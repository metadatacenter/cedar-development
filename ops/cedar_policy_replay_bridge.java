package org.metadatacenter.model.validation;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import org.metadatacenter.model.validation.report.CedarValidationReport;

/** Line-oriented offline comparison; emits verdicts, never the source values. */
class cedar_policy_replay_bridge {
  private static String decimalSignature(BigDecimal value) {
    String digits = value.unscaledValue().toString();
    if (value.signum() == 0) return "0e0";
    long exponent = -(long) value.scale();
    while (digits.endsWith("0")) { digits = digits.substring(0, digits.length() - 1); exponent++; }
    return digits + "e" + exponent;
  }

  public static void main(String[] args) throws Exception {
    var mapper = new ObjectMapper();
    var input = new BufferedReader(new InputStreamReader(System.in));
    String line;
    while ((line = input.readLine()) != null) {
      var row = mapper.readTree(line);
      String kind = row.get("kind").asText(), value = row.get("value").asText();
      Object result;
      try {
        result = switch (kind) {
          case "text" -> List.of(TextPolicy.isBlank(value), TextPolicy.codePointLength(value));
          case "identifier" -> IdentifierPolicy.isValid(value);
          case "timestamp" -> TimestampPolicy.format(TimestampPolicy.parse(value));
          case "numeric" -> decimalSignature(NumericPolicy.parse(value));
          case "json-source" -> {
            var sourceMapper = org.metadatacenter.model.policy.JsonSourcePolicy.apply(new ObjectMapper());
            var parsed = sourceMapper.readTree(value);
            yield sourceMapper.writeValueAsString(parsed);
          }
          case "regex" -> {
            var schema = mapper.createObjectNode();
            schema.putObject("_valueConstraints").put("regex", value);
            var answers = new java.util.ArrayList<Boolean>();
            var report = CedarValidationReport.newEmptyReport();
            FieldRegexValidation.validateSchema(schema, "", report);
            answers.add(report.getErrors().isEmpty());
            if (answers.get(0)) for (String sample : List.of("ABC", "abc", "123", "abc-123", "é", "😀", "\u00a0", "a\n")) {
              report = CedarValidationReport.newEmptyReport();
              FieldRegexValidation.validateInstance(mapper.createObjectNode().put("@value", sample), schema, "", report);
              answers.add(report.getErrors().isEmpty());
            }
            yield answers;
          }
          default -> throw new IllegalArgumentException("Unknown policy");
        };
      } catch (Exception invalid) { result = null; }
      System.out.println(mapper.writeValueAsString(result));
    }
  }
}
