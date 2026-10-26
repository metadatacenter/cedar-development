// Reads snapshot artifacts with cedar-artifact-library and validates them with
// cedar-model-validation-library, driven over stdin and stdout.
//
// ops/cedar_snapshot_read_audit.py starts several of these and streams a snapshot made by
// ops/cedar_snapshot.py through them. A request is one JSON header line followed by exactly
// "length" bytes of artifact source. The source is the response body as the deployment served it,
// so the parser sees what a client of the deployment sees.
//
//     {"seq": 1, "op": "template", "id": "<template @id>", "length": N}
//     {"seq": 2, "op": "read", "kind": "template" | "element" | "field" | "instance", "length": N,
//      "templateId": "<the template an instance names>"}
//
// A "template" request keeps a template for validating the instances based on it, in a cache of
// --template-cache entries that evicts the least recently used. Each request is answered with one
// JSON line echoing its "seq". A read answer carries a "reader" and a "validation" verdict:
//
//     reader:      "read"; "refused", when the reader throws; "unparsable", when the source is not
//                  one JSON object under the source policy the library's readers apply
//     validation:  "valid"; "invalid"; "template-missing", when no template was sent for the
//                  instance; "error", when the validator throws
//     renderer:    for an artifact the reader read, "rendered" or "failed" for each of "json" and
//                  "yaml", the renderings a client is served: JsonArtifactRenderer's, and the full
//                  YAML form YamlSerializer writes. "nanos" times the read and both renderings.
//
// The source is parsed once with ArtifactSourceParser, the boundary the library's own readers use.
// Every verdict is the library's. Nothing but answers goes to stdout, and the libraries' logging
// goes to stderr.
//
//     java -cp <cedar-artifact-library jar with dependencies> ops/cedar_snapshot_read_bridge.java

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.metadatacenter.artifacts.model.core.Artifact;
import org.metadatacenter.artifacts.model.core.ElementSchemaArtifact;
import org.metadatacenter.artifacts.model.core.FieldSchemaArtifact;
import org.metadatacenter.artifacts.model.core.TemplateInstanceArtifact;
import org.metadatacenter.artifacts.model.core.TemplateSchemaArtifact;
import org.metadatacenter.artifacts.model.reader.ArtifactParseException;
import org.metadatacenter.artifacts.model.renderer.JsonArtifactRenderer;
import org.metadatacenter.artifacts.model.tools.YamlSerializer;
import org.metadatacenter.artifacts.model.reader.ArtifactSourceParser;
import org.metadatacenter.artifacts.model.reader.JsonArtifactReader;
import org.metadatacenter.model.validation.CedarValidator;
import org.metadatacenter.model.validation.ModelValidator;
import org.metadatacenter.model.validation.report.ErrorItem;
import org.metadatacenter.model.validation.report.ValidationReport;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public class CedarSnapshotReadBridge {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final int MESSAGE_LIMIT = 400;
  private static final int ERROR_LIMIT = 5;

  private final ModelValidator validator = new CedarValidator();
  private final JsonArtifactReader reader = new JsonArtifactReader();
  private final JsonArtifactRenderer renderer = new JsonArtifactRenderer();
  private final Map<String, ObjectNode> templates;

  private CedarSnapshotReadBridge(int templateCapacity) {
    this.templates = new LinkedHashMap<>(16, 0.75f, true) {
      @Override
      protected boolean removeEldestEntry(Map.Entry<String, ObjectNode> eldest) {
        return size() > templateCapacity;
      }
    };
  }

  public static void main(String[] args) throws Exception {
    int templateCapacity = 256;
    for (int i = 0; i < args.length; i++) {
      if ("--template-cache".equals(args[i]) && i + 1 < args.length) {
        templateCapacity = Integer.parseInt(args[++i]);
      }
    }
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
    System.setOut(System.err);
    CedarSnapshotReadBridge bridge = new CedarSnapshotReadBridge(templateCapacity);
    InputStream in = new BufferedInputStream(System.in, 1 << 20);
    String header;
    while ((header = readLine(in)) != null) {
      JsonNode request = MAPPER.readTree(header);
      int length = request.path("length").asInt(-1);
      byte[] source = length < 0 ? new byte[0] : in.readNBytes(length);
      if (source.length != Math.max(0, length)) {
        throw new EOFException("request " + request.path("seq") + " ended after " + source.length + " bytes");
      }
      out.println(MAPPER.writeValueAsString(bridge.handle(request, new String(source, StandardCharsets.UTF_8))));
      if (in.available() == 0) {
        out.flush();
      }
    }
    out.flush();
  }

  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream(256);
    int b;
    while ((b = in.read()) != -1 && b != '\n') {
      line.write(b);
    }
    if (b == -1 && line.size() == 0) {
      return null;
    }
    return line.toString(StandardCharsets.UTF_8);
  }

  private ObjectNode handle(JsonNode request, String source) {
    ObjectNode answer = MAPPER.createObjectNode();
    answer.set("seq", request.get("seq"));
    String op = request.path("op").asText();
    if ("template".equals(op)) {
      try {
        templates.put(request.path("id").asText(), ArtifactSourceParser.json(source));
        answer.put("status", "kept");
      } catch (Throwable t) {
        answer.put("status", "unparsable");
        answer.put("message", truncate(t.getMessage()));
      }
      return answer;
    }
    if (!"read".equals(op)) {
      answer.put("status", "error");
      answer.put("message", "unknown op: " + op);
      return answer;
    }
    String kind = request.path("kind").asText();
    ObjectNode node;
    try {
      node = ArtifactSourceParser.json(source);
    } catch (Throwable t) {
      ObjectNode verdict = answer.putObject("reader");
      verdict.put("status", "unparsable");
      verdict.put("exception", t.getClass().getName());
      verdict.put("message", truncate(t.getMessage()));
      answer.putObject("validation").put("status", "unparsable");
      return answer;
    }
    answer.set("validation", validate(kind, node.deepCopy(), request.path("templateId").asText()));
    long started = System.nanoTime();
    Artifact[] model = new Artifact[1];
    answer.set("reader", read(kind, node, model));
    if (model[0] != null) {
      answer.set("renderer", render(model[0], started));
    }
    return answer;
  }

  private ObjectNode read(String kind, ObjectNode node, Artifact[] model) {
    ObjectNode verdict = MAPPER.createObjectNode();
    try {
      model[0] = switch (kind) {
        case "template" -> reader.readTemplateSchemaArtifact(node);
        case "element" -> reader.readElementSchemaArtifact(node);
        case "field" -> reader.readFieldSchemaArtifact(node);
        case "instance" -> reader.readTemplateInstanceArtifact(node);
        default -> throw new IllegalArgumentException("unknown kind: " + kind);
      };
      verdict.put("status", "read");
    } catch (Throwable t) {
      verdict.put("status", "refused");
      verdict.put("exception", t.getClass().getName());
      if (t instanceof ArtifactParseException parse) {
        verdict.put("message", truncate(parse.getParseErrorMessage()));
        verdict.put("location", parse.getPath());
      } else {
        verdict.put("message", truncate(t.getMessage()));
      }
    }
    return verdict;
  }

  /** Render a model the way the deployment serves it, as JSON and as full-form YAML. */
  private ObjectNode render(Artifact model, long started) {
    ObjectNode verdict = MAPPER.createObjectNode();
    renderOne(verdict, "json", () -> {
      if (model instanceof TemplateSchemaArtifact template) return renderer.renderTemplateSchemaArtifact(template);
      if (model instanceof ElementSchemaArtifact element) return renderer.renderElementSchemaArtifact(element);
      if (model instanceof FieldSchemaArtifact field) return renderer.renderFieldSchemaArtifact(field);
      if (model instanceof TemplateInstanceArtifact instance) return renderer.renderTemplateInstanceArtifact(instance);
      throw new IllegalArgumentException("no renderer for " + model.getClass().getName());
    });
    renderOne(verdict, "yaml", () -> YamlSerializer.getYAML(model, false, true));
    verdict.put("nanos", System.nanoTime() - started);
    return verdict;
  }

  private static void renderOne(ObjectNode verdict, String format, java.util.concurrent.Callable<?> rendering) {
    try {
      rendering.call();
      verdict.put(format, "rendered");
    } catch (Throwable t) {
      verdict.put(format, "failed");
      verdict.put(format + "Exception", t.getClass().getName());
      verdict.put(format + "Message", truncate(t.getMessage()));
    }
  }

  private ObjectNode validate(String kind, ObjectNode node, String templateId) {
    ObjectNode verdict = MAPPER.createObjectNode();
    try {
      ValidationReport report;
      switch (kind) {
        case "template" -> report = validator.validateTemplate(node);
        case "element" -> report = validator.validateTemplateElement(node);
        case "field" -> report = validator.validateTemplateField(node);
        case "instance" -> {
          ObjectNode template = templateId.isEmpty() ? null : templates.get(templateId);
          if (template == null) {
            verdict.put("status", "template-missing");
            return verdict;
          }
          report = validator.validateTemplateInstance(node, template);
        }
        default -> throw new IllegalArgumentException("unknown kind: " + kind);
      }
      boolean valid = "true".equals(report.getValidationStatus());
      verdict.put("status", valid ? "valid" : "invalid");
      if (!valid) {
        verdict.put("errorCount", report.getErrors().size());
        ArrayNode errors = verdict.putArray("errors");
        for (ErrorItem item : report.getErrors()) {
          if (errors.size() == ERROR_LIMIT) {
            break;
          }
          errors.addObject().put("message", truncate(item.getMessage())).put("location", item.getLocation());
        }
      }
    } catch (Throwable t) {
      verdict.put("status", "error");
      verdict.put("exception", t.getClass().getName());
      verdict.put("message", truncate(t.getMessage()));
    }
    return verdict;
  }

  private static String truncate(String value) {
    String text = String.valueOf(value);
    return text.length() <= MESSAGE_LIMIT ? text : text.substring(0, MESSAGE_LIMIT) + "…";
  }
}
