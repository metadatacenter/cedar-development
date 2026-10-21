import assert from "node:assert/strict";
import {artifactBody, call, enc, poll, RESOURCE} from "./rest/lib.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";

// The journey acts as the runner's first test user only and never signs in as another account.
export async function reusableSourceFailureJourney({page, designer, user, folderId, name, created, write, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "reusable source failure");
  async function create(kind, collection, label) {
    const result = await call(user.auth, "POST", "/" + collection + "?folder_id=" + enc(folderId), artifactBody(kind, label));
    assert.equal(result.status, 201, result.text);
    created.push({collection, id: result.body["@id"]});
    return result.body;
  }
  const query = name + " import outage";
  const field = await create("field", "template-fields", query + " field");
  const element = await create("element", "template-elements", query + " element");
  const template = await create("template", "templates", query + " parent");
  const path = "/templates/" + enc(template["@id"]);
  const read = async () => {
    const result = await call(user.auth, "GET", path);
    assert.equal(result.status, 200, result.text);
    return result.body;
  };
  const before = await read();
  await page.goto(designer + "/templates/edit/" + enc(template["@id"]));
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  await page.getByPlaceholder("Add description...", {exact: true}).fill("Keep my unsaved description");
  const ced = page.locator("cedar-embeddable-designer");
  const draft = await ced.evaluate(el => el.currentArtifact);
  await page.getByRole("button", {name: "Import fields and elements", exact: true}).first().click();
  const dialog = page.locator("app-child-picker dialog[open]");
  const search = dialog.getByRole("button", {name: "Search", exact: true});
  await dialog.getByRole("searchbox").fill(query);
  // Search indexing is eventual, so repeat the user's search until both fixtures appear. Each
  // attempt counts rows only once the dialog has rendered that search's answer.
  const searchAnswer = response => response.request().method() === "GET" &&
    new URL(response.url()).origin === new URL(RESOURCE).origin && new URL(response.url()).pathname === "/search";
  const listing = await poll(async () => {
    await Promise.all([page.waitForResponse(searchAnswer), search.click()]);
    await dialog.locator('.table-scroll[aria-busy="false"]').waitFor();
    const rows = await Promise.all([element, field].map(source =>
      dialog.getByRole("row", {name: "Select " + source["schema:name"], exact: true}).count()));
    return {done: rows.every(Boolean)};
  }, {tries: 15, delayMs: 1000});
  assert.ok(!listing.timedOut, `the import search never listed both reusable sources in ${listing.attempts} searches`);
  for (const source of [field, element])
    await dialog.getByRole("row", {name: "Select " + source["schema:name"], exact: true}).click();
  const selected = dialog.locator("table").first();
  await selected.getByRole("button", {name: "Remove " + element["schema:name"], exact: true}).waitFor();
  const selection = await selected.innerText();
  const origin = new URL(RESOURCE).origin;
  const searchMatch = url => url.origin === origin && url.pathname === "/search";
  const loadMatch = url => url.origin === origin && url.pathname.startsWith("/template-elements/") &&
    decodeURIComponent(url.pathname.split("/").at(-1)).split("/").at(-1) === element["@id"].split("/").at(-1);
  for (const [operation, mode] of [["search", 503], ["search", "disconnect"], ["load", 503], ["load", 403], ["load", 404], ["load", "disconnect"]]) {
    const matcher = operation === "search" ? searchMatch : loadMatch;
    let hits = 0;
    let responded;
    const intercepted = new Promise(resolve => { responded = resolve; });
    const fail = async route => {
      hits++;
      // Hold the response until the previous failure has cleared, so the next
      // assertion observes this request's error rather than the previous alert.
      await dialog.getByRole("alert").waitFor({state: "hidden"});
      if (mode === "disconnect") await route.abort("failed");
      else await route.fulfill({status: mode, contentType: "application/json", body: "{}"});
      responded();
    };
    await page.route(matcher, fail);
    try {
      await Promise.all([intercepted,
        (operation === "search" ? search : dialog.getByRole("button", {name: "Done", exact: true})).click()]);
      await dialog.getByRole("alert").waitFor();
      assert.ok(hits > 0, "failure must intercept a real browser request");
      assert.ok((await dialog.getByRole("alert").innerText()).trim(), "failure must be explained");
      assert.equal(await selected.innerText(), selection, "selected reusable items survive a failed request");
      assert.equal(await dialog.getByRole("searchbox").inputValue(), query);
      assert.deepEqual(await ced.evaluate(el => el.currentArtifact), draft, "failed batch import must not add even the successful field");
      assert.deepEqual(await read(), before, "import failure must not write the parent");
    } finally {
      await page.unroute(matcher, fail);
    }
    pass(`source-${operation}-${mode}`, `Designer reusable-source ${operation} ${mode} explains failure and retains selected items and the unsaved parent without partial import`);
  }
  await dialog.getByRole("button", {name: "Done", exact: true}).click();
  await dialog.waitFor({state: "hidden"});
  const imported = await ced.evaluate(el => el.currentArtifact);
  assert.equal(imported["schema:description"], "Keep my unsaved description");
  const children = value => Object.values(value.properties).map(child => child.items ?? child)
    .filter(child => [field["@id"], element["@id"]].includes(child["pav:derivedFrom"]));
  assert.equal(children(imported).length, 2, "retry adds each selected definition exactly once");
  for (const child of children(imported)) {
    assert.notEqual(child["@id"], child["pav:derivedFrom"], "a draft import is an independent editable copy");
    assert.equal(child["bibo:status"], "bibo:draft");
  }
  await write(page, "PUT", "/templates/", () => page.locator("#save").click(), 200, true);
  await page.locator("#state").filter({hasText: /^Saved$/}).waitFor();
  const stored = await read();
  assert.equal(stored["schema:description"], "Keep my unsaved description");
  assert.equal(children(stored).length, 2);
  for (const source of [field, element]) {
    const collection = source === field ? "template-fields" : "template-elements";
    assert.deepEqual((await call(user.auth, "GET", "/" + collection + "/" + enc(source["@id"]))).body, source,
      "import and parent save must leave library sources unchanged");
  }
  await page.reload();
  await page.locator("#state").filter({hasText: /^Unmodified$/}).waitFor();
  assert.deepEqual(children(await ced.evaluate(el => el.currentArtifact)), children(stored));
  pass("source-retry", "Designer retries the same selection after reusable-source recovery, imports each definition once, and saves and reopens the retained draft without modifying its sources");
}
