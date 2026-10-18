import assert from "node:assert/strict";
import {artifactBody, call, mutate, enc} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";
import {editorStatus} from "./metadata-journey-fixtures.mjs";

// No response injection: another REST client tightens the template while Editor
// holds its earlier projection. The real server saves the value and reports its quality finding.
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

  const draft = structuredClone(before.body);
  draft.Code["@value"] = "lowercase";
  const report = await call(user.auth, "POST", "/command/validate?resource_type=instance", draft);
  assert.equal(report.status, 200, report.text);
  assert.equal(report.body.canSave, true); assert.equal(report.body.isValid, false); assert.equal(report.body.validates, "true");
  assert.ok(report.body.warnings.some(error => error.location === "/Code/@value"), report.text);
  const save = page.locator("#button-save-metadata");
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const saved = await read("template-instances", instanceId);
  const content = value => {
    const copy = structuredClone(value); delete copy["pav:lastUpdatedOn"]; delete copy["oslc:modifiedBy"]; return copy;
  };
  assert.deepEqual(content(saved.body), content(draft));
  assert.notEqual(saved.headers.get("etag"), before.headers.get("etag"));
  await page.reload(); await editorStatus(page, /^Unmodified$/).waitFor();
  const issues = page.getByLabel("Metadata warnings", {exact: true});
  await issues.waitFor(); await issues.locator("summary").click();
  await issues.locator("li").filter({hasText: /Code.*(match|pattern)/i}).waitFor();
  assert.equal(await page.getByLabel("Metadata errors", {exact: true}).count(), 0);
  assert.equal(await code.inputValue(), "lowercase");
  assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Preserved answer");
  await page.waitForFunction(() => {
    const report = document.querySelector("cedar-embeddable-editor")?.dataQualityReport;
    return report?.canSave === true && report?.isValid === false;
  });
  // A fresh editor holding the tightened template also permits a well-formed nonmatching answer.
  await code.fill("MixedCase");
  await editorStatus(page, /^Modified$/).waitFor();
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  draft.Code["@value"] = "MixedCase";
  assert.deepEqual(content((await read("template-instances", instanceId)).body), content(draft));
  await code.fill("CORRECTED"); await issues.waitFor({state: "hidden"});
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  draft.Code["@value"] = "CORRECTED";
  assert.deepEqual(content((await read("template-instances", instanceId)).body), content(draft));
  await page.reload(); await editorStatus(page, /^Unmodified$/).waitFor(); await code.waitFor();
  assert.equal(await code.inputValue(), "CORRECTED");
  assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Preserved answer");
  await page.getByLabel("Metadata warnings", {exact: true}).waitFor({state: "hidden"});
  pass("tightened-regex", "A newly tightened template regex permits stale and fresh Editor saves, reports value-quality warnings on reload, and permits correction without losing other content");
}
