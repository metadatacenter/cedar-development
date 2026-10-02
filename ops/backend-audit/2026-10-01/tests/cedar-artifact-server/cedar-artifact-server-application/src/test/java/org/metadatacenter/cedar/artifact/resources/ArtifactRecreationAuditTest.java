package org.metadatacenter.cedar.artifact.resources;

import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.ws.rs.client.Entity;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.Test;
import org.metadatacenter.artifacts.model.core.TemplateSchemaArtifact;
import org.metadatacenter.artifacts.model.renderer.JsonArtifactRenderer;
import org.metadatacenter.cedar.artifact.resources.utils.TestUtil;
import org.metadatacenter.model.CedarResourceType;

import java.net.URI;

import static org.junit.jupiter.api.Assertions.*;

/** A saved validator must identify an incarnation, including across delete/recreate. */
public class ArtifactRecreationAuditTest extends BaseServerTest {
  private record Artifact(String url, ObjectNode body, String etag) {}

  private Artifact create(String name) {
    String id = TestUtil.getCedarConfig().getLinkedDataUtil().buildNewLinkedDataId(CedarResourceType.TEMPLATE);
    String url = "http://localhost:" + getPortNumber() + "/templates/" + encodeUrl(id);
    ObjectNode body = new JsonArtifactRenderer().renderTemplateSchemaArtifact(
        TemplateSchemaArtifact.builder().withName(name).withJsonLdId(URI.create(id)).build());
    try (Response created = testClient.target(url).request().header("Authorization", authHeaderValue)
        .put(Entity.json(body))) {
      assertEquals(201, created.getStatus(), created.readEntity(String.class));
      return new Artifact(url, body, currentEtag(url, authHeaderValue));
    }
  }

  private Artifact recreate(Artifact original) {
    try (Response deleted = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .header("If-Match", original.etag()).delete()) {
      assertEquals(204, deleted.getStatus());
    }
    ObjectNode replacement = original.body().deepCopy();
    replacement.put("schema:name", "Replacement incarnation");
    try (Response created = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .put(Entity.json(replacement))) {
      assertEquals(201, created.getStatus(), created.readEntity(String.class));
    }
    return new Artifact(original.url(), replacement, currentEtag(original.url(), authHeaderValue));
  }

  @Test
  void staleDeleteCannotDeleteARecreatedArtifact() {
    Artifact original = create("Old delete target");
    Artifact replacement = recreate(original);
    try (Response stale = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .header("If-Match", original.etag()).delete()) {
      assertEquals(412, stale.getStatus(), "a validator from the deleted incarnation must not delete its replacement; old="
          + original.etag() + ", replacement=" + replacement.etag());
    }
  }

  @Test
  void staleUpdateCannotOverwriteARecreatedArtifact() {
    Artifact original = create("Old editor contents");
    Artifact replacement = recreate(original);
    try (Response stale = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .header("If-Match", original.etag()).put(Entity.json(original.body()))) {
      assertEquals(412, stale.getStatus(), "an old editor must not overwrite a replacement; old="
          + original.etag() + ", replacement=" + replacement.etag());
    }
  }

  @Test
  void ordinaryUpdateStillRejectsThePreviousValidator() {
    Artifact original = create("Ordinary revision control");
    ObjectNode edited = original.body().deepCopy();
    edited.put("schema:name", "Edited once");
    try (Response updated = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .header("If-Match", original.etag()).put(Entity.json(edited))) {
      assertEquals(200, updated.getStatus(), updated.readEntity(String.class));
    }
    try (Response stale = testClient.target(original.url()).request().header("Authorization", authHeaderValue)
        .header("If-Match", original.etag()).put(Entity.json(original.body()))) {
      assertEquals(412, stale.getStatus());
    }
  }
}
