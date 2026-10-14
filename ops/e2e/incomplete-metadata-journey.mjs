import assert from "node:assert/strict";
import { call, enc } from "./rest/lib.mjs";

// Missing required values are warnings under the existing Editor contract.
// Prove that saving work in progress does not falsely mark it complete, and that
// the author can reopen and finish it without losing the answers already given.
export async function incompleteMetadataJourney({page, base, user, folderId, templateId, name, created, write, pass}) {
  const source = await call(user.auth, "GET", "/templates/" + enc(templateId));
  assert.equal(source.status, 200);
  const template = structuredClone(source.body);
  template["@id"] = null;
  template["schema:name"] = name + " required template";
  template.properties.Notes._valueConstraints = {
    ...template.properties.Notes._valueConstraints, requiredValue: true,
  };
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), template);
  assert.equal(made.status, 201, made.text);
  created.push({collection: "templates", id: made.body["@id"]});
  await page.goto(base + "/instances/create/" + enc(made.body["@id"]) + "?folderId=" + enc(folderId));
  const cee = page.locator("cedar-embeddable-editor");
  const notes = cee.getByLabel("Notes", {exact: false}).first();
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "");
  await page.locator("#instance-name").fill(name + " incomplete metadata");
  const disease = cee.getByLabel("Disease", {exact: false}).first();
  const influenza = page.getByRole("option", {name: /influenza/i}).first();
  for (let attempt = 0; ; attempt++) {
    await disease.fill("");
    await disease.pressSequentially("influenza", {delay: 40});
    if (await influenza.waitFor({timeout: 15000}).then(() => true, () => false)) break;
    assert.ok(attempt < 2, "no Disease suggestion for the incomplete metadata journey");
  }
  await influenza.click();
  const warnings = page.locator("details.validation-summary--warning");
  await warnings.waitFor();
  assert.equal(await page.locator("#button-save-metadata").isEnabled(), true);
  const firstSave = await write(page, "POST", "/template-instances",
    () => page.locator("#button-save-metadata").click(), 201);
  await page.waitForURL(/\/instances\/edit\//);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  assert.equal(await warnings.count(), 1, "a saved incomplete record must still show its warning");
  const instancePath = "/template-instances/" + enc(firstSave["@id"]);
  const incomplete = (await call(user.auth, "GET", instancePath)).body;
  assert.equal(incomplete.Notes["@value"], null);
  assert.match(incomplete.Disease["@id"], /DOID_\d+$/);
  const editUrl = page.url();
  await page.getByRole("button", {name: "Back to Workspace", exact: true}).click();
  await page.locator("cedar-workspace-page .destinations").waitFor();
  await page.goto(editUrl);
  await notes.waitFor();
  await warnings.waitFor();
  assert.equal(await notes.inputValue(), "");
  assert.match(await disease.inputValue(), /influenza/i);
  await notes.fill("Completed after reopening");
  await warnings.waitFor({state: "detached"});
  await write(page, "PUT", "/template-instances/",
    () => page.locator("#button-save-metadata").click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const completed = (await call(user.auth, "GET", instancePath)).body;
  assert.equal(completed.Notes["@value"], "Completed after reopening");
  assert.deepEqual(completed.Disease, incomplete.Disease);
  assert.equal(completed["@id"], incomplete["@id"]);
  await page.getByRole("button", {name: "Back to Workspace", exact: true}).click();
  await page.locator("cedar-workspace-page .destinations").waitFor();
  pass("Incomplete required metadata saves with warnings, reopens with its answers intact and completes on the same instance");
}
