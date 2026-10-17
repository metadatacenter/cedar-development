import assert from "node:assert/strict";
import { call, enc } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { diseaseTemplate, editorStatus, offeredTerm } from "./metadata-journey-fixtures.mjs";

// Missing required values are warnings under the existing Editor contract.
// Prove that saving work in progress does not falsely mark it complete, and that
// the author can reopen and finish it without losing the answers already given.
//
// The template has the fields the full smoke authors in Designer, a free-text Notes and a Disease
// constrained to the DOID "disease" branch, with Notes required.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function incompleteMetadataJourney({page, base, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "incomplete metadata");
  const template = diseaseTemplate(name + " required template");
  template.properties.Notes._valueConstraints = {
    ...template.properties.Notes._valueConstraints, requiredValue: true,
  };
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), template);
  assert.equal(made.status, 201, made.text);
  created.push({collection: "templates", id: made.body["@id"]});
  await page.goto(base + "/instances/create/" + enc(made.body["@id"]) + "?folderId=" + enc(folderId));
  const cee = page.locator("cedar-embeddable-editor");
  const notes = cee.getByLabel("Notes", {exact: false}).first();
  await editorStatus(page, /^Unmodified$/).waitFor();
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "");
  await page.locator("#instance-name").fill(name + " incomplete metadata");
  const disease = cee.getByLabel("Disease", {exact: false}).first();
  const influenza = await offeredTerm(page, disease, "influenza", /influenza/i,
    "no Disease suggestion for the incomplete metadata journey");
  await influenza.click();
  const warnings = page.locator("details.validation-summary--warning");
  await warnings.waitFor();
  assert.equal(await page.locator("#button-save-metadata").isEnabled(), true);
  // The first save creates the record by PUT, at an identity the editor minted.
  const firstSave = await write(page, "PUT", "/template-instances/",
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
  await editorStatus(page, /^Unmodified$/).waitFor();
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
  pass("complete-same-instance", "Incomplete required metadata saves with warnings, reopens with its answers intact and completes on the same instance");
}
