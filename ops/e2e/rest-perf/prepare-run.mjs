#!/usr/bin/env node
// Create a bounded fixture tree for each participating user. The manifest is updated after every
// successful POST so cleanup can recover from an interrupted setup.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import {
  PERF_PREFIX, RESOURCE, GROUP_SERVER, absolute, arg, assertSafeTargets, currentMutation, enc,
  intArg, parallelLimit, readJson, request, runId, userProfile, userToken, writeJson,
} from './lib.mjs';

assertSafeTargets();

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(HERE, '..', 'fixtures', 'minimal-template.json');
const usersPath = absolute(arg('users-file', 'reports/rest-perf/users.json'));
const id = arg('run-id', runId());
const output = absolute(arg('manifest', `reports/rest-perf/runs/${id}/run.json`));
const profile = arg('profile', 'quick');
const userCount = intArg('users', 10, { max: 500 });
const concurrency = intArg('concurrency', 4, { max: 20 });
const matrixRounds = intArg('rounds', 3, { max: 20 });
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const adminKey = env.CEDAR_ADMIN_USER_API_KEY;
if (profile === 'contention' && !adminKey) {
  throw new Error('CEDAR_ADMIN_USER_API_KEY is required for category contention fixtures');
}

const inventory = readJson(usersPath);
const selected = inventory.users?.slice(0, userCount) ?? [];
if (selected.length !== userCount) {
  throw new Error(`${usersPath} contains ${selected.length} users; provision at least ${userCount}`);
}

const manifest = {
  schemaVersion: 2,
  runId: id,
  prefix: PERF_PREFIX,
  createdAt: new Date().toISOString(),
  target: { resource: RESOURCE, group: GROUP_SERVER },
  usersFile: usersPath,
  actors: [],
  resources: [],
  shared: {},
  destructive: { updateDelete: [], doubleDelete: [], wildcardDelete: [] },
  matrixRounds,
  setupComplete: false,
};
writeJson(output, manifest);

function remember(resource) {
  manifest.resources.push(resource);
  writeJson(output, manifest);
}

const artifactFixtures = {
  template: fixturePath,
  element: resolve(HERE, '..', 'fixtures', 'minimal-element.json'),
  field: resolve(HERE, '..', 'fixtures', 'minimal-field.json'),
  instance: resolve(HERE, '..', 'fixtures', 'minimal-instance.json'),
};

const artifactCollections = {
  template: '/templates',
  element: '/template-elements',
  field: '/template-fields',
  instance: '/template-instances',
};

function artifactBody(kind, name, extra = {}) {
  const body = JSON.parse(readFileSync(artifactFixtures[kind], 'utf8'));
  body['@id'] = null;
  body['schema:name'] = name;
  body['schema:description'] = `${PERF_PREFIX} fixture for ${id}`;
  return Object.assign(body, extra);
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

async function createArtifact(actor, folderId, label, kind = 'template', extra = {}) {
  const name = `${PERF_PREFIX} ${label} ${actor.sequence} ${id}`;
  const collection = artifactCollections[kind];
  const response = await request(actor.token, 'POST', `${collection}?folder_id=${enc(folderId)}`,
      artifactBody(kind, name, extra));
  if (response.status !== 201) throw new Error(`${actor.username}: create ${label}: ${response.status} ${response.text}`);
  const artifactId = response.body['@id'];
  const path = `${collection}/${enc(artifactId)}`;
  remember({ kind, id: artifactId, path, name, actor: actor.index });
  return { kind, id: artifactId, path, name };
}

async function shareFilesystem(owner, path, actors, permission = 'write') {
  const response = await currentMutation(owner.token, 'PUT', `${path}/permissions`, {
    owner: { '@id': owner.cedarUserId },
    userPermissions: actors.slice(1).map(actor => ({
      user: { '@id': actor.cedarUserId },
      permission,
    })),
    groupPermissions: [],
  });
  if (response.status !== 200) {
    throw new Error(`could not share ${path}: ${response.status} ${response.text}`);
  }
}

async function createGroup(owner, label) {
  const name = `${PERF_PREFIX} ${label} ${id}`;
  const response = await request(owner.token, 'POST', '/groups', {
    'schema:name': name,
    'schema:description': `${PERF_PREFIX} fixture for ${id}`,
  }, { base: GROUP_SERVER });
  if (response.status !== 201) throw new Error(`create group ${label}: ${response.status} ${response.text}`);
  const groupId = response.body['@id'];
  const path = `/groups/${enc(groupId)}`;
  remember({ kind: 'group', id: groupId, path, name, actor: owner.index, base: GROUP_SERVER });
  return { kind: 'group', id: groupId, path, name };
}

async function createCategory(label) {
  const root = await request(adminKey, 'GET', '/categories/root');
  if (root.status !== 200 || !root.body?.['@id']) {
    throw new Error(`read category root: ${root.status} ${root.text}`);
  }
  const name = `${PERF_PREFIX} ${label} ${id}`;
  const response = await request(adminKey, 'POST', '/categories', {
    'schema:name': name,
    'schema:description': `${PERF_PREFIX} fixture for ${id}`,
    parentCategoryId: root.body['@id'],
    'schema:identifier': `cedar-rest-perf-${id}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  });
  if (response.status !== 201) throw new Error(`create category ${label}: ${response.status} ${response.text}`);
  const categoryId = response.body['@id'];
  const path = `/categories/${enc(categoryId)}`;
  remember({ kind: 'category', id: categoryId, path, name, actor: 'admin' });
  return { kind: 'category', id: categoryId, path, name };
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
  const readOnly = await createArtifact(actor, root, 'Read');
  const mutable = await createArtifact(actor, root, 'Mutable');
  const movable = await createArtifact(actor, source, 'Movable');
  const publicToggle = await createArtifact(actor, root, 'OpenView');
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

const owner = actors[0];
if (profile === 'contention') {
// Each independent ETag domain gets its own fixture. Sharing is direct and explicit so every batch
// is a real multi-identity race rather than twenty requests accidentally reusing one credential.
const content = {};
content.template = await createArtifact(owner, owner.rootFolderId, 'Content template');
content.element = await createArtifact(owner, owner.rootFolderId, 'Content element', 'element');
content.field = await createArtifact(owner, owner.rootFolderId, 'Content field', 'field');
content.instance = await createArtifact(owner, owner.rootFolderId, 'Content instance', 'instance', {
  'schema:isBasedOn': content.template.id,
});
for (const artifact of Object.values(content)) await shareFilesystem(owner, artifact.path, actors);

await shareFilesystem(owner, `/folders/${enc(owner.sourceFolderId)}`, actors);
await shareFilesystem(owner, `/folders/${enc(owner.destinationFolderId)}`, actors);
const graphArtifact = await createArtifact(owner, owner.sourceFolderId, 'Graph artifact');
await shareFilesystem(owner, graphArtifact.path, actors);
const graphFolderId = await createFolder(owner, owner.sourceFolderId, 'Graph folder');
const graphFolder = { kind: 'folder', id: graphFolderId, path: `/folders/${enc(graphFolderId)}` };
await shareFilesystem(owner, graphFolder.path, actors);

const aclArtifact = await createArtifact(owner, owner.rootFolderId, 'ACL artifact');
await shareFilesystem(owner, aclArtifact.path, actors);
const aclFolderId = await createFolder(owner, owner.rootFolderId, 'ACL folder');
const aclFolder = { kind: 'folder', id: aclFolderId, path: `/folders/${enc(aclFolderId)}` };
await shareFilesystem(owner, aclFolder.path, actors);

const contendedGroup = await createGroup(owner, 'Contended group');
const groupUsers = {
  users: actors.map(actor => ({
    user: { '@id': actor.cedarUserId }, administrator: true, member: true,
  })),
};
const groupMembers = await currentMutation(owner.token, 'PUT', `${contendedGroup.path}/users`, groupUsers,
    { base: GROUP_SERVER });
if (groupMembers.status !== 200) {
  throw new Error(`share contention group: ${groupMembers.status} ${groupMembers.text}`);
}

const contendedCategory = await createCategory('Contended category');
const categoryAcl = await request(adminKey, 'GET', `${contendedCategory.path}/permissions`);
if (categoryAcl.status !== 200 || !categoryAcl.body?.owner?.['@id']) {
  throw new Error(`read category permissions: ${categoryAcl.status} ${categoryAcl.text}`);
}
const categoryShare = await currentMutation(adminKey, 'PUT', `${contendedCategory.path}/permissions`, {
  owner: categoryAcl.body.owner,
  userPermissions: actors.map(actor => ({ user: { '@id': actor.cedarUserId }, permission: 'write' })),
  groupPermissions: [],
});
if (categoryShare.status !== 200) {
  throw new Error(`share contention category: ${categoryShare.status} ${categoryShare.text}`);
}

manifest.shared = {
  writerCount: actors.length,
  content,
  graphArtifact: { ...graphArtifact, sourceFolderId: owner.sourceFolderId, destinationFolderId: owner.destinationFolderId },
  graphFolder: { ...graphFolder, sourceFolderId: owner.sourceFolderId, destinationFolderId: owner.destinationFolderId },
  aclArtifact,
  aclFolder,
  group: contendedGroup,
  groupUsers,
  category: contendedCategory,
};
writeJson(output, manifest);

async function destructiveFixture(kind, label) {
  if (artifactCollections[kind]) {
    const extra = kind === 'instance' ? { 'schema:isBasedOn': content.template.id } : {};
    return createArtifact(owner, owner.rootFolderId, label, kind, extra);
  }
  if (kind === 'folder') {
    const folderId = await createFolder(owner, owner.rootFolderId, label);
    return { kind, id: folderId, path: `/folders/${enc(folderId)}` };
  }
  if (kind === 'group') return createGroup(owner, label);
  if (kind === 'category') return createCategory(label);
  throw new Error(`unknown destructive fixture kind ${kind}`);
}

const destructiveKinds = ['template', 'element', 'field', 'instance', 'folder', 'group', 'category'];
for (const race of Object.keys(manifest.destructive)) {
  for (let round = 0; round < matrixRounds; round++) {
    for (const kind of destructiveKinds) {
      manifest.destructive[race].push(await destructiveFixture(kind, `${race} ${kind} round ${round + 1}`));
      writeJson(output, manifest);
    }
  }
}
}

manifest.setupComplete = true;
writeJson(output, manifest);
console.log(`Prepared ${manifest.resources.length} resources; manifest ${output}`);
