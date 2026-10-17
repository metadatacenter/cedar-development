import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder, rendered } from "./journey-fixtures.mjs";
import { listing, modal, pathId } from "./workspace-journey-fixtures.mjs";

// These journeys delete a selection of several rows at once in Workspace, by dropping it on the
// Delete control or pressing that control, and after a reply is lost part way through. Each journey
// makes its rows by REST in a folder of its own.
//
// Both journeys act as the runner's first test user only and never sign in as another account.

/** Returns a function that makes a folder or an artifact by REST and records it for cleanup and in `made`. */
function maker({ user, created }, made) {
  return async (collection, parent, name, type, extra = {}) => {
    const response = await call(user.auth, "POST", "/" + collection +
      (type ? "?folder_id=" + enc(parent) : ""),
      type ? artifactBody(type, name, extra) : {folderId: parent, name, description: "Selection deletion smoke fixture"});
    assert.equal(response.status, 201, response.text);
    const item = {collection, id: response.body["@id"]};
    created.push(item); made.push(item);
    return item.id;
  };
}

export async function selectionDeleteJourney(args) {
  const { page, base, user, name, pass } = args;
  const parentId = await journeyFolder(args, "selection deletion");
  const bulkCreated = [];
  const bulkCreate = maker(args, bulkCreated);
  const bulkRoot = await bulkCreate("folders", parentId, `${name} selection deletion root`);
  const bulkFolder = await bulkCreate("folders", bulkRoot, `${name} selected folder`);
  const bulkEmpty = await bulkCreate("folders", bulkRoot, `${name} selected empty folder`);
  const bulkNested = await bulkCreate("folders", bulkFolder, `${name} nested folder`);
  const bulkTemplate = await bulkCreate("templates", bulkFolder, `${name} nested template`, "template");
  await bulkCreate("template-instances", bulkNested, `${name} nested instance`, "instance", {"schema:isBasedOn":bulkTemplate});
  const bulkField = await bulkCreate("template-fields", bulkRoot, `${name} selected field`, "field");
  await listing(page, base, bulkRoot);
  for (const [index, id] of [bulkFolder, bulkEmpty, bulkField].entries()) {
    await page.locator(`[data-resource-id="${id}"] .resource-icon`).click({modifiers:index ? ["ControlOrMeta"] : []});
  }
  const bulkAction = page.getByRole("button", {name:"Delete (3)",exact:true});
  const bulkSource = await page.locator(`[data-resource-id="${bulkFolder}"] .resource-icon`).boundingBox();
  const bulkBin = await bulkAction.boundingBox();
  await page.mouse.move(bulkSource.x + bulkSource.width / 2, bulkSource.y + bulkSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(bulkSource.x + bulkSource.width / 2 + 10, bulkSource.y + bulkSource.height / 2 + 10, {steps:3});
  await page.mouse.move(bulkBin.x + bulkBin.width / 2, bulkBin.y + bulkBin.height / 2, {steps:12});
  await page.locator('.selection-delete.explorer-delete-target').waitFor();
  await page.mouse.up();
  await modal(page).getByText("Total items to delete: 6.", {exact:false}).waitFor();
  await modal(page).getByRole("button", {name:"Cancel",exact:true}).click();
  for (const item of bulkCreated) assert.equal((await call(user.auth,"GET","/"+item.collection+"/"+enc(item.id))).status,200);
  await bulkAction.click();
  await modal(page).getByText("Total items to delete: 6.", {exact:false}).waitFor();
  await modal(page).getByRole("button",{name:"Delete selected items and contents",exact:true}).click();
  await modal(page).waitFor({state:"hidden"});
  for (const item of bulkCreated.filter(item=>item.id!==bulkRoot)) {
    assert.equal((await call(user.auth,"GET","/"+item.collection+"/"+enc(item.id))).status,404);
  }
  pass("mixed-selection", "Bin drop cancels safely; clicking Delete then removes two folders, nested template/instance and a separate artifact");
}

export async function partialSelectionDeleteJourney(args) {
  const { page, base, user, name, write, pass } = args;
  const bulkRoot = await journeyFolder(args, "partial selection deletion");
  const bulkCreate = maker(args, []);
  const partialIds = [];
  for (let i = 0; i < 3; i++) partialIds.push(await bulkCreate("template-fields", bulkRoot,
    `${name} partial deletion ${i}`, "field"));
  await listing(page, base, bulkRoot);
  for (const [index, id] of partialIds.entries()) {
    await page.locator(`[data-resource-id="${id}"] .resource-icon`).click({modifiers: index ? ["ControlOrMeta"] : []});
  }
  const attemptedDeletes = [];
  const deleteMatcher = url => url.pathname.startsWith("/template-fields/");
  const loseSecondDelete = async intercepted => {
    const req = intercepted.request();
    if (req.method() !== "DELETE") return intercepted.fallback();
    attemptedDeletes.push(pathId(new URL(req.url()).pathname));
    assert.ok(req.headers()["if-match"]);
    const response = await intercepted.fetch();
    assert.ok(response.ok());
    if (attemptedDeletes.length === 2) return intercepted.abort("failed");
    await intercepted.fulfill({response});
  };
  await page.route(deleteMatcher, loseSecondDelete);
  try {
    await page.getByRole("button", {name: "Delete (3)", exact: true}).click();
    await modal(page).getByRole("button", {name: "Delete", exact: true}).click();
    await modal(page).getByRole("alert").filter({hasText: "Some items may already have been deleted"}).waitFor();
    await modal(page).getByText("Confirmed deletions so far", {exact: true}).waitFor();
    await modal(page).getByText("1", {exact: true}).waitFor();
    assert.equal(await modal(page).getByRole("button", {name: "Delete", exact: true}).isDisabled(), true);
    assert.equal(attemptedDeletes.length, 2);
    for (const id of partialIds) {
      assert.equal((await call(user.auth, "GET", "/template-fields/" + enc(id))).status,
        attemptedDeletes.includes(pathId(id)) ? 404 : 200);
    }
    await modal(page).getByRole("button", {name: "Delete", exact: true}).dispatchEvent("click");
    // A deletion the dialog started would show its progress once rendered, and a refused one changes nothing.
    await rendered(page);
    assert.equal(await modal(page).getByRole("status").count(), 0, "the refused Delete started a deletion");
    assert.equal(attemptedDeletes.length, 2);
  } finally {
    await page.unroute(deleteMatcher, loseSecondDelete);
  }
  await modal(page).getByRole("button", {name: "Cancel", exact: true}).click();
  await listing(page, base, bulkRoot);
  const remainingId = partialIds.find(id => !attemptedDeletes.includes(pathId(id)));
  await page.locator(`[data-resource-id="${remainingId}"] .resource-icon`).click();
  await page.getByRole("button", {name: "Delete (1)", exact: true}).click();
  await write(page, "DELETE", "/template-fields/",
    () => modal(page).getByRole("button", {name: "Delete", exact: true}).click(), [200, 204], true);
  await modal(page).waitFor({state: "hidden"});
  for (const id of partialIds) assert.equal((await call(user.auth, "GET", "/template-fields/" + enc(id))).status, 404);
  pass("partial-selection", "Partial deletion stops after a lost response, reports only confirmed progress and resumes from a fresh selection");
}
