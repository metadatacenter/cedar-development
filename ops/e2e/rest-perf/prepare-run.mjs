#!/usr/bin/env node
// Create a bounded fixture tree for each participating user. The manifest is updated after every
// successful POST so cleanup can recover from an interrupted setup.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import {
  PERF_PREFIX, RESOURCE, absolute, arg, assertSafeTargets, currentMutation, enc,
  intArg, parallelLimit, readJson, request, runId, userProfile, userToken, writeJson,
} from './lib.mjs';

assertSafeTargets();

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(HERE, '..', 'fixtures', 'minimal-template.json');
const usersPath = absolute(arg('users-file', 'reports/rest-perf/users.json'));
const id = arg('run-id', runId());
const output = absolute(arg('manifest', `reports/rest-perf/runs/${id}/run.json`));
const userCount = intArg('users', 10, { max: 500 });
const concurrency = intArg('concurrency', 4, { max: 20 });
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');

const inventory = readJson(usersPath);
const selected = inventory.users?.slice(0, userCount) ?? [];
if (selected.length !== userCount) {
  throw new Error(`${usersPath} contains ${selected.length} users; provision at least ${userCount}`);
}

const manifest = {
  schemaVersion: 1,
  runId: id,
  prefix: PERF_PREFIX,
  createdAt: new Date().toISOString(),
  target: { resource: RESOURCE },
  usersFile: usersPath,
  actors: [],
  resources: [],
  shared: null,
  setupComplete: false,
};
writeJson(output, manifest);

function remember(resource) {
  manifest.resources.push(resource);
  writeJson(output, manifest);
}

function templateBody(name) {
  const body = JSON.parse(readFileSync(fixturePath, 'utf8'));
  body['@id'] = null;
  body['schema:name'] = name;
  body['schema:description'] = `${PERF_PREFIX} fixture for ${id}`;
  return body;
}

async function createFolder(actor, parentId, label) {
  const name = `${PERF_PREFIX} ${label} ${id}`;
  const response = await request(actor.token, 'POST', '/folders', {
    folderId: parentId,
    name,
    description: `${PERF_PREFIX} fixture for ${id}`,
  });
  if (response.status !== 201) throw new Error(`${actor.username}: create ${label}: ${response.status} ${response.text}`);
  const folderId = response.body['@id'];
  remember({ kind: 'folder', id: folderId, path: `/folders/${enc(folderId)}`, name, actor: actor.index });
  return folderId;
}

async function createTemplate(actor, folderId, label) {
  const name = `${PERF_PREFIX} ${label} ${actor.sequence} ${id}`;
  const response = await request(actor.token, 'POST', `/templates?folder_id=${enc(folderId)}`, templateBody(name));
  if (response.status !== 201) throw new Error(`${actor.username}: create ${label}: ${response.status} ${response.text}`);
  const templateId = response.body['@id'];
  remember({ kind: 'template', id: templateId, path: `/templates/${enc(templateId)}`, name, actor: actor.index });
  return { id: templateId, name };
}

console.log(`Preparing ${selected.length} users under run ${id}`);
const actors = await parallelLimit(selected, concurrency, async (record, index) => {
  const token = await userToken(record.username, password);
  const profile = await userProfile(token);
  if (profile.homeFolderId !== record.homeFolderId) {
    throw new Error(`${record.username}: home folder changed from ${record.homeFolderId} to ${profile.homeFolderId}`);
  }
  const actor = { ...record, index, token };
  // Record the identity before its first POST. If setup is interrupted midway through this actor,
  // cleanup can still authenticate the owner of every resource already in the manifest.
  manifest.actors[index] = {
    index,
    sequence: record.sequence,
    username: record.username,
    subject: record.subject,
    cedarUserId: record.cedarUserId,
    homeFolderId: record.homeFolderId,
  };
  writeJson(output, manifest);
  const root = await createFolder(actor, profile.homeFolderId, `User ${record.sequence}`);
  const source = await createFolder(actor, root, 'Source');
  const destination = await createFolder(actor, root, 'Destination');
  const readOnly = await createTemplate(actor, root, 'Read');
  const mutable = await createTemplate(actor, root, 'Mutable');
  const movable = await createTemplate(actor, source, 'Movable');
  const publicToggle = await createTemplate(actor, root, 'OpenView');
  const saved = {
    index,
    sequence: record.sequence,
    username: record.username,
    subject: record.subject,
    cedarUserId: record.cedarUserId,
    homeFolderId: record.homeFolderId,
    rootFolderId: root,
    sourceFolderId: source,
    destinationFolderId: destination,
    readTemplate: readOnly,
    mutableTemplate: mutable,
    movableTemplate: movable,
    openViewTemplate: publicToggle,
  };
  manifest.actors[index] = saved;
  writeJson(output, manifest);
  console.log(`  prepared ${record.username}`);
  return { ...saved, token };
});

// Share one template directly with the other performance identities at write level. Ordinary smoke
// users receive no grant, while the contention scenario still uses genuinely different accounts.
const owner = actors[0];
const shared = await createTemplate(owner, owner.rootFolderId, 'Contended');
const permissionsPath = `/templates/${enc(shared.id)}/permissions`;
const permissionResponse = await currentMutation(owner.token, 'PUT', permissionsPath, {
  owner: { '@id': owner.cedarUserId },
  userPermissions: actors.slice(1).map(actor => ({
    user: { '@id': actor.cedarUserId },
    permission: 'write',
  })),
  groupPermissions: [],
});
if (permissionResponse.status !== 200) {
  throw new Error(`could not share contention template: ${permissionResponse.status} ${permissionResponse.text}`);
}
manifest.shared = { contendedTemplate: shared, writerCount: actors.length };
manifest.setupComplete = true;
writeJson(output, manifest);
console.log(`Prepared ${manifest.resources.length} resources; manifest ${output}`);
