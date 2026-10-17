import assert from "node:assert/strict";
import {artifactBody, call, enc} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";

function renameChild(document, from, to) {
  const result = structuredClone(document);
  for (const map of [result.properties, result.properties["@context"].properties,
    result._ui.propertyLabels, result._ui.propertyDescriptions]) {
    if (Object.hasOwn(map, from)) { map[to] = map[from]; delete map[from]; }
  }
  for (const array of [result.required, result.properties["@context"].required, result._ui.order]) {
    if (array) for (let i = 0; i < array.length; i++) if (array[i] === from) array[i] = to;
  }
  return result;
}
function content(document) {
  const result = structuredClone(document);
  delete result["pav:lastUpdatedOn"];
  delete result["oslc:modifiedBy"];
  return result;
}

// The journey acts as the runner's first test user only and never signs in as another account.
export async function olderKeyRenameJourney({page, designer, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "older key rename");
  const template = artifactBody("template", name + " older child rename");
  for (const key of ["Notes", "Keep"]) {
    template.properties[key] = artifactBody("field", key);
    template.properties[key]._annotations = {"https://example.org/rename/note": {"@value": "Keep " + key}};
    template.properties["@context"].properties[key] = {enum: ["https://example.org/rename/" + key]};
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template._ui.propertyDescriptions[key] = "Original " + key;
    template.required.push(key);
  }
  const createdTemplate = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), template);
  assert.equal(createdTemplate.status, 201, createdTemplate.text);
  const id = createdTemplate.body["@id"];
  created.push({collection: "templates", id});
  const path = "/templates/" + enc(id);
  async function read() {
    const result = await call(user.auth, "GET", path);
    assert.equal(result.status, 200, result.text);
    return result.body;
  }
  const before = await read();
  await page.goto(designer + "/templates/edit/" + enc(id));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  const card = page.locator("app-field-card").first();
  const settings = card.locator("app-field-settings");
  await settings.locator(".settings-toggle").click();
  await settings.getByRole("tab", {name: "Configuration", exact: true}).click();
  await settings.getByLabel("Key", {exact: true}).fill("Renamed");
  await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
  await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
  const expected = renameChild(before, "Notes", "Renamed");
  assert.deepEqual(content(await read()), content(expected), "renaming a key must preserve its older definition and every unrelated branch");
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  await settings.locator(".settings-toggle").click();
  await settings.getByRole("tab", {name: "Configuration", exact: true}).click();
  assert.equal(await settings.getByLabel("Key", {exact: true}).inputValue(), "Renamed");
  assert.equal(await card.getByLabel("Field display name", {exact: true}).inputValue(), "Notes");
  pass("rename-preserves-content", "Renaming an older template's child key preserves its definition, annotations, identity, property IRI and sibling content through save and reopen");
}
