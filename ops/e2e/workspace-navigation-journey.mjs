import assert from "node:assert/strict";
import { artifactBody, call, enc } from "./rest/lib.mjs";
import { journeyFolder, listingIdle, listingOf, focused, rendered } from "./journey-fixtures.mjs";
import { listing, row, modal, menu, save, editorSave, searchUntilListed, assertOnlyContentChanges } from "./workspace-journey-fixtures.mjs";

const items = page => page.locator(".explorer-item");
const item = (page, id) => page.locator(`[data-resource-id="${id}"]`);
const ids = page => items(page).evaluateAll(nodes => nodes.map(node => node.dataset.resourceId));
async function selected(page) {
  // Angular renders keyboard selection on the next frame, after focus has already moved.
  await rendered(page);
  return page.locator('.explorer-item[aria-selected="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.resourceId));
}
async function make(args, parent, suffix, kind = "template") {
  const title = args.name + " " + suffix;
  const collection = { folder: "folders", template: "templates", field: "template-fields", element: "template-elements" }[kind];
  const made = await call(args.user.auth, "POST", "/" + collection + (kind === "folder" ? "" : "?folder_id=" + enc(parent)),
    kind === "folder" ? { folderId: parent, name: title, description: "Workspace navigation fixture" } : artifactBody(kind, title));
  assert.equal(made.status, 201, made.text);
  const id = made.body["@id"];
  args.created.push({ collection, id });
  return { id, title, collection, read: async () => {
    const result = await call(args.user.auth, "GET", "/" + collection + "/" + enc(id));
    assert.equal(result.status, 200, result.text);
    return result.body;
  } };
}
async function change(page, parent, gesture) {
  await Promise.all([page.waitForResponse(listingOf(parent)), gesture()]);
  await listingIdle(page);
}
async function sort(page, parent, choice) {
  await page.getByRole("button", { name: "Sort options", exact: true }).click();
  await change(page, parent, () => page.getByRole("menu", { name: "Sort options" }).getByRole("menuitemradio", { name: choice, exact: true }).click());
}
async function returned(page) {
  await page.getByRole("button", { name: "New", exact: true }).waitFor();
  await listingIdle(page);
}

// Each journey creates an isolated tree and uses only the runner's first account.
export async function workspaceKeyboardFoldersJourney(args) {
  const { page, base, pass } = args;
  const root = await journeyFolder(args, "keyboard folder traversal");
  const a = await make(args, root, "Alpha folder", "folder"), b = await make(args, root, "Beta folder", "folder");
  const child = await make(args, b.id, "Nested folder", "folder");
  const leaf = await make(args, child.id, "Leaf template");
  await listing(page, base, root);
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await item(page, a.id).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await focused(item(page, b.id), "End focuses the last grid card");
  assert.deepEqual(await selected(page), [b.id]);
  await change(page, b.id, () => page.keyboard.press("Enter"));
  await item(page, child.id).focus();
  await change(page, child.id, () => page.keyboard.press("Enter"));
  assert.deepEqual(await ids(page), [leaf.id]);
  assert.equal(await page.getByRole("button", { name: "Grid view", exact: true }).getAttribute("aria-pressed"), "true");
  await change(page, root, () => page.locator(`.breadcrumbs [data-drop-id="${root}"]`).click());
  assert.deepEqual(await ids(page), [a.id, b.id]);
  assert.deepEqual(await selected(page), []);
  await page.reload();
  await returned(page);
  assert.deepEqual(await ids(page), [a.id, b.id]);
  assert.equal(await page.getByRole("button", { name: "Grid view", exact: true }).getAttribute("aria-pressed"), "true");
  pass("keyboard-folder-tree", "Keyboard grid traversal opens nested real folders, breadcrumbs return to the original tree without stale selection, and reload preserves the grid location");
}

export async function workspaceKeyboardSelectionJourney(args) {
  const { page, base, pass } = args;
  const root = await journeyFolder(args, "keyboard range selection");
  const fixtures = [];
  for (const name of ["Alpha", "Beta", "Gamma", "Omega"]) fixtures.push(await make(args, root, name, "field"));
  const before = await Promise.all(fixtures.map(fixture => fixture.read()));
  await listing(page, base, root);
  await items(page).first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await selected(page), fixtures.slice(0, 3).map(f => f.id));
  await page.getByRole("button", { name: "Delete (3)", exact: true }).focus();
  await page.keyboard.press("Enter");
  await modal(page).getByText("Do you want to delete these 3 items?", { exact: true }).waitFor();
  await modal(page).getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await modal(page).waitFor({ state: "hidden" });
  assert.deepEqual(await selected(page), fixtures.slice(0, 3).map(f => f.id));
  const trigger = item(page, fixtures[1].id).getByRole("button", { name: "Actions for " + fixtures[1].title, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const actions = page.locator(".resource-menu button:not(:disabled)");
  await actions.first().focus();
  await page.keyboard.press("End");
  await focused(actions.last(), "End reaches the last available row action");
  await page.keyboard.press("Escape");
  await focused(trigger, "Escape returns focus to the row action trigger");
  // Focus returns synchronously; Angular removes the menu on its next render.
  await page.locator(".resource-menu").waitFor({ state: "detached" });
  assert.deepEqual(await Promise.all(fixtures.map(fixture => fixture.read())), before);
  pass("range-selection-cancel", "Keyboard range selection reaches grouped deletion, cancellation preserves all selected artifacts, and a row menu returns keyboard focus after dismissal");
}

export async function workspaceTypeFilterJourney(args) {
  const { page, base, pass } = args;
  const root = await journeyFolder(args, "type filters and ordering");
  const folder = await make(args, root, "Alpha folder", "folder"), template = await make(args, root, "Zeta template"),
    element = await make(args, root, "Middle element", "element"), field = await make(args, root, "Beta field", "field");
  await listing(page, base, root);
  const type = page.getByRole("button", { name: "Type", exact: true });
  await type.click();
  const filter = page.getByRole("dialog", { name: "Filter by type", exact: true });
  await filter.getByRole("checkbox", { name: "Folder", exact: true }).check();
  await filter.getByRole("checkbox", { name: "Template", exact: true }).check();
  await change(page, root, () => filter.getByRole("button", { name: "Apply", exact: true }).click());
  assert.deepEqual(await ids(page), [folder.id, template.id]);
  assert.equal((await type.innerText()).trim(), "Folder, Template");
  await sort(page, root, "Z to A");
  assert.deepEqual(await ids(page), [template.id, folder.id]);
  await sort(page, root, "On top");
  assert.deepEqual(await ids(page), [folder.id, template.id]);
  await change(page, root, () => page.getByRole("button", { name: "Refresh workspace", exact: true }).click());
  await page.reload();
  await returned(page);
  assert.deepEqual(await ids(page), [folder.id, template.id]);
  assert.equal((await type.innerText()).trim(), "Folder, Template");
  await change(page, root, () => page.getByRole("button", { name: "Clear type filter", exact: true }).click());
  assert.deepEqual(await ids(page), [folder.id, template.id, element.id, field.id]);
  pass("live-filter-sort-reload", "Multiple type filters constrain the real listing, descending order and folders-first compose correctly, and refresh/reload preserve those choices until the type filter is explicitly cleared");
}

export async function workspacePaginationJourney(args) {
  const { page, base, pass, write } = args;
  const root = await journeyFolder(args, "paged editing");
  const fixtures = [];
  // A real second page proves paging and return behavior; a mock cannot catch API offset errors.
  for (let index = 1; index <= 55; index++) fixtures.push(await make(args, root, "Page item " + String(index).padStart(2, "0")));
  await listing(page, base, root);
  assert.deepEqual(await ids(page), fixtures.slice(0, 50).map(f => f.id));
  await item(page, fixtures[49].id).locator(".resource-icon").click();
  await change(page, root, () => page.getByRole("button", { name: "Next", exact: true }).click());
  assert.deepEqual(await ids(page), fixtures.slice(50).map(f => f.id));
  assert.deepEqual(await selected(page), []);
  const target = fixtures[52], before = await target.read();
  await item(page, target.id).locator(".resource-icon").click();
  await row(page, target.title).getByRole("link", { name: target.title, exact: true }).click();
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  await page.getByPlaceholder("Add description...", { exact: true }).first().fill("Edited from the second page");
  await editorSave(page, write, "PUT", "templates");
  await page.locator("#back").click();
  await returned(page);
  assert.equal(new URL(page.url()).searchParams.get("offset"), "50");
  assert.deepEqual(await ids(page), fixtures.slice(50).map(f => f.id));
  assert.deepEqual(await selected(page), [target.id]);
  assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
  assertOnlyContentChanges(before, await target.read(), { "schema:description": "Edited from the second page" });
  await change(page, root, () => page.getByRole("button", { name: "Previous", exact: true }).click());
  assert.deepEqual(await ids(page), fixtures.slice(0, 50).map(f => f.id));
  pass("second-page-editor-return", "A fifty-five-item folder has disjoint correctly ordered pages, clears stale selections when paging, and returns from a real Designer save to the selected item on page two");
}

export async function workspaceSearchReturnJourney(args) {
  const { page, base, pass, write } = args;
  const root = await journeyFolder(args, "search return");
  const fixture = await make(args, root, "searchable template");
  const before = await fixture.read();
  await listing(page, base, root);
  const found = await searchUntilListed(page, fixture.title);
  assert.equal(found.done, true, "The created template becomes searchable");
  await row(page, fixture.title).locator("td").nth(1).click();
  await page.locator(".information").getByRole("tab", { name: "Version", exact: true }).click();
  const returnUrl = new URL(page.url());
  await row(page, fixture.title).getByRole("link", { name: fixture.title, exact: true }).click();
  await page.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
  await page.getByPlaceholder("Add description...", { exact: true }).first().fill("Saved from search results");
  await editorSave(page, write, "PUT", "templates");
  await page.locator("#back").click();
  await returned(page);
  assert.equal(new URL(page.url()).searchParams.get("search"), returnUrl.searchParams.get("search"));
  assert.equal(await page.getByRole("textbox", { name: "Search workspace", exact: true }).inputValue(), fixture.title);
  assert.deepEqual(await selected(page), [fixture.id]);
  assert.equal(await page.locator(".information").getByRole("tab", { name: "Version", exact: true }).getAttribute("aria-selected"), "true");
  assertOnlyContentChanges(before, await fixture.read(), { "schema:description": "Saved from search results" });
  pass("search-editor-return", "Editing a real search result restores its query, selection and Version tab on return while saving only the intended template description");
}

export async function workspaceRenamedBreadcrumbJourney(args) {
  const { page, base, name, pass, write } = args;
  const root = await journeyFolder(args, "renamed ancestors");
  const parent = await make(args, root, "Original parent", "folder"), child = await make(args, parent.id, "Child folder", "folder");
  const leaf = await make(args, child.id, "Unchanged descendant");
  const before = await leaf.read();
  await listing(page, base, root);
  await menu(page, parent.title, "Rename");
  const revised = name + " Renamed parent";
  await modal(page).getByLabel("Name", { exact: true }).fill(revised);
  await save(page, write, "POST", "/command/rename-resource", 200, true);
  await change(page, parent.id, () => row(page, revised).getByRole("link", { name: revised, exact: true }).click());
  await change(page, child.id, () => row(page, child.title).getByRole("link", { name: child.title, exact: true }).click());
  assert.equal((await page.locator(`.breadcrumbs [data-drop-id="${parent.id}"]`).innerText()).trim(), revised);
  assert.equal(await page.locator(".breadcrumbs").getByText(parent.title, { exact: true }).count(), 0);
  await page.reload();
  await returned(page);
  assert.deepEqual(await ids(page), [leaf.id]);
  assert.equal((await page.locator(`.breadcrumbs [data-drop-id="${parent.id}"]`).innerText()).trim(), revised);
  assert.deepEqual(await leaf.read(), before);
  await change(page, parent.id, () => page.locator(`.breadcrumbs [data-drop-id="${parent.id}"]`).click());
  assert.deepEqual(await ids(page), [child.id]);
  pass("renamed-ancestor-path", "Renaming a populated parent updates nested breadcrumbs and reloads under the same identities, preserving the descendant artifact and navigation back to the renamed folder");
}
