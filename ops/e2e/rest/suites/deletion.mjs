// Recursive folder deletion against the running services: the inventory, then one confirmed pass.
// The matrix in cedar-resource-server proves the deletion order against a stand-in document store.
// This suite proves it against the artifact server, which really rewrites a successor's link to a
// deleted version and so moves the successor's revision on.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

export const name = 'deletion';

const COLLECTION = { template: '/templates', element: '/template-elements', field: '/template-fields' };

// Each shape is a version history, oldest first, and where each version lives: the folder being
// deleted, a folder nested in it, or outside it in the home folder.
const SHAPES = [
  { title: 'a published version and its draft', versions: [['1.0.0', 'root'], ['1.0.1', 'root']] },
  { title: 'three versions across nested folders',
    versions: [['1.0.0', 'nested'], ['2.0.0', 'root'], ['2.0.1', 'nested']] },
  { title: 'the oldest version outside the folder', versions: [['1.0.0', 'home'], ['1.0.1', 'root']] },
  { title: 'the newest version outside the folder', versions: [['1.0.0', 'root'], ['1.0.1', 'home']] },
];

export async function run({ user1, homeFolderId }) {
  const auth = user1.auth;
  for (const kind of ['template', 'element', 'field'])
    for (const shape of SHAPES) await deleteChain(auth, homeFolderId, kind, shape);
  await deleteTemplateWithInstances(auth, homeFolderId);
  return {};
}

async function folder(auth, parent, label) {
  const res = await call(auth, 'POST', '/folders',
      { folderId: parent, name: `${label} ${RUN}`, description: `Created by the REST suites (${RUN})` });
  if (res.status !== 201) return null;
  cleanup('folder', `/folders/${enc(res.body['@id'])}`, label);
  return res.body['@id'];
}

/** Builds the chain oldest first: create, then publish and draft from each published version. */
async function buildChain(auth, kind, versions, places, label) {
  const ids = [];
  for (let i = 0; i < versions.length; i++) {
    const [version, place] = versions[i];
    const parent = places[place];
    let res;
    if (i === 0) {
      res = await call(auth, 'POST', `${COLLECTION[kind]}?folder_id=${enc(parent)}`, artifactBody(kind, label));
      if (res.status !== 201) return null;
    } else {
      const published = await call(auth, 'POST', '/command/publish-artifact', { '@id': ids[i - 1], newVersion: versions[i - 1][0] });
      if (![200, 201].includes(published.status)) return null;
      res = await call(auth, 'POST', '/command/create-draft-artifact',
          { '@id': ids[i - 1], folderId: parent, newVersion: version, propagateSharing: false });
      if (![200, 201].includes(res.status)) return null;
    }
    ids.push(res.body['@id']);
    cleanup(kind, `${COLLECTION[kind]}/${enc(res.body['@id'])}`, `${label} ${version}`);
  }
  return ids;
}

async function deleteChain(auth, homeFolderId, kind, shape) {
  suite(`deletion: a folder holding ${shape.title}, as ${kind}s`);
  // Names carry the shape: a version left outside the folder stays in the home folder until teardown.
  const label = `Deletion ${kind} ${shape.title}`;
  const root = await folder(auth, homeFolderId, `${label} root`);
  const nested = root && await folder(auth, root, `${label} nested`);
  if (!check(!!(root && nested), 'the folders are created', 'folder creation failed')) return;
  const places = { root, nested, home: homeFolderId };
  const ids = await buildChain(auth, kind, shape.versions, places, label);
  if (!check(!!ids, 'the version chain is created', 'create, publish or draft failed')) return;
  const outside = ids.filter((_, i) => shape.versions[i][1] === 'home');
  const inside = ids.filter(id => !outside.includes(id));
  const etags = {};
  for (const id of outside) etags[id] = (await call(auth, 'GET', `${COLLECTION[kind]}/${enc(id)}`)).headers?.get?.('etag');

  const plan = await call(auth, 'GET', `/folders/${enc(root)}/deletion`);
  if (!checkStatus(plan, 200, 'the deletion inventory is read')) return;
  check(plan.body?.allowed === true, 'the inventory allows the deletion', JSON.stringify(plan.body?.counts));
  const outcome = await call(auth, 'POST', `/folders/${enc(root)}/deletion`, { token: plan.body?.token });
  check(outcome.body?.status === 'completed', 'one confirmed pass deletes the whole tree',
      `${outcome.status}: ${JSON.stringify(outcome.body)}`);
  check(outcome.body?.deleted?.[kind] === inside.length && outcome.body?.deleted?.folder === 2,
      'every version and folder inside is counted as deleted', JSON.stringify(outcome.body?.deleted));
  const gone = [];
  for (const id of inside) gone.push((await call(auth, 'GET', `${COLLECTION[kind]}/${enc(id)}`)).status);
  gone.push((await call(auth, 'GET', `/folders/${enc(root)}`)).status);
  check(gone.every(status => status === 404), 'nothing inside the folder remains', `statuses ${gone}`);
  for (const id of outside) {
    const after = await call(auth, 'GET', `${COLLECTION[kind]}/${enc(id)}`);
    check(after.status === 200, 'a version outside the folder survives', `status ${after.status}`);
    if (ids.indexOf(id) > 0)
      check(!after.body?.['pav:previousVersion'], 'a surviving successor no longer links to a deleted version',
          `previous version ${after.body?.['pav:previousVersion']}`);
    else
      check(after.headers?.get?.('etag') === etags[id], 'a surviving predecessor is left as it was',
          `ETag ${etags[id]} became ${after.headers?.get?.('etag')}`);
  }
}

async function deleteTemplateWithInstances(auth, homeFolderId) {
  suite('deletion: a folder holding a template chain and instances of every version');
  const root = await folder(auth, homeFolderId, 'Deletion instances root');
  const nested = root && await folder(auth, root, 'Deletion instances nested');
  if (!check(!!(root && nested), 'the folders are created', 'folder creation failed')) return;
  const ids = await buildChain(auth, 'template', [['1.0.0', 'root'], ['2.0.0', 'nested'], ['2.0.1', 'root']],
      { root, nested }, 'Deletion instances template');
  if (!check(!!ids, 'the version chain is created', 'create, publish or draft failed')) return;
  let instances = 0;
  for (const template of ids) {
    const body = artifactBody('instance', 'Deletion instance', { 'schema:isBasedOn': template });
    const res = await call(auth, 'POST', `/template-instances?folder_id=${enc(nested)}`, body);
    if (res.status === 201) {
      instances++;
      cleanup('instance', `/template-instances/${enc(res.body['@id'])}`, 'Deletion instance');
    }
  }
  check(instances === ids.length, 'an instance of every version is created', `${instances} of ${ids.length}`);
  const plan = await call(auth, 'GET', `/folders/${enc(root)}/deletion`);
  if (!checkStatus(plan, 200, 'the deletion inventory is read')) return;
  const outcome = await call(auth, 'POST', `/folders/${enc(root)}/deletion`, { token: plan.body?.token });
  check(outcome.body?.status === 'completed', 'one confirmed pass deletes the instances, the chain and the folders',
      `${outcome.status}: ${JSON.stringify(outcome.body)}`);
  check(outcome.body?.deleted?.instance === instances && outcome.body?.deleted?.template === ids.length,
      'every instance and version is counted as deleted', JSON.stringify(outcome.body?.deleted));
}
