import assert from "node:assert/strict";
import {artifactBody, call, mutate, enc} from "./rest/lib.mjs";
import {focused, journeyFolder} from "./journey-fixtures.mjs";
import {editorStatus} from "./metadata-journey-fixtures.mjs";

// No response injection: another REST client tightens the template while Editor
// holds its earlier projection. The real server must reject and locate the value.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function currentTemplateConstraintJourney({page, base, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "current template constraint");
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  async function read(collection, id) {
    const result = await call(user.auth, "GET", "/" + collection + "/" + enc(id));
    assert.equal(result.status, 200, result.text);
    return result;
  }
  const template = artifactBody("template", name + " current constraints");
  for (const key of ["Code", "Keep"]) {
    template.properties[key] = artifactBody("field", key);
    template.properties["@context"].properties[key] = {enum: ["https://example.org/constraints/" + key]};
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template.required.push(key);
  }
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", name + " stale template metadata", {
    "schema:isBasedOn": templateId, Code: {"@value": "ABC"}, Keep: {"@value": "Preserved answer"},
  });
  for (const key of ["Code", "Keep"]) instance["@context"][key] = "https://example.org/constraints/" + key;
  instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
  const instanceId = await create("template-instances", instance);
  const before = await read("template-instances", instanceId);
  await page.goto(base + "/instances/edit/" + enc(instanceId));
  const cee = page.locator("cedar-embeddable-editor");
  const code = cee.getByLabel("Code", {exact: true});
  // Tighten the template only once the editor holds the earlier one.
  await editorStatus(page, /^Unmodified$/).waitFor();
  await code.fill("lowercase");
  await editorStatus(page, /^Modified$/).waitFor();
  const updatedTemplate = (await read("templates", templateId)).body;
  updatedTemplate.properties.Code._valueConstraints.regex = "^[A-Z]+$";
  const tightened = await mutate(user.auth, "PUT", "/templates/" + enc(templateId), updatedTemplate);
  assert.equal(tightened.status, 200, tightened.text);

  const save = page.locator("#button-save-metadata");
  const rejection = await write(page, "PUT", "/template-instances/", () => save.click(), 400, true);
  assert.ok(rejection.objects.validationReport.errors.some(error =>
    error.location === "/Code/@value" && error.message === "Does not match ^[A-Z]+$."), JSON.stringify(rejection));
  const refused = await read("template-instances", instanceId);
  assert.deepEqual(refused.body, before.body);
  assert.equal(refused.headers.get("etag"), before.headers.get("etag"));
  // The editor lists the server's findings once it has handled the refusal.
  const issues = page.getByLabel("Metadata errors", {exact: true});
  await issues.waitFor();
  assert.equal(await code.inputValue(), "lowercase");
  assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Preserved answer");
  assert.equal(await save.isDisabled(), true);
  await issues.locator("summary").click();
  await issues.getByRole("button", {name: /Code.*Does not match/}).click();
  await focused(code, "regex finding did not focus Code");
  await code.fill("CORRECTED");
  await issues.waitFor({state: "detached"});
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const after = (await read("template-instances", instanceId)).body;
  const expected = structuredClone(before.body);
  expected.Code["@value"] = "CORRECTED";
  for (const value of [after, expected]) { delete value["pav:lastUpdatedOn"]; delete value["oslc:modifiedBy"]; }
  assert.deepEqual(after, expected);
  await page.reload();
  await editorStatus(page, /^Unmodified$/).waitFor();
  await code.waitFor();
  assert.equal(await code.inputValue(), "CORRECTED");
  assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Preserved answer");
  await code.fill("lowercase");
  await page.waitForFunction(() => document.querySelector("#button-save-metadata")?.disabled === true);
  assert.equal((await read("template-instances", instanceId)).body.Code["@value"], "CORRECTED");
  await code.fill("CORRECTED");
  pass("A newly tightened template regex rejects the stale Editor's save at the real server, focuses the answer, and permits correction without losing other content");
}
