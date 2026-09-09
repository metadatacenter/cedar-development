// A long-lived front for cedar-model-validation-library, driven over stdin and stdout.
//
// The library's own entry points under org.metadatacenter.model.validation.exec validate one file
// per JVM. An audit of a whole deployment validates tens of thousands of documents, and paying a
// JVM start for each would make the run hours longer than the network already does. This program
// starts once, keeps a bounded cache of templates so an instance can be validated against the
// template it names without the caller sending it every time, and answers one JSON line per
// request line. It contains no validation logic of its own: every verdict is the library's.
//
// It is launched in Java's source-file mode, so nothing is compiled ahead of time:
//
//     java -cp "$(ops/cedar_validate.sh classpath)" ops/cedar_validation_bridge.java --template-cache 500
//
// Requests are JSON objects, one per line. Every request may carry a "seq" the answer echoes.
//
//     {"op": "hello"}
//     {"op": "cache-template", "id": "<template @id>", "template": {...}}
//     {"op": "validate", "kind": "template" | "element" | "field", "artifact": {...}}
//     {"op": "validate", "kind": "instance", "templateId": "<template @id>", "artifact": {...}}
//     {"op": "shutdown"}
//
// A validate answer carries "status": "valid", "invalid", "template-missing" (the caller sends the
// template and asks again) or "error" (the library threw, with the exception's class and message).
// An invalid answer lists the library's errors and warnings as {message, location}. Nothing but
// answers goes to stdout; the library's logging goes to stderr.
//
// ops/cedar_artifact_validation_audit.py is the caller this exists for.

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import java.util.Map;

public class CedarValidationBridge {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final int DEFAULT_TEMPLATE_CACHE = 500;
  private static final int MESSAGE_LIMIT = 1000;

  private final ModelValidator validator = new CedarValidator();
  private final Map<String, JsonNode> templates;
  private final int templateCapacity;

  private CedarValidationBridge(int templateCapacity) {
    this.templateCapacity = templateCapacity;
    this.templates = new LinkedHashMap<>(16, 0.75f, true) {
      @Override
      protected boolean removeEldestEntry(Map.Entry<String, JsonNode> eldest) {
        return size() > CedarValidationBridge.this.templateCapacity;
      }
    };
  }

  public static void main(String[] args) throws Exception {
    int templateCapacity = DEFAULT_TEMPLATE_CACHE;
    for (int i = 0; i < args.length; i++) {
      if ("--template-cache".equals(args[i]) && i + 1 < args.length) {
        templateCapacity = Integer.parseInt(args[++i]);
      } else {
        System.err.println("usage: CedarValidationBridge [--template-cache N]");
        System.exit(2);
      }
    }
    if (templateCapacity < 1) {
      System.err.println("--template-cache must be at least 1");
      System.exit(2);
    }
    CedarValidationBridge bridge = new CedarValidationBridge(templateCapacity);
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
          answer.put("templateCache", templateCapacity);
          answer.put("java", System.getProperty("java.version"));
        }
        case "cache-template" -> {
          String id = request.path("id").asText();
          JsonNode template = request.get("template");
          if (id.isEmpty() || template == null || !template.isObject()) {
            answer.put("status", "error");
            answer.put("message", "cache-template needs a non-empty id and an object template");
          } else {
            templates.put(id, template);
            answer.put("status", "ok");
            answer.put("cached", templates.size());
          }
        }
        case "validate" -> validate(request, answer);
        case "shutdown" -> answer.put("status", "ok");
        default -> {
          answer.put("status", "error");
          answer.put("message", "unknown op: " + op);
        }
      }
    } catch (Throwable t) {
      // A malformed artifact can make the library throw rather than report, and one such document
      // must not end the run. The caller records the exception as the verdict for that artifact.
      answer.put("status", "error");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
    }
    answer.put("millis", (System.nanoTime() - started) / 1_000_000);
    return answer;
  }

  private void validate(JsonNode request, ObjectNode answer) throws Exception {
    String kind = request.path("kind").asText();
    JsonNode artifact = request.get("artifact");
    if (artifact == null) {
      answer.put("status", "error");
      answer.put("message", "validate needs an artifact");
      return;
    }
    ValidationReport report;
    switch (kind) {
      case "template" -> report = validator.validateTemplate(artifact);
      case "element" -> report = validator.validateTemplateElement(artifact);
      case "field" -> report = validator.validateTemplateField(artifact);
      case "instance" -> {
        String templateId = request.path("templateId").asText();
        JsonNode template = templateId.isEmpty() ? null : templates.get(templateId);
        if (template == null) {
          answer.put("status", "template-missing");
          answer.put("templateId", templateId);
          return;
        }
        report = validator.validateTemplateInstance(artifact, template);
      }
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
