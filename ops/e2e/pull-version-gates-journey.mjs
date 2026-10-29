import assert from "node:assert/strict";
import {actors, artifactBody, call, enc, mutate, RESOURCE} from "./rest/lib.mjs";
import {fixtureAt, recordFixture} from "./journey-fixtures.mjs";
import {collection, insert, open, setup, versionPanel} from "./pull-version-journey.mjs";
import {designerShows} from "./uncertain-create-journey.mjs";

// A linked or copied child's Version tab reads its origin's history, loads the newest published
// release and weighs it against the parent. Two of these journeys change that history on the real
// host: one gives the author a history it can read only in part, and the other deletes a source while
// the tab weighs it. The third changes the parent while a Save as reusable draft is unsettled. Each
// journey first opens a fixture of its own and leaves it untouched, to check that the ordinary tab
// shows no failure and no exceptional host control, and writes nothing.
//
// version-source-access also uses the second test user, by REST token and never in a browser, to own
// sources the first user may read only in part. What it makes in the second user's home is named after
// the root it was given. The other two journeys act as the first user only.

const resource = new URL(RESOURCE).origin;
const uuid = id => id.split("/").at(-1);
const PENDING_NOTE = /^(Looking for newer versions|Checking whether it is compatible)\.$/;

/** Records every request that could change stored state. A compatibility check only reads. */
function writesOf(page) {
  const writes = [];
  const note = request => {
    const url = new URL(request.url());
    if (url.origin === resource && !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
        !url.pathname.startsWith("/command/check-update-template/")) writes.push(request.method() + " " + url.pathname);
  };
  page.on("request", note);
  return {writes, stop: () => page.off("request", note)};
}

/** The notes a Version tab shows once its lookup, and any assessment the lookup started, have ended. */
async function settledNotes(panel) {
  await panel.page().waitForFunction(({element, pending}) => {
    const notes = [...element.querySelectorAll("p.version-note")].map(note => note.textContent.trim());
    return notes.length >= 2 && !notes.some(note => new RegExp(pending).test(note));
  }, {element: await panel.elementHandle(), pending: PENDING_NOTE.source});
  return (await panel.locator("p.version-note").allTextContents()).map(note => note.trim());
}

/** Waits for a promise, failing after the runners' default wait with a message that says what it waited for. */
async function within(promise, what, ms = 25000) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); });
  try { return await Promise.race([promise, expired]); } finally { clearTimeout(timer); }
}

/** Waits until a control is enabled. */
async function enabled(locator) {
  await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle());
}

/** The settings of the field placed as Reused, found by its name as versionPanel finds it. */
async function reusedSettings(page) {
  for (const card of await page.locator("app-field-card").all())
    if (await card.locator("input.field-name").first().inputValue() === "Reused") return card.locator("app-field-settings");
  assert.fail("The field placement named Reused is present");
}

/** The names of the buttons a Version tab offers. */
const actionsOf = async panel => (await panel.getByRole("button").allTextContents()).map(name => name.trim());

/** Opens the Reused child's Version tab and returns it with the notes and actions it settles on. */
async function versionTab(page, kind = "field") {
  const panel = await versionPanel(page, kind);
  const notes = await settledNotes(panel);
  return {panel, notes, actions: await actionsOf(panel)};
}

/** A published source with the given releases, each drafted from the one before and then published. */
async function releases(auth, folderId, label, versions, own) {
  const made = await call(auth, "POST", "/template-fields?folder_id=" + enc(folderId), artifactBody("field", label));
  assert.equal(made.status, 201, made.text);
  const ids = [made.body["@id"]];
  own(ids[0]);
  for (const [index, version] of versions.entries()) {
    if (index) {
      const drafted = await call(auth, "POST", "/command/create-draft-artifact",
        {"@id": ids.at(-1), folderId, newVersion: version, propagateSharing: false});
      assert.equal(drafted.status, 201, drafted.text);
      ids.push(drafted.body["@id"]);
      own(drafted.body["@id"]);
    }
    const published = await call(auth, "POST", "/command/publish-artifact", {"@id": ids.at(-1), newVersion: version});
    assert.equal(published.status, 200, published.text);
  }
  return ids;
}

/** A template that links the given published field under the placement Reused, beside a sibling. */
function linkingTemplate(label, child) {
  const body = artifactBody("template", label);
  insert(body, "Reused", child);
  insert(body, "Sibling", artifactBody("field", "Sibling"));
  return body;
}

/** Asserts that the parent is unmodified, shows no exceptional control, was never written and is stored as it was made. */
async function untouched(ctx, template, observed) {
  const {page} = ctx;
  assert.equal(await page.locator("#state").textContent(), "Unmodified");
  await designerShows(page);
  assert.deepEqual(observed.writes, [], "an untouched Version tab writes nothing");
  assert.deepEqual((await call(ctx.user.auth, "GET", "/templates/" + enc(template["@id"]))).body, template);
}

/** Reloads the parent and asserts that it opens unmodified with no exceptional control. */
async function reopensClean(page) {
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  await designerShows(page);
}

/**
 * The first user may read the first release of the second user's source but not its second release,
 * and may read nothing of another source. The tab never offers or attaches a release the author cannot
 * read. An unreadable origin is reported as such, and the parent stays editable with its link intact.
 */
export async function sourceAccessJourney(ctx) {
  const {page, user, name, write, pass} = ctx;
  const {folderId, read, create} = await setup(ctx, "version source access");
  const {user2} = await actors();
  const home = await call(user2.auth, "POST", "/folders", {
    folderId: user2.profile.homeFolderId, name: name + " version source owner folder", description: "Temporary journey fixtures",
  });
  assert.equal(home.status, 201, home.text.slice(0, 600));
  const ownerFolder = home.body["@id"];
  const owned = [];
  let failure;
  try {
    const own = id => owned.push(id);
    const viewer = async id => {
      const granted = await mutate(user2.auth, "PUT", "/template-fields/" + enc(id) + "/permissions", {
        owner: {"@id": user2.profile["@id"]}, userPermissions: [{user: {"@id": user.profile["@id"]}, role: "viewer"}], groupPermissions: [],
      });
      assert.equal(granted.status, 200, granted.text.slice(0, 600));
    };
    const readAs = async (auth, id, status = 200) => {
      const result = await call(auth, "GET", "/template-fields/" + enc(id));
      assert.equal(result.status, status, result.text.slice(0, 600));
      return result.body;
    };

    // A history the author can read in full, at its newest release, shows the ordinary tab.
    const [current] = await releases(user.auth, folderId, "Reused", ["1.0.0"], id => ctx.created.push({collection: "template-fields", id}));
    const plain = await create("template", linkingTemplate(name + " readable history", await read("field", current)));
    let observed = writesOf(page);
    try {
      await open(ctx, plain, folderId);
      const tab = await versionTab(page);
      assert.deepEqual(tab.notes, ["This is Reused v1.0.0.", "No newer published version is available."]);
      assert.deepEqual(tab.actions, ["Open original", "Detach to edit"]);
      assert.equal(await tab.panel.getByRole("alert").count(), 0);
      await untouched(ctx, plain, observed);
    } finally { observed.stop(); }
    await reopensClean(page);
    pass("readable-history-untouched", "A linked child whose whole history the author can read shows its newest release with no failure, no exceptional control and no write");

    // The second release is published but unreadable to the author, and the tab never offers it.
    const [first, second] = await releases(user2.auth, ownerFolder, "Reused", ["1.0.0", "2.0.0"], own);
    await viewer(first);
    await readAs(user.auth, second, 403);
    const partly = await create("template", linkingTemplate(name + " partly readable history", await readAs(user.auth, first)));
    observed = writesOf(page);
    try {
      await open(ctx, partly, folderId);
      const tab = await versionTab(page);
      assert.equal(tab.notes[0], "This is Reused v1.0.0.");
      assert.ok(!tab.actions.some(action => /^Upgrade to /.test(action)), `no upgrade to a release the author cannot read: ${tab.actions}`);
      assert.ok(tab.actions.includes("Detach to edit"));
      const embedded = (await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact)).properties.Reused;
      assert.equal(embedded["@id"], first, "the child stays linked to the release the author can read");
      await untouched(ctx, partly, observed);
    } finally { observed.stop(); }
    await reopensClean(page);
    pass("newer-release-unreadable", "A newer release the author cannot read is never offered or attached, and the parent stays unchanged and unwritten");

    // The author can read nothing of this source. The tab says so, offers only detachment, and the
    // parent still saves an edit of its own with the link intact.
    const [hidden] = await releases(user2.auth, ownerFolder, "Reused", ["1.0.0"], own);
    await readAs(user.auth, hidden, 403);
    const sealed = await create("template", linkingTemplate(name + " unreadable origin", await readAs(user2.auth, hidden)));
    observed = writesOf(page);
    try {
      await open(ctx, sealed, folderId);
      const tab = await versionTab(page);
      assert.deepEqual(tab.notes, ["This is Reused v1.0.0.",
        "The origin cannot be read. It may have been deleted, or you may not have access to it."]);
      assert.deepEqual(tab.actions, ["Detach to edit"]);
      await untouched(ctx, sealed, observed);
    } finally { observed.stop(); }
    await page.getByPlaceholder("Add description...", {exact: true}).first().fill("Edited beside an unreadable origin");
    await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    const saved = await read("template", sealed["@id"]);
    assert.equal(saved["schema:description"], "Edited beside an unreadable origin");
    assert.deepEqual(saved.properties.Reused, sealed.properties.Reused, "the unreadable link is kept exactly");
    assert.deepEqual(saved.properties.Sibling, sealed.properties.Sibling);
    await reopensClean(page);
    pass("origin-unreadable", "An origin the author cannot read is reported as unreadable with only detachment offered, and the parent saves its own edit with the link intact");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // The second user's sources go before the folder that holds them, newest release first.
    const problems = [];
    for (const id of [...owned].reverse()) {
      const removed = await mutate(user2.auth, "DELETE", "/template-fields/" + enc(id));
      if (![200, 204, 404].includes(removed.status)) problems.push(`template-fields/${id}: ${removed.status}`);
    }
    const removed = await mutate(user2.auth, "DELETE", "/folders/" + enc(ownerFolder));
    if (![200, 204, 404].includes(removed.status)) problems.push(`folders/${ownerFolder}: ${removed.status}`);
    if (problems.length && failure) console.error("version-source-access cleanup: " + problems.join("; "));
    else assert.deepEqual(problems, [], "version-source-access cleanup");
  }
}

/**
 * The source is deleted while the tab weighs it. A release deleted after the history listed it is
 * answered 404 when the tab loads it, so no upgrade is offered, and a fresh lookup lists what remains.
 * An origin deleted while its history is read is reported as unreadable. The deletions are real REST
 * deletions, made while the page's own request is held at the browser's request boundary.
 */
export async function sourceDeletionJourney(ctx) {
  const {page, user, name, pass} = ctx;
  const {folderId, read, create} = await setup(ctx, "version source deletion");
  const own = id => ctx.created.push({collection: "template-fields", id});
  const remove = async id => {
    const removed = await mutate(user.auth, "DELETE", "/template-fields/" + enc(id));
    assert.equal(removed.status, 204, removed.text);
  };
  /** Holds the page's first GET that `matches` until `release` is called, and resolves `held` once it arrives. */
  function holding(matches) {
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { arrived = resolve; });
    let taken = false;
    const handler = async route => {
      if (taken || route.request().method() !== "GET") return route.fallback();
      taken = true; arrived();
      await gate;
      return route.fallback();
    };
    return {matcher: url => url.origin === resource && matches(url), handler, held, release: () => release()};
  }

  // The tab weighs a readable newer release and offers it. Nothing is written until the author acts.
  const [plainFirst] = await releases(user.auth, folderId, "Reused", ["1.0.0", "2.0.0"], own);
  const plain = await create("template", linkingTemplate(name + " assessment untouched", await read("field", plainFirst)));
  let observed = writesOf(page);
  try {
    await open(ctx, plain, folderId);
    const tab = await versionTab(page);
    assert.deepEqual(tab.notes, ["This is Reused v1.0.0.", "The newest available published version is v2.0.0.",
      "It is compatible: every instance that is valid now stays valid."]);
    assert.deepEqual(tab.actions, ["Open original", "Upgrade to v2.0.0 (compatible)", "Detach to edit"]);
    assert.equal(await tab.panel.getByRole("alert").count(), 0);
    await untouched(ctx, plain, observed);
  } finally { observed.stop(); }
  await reopensClean(page);
  pass("assessment-untouched", "An untouched assessment offers the compatible release with no failure, no exceptional control and no write");

  // The newer release is deleted after the history listed it and before the tab loaded it.
  const [first, second] = await releases(user.auth, folderId, "Reused", ["1.0.0", "2.0.0"], own);
  const parent = await create("template", linkingTemplate(name + " candidate deleted", await read("field", first)));
  const load = holding(url => url.pathname === "/template-fields/" + uuid(second));
  await page.route(load.matcher, load.handler);
  observed = writesOf(page);
  try {
    await open(ctx, parent, folderId);
    const panel = await versionPanel(page, "field");
    await within(load.held, "the tab to load the newer release");
    await remove(second);
    load.release();
    const notes = await settledNotes(panel);
    assert.equal(notes[0], "This is Reused v1.0.0.");
    const actions = await actionsOf(panel);
    assert.ok(!actions.some(action => /^Upgrade to /.test(action)), `no upgrade to a deleted release: ${actions}`);
    assert.ok(actions.includes("Detach to edit"));
    await untouched(ctx, parent, observed);
  } finally { load.release(); await page.unroute(load.matcher, load.handler); observed.stop(); }
  // Opening the tab again looks the history up afresh, and the deleted release has left it.
  await (await reusedSettings(page)).getByRole("tab", {name: "Configuration", exact: true}).click();
  const panel = await versionPanel(page, "field");
  await panel.getByText("No newer published version is available.", {exact: true}).waitFor();
  assert.deepEqual(await settledNotes(panel), ["This is Reused v1.0.0.", "No newer published version is available."]);
  assert.deepEqual(await actionsOf(panel), ["Open original", "Detach to edit"]);
  await reopensClean(page);
  pass("candidate-deleted-during-load", "A release deleted while the tab loads it is never offered, the parent stays unwritten, and a fresh lookup lists only what remains");

  // The origin is deleted while its history is read.
  const [origin] = await releases(user.auth, folderId, "Reused", ["1.0.0"], own);
  const orphan = await create("template", linkingTemplate(name + " origin deleted", await read("field", origin)));
  const history = holding(url => url.pathname === "/template-fields/" + uuid(origin) + "/versions");
  await page.route(history.matcher, history.handler);
  observed = writesOf(page);
  try {
    await open(ctx, orphan, folderId);
    const panel = await versionPanel(page, "field");
    await within(history.held, "the tab to read the origin's history");
    await remove(origin);
    history.release();
    assert.deepEqual(await settledNotes(panel), ["This is Reused v1.0.0.",
      "The origin cannot be read. It may have been deleted, or you may not have access to it."]);
    assert.deepEqual(await actionsOf(panel), ["Detach to edit"]);
    await untouched(ctx, orphan, observed);
  } finally { history.release(); await page.unroute(history.matcher, history.handler); observed.stop(); }
  await reopensClean(page);
  pass("origin-deleted-during-lookup", "An origin deleted while its history is read is reported as unreadable, offers only detachment, and leaves the parent unwritten");
}

/**
 * The parent changes while Save as reusable draft is unsettled. A result that arrives for a document
 * that has since changed is stored but not attached, and repeating the action attaches that stored
 * artifact without creating another. A lost reply whose readback also fails, and a create that never
 * reached the server, settle on repetition under the identity first sent. Either way the parent keeps
 * its edit and saves it with the reusable child, and one reusable artifact is stored.
 */
export async function reusableChangedDraftJourney(ctx) {
  const {page, name, write, pass} = ctx;
  const {folderId, read, create} = await setup(ctx, "reusable changed draft");
  const ced = page.locator("cedar-embeddable-designer");
  const description = page.getByPlaceholder("Add description...", {exact: true}).first();
  const held = async kind => {
    const listed = await call(ctx.user.auth, "GET", "/folders/" + enc(folderId) + "/contents?limit=100");
    assert.equal(listed.status, 200, listed.text);
    return listed.body.resources.filter(item => item.resourceType === kind).map(item => item["@id"]).sort();
  };
  const parentWith = (kind, label) => {
    const body = artifactBody("template", label);
    const local = artifactBody(kind, "Reused");
    if (kind === "element") insert(local, "Value", artifactBody("field", "Value"));
    insert(body, "Reused", local);
    insert(body, "Sibling", artifactBody("field", "Sibling"));
    return body;
  };
  const embedded = async () => (await ced.evaluate(el => el.currentArtifact)).properties.Reused;
  const saveDraft = panel => panel.getByRole("button", {name: "Save as reusable draft", exact: true});

  // A local child's tab offers storage and nothing else, and opening it writes nothing.
  const plain = await create("template", parentWith("field", name + " local child untouched"));
  const observed = writesOf(page);
  try {
    await open(ctx, plain, folderId);
    const panel = await versionPanel(page, "field");
    await panel.getByText("It is not stored as a reusable artifact.", {exact: true}).waitFor();
    assert.deepEqual((await panel.locator("p.version-note").allTextContents()).map(note => note.trim()),
      ["It is not stored as a reusable artifact."]);
    assert.deepEqual(await actionsOf(panel), ["Save as reusable draft", "Publish as reusable"]);
    assert.equal(await panel.getByRole("alert").count(), 0);
    await untouched(ctx, plain, observed);
  } finally { observed.stop(); }
  await reopensClean(page);
  pass("local-child-untouched", "A local child's Version tab offers only storage, with no failure, no exceptional control and no write");

  for (const kind of ["field", "element"]) for (const fault of ["pending", "lost-reply", "unsent"]) {
    const reusables = collection(kind);
    const before = await held(kind);
    const template = await create("template", parentWith(kind, `${name} ${kind} changed ${fault}`));
    await open(ctx, template, folderId);
    const panel = await versionPanel(page, kind);
    const sent = [];
    let release, arrived, failure;
    const gate = new Promise(resolve => { release = resolve; });
    const dispatched = new Promise(resolve => { arrived = resolve; });
    const target = url => url.origin === resource && url.pathname.startsWith("/" + reusables + "/");
    const intercept = async route => {
      const request = route.request();
      // After a lost reply the readback is refused too, so the outcome stays unknown.
      if (request.method() === "GET" && fault === "lost-reply" && sent.length)
        return route.fulfill({status: 503, json: {message: "Temporary readback outage"}});
      if (request.method() !== "PUT") return route.fallback();
      try {
        const fixture = fixtureAt(request.url());
        assert.equal(fixture?.collection, reusables, "the reusable create names its identity");
        recordFixture(ctx.created, fixture);
        sent.push(fixture.id);
        arrived();
        if (fault === "pending") { await gate; return await route.fallback(); }
        if (fault === "lost-reply") {
          const response = await route.fetch();
          assert.equal(response.status(), 201, await response.text());
        }
      } catch (error) { failure = error; }
      // Whatever happened, the page receives no reply, and the request is never sent a second time.
      return route.abort("failed");
    };
    await page.route(target, intercept);
    try {
      await saveDraft(panel).click();
      if (fault === "pending") {
        await within(dispatched, `the ${kind} reusable create`);
        assert.equal(await saveDraft(panel).isDisabled(), true, "the child's actions wait for the pending save");
        await description.fill(`Edited while the ${kind} save was pending`);
        release();
        await enabled(saveDraft(panel));
      } else {
        await panel.getByRole("alert").waitFor();
        await description.fill(`Edited after the ${kind} save was ${fault === "unsent" ? "unsent" : "lost"}`);
      }
    } finally { release(); await page.unroute(target, intercept); }
    assert.equal(failure, undefined, failure?.stack);
    assert.equal(sent.length, 1, "one create was sent");
    const identity = sent[0];
    const edit = await description.inputValue();
    // The parent changed, so nothing was attached to it, and the child is still the local one.
    assert.equal((await embedded())["pav:derivedFrom"], undefined, "a late result never attaches to a changed parent");
    assert.equal(await page.locator("#state").textContent(), "Modified");
    const stored = fault === "unsent" ? [] : [identity];
    assert.deepEqual(await held(kind), [...before, ...stored].sort(), "the unsettled create stored at most its own identity");

    // Repeating the action settles that identity and attaches it without another artifact.
    const creates = [];
    const count = request => { if (request.method() === "PUT" && target(new URL(request.url()))) creates.push(fixtureAt(request.url())?.id); };
    page.on("request", count);
    try {
      await saveDraft(panel).click();
      await page.waitForFunction(() =>
        !!document.querySelector("cedar-embeddable-designer")?.currentArtifact?.properties?.Reused?.["pav:derivedFrom"]);
    } finally { page.off("request", count); }
    assert.deepEqual(creates, fault === "unsent" ? [identity] : [], "settling never creates under a new identity");
    const child = await embedded();
    assert.equal(child["pav:derivedFrom"], identity);
    assert.notEqual(child["@id"], identity, "a reusable draft stays an editable copy");
    assert.equal(await panel.getByRole("alert").count(), 0);
    assert.equal(await description.inputValue(), edit, "the parent keeps the edit made while the save was unsettled");
    assert.deepEqual(await held(kind), [...before, identity].sort(), "exactly one reusable artifact is stored");
    const reusable = await read(kind, identity);
    assert.deepEqual([reusable["bibo:status"], reusable["schema:name"]], ["bibo:draft", "Reused"]);

    await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    const saved = await read("template", template["@id"]);
    assert.equal(saved["schema:description"], edit);
    assert.equal(saved.properties.Reused["pav:derivedFrom"], identity);
    assert.deepEqual(saved.properties.Sibling, template.properties.Sibling);
    await reopensClean(page);
    assert.equal((await embedded())["pav:derivedFrom"], identity);
    pass(`${kind}-parent-edited-${fault}`, `${kind}: a parent edited while Save as reusable draft is ${fault === "pending" ? "pending" : fault === "unsent" ? "unsent" : "unconfirmed after a lost reply"} keeps its edit, attaches one stored artifact on repetition, and saves and reopens`);
  }
}
