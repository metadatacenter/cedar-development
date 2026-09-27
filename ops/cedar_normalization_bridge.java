// Read-only measurement of the real compatibility path. No normalization rules are duplicated here.
// Run in Java 17 source-file mode with cedar-config-library and its dependencies on the classpath.
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.metadatacenter.config.LinkedDataConfig;
import org.metadatacenter.model.CedarResourceType;
import org.metadatacenter.server.jsonld.LinkedDataUtil;
import java.io.*;
import java.nio.charset.StandardCharsets;

class CedarNormalizationBridge {
  public static void main(String[] args) throws Exception {
    ObjectMapper mapper = new ObjectMapper();
    LinkedDataUtil util = new LinkedDataUtil(mapper.readValue(
        "{\"base\":\"https://repo.metadatacenter.org/\",\"usersBase\":\"https://metadatacenter.org/users/\"}",
        LinkedDataConfig.class));
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    String line;
    while ((line = input.readLine()) != null) {
      JsonNode request = mapper.readTree(line);
      ObjectNode answer = mapper.createObjectNode();
      answer.set("seq", request.get("seq"));
      String op = request.path("op").asText();
      try {
        if (op.equals("audit")) {
          JsonNode stored = request.required("artifact");
          if (!stored.isObject()) throw new IllegalArgumentException("artifact must be an object");
          CedarResourceType type = CedarResourceType.valueOf(request.required("kind").asText().toUpperCase());
          JsonNode template = request.get("template");
          if (template != null && template.isNull()) template = null;
          // Deep copy is essential: the implementation mutates the submitted body.
          answer.set("repairs", mapper.valueToTree(util.repairInheritedDefects(
              stored.deepCopy(), stored, template, type)));
          answer.put("complete", type != CedarResourceType.INSTANCE || template != null);
        } else if (!op.equals("hello") && !op.equals("shutdown")) {
          throw new IllegalArgumentException("unknown operation");
        }
        answer.put("status", "ok");
      } catch (Exception e) {
        answer.put("status", "error");
        answer.put("exception", e.getClass().getName());
        answer.put("message", String.valueOf(e.getMessage()));
      }
      output.println(mapper.writeValueAsString(answer));
      if (op.equals("shutdown")) break;
    }
  }
}
