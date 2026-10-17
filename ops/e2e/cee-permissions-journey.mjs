import assert from "node:assert/strict";
import { call } from "./rest/lib.mjs";
import { diseaseRecord, editorStatus } from "./metadata-journey-fixtures.mjs";
import { listed, menu, removePermission, setPermission, signInSecondUser } from "./workspace-journey-fixtures.mjs";

// The metadata editor's host reads a second person's permission on a record before it configures
// the editor, and keeps their draft when they lose that permission while the record is open. The owner
// changes the permission on the runner's page; the second person works in a browser context of their
// own. The template has the fields the full smoke authors in Designer.
//
// The journey signs the second test user in to a browser context of their own, so it belongs in the
// identity lane.
export async function ceePermissionsJourney(args) {
  const { page, base, user, name, write, pass } = args;
  const templateName = name + " shared metadata template", instanceName = name + " shared metadata";
  const record = await diseaseRecord(args, "metadata permissions", { template: templateName, instance: instanceName });
  const instancePath = record.path, metadataUrl = record.url;
  // The record's template is shared to view, so only the record's own permission varies.
  await listed(page, base, record.folderId, templateName);
  await menu(page, templateName, "Permissions…");
  await setPermission(page, write, "/templates/", "viewer");
  const { context, page: reader, errors } = await signInSecondUser(page, base);
  try {
    await listed(page, base, record.folderId, instanceName);
    await menu(page, instanceName, "Permissions…");
    await setPermission(page, write, "/template-instances/", "viewer");
    await reader.goto(metadataUrl);
    await reader.locator(".metadata-toolbar [role=status]").filter({ hasText: "Read only" }).waitFor();
    assert.equal(await reader.evaluate(() => typeof window.angular), "undefined");
    assert.equal(await reader.locator("#button-save-metadata").count(), 0);
    assert.equal(await reader.locator("#instance-name").getAttribute("readonly"), "");
    await menu(page, instanceName, "Permissions…");
    await removePermission(page, write, "/template-instances/");
    pass("CEE host settles viewer permissions before configuring its read-only editor");

    await menu(page, instanceName, "Permissions…");
    await setPermission(page, write, "/template-instances/", "editor");
    await reader.goto(metadataUrl);
    const readerNotes = reader.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: false}).first();
    await editorStatus(reader, /^Unmodified$/).waitFor();
    await readerNotes.fill("Metadata draft after access loss");
    const beforeEditorRevocation = await call(user.auth, "GET", instancePath);
    await menu(page, instanceName, "Permissions…");
    await setPermission(page, write, "/template-instances/", "viewer");
    await write(reader, "PUT", "/template-instances/",
      () => reader.locator("#button-save-metadata").click(), 403, true);
    await reader.waitForFunction(() => document.getElementById("button-save-metadata").disabled);
    assert.equal(await readerNotes.inputValue(), "Metadata draft after access loss");
    assert.deepEqual((await call(user.auth, "GET", instancePath)).body, beforeEditorRevocation.body);
    await reader.getByRole("button", {name: "Reload metadata", exact: true}).click();
    const reloadQuestion = reader.locator("dialog.confirmation-dialog");
    await reloadQuestion.getByRole("button", {name: "Cancel", exact: true}).click();
    await reloadQuestion.waitFor({state: "hidden"});
    assert.equal(await readerNotes.inputValue(), "Metadata draft after access loss");
    await menu(page, instanceName, "Permissions…");
    await removePermission(page, write, "/template-instances/");
    assert.deepEqual(errors, [], "uncaught browser errors on the reader's page");
  } finally {
    await context.close();
  }
  pass("CEE loses edit permission while open: save refused, draft retained, server content unchanged");
}
