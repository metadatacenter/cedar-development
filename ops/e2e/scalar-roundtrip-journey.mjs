import assert from "node:assert/strict";
import { artifactBody } from "./rest/lib.mjs";
import {
  metadataFixture,
  numericField,
  comparable,
  editorStatus,
} from "./metadata-journey-fixtures.mjs";

// The journey acts as the runner's first test user only and never signs in as another account.
export async function scalarRoundtripJourney(args) {
  const { page, write, pass } = args;
  const fields = {
    Decimal: numericField("Decimal"),
    Integer: numericField("Integer", "xsd:long"),
    NegativeZero: numericField("NegativeZero"),
    Notes: artifactBody("field", "Notes"),
  };
  for (const [key, type, granularity] of [
    ["LeapDate", "xsd:date", "day"],
    ["OffsetInstant", "xsd:dateTime", "decimalSecond"],
  ]) {
    const field = artifactBody("field", key);
    field._ui = {
      ...field._ui,
      inputType: "temporal",
      temporalGranularity: granularity,
      timezoneEnabled: true,
    };
    field._valueConstraints = { requiredValue: false, temporalType: type };
    field.required = ["@value", "@type"];
    fields[key] = field;
  }
  const values = {
    Decimal: { "@value": "0.10000000000000001", "@type": "xsd:decimal" },
    Integer: { "@value": "9007199254740993", "@type": "xsd:long" },
    NegativeZero: { "@value": "-0.000", "@type": "xsd:decimal" },
    LeapDate: { "@value": "2024-02-29", "@type": "xsd:date" },
    OffsetInstant: {
      "@value": "2026-11-01T01:30:45.123456-07:00",
      "@type": "xsd:dateTime",
    },
    Notes: { "@value": "Opened" },
  };
  const f = await metadataFixture(args, "scalar round trips", fields, values),
    before = (await f.read()).body;
  await page.goto(f.url);
  const cee = page.locator("cedar-embeddable-editor"),
    notes = cee.getByLabel("Notes", { exact: true }),
    save = page.locator("#button-save-metadata");
  // Every value is read and edited only once the page has loaded the record.
  const opened = async () => {
    await editorStatus(page, /^Unmodified$/).waitFor();
    await notes.waitFor();
  };
  await opened();
  for (const key of ["Decimal", "Integer", "NegativeZero"])
    assert.equal(
      await cee.getByLabel(key, { exact: true }).inputValue(),
      values[key]["@value"],
    );
  await notes.fill("Unrelated edit");
  await write(
    page,
    "PUT",
    "/template-instances/",
    () => save.click(),
    200,
    true,
  );
  await page
    .locator(".metadata-save-status")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  const expected = structuredClone(before);
  expected.Notes["@value"] = "Unrelated edit";
  assert.deepEqual(comparable((await f.read()).body), comparable(expected));
  await page.reload();
  await opened();
  for (const [key, value] of [
    ["Decimal", "1.23000000000000001"],
    ["Integer", "9007199254740995"],
    ["NegativeZero", "-0.00"],
  ]) {
    await cee.getByLabel(key, { exact: true }).fill(value);
    expected[key]["@value"] = value;
  }
  await write(
    page,
    "PUT",
    "/template-instances/",
    () => save.click(),
    200,
    true,
  );
  await page
    .locator(".metadata-save-status")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  assert.deepEqual(comparable((await f.read()).body), comparable(expected));
  await page.reload();
  await opened();
  for (const key of ["Decimal", "Integer", "NegativeZero"])
    assert.equal(
      await cee.getByLabel(key, { exact: true }).inputValue(),
      expected[key]["@value"],
    );
  pass(
    "Exact numeric text, large integers, signed zero, leap dates and offset/fractional timestamps survive unrelated edits and numeric corrections without changing other content",
  );
}
