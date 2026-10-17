import assert from "node:assert/strict";
import { call, enc, mutate, OPENVIEW, poll } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { diseaseTemplate } from "./metadata-journey-fixtures.mjs";
import { listed, menu, modal, pathId, row, save } from "./workspace-journey-fixtures.mjs";

// The journey follows one copy through Workspace. It is copied from a template with the fields the
// full smoke authors in Designer, moved into another folder through the folder picker, made public
// in OpenView by itself and through its folder, and finally deleted while Designer holds it open
// with an unsaved edit. An anonymous browser context, which signs nobody in, reads it while it is
// public.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function copyOpenViewJourney(args) {
  const { page, base, user, name, created, write, pass } = args;
  const folderId = await journeyFolder(args, "copy and openview");
  const names = { template: name + " copy source", copy: name + " copy", destination: name + " copy destination" };
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), diseaseTemplate(names.template));
  assert.equal(made.status, 201, made.text);
  created.push({ collection: "templates", id: made.body["@id"] });
  const moved = await call(user.auth, "POST", "/folders",
    { folderId, name: names.destination, description: "Isolated temporary journey fixtures" });
  assert.equal(moved.status, 201, moved.text);
  const destination = moved.body["@id"];
  created.push({ collection: "folders", id: destination });

  await listed(page, base, folderId, names.template);
  await menu(page, names.template, "Copy");
  await modal(page).getByLabel("Name of copy", { exact: true }).fill(names.copy);
  const copy = await save(page, write, "POST", "/command/copy-artifact-to-folder", 201);
  assert.ok(copy["@id"]);
  await listed(page, base, folderId, names.copy);
  await menu(page, names.copy, "Move");
  await modal(page).locator("cedar-folder-list").getByRole("button", { name: names.destination, exact: true }).click();
  await save(page, write, "POST", "/command/move-resource-to-folder", 201, true);
  await listed(page, base, destination, names.copy);
  pass("copy-move", "Copy and conditional move through folder picker");

  await listed(page, base, destination, names.copy);
  await menu(page, names.copy, "Enable Openview");
  await save(page, write, "POST", "/command/make-artifact-open", 200, true);
  // OpenView follows a change of openness after the command has answered, so read it until it agrees.
  const openViewStatus = async (open, what) => {
    const outcome = await poll(async () => {
      const r = await call(null, "GET", "/templates/" + enc(copy["@id"]), undefined, { base: OPENVIEW });
      return { done: open ? r.status === 200 : [401, 403, 404].includes(r.status), status: r.status };
    }, { tries: 20, delayMs: 500 });
    assert.ok(!outcome.timedOut, `${what}: OpenView still answers ${outcome.status} after ${outcome.attempts} reads`);
  };
  await openViewStatus(true, "OpenView did not become public");
  const publicContext = await page.context().browser().newContext({ ignoreHTTPSErrors: true });
  const errors = [];
  try {
    const publicPage = await publicContext.newPage();
    publicPage.on("pageerror", error => errors.push(error.message));
    await publicPage.goto(
      "https://openview." + new URL(base).hostname.split(".").slice(1).join(".") +
      "/templates/" + pathId(copy["@id"]),
    );
    await publicPage.locator("cedar-embeddable-editor").waitFor();
    await publicPage.waitForFunction(name => {
      const content = document.querySelector("cedar-embeddable-editor")?.shadowRoot?.textContent;
      return content?.includes(name) && content.includes("Notes");
    }, names.copy);
  } finally {
    await publicContext.close();
  }
  assert.deepEqual(errors, [], "uncaught browser errors on the public OpenView page");
  await menu(page, names.copy, "Disable Openview");
  await save(page, write, "POST", "/command/make-artifact-not-open", 200, true);
  await openViewStatus(false, "Closed artifact remains public");
  pass("artifact-openview", "OpenView open/render/close");

  await listed(page, base, folderId, names.destination);
  await menu(page, names.destination, "Enable Openview");
  await save(page, write, "POST", "/command/make-folder-open", 200, true);
  await openViewStatus(true, "An open folder did not make its child artifact public");
  await menu(page, names.destination, "Disable Openview");
  await save(page, write, "POST", "/command/make-folder-not-open", 200, true);
  await openViewStatus(false, "A closed folder left its child artifact public");
  pass("folder-openview", "Folder OpenView grant and revocation apply to its child artifact");

  await listed(page, base, destination, names.copy);
  await row(page, names.copy).getByRole("link", { name: names.copy, exact: true }).click();
  // An artifact just read from the server is unmodified, not saved.
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  assert.equal((await mutate(user.auth, "DELETE", "/templates/" + enc(copy["@id"]))).status, 204);
  await page.getByPlaceholder("Add description...", { exact: true }).first().fill("Unsaved after deletion");
  // CED checks template update impact before saving; deletion is caught there
  // before a conditional PUT can be sent.
  const deletedRead = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/command/check-update-template/" + pathId(copy["@id"]) &&
    response.status() === 404);
  await page.locator("#save").click();
  await deletedRead;
  await page.locator("#message").filter({ hasText: /404|not found/i }).waitFor();
  assert.equal(await page.getByPlaceholder("Add description...", { exact: true }).first().inputValue(), "Unsaved after deletion");
  assert.equal((await call(user.auth, "GET", "/templates/" + enc(copy["@id"]))).status, 404);
  pass("deleted-designer", "Delete versus CED save retains edits and cannot resurrect the artifact");
}
