import assert from "node:assert/strict";
import { call, mutate, enc } from "./rest/lib.mjs";

// A shared template embeds its reused element snapshot. A recipient should be
// able to populate that template even without access to the private library source.
export async function sharedTemplateJourney({page, user, sourceElementId, templateName, created, menu, write, pass}) {
  const privateSource = await call(user.auth, "GET", "/template-elements/" + enc(sourceElementId));
  assert.ok([403, 404].includes(privateSource.status), "the library source must remain private in this journey");
  const existing = new Set(created.map(item => item.id));
  try {
    await menu(page, templateName, "Populate");
    const cee = page.locator("cedar-embeddable-editor");
    await cee.getByLabel("Notes", {exact: false}).first().fill("Metadata from a shared template");
    const disease = cee.getByLabel("Disease", {exact: false}).first();
    const influenza = page.getByRole("option", {name: /influenza/i}).first();
    for (let attempt = 0; ; attempt++) {
      await disease.fill("");
      await disease.pressSequentially("influenza", {delay: 40});
      if (await influenza.waitFor({timeout: 15000}).then(() => true, () => false)) break;
      assert.ok(attempt < 2, "the recipient could not use the template's terminology constraint");
    }
    await influenza.click();
    const saved = await write(page, "POST", "/template-instances",
      () => page.locator("#button-save-metadata").click(), 201);
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
    await cee.getByLabel("Notes", {exact: false}).first().waitFor();
    assert.equal(await cee.getByLabel("Notes", {exact: false}).first().inputValue(), "Metadata from a shared template");
    assert.match(await disease.inputValue(), /influenza/i);
    await page.getByRole("button", {name: "Back to Workspace", exact: true}).click();
    await page.locator("cedar-workspace-page .destinations").waitFor();
    pass("A viewer populates and reopens a shared template with a private library source and a live terminology constraint");
  } finally {
    // These instances belong to the recipient. The main journey's owner cannot
    // clean them up, and must not need access to the recipient's new records.
    for (const item of [...created].reverse()) {
      if (existing.has(item.id) || item.collection !== "template-instances") continue;
      const removed = await mutate(user.auth, "DELETE", "/template-instances/" + enc(item.id));
      assert.ok([200, 204, 404].includes(removed.status), `recipient fixture cleanup: ${removed.status}`);
      created.splice(created.indexOf(item), 1);
    }
  }
}
