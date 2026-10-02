package org.metadatacenter.cedar.artifact.resources;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.ws.rs.client.Entity;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.AfterAll;
import io.dropwizard.testing.DropwizardTestSupport;
import io.dropwizard.testing.ResourceHelpers;
import jakarta.ws.rs.client.Client;
import jakarta.ws.rs.client.ClientBuilder;
import org.metadatacenter.cedar.artifact.ArtifactServerApplication;
import org.metadatacenter.cedar.artifact.ArtifactServerConfiguration;
import org.metadatacenter.cedar.artifact.resources.utils.TestUtil;
import org.metadatacenter.util.test.EmbeddedCedarMongo;
import org.metadatacenter.util.test.TestAuthUtil;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.metadatacenter.artifacts.model.core.TemplateSchemaArtifact;
import org.metadatacenter.artifacts.model.renderer.JsonArtifactRenderer;
import org.metadatacenter.server.service.TemplateInstanceService;
import org.metadatacenter.util.json.JsonMapper;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** Real HTTP and embedded Mongo; service decorators only pause, never alter a result. */
public class TemplateDeletionRaceAuditTest {
  static {
    EmbeddedCedarMongo.startAndRedirectEnvironment(Map.of(
        "CEDAR_ARTIFACT_HTTP_PORT", "0", "CEDAR_ARTIFACT_ADMIN_PORT", "0",
        "CEDAR_ARTIFACT_STOP_PORT", "0", "CEDAR_REDIS_PERSISTENT_PORT", "1"));
  }
  private static final DropwizardTestSupport<ArtifactServerConfiguration> SERVER =
      new DropwizardTestSupport<>(RaceApplication.class, ResourceHelpers.resourceFilePath("test-config.yml"));
  private static Client testClient;
  private static String authHeaderValue;
  private static volatile Pause activePause;

  @BeforeAll static void start() throws Exception {
    SERVER.before();
    var config = TestUtil.getCedarConfig();
    TestAuthUtil.installInMemoryUserService(config);
    authHeaderValue = TestAuthUtil.getTestUser1AuthHeader(config);
    testClient = ClientBuilder.newClient();
    testClient.register((jakarta.ws.rs.client.ClientRequestFilter) request ->
        request.getHeaders().putSingle(org.metadatacenter.config.ArtifactServiceConfig.HEADER,
            config.getArtifactService().requireApiKey()));
  }

  @AfterAll static void stop() {
    if (testClient != null) testClient.close();
    SERVER.after();
  }

  private static String encodeUrl(String id) { return URLEncoder.encode(id, StandardCharsets.UTF_8); }

  public static class RaceApplication extends ArtifactServerApplication {
    @Override public void initializeApp() {
      super.initializeApp();
      var original = templateInstanceService;
      @SuppressWarnings("unchecked")
      TemplateInstanceService<String, JsonNode> decorated = (TemplateInstanceService<String, JsonNode>)
          Proxy.newProxyInstance(TemplateInstanceService.class.getClassLoader(),
              new Class<?>[]{TemplateInstanceService.class}, (proxy, method, arguments) -> {
                Pause pause = activePause;
                boolean target = pause != null && method.getName().equals(pause.methodName);
                if (target && !pause.after) pause.awaitResume();
                Object result;
                try {
                  result = method.invoke(original, arguments);
                } catch (InvocationTargetException error) {
                  throw error.getCause();
                }
                if (target && pause.after) {
                  assertEquals(0L, result, "the paused reference check must see no instances");
                  pause.awaitResume();
                }
                return result;
              });
      templateInstanceService = decorated;
    }
  }

  private record Reply(int status, String body, String etag) {}
  private record Template(String id, String url, String etag) {}

  private String base() { return "http://localhost:" + SERVER.getLocalPort(); }

  private static Reply reply(Response response) {
    try (response) {
      return new Reply(response.getStatus(), response.readEntity(String.class), response.getHeaderString("ETag"));
    }
  }

  private Template createTemplate() throws Exception {
    ObjectNode body = new JsonArtifactRenderer().renderTemplateSchemaArtifact(
        TemplateSchemaArtifact.builder().withName("Deletion race template").build());
    Reply created = reply(testClient.target(base() + "/templates").request()
        .header("Authorization", authHeaderValue).post(Entity.json(body)));
    assertEquals(201, created.status(), created.body());
    String id = JsonMapper.STRICT_MAPPER.readTree(created.body()).path("@id").asText();
    return new Template(id, base() + "/templates/" + encodeUrl(id), created.etag());
  }

  private Reply createInstance(Template template) {
    String yaml = "type: instance\nname: Concurrent instance\nisBasedOn: " + template.id() + "\n";
    return reply(testClient.target(base() + "/template-instances").request("application/json")
        .property("jersey.config.client.readTimeout", 20000)
        .header("Authorization", authHeaderValue).post(Entity.entity(yaml, "application/yaml")));
  }

  private Reply delete(Template template) {
    return reply(testClient.target(template.url()).request()
        .property("jersey.config.client.readTimeout", 20000)
        .header("Authorization", authHeaderValue).header("If-Match", template.etag()).delete());
  }

  private Reply get(String url) {
    return reply(testClient.target(url).request().header("Authorization", authHeaderValue).get());
  }

  private void assertNoOrphan(Template template, Reply created, Reply deleted) throws Exception {
    assertEquals(201, created.status(), created.body());
    JsonNode instance = JsonMapper.STRICT_MAPPER.readTree(created.body());
    Reply storedInstance = get(base() + "/template-instances/" + encodeUrl(instance.path("@id").asText()));
    assertEquals(200, storedInstance.status(), storedInstance.body());
    assertEquals(template.id(), JsonMapper.STRICT_MAPPER.readTree(storedInstance.body()).path("schema:isBasedOn").asText());
    Reply storedTemplate = get(template.url());
    assertFalse(deleted.status() == 204 && storedTemplate.status() == 404,
        "DELETE returned 204 and template GET returned 404, but the concurrent POST returned 201 "
            + "and instance GET returned 200: a persisted instance now references a missing template");
  }

  @Test
  void instanceCreatedAfterTheReferenceCountMustPreventTemplateDeletion() throws Exception {
    Template template = createTemplate();
    var executor = Executors.newSingleThreadExecutor();
    try (Pause pause = new Pause("countReferencingTemplate", true)) {
      var deleting = executor.submit(() -> delete(template));
      assertTrue(pause.entered.await(10, TimeUnit.SECONDS), "delete did not reach reference check");
      Reply created = createInstance(template);
      pause.resume.countDown();
      assertNoOrphan(template, created, deleting.get(15, TimeUnit.SECONDS));
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void templateDeletedAfterValidationMustPreventInstanceInsertion() throws Exception {
    Template template = createTemplate();
    var executor = Executors.newSingleThreadExecutor();
    try (Pause pause = new Pause("createTemplateInstance", false)) {
      var creating = executor.submit(() -> createInstance(template));
      assertTrue(pause.entered.await(10, TimeUnit.SECONDS), "create did not reach validated insert");
      Reply deleted = delete(template);
      pause.resume.countDown();
      assertNoOrphan(template, creating.get(15, TimeUnit.SECONDS), deleted);
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void anAlreadyStoredInstanceBlocksDeletion() throws Exception {
    Template template = createTemplate();
    Reply created = createInstance(template);
    assertEquals(201, created.status(), created.body());
    Reply deleted = delete(template);
    assertEquals(400, deleted.status(), deleted.body());
    assertEquals(200, get(template.url()).status());
  }

  /** Pause at one real Mongo service boundary; no return value is fabricated. */
  private static final class Pause implements AutoCloseable {
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch resume = new CountDownLatch(1);
    final String methodName;
    final boolean after;

    Pause(String methodName, boolean after) {
      this.methodName = methodName;
      this.after = after;
      activePause = this;
    }

    private void awaitResume() throws InterruptedException {
      entered.countDown();
      assertTrue(resume.await(15, TimeUnit.SECONDS), "controller never resumed the service call");
    }

    @Override public void close() {
      resume.countDown();
      activePause = null;
    }
  }
}
