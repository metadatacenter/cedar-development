import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";

// Refuse one move at the HTTP boundary while allowing the other real server
// moves to finish. Recovery must select only the remaining artifact and
// preserve every stored document. This checks host handling, not authorization enforcement.
export async function partialMoveJourney({page, base, user, folderId, name, created, pass}) {
  const folder = await call(user.auth, "POST", "/folders", {folderId, name: name + " move target", description: "Temporary move destination"});
  assert.equal(folder.status, 201, folder.text);
  const targetId = folder.body["@id"];
  created.push({collection: "folders", id: targetId});
  const ids = [], original = new Map();
  for (let index = 0; index < 3; index++) {
    const result = await call(user.auth, "POST", "/template-fields?folder_id=" + enc(folderId),
      artifactBody("field", name + " moving " + index));
    assert.equal(result.status, 201, result.text);
    const id = result.body["@id"];
    ids.push(id); created.push({collection: "template-fields", id});
    original.set(id, (await call(user.auth, "GET", "/template-fields/" + enc(id))).body);
  }
  const row = id => page.locator(`[data-resource-id="${id}"]`);
  for (let attempt = 0; ; attempt++) {
    await page.goto(base + "/dashboard?folderId=" + enc(folderId));
    await page.getByRole("button", {name: "New", exact: true}).waitFor();
    const list = page.getByRole("button", {name: "List view", exact: true});
    if (await list.count()) await list.click();
    await page.waitForFunction(() => document.querySelector(".table-scroll")?.getAttribute("aria-busy") === "false");
    if (await row(ids[2]).waitFor({timeout: 1000}).then(() => true, () => false)) break;
    assert.ok(attempt < 15, "move fixtures not listed");
  }
  for (const [index, id] of ids.entries()) {
    await row(id).locator(".resource-icon").click({modifiers: index ? ["ControlOrMeta"] : []});
    await page.waitForFunction(expected => document.querySelectorAll("tr.selected").length === expected, index + 1);
  }
  assert.equal(await page.locator("tr.selected").count(), 3);
  async function drag(id) {
    await row(id).scrollIntoViewIfNeeded();
    const source = await row(id).locator(".resource-icon").boundingBox();
    const destination = await row(targetId).boundingBox();
    assert.ok(source && destination);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2 + 10, {steps: 3});
    await page.mouse.move(destination.x + 50, destination.y + destination.height / 2, {steps: 12});
    await page.locator("body.explorer-can-drop").waitFor();
    await page.mouse.up();
  }
  const attempts = [];
  let refusing = true, routeError;
  const matcher = url => url.origin === new URL(RESOURCE).origin && url.pathname === "/command/move-resource-to-folder";
  const conflict = async route => {
    try {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const id = ids.find(candidate => candidate.split("/").at(-1) === request.postDataJSON()["@id"].split("/").at(-1));
      assert.ok(id, "only this journey's artifacts may be moved");
      assert.ok(request.headers()["if-match"]);
      if (id === ids[1] && refusing) {
        attempts.push({id, status: 403});
        return await route.fulfill({status: 403, contentType: "application/json",
          body: JSON.stringify({message: "Move refused by server"})});
      }
      const response = await route.fetch();
      attempts.push({id, status: response.status()});
      await route.fulfill({response});
    } catch (error) { routeError = error; await route.abort("failed").catch(() => {}); }
  };
  await page.route(matcher, conflict);
  try {
    await drag(ids[0]);
    await page.getByRole("alert").filter({hasText: /Move refused by server/}).waitFor();
    await page.getByText("Moved 2 items.", {exact: true}).waitFor();
    assert.equal(routeError, undefined);
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.filter(item => item.status === 403).map(item => item.id), [ids[1]]);
    assert.equal(attempts.filter(item => item.status === 201).length, 2);
    await row(ids[1]).waitFor();
    assert.equal(await row(ids[1]).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("tr.selected").count(), 1);
    for (const id of ids) {
      const report = await call(user.auth, "GET", "/template-fields/" + enc(id) + "/report");
      assert.equal(report.status, 200);
      assert.equal(report.body.pathInfo.some(parent => parent["@id"] === targetId), id !== ids[1]);
      const stored = await call(user.auth, "GET", "/template-fields/" + enc(id));
      assert.equal(stored.status, 200);
      assert.deepEqual(stored.body, original.get(id));
    }
    pass("A refused grouped move reports two real successes, leaves the refused artifact selected and preserves all content");
    refusing = false;
    await drag(ids[1]);
    await page.getByText("Moved 1 item.", {exact: true}).waitFor();
    assert.deepEqual(attempts.at(-1), {id: ids[1], status: 201});
    assert.equal(attempts.length, 4, "recovery must not repeat successful moves");
    const report = await call(user.auth, "GET", "/template-fields/" + enc(ids[1]) + "/report");
    assert.equal(report.status, 200);
    assert.ok(report.body.pathInfo.some(parent => parent["@id"] === targetId));
    assert.deepEqual((await call(user.auth, "GET", "/template-fields/" + enc(ids[1]))).body, original.get(ids[1]));
    pass("Retrying the remaining selection after refusal clears preserves its content without repeating completed moves");
  } finally { await page.unroute(matcher, conflict); }
}
