import {test} from "node:test";
import assert from "node:assert/strict";
import {createAttempt, createdFixture, fixtureAt} from "./journey-fixtures.mjs";

// Every runner cleans up what a journey created from the fixtures these rules record. A rule that
// misses a create leaks it silently, and one that records an update deletes something it did not make.
const uuid = "0b6c8a52-3c5e-4f0e-9a4b-1d2e3f405162";
const full = `https://repo.metadatacenter.orgx/templates/${uuid}`;
const resource = "https://resource.metadatacenter.orgx";

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
