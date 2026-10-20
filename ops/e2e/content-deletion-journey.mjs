import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { editorStatus } from "./metadata-journey-fixtures.mjs";

const propertyIri = key => "https://example.org/deletion-journey/" + key;
function addChild(parent, key, child, repeat = false) {
  parent.properties[key] = repeat ? {type: "array", minItems: 0, items: child} : child;
  parent.properties["@context"].properties[key] = {enum: [propertyIri(key)]};
  parent._ui.order.push(key);
  parent._ui.propertyLabels[key] = key;
  parent._ui.propertyDescriptions[key] = "Preserve " + key;
  parent.required.push(key);
}
function definition(name) {
  const template = artifactBody("template", name);
  const visits = artifactBody("element", "Visits");
  addChild(visits, "Detail", artifactBody("field", "Detail"));
  addChild(template, "Notes", artifactBody("field", "Notes"), true);
  addChild(template, "Visits", visits, true);
  addChild(template, "Keep", artifactBody("field", "Keep"));
  return template;
}
function withoutChildren(artifact, keys) {
  const expected = structuredClone(artifact);
  for (const key of keys) {
    delete expected.properties[key];
    delete expected.properties["@context"].properties[key];
    if (expected.properties["@context"].required)
      expected.properties["@context"].required = expected.properties["@context"].required.filter(item => item !== key);
    expected.required = expected.required.filter(item => item !== key);
    expected._ui.order = expected._ui.order.filter(item => item !== key);
    delete expected._ui.propertyLabels[key];
    delete expected._ui.propertyDescriptions[key];
  }
  return expected;
}
function content(artifact) {
  const copy = structuredClone(artifact);
  delete copy["pav:lastUpdatedOn"];
  delete copy["oslc:modifiedBy"];
  return copy;
}

// These surfaces have no deletion Undo action. Exercise their actual recovery
// contract: cancel where offered, or deliberately discard unsaved deletions.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function contentDeletionJourney({page, base, designer, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "content deletion");
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  async function read(path) {
    const result = await call(user.auth, "GET", path);
    assert.equal(result.status, 200, result.text);
    return result.body;
  }
  async function discardRetainedDeletion(designing) {
    const discard = designing ? page.locator("#discard-draft")
      : page.getByRole("button", {name: "Discard recovery draft", exact: true});
    await discard.click();
    if (!designing) await page.locator("dialog.confirmation-dialog")
      .getByRole("button", {name: "Yes", exact: true}).click();
    await discard.waitFor({state: "hidden"});
  }
  const templateId = await create("templates", definition(name + " designer deletion"));
  const templatePath = "/templates/" + enc(templateId);
  await page.goto(designer + "/templates/edit/" + enc(templateId));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  const ced = page.locator("cedar-embeddable-designer");
  const original = await ced.evaluate(el => el.currentArtifact);
  const storedOriginal = await read(templatePath);
  const deleteElement = page.getByRole("button", {name: "Delete element Visits", exact: true});
  const dialog = page.getByRole("dialog", {name: "Delete element?", exact: true});
  await deleteElement.click();
  await dialog.getByRole("button", {name: "Cancel", exact: true}).click();
  await dialog.waitFor({state: "hidden"});
  assert.deepEqual(await ced.evaluate(el => el.currentArtifact), original);
  // The field's deletion is the first edit, so the state reads Modified once it has happened. The
  // element's has happened once its card, and the card's delete control with it, has gone.
  async function deleteChildren() {
    const field = page.locator("app-field-card").first();
    assert.equal(await field.getByRole("textbox", {name: "Enter field name", exact: true}).inputValue(), "Notes");
    await field.getByRole("button", {name: "Delete field", exact: true}).click();
    await page.locator("#state").filter({hasText: /^Modified$/}).waitFor();
    await deleteElement.click();
    await dialog.getByRole("button", {name: "Delete", exact: true}).click();
    await dialog.waitFor({state: "hidden"});
    await deleteElement.waitFor({state: "detached"});
  }
  await deleteChildren();
  assert.deepEqual(await ced.evaluate(el => el.currentArtifact), withoutChildren(original, ["Notes", "Visits"]));
  assert.deepEqual(await read(templatePath), storedOriginal, "unsaved deletion must not change storage");
  await page.reload(); // Reload retains work; this scenario explicitly discards its deletion draft.
  await discardRetainedDeletion(true);
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  assert.deepEqual(await ced.evaluate(el => el.currentArtifact), original,
    "discarding unsaved deletions restores the saved definitions, order and identities");
  pass("designer-cancel", "Designer cancels populated-element deletion and restores unsaved field/element deletions by reopening and explicitly discarding the recovery draft");
  await deleteChildren();
  await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
  await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
  assert.deepEqual(content(await read(templatePath)), content(withoutChildren(storedOriginal, ["Notes", "Visits"])));
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  assert.deepEqual(content(await ced.evaluate(el => el.currentArtifact)), content(withoutChildren(original, ["Notes", "Visits"])),
    "saved deletion removes only the selected definitions and their parent references");
  pass("designer-save", "Designer saves and reopens field/element deletion without changing the surviving field or leaving stale parent references");

  const editorTemplateId = await create("templates", definition(name + " editor deletion"));
  const instance = artifactBody("instance", name + " deletion values", {
    "schema:isBasedOn": editorTemplateId,
    Notes: ["first", "middle", "last"].map(value => ({"@value": value})),
    Keep: {"@value": "Unrelated value"},
    Visits: ["first visit", "middle visit", "last visit"].map(value => ({
      "@id": null, "@context": {Detail: propertyIri("Detail")}, Detail: {"@value": value},
    })),
  });
  // Match the provenance term declared by the template and current Editor writer.
  instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
  for (const key of ["Notes", "Visits", "Keep"]) instance["@context"][key] = propertyIri(key);
  const instanceId = await create("template-instances", instance);
  const instancePath = "/template-instances/" + enc(instanceId);
  const stored = await read(instancePath);
  assert.equal(new Set(stored.Visits.map(visit => visit["@id"])).size, 3);
  assert.ok(stored.Visits.every(visit => typeof visit["@id"] === "string" && visit["@id"]));
  await page.goto(base + "/instances/edit/" + enc(instanceId));
  const cee = page.locator("cedar-embeddable-editor");
  // The editor has rendered the stored record once the page reports it loaded.
  async function opened() {
    await editorStatus(page, /^Unmodified$/).waitFor();
    await cee.getByLabel("Keep", {exact: true}).waitFor();
  }
  await opened();
  const initial = await cee.evaluate(el => el.currentMetadata);
  // There are two pagers: the repeated field and the repeated element. Detail
  // is scalar, so it cannot accidentally satisfy a pager action.
  const pagers = cee.locator("app-cedar-multi-pager");
  await pagers.nth(1).waitFor();
  assert.equal(await pagers.count(), 2);
  // A pager marks the occurrence it shows, and numbers one option per occurrence.
  async function deleteMiddle() {
    for (const pager of [pagers.nth(0), pagers.nth(1)]) {
      await pager.getByRole("option", {name: "2", exact: true}).click();
      await pager.getByRole("option", {name: "2", exact: true, selected: true}).waitFor();
      await pager.getByRole("button", {name: "Delete current", exact: true}).click();
      await pager.getByRole("option", {name: "3", exact: true}).waitFor({state: "detached"});
    }
    await editorStatus(page, /^Modified$/).waitFor();
  }
  const reduced = {...initial, Notes: [initial.Notes[0], initial.Notes[2]], Visits: [initial.Visits[0], initial.Visits[2]]};
  await deleteMiddle();
  assert.deepEqual(await cee.evaluate(el => el.currentMetadata), reduced);
  assert.deepEqual(await read(instancePath), stored);
  await page.reload();
  await cee.getByLabel("Keep", {exact: true}).waitFor();
  await discardRetainedDeletion(false);
  await opened();
  assert.deepEqual(await cee.evaluate(el => el.currentMetadata), initial);
  pass("editor-discard", "Editor restores unsaved repeated-field and element deletions by explicitly discarding the recovery draft after reopening, including original values, order and element identities");
  await deleteMiddle();
  await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  const reducedStored = {...stored, Notes: [stored.Notes[0], stored.Notes[2]], Visits: [stored.Visits[0], stored.Visits[2]]};
  assert.deepEqual(content(await read(instancePath)), content(reducedStored));
  await page.reload();
  await opened();
  const reopened = await cee.evaluate(el => el.currentMetadata);
  assert.deepEqual(reopened.Notes, reduced.Notes);
  assert.deepEqual(reopened.Visits, reduced.Visits);
  assert.deepEqual(reopened.Keep, initial.Keep);
  pass("editor-middle-occurrence", "Editor saves and reopens middle-occurrence deletion while preserving surviving values, order, element identities and unrelated content");
  for (const pager of [pagers.nth(0), pagers.nth(1)]) {
    const remove = pager.getByRole("button", {name: "Delete current", exact: true});
    await remove.click();
    await remove.click();
    // An emptied pager says so in place of its occurrence numbers.
    await pager.getByRole("option", {name: "No instances yet", exact: true}).waitFor();
    assert.equal(await remove.isDisabled(), true);
  }
  const emptied = await cee.evaluate(el => el.currentMetadata);
  assert.deepEqual(emptied.Notes, []);
  assert.deepEqual(emptied.Visits, []);
  assert.deepEqual(emptied.Keep, initial.Keep);
  await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  assert.deepEqual(content(await read(instancePath)), content({...stored, Notes: [], Visits: []}));
  await page.reload();
  await opened();
  const emptyReopened = await cee.evaluate(el => el.currentMetadata);
  assert.deepEqual(emptyReopened.Notes, []);
  assert.deepEqual(emptyReopened.Visits, []);
  pass("editor-empty-lists", "Editor deletes the remaining optional occurrences, disables further deletion and reopens the saved empty lists");
}
