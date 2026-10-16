import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { comparable } from "./metadata-journey-fixtures.mjs";

export async function fieldConfiguration(page) {
  const settings = page
    .locator("app-field-card")
    .first()
    .locator("app-field-settings");
  const toggle = settings.locator(".settings-toggle");
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await settings
    .getByRole("tab", { name: "Configuration", exact: true })
    .click();
  return settings.getByRole("tabpanel", { name: "Configuration", exact: true });
}
export async function schemaFixture(args, kind, suffix) {
  const { user, name, created, designer } = args,
    folderId = await journeyFolder(args, suffix + " " + kind);
  const source = artifactBody(kind, name + " " + suffix + " " + kind);
  source._annotations = {
    "https://example.org/structural/root": {
      "@value": "Retained root annotation",
    },
  };
  for (const key of ["Notes", "Keep"]) {
    const field = artifactBody("field", key);
    field._annotations = {
      "https://example.org/structural/field": { "@value": "Retained " + key },
    };
    field["schema:identifier"] = "older-" + key;
    source.properties[key] = field;
    source.properties["@context"].properties[key] = {
      enum: ["https://example.org/structural/" + key],
    };
    source._ui.order.push(key);
    source._ui.propertyLabels[key] = key;
    source._ui.propertyDescriptions[key] = "Placement " + key;
    source.required.push(key);
  }
  const collection = kind === "template" ? "templates" : "template-elements";
  const createdResult = await call(
    user.auth,
    "POST",
    "/" + collection + "?folder_id=" + enc(folderId),
    source,
  );
  assert.equal(createdResult.status, 201, createdResult.text);
  const id = createdResult.body["@id"];
  created.push({ collection, id });
  const path = "/" + collection + "/" + enc(id),
    read = async () => {
      const result = await call(user.auth, "GET", path);
      assert.equal(result.status, 200, result.text);
      return result.body;
    };
  return {
    path,
    read,
    collection,
    url: designer + "/" + kind + "s/edit/" + enc(id),
  };
}
// The edited field may receive fresh update provenance; its authored content,
// creation provenance and the untouched sibling must remain exact.
function comparableSchema(body) {
  const copy = comparable(body),
    field = copy.properties.Notes.items ?? copy.properties.Notes;
  delete field["pav:lastUpdatedOn"];
  delete field["oslc:modifiedBy"];
  return copy;
}
export async function repeatedSchemaJourney(args) {
  const { page, write, pass } = args;
  for (const kind of ["template", "element"]) {
    const f = await schemaFixture(args, kind, "repeated schema"),
      before = await f.read();
    await page.goto(f.url);
    await page
      .locator("#state")
      .filter({ hasText: /^Unmodified$/ })
      .waitFor();
    let settings = await fieldConfiguration(page);
    await settings
      .getByRole("checkbox", { name: "Allow multiple", exact: true })
      .check();
    await settings.getByLabel("Minimum", { exact: true }).fill("2");
    await settings.getByLabel("Maximum", { exact: true }).fill("5");
    await write(
      page,
      "PUT",
      "/" + f.collection + "/",
      () => page.locator("#save").click(),
      200,
      true,
    );
    await page
      .locator("#state")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    const expected = structuredClone(before);
    expected.properties.Notes = {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: before.properties.Notes,
    };
    assert.deepEqual(
      comparableSchema(await f.read()),
      comparableSchema(expected),
      "wrapping an older definition must preserve its stored contents and every sibling",
    );
    await page.reload();
    await page
      .locator("#state")
      .filter({ hasText: /^Unmodified$/ })
      .waitFor();
    settings = await fieldConfiguration(page);
    assert.equal(
      await settings.getByLabel("Minimum", { exact: true }).inputValue(),
      "2",
    );
    assert.equal(
      await settings.getByLabel("Maximum", { exact: true }).inputValue(),
      "5",
    );
    await settings.getByLabel("Maximum", { exact: true }).fill("7");
    await write(
      page,
      "PUT",
      "/" + f.collection + "/",
      () => page.locator("#save").click(),
      200,
      true,
    );
    await page
      .locator("#state")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    expected.properties.Notes.maxItems = 7;
    assert.deepEqual(
      comparableSchema(await f.read()),
      comparableSchema(expected),
    );
    await settings
      .getByRole("checkbox", { name: "Allow multiple", exact: true })
      .uncheck();
    await write(
      page,
      "PUT",
      "/" + f.collection + "/",
      () => page.locator("#save").click(),
      200,
      true,
    );
    await page
      .locator("#state")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.deepEqual(
      comparableSchema(await f.read()),
      comparableSchema(before),
      "unwrapping restores the original schema without normalizing unrelated content",
    );
    await page.reload();
    await page
      .locator("#state")
      .filter({ hasText: /^Unmodified$/ })
      .waitFor();
    settings = await fieldConfiguration(page);
    assert.equal(
      await settings
        .getByRole("checkbox", { name: "Allow multiple", exact: true })
        .isChecked(),
      false,
    );
    pass(
      `${kind}: older field definitions survive repeat wrapping, bound changes and unwrapping without changing annotations, constraints, identities or siblings`,
    );
  }
}
