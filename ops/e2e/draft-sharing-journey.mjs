import { withBrowserAuthentication } from "./auth-activity.mjs";
import assert from "node:assert/strict";
import {dashboardAddress, journeyFolder} from "./journey-fixtures.mjs";
import {actors, artifactBody, call, enc, mutate} from "./rest/lib.mjs";

// A draft is shared as the version it is drafted from. Workspace's Create Draft and the Designer's
// Create new draft both ask the server to copy the source's grants, and only the owner may create a
// draft. Two people can sign in, so the second takes one role per source template, as the REST
// sharing suite does: no grant on the first, viewer of the second, and editor of the third.
//
// Each journey signs the second user in to a browser context of its own, so it belongs in the
// identity lane.
const ROLES = [null, "viewer", "editor"];
const roleName = role => role ?? "unrelated";
const uuid = id => id.split("/").at(-1);

async function signIn(page, base) {
  return withBrowserAuthentication("draft sharing reader sign-in", async () => {
    const context = await page.context().browser().newContext({ignoreHTTPSErrors: true, viewport: {width: 1500, height: 1000}});
    const reader = await context.newPage();
    const errors = [];
    reader.on("dialog", dialog => dialog.accept());
    reader.on("pageerror", error => errors.push(error.message));
    await reader.goto(base + "/dashboard");
    await reader.locator("#username").fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN || "test2@test.com");
    await reader.locator("#password").fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || "test2");
    await reader.locator("#kc-login").click();
    await reader.getByRole("button", {name: "New", exact: true}).waitFor();
    return {context, reader, errors};
  });
}

async function fixtures(args, suffix) {
  const {user, created} = args;
  const {user2} = await actors();
  const folderId = await journeyFolder(args, suffix);
  // The folder grants nobody anything, so any access the second user has to a draft came from its source.
  const folderAcl = await call(user.auth, "GET", "/folders/" + enc(folderId) + "/permissions");
  assert.equal(folderAcl.status, 200, folderAcl.text);
  assert.deepEqual([folderAcl.body.userPermissions, folderAcl.body.groupPermissions], [[], []]);
  const folderRead = await call(user2.auth, "GET", "/folders/" + enc(folderId));
  assert.equal(folderRead.status, 403, folderRead.text);
  async function create(collection, body) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body["@id"];
  }
  // Shares the source with the second user in the given role, or leaves it unshared, and returns its ACL.
  async function share(id, role) {
    const path = "/templates/" + enc(id) + "/permissions";
    if (role) {
      const granted = await mutate(user.auth, "PUT", path, {owner: {"@id": user.profile["@id"]},
        userPermissions: [{user: {"@id": user2.profile["@id"]}, role}], groupPermissions: []});
      assert.equal(granted.status, 200, granted.text);
    }
    const acl = await call(user.auth, "GET", path);
    assert.equal(acl.status, 200, acl.text);
    assert.equal(acl.body.userPermissions.length, role ? 1 : 0, JSON.stringify(acl.body));
    return acl.body;
  }
  return {folderId, user2, create, share};
}

// What each person can do with a new draft, read from the server and from the Designer, and what its
// original allows them afterwards.
async function checkAccess({reader, designer, user, user2, sourceId, sourceAcl, draftId, role, write}) {
  const label = roleName(role);
  const original = "/templates/" + enc(sourceId), draft = "/templates/" + enc(draftId);
  assert.deepEqual((await call(user.auth, "GET", original + "/permissions")).body, sourceAcl,
    label + ": drafting must leave the original's grants as they were");
  const draftAcl = (await call(user.auth, "GET", draft + "/permissions")).body;
  assert.equal(draftAcl.owner["@id"], user.profile["@id"], label + ": the draft belongs to the owner who drafted it");
  assert.deepEqual([draftAcl.userPermissions, draftAcl.groupPermissions],
    [sourceAcl.userPermissions, sourceAcl.groupPermissions], label + ": the draft carries exactly the original's grants");

  for (const path of [original, draft]) {
    const read = await call(user2.auth, "GET", path);
    assert.equal(read.status, role ? 200 : 403, label + " reading " + path + ": " + read.text);
  }
  if (role !== "editor") {
    // The revision comes from the owner, so the refusal is the write itself rather than its preflight read.
    const before = (await call(user.auth, "GET", draft)).body;
    const changed = {...structuredClone(before), "schema:description": "Changed by the " + label + " user"};
    const refused = await mutate(user2.auth, "PUT", draft, changed, {etagAuth: user.auth});
    assert.equal(refused.status, 403, label + " writing the draft: " + refused.text);
    assert.deepEqual((await call(user.auth, "GET", draft)).body, before, label + ": a refused write changes nothing");
  }

  await reader.goto(designer + "/templates/edit/" + enc(draftId));
  const state = reader.locator("#state");
  if (role === "editor") {
    await state.filter({hasText: /^Unmodified$/}).waitFor();
    for (const name of ["Recheck access", "Sign in again"])
      assert.equal(await reader.getByRole("button", {name, exact: true}).isVisible(), false, name + " shown to an editor");
    const description = reader.getByPlaceholder("Add description...", {exact: true}).first();
    await description.fill("Edited by the editor of the draft");
    await write(reader, "PUT", "/templates/", () => reader.locator("#save").click(), 200, true);
    await state.filter({hasText: /^Saved$/}).waitFor();
    assert.equal((await call(user.auth, "GET", draft)).body["schema:description"], "Edited by the editor of the draft");
  } else if (role === "viewer") {
    await state.filter({hasText: /^Read only$/}).waitFor();
    await reader.locator("#message").filter({hasText: "This artifact is read only."}).waitFor();
    const save = reader.locator("#save");
    assert.ok(!(await save.count()) || await save.isDisabled(), "Save offered to a viewer");
  } else {
    await state.filter({hasText: /^Unable to load$/}).waitFor();
    await reader.locator("#message").filter({hasText: "You do not have permission to open this artifact."}).waitFor();
  }
}

// Shared with Me lists the drafts the second user was given and not the one they were not. The
// listing comes from the search index, so wait until both granted drafts appear. The unshared one was
// drafted first, so by then it would be listed too if it were shared.
async function checkSharedWithMe(reader, base, drafts) {
  const listed = async () => {
    await reader.goto(dashboardAddress(base, {sharing: "shared-with-me"}));
    await reader.getByRole("button", {name: "New", exact: true}).waitFor();
    const list = reader.getByRole("button", {name: "List view", exact: true});
    if (await list.count()) await list.click();
    const found = new Set();
    for (;;) {
      await reader.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");
      for (const [role, id] of drafts)
        if (await reader.locator(`tbody tr a[href*="${uuid(id)}"]`).count()) found.add(role);
      const next = reader.getByRole("button", {name: "Next", exact: true});
      if (!(await next.count()) || await next.isDisabled()) return found;
      const previousUrl = reader.url();
      await next.click();
      await reader.waitForURL(url => url.href !== previousUrl);
    }
  };
  let found;
  for (let attempt = 0; attempt < 15; attempt++) {
    found = await listed();
    if (found.has("editor") && found.has("viewer")) break;
  }
  assert.ok(found.has("editor") && found.has("viewer"), "Shared with Me lists " + [...found].join(", "));
  assert.equal(found.has("unrelated"), false, "Shared with Me lists a draft its source never shared");
}

// Workspace path: a published template, drafted from its row's Create Draft action.
export async function workspaceDraftSharingJourney(args) {
  const {page, base, designer, user, name, created, write, pass} = args;
  const {folderId, user2, create, share} = await fixtures(args, "workspace draft sharing");
  const drafts = [];
  for (const role of ROLES) {
    const sourceName = name + " shared draft source " + roleName(role);
    const sourceId = await create("templates", artifactBody("template", sourceName));
    const published = await call(user.auth, "POST", "/command/publish-artifact", {"@id": sourceId, newVersion: "1.0.0"});
    assert.ok([200, 201].includes(published.status), published.text);
    const sourceAcl = await share(sourceId, role);

    // The row's actions come from the search index, so the published template offers Create Draft once
    // the index has caught up with its publication.
    let offered = false;
    for (let attempt = 0; attempt < 15 && !offered; attempt++) {
      await page.goto(dashboardAddress(base, {folderId}));
      await page.getByRole("button", {name: "New", exact: true}).waitFor();
      const list = page.getByRole("button", {name: "List view", exact: true});
      if (await list.count()) await list.click();
      await page.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");
      const row = page.locator("tbody tr").filter({has: page.locator(`a[href*="${uuid(sourceId)}"]`)}).first();
      if (!(await row.count())) continue;
      await row.getByRole("button", {name: "Actions for " + sourceName, exact: true}).click();
      const item = page.locator(".resource-menu").getByRole("button", {name: "Create Draft", exact: true});
      await item.waitFor();
      offered = await item.isEnabled();
      if (offered) await item.click();
    }
    assert.ok(offered, sourceName + " never offered Create Draft");
    const dialog = page.locator("dialog[open]");
    for (const [index, part] of ["Major", "Minor", "Patch"].entries())
      await dialog.getByRole("textbox", {name: part, exact: true}).fill(["1", "0", "1"][index]);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/command/create-draft-artifact"),
      dialog.getByRole("button", {name: "Ok", exact: true}).click(),
    ]);
    assert.equal(response.status(), 201, await response.text());
    assert.equal(JSON.parse(response.request().postData()).propagateSharing, true);
    const draftId = (await response.json())["@id"];
    assert.ok(draftId && draftId !== sourceId);
    if (!created.some(item => item.id === draftId)) created.push({collection: "templates", id: draftId});
    await dialog.waitFor({state: "hidden"});
    drafts.push({role, sourceId, sourceAcl, draftId});
  }
  const {context, reader, errors} = await signIn(page, base);
  try {
    for (const draft of drafts) await checkAccess({reader, designer, user, user2, write, ...draft});
    await checkSharedWithMe(reader, base, drafts.map(draft => [roleName(draft.role), draft.draftId]));
    assert.deepEqual(errors, [], "uncaught browser errors");
  } finally {
    await context.close();
  }
  pass("workspace-grants", "Workspace Create Draft: the editor edits the draft, the viewer reads it, a person without a grant cannot open it, and the original's grants are unchanged");
}

// Designer path: a draft template with metadata, saved with a change its metadata prevents, so the
// Designer offers Create new draft.
export async function designerDraftSharingJourney(args) {
  const {page, base, designer, user, name, created, write, pass} = args;
  const {user2, create, share} = await fixtures(args, "designer draft sharing");
  const drafts = [];
  for (const role of ROLES) {
    const template = artifactBody("template", name + " shared version source " + roleName(role));
    for (const key of ["Notes", "Keep"]) {
      template.properties[key] = artifactBody("field", key);
      template.properties["@context"].properties[key] = {enum: ["https://example.org/draft-sharing/" + key]};
      template._ui.order.push(key);
      template._ui.propertyLabels[key] = key;
      template.required.push(key);
    }
    const sourceId = await create("templates", template);
    const instance = artifactBody("instance", name + " shared version record " + roleName(role), {
      "schema:isBasedOn": sourceId, Notes: {"@value": "An answer"}, Keep: {"@value": "Another answer"},
    });
    for (const key of ["Notes", "Keep"]) instance["@context"][key] = "https://example.org/draft-sharing/" + key;
    instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
    await create("template-instances", instance);
    const sourceAcl = await share(sourceId, role);

    await page.goto(designer + "/templates/edit/" + enc(sourceId));
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    const field = page.locator("app-field-card").filter({has: page.getByRole("textbox", {name: "Enter field name", exact: true})}).first();
    assert.equal(await field.getByRole("textbox", {name: "Enter field name", exact: true}).inputValue(), "Notes");
    await field.getByRole("button", {name: "Delete field", exact: true}).click();
    await page.locator("#save").click();
    const dialog = page.locator("#version-dialog");
    await dialog.waitFor();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/command/publish-create-draft-template/")),
      dialog.getByRole("button", {name: "Create new draft", exact: true}).click(),
    ]);
    assert.ok(response.ok(), await response.text());
    const draftId = (await response.json())["@id"];
    assert.ok(draftId && draftId !== sourceId);
    if (!created.some(item => item.id === draftId)) created.push({collection: "templates", id: draftId});
    await page.waitForURL(url => decodeURIComponent(url.pathname).endsWith(uuid(draftId)));
    await page.locator("#state").filter({hasText: /^Unmodified$|^Saved$/}).waitFor();
    assert.equal((await call(user.auth, "GET", "/templates/" + enc(sourceId))).body["bibo:status"], "bibo:published");
    drafts.push({role, sourceId, sourceAcl, draftId});
  }
  const {context, reader, errors} = await signIn(page, base);
  try {
    for (const draft of drafts) await checkAccess({reader, designer, user, user2, write, ...draft});
    await checkSharedWithMe(reader, base, drafts.map(draft => [roleName(draft.role), draft.draftId]));
    assert.deepEqual(errors, [], "uncaught browser errors");
  } finally {
    await context.close();
  }
  pass("designer-grants", "Designer Create new draft: the editor edits the draft, the viewer reads it, a person without a grant cannot open it, and the original's grants are unchanged");
}
