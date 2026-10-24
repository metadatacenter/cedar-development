import { withBrowserAuthentication } from "./auth-activity.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { poll } from "./rest/lib.mjs";
import { dashboardAddress, listingIdle, listingOf, listView } from "./journey-fixtures.mjs";

// These helpers drive Workspace's own controls for the full smoke and its journeys: the listing and
// its rows, a row's action menu, the dialogs those actions open, the Permissions dialog and the
// Shared with Me listing. A helper that writes takes the runner's write(), which asserts the reply's
// status and records what the write created.

/** The form in which a browser address identifies an artifact or folder: its type and UUID. */
export const selector = iri => iri.split("/").slice(-2).join("/");
/** The UUID that ends an identity. */
export const pathId = iri => iri.substring(iri.lastIndexOf("/") + 1);

/**
 * Asserts that a save changed only what the user edited. A normal update changes its root write
 * provenance. Everything else must be accounted for by the user's explicit edit, including nested
 * definitions and unexposed metadata.
 */
export function assertOnlyContentChanges(before, after, changes) {
  const comparable = artifact => {
    const copy = structuredClone(artifact);
    delete copy["pav:lastUpdatedOn"];
    delete copy["oslc:modifiedBy"];
    return copy;
  };
  assert.deepEqual(comparable(after), comparable({...before, ...changes}),
    "Saving a targeted edit must preserve all unrelated artifact content");
}

export const modal = p => p.locator("dialog[open]");

/**
 * The visible copy of a message in `scope`, a page or a locator. Workspace also says each message
 * from a status region the page does not draw, so a plain text locator finds both.
 */
export const shown = (scope, text) => scope.getByText(text, {exact: true})
  .and((typeof scope.page === "function" ? scope.page() : scope).locator(":not(cedar-status)"));

/** A version is entered as three numbers, one per box of the dialog's picker. */
export async function enterVersion(p, version) {
  const parts = version.split(".");
  for (const [index, name] of ["Major", "Minor", "Patch"].entries())
    await modal(p).getByRole("textbox", { name, exact: true }).fill(parts[index]);
}

export const row = (p, name) =>
  p.locator("tbody tr").filter({ has: p.getByRole("link", { name, exact: true }) }).first();

/** Selecting a row opens its information. The date cell is clicked, since the name cell's link opens the artifact. */
export const showInformation = (p, name) => row(p, name).locator("td").nth(1).click();

/**
 * Waits until Workspace has rendered its listing in list view, without writing shared preferences.
 */
export const ready = listView;

/**
 * Signs a user in to Workspace through the Keycloak form, in a browser context of its own, and
 * returns once the listing is shown. The context has the smoke's viewport and default timeout.
 * Every dialog on the page is accepted, and the page's uncaught errors are collected.
 */
export async function signIn(browser, base, login, password) {
  return withBrowserAuthentication("Workspace user sign-in", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
    context.setDefaultTimeout(25000);
    const page = await context.newPage();
    const errors = [];
    page.on("dialog", dialog => dialog.accept());
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(dashboardAddress(base), { waitUntil: "domcontentloaded" });
    await page.locator("#username, cedar-workspace-page .destinations").first().waitFor({ state: "visible" });
    if (await page.locator("#username").isVisible()) {
      await page.locator("#username").fill(login);
      await page.locator("#password").fill(password);
      await page.locator("#kc-login").click();
    }
    await ready(page);
    return { context, page, errors };
  });
}

/** Signs the second test user in to a browser context of its own. */
export const signInSecondUser = (page, base) => signIn(page.context().browser(), base,
  process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com",
  process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2");

/** Opens a folder's listing, and returns once the request the navigation made has been answered and rendered. */
export async function listing(p, base, id) {
  await Promise.all([
    p.waitForResponse(listingOf(id)),
    p.goto(dashboardAddress(base, { folderId: selector(id) }), { waitUntil: "domcontentloaded" }),
  ]);
  await ready(p);
}

/**
 * Opens a folder's listing until it shows a row with the name. A folder can hold enough fixtures to
 * span several listing pages, so each listing is read to its end before the next attempt.
 */
export async function listed(p, base, id, name) {
  for (let i = 0; i < 15; i++) {
    await listing(p, base, id);
    for (;;) {
      if (await row(p, name).count()) return;
      const next = p.getByRole("button", { name: "Next", exact: true });
      if (await next.isDisabled()) break;
      await Promise.all([p.waitForResponse(listingOf(id)), next.click()]);
      await listingIdle(p);
    }
  }
  throw new Error("Not listed in 15 settled listings: " + name);
}

/** Opens a row's action menu and chooses an action once the menu offers it enabled. */
export async function menu(p, name, label) {
  await row(p, name).getByRole("button", { name: "Actions for " + name, exact: true }).click();
  const item = p.locator(".resource-menu").getByRole("button", { name: label, exact: true });
  await item.waitFor();
  await p.waitForFunction(
    label => Array.from(document.querySelectorAll(".resource-menu button")).some(
      b => b.textContent.trim() === label && !b.disabled),
    label,
  );
  await item.click();
}

// OpenView changes, publications and drafts confirm with "Ok" rather than "Save".
const confirmLabel = path => /-open|publish-artifact|create-draft-artifact/.test(path) ? "Ok" : "Save";

/** Confirms the open dialog, asserts the write the confirmation sends, and returns once the dialog has closed. */
export async function save(p, write, method, path, status = 200, conditional = false) {
  const data = await write(p, method, path,
    () => modal(p).getByRole("button", { name: confirmLabel(path), exact: true }).click(),
    status, conditional);
  await modal(p).waitFor({ state: "hidden" });
  return data;
}

/** Creates a folder in the listing shown, through New. The dialog mints the folder's identity, so the write is a PUT to it. */
export async function createFolder(p, write, name) {
  await p.getByRole("button", { name: "New", exact: true }).click();
  await p.getByRole("button", { name: "Folder", exact: true }).click();
  await modal(p).getByLabel("Name", { exact: true }).fill(name);
  return save(p, write, "PUT", "/folders/", 201);
}

/** Opens an artifact listed in a folder in Designer, and returns once Designer has read it. */
export async function editor(p, base, id, name) {
  await listed(p, base, id, name);
  await row(p, name).getByRole("link", { name, exact: true }).click();
  await p.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
}

/** Saves in Designer. A create is a PUT answered 201 at an identity the editor minted, and carries no If-Match. */
export async function editorSave(p, write, method, collection, status = 200) {
  const data = await write(p, method, "/" + collection + "/", () => p.locator("#save").click(),
    status, method === "PUT" && status !== 201);
  // A successful save stays in Designer.
  await p.locator("#state").filter({ hasText: /^Saved$/ }).waitFor();
  return data;
}

/** Designer's own control is the only way back to Workspace. */
export async function backToWorkspace(p) {
  await p.locator("#back").click();
  await ready(p);
}

/** Checks the Permissions dialog's colours and that it fits a wide and a narrow screen. */
export async function permissionAppearance(p, name) {
  const heading = modal(p).locator("h2");
  assert.equal(await heading.evaluate(e => getComputedStyle(e).color), "rgb(23, 63, 62)");
  assert.equal(await modal(p).evaluate(e => getComputedStyle(e).backgroundColor), "rgb(255, 255, 255)");
  if (name === "readonly") {
    assert.equal(await modal(p).locator("select.readonly-role").first().evaluate(e => getComputedStyle(e).opacity), "1",
      "read-only values remain legible rather than appearing unavailable");
  }
  const previous = p.viewportSize();
  for (const width of [1440, 375]) {
    await p.setViewportSize({ width, height: 950 });
    const bounds = await modal(p).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "permissions stays within viewport");
    assert.equal(await modal(p).locator(".access-list").evaluate(e => e.scrollWidth <= e.clientWidth), true,
      "permission controls require no horizontal scrolling");
    const done = await modal(p).getByRole("button", { name: "Done", exact: true }).boundingBox();
    assert.ok(done.y + done.height <= 950, "Done stays reachable on narrow screens");
    if (process.env.CEDAR_UI_SCREENSHOTS) {
      await mkdir(process.env.CEDAR_UI_SCREENSHOTS, { recursive: true });
      await p.screenshot({ path: `${process.env.CEDAR_UI_SCREENSHOTS}/permissions-${name}-${width}.png` });
    }
  }
  await p.setViewportSize(previous);
}

export async function permissionDone(p) {
  await modal(p).getByRole("button", { name: "Done", exact: true }).click();
  await modal(p).waitFor({ state: "hidden" });
}

/** Gives Test User 2 a role in the open Permissions dialog, or changes the role they have, and closes it. */
export async function setPermission(p, write, collection, role) {
  const rolePicker = modal(p).getByRole("combobox", { name: "Role for Test User 2", exact: true });
  await modal(p).getByRole("heading", { name: "Owner and direct role assignments", exact: true }).waitFor();
  if (await rolePicker.count()) {
    await write(p, "PUT", collection, () => rolePicker.selectOption(role), 200, true);
  } else {
    await modal(p).getByRole("combobox", { name: "User or group", exact: true }).fill("Test User 2");
    await modal(p).getByRole("option", { name: "Test User 2", exact: true }).click();
    await modal(p).getByRole("combobox", { name: "Role", exact: true }).selectOption(role);
    await write(p, "PUT", collection, () => modal(p).getByRole("button", { name: "Add", exact: true }).click(), 200, true);
  }
  await permissionDone(p);
}

/** Removes Test User 2's direct role in the open Permissions dialog, and closes it. */
export async function removePermission(p, write, collection) {
  await write(p, "PUT", collection,
    () => modal(p).getByRole("button", { name: "Remove direct role for Test User 2", exact: true }).click(),
    200, true);
  await permissionDone(p);
}

const sharedListing = response => {
  const url = new URL(response.url());
  return response.request().method() === "GET" && url.pathname === "/search" &&
    url.searchParams.get("sharing") === "shared-with-me";
};

/** Runs a gesture that opens Shared with Me, and returns once its listing has settled. */
export async function openSharedWithMe(p, gesture) {
  await Promise.all([p.waitForResponse(sharedListing), gesture()]);
  await ready(p);
}

const searchAnswer = query => response => {
  const url = new URL(response.url());
  return response.request().method() === "GET" && url.pathname === "/search" &&
    url.searchParams.get("q") === query && response.status() === 200;
};

/**
 * Searches for a name with Workspace's top search until a result row shows it, and returns poll()'s
 * outcome. Indexing is eventual, so a search that does not list the name is repeated. Every artifact
 * whose name shares a word with the query is a result, and the results page by fifty rows sorted by
 * name, so the fixtures of a run in another lane can fill the first page. Each search is therefore
 * read to its last page. `query` is what is typed, when a word only this artifact carries makes a
 * search that lists it alone.
 */
export async function searchUntilListed(p, name, { tries = 21, delayMs = 1000, query = name } = {}) {
  const answered = searchAnswer(query);
  await p.getByRole("textbox", { name: "Search workspace", exact: true }).fill(query);
  let paged = false;
  return poll(async attempt => {
    // Searching again from a later page returns to the first one. Searching again on the first page
    // changes no route, so a later attempt there refreshes the listing instead.
    const control = attempt === 1 || paged ? "Search" : "Refresh workspace";
    await Promise.all([p.waitForResponse(answered), p.getByRole("button", { name: control, exact: true }).click()]);
    await ready(p);
    paged = false;
    for (;;) {
      if (await row(p, name).count()) return { done: true };
      const next = p.getByRole("button", { name: "Next", exact: true });
      if (await next.isDisabled()) return { done: false };
      await Promise.all([p.waitForResponse(answered), next.click()]);
      await listingIdle(p);
      paged = true;
    }
  }, { tries, delayMs });
}

/**
 * Whether the Shared with Me listing on this page shows the name on any of its pages. It pages by
 * fifty rows sorted by name, so a grant that another run makes to the same user can push a row past
 * the first page; reading only that page would miss a present row and prove nothing about an absent one.
 * The caller opens the listing with openSharedWithMe, so every page is read once it has settled.
 */
export async function sharedWithMeLists(p, name) {
  for (;;) {
    if (await row(p, name).count()) return true;
    const next = p.getByRole("button", { name: "Next", exact: true });
    if (!(await next.count()) || await next.isDisabled()) return false;
    await Promise.all([p.waitForResponse(sharedListing), next.click()]);
    await listingIdle(p);
  }
}
