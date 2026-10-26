import {test} from "node:test";
import assert from "node:assert/strict";
import {createAttempt, createdFixture, fixtureAt, keepingListingPreferences} from "./journey-fixtures.mjs";

// Every runner cleans up what a journey created from the fixtures these rules record. A rule that
// misses a create leaks it silently, and one that records an update deletes something it did not make.
const uuid = "0b6c8a52-3c5e-4f0e-9a4b-1d2e3f405162";
const full = `https://repo.metadatacenter.orgx/templates/${uuid}`;
const resource = "https://resource.metadatacenter.orgx";

test("preferences are restored on success and failure, without replacing unrelated profile fields", async t => {
  let account = {uiPreferences: {workspace: {viewMode: "grid", resourceTypes: ["folder"]}, other: "kept"}};
  const original = structuredClone(account), writes = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      writes.push(body);
      account.uiPreferences.workspace = body["uiPreferences.workspace"];
    }
    return new Response(JSON.stringify(account), {status: 200});
  });
  const user = {profile: {"@id": "https://repo.example/users/u1"}};
  for (const failing of [false, true]) {
    const visit = () => keepingListingPreferences(user, async () => {
      account.uiPreferences.workspace = {viewMode: "list"};
      if (failing) throw new Error("journey failure");
      return "result";
    });
    if (failing) await assert.rejects(visit, /journey failure/);
    else assert.equal(await visit(), "result");
    assert.deepEqual(account, original);
  }
  assert.deepEqual(writes, Array(2).fill({"uiPreferences.workspace": original.uiPreferences.workspace}));
});

test("a failed preference restore reports cleanup failure and preserves the journey failure", async t => {
  let workspace = {viewMode: "grid"};
  t.mock.method(globalThis, "fetch", async (_url, options) => options.method === "PUT"
    ? new Response("restore refused", {status: 503})
    : new Response(JSON.stringify({uiPreferences: {workspace}}), {status: 200}));
  const user = {profile: {"@id": "https://repo.example/users/u1"}};
  await assert.rejects(() => keepingListingPreferences(user, async () => {
    workspace = {viewMode: "list"};
    throw new Error("original failure");
  }), /original failure; Workspace preference cleanup failed \(503\)/);
});

test("a create-by-PUT address names its fixture in every form the hosts send", () => {
  assert.deepEqual(fixtureAt(`${resource}/templates/${encodeURIComponent(full)}?folder_id=x`), {collection: "templates", id: full});
  assert.deepEqual(fixtureAt(`${resource}/templates/${uuid}?folder_id=x`), {collection: "templates", id: full});
  assert.deepEqual(fixtureAt(`${resource}/templates/${encodeURIComponent("templates/" + uuid)}`), {collection: "templates", id: full});
  assert.deepEqual(fixtureAt(`${resource}/folders/${uuid}`),
    {collection: "folders", id: `https://repo.metadatacenter.orgx/folders/${uuid}`});
});

test("an address that is not one artifact's identity names no fixture", () => {
  assert.equal(fixtureAt(`${resource}/templates/${uuid}/permissions`), undefined);
  assert.equal(fixtureAt(`${resource}/command/copy-artifact-to-folder`), undefined);
  assert.equal(fixtureAt(`${resource}/template-fields/${encodeURIComponent(full)}`), undefined);
  assert.equal(fixtureAt(`https://elsewhere.test/templates/${uuid}`), undefined);
});

test("only a create is recorded, whether or not its reply was read", () => {
  assert.equal(createdFixture("PUT", `${resource}/templates/${uuid}`, 200, {"@id": full}), undefined);
  assert.deepEqual(createdFixture("PUT", `${resource}/templates/${uuid}`, 201, undefined), {collection: "templates", id: full});
  assert.deepEqual(createdFixture("PUT", `https://elsewhere.test/templates/${uuid}`, 201, {"@id": full}), {collection: "templates", id: full});
  assert.deepEqual(createdFixture("POST", `${resource}/command/publish-create-draft-template/x`, 200, {"@id": full}),
    {collection: "templates", id: full});
  assert.equal(createdFixture("POST", `${resource}/command/copy-artifact-to-folder`, 412, {"@id": full}), undefined);
  assert.equal(createdFixture("POST", `${resource}/groups`, 201, {"@id": `https://repo.metadatacenter.orgx/groups/${uuid}`}), undefined);
});

test("an unconditional PUT to an identity is a create attempt, and nothing else is", () => {
  const request = (method, url, headers = {}) => ({method: () => method, url: () => url, headers: () => headers});
  assert.equal(createAttempt(request("PUT", `${resource}/templates/${uuid}`)), true);
  assert.equal(createAttempt(request("PUT", `${resource}/templates/${uuid}`, {"if-match": '"3"'})), false);
  assert.equal(createAttempt(request("POST", `${resource}/templates`)), false);
});
