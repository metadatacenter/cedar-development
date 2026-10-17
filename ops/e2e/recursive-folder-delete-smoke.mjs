// Real-stack verification of the recursive delete contract. Only resources minted by this run
// are deleted; cleanup uses each resource's creating user and current revision.
import assert from 'node:assert/strict';
import { actors, call, mutate, artifactBody, enc, RUN } from './rest/lib.mjs';
const { user1, user2 } = await actors();
const created = [];
async function expectStatus(response, status) {
  assert.equal(response.status, status, response.text);
  return response;
}
// A refusal answers the shared error body. A refused confirmation reports its outcome in objects.outcome.
async function expectRefusal(response, status, errorKey) {
  await expectStatus(response, status);
  assert.equal(response.body?.statusCode, status, response.text);
  assert.equal(response.body?.errorKey ?? null, errorKey, response.text);
  return response.body;
}
async function expectRefusedOutcome(response, status, errorKey) {
  const outcome = (await expectRefusal(response, 409, errorKey)).objects?.outcome;
  assert.equal(outcome?.status, status, response.text);
  assert.equal(Object.values(outcome.deleted).reduce((sum, n) => sum + n, 0), 0, 'a refused confirmation deletes nothing');
  return outcome;
}
async function folder(user, parent, suffix) {
  const response = await expectStatus(await call(user.auth, 'POST', '/folders', {
    folderId: parent, name: `Recursive delete ${suffix} ${RUN}`, description: 'Recursive deletion smoke fixture',
  }), 201);
  const id = response.body['@id'];
  created.push({auth: user.auth, path: `/folders/${enc(id)}`});
  return id;
}
async function artifact(user, type, collection, parent, extra = {}) {
  const response = await expectStatus(await call(user.auth, 'POST', `${collection}?folder_id=${enc(parent)}`,
    artifactBody(type, `Recursive ${type} ${RUN}`, extra)), 201);
  const id = response.body['@id'];
  created.push({auth: user.auth, path: `${collection}/${enc(id)}`});
  return id;
}
async function grant(user, path, role) {
  await expectStatus(await mutate(user.auth, 'PUT', path + '/permissions', {
    userPermissions: [{user: {'@id': user2.profile['@id']}, role}], groupPermissions: [],
  }), 200);
}
try {
  const root = await folder(user1, user1.profile.homeFolderId, 'root');
  const nested = await folder(user1, root, 'nested');
  const template = await artifact(user1, 'template', '/templates', root);
  await artifact(user1, 'element', '/template-elements', nested);
  await artifact(user1, 'field', '/template-fields', nested);
  const instance = await artifact(user1, 'instance', '/template-instances', nested, {'schema:isBasedOn': template});
  await grant(user1, `/templates/${enc(template)}`, 'viewer');
  const outside = await artifact(user2, 'instance', '/template-instances', user2.profile.homeFolderId, {'schema:isBasedOn': template});
  await grant(user1, `/folders/${enc(root)}`, 'editor');
  const hidden = await folder(user2, root, 'other owner child');
  const endpoint = `/folders/${enc(root)}/deletion`;
  const denied = (await expectStatus(await call(user1.auth, 'GET', endpoint), 200)).body;
  assert.equal(denied.allowed, false);
  assert.equal(denied.restrictedItems, 0);
  assert.equal(denied.templatesWithInstances, 1);
  assert.equal(denied.templatesWithOutsideInstances, 1);
  assert.equal(denied.instancesOutside, 1);
  await grant(user1, `/folders/${enc(root)}`, 'viewer');
  await expectRefusal(await call(user2.auth, 'GET', endpoint), 403, 'folderCanNotBeDeleted');
  await expectRefusal(await call(user2.auth, 'POST', endpoint, {token: denied.token}), 403, 'folderCanNotBeDeleted');
  assert.equal(JSON.stringify(denied).includes(outside), false, 'outside instance identity is private');
  await expectRefusedOutcome(await call(user1.auth, 'POST', endpoint, {token: denied.token}), 'blocked', 'folderCanNotBeDeleted');
  await expectStatus(await call(user1.auth, 'GET', `/template-instances/${enc(instance)}`), 200);
  console.log('PASS: only the root owner may delete recursively; outside instances block deletion without leaking identities');

  await expectStatus(await mutate(user2.auth, 'DELETE', `/template-instances/${enc(outside)}`), 204);
  const eligible = (await expectStatus(await call(user1.auth, 'GET', endpoint), 200)).body;
  assert.equal(eligible.allowed, true);
  assert.deepEqual(eligible.counts, {folder: 3, template: 1, element: 1, field: 1, instance: 1});
  await folder(user1, root, 'added after confirmation');
  await expectRefusedOutcome(await call(user1.auth, 'POST', endpoint, {token: eligible.token}), 'changed', null);
  await expectStatus(await call(user1.auth, 'GET', `/template-instances/${enc(instance)}`), 200);
  console.log('PASS: a changed tree invalidates confirmation before deleting any item');

  const fresh = (await expectStatus(await call(user1.auth, 'GET', endpoint), 200)).body;
  const result = (await expectStatus(await call(user1.auth, 'POST', endpoint, {token: fresh.token}), 200)).body;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.deleted, fresh.counts);
  for (const item of created) await expectStatus(await call(item.auth, 'GET', item.path), 404);
  console.log('PASS: internal instances, their templates, all other artifacts and deepest-first folders are deleted');
} finally {
  const failures = [];
  for (const item of created.toReversed()) {
    const read = await call(item.auth, 'GET', item.path);
    if (read.status === 404) continue;
    const result = await mutate(item.auth, 'DELETE', item.path);
    if (![204, 404].includes(result.status)) failures.push(`${item.path}: ${result.status}`);
  }
  assert.deepEqual(failures, [], 'Fixture cleanup failed');
}
