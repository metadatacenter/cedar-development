import assert from "node:assert/strict";
import { enc, mutate } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { createFolder, listed, listing, menu, modal, pathId, ready, row, save } from "./workspace-journey-fixtures.mjs";

// The journey checks Workspace's folder controls: a folder created and renamed through its own
// dialogs, the folder's action menu on a tall and a short screen, a listing that recovers from an
// expired access token, and a rename that a concurrent change refuses. Both folders are made through
// New, inside a folder of the journey's own.
//
// The journey acts as the runner's first test user only and never signs in as another account.
export async function folderUiJourney(args) {
  const { page, base, user, name, write, pass } = args;
  const parentId = await journeyFolder(args, "folder controls");
  const names = { folder: name + " folder", destination: name + " destination" };

  await listing(page, base, parentId);
  const folderId = (await createFolder(page, write, names.folder))["@id"];
  await listing(page, base, folderId);
  const destination = (await createFolder(page, write, names.destination))["@id"];
  await listed(page, base, folderId, names.destination);
  await menu(page, names.destination, "Rename");
  await modal(page).getByLabel("Name", { exact: true }).fill(names.destination + " renamed");
  await save(page, write, "POST", "/command/rename-resource", 200, true);
  names.destination += " renamed";
  pass("Create folder and conditional rename");

  for (const height of [1000, 480]) {
    await page.setViewportSize({ width: 1500, height });
    await row(page, names.destination)
      .getByRole("button", { name: "Actions for " + names.destination, exact: true }).click();
    const resourceMenu = page.locator(".resource-menu");
    await resourceMenu.waitFor();
    assert.deepEqual(
      (await resourceMenu.getByRole("button").allTextContents()).map(label => label.trim()),
      ["Open", "Permissions…", "Move", "Rename", "Delete", "Enable Openview",
        "Disable Openview", "Open in OpenView"],
      "The folder menu must offer only applicable actions in order",
    );
    await page.waitForFunction(() => {
      const menu = document.querySelector(".resource-menu");
      const rect = menu?.getBoundingClientRect();
      return rect && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    if (height === 1000) {
      assert.equal(await resourceMenu.evaluate(m => m.scrollHeight <= m.clientHeight), true,
        "All Workspace menu actions should fit without scrolling on a tall viewport");
    }
    const last = resourceMenu.getByRole("button", { name: "Open in OpenView", exact: true });
    await last.scrollIntoViewIfNeeded();
    const bounds = await last.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height,
      "The final menu action must remain reachable on short viewports");
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  pass("Applicable folder menu actions fit tall screens and remain reachable on short screens");

  await ready(page);
  // Inject one expired-access-token response, then let the real refresh and
  // retried request reach Keycloak and the resource server.
  let attempts = 0;
  const contentsUrl = url => url.pathname === "/folders/" + pathId(folderId) + "/contents";
  const expireOnce = async route => {
    if (route.request().method() !== "GET") return route.fallback();
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"message":"Expired access token"}',
        headers: { "Access-Control-Allow-Origin": new URL(base).origin },
      });
    return route.fallback();
  };
  await page.route(contentsUrl, expireOnce);
  try {
    const recovered = page.waitForResponse(response =>
      contentsUrl(new URL(response.url())) &&
      response.request().method() === "GET" &&
      response.status() === 200);
    await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
    await recovered;
    await ready(page);
    assert.equal(attempts, 2, "One unauthorized request is refreshed and retried once");
    assert.ok(await row(page, names.destination).count());
  } finally {
    await page.unroute(contentsUrl, expireOnce);
  }
  pass("Expired access response refreshes the real session and retries once");

  await listed(page, base, folderId, names.destination);
  await menu(page, names.destination, "Rename");
  await modal(page).getByLabel("Description", { exact: true }).fill("Unsaved local edit");
  const external = await mutate(user.auth, "PUT", "/folders/" + enc(destination),
    { "schema:description": "Concurrent description" });
  assert.equal(external.status, 200, external.text);
  await write(page, "POST", "/command/rename-resource",
    () => modal(page).getByRole("button", { name: "Save", exact: true }).click(), 412, true);
  // The dialog keeps the edit and says why once it has handled the refusal.
  await modal(page).getByRole("alert").filter({ hasText: "changed since" }).waitFor();
  assert.equal(await modal(page).getByLabel("Description", { exact: true }).inputValue(), "Unsaved local edit");
  await modal(page).getByRole("button", { name: "Cancel", exact: true }).click();
  pass("Stale Workspace write retains edits");
}
