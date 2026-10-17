import assert from "node:assert/strict";
import { call, enc } from "./rest/lib.mjs";
import { diseaseRecord } from "./metadata-journey-fixtures.mjs";
import { enterVersion, listed, menu, save, showInformation } from "./workspace-journey-fixtures.mjs";

// The journey publishes a template and drafts its next version through Workspace's row actions. A
// record made before publication stays based on the template it was made from, and the template's
// Version tab shows the published version and its draft from either row. The template has the
// fields the full smoke authors in Designer, its DOID constraint included.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function publicationJourney(args) {
  const { page, base, user, name, write, pass } = args;
  const templateName = name + " published template";
  const record = await diseaseRecord(args, "publication", { template: templateName, instance: name + " published metadata" });
  await listed(page, base, record.folderId, templateName);
  await menu(page, templateName, "Publish");
  await enterVersion(page, "1.0.0");
  await save(page, write, "POST", "/command/publish-artifact", [200, 201]);
  await listed(page, base, record.folderId, templateName);
  await menu(page, templateName, "Create Draft");
  await enterVersion(page, "1.1.0");
  const draft = await save(page, write, "POST", "/command/create-draft-artifact", 201);
  assert.ok(draft["@id"]);
  assert.notEqual(draft["@id"], record.templateId);
  assert.equal((await call(user.auth, "GET", "/template-instances/" + enc(record.id))).body["schema:isBasedOn"],
    record.templateId);
  pass("Publish/new draft preserves metadata template identity");
  await listed(page, base, record.folderId, templateName);
  await showInformation(page, templateName);
  await page.getByRole("tab", { name: "Version", exact: true }).click();
  // The tab describes the selected version and names the other one: the draft
  // as the latest version, or the published template as a previous one.
  const panel = page.getByRole("tabpanel");
  const versionCell = panel.locator("dd").nth(1);
  await versionCell.waitFor();
  const shown = (await versionCell.textContent()).trim();
  assert.ok(["1.0.0", "1.1.0"].includes(shown), `Version tab shows ${shown}`);
  await panel
    .locator(shown === "1.0.0" ? ".latest-version" : ".previous-versions")
    .filter({ hasText: shown === "1.0.0" ? "· 1.1.0 · Draft" : "· 1.0.0 · Published" })
    .waitFor();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  pass("Details and Version panels show the published/draft chain");
}
