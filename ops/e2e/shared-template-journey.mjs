import assert from "node:assert/strict";
import { call, mutate, enc } from "./rest/lib.mjs";
import { editorStatus, offeredTerm } from "./metadata-journey-fixtures.mjs";

// A shared template embeds its reused element snapshot. A recipient should be
// able to populate that template even without access to the private library source.
//
// The journey signs nobody in. It acts as the recipient on the page it is given, which the full
// smoke has signed in as its second test user and left on the recipient's Shared with Me listing.
export async function sharedTemplateJourney({page, user, sourceElementId, templateName, created, menu, write, pass}) {
  const privateSource = await call(user.auth, "GET", "/template-elements/" + enc(sourceElementId));
  assert.ok([403, 404].includes(privateSource.status), "the library source must remain private in this journey");
  let savedId;
  try {
    await menu(page, templateName, "Populate");
    const cee = page.locator("cedar-embeddable-editor");
    await editorStatus(page, /^Unmodified$/).waitFor();
    await cee.getByLabel("Notes", {exact: false}).first().fill("Metadata from a shared template");
    const disease = cee.getByLabel("Disease", {exact: false}).first();
    const influenza = await offeredTerm(page, disease, "influenza", /influenza/i,
      "the recipient could not use the template's terminology constraint");
    await influenza.click();
    const saved = await write(page, "PUT", "/template-instances/",
      () => page.locator("#button-save-metadata").click(), 201);
    savedId = saved["@id"];
    await page.waitForURL(/\/instances\/edit\//);
    await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
    const instancePath = "/template-instances/" + enc(saved["@id"]);
    const stored = await call(user.auth, "GET", instancePath);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.Notes["@value"], "Metadata from a shared template");
    assert.match(stored.body.Disease["@id"], /DOID_\d+$/);
    const editUrl = page.url();
    await page.getByRole("button", {name: "Back to Workspace", exact: true}).click();
    await page.locator("cedar-workspace-page .destinations").waitFor();
    await page.goto(editUrl);
    await editorStatus(page, /^Unmodified$/).waitFor();
    await cee.getByLabel("Notes", {exact: false}).first().waitFor();
    assert.equal(await cee.getByLabel("Notes", {exact: false}).first().inputValue(), "Metadata from a shared template");
    assert.match(await disease.inputValue(), /influenza/i);
    await page.getByRole("button", {name: "Back to Workspace", exact: true}).click();
    await page.locator("cedar-workspace-page .destinations").waitFor();
    pass("A viewer populates and reopens a shared template with a private library source and a live terminology constraint");
  } finally {
    // The instance belongs to the recipient. The main journey's owner cannot clean it up, and must
    // not need access to the recipient's records. Only the instance this journey saved is removed:
    // deleting whatever else was created meanwhile would reach records other work still uses.
    if (savedId) {
      const removed = await mutate(user.auth, "DELETE", "/template-instances/" + enc(savedId));
      assert.ok([200, 204, 404].includes(removed.status), `recipient fixture cleanup: ${removed.status}`);
      const entry = created.findIndex(item => item.id === savedId);
      if (entry >= 0) created.splice(entry, 1);
    }
  }
}
