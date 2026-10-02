package org.metadatacenter.cedar.resource.resources;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.dropwizard.testing.DropwizardTestSupport;
import io.dropwizard.testing.ResourceHelpers;
import org.junit.jupiter.api.*;
import org.metadatacenter.bridge.CedarDataServices;
import org.metadatacenter.cedar.resource.ResourceServerApplication;
import org.metadatacenter.cedar.resource.ResourceServerConfiguration;
import org.metadatacenter.config.CedarConfig;
import org.metadatacenter.config.environment.CedarEnvironmentVariableProvider;
import org.metadatacenter.id.CedarArtifactId;
import org.metadatacenter.id.CedarFolderId;
import org.metadatacenter.model.CedarResourceType;
import org.metadatacenter.model.SystemComponent;
import org.metadatacenter.model.folderserver.basic.FolderServerFolder;
import org.metadatacenter.model.folderserver.basic.FolderServerTemplate;
import org.metadatacenter.rest.context.CedarRequestContextFactory;
import org.metadatacenter.server.FolderServiceSession;
import org.metadatacenter.server.search.elasticsearch.service.NoOpNodeIndexingService;
import org.metadatacenter.server.search.permission.SearchPermissionEnqueueService;
import org.metadatacenter.server.search.util.IndexUtils;
import org.metadatacenter.server.valuerecommender.ValuerecommenderReindexQueueService;
import org.metadatacenter.util.json.JsonMapper;
import org.metadatacenter.util.test.EmbeddedCedarNeo4j;
import org.metadatacenter.util.test.TestAuthUtil;

import java.io.IOException;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/** Real resource HTTP and embedded graph, with a controllable content-store HTTP boundary. */
class CrossStoreSequenceAuditTest {
  private record Stored(ObjectNode body, long revision) { String etag() { return "\"" + revision + "\""; } }
  private static final Map<String, Stored> documents = new ConcurrentHashMap<>();
  private static HttpServer artifactServer;
  private static ExecutorService artifactThreads;
  private static CedarConfig config;
  private static FolderServiceSession folders;
  private static CedarFolderId home;
  private static String authorization;
  private static volatile String delayedName;
  private static volatile CountDownLatch firstWriteStored;
  private static volatile CountDownLatch releaseFirstReply;
  private static volatile Runnable afterPost;
  private static volatile String copiedId;
  private static final HttpClient client = HttpClient.newHttpClient();
  private static final DropwizardTestSupport<ResourceServerConfiguration> server =
      new DropwizardTestSupport<>(ResourceServerApplication.class, ResourceHelpers.resourceFilePath("test-config.yml"));

  @BeforeAll
  static void start() throws Exception {
    artifactServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    artifactThreads = Executors.newCachedThreadPool();
    artifactServer.setExecutor(artifactThreads);
    artifactServer.createContext("/", CrossStoreSequenceAuditTest::handleArtifact);
    artifactServer.start();
    EmbeddedCedarNeo4j.startAndRedirectEnvironment(Map.of(
        "CEDAR_RESOURCE_HTTP_PORT", "0", "CEDAR_RESOURCE_ADMIN_PORT", "0", "CEDAR_RESOURCE_STOP_PORT", "0",
        "CEDAR_REDIS_PERSISTENT_PORT", "1", "CEDAR_ARTIFACT_SERVER_HOST", "127.0.0.1",
        "CEDAR_ARTIFACT_HTTP_PORT", Integer.toString(artifactServer.getAddress().getPort()),
        "CEDAR_OPENSEARCH_HOST", "127.0.0.1", "CEDAR_OPENSEARCH_REST_PORT", "1"));
    server.before();
    config = CedarConfig.getInstance(CedarEnvironmentVariableProvider.getFor(SystemComponent.SERVER_RESOURCE));
    TestAuthUtil.installInMemoryUserService(config);
    EmbeddedCedarNeo4j.seed(config);
    authorization = TestAuthUtil.getTestUser1AuthHeader(config);
    folders = CedarDataServices.getInstance().getFolderServiceSession(
        CedarRequestContextFactory.fromUser(TestAuthUtil.getTestUser1(config)));
    home = folders.findHomeFolderOf().getResourceId();
    AbstractResourceServerResource.injectServices(new NoOpNodeIndexingService(config),
        new IndexUtils(config).getNodeSearchingService(), new SearchPermissionEnqueueService(config),
        new ValuerecommenderReindexQueueService(config.getCacheConfig().getPersistent()));
  }

  @AfterEach
  void clearHooks() {
    if (releaseFirstReply != null) releaseFirstReply.countDown();
    delayedName = null;
    afterPost = null;
  }

  @AfterAll
  static void stop() {
    server.after();
    artifactServer.stop(0);
    artifactThreads.shutdownNow();
  }

  @Test
  void aDelayedEarlierWriteCannotReplaceTheGraphOfALaterSuccessfulWrite() throws Exception {
    String id = createTemplate("Before overlapping writes");
    ObjectNode first = documents.get(id).body().deepCopy();
    first.put("schema:name", "First writer");
    ObjectNode second = first.deepCopy();
    second.put("schema:name", "Second writer");
    delayedName = "First writer";
    firstWriteStored = new CountDownLatch(1);
    releaseFirstReply = new CountDownLatch(1);
    CompletableFuture<HttpResponse<String>> firstResponse = client.sendAsync(
        request("PUT", "/templates/" + enc(id), first.toString(), "\"1\""), HttpResponse.BodyHandlers.ofString());
    try {
      assertTrue(firstWriteStored.await(10, TimeUnit.SECONDS), "first content update must be committed before the second read");
      HttpResponse<String> read = send("GET", "/templates/" + enc(id), null, null);
      assertEquals(200, read.statusCode(), read.body());
      assertEquals("First writer", JsonMapper.STRICT_MAPPER.readTree(read.body()).path("schema:name").asText());
      HttpResponse<String> newer = send("PUT", "/templates/" + enc(id), second.toString(),
          read.headers().firstValue("ETag").orElseThrow());
      assertEquals(200, newer.statusCode(), newer.body());
      assertEquals("Second writer", folders.findArtifactById(artifactId(id)).getName());
    } finally {
      releaseFirstReply.countDown();
    }
    HttpResponse<String> earlier = firstResponse.get(10, TimeUnit.SECONDS);
    assertEquals(200, earlier.statusCode(), earlier.body());
    assertEquals("Second writer", documents.get(id).body().path("schema:name").asText());
    assertEquals("Second writer", folders.findArtifactById(artifactId(id)).getName(),
        "the earlier HTTP reply must not project stale metadata over the already committed successor");
  }

  @Test
  void aCopyCleansUpItsDocumentWhenTheDestinationDisappears() throws Exception {
    String source = createTemplate("Copy source");
    FolderServerFolder target = new FolderServerFolder();
    target.setName("Disposable copy destination");
    target.setDescription("Removed after authorization and content creation");
    CedarFolderId targetId = config.getLinkedDataUtil().buildNewLinkedDataIdObject(CedarFolderId.class);
    assertNotNull(folders.createFolderAsChildOfId(target, home, targetId));
    afterPost = () -> assertTrue(folders.deleteFolderById(targetId));
    ObjectNode command = JsonMapper.MAPPER.createObjectNode().put("@id", source)
        .put("targetFolderId", targetId.getId()).put("nameTemplate", "Copy of {{name}}");
    HttpResponse<String> copy = send("POST", "/command/copy-artifact-to-folder", command.toString(), null);
    assertTrue(copy.statusCode() >= 400, copy.body());
    assertNotNull(copiedId, "the content service created a document before the destination disappeared");
    assertNull(folders.findArtifactById(artifactId(copiedId)), "the copy has no workspace node");
    assertFalse(documents.containsKey(copiedId), "a refused copy must discard the newly created content-store orphan");
  }

  @Test
  void sequentialEditsKeepContentAndGraphInAgreement() throws Exception {
    String id = createTemplate("Sequential control");
    for (String name : new String[]{"First sequential edit", "Second sequential edit"}) {
      Stored before = documents.get(id);
      ObjectNode edited = before.body().deepCopy();
      edited.put("schema:name", name);
      HttpResponse<String> result = send("PUT", "/templates/" + enc(id), edited.toString(), before.etag());
      assertEquals(200, result.statusCode(), result.body());
      assertEquals(name, documents.get(id).body().path("schema:name").asText());
      assertEquals(name, folders.findArtifactById(artifactId(id)).getName());
    }
  }

  private static String createTemplate(String name) {
    String id = config.getLinkedDataUtil().buildNewLinkedDataId(CedarResourceType.TEMPLATE);
    FolderServerTemplate template = new FolderServerTemplate();
    template.setId(id); template.setName(name); template.setDescription("Cross-store audit");
    template.setVersion("0.0.1"); template.setPublicationStatus("bibo:draft");
    template.setLatestVersion(true); template.setLatestDraftVersion(true); template.setLatestPublishedVersion(false);
    assertNotNull(folders.createResourceAsChildOfId(template, home));
    documents.put(id, new Stored(JsonMapper.MAPPER.createObjectNode().put("@id", id)
        .put("@type", "https://schema.metadatacenter.org/core/Template")
        .put("schema:name", name).put("schema:description", "Cross-store audit")
        .put("pav:version", "0.0.1").put("bibo:status", "bibo:draft"), 1));
    return id;
  }

  private static CedarArtifactId artifactId(String id) { return CedarArtifactId.build(id, CedarResourceType.TEMPLATE); }
  private static String enc(String id) { return URLEncoder.encode(id, StandardCharsets.UTF_8); }
  private static HttpRequest request(String method, String path, String body, String etag) {
    HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://localhost:" + server.getLocalPort() + path))
        .timeout(Duration.ofSeconds(20)).header("Authorization", authorization).header("Content-Type", "application/json");
    if (etag != null) builder.header("If-Match", etag);
    return builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build();
  }
  private static HttpResponse<String> send(String method, String path, String body, String etag) throws Exception {
    return client.send(request(method, path, body, etag), HttpResponse.BodyHandlers.ofString());
  }

  private static void handleArtifact(HttpExchange exchange) throws IOException {
    String path = exchange.getRequestURI().getPath();
    String id = path.startsWith("/templates/") ? path.substring("/templates/".length()) : null;
    String method = exchange.getRequestMethod();
    if (method.equals("POST")) {
      ObjectNode body = (ObjectNode) JsonMapper.STRICT_MAPPER.readTree(exchange.getRequestBody());
      copiedId = config.getLinkedDataUtil().buildNewLinkedDataId(CedarResourceType.TEMPLATE);
      body.put("@id", copiedId);
      Stored stored = new Stored(body, 1);
      documents.put(copiedId, stored);
      Runnable hook = afterPost;
      if (hook != null) hook.run();
      exchange.getResponseHeaders().set("Location", copiedId);
      respond(exchange, 201, stored);
      return;
    }
    Stored stored = id == null ? null : documents.get(id);
    if (stored == null) { respond(exchange, 404, null); return; }
    if (method.equals("GET")) { respond(exchange, 200, stored); return; }
    if (!stored.etag().equals(exchange.getRequestHeaders().getFirst("If-Match"))) {
      respond(exchange, 412, null); return;
    }
    if (method.equals("DELETE")) { documents.remove(id); respond(exchange, 204, null); return; }
    if (method.equals("PUT")) {
      ObjectNode body = (ObjectNode) JsonMapper.STRICT_MAPPER.readTree(exchange.getRequestBody());
      Stored replacement = new Stored(body, stored.revision() + 1);
      if (!documents.replace(id, stored, replacement)) { respond(exchange, 412, null); return; }
      if (body.path("schema:name").asText().equals(delayedName)) {
        firstWriteStored.countDown();
        try {
          if (!releaseFirstReply.await(15, TimeUnit.SECONDS)) throw new IOException("audit did not release delayed reply");
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException(e); }
      }
      respond(exchange, 200, replacement);
      return;
    }
    respond(exchange, 405, null);
  }

  private static void respond(HttpExchange exchange, int status, Stored stored) throws IOException {
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    if (stored != null) exchange.getResponseHeaders().set("ETag", stored.etag());
    byte[] bytes = (stored == null ? "{}" : stored.body().toString()).getBytes(StandardCharsets.UTF_8);
    exchange.sendResponseHeaders(status, status == 204 ? -1 : bytes.length);
    if (status != 204) exchange.getResponseBody().write(bytes);
    exchange.close();
  }
}
