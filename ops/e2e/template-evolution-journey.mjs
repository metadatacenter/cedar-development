import assert from "node:assert/strict";
import {artifactBody, call, enc} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";
import {editorStatus} from "./metadata-journey-fixtures.mjs";

// An author removes a field while an existing metadata record is being edited
// in another tab. The supported Designer workflow must version the template,
// leaving that record and its unsaved answer on the original definition.
//
// The journey acts as the runner's first test user only. Its second tab is in the same browser
// context, and it never signs in as another account.
export async function templateEvolutionJourney({page, base, designer, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "template evolution");
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  async function read(collection, id) {
    const result = await call(user.auth, "GET", "/" + collection + "/" + enc(id));
    assert.equal(result.status, 200, result.text);
    return result.body;
  }
  const template = artifactBody("template", name + " evolving template");
  for (const key of ["Notes", "Keep"]) {
    template.properties[key] = artifactBody("field", key);
    template.properties["@context"].properties[key] = {enum: ["https://example.org/evolution/" + key]};
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template.required.push(key);
  }
  const templateId = await create("templates", template);
  const instance = artifactBody("instance", name + " existing record", {
    "schema:isBasedOn": templateId, Notes: {"@value": "Original answer"}, Keep: {"@value": "Keep this answer"},
  });
  for (const key of ["Notes", "Keep"]) instance["@context"][key] = "https://example.org/evolution/" + key;
  instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
  const instanceId = await create("template-instances", instance);
  const beforeTemplate = await read("templates", templateId);
  const beforeInstance = await read("template-instances", instanceId);
  const editor = await page.context().newPage();
  const errors = [];
  editor.on("pageerror", error => errors.push(error.message));
  editor.on("dialog", dialog => dialog.accept());
  try {
    await editor.goto(base + "/instances/edit/" + enc(instanceId));
    const cee = editor.locator("cedar-embeddable-editor");
    const notes = cee.getByLabel("Notes", {exact: true});
    await editorStatus(editor, /^Unmodified$/).waitFor();
    await notes.fill("Unsaved answer on the original schema");
    await editorStatus(editor, /^Modified$/).waitFor();
    await page.goto(designer + "/templates/edit/" + enc(templateId));
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    const field = page.locator("app-field-card").filter({has: page.getByRole("textbox", {name: "Field display name", exact: true})}).first();
    assert.equal(await field.getByRole("textbox", {name: "Field display name", exact: true}).inputValue(), "Notes");
    await field.getByRole("button", {name: "Delete field", exact: true}).click();
    await page.locator("#save").click();
    const dialog = page.locator("#version-dialog");
    await dialog.waitFor();
    assert.match(await page.locator("#version-message").innerText(), /1/);
    assert.match(await page.locator("#version-explanation").innerText(), /metadata.*(?:original|version)/i);
    await dialog.getByRole("button", {name: "Keep editing", exact: true}).click();
    // Keep editing closes the dialog and leaves the edit unsaved, with nothing on its way to the server.
    await dialog.waitFor({state: "hidden"});
    await page.locator("#state").filter({hasText: /^Modified$/}).waitFor();
    assert.deepEqual(await read("templates", templateId), beforeTemplate);
    assert.deepEqual(await read("template-instances", instanceId), beforeInstance);
    assert.equal(await notes.inputValue(), "Unsaved answer on the original schema");
    assert.equal(await page.locator("cedar-embeddable-designer").evaluate(el => "Notes" in el.currentArtifact.properties), false);
    pass("cancel-version", "Cancelling template version creation preserves the structural edit and the other tab's unsaved metadata without changing storage");
    await page.locator("#save").click();
    await dialog.waitFor();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/command/publish-create-draft-template/")),
      dialog.getByRole("button", {name: "Create new draft", exact: true}).click(),
    ]);
    assert.ok(response.ok(), await response.text());
    assert.ok(await response.request().headerValue("if-match"));
    const draftId = (await response.json())["@id"];
    assert.ok(draftId && draftId !== templateId);
    if (!created.some(item => item.id === draftId)) created.push({collection: "templates", id: draftId});
    await page.waitForURL(url => decodeURIComponent(url.pathname).endsWith(draftId.split("/").at(-1)));
    await page.locator("#state").filter({hasText: /^Unmodified$|^Saved$/}).waitFor();
    const original = await read("templates", templateId);
    const draft = await read("templates", draftId);
    assert.equal(original["bibo:status"], "bibo:published");
    assert.deepEqual(original.properties, beforeTemplate.properties);
    assert.deepEqual(original._ui, beforeTemplate._ui);
    assert.equal(draft["bibo:status"], "bibo:draft");
    assert.equal(draft["pav:previousVersion"], templateId);
    assert.equal("Notes" in draft.properties, false);
    assert.equal(draft._ui.order.includes("Notes"), false);
    assert.equal(await notes.inputValue(), "Unsaved answer on the original schema");
    await write(editor, "PUT", "/template-instances/", () => editor.locator("#button-save-metadata").click(), 200, true);
    await editor.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
    const saved = await read("template-instances", instanceId);
    assert.equal(saved["schema:isBasedOn"], templateId);
    assert.equal(saved.Notes["@value"], "Unsaved answer on the original schema");
    assert.deepEqual(saved.Keep, beforeInstance.Keep);
    await editor.reload();
    await editorStatus(editor, /^Unmodified$/).waitFor();
    await notes.waitFor();
    assert.equal(await notes.inputValue(), "Unsaved answer on the original schema");
    assert.equal(await cee.getByLabel("Keep", {exact: true}).inputValue(), "Keep this answer");
    pass("original-metadata", "Removing a used field creates a new template version while the open metadata record saves and reopens against its original schema");
    await editor.goto(base + "/instances/create/" + enc(draftId) + "?folderId=" + enc(folderId));
    const keep = cee.getByLabel("Keep", {exact: true});
    // Once the new version has loaded and its Keep field is shown, a Notes field would be shown too.
    await editorStatus(editor, /^Unmodified$/).waitFor();
    await keep.waitFor();
    assert.equal(await notes.count(), 0);
    await keep.fill("Answer on the new schema");
    await editor.locator("#instance-name").fill(name + " new version record");
    const made = await write(editor, "PUT", "/template-instances/", () => editor.locator("#button-save-metadata").click(), 201);
    assert.ok(made?.["@id"]);
    if (!created.some(item => item.id === made["@id"])) created.push({collection: "template-instances", id: made["@id"]});
    await editor.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
    const newRecord = await read("template-instances", made["@id"]);
    assert.equal(newRecord["schema:isBasedOn"], draftId);
    assert.equal("Notes" in newRecord, false);
    assert.equal(newRecord.Keep["@value"], "Answer on the new schema");
    assert.deepEqual(await read("template-instances", instanceId), saved);
    await editor.reload();
    await editorStatus(editor, /^Unmodified$/).waitFor();
    await keep.waitFor();
    assert.equal(await keep.inputValue(), "Answer on the new schema");
    assert.equal(await notes.count(), 0);
    assert.deepEqual(errors, []);
    pass("revised-metadata", "New metadata uses the revised template while the old record retains its original field and answer");
  } finally { await editor.close(); }
}
