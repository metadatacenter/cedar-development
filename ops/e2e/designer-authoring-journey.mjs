import assert from "node:assert/strict";
import { call, enc, mutate } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { diseaseRecord, diseaseTemplate, editorStatus } from "./metadata-journey-fixtures.mjs";
import {
  assertOnlyContentChanges, backToWorkspace, editor, editorSave, listed, listing, menu, modal, pathId,
  searchUntilListed,
} from "./workspace-journey-fixtures.mjs";

// The first journey authors an element and a field in Designer from Workspace's New menu, and
// reopens and edits each there. Workspace's top search then finds the element, and Workspace deletes
// both and a metadata record, which a second tab still holds open in the metadata editor. The full
// smoke authors its template the same way, and keeps it, because the rest of its chain populates
// that template.
//
// Both journeys act as the runner's first test user only and never sign in as another account.
export async function designerAuthoringJourney(args) {
  const { page, base, designer, user, name, write, pass } = args;
  const folderId = await journeyFolder(args, "designer authoring");
  const stamp = Date.now();
  const names = { element: name + " authored element", field: name + " authored field" };
  const artifacts = {};
  for (const [kind, label, collection] of [
    ["element", "Element", "template-elements"],
    ["field", "Field", "template-fields"],
  ]) {
    await listing(page, base, folderId);
    const returnUrl = page.url();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL(u => u.origin === new URL(designer).origin);
    assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
    if (kind === "field")
      await page.getByRole("button", { name: "Number", exact: true }).click();
    await page.getByRole("textbox", {
      name: kind === "field" ? "Field display name" : "Element name",
      exact: true,
    }).fill(names[kind]);
    artifacts[kind] = (await editorSave(page, write, "PUT", collection, 201))["@id"];
    // The new artifact stays open at its edit address, which keeps Workspace's address.
    assert.equal(new URL(page.url()).pathname, `/${kind}s/edit/${pathId(artifacts[kind])}`);
    assert.equal(new URL(page.url()).searchParams.get("returnTo"), returnUrl);
    await backToWorkspace(page);
    assert.equal(page.url(), returnUrl);
    const contentPath = "/" + collection + "/" + enc(artifacts[kind]);
    const sourceContent = (await call(user.auth, "GET", contentPath)).body;
    // Seed supported metadata outside the description control being exercised.
    const annotated = await mutate(user.auth, "PUT", contentPath, {...sourceContent,
      "schema:identifier": `journey-${kind}-${stamp}`,
      "_annotations": {"https://example.org/journey-note": {"@value": "Keep this annotation"}},
    });
    assert.equal(annotated.status, 200, annotated.text);
    const beforeDescriptionEdit = (await call(user.auth, "GET", contentPath)).body;
    await editor(page, base, folderId, names[kind]);
    if (kind === "field") {
      // Settings open expanded; expand them only if a later default collapses them again.
      const expand = page.getByRole("button", { name: "Expand field settings", exact: true });
      if (await expand.isVisible().catch(() => false)) await expand.click();
      // A field's own description, which CEE shows as its help, is on the Presentation tab.
      await page.getByRole("tab", { name: "Presentation", exact: true }).click();
    }
    await page
      .getByPlaceholder(kind === "field" ? "Field description" : "Add description...", { exact: true })
      .fill("Updated by journey");
    await editorSave(page, write, "PUT", collection);
    const afterDescriptionEdit = (await call(user.auth, "GET", contentPath)).body;
    assertOnlyContentChanges(beforeDescriptionEdit, afterDescriptionEdit, {"schema:description": "Updated by journey"});
    await backToWorkspace(page);
    pass(`author-${kind}`, `${label}: CED/CEFD create, reopen, conditional update, each staying in Designer, exact return`);
    pass(`preserve-${kind}`, `${label}: a description edit preserves the rest of the stored artifact`);
  }

  await listing(page, base, folderId);
  const found = await searchUntilListed(page, names.element);
  assert.ok(!found.timedOut, `the authored element never appeared in ${found.attempts} top searches`);
  pass("search-element", "Top search finds authored element");

  // The record deleted first answers both fields of the template the full smoke authors.
  names.instance = name + " authored metadata";
  const record = await diseaseRecord(args, "authored deletion",
    { template: name + " authored deletion template", instance: names.instance });
  const folders = { instance: record.folderId, field: folderId, element: folderId };
  const errors = [];
  for (const [kind, collection] of [
    ["instance", "template-instances"],
    ["field", "template-fields"],
    ["element", "template-elements"],
  ]) {
    await listed(page, base, folders[kind], names[kind]);
    let deletedEditor;
    if (kind === "instance") {
      deletedEditor = await page.context().newPage();
      deletedEditor.on("pageerror", error => errors.push(error.message));
      await deletedEditor.goto(record.url);
      await editorStatus(deletedEditor, /^Unmodified$/).waitFor();
      await deletedEditor.locator("cedar-embeddable-editor").getByLabel("Notes", { exact: false }).first().waitFor();
    }
    try {
      await menu(page, names[kind], "Delete");
      await write(page, "DELETE", "/" + collection,
        () => modal(page).getByRole("button", { name: "Yes, delete it!", exact: true }).click(), 204, true);
      await modal(page).waitFor({ state: "hidden" });
      if (deletedEditor) {
        const notes = deletedEditor.locator("cedar-embeddable-editor").getByLabel("Notes", { exact: false }).first();
        await notes.fill("Edits after metadata deletion");
        await write(deletedEditor, "PUT", "/template-instances/",
          () => deletedEditor.locator("#button-save-metadata").click(), 412, true);
        await deletedEditor.getByRole("alert").filter({ hasText: "was deleted" }).waitFor();
        assert.equal(await notes.inputValue(), "Edits after metadata deletion");
        assert.equal((await call(user.auth, "GET", record.path)).status, 404);
        pass("deleted-metadata", "CEE save after deletion retains edits and cannot recreate metadata");
      }
    } finally {
      await deletedEditor?.close();
    }
  }
  assert.deepEqual(errors, [], "uncaught browser errors in the deleted record's tab");
  pass("delete-artifacts", "Conditional deletion through Workspace");
}

// Designer refuses a save that a concurrent change has made stale, and keeps the edit. The template
// has the fields the full smoke authors in Designer.
export async function designerConflictJourney(args) {
  const { page, base, user, name, created, write, pass } = args;
  const folderId = await journeyFolder(args, "designer conflict");
  const templateName = name + " conflicting template";
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), diseaseTemplate(templateName));
  assert.equal(made.status, 201, made.text);
  created.push({ collection: "templates", id: made.body["@id"] });
  await editor(page, base, folderId, templateName);
  const templatePath = "/templates/" + enc(made.body["@id"]);
  const stored = await call(user.auth, "GET", templatePath);
  assert.equal((await mutate(user.auth, "PUT", templatePath, {
    ...stored.body,
    "schema:description": "Concurrent CED edit",
  })).status, 200);
  await page.getByPlaceholder("Add description...", { exact: true }).first().fill("Unsaved CED edit");
  await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 412, true);
  // Save is disabled while it is in flight too, so wait until Designer has handled the refusal.
  await page.locator("#state").filter({ hasText: /^Reload required$/ }).waitFor();
  assert.equal(await page.getByPlaceholder("Add description...", { exact: true }).first().inputValue(), "Unsaved CED edit");
  pass("stale-designer", "CED stale save retains edits");
}
