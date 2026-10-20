import {journeyFolder, listedIn, listingIdle} from "./journey-fixtures.mjs";
import assert from "node:assert/strict";
import {artifactBody, call, enc, RESOURCE} from "./rest/lib.mjs";

// Refuse one move at the HTTP boundary while allowing the other real server
// moves to finish. Recovery must select only the remaining artifact and
// preserve every stored document. This checks host handling, not authorization enforcement.
//
// Both journeys act as the runner's first test user only and never sign in as another account.
async function groupedMoveJourney({page, base, user, folderId, name, created, pass}, mixed = false) {
  folderId = await journeyFolder({user, folderId, name, created}, mixed ? "mixed move failures" : "partial moves");
  const folder = await call(user.auth, "POST", "/folders", {folderId, name: name + " move target", description: "Temporary move destination"});
  assert.equal(folder.status, 201, folder.text);
  const targetId = folder.body["@id"];
  created.push({collection: "folders", id: targetId});
  const ids = [], original = new Map();
  for (let index = 0; index < (mixed ? 4 : 3); index++) {
    const result = await call(user.auth, "POST", "/template-fields?folder_id=" + enc(folderId),
      artifactBody("field", name + " moving " + index));
    assert.equal(result.status, 201, result.text);
    const id = result.body["@id"];
    ids.push(id); created.push({collection: "template-fields", id});
    original.set(id, (await call(user.auth, "GET", "/template-fields/" + enc(id))).body);
  }
  const row = id => page.locator(`[data-resource-id="${id}"]`);
  await listedIn(page, base, folderId, row(ids.at(-1)), "the move fixtures");
  for (const [index, id] of ids.entries()) {
    await row(id).locator(".resource-icon").click({modifiers: index ? ["ControlOrMeta"] : []});
    await page.waitForFunction(expected => document.querySelectorAll("tr.selected").length === expected, index + 1);
  }
  assert.equal(await page.locator("tr.selected").count(), ids.length);
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
      if (mixed && id === ids[3] && refusing) {
        attempts.push({id, status: 0}); return await route.abort("failed");
      }
      const response = await route.fetch();
      attempts.push({id, status: response.status()});
      if (mixed && id === ids[2] && refusing) return await route.abort("connectionclosed");
      await route.fulfill({response});
    } catch (error) { routeError = error; await route.abort("failed").catch(() => {}); }
  };
  await page.route(matcher, conflict);
  try {
    await drag(ids[0]);
    await page.getByRole("alert").filter({hasText: /Move refused by server/}).waitFor();
    await page.getByText(mixed ? "Moved 1 item." : "Moved 2 items.", {exact: true}).waitFor();
    assert.equal(routeError, undefined);
    assert.equal(attempts.length, ids.length);
    assert.deepEqual(attempts.filter(item => item.status === 403).map(item => item.id), [ids[1]]);
    assert.equal(attempts.filter(item => item.status === 201).length, 2);
    // The source listing has refreshed once the moved rows have left it and it is idle again.
    for (const id of [ids[0], ids[2]]) await row(id).waitFor({state: "detached"});
    await listingIdle(page);
    await row(ids[1]).waitFor();
    assert.equal(await row(ids[1]).evaluate(node => node.classList.contains("selected")), true);
    assert.equal(await page.locator("tr.selected").count(), mixed ? 2 : 1);
    for (const id of ids) {
      const report = await call(user.auth, "GET", "/template-fields/" + enc(id) + "/report");
      assert.equal(report.status, 200);
      assert.equal(report.body.pathInfo.some(parent => parent["@id"] === targetId), id !== ids[1] && id !== ids[3]);
      const stored = await call(user.auth, "GET", "/template-fields/" + enc(id));
      assert.equal(stored.status, 200);
      assert.deepEqual(stored.body, original.get(id));
    }
    pass("partial-outcome", mixed ? "A grouped move survives a permission refusal, a network failure and a lost committed response; fresh listing retains only unmoved selections and all content" : "A refused grouped move reports two real successes, leaves the refused artifact selected and preserves all content");
    refusing = false;
    await drag(ids[1]);
    await page.getByText(mixed ? "Moved 2 items." : "Moved 1 item.", {exact: true}).waitFor();
    assert.deepEqual(attempts.slice(ids.length).map(item=>item.id).sort(), (mixed ? [ids[1],ids[3]] : [ids[1]]).sort());
    assert.equal(attempts.length, mixed ? 6 : 4, "recovery must not repeat successful or uncertain committed moves");
    const report = await call(user.auth, "GET", "/template-fields/" + enc(ids[1]) + "/report");
    assert.equal(report.status, 200);
    assert.ok(report.body.pathInfo.some(parent => parent["@id"] === targetId));
    assert.deepEqual((await call(user.auth, "GET", "/template-fields/" + enc(ids[1]))).body, original.get(ids[1]));
    pass("retry-remaining", "Retrying the remaining selection after refusal clears preserves its content without repeating completed moves");
  } finally { await page.unroute(matcher, conflict); }
}

export const partialMoveJourney = args => groupedMoveJourney(args);
export const mixedMoveJourney = args => groupedMoveJourney(args, true);
