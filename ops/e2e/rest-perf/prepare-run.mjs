#!/usr/bin/env node
// Create a bounded fixture tree for each participating user. The manifest is updated after every
// successful POST so cleanup can recover from an interrupted setup.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import {
  HOST, PERF_PREFIX, RESOURCE, GROUP_SERVER, absolute, arg, assertSafeTargets, currentMutation, enc,
  intArg, parallelLimit, readJson, request, runId, userProfile, userToken, writeJson,
} from './lib.mjs';
import { categoryAcl, filesystemAcl } from './permission-model.js';
import { authoringInstance, authoringOntology, authoringTemplate, authoringValues } from './authoring-model.js';
import { sampleTerminology } from './terminology-sample.mjs';

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
const scheduleSeed = arg('seed', id);
const authoringInstances = intArg('authoring-instances', 20, { max: 500 });
const findingArtifacts = intArg('finding-artifacts', 40, { min: 0, max: 400 });
const terminologyAcronyms = arg('sources', 'UO,EDAM,DOID,MONDO,NCIT,NCBITAXON').split(',').filter(Boolean);
const termsPerSource = intArg('terms-per-source', 40, { min: 6, max: 500 });
const TERMINOLOGY = env.CEDAR_TERMINOLOGY_BASE ?? `https://terminology.${HOST}`;
const OPENVIEW = env.CEDAR_OPENVIEW_BASE
  ?? `http://${env.CEDAR_OPENVIEW_SERVER_HOST ?? 'localhost'}:${env.CEDAR_OPENVIEW_HTTP_PORT ?? '9013'}`;
const terminologyLog = arg('terminology-log',
    env.CEDAR_HOME ? resolve(env.CEDAR_HOME, 'log', 'cedar-terminology-server.log') : '');
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const adminKey = env.CEDAR_ADMIN_USER_API_KEY;
if ((profile === 'contention' || profile === 'hotset' || profile === 'soak'
    || profile === 'permissions') && !adminKey) {
  throw new Error(`CEDAR_ADMIN_USER_API_KEY is required for category ${profile} fixtures`);
}

const inventory = readJson(usersPath);
const selected = inventory.users?.slice(0, userCount) ?? [];
if (selected.length !== userCount) {
  throw new Error(`${usersPath} contains ${selected.length} users; provision at least ${userCount}`);
}
if (profile === 'soak' && selected.length < 2) {
  throw new Error('the soak profile needs at least two users for grant/revoke and membership transitions');
}
if (profile === 'permissions' && selected.length < 5) {
  throw new Error('the permissions profile needs five users for owner, Viewer, Classifier, Editor and Manager coverage');
}

const manifest = {
  schemaVersion: 5,
  runId: id,
  scheduleSeed,
  prefix: PERF_PREFIX,
  createdAt: new Date().toISOString(),
  target: { resource: RESOURCE, group: GROUP_SERVER, terminology: TERMINOLOGY, openView: OPENVIEW },
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

async function shareFilesystemRoles(owner, path, userRoles = [], groupRoles = []) {
  const response = await currentMutation(owner.token, 'PUT', `${path}/permissions`,
      filesystemAcl(owner.cedarUserId, userRoles, groupRoles));
  if (response.status !== 200) {
    throw new Error(`could not share ${path}: ${response.status} ${response.text}`);
  }
}

async function shareFilesystem(owner, path, actors, role = 'manager') {
  await shareFilesystemRoles(owner, path,
      actors.slice(1).map(actor => ({ id: actor.cedarUserId, role })));
}

async function shareFilesystemWithGroup(owner, path, groupId, role = 'viewer') {
  await shareFilesystemRoles(owner, path, [], [{ id: groupId, role }]);
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

let categoryRootPromise;

async function categoryRootId() {
  if (!categoryRootPromise) {
    categoryRootPromise = request(adminKey, 'GET', '/categories/root').then(root => {
      if (root.status !== 200 || !root.body?.['@id']) {
        throw new Error(`read category root: ${root.status} ${root.text}`);
      }
      return root.body['@id'];
    });
  }
  return categoryRootPromise;
}

async function createCategory(label, parentCategoryId) {
  const parentId = parentCategoryId || await categoryRootId();
  const name = `${PERF_PREFIX} ${label} ${id}`;
  const response = await request(adminKey, 'POST', '/categories', {
    'schema:name': name,
    'schema:description': `${PERF_PREFIX} fixture for ${id}`,
    parentCategoryId: parentId,
    'schema:identifier': `cedar-rest-perf-${id}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  });
  if (response.status !== 201) throw new Error(`create category ${label}: ${response.status} ${response.text}`);
  const categoryId = response.body['@id'];
  const path = `/categories/${enc(categoryId)}`;
  remember({ kind: 'category', id: categoryId, path, name, actor: 'admin' });
  return { kind: 'category', id: categoryId, path, name };
}

async function shareCategory(category, actorsToShare) {
  const permissions = categoryAcl(
      actorsToShare.map(actor => ({ id: actor.cedarUserId, role: 'manager' })));
  const shared = await currentMutation(adminKey, 'PUT', `${category.path}/permissions`, permissions);
  if (shared.status !== 200) {
    throw new Error(`share category: ${shared.status} ${shared.text}`);
  }
  return permissions;
}

async function shareCategoryRoles(category, userRoles = [], groupRoles = []) {
  const permissions = categoryAcl(userRoles, groupRoles);
  const shared = await currentMutation(adminKey, 'PUT', `${category.path}/permissions`, permissions);
  if (shared.status !== 200) {
    throw new Error(`share category roles: ${shared.status} ${shared.text}`);
  }
  return permissions;
}

console.log(`Preparing ${selected.length} users under run ${id}`);
const actors = await parallelLimit(selected, concurrency, async (record, index) => {
  const token = await userToken(record.username, password);
  const cedarProfile = await userProfile(token);
  if (cedarProfile.homeFolderId !== record.homeFolderId) {
    throw new Error(`${record.username}: home folder changed from ${record.homeFolderId} to ${cedarProfile.homeFolderId}`);
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
  const root = await createFolder(actor, cedarProfile.homeFolderId, `User ${record.sequence}`);
  if (profile === 'terminology') {
    // The terminology profile asks about terms and stores nothing. The root keeps the manifest
    // and the cleanup audit the same shape as every other profile's.
    manifest.actors[index] = { ...manifest.actors[index], rootFolderId: root };
    writeJson(output, manifest);
    return { ...manifest.actors[index], token };
  }
  const source = await createFolder(actor, root, 'Source');
  const destination = await createFolder(actor, root, 'Destination');
  const readOnly = await createArtifact(actor, root, 'Read');
  const mutable = await createArtifact(actor, root, 'Mutable');
  const movable = await createArtifact(actor, source, 'Movable');
  const publicToggle = await createArtifact(actor, root, 'OpenView');
  let extendedArtifacts;
  let soakFolders;
  if (profile === 'soak' || profile === 'burst' || profile === 'formats' || profile === 'finding') {
    const label = { soak: 'Soak', burst: 'Burst', formats: 'Formats', finding: 'Finding' }[profile];
    const element = await createArtifact(actor, root, `${label} element`, 'element');
    const field = await createArtifact(actor, root, `${label} field`, 'field');
    const instance = await createArtifact(actor, root, `${label} instance`, 'instance', {
      'schema:isBasedOn': mutable.id,
    });
    extendedArtifacts = { template: mutable, element, field, instance };
  }
  if (profile === 'soak') {
    const aclFolderId = await createFolder(actor, root, 'Soak ACL');
    const groupAccessFolderId = await createFolder(actor, root, 'Soak group access');
    soakFolders = {
      acl: { kind: 'folder', id: aclFolderId, path: `/folders/${enc(aclFolderId)}` },
      groupAccess: {
        kind: 'folder', id: groupAccessFolderId, path: `/folders/${enc(groupAccessFolderId)}`,
      },
    };
  }
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
    ...(profile === 'soak' ? {
      soak: {
        artifacts: extendedArtifacts,
        aclArtifact: mutable,
        aclFolder: soakFolders.acl,
        groupAccessFolder: soakFolders.groupAccess,
      },
    } : {}),
    ...(profile === 'burst' ? { burst: { artifacts: extendedArtifacts } } : {}),
    ...(profile === 'formats' ? { formats: { artifacts: extendedArtifacts } } : {}),
    ...(profile === 'finding' ? { finding: { artifacts: extendedArtifacts } } : {}),
  };
  manifest.actors[index] = saved;
  writeJson(output, manifest);
  console.log(`  prepared ${record.username}`);
  return { ...saved, token };
});

const owner = actors[0];

if (profile === 'terminology' || profile === 'authoring') {
  const acronyms = profile === 'authoring' ? [authoringOntology.acronym] : terminologyAcronyms;
  console.log(`Sampling ${acronyms.join(', ')} from ${env.CEDAR_TERMINOLOGY_STORE_INDEX}`);
  const sampled = await sampleTerminology({
    indexPath: env.CEDAR_TERMINOLOGY_STORE_INDEX,
    base: TERMINOLOGY,
    token: owner.token,
    acronyms,
    perSource: profile === 'authoring' ? Math.max(termsPerSource, 60) : termsPerSource,
    logPath: terminologyLog,
  });
  for (const { acronym, reason } of sampled.dropped) console.log(`  left out ${acronym}: ${reason}`);
  if (!Object.keys(sampled.sources).length) {
    throw new Error(`no requested source is served from the local terminology store: ${acronyms.join(', ')}`);
  }
  if (profile === 'terminology') {
    manifest.terminology = sampled;
  } else {
    // A write verifies each controlled-term value against the terminology server, so the values
    // are terms that server has already confirmed from its local store.
    manifest.terms = sampled.sources[authoringOntology.acronym].terms;
  }
  writeJson(output, manifest);
}

if (profile === 'authoring') {
  const minimalTemplate = JSON.parse(readFileSync(artifactFixtures.template, 'utf8'));
  const minimalField = JSON.parse(readFileSync(artifactFixtures.field, 'utf8'));
  const minimalInstance = JSON.parse(readFileSync(artifactFixtures.instance, 'utf8'));
  const description = `${PERF_PREFIX} fixture for ${id}`;
  await parallelLimit(actors, concurrency, async actor => {
    const post = async (kind, body) => {
      const collection = artifactCollections[kind];
      const response = await request(actor.token, 'POST',
          `${collection}?folder_id=${enc(actor.rootFolderId)}`, body);
      if (response.status !== 201) {
        throw new Error(`${actor.username}: create ${body['schema:name']}: ${response.status} ${response.text}`);
      }
      const created = {
        kind, id: response.body['@id'], path: `${collection}/${enc(response.body['@id'])}`, name: body['schema:name'],
      };
      remember({ ...created, actor: actor.index });
      return created;
    };
    const template = await post('template', authoringTemplate(minimalTemplate, minimalField,
        `${PERF_PREFIX} Authoring template ${actor.sequence} ${id}`, description));
    const instances = [];
    for (let number = 0; number < authoringInstances; number++) {
      instances.push(await post('instance', authoringInstance(minimalInstance, template.id,
          `${PERF_PREFIX} Authoring instance ${actor.sequence}-${number + 1} ${id}`, description,
          authoringValues(manifest.terms, actor.index * 1009 + number * 3))));
    }
    manifest.actors[actor.index].authoring = { template, instances };
    writeJson(output, manifest);
    console.log(`  prepared ${instances.length} authoring instances for ${actor.username}`);
  });
}

if (profile === 'finding') {
  // A search page costs the server work for every hit it returns, so each participant gets enough
  // artifacts to fill one. The rest of the fixture gives every kind of listing something to find:
  // an artifact a peer shared, an open artifact, an open folder and a group the participant is in.
  await parallelLimit(actors, concurrency, async actor => {
    const peer = actors[(actor.index + 1) % actors.length];
    const corpusId = await createFolder(actor, actor.rootFolderId, 'Finding corpus');
    for (let number = 0; number < findingArtifacts; number++) {
      await createArtifact(actor, corpusId, `Finding field ${number + 1}`, 'field');
    }
    await shareFilesystemRoles(actor, actor.readTemplate.path, [{ id: peer.cedarUserId, role: 'viewer' }]);

    const opened = await currentMutation(actor.token, 'POST', '/command/make-artifact-open',
        { '@id': actor.openViewTemplate.id }, { etagPath: `${actor.openViewTemplate.path}/details` });
    if (opened.status !== 200) {
      throw new Error(`${actor.username}: open the OpenView template: ${opened.status} ${opened.text}`);
    }
    const openFolderId = await createFolder(actor, actor.rootFolderId, 'Finding open folder');
    const openFolderPath = `/folders/${enc(openFolderId)}`;
    const inOpenFolder = await createArtifact(actor, openFolderId, 'Finding open folder template');
    const folderOpened = await currentMutation(actor.token, 'POST', '/command/make-folder-open',
        { '@id': openFolderId }, { etagPath: openFolderPath });
    if (folderOpened.status !== 200) {
      throw new Error(`${actor.username}: open the folder: ${folderOpened.status} ${folderOpened.text}`);
    }

    const group = await createGroup(actor, `Finding group ${actor.sequence}`);
    const groupMembers = await currentMutation(actor.token, 'PUT', `${group.path}/users`, {
      users: [{ user: { '@id': actor.cedarUserId }, administrator: true, member: true }],
    }, { base: GROUP_SERVER });
    if (groupMembers.status !== 200) {
      throw new Error(`${actor.username}: initialize finding group: ${groupMembers.status} ${groupMembers.text}`);
    }

    Object.assign(manifest.actors[actor.index].finding, {
      corpusFolderId: corpusId,
      corpusSize: findingArtifacts,
      sharedByPeer: {
        // What this participant can find because the previous participant shared it.
        id: actors[(actor.index + actors.length - 1) % actors.length].readTemplate.id,
      },
      openFolder: { kind: 'folder', id: openFolderId, path: openFolderPath, template: inOpenFolder },
      group,
    });
    writeJson(output, manifest);
    console.log(`  prepared finding fixtures for ${actor.username}`);
  });
}

if (profile === 'soak') {
  await parallelLimit(actors, concurrency, async actor => {
    const peer = actors[(actor.index + 1) % actors.length];
    const group = await createGroup(actor, `Soak group ${actor.sequence}`);
    const groupUsers = {
      users: [{
        user: { '@id': actor.cedarUserId }, administrator: true, member: true,
      }],
    };
    const groupMembers = await currentMutation(actor.token, 'PUT', `${group.path}/users`, groupUsers,
        { base: GROUP_SERVER });
    if (groupMembers.status !== 200) {
      throw new Error(`${actor.username}: initialize soak group: ${groupMembers.status} ${groupMembers.text}`);
    }
    await shareFilesystemWithGroup(actor, actor.soak.groupAccessFolder.path, group.id);

    const category = await createCategory(`Soak category ${actor.sequence}`);
    await shareCategory(category, [actor]);

    manifest.actors[actor.index].soak.group = group;
    manifest.actors[actor.index].soak.groupUsers = groupUsers;
    manifest.actors[actor.index].soak.peer = {
      index: peer.index,
      cedarUserId: peer.cedarUserId,
      username: peer.username,
    };
    manifest.actors[actor.index].soak.category = category;
    writeJson(output, manifest);
  });
}

if (profile === 'permissions') {
  const viewer = actors[1];
  const classifier = actors[4];
  const editor = actors[2];
  const manager = actors[3];
  const directField = await createArtifact(owner, owner.rootFolderId, 'Permission roles field', 'field');
  const directFolderId = await createFolder(owner, owner.rootFolderId, 'Permission roles folder');
  const directFolder = { kind: 'folder', id: directFolderId, path: `/folders/${enc(directFolderId)}` };
  const directRoles = [
    { id: viewer.cedarUserId, role: 'viewer' },
    { id: editor.cedarUserId, role: 'editor' },
    { id: manager.cedarUserId, role: 'manager' },
  ];
  await shareFilesystemRoles(owner, directField.path, directRoles);
  await shareFilesystemRoles(owner, directFolder.path, directRoles);

  const inheritedFolderId = await createFolder(owner, owner.rootFolderId, 'Permission inherited folder');
  const inheritedFolder = {
    kind: 'folder', id: inheritedFolderId, path: `/folders/${enc(inheritedFolderId)}`,
  };
  const inheritedField = await createArtifact(owner, inheritedFolderId, 'Permission inherited field', 'field');
  await shareFilesystemRoles(owner, inheritedFolder.path,
      [{ id: editor.cedarUserId, role: 'editor' }]);
  await shareFilesystemRoles(owner, inheritedField.path,
      [{ id: editor.cedarUserId, role: 'viewer' }]);

  const group = await createGroup(owner, 'Permission Viewer group');
  const groupUsers = {
    users: [
      { user: { '@id': owner.cedarUserId }, administrator: true, member: true },
      { user: { '@id': viewer.cedarUserId }, administrator: false, member: true },
    ],
  };
  const groupMembers = await currentMutation(owner.token, 'PUT', `${group.path}/users`, groupUsers,
      { base: GROUP_SERVER });
  if (groupMembers.status !== 200) {
    throw new Error(`initialize permission group: ${groupMembers.status} ${groupMembers.text}`);
  }
  const groupField = await createArtifact(owner, owner.rootFolderId, 'Permission group field', 'field');
  await shareFilesystemRoles(owner, groupField.path, [], [{ id: group.id, role: 'viewer' }]);

  const transitionField = await createArtifact(owner, owner.rootFolderId, 'Permission transition field', 'field');
  await shareFilesystemRoles(owner, transitionField.path,
      [{ id: viewer.cedarUserId, role: 'viewer' }]);

  const moveSourceId = await createFolder(owner, owner.rootFolderId, 'Permission move source');
  const moveBlockedId = await createFolder(owner, owner.rootFolderId, 'Permission move Viewer target');
  const moveAllowedId = await createFolder(owner, owner.rootFolderId, 'Permission move Editor target');
  const moveSource = { kind: 'folder', id: moveSourceId, path: `/folders/${enc(moveSourceId)}` };
  const moveBlocked = { kind: 'folder', id: moveBlockedId, path: `/folders/${enc(moveBlockedId)}` };
  const moveAllowed = { kind: 'folder', id: moveAllowedId, path: `/folders/${enc(moveAllowedId)}` };
  const moveField = await createArtifact(owner, moveSourceId, 'Permission movable field', 'field');
  await shareFilesystemRoles(owner, moveField.path, [{ id: manager.cedarUserId, role: 'manager' }]);
  await shareFilesystemRoles(owner, moveSource.path, [{ id: manager.cedarUserId, role: 'editor' }]);
  await shareFilesystemRoles(owner, moveBlocked.path, [{ id: manager.cedarUserId, role: 'viewer' }]);
  await shareFilesystemRoles(owner, moveAllowed.path, [{ id: manager.cedarUserId, role: 'editor' }]);

  const directCategory = await createCategory('Permission direct roles category');
  await shareCategoryRoles(directCategory, [
    { id: viewer.cedarUserId, role: 'viewer' },
    { id: classifier.cedarUserId, role: 'classifier' },
    { id: editor.cedarUserId, role: 'editor' },
    { id: manager.cedarUserId, role: 'manager' },
  ]);

  const inheritedCategoryParent = await createCategory('Permission inherited category parent');
  const inheritedCategory = await createCategory(
      'Permission inherited category child', inheritedCategoryParent.id);
  await shareCategoryRoles(inheritedCategoryParent,
      [{ id: editor.cedarUserId, role: 'editor' }]);
  await shareCategoryRoles(inheritedCategory,
      [{ id: editor.cedarUserId, role: 'viewer' }]);

  const groupCategory = await createCategory('Permission group category');
  await shareCategoryRoles(groupCategory, [], [{ id: group.id, role: 'classifier' }]);

  const transitionCategory = await createCategory('Permission transition category');
  const transitionCategoryArtifact = await createArtifact(
      classifier, classifier.rootFolderId, 'Permission category classification template');
  const transferCategory = await createCategory('Permission ownership transfer category');

  manifest.permissions = {
    ownerIndex: owner.index,
    viewerIndex: viewer.index,
    editorIndex: editor.index,
    managerIndex: manager.index,
    classifierIndex: classifier.index,
    directField,
    directFolder,
    inheritedField,
    groupField,
    transitionField,
    move: { field: moveField, source: moveSource, blocked: moveBlocked, allowed: moveAllowed },
    category: {
      direct: directCategory,
      inherited: inheritedCategory,
      group: groupCategory,
      transition: transitionCategory,
      transitionArtifact: transitionCategoryArtifact,
      transfer: transferCategory,
    },
  };
  writeJson(output, manifest);
}

if (profile === 'contention' || profile === 'hotset') {
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
await shareCategory(contendedCategory, actors);

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

if (profile === 'contention') {
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
}

manifest.setupComplete = true;
writeJson(output, manifest);
console.log(`Prepared ${manifest.resources.length} resources; manifest ${output}`);
