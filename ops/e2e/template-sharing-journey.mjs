import assert from "node:assert/strict";
import { actors, call, enc, mutate } from "./rest/lib.mjs";
import { journeyFolder } from "./journey-fixtures.mjs";
import { diseaseTemplate } from "./metadata-journey-fixtures.mjs";
import {
  listed, menu, modal, openSharedWithMe, pathId, permissionAppearance, permissionDone, removePermission,
  save, searchUntilListed, setPermission, sharedWithMeLists, showInformation, signInSecondUser,
} from "./workspace-journey-fixtures.mjs";

// These journeys share a template with a second person through Workspace's Permissions dialog, and
// move its ownership to them and back. The owner works on the runner's page. The second person works
// in a browser context of their own, so both people are signed in at once, as in two browsers.
//
// Both journeys sign the second test user in to a browser context of their own, so they belong in the
// identity lane.

/** Makes a template with the fields the full smoke authors in Designer, in a folder the second user cannot read. */
async function sharedTemplate(args, suffix) {
  const { user, name, created } = args;
  const folderId = await journeyFolder(args, suffix);
  const templateName = name + " " + suffix + " template";
  const made = await call(user.auth, "POST", "/templates?folder_id=" + enc(folderId), diseaseTemplate(templateName));
  assert.equal(made.status, 201, made.text);
  created.push({ collection: "templates", id: made.body["@id"] });
  return { folderId, templateName, templateId: made.body["@id"] };
}

// The owner gives the second person each role in turn: Viewer, then Editor, which they use and then
// lose with a Designer draft open, then Manager. The second person watches from their own page. The
// Everyone group may only view. A role change sent against a stale list of grants is refused and
// explained. Removing the grant takes the template out of the reader's Shared with Me.
export async function templateSharingJourney(args) {
  const { page, base, designer, user, write, pass } = args;
  const { folderId, templateName, templateId } = await sharedTemplate(args, "sharing");
  const grant = async (p, role) => {
    await listed(p, base, folderId, templateName);
    await menu(p, templateName, "Permissions…");
    await setPermission(p, write, "/templates/", role);
  };
  await grant(page, "viewer");
  const { context, page: reader, errors } = await signInSecondUser(page, base);
  try {
    await openSharedWithMe(reader, () => reader
      .getByRole("link", { name: "Shared with Me", exact: true })
      .click());
    assert.ok(await sharedWithMeLists(reader, templateName), "Shared with Me does not list the template");
    // The panel shows the row at once and what the reader may do once the template's report is read.
    await Promise.all([
      reader.waitForResponse(response => response.request().method() === "GET" &&
        new URL(response.url()).pathname.endsWith("/report") &&
        decodeURIComponent(new URL(response.url()).pathname).includes(pathId(templateId))),
      showInformation(reader, templateName),
    ]);
    await reader.getByRole("heading", { name: templateName, exact: true }).waitFor();
    assert.equal(await reader.getByRole("button", { name: "Edit description", exact: true }).count(), 0);
    await menu(reader, templateName, "Permissions…");
    await modal(reader).getByRole("heading", { name: "Owner and direct role assignments", exact: true }).waitFor();
    assert.equal(await modal(reader).getByRole("combobox", { name: "User or group", exact: true }).count(), 0);
    assert.equal(await modal(reader).getByRole("combobox", { name: "Role for Test User 2", exact: true }).isDisabled(), true);
    await permissionAppearance(reader, "readonly");
    await permissionDone(reader);

    await grant(page, "editor");
    // Shared with Me pages by name, and other work's grants to the reader can push the row past the
    // first page, so the reloaded listing is read until it shows the row.
    await openSharedWithMe(reader, () => reader.reload());
    assert.ok(await sharedWithMeLists(reader, templateName), "Shared with Me does not list the template");
    await menu(reader, templateName, "Rename");
    await modal(reader).getByLabel("Description", { exact: true }).fill("Changed by editor");
    await save(reader, write, "POST", "/command/rename-resource", 200, true);
    // The editor opened with permission; another user removes that permission while
    // its draft is still open. This differs from initially opening a read-only page.
    await reader.goto(designer + "/templates/edit/" + enc(templateId));
    const readerDescription = reader.getByPlaceholder("Add description...", {exact: true}).first();
    await reader.locator("#state").filter({ hasText: /^Unmodified$/ }).waitFor();
    await readerDescription.fill("Designer draft after access loss");
    const beforeDesignerRevocation = await call(user.auth, "GET", "/templates/" + enc(templateId));
    await grant(page, "viewer");
    const deniedDesignerSave = reader.waitForResponse(response => response.status() === 403 &&
      response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith("/templates/"));
    await reader.locator("#save").click();
    await deniedDesignerSave;
    await reader.waitForFunction(() => document.getElementById("save").disabled);
    assert.equal(await readerDescription.inputValue(), "Designer draft after access loss");
    assert.deepEqual((await call(user.auth, "GET", "/templates/" + enc(templateId))).body,
      beforeDesignerRevocation.body);
    // Reload asks before discarding the draft, and the answer is settled once the question is closed.
    reader.removeAllListeners("dialog");
    const askedToReload = reader.waitForEvent("dialog");
    reader.once("dialog", dialog => dialog.dismiss());
    await reader.locator("#reload").click();
    assert.equal((await askedToReload).type(), "confirm");
    assert.equal(await readerDescription.inputValue(), "Designer draft after access loss");
    reader.on("dialog", dialog => dialog.accept());
    pass("revoked-designer", "Designer loses edit permission while open: save refused, draft retained, server content unchanged");

    await grant(page, "manager");
    await openSharedWithMe(reader, () => reader.goto(base + "/dashboard?sharing=shared-with-me"));
    assert.ok(await sharedWithMeLists(reader, templateName), "Shared with Me does not list the template");
    await menu(reader, templateName, "Permissions…");
    await modal(reader).getByRole("combobox", { name: "User or group", exact: true }).waitFor();
    await permissionDone(reader);
    await listed(page, base, folderId, templateName);
    await menu(page, templateName, "Permissions…");
    await modal(page).getByRole("heading", {name: "Owner and direct role assignments", exact: true}).waitFor();
    await permissionAppearance(page, "editable");
    // Special groups remain Viewer-only and cannot be made owners.
    await modal(page).getByRole("combobox", { name: "User or group", exact: true }).fill("Everyone");
    await modal(page).getByRole("option", { name: "Everyone (Group)", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#share-role")?.options.length === 1);
    assert.deepEqual(
      await modal(page).getByRole("combobox", { name: "Role", exact: true }).locator("option").allTextContents(),
      ["Viewer"],
    );
    await write(page, "PUT", "/templates/",
      () => modal(page).getByRole("button", { name: "Add", exact: true }).click(), 200, true);
    const everyoneRole = modal(page).getByRole("combobox", { name: "Role for Everyone", exact: true });
    await everyoneRole.waitFor();
    assert.deepEqual(
      (await everyoneRole.locator("option").allTextContents()).map(label => label.trim()),
      ["Viewer"],
    );
    assert.equal(
      await modal(page).getByRole("checkbox", { name: "Make Everyone the owner", exact: true }).isDisabled(),
      true,
    );
    await write(page, "PUT", "/templates/",
      () => modal(page).getByRole("button", { name: "Remove direct role for Everyone", exact: true }).click(),
      200, true);
    await everyoneRole.waitFor({ state: "detached" });

    // An external ACL change must reject a stale edit and leave the failed intent visible.
    const permissionPath = "/templates/" + enc(templateId) + "/permissions";
    const acl = await call(user.auth, "GET", permissionPath);
    assert.equal(acl.status, 200);
    const changed = await mutate(user.auth, "PUT", permissionPath, {
      owner: { "@id": acl.body.owner["@id"] },
      userPermissions: acl.body.userPermissions.map(g => ({ user: { "@id": g.user["@id"] }, role: "editor" })),
      groupPermissions: [],
    });
    assert.equal(changed.status, 200);
    await write(page, "PUT", "/templates/",
      () => modal(page).getByRole("combobox", { name: "Role for Test User 2", exact: true }).selectOption("viewer"),
      412, true);
    await modal(page).getByRole("alert").filter({ hasText: "Not saved: Set Test User 2 to Viewer" }).waitFor();
    await modal(page).getByRole("button", { name: "Reload permissions", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('select[aria-label="Role for Test User 2"]')?.value === "editor");
    await removePermission(page, write, "/templates/");
    await openSharedWithMe(reader, () => reader.reload());
    assert.equal(await sharedWithMeLists(reader, templateName), false,
      "Shared with Me still lists the template after its grant was removed");
    assert.deepEqual(errors, [], "uncaught browser errors on the reader's page");
  } finally {
    await context.close();
  }
  pass("role-transitions", "Permissions: viewer access, immediate role saves, Everyone restrictions, stale revisions, and two-user revocation");
}

// Ownership moves through Workspace's own control in both directions, each confirmed in the page.
// The new owner cannot open the folder holding the template, so they reach it through search.
export async function ownershipTransferJourney(args) {
  const { page, base, user, write, pass } = args;
  const { user2 } = await actors();
  const { folderId, templateName, templateId } = await sharedTemplate(args, "ownership");
  const permissionPath = "/templates/" + enc(templateId) + "/permissions";
  const transferOwnership = async (p, toName, toUser) => {
    const confirmation = p.locator("dialog.confirmation-dialog");
    const permissions = await write(p, "POST", "/command/transfer-resource-ownership", async () => {
      await modal(p).getByRole("checkbox", { name: `Make ${toName} the owner`, exact: true }).click();
      await confirmation.getByRole("button", { name: "Yes", exact: true }).click();
    }, 200);
    assert.equal(permissions?.owner?.["@id"], toUser.profile["@id"]);
    assert.ok(
      !(permissions?.userPermissions ?? []).some(g => g.user?.["@id"] === toUser.profile["@id"]),
      "the new owner does not also keep a direct role",
    );
    await modal(p).waitFor({ state: "hidden" });
  };
  const { context, page: reader, errors } = await signInSecondUser(page, base);
  try {
    await listed(page, base, folderId, templateName);
    await menu(page, templateName, "Permissions…");
    await setPermission(page, write, "/templates/", "editor");
    await listed(page, base, folderId, templateName);
    await menu(page, templateName, "Permissions…");
    await transferOwnership(page, "Test User 2", user2);
    // The index follows the transfer, so the new owner searches again until the template is found.
    const transferred = await searchUntilListed(reader, templateName);
    assert.ok(!transferred.timedOut,
      `the transferred template never appeared in ${transferred.attempts} of the new owner's searches`);
    await menu(reader, templateName, "Permissions…");
    await modal(reader).getByRole("combobox", { name: "User or group", exact: true }).fill("Test User 1");
    await modal(reader).getByRole("option", { name: "Test User 1", exact: true }).click();
    await modal(reader).getByRole("combobox", { name: "Role", exact: true }).selectOption("editor");
    await write(reader, "PUT", "/templates/",
      () => modal(reader).getByRole("button", { name: "Add", exact: true }).click(), 200, true);
    await transferOwnership(reader, "Test User 1", user);
    const returned = await call(user.auth, "GET", permissionPath);
    assert.equal(returned.body.owner["@id"], user.profile["@id"]);
    // Leave the template owned by Test User 1 alone, with no direct role left for anyone.
    if (returned.body.userPermissions.length)
      assert.equal((await mutate(user.auth, "PUT", permissionPath, {
        owner: { "@id": user.profile["@id"] },
        userPermissions: [],
        groupPermissions: [],
      })).status, 200);
    assert.deepEqual(errors, [], "uncaught browser errors on the new owner's page");
  } finally {
    await context.close();
    // The first user deletes the template at cleanup, which only its owner may do. A run that stops
    // while the second user owns it hands it back first.
    const acl = await call(user2.auth, "GET", permissionPath);
    if (acl.status === 200 && acl.body.owner?.["@id"] === user2.profile["@id"]) {
      const back = await mutate(user2.auth, "POST", "/command/transfer-resource-ownership",
        { "@id": templateId, newOwnerId: user.profile["@id"] }, { etagPath: permissionPath });
      assert.equal(back.status, 200, back.text);
    }
  }
  pass("ownership-roundtrip", "Ownership transfers to another user and back through Workspace");
}
