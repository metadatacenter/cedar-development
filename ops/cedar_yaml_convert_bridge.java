// A long-lived front for cedar-artifact-library and cedar-model-validation-library, driven over
// stdin and stdout.
//
// It answers two questions about one artifact: what JSON Schema the Java artifact library produces
// from a YAML document, and what cedar-model-validation-library makes of a JSON Schema document.
// Keeping both in one process lets a caller convert with this library and validate here, or convert
// elsewhere and validate here, without paying a JVM start per artifact. The artifact library already
// depends on the validation library, so one classpath serves both.
//
// It is launched in Java's source-file mode, so nothing is compiled ahead of time:
//
//     java -cp "<artifact library classes>:<validation gate classpath>:<artifact library deps>" \
//       ops/cedar_yaml_convert_bridge.java
//
// Requests are JSON objects, one per line. Every request may carry a "seq" the answer echoes.
//
//     {"op": "hello"}
//     {"op": "convert", "kind": "template" | "element" | "field", "yaml": "<document>",
//      "compact": false}
//     {"op": "render", "kind": "template" | "element" | "field", "json": {...},
//      "compact": false}
//     {"op": "validate", "kind": "template" | "element" | "field", "artifact": {...}}
//     {"op": "shutdown"}
//
// A convert answer carries "status": "ok" with the rendered "json", or "error" with the "stage" it
// failed at — "parse" for a document YAML itself rejects, "read" for one the artifact model cannot
// represent, "render" for a model the JSON renderer cannot write. A render answer is the other
// direction, JSON Schema to YAML, and carries "yaml" with the same stages: it exists so a caller
// can start from the document a deployment stores rather than from one a deployment rendered, which
// is the only way a YAML writer is put under test rather than merely used. A validate answer carries
// "status": "valid", "invalid" or "error", and an invalid answer lists the library's errors and
// warnings as {message, location}. Nothing but answers goes to stdout; logging goes to stderr.
//
// ops/cedar_yaml_conversion_audit.py is the caller this exists for. Its sibling,
// ops/cedar_validation_bridge.java, validates stored artifacts and instances; this one exists
// because that bridge knows nothing about YAML or about the artifact library's renderers.

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import org.metadatacenter.artifacts.model.core.ElementSchemaArtifact;
import org.metadatacenter.artifacts.model.core.FieldSchemaArtifact;
import org.metadatacenter.artifacts.model.core.TemplateSchemaArtifact;
import org.metadatacenter.artifacts.model.reader.JsonArtifactReader;
import org.metadatacenter.artifacts.model.reader.YamlArtifactReader;
import org.metadatacenter.artifacts.model.renderer.JsonArtifactRenderer;
import org.metadatacenter.artifacts.model.core.Artifact;
import org.metadatacenter.artifacts.model.core.TemplateInstanceArtifact;
import org.metadatacenter.artifacts.model.tools.YamlSerializer;
import org.metadatacenter.model.validation.CedarValidator;
import org.metadatacenter.model.validation.ModelValidator;
import org.metadatacenter.model.validation.report.ErrorItem;
import org.metadatacenter.model.validation.report.ValidationReport;
import org.metadatacenter.model.validation.report.WarningItem;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;

public class CedarYamlConvertBridge {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final ObjectMapper YAML_MAPPER = new ObjectMapper(new YAMLFactory());
  private static final int MESSAGE_LIMIT = 1000;

  private final ModelValidator validator = new CedarValidator();
  private final JsonArtifactRenderer renderer = new JsonArtifactRenderer();

  public static void main(String[] args) throws Exception {
    if (args.length != 0) {
      System.err.println("usage: CedarYamlConvertBridge");
      System.exit(2);
    }
    CedarYamlConvertBridge bridge = new CedarYamlConvertBridge();
    // The protocol is UTF-8 in both directions whatever the platform's default encoding is.
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) {
        continue;
      }
      ObjectNode answer = bridge.answer(line);
      out.println(MAPPER.writeValueAsString(answer));
      if ("shutdown".equals(answer.path("op").asText())) {
        break;
      }
    }
  }

  private ObjectNode answer(String line) {
    ObjectNode answer = MAPPER.createObjectNode();
    JsonNode request;
    try {
      request = MAPPER.readTree(line);
    } catch (Exception e) {
      answer.put("status", "error");
      answer.put("exception", e.getClass().getName());
      answer.put("message", truncate("request is not JSON: " + e.getMessage()));
      return answer;
    }
    if (request.has("seq")) {
      answer.set("seq", request.get("seq"));
    }
    String op = request.path("op").asText();
    answer.put("op", op);
    long started = System.nanoTime();
    try {
      switch (op) {
        case "hello" -> {
          answer.put("status", "ok");
          answer.put("validator", validator.getClass().getName());
          answer.put("reader", YamlArtifactReader.class.getName());
          answer.put("renderer", renderer.getClass().getName());
          answer.put("java", System.getProperty("java.version"));
        }
        case "convert" -> convert(request, answer);
        case "render" -> render(request, answer);
        case "validate" -> validate(request, answer);
        case "complete-instance" -> completeInstance(request, answer);
        case "shutdown" -> answer.put("status", "ok");
        default -> {
          answer.put("status", "error");
          answer.put("message", "unknown op: " + op);
        }
      }
    } catch (Throwable t) {
      // A malformed artifact can make either library throw rather than report, and one such
      // document must not end the run. The caller records the exception as that artifact's verdict.
      answer.put("status", "error");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
    }
    answer.put("millis", (System.nanoTime() - started) / 1_000_000);
    return answer;
  }

  /**
   * Read a YAML document into the artifact model and render it back out as JSON Schema.
   * <p>
   * The three steps fail for different reasons and the caller counts them apart, so each one
   * reports the stage it was at rather than a single conversion failure.
   */
  private void convert(JsonNode request, ObjectNode answer) {
    String kind = request.path("kind").asText();
    JsonNode yaml = request.get("yaml");
    if (yaml == null || !yaml.isTextual()) {
      answer.put("status", "error");
      answer.put("stage", "request");
      answer.put("message", "convert needs a textual yaml document");
      return;
    }
    boolean compact = request.path("compact").asBoolean(false);

    LinkedHashMap<String, Object> sourceNode;
    try {
      Object parsed = YAML_MAPPER.readValue(yaml.textValue(), Object.class);
      if (!(parsed instanceof LinkedHashMap<?, ?>)) {
        answer.put("status", "error");
        answer.put("stage", "parse");
        answer.put("message", "the document is not a YAML mapping");
        return;
      }
      @SuppressWarnings("unchecked") LinkedHashMap<String, Object> mapping = (LinkedHashMap<String, Object>) parsed;
      sourceNode = mapping;
    } catch (Throwable t) {
      answer.put("status", "error");
      answer.put("stage", "parse");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
      return;
    }

    Object artifact;
    try {
      YamlArtifactReader reader = new YamlArtifactReader(compact);
      artifact = switch (kind) {
        case "template" -> reader.readTemplateSchemaArtifact(sourceNode);
        case "element" -> reader.readElementSchemaArtifact(sourceNode);
        case "field" -> reader.readFieldSchemaArtifact(sourceNode);
        case "instance" -> reader.readTemplateInstanceArtifact(sourceNode);
        default -> null;
      };
      if (artifact == null) {
        answer.put("status", "error");
        answer.put("stage", "request");
        answer.put("message", "unknown kind: " + kind);
        return;
      }
    } catch (Throwable t) {
      answer.put("status", "error");
      answer.put("stage", "read");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
      return;
    }

    try {
      ObjectNode rendering = switch (kind) {
        case "template" -> renderer.renderTemplateSchemaArtifact((TemplateSchemaArtifact) artifact);
        case "element" -> renderer.renderElementSchemaArtifact((ElementSchemaArtifact) artifact);
        case "instance" -> renderer.renderTemplateInstanceArtifact((TemplateInstanceArtifact) artifact);
        default -> renderer.renderFieldSchemaArtifact((FieldSchemaArtifact) artifact);
      };
      answer.put("status", "ok");
      answer.set("json", rendering);
    } catch (Throwable t) {
      answer.put("status", "error");
      answer.put("stage", "render");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
    }
  }

  /**
   * Read a JSON Schema document into the artifact model and render it back out as YAML.
   * <p>
   * The inverse of {@link #convert}, reporting the same three stages apart so the caller counts
   * them separately: "parse" for a body that is not an object, "read" for one the model cannot
   * represent, "render" for a model the YAML renderer cannot write.
   */
  private void render(JsonNode request, ObjectNode answer) {
    String kind = request.path("kind").asText();
    JsonNode source = request.get("json");
    if (source == null || !source.isObject()) {
      answer.put("status", "error");
      answer.put("stage", "parse");
      answer.put("message", "render needs an object json document");
      return;
    }
    boolean compact = request.path("compact").asBoolean(false);

    Object artifact;
    try {
      JsonArtifactReader jsonReader = new JsonArtifactReader();
      artifact = switch (kind) {
        case "template" -> jsonReader.readTemplateSchemaArtifact((ObjectNode) source);
        case "element" -> jsonReader.readElementSchemaArtifact((ObjectNode) source);
        case "field" -> jsonReader.readFieldSchemaArtifact((ObjectNode) source);
        case "instance" -> jsonReader.readTemplateInstanceArtifact((ObjectNode) source);
        default -> null;
      };
      if (artifact == null) {
        answer.put("status", "error");
        answer.put("stage", "request");
        answer.put("message", "unknown kind: " + kind);
        return;
      }
    } catch (Throwable t) {
      answer.put("status", "error");
      answer.put("stage", "read");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
      return;
    }

    try {
      // The same call and the same quoting the resource server uses, so a document rendered here
      // is comparable with one the deployment serves rather than with a form nothing emits.
      answer.put("status", "ok");
      answer.put("yaml", YamlSerializer.getYAML((Artifact) artifact, compact, true));
    } catch (Throwable t) {
      answer.put("status", "error");
      answer.put("stage", "render");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
    }
  }

  /** Complete a sparse conversion result using the repository's instance completion rules. */
  private void completeInstance(JsonNode request, ObjectNode answer) throws Exception {
    JsonArtifactReader reader = new JsonArtifactReader();
    TemplateSchemaArtifact template = reader.readTemplateSchemaArtifact((ObjectNode) request.get("template"));
    TemplateInstanceArtifact instance = reader.readTemplateInstanceArtifact((ObjectNode) request.get("json"));
    ObjectNode json = renderer.renderTemplateInstanceArtifact(template, instance);
    mintElementInstanceIds(json);
    ValidationReport report = validator.validateTemplateInstance(json, request.get("template"));
    answer.put("status", "true".equals(report.getValidationStatus()) ? "valid" : "invalid");
    answer.set("json", json);
    ArrayNode errors = answer.putArray("errors");
    for (ErrorItem item : report.getErrors()) {
      ObjectNode error = errors.addObject();
      error.put("message", truncate(item.getMessage()));
      error.put("location", item.getLocation());
    }
  }

  // Same in-memory identity completion as cedar_instance_roundtrip_bridge; never stored.
  private void mintElementInstanceIds(JsonNode node) {
    if (node instanceof ObjectNode object) {
      if (object.has("@context") && !object.has("schema:isBasedOn") &&
          (!object.has("@id") || object.get("@id").isNull()))
        object.put("@id", "https://repo.example/template-element-instances/minted-by-the-bridge");
      object.fields().forEachRemaining(entry -> {
        if (!entry.getKey().equals("@context")) mintElementInstanceIds(entry.getValue());
      });
    } else if (node != null && node.isArray()) {
      node.forEach(this::mintElementInstanceIds);
    }
  }

  private void validate(JsonNode request, ObjectNode answer) throws Exception {
    String kind = request.path("kind").asText();
    JsonNode artifact = request.get("artifact");
    if (artifact == null || !artifact.isObject()) {
      answer.put("status", "error");
      answer.put("message", "validate needs an object artifact");
      return;
    }
    ValidationReport report;
    switch (kind) {
      case "template" -> report = validator.validateTemplate(artifact);
      case "element" -> report = validator.validateTemplateElement(artifact);
      case "field" -> report = validator.validateTemplateField(artifact);
      default -> {
        answer.put("status", "error");
        answer.put("message", "unknown kind: " + kind);
        return;
      }
    }
    boolean valid = "true".equals(report.getValidationStatus());
    answer.put("status", valid ? "valid" : "invalid");
    ArrayNode errors = answer.putArray("errors");
    for (ErrorItem item : report.getErrors()) {
      ObjectNode error = errors.addObject();
      error.put("message", truncate(item.getMessage()));
      error.put("location", item.getLocation());
      Object schemaFile = item.getAdditionalInfo().get("schemaFile");
      if (schemaFile != null) {
        error.put("schemaFile", String.valueOf(schemaFile));
      }
    }
    ArrayNode warnings = answer.putArray("warnings");
    for (WarningItem item : report.getWarnings()) {
      ObjectNode warning = warnings.addObject();
      warning.put("message", truncate(item.getMessage()));
      warning.put("location", item.getLocation());
    }
  }

  private static String truncate(String text) {
    if (text == null) {
      return null;
    }
    return text.length() <= MESSAGE_LIMIT ? text : text.substring(0, MESSAGE_LIMIT) + "…";
  }
}
