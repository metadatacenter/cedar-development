import assert from "node:assert/strict";
import {actors, call, enc, mutate} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";
import {assertNoRecoveryFiles} from "./recovery-boundary-journey.mjs";
import {
  createNewDraft, designerShows, editAddress, hasNotes, keep, removeUsedField, saveEnabled,
  versionCommand, versionedTemplate, versionsOf, withoutNotes,
} from "./uncertain-create-journey.mjs";

// Designer's Create new draft publishes the template, creates its successor and gives the successor
// the submitted definition. The server does all three or none, and refuses before publishing what a
// later step would refuse. These journeys meet two such refusals from the real server and check that
// nothing was stored: the source is still the draft the author opened, at the same ETag, and has no
// successor. A corrected retry then creates exactly one successor.
//
// partial-version-definition acts as the runner's first test user only. partial-version-draft also
// uses the second test user, by REST token and never in a browser, to own the parent folder and to
// change the first user's grant on it. It writes in the second user's home folder, so it belongs with
// the other two-user journeys.

async function read(user, path, status = 200) {
  const result = await call(user.auth, "GET", path);
  assert.equal(result.status, status, `GET ${path}: ${result.text.slice(0, 600)}`);
  return result;
}

/**
 * Asserts that a refused Create new draft stored nothing: the source is the document that was opened,
 * at the same ETag, with one version, and no draft identity the attempts named exists.
 */
async function nothingStored(user, templateId, opened, draftIds) {
  const source = await read(user, "/templates/" + enc(templateId));
  assert.deepEqual(source.body, opened.body, "the source is still the draft that was opened");
  assert.equal(source.headers.get("etag"), opened.headers.get("etag"), "the source keeps the opened ETag");
  assert.equal(await versionsOf(user, templateId), 1, "the source has no successor");
  for (const id of draftIds) await read(user, "/templates/" + enc(id), 404);
}

/** Asserts that a template has exactly one successor, which holds the edited definition. */
async function oneSuccessor(user, templateId, successorId, description) {
  assert.equal(await versionsOf(user, templateId), 2, "the source has exactly one successor");
  assert.equal((await read(user, "/templates/" + enc(templateId))).body["bibo:status"], "bibo:published");
  const successor = (await read(user, "/templates/" + enc(successorId))).body;
  assert.deepEqual([successor["pav:previousVersion"], successor["bibo:status"], "Notes" in successor.properties],
    [templateId, "bibo:draft", false]);
  if (description) assert.equal(successor["schema:description"], description);
}

const draftIdOf = response => new URL(response.url()).searchParams.get("draft_id");

/**
 * The server's validator refuses the submitted definition. A page-scoped rewrite removes the
 * oslc:modifiedBy declaration every template must carry from what Designer sends, and nothing else.
 * The refusal comes before publication, with the validator's report, which Designer lists. Editing the
 * definition retires those findings, and the retry, without the rewrite, creates one successor.
 */
export async function partialVersionDefinitionJourney(args) {
  const {page, designer, user, created, pass} = args;
  const folderId = await journeyFolder(args, "partial version definition");
  const {templateId} = await versionedTemplate(user, folderId, args.name + " refused definition",
    (collection, id) => keep(created, collection, id));
  const opened = await read(user, "/templates/" + enc(templateId));
  assert.equal(await versionsOf(user, templateId), 1);
  await removeUsedField(page, designer, templateId);
  const editUrl = page.url();
  let draftId, failure;
  const strip = async route => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    try {
      draftId = new URL(request.url()).searchParams.get("draft_id");
      assert.ok(draftId, "Designer names the draft's identity");
      keep(created, "templates", draftId);
      const body = request.postDataJSON();
      assert.ok(body.properties["oslc:modifiedBy"], "Designer sends the oslc:modifiedBy declaration");
      delete body.properties["oslc:modifiedBy"];
      return await route.fallback({postData: JSON.stringify(body)});
    } catch (error) {
      // Answer, so the journey reports this failure rather than waiting for a reply that never comes.
      failure = error;
      return route.fulfill({status: 500, json: {message: String(error)}});
    }
  };
  let refused;
  await page.route(versionCommand, strip);
  try { refused = await createNewDraft(page); } finally { await page.unroute(versionCommand, strip); }
  assert.equal(failure, undefined, failure?.stack);
  assert.equal(refused.status(), 400, await refused.text());
  const report = (await refused.json())?.objects?.validationReport;
  assert.ok(Array.isArray(report?.errors) && report.errors.length > 0, "the refusal carries the validator's report");
  await page.locator("#server-issues").waitFor();
  await page.locator('#message[data-tone="error"]').waitFor();
  // The edit stays, unsaved, at the source's address, and only the server's findings are shown.
  assert.equal(await page.locator("#state").textContent(), "Modified");
  assert.equal(page.url(), editUrl);
  assert.equal(await hasNotes(page), false);
  assert.equal(await page.locator("#save").isDisabled(), true, "Save waits for the findings to be addressed");
  await designerShows(page, "#server-issues");
  await nothingStored(user, templateId, opened, [draftId]);
  pass("definition-rejected", "Designer Create new draft: a definition the server's validator refuses is refused before publication, and nothing is stored");

  const description = "Corrected after the refusal";
  await page.getByPlaceholder("Add description...", {exact: true}).first().fill(description);
  await page.locator("#server-issues").waitFor({state: "hidden"});
  await saveEnabled(page);
  const accepted = await createNewDraft(page);
  assert.equal(accepted.status(), 200, await accepted.text());
  const successorId = (await accepted.json())["@id"];
  assert.equal(successorId, draftIdOf(accepted), "the successor has the identity the request named");
  keep(created, "templates", successorId);
  await page.waitForURL(url => editAddress(url, "templates", successorId));
  await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
  await designerShows(page);
  await oneSuccessor(user, templateId, successorId, description);
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  await designerShows(page);
  await assertNoRecoveryFiles(page);
  assert.equal(await versionsOf(user, templateId), 2);
  pass("definition-corrected", "Designer Create new draft: the corrected definition creates exactly one successor, which reopens with nothing to recover");
}

/**
 * The author owns the template but may no longer create in its folder, where the draft would go. The
 * second user owns that folder and has made the author a viewer of it. The refusal is the real server's
 * 403, before publication, and survives a reload and a restored draft. Recheck access reads the
 * template's own permissions, which the author still holds, so it re-enables Save, and the folder
 * refuses again. Once the second user restores the editor grant, the retry creates one successor.
 */
export async function partialVersionDraftJourney(args) {
  const {page, designer, user, name, pass} = args;
  const {user2} = await actors();
  const parent = await call(user2.auth, "POST", "/folders", {
    folderId: user2.profile.homeFolderId, name: name + " partial version owner folder", description: "Temporary journey fixtures",
  });
  assert.equal(parent.status, 201, parent.text.slice(0, 600));
  const folderId = parent.body["@id"], folderPath = "/folders/" + enc(folderId);
  const grant = role => mutate(user2.auth, "PUT", folderPath + "/permissions", {
    owner: {"@id": user2.profile["@id"]}, userPermissions: [{user: {"@id": user.profile["@id"]}, role}], groupPermissions: [],
  });
  // What the first user creates in the folder is removed here rather than by the runner, which would
  // otherwise meet the folder after the second user deleted it.
  const owned = [];
  const own = (collection, id) => { if (!owned.some(item => item.id === id)) owned.push({collection, id}); };
  let failure;
  try {
    let granted = await grant("editor");
    assert.equal(granted.status, 200, granted.text.slice(0, 600));
    const {templateId, instanceId} = await versionedTemplate(user, folderId, name + " partial version draft", own);
    granted = await grant("viewer");
    assert.equal(granted.status, 200, granted.text.slice(0, 600));
    const opened = await read(user, "/templates/" + enc(templateId));
    assert.equal(await versionsOf(user, templateId), 1);
    await removeUsedField(page, designer, templateId);
    const editUrl = page.url();
    const forbidden = page.locator("#message").filter({hasText: "You do not have permission to save this artifact."});
    const restored = page.locator("#message").filter({hasText: "Access is restored and the stored version is unchanged."});
    const draftIds = [];

    const first = await createNewDraft(page);
    assert.equal(first.status(), 403, await first.text());
    draftIds.push(draftIdOf(first));
    own("templates", draftIdOf(first));
    await forbidden.waitFor();
    await page.locator("#recheck-access").waitFor();
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.equal(page.url(), editUrl);
    assert.equal(await hasNotes(page), false, "the edit stays in the designer");
    await designerShows(page, "#recheck-access", "#sign-in-again", "#reload");
    await nothingStored(user, templateId, opened, draftIds);
    pass("destination-refused", "Designer Create new draft: a parent folder the author may not create in is refused before publication, and nothing is stored");

    await page.reload();
    await page.locator("#draft-offer").waitFor();
    await designerShows(page, "#draft-offer");
    await page.locator("#restore-draft").click();
    await page.locator("#message").filter({hasText: "Your draft has been restored. Use Check save status or Recheck access before saving again."}).waitFor();
    await withoutNotes(page);
    assert.equal(await page.locator("#save").isDisabled(), true);
    await designerShows(page, "#recheck-access", "#sign-in-again", "#reload");
    await nothingStored(user, templateId, opened, draftIds);

    // The author still holds the template's own permissions, so the recheck re-enables Save, and the folder refuses again.
    await page.locator("#recheck-access").click();
    await restored.waitFor();
    await saveEnabled(page);
    await designerShows(page);
    const second = await createNewDraft(page);
    assert.equal(second.status(), 403, await second.text());
    draftIds.push(draftIdOf(second));
    own("templates", draftIdOf(second));
    await forbidden.waitFor();
    await page.locator("#recheck-access").waitFor();
    await designerShows(page, "#recheck-access", "#sign-in-again", "#reload");
    await nothingStored(user, templateId, opened, draftIds);
    pass("refusal-retained", "Designer Create new draft: the refusal survives a reload, a restored draft and an access recheck without a successor");

    granted = await grant("editor");
    assert.equal(granted.status, 200, granted.text.slice(0, 600));
    await page.locator("#recheck-access").click();
    await restored.waitFor();
    await saveEnabled(page);
    await designerShows(page);
    const accepted = await createNewDraft(page);
    assert.equal(accepted.status(), 200, await accepted.text());
    const successorId = (await accepted.json())["@id"];
    assert.equal(successorId, draftIdOf(accepted), "the successor has the identity the request named");
    own("templates", successorId);
    await page.waitForURL(url => editAddress(url, "templates", successorId));
    await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
    await designerShows(page);
    await oneSuccessor(user, templateId, successorId);
    assert.equal((await read(user, "/template-instances/" + enc(instanceId))).body["schema:isBasedOn"], templateId);
    await page.reload();
    await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
    await designerShows(page);
    await assertNoRecoveryFiles(page);
    assert.equal(await versionsOf(user, templateId), 2);
    pass("destination-restored", "Designer Create new draft: once the folder grant returns, the retry creates exactly one successor");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // The first user deletes what it created, which needs its editor grant back. The successor and the
    // instance go before the source, because a template with instances refuses deletion. The folder is
    // the second user's, so the second user deletes it last.
    const problems = [];
    const restoredGrant = await grant("editor");
    if (restoredGrant.status !== 200) problems.push(`${folderPath}/permissions: ${restoredGrant.status}`);
    for (const item of [...owned].reverse()) {
      const removed = await mutate(user.auth, "DELETE", "/" + item.collection + "/" + enc(item.id));
      if (![200, 204, 404].includes(removed.status)) problems.push(`${item.collection}/${item.id}: ${removed.status}`);
    }
    const removed = await mutate(user2.auth, "DELETE", folderPath);
    if (![200, 204, 404].includes(removed.status)) problems.push(`${folderPath}: ${removed.status}`);
    // A failure in the journey itself is the one to report, so cleanup problems are then only logged.
    if (problems.length && failure) console.error("partial-version-draft cleanup: " + problems.join("; "));
    else assert.deepEqual(problems, [], "partial-version-draft cleanup");
  }
}
