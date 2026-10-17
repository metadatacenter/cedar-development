import assert from "node:assert/strict";
import { call, TERMINOLOGY } from "./rest/lib.mjs";
import { editorStatus } from "./metadata-journey-fixtures.mjs";

// Real BioPortal-backed searches have taken 40–80 seconds while still answering successfully.
// Bound this external dependency separately from ordinary 25-second UI operations. The chain's
// measured runtime and overall deadline still expose slow or unavailable service responses.
export const LIVE_SEARCH_TIMEOUT = 90_000;

// Only this page loses terminology search. Recovery uses the real service, and
// artifact writes continue to reach the real resource server throughout.
//
// Both journeys sign nobody in. Each continues on the page the full smoke hands it, as its first
// test user, and depends on what that smoke has put on the page.
function searchRoute(path) {
  return url => url.origin === new URL(TERMINOLOGY).origin && url.pathname.endsWith(path);
}
function outage(mode, hits) {
  return async route => {
    hits.push(route.request().url());
    if (mode === "503") await route.fulfill({status: 503, contentType: "application/json", body: "{}"});
    else await route.abort("failed");
  };
}

// Called with the Disease branch already in the constraint draft. Searching is
// exploratory: failure or recovery must not change what the author has chosen.
export async function designerTerminologyFailureJourney({page, pass}) {
  const picker = page.locator("cedar-embeddable-term-picker");
  const query = picker.getByRole("searchbox", {name: "Find terms", exact: true});
  const constraints = picker.getByRole("region", {name: "Field constraints"});
  const draft = await constraints.innerText();
  const artifact = await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact);
  const matcher = searchRoute("/search");
  for (const mode of ["503", "connection loss"]) {
    const hits = [];
    const fail = outage(mode, hits);
    await page.route(matcher, fail);
    try {
      await query.fill("asthma");
      await picker.locator(".notice").filter({hasText: mode === "503" ? /answered 503/ : /could not be reached/}).waitFor();
      assert.ok(hits.length > 0, "the browser must attempt a terminology request");
      assert.equal(await query.inputValue(), "asthma");
      assert.equal(await constraints.innerText(), draft);
      assert.deepEqual(await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact), artifact);
    } finally {
      await page.unroute(matcher, fail);
    }
    const [response] = await Promise.all([
      page.waitForResponse(r => matcher(new URL(r.url())) && r.request().method() === "POST", { timeout: LIVE_SEARCH_TIMEOUT }),
      query.fill("disease"),
    ]);
    assert.equal(response.status(), 200);
    await picker.getByRole("button", {name: "disease 1 ontology", exact: true}).waitFor();
    assert.equal(await picker.locator(".notice").count(), 0);
    assert.equal(await constraints.innerText(), draft);
    assert.deepEqual(await page.locator("cedar-embeddable-designer").evaluate(el => el.currentArtifact), artifact);
    pass(`designer-${mode}`, `Designer terminology ${mode} explains failure, retains the constraint draft and recovers through a live search`);
  }
}

export async function editorTerminologyFailureJourney({page, user, instancePath, write, pass}) {
  const cee = page.locator("cedar-embeddable-editor");
  const notes = cee.getByLabel("Notes", {exact: false}).first();
  const disease = cee.getByLabel("Disease", {exact: false}).first();
  const originalNotes = await notes.inputValue();
  const matcher = searchRoute("/bioportal/integrated-search");
  for (const mode of ["503", "connection loss"]) {
    const before = await call(user.auth, "GET", instancePath);
    assert.equal(before.status, 200);
    const label = await disease.inputValue();
    const draft = `Notes retained during terminology ${mode}`;
    await notes.fill(draft);
    await editorStatus(page, /^Modified$/).waitFor();
    const metadata = await cee.evaluate(el => el.currentMetadata);
    const hits = [];
    const fail = outage(mode, hits);
    await page.route(matcher, fail);
    try {
      await disease.fill("asthma");
      await page.getByRole("option", {name: "Search failed: the service could not be reached", exact: true}).waitFor();
      assert.ok(hits.length > 0, "the browser must attempt a terminology request");
      assert.equal(await disease.inputValue(), "asthma");
      assert.equal(await notes.inputValue(), draft);
      assert.deepEqual(await cee.evaluate(el => el.currentMetadata), metadata,
        "a failed exploratory search must not replace an already selected term or other input");
      assert.deepEqual((await call(user.auth, "GET", instancePath)).body, before.body);
      await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
      await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
      const stored = await call(user.auth, "GET", instancePath);
      assert.equal(stored.status, 200);
      assert.equal(stored.body.Notes["@value"], draft);
      assert.deepEqual(stored.body.Disease, before.body.Disease,
        "saving other input during the outage must retain the chosen term's identity and label");
    } finally {
      await page.unroute(matcher, fail);
    }
    const [response] = await Promise.all([
      page.waitForResponse(r => matcher(new URL(r.url())) && r.request().method() === "POST", { timeout: LIVE_SEARCH_TIMEOUT }),
      disease.fill("influen"),
    ]);
    assert.equal(response.status(), 200);
    // The live answer replaces the failure notice in the open suggestions. Choosing a term closes them.
    const recovered = page.getByRole("option", {name: label, exact: true});
    await recovered.waitFor();
    assert.equal(await page.locator(".lookup-failed").count(), 0);
    await recovered.click();
    await recovered.waitFor({state: "hidden"});
    assert.equal(await notes.inputValue(), draft);
    assert.deepEqual((await cee.evaluate(el => el.currentMetadata)).Disease, metadata.Disease);
    pass(`editor-${mode}`, `Editor terminology ${mode} explains failure, preserves and saves existing input, and recovers through a live search`);
  }
  // The following navigation journey checks an exact revert to its original
  // Notes value. Restore that saved baseline after exercising outage writes.
  await notes.fill(originalNotes);
  await write(page, "PUT", "/template-instances/", () => page.locator("#button-save-metadata").click(), 200, true);
  await page.locator(".metadata-toolbar [role=status]").filter({hasText: /^Saved$/}).waitFor();
  assert.equal((await call(user.auth, "GET", instancePath)).body.Notes["@value"], originalNotes);
}
