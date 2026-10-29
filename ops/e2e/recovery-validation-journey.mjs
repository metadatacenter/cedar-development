import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";
import {comparable, editorStatus, metadataFixture} from "./metadata-journey-fixtures.mjs";
import {textField} from "./ordinary-editing-journey.mjs";
import {schemaFixture} from "./repeated-schema-journey.mjs";
import {assertNoRecoveryFiles, settled} from "./recovery-boundary-journey.mjs";
import {
  designerShows, editAddress, hasNotes, keep, removeUsedField, saveEnabled, versionCommand, versionedTemplate,
  versionsOf, withoutNotes,
} from "./uncertain-create-journey.mjs";

// Restoring a retained draft must bring back exactly what the author typed, including input that no
// control accepts yet, and must not let a write through before recovery has settled the last one.
// These journeys extend that check to further invalid control shapes, to edits typed while a restored
// draft's save status is checked, to the server's normalization of a committed schema, and to a new
// version whose outcome the check cannot settle. Faults are injected at the browser's request
// boundary. Every write, readback and intervening change is real.
//
// All three journeys act as the runner's first test user only and never sign in as another account.

const resource = new URL(RESOURCE).origin;
const uuid = id => id.split("/").at(-1);
const identifies = (collection, id) => url => url.origin === resource && url.pathname.startsWith("/" + collection + "/") &&
  decodeURIComponent(url.pathname.split("/").at(-1)).split("/").at(-1) === uuid(id);

/** The first field's settings in Designer, opened at the tab named. */
async function fieldTab(page, name) {
  const settings = page.locator("app-field-card").first().locator("app-field-settings");
  const toggle = settings.locator(".settings-toggle");
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await settings.getByRole("tab", {name, exact: true}).click();
  return settings.getByRole("tabpanel", {name, exact: true});
}

/** Reloads and restores the retained draft, which the page offers once it has loaded. */
async function restore(page) {
  await page.reload();
  await page.getByRole("button", {name: "Restore draft", exact: true}).click();
}

/**
 * Invalid input that no control can save is retained exactly through a reload and a restored draft,
 * keeps saving blocked with the control's own explanation, and saves once corrected. Designer meets an
 * inverted text-length range in a template and an incomplete regular expression in an element. The
 * metadata editor meets a malformed IRI in a link field, which its validator calls structural.
 */
export async function restoredControlShapesJourney(args) {
  const {page, write, pass} = args;
  for (const [kind, shape] of [["template", "length"], ["element", "regex"]]) {
    const f = await schemaFixture(args, kind, "restored " + shape);
    const before = await f.read();
    await page.goto(f.url);
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    const message = shape === "length"
      ? "Text lengths must be nonnegative numbers, with minimum no greater than maximum."
      : "The regular expression is incomplete or invalid. Check its brackets, parentheses and escape characters, or clear it to remove the pattern constraint.";
    const typed = shape === "length" ? {"Minimum length": "8", "Maximum length": "3"} : {"Regular expression": "([a-z"};
    let panel = await fieldTab(page, "Constraints");
    for (const [label, value] of Object.entries(typed)) await panel.getByLabel(label, {exact: true}).fill(value);
    await panel.getByRole("alert").filter({hasText: message}).waitFor();
    await page.locator("#state").filter({hasText: /^Modified$/}).waitFor();
    assert.equal(await page.locator("#save").isDisabled(), true);
    await designerShows(page);

    await restore(page);
    panel = await fieldTab(page, "Constraints");
    for (const [label, value] of Object.entries(typed)) await settled(panel.getByLabel(label, {exact: true}), value);
    await panel.getByRole("alert").filter({hasText: message}).waitFor();
    assert.equal(await page.locator("#save").isDisabled(), true, "the restored invalid input keeps saving blocked");
    await designerShows(page);
    await assertNoRecoveryFiles(page);
    assert.deepEqual(await f.read(), before, "restoration writes nothing");

    const corrected = shape === "length" ? {"Maximum length": "12"} : {"Regular expression": "^([a-z]+)$"};
    for (const [label, value] of Object.entries(corrected)) await panel.getByLabel(label, {exact: true}).fill(value);
    await panel.getByRole("alert").waitFor({state: "detached"});
    await saveEnabled(page);
    await write(page, "PUT", "/" + f.collection + "/", () => page.locator("#save").click(), 200, true);
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    const after = await f.read();
    const constraints = after.properties.Notes._valueConstraints;
    if (shape === "length") assert.deepEqual([constraints.minLength, constraints.maxLength], [8, 12]);
    else assert.equal(constraints.regex, "^([a-z]+)$");
    assert.deepEqual(after.properties.Keep, before.properties.Keep);
    await page.reload();
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    await designerShows(page);
    panel = await fieldTab(page, "Constraints");
    if (shape === "length") assert.equal(await panel.getByLabel("Maximum length", {exact: true}).inputValue(), "12");
    else assert.equal(await panel.getByLabel("Regular expression", {exact: true}).inputValue(), "^([a-z]+)$");
    pass(`${kind}-${shape === "length" ? "text-length-range" : "incomplete-regex"}`,
      `Designer ${kind}: ${shape === "length" ? "an inverted text-length range" : "an incomplete regular expression"} survives reload and restoration exactly, keeps saving blocked with its explanation, and saves and reopens once corrected`);
  }

  const link = textField("Reference", "link");
  link.properties = {"@type": link.properties["@type"], "@id": {type: "string", format: "uri"}, "rdfs:label": {type: ["string", "null"]}};
  delete link.required;
  const f = await metadataFixture(args, "restored malformed IRI", {Reference: link, Keep: textField("Keep")},
    {Reference: {"@id": "https://example.org/opened"}, Keep: {"@value": "Untouched"}});
  const before = (await f.read()).body;
  await page.goto(f.url);
  await editorStatus(page, /^Unmodified$/).waitFor();
  const reference = page.locator("cedar-embeddable-editor").getByLabel("Reference", {exact: true});
  const save = page.locator("#button-save-metadata");
  const malformed = async () => {
    const report = await page.evaluate(() => document.querySelector("cedar-embeddable-editor").dataQualityReport);
    assert.equal(report.canSave, false);
    assert.ok(report.problems.some(problem => problem.code === "iriMalformed" && problem.category === "structural" &&
      problem.path.join("/") === "Reference"), JSON.stringify(report.problems));
  };
  await reference.fill("not an address");
  await editorStatus(page, /^Modified$/).waitFor();
  assert.equal(await save.isDisabled(), true);
  await malformed();
  await restore(page);
  await settled(reference, "not an address");
  assert.equal(await save.isDisabled(), true, "the restored malformed IRI keeps saving blocked");
  await malformed();
  await assertNoRecoveryFiles(page);
  assert.deepEqual((await f.read()).body, before, "restoration writes nothing");
  await reference.fill("https://example.org/corrected");
  await saveEnabled(page, "#button-save-metadata");
  await write(page, "PUT", "/template-instances/", () => save.click(), 200, true);
  await editorStatus(page, /^Saved$/).waitFor();
  const expected = structuredClone(before);
  expected.Reference["@id"] = "https://example.org/corrected";
  assert.deepEqual(comparable((await f.read()).body), comparable(expected));
  await page.reload();
  await editorStatus(page, /^Unmodified$/).waitFor();
  await settled(reference, "https://example.org/corrected");
  pass("metadata-malformed-iri", "Editor: a malformed IRI in a link field survives reload and restoration exactly, keeps saving blocked as structurally invalid, and saves and reopens once corrected");
}

/**
 * A committed save loses its reply, the page reloads and the draft is restored. While the restored
 * draft's save status is being checked, the author types more. The check adopts the stored revision
 * and keeps the newer input, and the next conditional save stores it. In templates and elements the
 * lost save added a field, which the server stamps with creation and update provenance it did not
 * receive; the check must recognize that normalization as the server's and not as a different write.
 * In the metadata editor the lost save added a repeated entry, whose identity the server minted, and
 * the next save keeps that identity.
 */
export async function restoredNewerEditsJourney(args) {
  const {page, base, designer, user, name, created, write, pass} = args;
  const folderId = await journeyFolder(args, "restored newer edits");
  const create = async (collection, body) => {
    const made = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), body);
    assert.equal(made.status, 201, made.text);
    created.push({collection, id: made.body["@id"]});
    return made.body["@id"];
  };
  const place = (parent, key, child, repeated = false) => {
    parent.properties[key] = repeated ? {type: "array", minItems: 0, items: child} : child;
    parent.properties["@context"].properties[key] = {enum: ["https://example.org/restored-edits/" + key]};
    parent._ui.order.push(key); parent._ui.propertyLabels[key] = key;
  };
  for (const kind of ["template", "element", "field", "metadata"]) {
    const metadata = kind === "metadata", schema = kind === "template" || kind === "element";
    const collection = metadata ? "template-instances" : {template: "templates", element: "template-elements", field: "template-fields"}[kind];
    let id;
    if (metadata) {
      const template = artifactBody("template", name + " restored edits template");
      const visits = artifactBody("element", "Visits");
      place(visits, "Detail", artifactBody("field", "Detail"));
      place(template, "Visits", visits, true); place(template, "Notes", artifactBody("field", "Notes")); place(template, "Keep", artifactBody("field", "Keep"));
      const templateId = await create("templates", template);
      const record = artifactBody("instance", name + " restored edits", {"schema:isBasedOn": templateId,
        Notes: {"@value": "Opened"}, Keep: {"@value": "Untouched"},
        Visits: [{"@id": null, "@context": {Detail: "https://example.org/restored-edits/Detail"}, Detail: {"@value": "Original visit"}}]});
      for (const key of ["Visits", "Notes", "Keep"]) record["@context"][key] = "https://example.org/restored-edits/" + key;
      record["@context"]["pav:derivedFrom"] = {"@type": "@id"};
      id = await create(collection, record);
    } else {
      const body = artifactBody(kind, name + " restored edits " + kind);
      if (schema) place(body, "Keep", artifactBody("field", "Keep"));
      id = await create(collection, body);
    }
    const path = "/" + collection + "/" + enc(id);
    const read = async () => { const result = await call(user.auth, "GET", path); assert.equal(result.status, 200, result.text); return result.body; };
    const before = await read();
    await page.goto((metadata ? base + "/instances/edit/" : designer + "/" + kind + "s/edit/") + enc(id));
    const status = text => metadata ? editorStatus(page, text) : page.locator("#state").filter({hasText: text});
    const cee = page.locator("cedar-embeddable-editor");
    const input = () => metadata ? cee.getByLabel("Notes", {exact: true})
      : page.getByPlaceholder(kind === "field" ? "Field description" : "Add description...", {exact: true}).first();
    const presentation = async () => { if (kind === "field") await page.getByRole("tab", {name: "Presentation", exact: true}).click(); };
    await status(/^Unmodified$/).waitFor();
    await presentation();
    await input().fill("Submitted before the outage");
    if (schema) {
      await page.getByRole("button", {name: /^Add field$/}).last().click();
      await page.locator("app-field-type-picker").getByRole("button", {name: "Text", exact: true}).click();
      await page.getByRole("textbox", {name: "Enter field name", exact: true}).nth(1).fill("Added");
    }
    if (metadata) {
      await cee.getByRole("button", {name: "Add empty instance here", exact: true}).click();
      await cee.getByLabel("Detail", {exact: true}).fill("New visit");
    }
    const save = page.locator(metadata ? "#button-save-metadata" : "#save");
    const check = page.getByRole("button", {name: "Check save status", exact: true});
    const matcher = identifies(collection, id);
    let submitted, failure;
    const lose = async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      try {
        submitted = route.request().postDataJSON();
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
      } catch (error) { failure = error; }
      return route.abort("failed");
    };
    await page.route(matcher, lose);
    try {
      await saveEnabled(page, metadata ? "#button-save-metadata" : "#save");
      await save.click();
      await check.waitFor();
    } finally { await page.unroute(matcher, lose); }
    assert.equal(failure, undefined, failure?.stack);
    const committed = await read();
    if (schema) {
      // The server stamped the new field with provenance the Designer sent as null.
      const added = committed.properties.Added;
      assert.ok(added, "the lost save stored the new field");
      assert.equal(added["@id"], submitted.properties.Added["@id"], "the new field keeps the identity the Designer minted");
      for (const key of ["pav:createdOn", "pav:createdBy", "pav:lastUpdatedOn", "oslc:modifiedBy"]) {
        assert.equal(submitted.properties.Added[key], null, `the Designer sends ${key} empty`);
        assert.ok(added[key], `the server assigns ${key}`);
      }
    }
    if (metadata) assert.equal(committed.Visits.length, 2);

    await restore(page);
    await presentation();
    await settled(input(), "Submitted before the outage");
    assert.equal(await save.isDisabled(), true, "a restored unsettled save waits for its status check");
    // An unconfirmed update requires a reload or a status check before Designer saves again.
    if (!metadata) await designerShows(page, "#check-save", "#reload");
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const hold = async route => { if (route.request().method() !== "GET") return route.fallback(); await gate; return route.fallback(); };
    await page.route(matcher, hold);
    try {
      await check.click();
      await page.getByText("Checking save status…", {exact: false}).waitFor();
      await input().fill("Typed while the status was checked");
      release();
      await check.waitFor({state: "hidden"});
    } finally { release(); await page.unroute(matcher, hold); }
    if (!metadata) await page.locator("#message").filter({hasText: "The stored version matches your submitted changes. Your current edits have been kept."}).waitFor();
    assert.equal(await input().inputValue(), "Typed while the status was checked");
    await status(/^Modified$/).waitFor();
    await saveEnabled(page, metadata ? "#button-save-metadata" : "#save");
    if (!metadata) await designerShows(page);
    assert.deepEqual(await read(), committed, "checking writes nothing");

    await write(page, "PUT", "/" + collection + "/", () => save.click(), 200, true);
    await status(/^Saved$/).waitFor();
    const after = await read();
    if (metadata) {
      assert.equal(after.Notes["@value"], "Typed while the status was checked");
      assert.deepEqual(after.Keep, before.Keep);
      assert.deepEqual(after.Visits.map(visit => visit["@id"]), committed.Visits.map(visit => visit["@id"]),
        "the next save keeps the entry identities the lost save minted");
      assert.equal(after.Visits[1].Detail["@value"], "New visit");
    } else {
      assert.equal(after["schema:description"], "Typed while the status was checked");
      if (schema) {
        assert.equal(after.properties.Added["@id"], committed.properties.Added["@id"]);
        assert.deepEqual(after.properties.Keep, before.properties.Keep);
        assert.deepEqual(after._ui.order, ["Keep", "Added"]);
      }
    }
    await page.reload();
    await status(/^Unmodified$/).waitFor();
    await presentation();
    await settled(input(), "Typed while the status was checked");
    for (const control of ["Restore draft", "Check save status"])
      assert.equal(await page.getByRole("button", {name: control, exact: true}).count(), 0, `${control} shown after a clean reopen`);
    if (!metadata) await designerShows(page);
    pass(`newer-edits-${kind}`, schema
      ? `${kind}: a restored draft whose lost save added a field settles through a status check despite the server's provenance stamps, keeps input typed during the check, and saves and reopens`
      : `${kind}: a restored draft's status check keeps input typed while it runs${metadata ? " and the entry identities the lost save minted" : ""}, and the next save stores and reopens it`);
  }
}

/**
 * A new version whose reply was lost cannot be discarded until its outcome is known, because the
 * retained draft may hold the only record of that write. Once restored, the status check settles a
 * committed version. When another client has changed what the check reads, the outcome cannot be
 * settled. The check then keeps the edit and the save guard, sends no version command and adopts
 * nothing. The
 * changes are a real edit of the new draft after a committed version, and a real publication of the
 * source after an uncommitted one.
 */
export async function unresolvedVersionJourney(args) {
  const {page, designer, user, created, pass} = args;
  const folderId = await journeyFolder(args, "unresolved version");
  const read = async (path, status = 200) => {
    const result = await call(user.auth, "GET", path);
    assert.equal(result.status, status, `GET ${path}: ${result.text.slice(0, 600)}`);
    return result;
  };
  for (const outcome of ["discard-refused", "changed-draft", "published-source"]) {
    const committed = outcome !== "published-source";
    const {templateId} = await versionedTemplate(user, folderId, `${args.name} unresolved ${outcome}`,
      (collection, id) => keep(created, collection, id));
    const sourcePath = "/templates/" + enc(templateId);
    const sent = [];
    const count = request => {
      if (request.method() === "POST" && versionCommand(new URL(request.url())))
        sent.push(new URL(request.url()).searchParams.get("draft_id"));
    };
    page.on("request", count);
    try {
      await removeUsedField(page, designer, templateId);
      let draftId, failure;
      const lose = async route => {
        if (draftId || route.request().method() !== "POST") return route.fallback();
        try {
          draftId = new URL(route.request().url()).searchParams.get("draft_id");
          keep(created, "templates", draftId);
          if (committed) {
            const response = await route.fetch();
            assert.equal(response.status(), 200, await response.text());
          }
        } catch (error) { failure = error; }
        return route.abort("failed");
      };
      await page.route(versionCommand, lose);
      try {
        await page.locator("#save").click();
        const dialog = page.locator("#version-dialog");
        await dialog.waitFor();
        await dialog.getByRole("button", {name: "Create new draft", exact: true}).click();
        await page.locator("#message").filter({hasText: "could not confirm whether"}).waitFor();
      } finally { await page.unroute(versionCommand, lose); }
      assert.equal(failure, undefined, failure?.stack);
      const draftPath = "/templates/" + enc(draftId);

      // Discarding the reloaded draft is refused while the version is unsettled, and keeps the offer.
      await page.reload();
      await page.locator("#draft-offer").waitFor();
      await page.waitForFunction(() => document.querySelector("#restore-draft")?.disabled === false);
      await page.locator("#discard-draft").click();
      await page.locator("#message").filter({hasText: "The previous create or version operation is unresolved. Restore the draft and use Check save status before discarding it."}).waitFor();
      await designerShows(page, "#draft-offer");
      assert.ok(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("cedar.designer.draft:"))),
        "the refused discard keeps the retained draft");

      if (outcome === "changed-draft") {
        const draft = await read(draftPath);
        const changed = await call(user.auth, "PUT", draftPath, {...draft.body, "schema:description": "Changed by another client"},
          {headers: {"If-Match": draft.headers.get("etag")}});
        assert.equal(changed.status, 200, changed.text.slice(0, 600));
      }
      if (outcome === "published-source") {
        const published = await call(user.auth, "POST", "/command/publish-artifact", {"@id": templateId, newVersion: "0.0.1"});
        assert.equal(published.status, 200, published.text.slice(0, 600));
      }
      const sourceBefore = await read(sourcePath);
      const draftBefore = committed ? (await read(draftPath)).body : (await read(draftPath, 404), null);

      await page.locator("#restore-draft").click();
      await withoutNotes(page);
      await designerShows(page, "#check-save");
      await page.locator("#check-save").click();
      if (outcome === "discard-refused") {
        await page.locator("#message").filter({hasText: "The stored version matches your submitted changes"}).waitFor();
        await page.waitForURL(url => editAddress(url, "templates", draftId));
        await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
        await designerShows(page);
        assert.equal(await versionsOf(user, templateId), 2, "the settled version has exactly one successor");
        await page.reload();
        await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
        await designerShows(page);
        await assertNoRecoveryFiles(page);
      } else {
        await page.locator("#message").filter({hasText: "The stored version could not be reconciled with your save. Your edits have been kept; saving remains blocked."}).waitFor();
        await page.locator("#state").filter({hasText: /^Reload required$/}).waitFor();
        assert.equal(await page.locator("#save").isDisabled(), true, "an unresolved version keeps saving blocked");
        assert.equal(await hasNotes(page), false, "the edit stays in the designer");
        assert.ok(editAddress(new URL(page.url()), "templates", templateId), "the designer stays on the source");
        await designerShows(page, "#check-save");
        const source = await read(sourcePath);
        assert.deepEqual([source.body, source.headers.get("etag")], [sourceBefore.body, sourceBefore.headers.get("etag")],
          "the check leaves the source as the other client left it");
        if (committed) assert.deepEqual((await read(draftPath)).body, draftBefore, "the check leaves the changed draft alone");
        else await read(draftPath, 404);
        assert.equal(await versionsOf(user, templateId), committed ? 2 : 1, "nothing creates a second successor");
      }
      assert.deepEqual(sent, [draftId], "neither restoration nor the check sends the version again");
    } finally { page.off("request", count); }
    pass(outcome, outcome === "discard-refused"
      ? "Designer Create new draft: a restored draft whose version reply was lost cannot be discarded until checked, and the check then settles one successor"
      : `Designer Create new draft: a check that finds ${outcome === "changed-draft" ? "the committed draft changed by another client" : "the uncommitted source published by another client"} keeps the edit and the save guard, adopts nothing and sends no version`);
  }
}
