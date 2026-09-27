import com.fasterxml.jackson.databind.ObjectMapper;
import org.metadatacenter.model.rdf.RdfConverter;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** JSONL bridge over the shipped Java converter. Preparation is independent of CEE. */
public class TitaniumBridge {
  public static void main(String[] args) throws Exception {
    var mapper = new ObjectMapper();
    var reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = reader.readLine()) != null) {
      var answer = mapper.createObjectNode();
      long start = System.nanoTime();
      try {
        var request = mapper.readTree(line);
        var source = request.get("source");
        var template = request.get("template");
        String before = source.toString();
        answer.put("nquads", RdfConverter.toNQuads(source, template)).put("ok", true);
        try { answer.put("turtle", RdfConverter.toTurtle(source, template)).put("turtleOk", true); }
        catch (Exception error) { answer.put("turtleOk", false).put("turtleError", error.getMessage()); }
        answer.put("inputUnchanged", before.equals(source.toString()));
      } catch (Exception error) {
        answer.put("ok", false).put("error", error.getClass().getSimpleName() + ": " + error.getMessage());
      }
      answer.put("elapsedMs", (System.nanoTime() - start) / 1_000_000.0);
      System.out.println(answer);
    }
  }
}
