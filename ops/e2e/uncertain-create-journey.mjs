import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";
import {fixtureAt, journeyFolder} from "./journey-fixtures.mjs";
import {assertNoRecoveryFiles} from "./recovery-boundary-journey.mjs";

// A client sends every create and new version under an identity it minted and journaled before
// sending, so a lost reply is settled by reading that identity, never by repeating the write. These
// journeys lose real replies at the browser's request boundary, after the server committed the write
// or before the write reached it, and settle each outcome through the existing controls: Check save
// status in Designer and the metadata editor, and Retry in Workspace's resource dialogs. A late
// commit is modelled by a real REST PUT of the body the browser sent. Every fault is page-scoped and
// removed in finally. Every case works in a folder of its own, so the count of what that folder holds
// is exact, and absences are asserted only once the page has reached a settled state.
//
// All three journeys act as the runner's first test user. The sign-in case returns through the SSO
// cookie, or through the login form if that has expired. It never logs out and never signs in as
// another account, so these journeys run alongside the other single-user journeys.

const resource = new URL(RESOURCE).origin;
const uuid = id => id.split("/").at(-1);
const UNCONFIRMED = "could not confirm whether";
const MINTED = collection => new RegExp(`^https://repo\\.[^/]+/${collection}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
export const VERSION_COMMAND = "/command/publish-create-draft-template/";
export const versionCommand = url => url.origin === resource && url.pathname.startsWith(VERSION_COMMAND);

// Designer controls that exist only while their condition does.
const DESIGNER_EXCEPTIONS = ["#check-save", "#recheck-access", "#sign-in-again", "#reload", "#draft-offer", "#server-issues"];
// The metadata editor's controls of the same kind, by their accessible names. Its reload control
// reads Retry after a failed load and Reload metadata otherwise.
const EDITOR_EXCEPTIONS = ["Check save status", "Recheck access", "Sign in again", "Reload metadata", "Retry", "Restore draft"];

/**
 * Asserts that Designer shows exactly the named exceptional controls and none of the others. Call it
 * only in a settled state, after the page has shown the message or status that ends the step.
 */
export async function designerShows(page, ...expected) {
  for (const selector of DESIGNER_EXCEPTIONS) {
    const shown = await page.locator(selector).isVisible();
    assert.equal(shown, expected.includes(selector), `${selector} ${shown ? "shown outside its condition" : "missing in its condition"}`);
  }
}

async function editorShows(page, ...expected) {
  for (const name of EDITOR_EXCEPTIONS) {
    const shown = (await page.getByRole("button", {name, exact: true}).count()) > 0;
    assert.equal(shown, expected.includes(name), `${name} ${shown ? "shown outside its condition" : "missing in its condition"}`);
  }
}

/** Waits until an input holds a value. A restored draft fills the form after the page has rendered. */
async function holds(locator, value) {
  await locator.page().waitForFunction(({element, value}) => element.value === value,
    {element: await locator.elementHandle(), value});
}

export async function saveEnabled(page, selector = "#save") {
  await page.waitForFunction(selector => document.querySelector(selector)?.disabled === false, selector);
}

/** Whether an address is the edit address of an identity, such as /templates/edit/<uuid>. */
export const editAddress = (url, route, id) => {
  const path = decodeURIComponent(url.pathname);
  return path.startsWith(`/${route}/edit/`) && path.endsWith("/" + uuid(id));
};

/** Completes a sign-in redirect. A live SSO cookie returns at once; an expired one shows the login form. */
async function signedIn(page, landed) {
  const form = page.locator("#username");
  await form.or(landed).first().waitFor();
  if (await form.isVisible()) {
    await form.fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com");
    await page.locator("#password").fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1");
    await page.locator("#kc-login").click();
  }
  await landed.waitFor();
}

/** Records a fixture for cleanup once, however many attempts name it. */
export function keep(created, collection, id) {
  if (!created.some(item => item.id === id)) created.push({collection, id});
}

async function read(user, path, status = 200) {
  const result = await call(user.auth, "GET", path);
  assert.equal(result.status, status, `GET ${path}: ${result.text.slice(0, 600)}`);
  return result;
}

export async function versionsOf(user, templateId) {
  return (await read(user, "/templates/" + enc(templateId) + "/versions")).body.totalCount;
}

/** What a folder holds, from the graph, which answers at once rather than when the index catches up. */
async function holdings(user, folderId) {
  const contents = await read(user, "/folders/" + enc(folderId) + "/contents?limit=50");
  return contents.body.resources.map(item => item["@id"]).sort();
}

async function createIn(user, folderId, collection, body) {
  const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
  assert.equal(result.status, 201, result.text.slice(0, 600));
  return result.body["@id"];
}

/**
 * A template whose two required fields an existing instance answers, so that removing one of them
 * needs a new version. `record` receives each fixture as it is made, the instance after its template.
 */
export async function versionedTemplate(user, folderId, label, record) {
  const template = artifactBody("template", label);
  for (const key of ["Notes", "Keep"]) {
    template.properties[key] = artifactBody("field", key);
    template.properties["@context"].properties[key] = {enum: ["https://example.org/uncertain-version/" + key]};
    template._ui.order.push(key);
    template._ui.propertyLabels[key] = key;
    template.required.push(key);
  }
  const templateId = await createIn(user, folderId, "templates", template);
  record("templates", templateId);
  const instance = artifactBody("instance", label + " record", {
    "schema:isBasedOn": templateId, Notes: {"@value": "An answer"}, Keep: {"@value": "Another answer"},
  });
  for (const key of ["Notes", "Keep"]) instance["@context"][key] = "https://example.org/uncertain-version/" + key;
  instance["@context"]["pav:derivedFrom"] = {"@type": "@id"};
  const instanceId = await createIn(user, folderId, "template-instances", instance);
  record("template-instances", instanceId);
  return {templateId, instanceId};
}

/**
 * Opens a template in Designer and deletes its Notes field, which the template's instance answers, so
 * that Save asks for a new version. The opened page must show no exceptional control.
 */
export async function removeUsedField(page, designer, templateId) {
  await page.goto(designer + "/templates/edit/" + enc(templateId));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  await designerShows(page);
  const name = page.getByRole("textbox", {name: "Field display name", exact: true});
  const field = page.locator("app-field-card").filter({has: name}).first();
  assert.equal(await field.getByRole("textbox", {name: "Field display name", exact: true}).inputValue(), "Notes");
  await field.getByRole("button", {name: "Delete field", exact: true}).click();
}

export const hasNotes = page => page.locator("cedar-embeddable-designer").evaluate(el => "Notes" in el.currentArtifact.properties);

/** Waits until the designer holds the restored definition, which keeps Keep and lacks Notes. */
export async function withoutNotes(page) {
  await page.waitForFunction(() => {
    const properties = document.querySelector("cedar-embeddable-designer")?.currentArtifact?.properties;
    return !!properties && "Keep" in properties && !("Notes" in properties);
  });
}

/** Saves, confirms Create new draft and returns the answer to the version command. */
export async function createNewDraft(page) {
  await page.locator("#save").click();
  const dialog = page.locator("#version-dialog");
  await dialog.waitFor();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === "POST" && versionCommand(new URL(r.url()))),
    dialog.getByRole("button", {name: "Create new draft", exact: true}).click(),
  ]);
  return response;
}

const createAttemptTo = (request, collection) => request.method() === "PUT" && !request.headers()["if-match"] &&
  fixtureAt(request.url())?.collection === collection;

/**
 * Loses the reply to the page's first create in a collection, after the server stored it or before
 * the server was reached. Returns what was sent: the address, the body and the identity the address
 * names, which is recorded for cleanup before anything else happens.
 */
async function loseCreate({page, collection, created, committed, save, settled}) {
  let sent, failure;
  const matcher = url => url.origin === resource && url.pathname.startsWith("/" + collection + "/");
  const lose = async route => {
    const request = route.request();
    if (sent || !createAttemptTo(request, collection)) return route.fallback();
    try {
      sent = {url: request.url(), body: request.postDataJSON(), id: fixtureAt(request.url()).id};
      keep(created, collection, sent.id);
      if (committed) {
        const response = await route.fetch();
        assert.equal(response.status(), 201, await response.text());
      }
    } catch (error) { failure = error; }
    await route.abort("failed");
  };
  await page.route(matcher, lose);
  try {
    await save();
    await settled();
  } finally { await page.unroute(matcher, lose); }
  assert.equal(failure, undefined, failure?.stack);
  assert.ok(sent, "the create was sent");
  assert.match(sent.id, MINTED(collection), "the client minted the identity on the deployment's base");
  assert.equal(sent.body["@id"], sent.id, "the body names the identity its address names");
  return sent;
}

/** Answers every read of an identity, and of its access report, as a session that has ended. */
async function refuseSession(page, id, run) {
  const lookup = url => url.origin === resource && decodeURIComponent(url.pathname).includes(uuid(id));
  const expire = route => route.request().method() === "GET"
    ? route.fulfill({status: 401, json: {message: "Session expired"}}) : route.fallback();
  await page.route(lookup, expire);
  try { await run(); } finally { await page.unroute(lookup, expire); }
}

const DESIGNER_KINDS = {
  template: {route: "templates", collection: "templates", component: "cedar-embeddable-designer",
    name: page => page.getByPlaceholder("Template name", {exact: true})},
  element: {route: "elements", collection: "template-elements", component: "cedar-embeddable-designer",
    name: page => page.getByRole("textbox", {name: "Element name", exact: true})},
  field: {route: "fields", collection: "template-fields", component: "cedar-embeddable-field-designer",
    name: page => page.getByRole("textbox", {name: "Field display name", exact: true})},
};

/** A field's description is on its Presentation tab, which a reload or a restored draft leaves unselected. */
async function showDescription(page, kind) {
  if (kind !== "field") return page.getByPlaceholder("Add description...", {exact: true}).first();
  const expand = page.getByRole("button", {name: "Expand field settings", exact: true});
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("tab", {name: "Presentation", exact: true}).click();
  return page.getByPlaceholder("Field description", {exact: true});
}

/**
 * One Designer create series. Committed: the reply is lost after the server stored the artifact, and
 * after a reload the restored draft's Check save status adopts it at its edit address. Uncommitted:
 * the write never reaches the server, the check is refused for the session, and after Sign in again
 * the restored draft's check finds nothing, so Save sends the same identity again. Late: the check in
 * the open tab finds nothing, the original request then commits, and the next Save is refused as
 * occupied. The check adopts what the late commit stored and keeps the newer edit on screen, under
 * the existing rule that an artifact Designer did not save needs a reload before another save.
 */
async function designerCreate(args, root, kind, outcome) {
  const {page, designer, user, created, write, pass} = args;
  const {route, collection, component, name: nameInput} = DESIGNER_KINDS[kind];
  const folderId = await journeyFolder({...args, folderId: root}, `${kind} ${outcome}`);
  const name = `${args.name} uncertain ${kind} ${outcome}`;
  const authored = () => page.locator(component).evaluate(el => [el.currentArtifact["schema:name"], el.currentArtifact["schema:description"]]);
  const authoredAs = (description) => page.waitForFunction(({component, name, description}) => {
    const artifact = document.querySelector(component)?.currentArtifact;
    return artifact?.["schema:name"] === name && artifact?.["schema:description"] === description;
  }, {component, name, description});
  const attempts = [];
  const count = request => { if (createAttemptTo(request, collection)) attempts.push(fixtureAt(request.url()).id); };
  page.on("request", count);
  try {
    await page.goto(`${designer}/${route}/create?folderId=${enc(folderId)}`);
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    await designerShows(page);
    if (kind === "field") await page.getByRole("button", {name: "Number", exact: true}).click();
    await nameInput(page).fill(name);
    await (await showDescription(page, kind)).fill("Submitted " + outcome);
    const sent = await loseCreate({page, collection, created, committed: outcome === "committed",
      save: () => page.locator("#save").click(),
      settled: () => page.locator("#message").filter({hasText: UNCONFIRMED}).waitFor()});
    const path = `/${collection}/${enc(sent.id)}`;
    // While the outcome is unknown, the input stays, Save is blocked, only Check save status is offered and nothing claims success.
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.notEqual(await page.locator("#state").textContent(), "Saved");
    assert.deepEqual(await authored(), [name, "Submitted " + outcome]);
    await designerShows(page, "#check-save");
    // A click that reaches the blocked Save sends nothing. The count of attempts at the end of the series shows it.
    await page.locator("#save").dispatchEvent("click");
    await read(user, path, outcome === "committed" ? 200 : 404);
    const check = page.locator("#check-save");
    if (outcome === "committed") {
      await page.reload();
      await page.locator("#draft-offer").waitFor();
      await designerShows(page, "#draft-offer");
      await page.locator("#restore-draft").click();
      await authoredAs("Submitted committed");
      await designerShows(page, "#check-save");
      await check.click();
      await page.locator("#message").filter({hasText: "The stored version matches your submitted changes"}).waitFor();
      await page.waitForURL(url => editAddress(url, route, sent.id));
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
      await designerShows(page);
      const stored = (await read(user, path)).body;
      assert.equal(stored["pav:createdBy"], user.profile["@id"]);
      assert.deepEqual([stored["schema:name"], stored["schema:description"]], [name, "Submitted committed"]);
    } else if (outcome === "uncommitted") {
      await refuseSession(page, sent.id, async () => {
        await check.click();
        await page.locator("#sign-in-again").waitFor();
      });
      await page.locator("#message").filter({hasText: "Your session has expired"}).waitFor();
      assert.equal(await page.locator("#save").isDisabled(), true);
      await designerShows(page, "#check-save", "#sign-in-again");
      await page.locator("#sign-in-again").click();
      await signedIn(page, page.locator("#restore-draft"));
      await designerShows(page, "#draft-offer");
      await page.locator("#restore-draft").click();
      await authoredAs("Submitted uncommitted");
      await check.click();
      await page.locator("#message").filter({hasText: "Not saved. Your changes remain in the designer."}).waitFor();
      await saveEnabled(page);
      await designerShows(page);
      await read(user, path, 404);
      assert.deepEqual(await holdings(user, folderId), []);
      const [response] = await Promise.all([
        page.waitForResponse(r => createAttemptTo(r.request(), collection)),
        page.locator("#save").click(),
      ]);
      assert.equal(response.status(), 201, await response.text());
      assert.equal(fixtureAt(response.url()).id, sent.id, "Save sends the create under the same identity");
      await page.waitForURL(url => editAddress(url, route, sent.id));
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    } else {
      await check.click();
      await page.locator("#message").filter({hasText: "Not saved. Your changes remain in the designer."}).waitFor();
      await saveEnabled(page);
      await designerShows(page);
      // The original request now commits, after the check found nothing at its identity.
      const address = new URL(sent.url);
      const late = await call(user.auth, "PUT", address.pathname + address.search, sent.body);
      assert.equal(late.status, 201, late.text.slice(0, 600));
      await (await showDescription(page, kind)).fill("Newer than the late commit");
      const [occupied] = await Promise.all([
        page.waitForResponse(r => createAttemptTo(r.request(), collection)),
        page.locator("#save").click(),
      ]);
      assert.ok([412, 428].includes(occupied.status()), `an occupied identity answered ${occupied.status()}`);
      assert.equal(fixtureAt(occupied.url()).id, sent.id);
      await page.locator("#message").filter({hasText: UNCONFIRMED}).waitFor();
      assert.equal(await page.locator("#save").isDisabled(), true);
      await designerShows(page, "#check-save");
      await check.click();
      await page.locator("#message").filter({hasText: "Saved as a new artifact."}).waitFor();
      await page.waitForURL(url => editAddress(url, route, sent.id));
      assert.deepEqual(await authored(), [name, "Newer than the late commit"]);
      assert.equal(await page.locator("#save").isDisabled(), true);
      await designerShows(page, "#reload");
      // Reload confirms discarding the newer edit and opens what the late commit stored.
      await page.locator("#reload").click();
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      await authoredAs("Submitted late");
      await designerShows(page);
    }
    // A conditional edit updates the one artifact, and reopening it offers nothing to recover.
    await (await showDescription(page, kind)).fill("Edited after " + outcome);
    await write(page, "PUT", "/" + collection + "/", () => page.locator("#save").click(), 200, true);
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    await page.reload();
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    await authoredAs("Edited after " + outcome);
    await designerShows(page);
    await assertNoRecoveryFiles(page);
    const stored = (await read(user, path)).body;
    assert.deepEqual([stored["schema:name"], stored["schema:description"], stored["pav:createdBy"]],
      [name, "Edited after " + outcome, user.profile["@id"]]);
    assert.deepEqual(await holdings(user, folderId), [sent.id], "the case folder holds exactly the one artifact");
    assert.equal(attempts.length, outcome === "committed" ? 1 : 2, "restoring and checking never send the create");
    assert.ok(attempts.every(id => id === sent.id), "every attempt uses the minted identity");
  } finally { page.off("request", count); }
  pass(`designer-${kind}-${outcome}`, `Designer ${kind}: ${outcome === "uncommitted" ? "an" : "a"} ${outcome} create whose reply was lost is settled by its identity and stored exactly once`);
}

/**
 * One metadata create series, with the same three outcomes as in Designer. The metadata editor adopts
 * what a late commit stored and keeps the newer value as an unsaved change, so the next Save updates
 * the adopted instance conditionally.
 */
async function editorCreate(args, root, templateId, outcome) {
  const {page, base, user, created, write, pass} = args;
  const collection = "template-instances";
  const folderId = await journeyFolder({...args, folderId: root}, `metadata ${outcome}`);
  const name = `${args.name} uncertain metadata ${outcome}`;
  const notes = page.locator("cedar-embeddable-editor").getByLabel("Notes", {exact: true});
  const instanceName = page.locator("#instance-name");
  const save = page.locator("#button-save-metadata");
  const status = page.locator(".metadata-save-status");
  const check = page.getByRole("button", {name: "Check save status", exact: true});
  const restore = page.getByRole("button", {name: "Restore draft", exact: true});
  const alert = text => page.getByRole("alert").filter({hasText: text});
  const attempts = [];
  const count = request => { if (createAttemptTo(request, collection)) attempts.push(fixtureAt(request.url()).id); };
  page.on("request", count);
  try {
    await page.goto(`${base}/instances/create/${enc(templateId)}?folderId=${enc(folderId)}`);
    await notes.waitFor();
    await status.filter({hasText: /^Unmodified$/}).waitFor();
    await editorShows(page);
    await instanceName.fill(name);
    await notes.fill("Submitted " + outcome);
    const sent = await loseCreate({page, collection, created, committed: outcome === "committed",
      save: () => save.click(), settled: () => alert(UNCONFIRMED).waitFor()});
    const path = `/${collection}/${enc(sent.id)}`;
    assert.equal(await save.isDisabled(), true);
    assert.notEqual((await status.textContent()).trim(), "Saved");
    assert.equal(await instanceName.inputValue(), name);
    assert.equal(await notes.inputValue(), "Submitted " + outcome);
    await editorShows(page, "Check save status");
    // A click that reaches the blocked Save sends nothing. The count of attempts at the end of the series shows it.
    await save.dispatchEvent("click");
    await read(user, path, outcome === "committed" ? 200 : 404);
    if (outcome === "committed") {
      await page.reload();
      await restore.waitFor();
      await editorShows(page, "Restore draft");
      await restore.click();
      await holds(notes, "Submitted committed");
      await editorShows(page, "Check save status");
      await check.click();
      await page.waitForURL(url => editAddress(url, "instances", sent.id));
      await status.filter({hasText: /^Saved$/}).waitFor();
      await editorShows(page);
      const stored = (await read(user, path)).body;
      assert.equal(stored["pav:createdBy"], user.profile["@id"]);
      assert.deepEqual([stored["schema:name"], stored.Notes["@value"]], [name, "Submitted committed"]);
    } else if (outcome === "uncommitted") {
      const signIn = page.getByRole("button", {name: "Sign in again", exact: true});
      await refuseSession(page, sent.id, async () => {
        await check.click();
        await signIn.waitFor();
      });
      assert.equal(await save.isDisabled(), true);
      await editorShows(page, "Check save status", "Sign in again");
      await signIn.click();
      await signedIn(page, restore);
      await editorShows(page, "Restore draft");
      await restore.click();
      await holds(notes, "Submitted uncommitted");
      await check.click();
      await alert("The record was not created.").waitFor();
      await saveEnabled(page, "#button-save-metadata");
      await editorShows(page);
      await read(user, path, 404);
      assert.deepEqual(await holdings(user, folderId), []);
      const [response] = await Promise.all([
        page.waitForResponse(r => createAttemptTo(r.request(), collection)),
        save.click(),
      ]);
      assert.equal(response.status(), 201, await response.text());
      assert.equal(fixtureAt(response.url()).id, sent.id, "Save sends the create under the same identity");
      await page.waitForURL(url => editAddress(url, "instances", sent.id));
      await status.filter({hasText: /^Saved$/}).waitFor();
    } else {
      await check.click();
      await alert("The record was not created.").waitFor();
      await saveEnabled(page, "#button-save-metadata");
      await editorShows(page);
      // The original request now commits, after the check found nothing at its identity.
      const address = new URL(sent.url);
      const late = await call(user.auth, "PUT", address.pathname + address.search, sent.body);
      assert.equal(late.status, 201, late.text.slice(0, 600));
      await notes.fill("Newer than the late commit");
      const [occupied] = await Promise.all([
        page.waitForResponse(r => createAttemptTo(r.request(), collection)),
        save.click(),
      ]);
      assert.ok([412, 428].includes(occupied.status()), `an occupied identity answered ${occupied.status()}`);
      assert.equal(fixtureAt(occupied.url()).id, sent.id);
      await alert(UNCONFIRMED).waitFor();
      assert.equal(await save.isDisabled(), true);
      await editorShows(page, "Check save status");
      await check.click();
      await page.waitForURL(url => editAddress(url, "instances", sent.id));
      await status.filter({hasText: /^Modified$/}).waitFor();
      assert.equal(await notes.inputValue(), "Newer than the late commit");
      await saveEnabled(page, "#button-save-metadata");
      await editorShows(page);
      assert.equal((await read(user, path)).body.Notes["@value"], "Submitted late");
    }
    // A conditional edit updates the one instance, and reopening it offers nothing to recover.
    await notes.fill("Edited after " + outcome);
    await write(page, "PUT", "/" + collection + "/", () => save.click(), 200, true);
    await status.filter({hasText: /^Saved$/}).waitFor();
    await page.reload();
    await notes.waitFor();
    await status.filter({hasText: /^Unmodified$/}).waitFor();
    assert.equal(await notes.inputValue(), "Edited after " + outcome);
    await editorShows(page);
    await assertNoRecoveryFiles(page);
    const stored = (await read(user, path)).body;
    assert.deepEqual([stored["schema:name"], stored.Notes["@value"], stored["schema:isBasedOn"], stored["pav:createdBy"]],
      [name, "Edited after " + outcome, templateId, user.profile["@id"]]);
    assert.deepEqual(await holdings(user, folderId), [sent.id], "the case folder holds exactly the one instance");
    assert.equal(attempts.length, outcome === "committed" ? 1 : 2, "restoring and checking never send the create");
    assert.ok(attempts.every(id => id === sent.id), "every attempt uses the minted identity");
  } finally { page.off("request", count); }
  pass(`editor-${outcome}`, `Metadata editor: ${outcome === "uncommitted" ? "an" : "a"} ${outcome} create whose reply was lost is settled by its identity and stored exactly once`);
}

const OUTCOMES = ["committed", "uncommitted", "late"];

export async function uncertainCreateJourney(args) {
  const {user, name, created} = args;
  const root = await journeyFolder(args, "uncertain creates");
  const template = artifactBody("template", name + " uncertain create template");
  template.properties.Notes = artifactBody("field", "Notes");
  template.properties["@context"].properties.Notes = {enum: ["https://example.org/uncertain-create/Notes"]};
  template._ui.order.push("Notes");
  template._ui.propertyLabels.Notes = "Notes";
  template.required.push("Notes");
  const templateId = await createIn(user, root, "templates", template);
  keep(created, "templates", templateId);
  for (const outcome of OUTCOMES) {
    for (const kind of Object.keys(DESIGNER_KINDS)) await designerCreate(args, root, kind, outcome);
    await editorCreate(args, root, templateId, outcome);
  }
}

// ── Workspace resource dialogs ─────────────────────────────────────────────────

const INSPECT = "This operation may already have completed. Use Retry to check its result before trying again.";

async function openFolder(page, base, folderId) {
  await page.goto(base + "/dashboard?folderId=" + enc(folderId));
  await page.getByRole("button", {name: "New", exact: true}).waitFor();
  const list = page.getByRole("button", {name: "List view", exact: true});
  if (await list.count()) await list.click();
  await page.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");
}

/**
 * Opens a row's action. The actions a row offers come from what the server derives for the listing,
 * so an action on a fixture made a moment ago can need the listing read again before it is offered.
 */
async function openAction(page, base, folderId, id, label) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await openFolder(page, base, folderId);
    const row = page.locator(`tbody tr[data-resource-id="${id}"]`);
    if (!(await row.count())) continue;
    await row.getByRole("button", {name: /^Actions for /}).click();
    const item = page.locator(".resource-menu").getByRole("button", {name: label, exact: true});
    await item.waitFor();
    if (await item.isEnabled()) return item.click();
  }
  assert.fail(`${label} was never offered for ${id}`);
}

async function enterVersion(dialog, version) {
  const parts = version.split(".");
  for (const [index, part] of ["Major", "Minor", "Patch"].entries())
    await dialog.getByRole("textbox", {name: part, exact: true}).fill(parts[index]);
}

async function versionIn(dialog) {
  const parts = [];
  for (const part of ["Major", "Minor", "Patch"]) parts.push(await dialog.getByRole("textbox", {name: part, exact: true}).inputValue());
  return parts.join(".");
}

/** Asserts whether a dialog shows its uncertain state: the status naming Retry, and Retry itself. */
async function dialogShows(dialog, uncertain) {
  assert.equal(await dialog.getByText(INSPECT, {exact: true}).count(), uncertain ? 1 : 0, "the uncertain status");
  assert.equal(await dialog.getByRole("button", {name: "Retry", exact: true}).count(), uncertain ? 1 : 0, "Retry");
}

/**
 * The four dialog actions whose outcome a lost reply leaves unknown. Each names the request it sends,
 * the identity that request creates, how the dialog is opened and filled, and how the outcome reads
 * from the server when the action did and did not take effect.
 */
const ACTIONS = {
  "new-folder": {
    label: "New folder",
    sends: request => request.method() === "PUT" && !request.headers()["if-match"] && new URL(request.url()).pathname.startsWith("/folders/"),
    identity: request => request.postDataJSON()["@id"],
    collection: "folders",
    statuses: [201],
    async open({page, base, folderId}) {
      await openFolder(page, base, folderId);
      await page.getByRole("button", {name: "New", exact: true}).click();
      await page.getByRole("button", {name: "Folder", exact: true}).click();
    },
    input: dialog => dialog.getByLabel("Name", {exact: true}),
    async committed({user, folderId, id}) {
      const folder = (await read(user, "/folders/" + enc(id))).body;
      assert.equal(folder.pathInfo.at(-2)["@id"], folderId, "the folder is in the requested parent");
      assert.deepEqual(await holdings(user, folderId), [id]);
    },
    async absent({user, folderId, id}) {
      await read(user, "/folders/" + enc(id), 404);
      assert.deepEqual(await holdings(user, folderId), []);
    },
  },
  copy: {
    label: "Copy",
    sends: request => request.method() === "POST" && new URL(request.url()).pathname === "/command/copy-artifact-to-folder",
    identity: request => request.postDataJSON().copyId,
    collection: "template-fields",
    statuses: [201],
    sourceCollection: "template-fields",
    source: ({user, folderId, label}) => createIn(user, folderId, "template-fields", artifactBody("field", label)),
    open: ({page, base, folderId, source}) => openAction(page, base, folderId, source, "Copy"),
    input: dialog => dialog.getByLabel("Name of copy", {exact: true}),
    async committed({user, folderId, source, id}) {
      assert.equal((await read(user, "/template-fields/" + enc(id))).body["pav:derivedFrom"], source);
      assert.deepEqual(await holdings(user, folderId), [source, id].sort(), "the folder holds the source and one copy");
    },
    async absent({user, folderId, source, id}) {
      await read(user, "/template-fields/" + enc(id), 404);
      assert.deepEqual(await holdings(user, folderId), [source]);
    },
  },
  draft: {
    label: "Create Draft",
    sends: request => request.method() === "POST" && new URL(request.url()).pathname === "/command/create-draft-artifact",
    identity: request => request.postDataJSON().draftId,
    collection: "templates",
    statuses: [201],
    version: "1.0.1",
    sourceCollection: "templates",
    async source({user, folderId, label}) {
      const id = await createIn(user, folderId, "templates", artifactBody("template", label));
      const published = await call(user.auth, "POST", "/command/publish-artifact", {"@id": id, newVersion: "1.0.0"});
      assert.ok([200, 201].includes(published.status), published.text.slice(0, 600));
      return id;
    },
    open: ({page, base, folderId, source}) => openAction(page, base, folderId, source, "Create Draft"),
    async committed({user, source, id}) {
      const draft = (await read(user, "/templates/" + enc(id))).body;
      assert.deepEqual([draft["pav:previousVersion"], draft["bibo:status"], draft["pav:version"]], [source, "bibo:draft", "1.0.1"]);
      assert.equal(await versionsOf(user, source), 2, "the source has exactly one successor");
    },
    async absent({user, source, id}) {
      await read(user, "/templates/" + enc(id), 404);
      assert.equal(await versionsOf(user, source), 1);
    },
  },
  publish: {
    label: "Publish",
    sends: request => request.method() === "POST" && new URL(request.url()).pathname === "/command/publish-artifact",
    identity: () => null,
    statuses: [200, 201],
    version: "1.0.0",
    sourceCollection: "templates",
    source: ({user, folderId, label}) => createIn(user, folderId, "templates", artifactBody("template", label)),
    open: ({page, base, folderId, source}) => openAction(page, base, folderId, source, "Publish"),
    async committed({user, source}) {
      const published = (await read(user, "/templates/" + enc(source))).body;
      assert.deepEqual([published["bibo:status"], published["pav:version"]], ["bibo:published", "1.0.0"]);
    },
    async absent({user, source}) {
      assert.equal((await read(user, "/templates/" + enc(source))).body["bibo:status"], "bibo:draft");
    },
  },
};

/**
 * One dialog action whose reply is lost. Committed: Retry finds the result and the dialog completes as
 * on success. Uncommitted: Retry finds nothing, submit returns with the same values, and submitting
 * sends the same identity. Across a reload, reopening the same action on the same item and destination
 * takes up the retained identity and values.
 */
async function dialogCase(args, root, action, outcome, acrossReload = false) {
  const {page, base, user, created, pass} = args;
  const spec = ACTIONS[action];
  const caseName = `${spec.label} ${outcome}${acrossReload ? " across reload" : ""}`;
  const folderId = await journeyFolder({...args, folderId: root}, caseName);
  const source = spec.source ? await spec.source({user, folderId, label: `${args.name} ${caseName} source`}) : undefined;
  if (source) keep(created, spec.sourceCollection, source);
  const dialog = page.locator("dialog[open]");
  const submit = dialog.locator("footer button[type=submit]");
  const value = `${args.name} ${caseName}`;
  const sent = [];
  const count = request => { if (spec.sends(request)) sent.push(spec.identity(request)); };
  page.on("request", count);
  try {
    await spec.open({page, base, folderId, source});
    await page.locator('dialog[open]:not([aria-busy="true"])').waitFor();
    // A fresh dialog, once prepared, offers no recovery.
    if (spec.input) {
      if (action === "copy") await page.waitForFunction(element => element.value !== "", await spec.input(dialog).elementHandle());
      await spec.input(dialog).fill(value);
    } else await enterVersion(dialog, spec.version);
    await dialogShows(dialog, false);
    let attempt, failure;
    const lose = async route => {
      const request = route.request();
      if (attempt || !spec.sends(request)) return route.fallback();
      try {
        attempt = {identity: spec.identity(request), body: request.postDataJSON()};
        if (spec.collection) {
          assert.match(attempt.identity ?? "", MINTED(spec.collection), "the dialog minted the identity it creates");
          keep(created, spec.collection, attempt.identity);
        }
        if (outcome === "committed") {
          const response = await route.fetch();
          assert.ok(spec.statuses.includes(response.status()), await response.text());
        }
      } catch (error) { failure = error; }
      await route.abort("failed");
    };
    const matcher = url => url.origin === resource;
    await page.route(matcher, lose);
    try {
      await submit.click();
      await dialog.getByText(INSPECT, {exact: true}).waitFor();
    } finally { await page.unroute(matcher, lose); }
    assert.equal(failure, undefined, failure?.stack);
    assert.ok(attempt, `${spec.label} was sent`);
    const retained = async () => {
      if (spec.input) assert.equal(await spec.input(dialog).inputValue(), value);
      else assert.equal(await versionIn(dialog), spec.version);
    };
    if (acrossReload) {
      await page.reload();
      await page.getByRole("button", {name: "New", exact: true}).waitFor();
      await spec.open({page, base, folderId, source});
      await dialog.getByText(INSPECT, {exact: true}).waitFor();
    }
    // While the outcome is unknown, the values stay, submit is blocked and Retry is offered.
    await dialogShows(dialog, true);
    assert.equal(await submit.isDisabled(), true);
    await retained();
    assert.equal(sent.length, 1);
    const ids = {user, folderId, source, id: attempt.identity};
    await dialog.getByRole("button", {name: "Retry", exact: true}).click();
    if (outcome === "committed") {
      await dialog.waitFor({state: "hidden"});
      if (["new-folder", "copy"].includes(action)) await page.locator(`tbody tr[data-resource-id="${attempt.identity}"]`).waitFor();
    } else {
      await dialog.getByRole("button", {name: "Retry", exact: true}).waitFor({state: "detached"});
      await page.waitForFunction(element => !element.disabled, await submit.elementHandle());
      await dialogShows(dialog, false);
      await retained();
      await spec.absent(ids);
      const [response] = await Promise.all([page.waitForResponse(r => spec.sends(r.request())), submit.click()]);
      assert.ok(spec.statuses.includes(response.status()), await response.text());
      assert.equal(spec.identity(response.request()), attempt.identity, "submitting again sends the same identity");
      assert.deepEqual(response.request().postDataJSON(), attempt.body, "submitting again sends the same values");
      await dialog.waitFor({state: "hidden"});
    }
    await spec.committed(ids);
    assert.equal(sent.length, outcome === "committed" ? 1 : 2, "Retry never sends the action");
  } finally { page.off("request", count); }
  pass(`workspace-${spec.label}-${outcome}-${acrossReload ? "reload" : "open"}`, `Workspace ${spec.label}: ${outcome === "uncommitted" ? "an" : "a"} ${outcome} action whose reply was lost${acrossReload ? ", reopened after a reload," : ""} is settled through Retry with exactly one result`);
}

export async function uncertainWorkspaceCreateJourney(args) {
  const root = await journeyFolder(args, "uncertain workspace creates");
  for (const action of Object.keys(ACTIONS)) for (const outcome of ["committed", "uncommitted"])
    await dialogCase(args, root, action, outcome);
  await dialogCase(args, root, "copy", "uncommitted", true);
}

// ── Designer's Create new draft ────────────────────────────────────────────────

/**
 * Designer's Create new draft with its reply lost, after the server created the successor or before
 * the request reached it. After a reload the restored draft's Check save status reads the draft
 * identity the request carried. Committed: Designer adopts the successor at its edit address.
 * Uncommitted: the source is still the opened draft, and Save sends the same draft identity again.
 */
export async function uncertainVersionJourney(args) {
  const {page, designer, user, created, write, pass} = args;
  const root = await journeyFolder(args, "uncertain versions");
  for (const outcome of ["committed", "uncommitted"]) {
    const {templateId, instanceId} = await versionedTemplate(user, root, `${args.name} uncertain version ${outcome}`,
      (collection, id) => keep(created, collection, id));
    const sourcePath = "/templates/" + enc(templateId);
    const opened = await read(user, sourcePath);
    assert.equal(await versionsOf(user, templateId), 1);
    const sent = [];
    const count = request => {
      if (request.method() === "POST" && versionCommand(new URL(request.url())))
        sent.push(new URL(request.url()).searchParams.get("draft_id"));
    };
    page.on("request", count);
    try {
      await removeUsedField(page, designer, templateId);
      let attempt, failure;
      const lose = async route => {
        const request = route.request();
        if (attempt || request.method() !== "POST") return route.fallback();
        try {
          attempt = {draftId: new URL(request.url()).searchParams.get("draft_id"), etag: request.headers()["if-match"]};
          assert.match(attempt.draftId ?? "", MINTED("templates"), "Designer minted the draft's identity");
          keep(created, "templates", attempt.draftId);
          if (outcome === "committed") {
            const response = await route.fetch();
            assert.equal(response.status(), 200, await response.text());
          }
        } catch (error) { failure = error; }
        await route.abort("failed");
      };
      await page.route(versionCommand, lose);
      try {
        await page.locator("#save").click();
        const dialog = page.locator("#version-dialog");
        await dialog.waitFor();
        await dialog.getByRole("button", {name: "Create new draft", exact: true}).click();
        await page.locator("#message").filter({hasText: UNCONFIRMED}).waitFor();
      } finally { await page.unroute(versionCommand, lose); }
      assert.equal(failure, undefined, failure?.stack);
      assert.ok(attempt?.etag, "the version write is conditional on the opened revision");
      const draftPath = "/templates/" + enc(attempt.draftId);
      assert.equal(await page.locator("#save").isDisabled(), true);
      assert.notEqual(await page.locator("#state").textContent(), "Saved");
      assert.equal(await hasNotes(page), false, "the edit stays in the designer");
      await designerShows(page, "#check-save");
      if (outcome === "committed") await read(user, draftPath);
      else {
        await read(user, draftPath, 404);
        assert.equal((await read(user, sourcePath)).headers.get("etag"), opened.headers.get("etag"));
      }
      await page.reload();
      await page.locator("#draft-offer").waitFor();
      await designerShows(page, "#draft-offer");
      await page.locator("#restore-draft").click();
      await withoutNotes(page);
      await designerShows(page, "#check-save");
      assert.notEqual(await page.locator("#state").textContent(), "Saved");
      await page.locator("#check-save").click();
      if (outcome === "committed") {
        await page.locator("#message").filter({hasText: "The stored version matches your submitted changes"}).waitFor();
        await page.waitForURL(url => editAddress(url, "templates", attempt.draftId));
        await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
        await designerShows(page);
      } else {
        await page.locator("#message").filter({hasText: "Not saved. Your changes remain in the designer."}).waitFor();
        await saveEnabled(page);
        await designerShows(page);
        assert.ok(editAddress(new URL(page.url()), "templates", templateId), "the designer stays on the source");
        assert.equal(await hasNotes(page), false);
        const source = await read(user, sourcePath);
        assert.deepEqual([source.body["bibo:status"], source.headers.get("etag")], ["bibo:draft", opened.headers.get("etag")]);
        assert.equal(await versionsOf(user, templateId), 1);
        await read(user, draftPath, 404);
        const response = await createNewDraft(page);
        assert.equal(response.status(), 200, await response.text());
        assert.equal(new URL(response.url()).searchParams.get("draft_id"), attempt.draftId, "Save sends the same draft identity");
        assert.equal((await response.json())["@id"], attempt.draftId);
        await page.waitForURL(url => editAddress(url, "templates", attempt.draftId));
        await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
        await designerShows(page);
      }
      const source = (await read(user, sourcePath)).body;
      assert.equal(source["bibo:status"], "bibo:published");
      assert.deepEqual(source.properties, opened.body.properties, "the published source keeps its definition");
      const draft = (await read(user, draftPath)).body;
      assert.deepEqual([draft["pav:previousVersion"], draft["bibo:status"]], [templateId, "bibo:draft"]);
      assert.deepEqual(["Notes" in draft.properties, "Keep" in draft.properties], [false, true], "the draft holds the edited definition");
      assert.equal(await versionsOf(user, templateId), 2, "the source has exactly one successor");
      assert.equal((await read(user, "/template-instances/" + enc(instanceId))).body["schema:isBasedOn"], templateId);
      // The adopted draft takes a conditional edit, and reopening it offers nothing to recover.
      await page.getByPlaceholder("Add description...", {exact: true}).first().fill("Edited after a " + outcome + " version");
      await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
      await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
      await page.reload();
      await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
      await designerShows(page);
      await assertNoRecoveryFiles(page);
      assert.equal((await read(user, draftPath)).body["schema:description"], "Edited after a " + outcome + " version");
      assert.equal(await versionsOf(user, templateId), 2);
      assert.deepEqual(sent, Array(outcome === "committed" ? 1 : 2).fill(attempt.draftId), "checking never sends the version");
    } finally { page.off("request", count); }
    pass(`version-${outcome}`, `Designer Create new draft: ${outcome === "uncommitted" ? "an" : "a"} ${outcome} version whose reply was lost is settled by its draft identity with exactly one successor`);
  }
}
