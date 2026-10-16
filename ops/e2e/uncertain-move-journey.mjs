import {journeyFolder} from "./journey-fixtures.mjs";
import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";

// Commit a move at the real server, then lose only its response. Confirmed
// progress must remain accurate and a fresh listing must prevent a blind retry.
export async function uncertainMoveJourney({page, base, user, folderId, name, created, pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "uncertain moves");
  const target = await call(user.auth, "POST", "/folders", {
    folderId, name: name + " uncertain move target", description: "Temporary journey destination",
  });
  assert.equal(target.status, 201, target.text);
  const targetId = target.body["@id"];
  created.push({collection: "folders", id: targetId});
  const ids = [], before = new Map();
  for (let index = 0; index < 3; index++) {
    const result = await call(user.auth, "POST", "/template-fields?folder_id=" + enc(folderId),
      artifactBody("field", name + " uncertain move " + index));
    assert.equal(result.status, 201, result.text);
    const id = result.body["@id"];
    ids.push(id);
    created.push({collection: "template-fields", id});
    before.set(id, (await call(user.auth, "GET", "/template-fields/" + enc(id))).body);
  }
  const row = id => page.locator(`[data-resource-id="${id}"]`);
  async function openFolder(id) {
    await page.goto(base + "/dashboard?folderId=" + enc(id));
    await page.getByRole("button", {name: "New", exact: true}).waitFor();
    await page.getByRole("button", {name: "List view", exact: true}).click();
    await page.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");
  }
  for (let attempt = 0; ; attempt++) {
    await openFolder(folderId);
    if (await row(ids[2]).waitFor({timeout: 1000}).then(() => true, () => false)) break;
    assert.ok(attempt < 15, "move fixtures not listed");
  }
  for (const [index, id] of ids.entries()) {
    await row(id).locator(".resource-icon").click({modifiers: index ? ["ControlOrMeta"] : []});
    await page.waitForFunction(expected => document.querySelectorAll("tr.selected").length === expected, index + 1);
  }
  const attempts = [];
  let routeError;
  const matcher = url => url.origin === new URL(RESOURCE).origin && url.pathname === "/command/move-resource-to-folder";
  const loseResponse = async route => {
    try {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const id = ids.find(candidate => candidate.split("/").at(-1) === request.postDataJSON()["@id"].split("/").at(-1));
      assert.ok(id, "only this journey's artifacts may be moved");
      assert.ok(request.headers()["if-match"]);
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      attempts.push(id);
      if (id === ids[1]) return await route.abort("connectionclosed");
      await route.fulfill({response});
    } catch (error) { routeError = error; await route.abort("failed").catch(() => {}); }
  };
  await page.route(matcher, loseResponse);
  try {
    const source = await row(ids[0]).locator(".resource-icon").boundingBox();
    const destination = await row(targetId).boundingBox();
    assert.ok(source && destination);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2 + 10, {steps: 3});
    await page.mouse.move(destination.x + 50, destination.y + destination.height / 2, {steps: 12});
    await page.locator("body.explorer-can-drop").waitFor();
    await page.mouse.up();
    await page.getByRole("alert").waitFor();
    await page.getByText("Moved 2 items.", {exact: true}).waitFor();
    assert.equal(routeError, undefined);
    assert.deepEqual([...attempts].sort(), [...ids].sort(), "each item is submitted once, including the response that was lost");
    for (const id of ids) await row(id).waitFor({state: "detached"});
    assert.equal(await page.locator("tr.selected").count(), 0, "the refreshed source must not offer the moved item for retry");
    for (const id of ids) {
      const report = await call(user.auth, "GET", "/template-fields/" + enc(id) + "/report");
      assert.equal(report.status, 200, report.text);
      assert.ok(report.body.pathInfo.some(parent => parent["@id"] === targetId));
      const stored = await call(user.auth, "GET", "/template-fields/" + enc(id));
      assert.equal(stored.status, 200, stored.text);
      assert.deepEqual(stored.body, before.get(id));
    }
    await openFolder(targetId);
    for (const id of ids) await row(id).waitFor();
    assert.equal(attempts.length, 3, "opening the destination must not replay a move");
    pass("A lost grouped-move response reports only confirmed progress, refreshes away already-moved selections and reopens all intact artifacts in the destination without replaying writes");
  } finally { await page.unroute(matcher, loseResponse); }
}
