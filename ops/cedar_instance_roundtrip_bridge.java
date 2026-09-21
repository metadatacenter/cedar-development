// A long-lived front for cedar-artifact-library's instance readers and renderers, driven over
// stdin and stdout.
//
// It answers two questions about one template instance. Can the library read the YAML the server
// served, and does it render that YAML back unchanged? And does the instance survive a trip
// through YAML — JSON to the model, out as YAML, back to the model, out as JSON again — with
// nothing lost that the template cannot restore?
//
// The second question needs care, because the YAML representation is lossy on purpose. It carries
// no JSON-LD context and no field that holds nothing, and the server completes both against the
// template when a YAML instance is written. A comparison that counted those would report every
// instance as broken, so this bridge separates them: a difference is benign when the value it
// concerns is a context term, a field holding nothing, or an element whose every descendant field
// holds nothing. Everything else is content the round trip lost, and is reported with its path.
//
// It is launched in Java's source-file mode, so nothing is compiled ahead of time:
//
//     java -cp "<artifact library classes>:<artifact library deps>" \
//       ops/cedar_instance_roundtrip_bridge.java
//
// Requests are JSON objects, one per line. Every request may carry a "seq" the answer echoes.
//
//     {"op": "hello"}
//     {"op": "serves", "yaml": "<document the server served>"}
//     {"op": "roundtrip", "json": "<document the server served>"}
//     {"op": "shutdown"}
//
// A "serves" answer carries "status": "ok" with "reproduced" saying whether re-rendering the
// document the library read gives the document back, or "error" with the "stage" it failed at —
// "parse" for a document YAML itself rejects, "read" for one the instance model cannot represent.
// A "roundtrip" answer carries "survives", the benign counts, and "losses": each one a "kind",
// the "path" it sits at and a short "value".
//
// ops/cedar_instance_roundtrip_audit.py is the caller this exists for. Its siblings
// ops/cedar_yaml_convert_bridge.java and ops/cedar_validation_bridge.java answer the same shape of
// question about schema artifacts and about validity; neither reads or writes instance YAML.

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.metadatacenter.artifacts.model.core.TemplateInstanceArtifact;
import org.metadatacenter.artifacts.model.reader.JsonArtifactReader;
import org.metadatacenter.artifacts.model.reader.YamlArtifactReader;
import org.metadatacenter.artifacts.model.renderer.JsonArtifactRenderer;
import org.metadatacenter.artifacts.model.renderer.YamlArtifactRenderer;
import org.yaml.snakeyaml.Yaml;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class CedarInstanceRoundtripBridge {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final int MAX_LOSSES = 40;
  private static final int MAX_TEXT = 300;

  private final JsonArtifactReader jsonReader = new JsonArtifactReader();
  private final YamlArtifactReader yamlReader = new YamlArtifactReader();
  private final JsonArtifactRenderer jsonRenderer = new JsonArtifactRenderer();
  private final YamlArtifactRenderer yamlRenderer = new YamlArtifactRenderer(false);

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    CedarInstanceRoundtripBridge bridge = new CedarInstanceRoundtripBridge();
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) continue;
      ObjectNode answer = bridge.answer(line);
      out.println(MAPPER.writeValueAsString(answer));
      if ("shutdown".equals(answer.path("op").asText())) break;
    }
  }

  private ObjectNode answer(String line) {
    ObjectNode answer = MAPPER.createObjectNode();
    JsonNode request;
    try {
      request = MAPPER.readTree(line);
    } catch (Exception e) {
      answer.put("op", "?");
      answer.put("status", "error");
      answer.put("message", truncate("request is not JSON: " + e.getMessage()));
      return answer;
    }
    if (request.has("seq")) answer.set("seq", request.get("seq"));
    String op = request.path("op").asText();
    answer.put("op", op);
    try {
      switch (op) {
        case "hello" -> {
          answer.put("status", "ok");
          answer.put("reader", YamlArtifactReader.class.getName());
          answer.put("renderer", YamlArtifactRenderer.class.getName());
          answer.put("java", System.getProperty("java.version"));
        }
        case "serves" -> serves(request, answer);
        case "roundtrip" -> roundtrip(request, answer);
        case "shutdown" -> answer.put("status", "ok");
        default -> {
          answer.put("status", "error");
          answer.put("message", "unknown op: " + op);
        }
      }
    } catch (Throwable t) {
      // One malformed instance must not end a sweep of a hundred thousand. The caller records the
      // exception as that instance's verdict and moves on.
      answer.put("status", "error");
      answer.put("exception", t.getClass().getName());
      answer.put("message", truncate(String.valueOf(t.getMessage())));
    }
    return answer;
  }

  /** Can the library read the YAML the server served, and does it write the same document back? */
  private void serves(JsonNode request, ObjectNode answer) {
    JsonNode text = request.get("yaml");
    if (text == null || !text.isTextual()) {
      answer.put("status", "error");
      answer.put("stage", "request");
      answer.put("message", "serves needs a textual yaml document");
      return;
    }
    Object parsed;
    try {
      parsed = new Yaml().load(text.asText());
    } catch (Exception e) {
      answer.put("status", "error");
      answer.put("stage", "parse");
      answer.put("message", truncate(String.valueOf(e.getMessage())));
      return;
    }
    if (!(parsed instanceof LinkedHashMap<?, ?>)) {
      answer.put("status", "error");
      answer.put("stage", "parse");
      answer.put("message", "the document is not a YAML mapping");
      return;
    }
    @SuppressWarnings("unchecked")
    LinkedHashMap<String, Object> source = (LinkedHashMap<String, Object>) parsed;

    TemplateInstanceArtifact instance;
    try {
      instance = yamlReader.readTemplateInstanceArtifact(source);
    } catch (Exception e) {
      answer.put("status", "error");
      answer.put("stage", "read");
      answer.put("message", truncate(String.valueOf(e.getMessage())));
      return;
    }

    List<String> differences = new ArrayList<>();
    difference("", source, yamlRenderer.renderTemplateInstanceArtifact(instance), differences);
    answer.put("status", "ok");
    answer.put("reproduced", differences.isEmpty());
    if (!differences.isEmpty()) {
      ArrayNode where = answer.putArray("differences");
      differences.stream().limit(MAX_LOSSES).forEach(where::add);
    }
  }

  /** Does the instance survive JSON to the model, out as YAML, back, and out as JSON again? */
  private void roundtrip(JsonNode request, ObjectNode answer) throws Exception {
    JsonNode text = request.get("json");
    if (text == null || !text.isTextual()) {
      answer.put("status", "error");
      answer.put("stage", "request");
      answer.put("message", "roundtrip needs a textual json document");
      return;
    }
    JsonNode source = MAPPER.readTree(text.asText());
    TemplateInstanceArtifact instance;
    try {
      instance = jsonReader.readTemplateInstanceArtifact((ObjectNode) source);
    } catch (Exception e) {
      answer.put("status", "error");
      answer.put("stage", "read");
      answer.put("message", truncate(String.valueOf(e.getMessage())));
      return;
    }

    LinkedHashMap<String, Object> asYaml = yamlRenderer.renderTemplateInstanceArtifact(instance);
    TemplateInstanceArtifact viaYaml = yamlReader.readTemplateInstanceArtifact(asYaml);

    @SuppressWarnings("unchecked")
    Map<String, Object> before = MAPPER.convertValue(
      jsonRenderer.renderTemplateInstanceArtifact(instance), Map.class);
    @SuppressWarnings("unchecked")
    Map<String, Object> after = MAPPER.convertValue(
      jsonRenderer.renderTemplateInstanceArtifact(viaYaml), Map.class);

    List<String> differences = new ArrayList<>();
    difference("", before, after, differences);

    int contextTerms = 0, emptyFields = 0, emptyElements = 0;
    ArrayNode losses = MAPPER.createArrayNode();
    for (String raw : differences) {
      String verb = raw.substring(0, raw.indexOf(' '));
      String rest = raw.substring(raw.indexOf(' ') + 1);
      if (verb.equals("length")) {
        // A multi-instance list that renders shorter than it was stored has lost an entry, and
        // every entry after it has moved. The count is information the template cannot restore.
        if (losses.size() < MAX_LOSSES) losses.add(loss("list-shortened", rest, ""));
        continue;
      }
      if (!verb.equals("dropped")) {
        // A value difference reads "<path> <before> -> <after>", so the path is the first token.
        int space = rest.indexOf(' ');
        String path = space < 0 ? rest : rest.substring(0, space);
        if (losses.size() < MAX_LOSSES)
          losses.add(loss(path.endsWith("/@type") ? "type-changed" : "value-changed", rest, ""));
        continue;
      }
      if (rest.contains("/@context/") || rest.endsWith("/@context")) { contextTerms++; continue; }
      Object value = resolve(before, rest.startsWith("/") ? rest.substring(1) : rest);
      if (value == MISSING) {
        if (losses.size() < MAX_LOSSES) losses.add(loss("unresolved", rest, ""));
        continue;
      }
      if (holdsNothing(value)) { emptyFields++; continue; }
      if (hollowElement(value)) { emptyElements++; continue; }
      if (losses.size() < MAX_LOSSES) losses.add(loss(kindOf(value), rest, brief(value)));
    }

    answer.put("status", "ok");
    answer.put("survives", losses.isEmpty());
    answer.put("contextTerms", contextTerms);
    answer.put("emptyFields", emptyFields);
    answer.put("emptyElements", emptyElements);
    answer.put("lossCount", losses.size());
    if (!losses.isEmpty()) answer.set("losses", losses);
  }

  private ObjectNode loss(String kind, String path, String value) {
    ObjectNode node = MAPPER.createObjectNode();
    node.put("kind", kind);
    node.put("path", truncate(path));
    if (!value.isEmpty()) node.put("value", value);
    return node;
  }

  /** Name the shape of a value the round trip dropped, so a sweep can tally causes. */
  private String kindOf(Object value) {
    if (value instanceof Map<?, ?> map) {
      if (map.size() == 1 && map.containsKey("@type")) return "type-only-field";
      for (Object key : map.keySet())
        if ("type".equals(key) || "id".equals(key) || "children".equals(key))
          return "group-under-a-reserved-key";
    }
    return "content";
  }

  private static final Object MISSING = new Object();

  /**
   * Walk a '/'-joined path. A child key may itself contain '/', so the longest key that resolves
   * wins rather than the first segment.
   */
  private Object resolve(Object node, String remainder) {
    if (remainder.isEmpty()) return node;
    if (!(node instanceof Map<?, ?> map)) return MISSING;
    String[] parts = remainder.split("/");
    for (int take = parts.length; take >= 1; take--) {
      StringBuilder step = new StringBuilder();
      for (int i = 0; i < take; i++) step.append(i == 0 ? "" : "/").append(parts[i]);
      StringBuilder rest = new StringBuilder();
      for (int i = take; i < parts.length; i++) rest.append(i == take ? "" : "/").append(parts[i]);

      String key = step.toString();
      int index = -1;
      if (key.endsWith("]") && key.lastIndexOf('[') > 0) {
        int open = key.lastIndexOf('[');
        try {
          index = Integer.parseInt(key.substring(open + 1, key.length() - 1));
          key = key.substring(0, open);
        } catch (NumberFormatException ignored) {
          index = -1;
        }
      }
      if (!map.containsKey(key)) continue;
      Object inner = map.get(key);
      if (index >= 0) {
        if (!(inner instanceof List<?> list) || index >= list.size()) continue;
        inner = list.get(index);
      }
      Object found = resolve(inner, rest.toString());
      if (found != MISSING) return found;
    }
    return MISSING;
  }

  /** A field instance that holds nothing: no value, no id, no label. */
  private boolean holdsNothing(Object value) {
    if (value == null) return true;
    if (value instanceof Map<?, ?> map) {
      if (map.isEmpty()) return true;
      if (map.containsKey("@value") && map.get("@value") == null
        && map.keySet().stream().allMatch(k -> k.equals("@value") || k.equals("@type"))) return true;
      if (map.keySet().stream().allMatch(k -> k.equals("@id") || k.equals("rdfs:label")
        || k.equals("skos:notation") || k.equals("@type")) && map.get("@id") == null) return true;
      return false;
    }
    if (value instanceof List<?> list)
      return list.isEmpty() || list.stream().allMatch(this::holdsNothing);
    return false;
  }

  /** An element instance whose every descendant field holds nothing. */
  private boolean hollowElement(Object value) {
    if (!(value instanceof Map<?, ?> map)) return false;
    if (!map.containsKey("@id") && !map.containsKey("@context")) return false;
    for (Map.Entry<?, ?> entry : map.entrySet()) {
      Object key = entry.getKey(), inner = entry.getValue();
      if ("@id".equals(key) || "@context".equals(key) || "@type".equals(key)) continue;
      // An attribute-value group states its member names as a list of strings; that listing is
      // structure rather than content, so it does not make the element non-hollow by itself.
      if (inner instanceof List<?> names && !names.isEmpty()
        && names.stream().allMatch(n -> n instanceof String)) continue;
      if (holdsNothing(inner) || hollowElement(inner)) continue;
      if (inner instanceof List<?> list
        && list.stream().allMatch(x -> holdsNothing(x) || hollowElement(x))) continue;
      return false;
    }
    return true;
  }

  /** Structural comparison: the order of keys is not a difference, presence and value are. */
  private void difference(String at, Object left, Object right, List<String> into) {
    if (into.size() > 400) return;
    if (left instanceof Map<?, ?> leftMap && right instanceof Map<?, ?> rightMap) {
      for (Object key : leftMap.keySet()) {
        if (!rightMap.containsKey(key)) into.add("dropped " + at + "/" + key);
        else difference(at + "/" + key, leftMap.get(key), rightMap.get(key), into);
      }
      for (Object key : rightMap.keySet())
        if (!leftMap.containsKey(key)) into.add("added " + at + "/" + key);
    } else if (left instanceof List<?> leftList && right instanceof List<?> rightList) {
      if (leftList.size() != rightList.size())
        into.add("length " + at + " " + leftList.size() + "->" + rightList.size());
      else
        for (int i = 0; i < leftList.size(); i++)
          difference(at + "[" + i + "]", leftList.get(i), rightList.get(i), into);
    } else if (left == null ? right != null : !left.equals(right)) {
      into.add("value " + at + " " + brief(left) + " -> " + brief(right));
    }
  }

  private String brief(Object value) {
    String text = String.valueOf(value);
    return text.length() > 80 ? text.substring(0, 80) + "..." : text;
  }

  private static String truncate(String text) {
    if (text == null) return "";
    return text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) + "..." : text;
  }
}
