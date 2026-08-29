// Removes what a smoke run left behind when it never reached its teardown step.
//
// Two ways in. Given nothing, it finds the leftovers itself, reports them, and deletes them only
// under `--apply`, which is the convention the other ops tools follow. Given a JSON list of
// `[type, name, id]` triples it deletes exactly those, which is what to reach for when a run named
// its own casualties.
//
// Discovery keys on the run stamp every suite puts in the names it creates — `2026-08-19T04-27-53`,
// which is UTC. A folder carrying one is a run's working folder, so everything below it belongs to
// that run whether or not its own name is stamped; the fixtures a person left in the home folder
// carry no stamp and are never touched. Categories are found the same way, and they matter because
// they live outside the folder tree: two stray ones sat in the shared vocabulary through a cleanup
// that walked only folders and reported itself complete.
//
//   node cleanup-smoke-leftovers.mjs                        # report
//   node cleanup-smoke-leftovers.mjs --apply                # report, then delete
//   node cleanup-smoke-leftovers.mjs --apply --min-age=0    # include a run still in flight
//   node cleanup-smoke-leftovers.mjs '[["folder","x","https://…"]]'   # delete exactly these
import { actors, call, mutate, enc, GROUP_SERVER } from './rest/lib.mjs';

const PATHS = {
  instance: '/template-instances',
  template: '/templates',
  element: '/template-elements',
  field: '/template-fields',
  folder: '/folders',
  category: '/categories',
  group: '/groups',
};

// Instances before the templates they populate, elements and fields after the templates that embed
// them, folders last. Leaving elements out of an earlier version did not merely skip three deletes:
// a folder still holding one cannot be removed, so every folder above it survived too. Categories
// are independent of all of it and go at the end.
const ORDER = ['instance', 'template', 'element', 'field', 'folder', 'category', 'group'];
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const minAgeArg = argv.find(a => a.startsWith('--min-age='));
// A run in flight names its working folder the same way a dead run did, so anything younger than
// this is left alone by default: deleting it would break the run that is still using it, and two
// sessions share this stack.
const minAgeMinutes = minAgeArg ? Number(minAgeArg.split('=')[1]) : 15;
const explicit = argv.find(a => a.startsWith('['));

const { user1, admin } = await actors();
const nameOf = n => n['schema:name'] ?? n.schema_name ?? '(unnamed)';
const kindOf = n => {
  const t = n.resourceType ?? '';
  if (t === 'folder') return 'folder';
  if (t === 'instance' || t.includes('template-instance')) return 'instance';
  if (t === 'element' || t.includes('template-element')) return 'element';
  if (t === 'field' || t.includes('template-field')) return 'field';
  return 'template';
};

/** Minutes since the stamp in a name, or null when it carries none. */
function ageMinutes(stamp) {
  if (!stamp) return null;
  const [date, time] = stamp.split('T');
  const at = Date.parse(`${date}T${time.replace(/-/g, ':')}Z`);
  return Number.isNaN(at) ? null : (Date.now() - at) / 60000;
}

async function deleteOne({ kind, name, id, auth }) {
  const base = kind === 'group' ? GROUP_SERVER : undefined;
  const res = await mutate(auth, 'DELETE', `${PATHS[kind]}/${enc(id)}`, undefined, { base });
  const done = res.status === 204 || res.status === 200 || res.status === 404;
  console.log(`${done ? 'ok  ' : 'FAIL'} ${kind} ${res.status} ${name}`);
  if (!done) console.log(`      ${(res.text ?? '').slice(0, 200)}`);
  return done;
}

// Deepest first within a kind, since a folder still holding anything cannot be deleted and a
// category cannot go while it has children. Discovery records depth; the explicit list is trusted
// to be in the order the caller wants.
async function deleteAll(items) {
  let done = 0;
  for (const kind of ORDER) {
    const of = items.filter(i => i.kind === kind).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
    for (const item of of) if (await deleteOne(item)) done++;
  }
  return done;
}

if (explicit) {
  const items = JSON.parse(explicit).map(([kind, name, id]) => ({ kind, name, id, auth: authFor(kind) }));
  const unknown = [...new Set(items.filter(i => !PATHS[i.kind]).map(i => i.kind))];
  if (unknown.length) {
    console.log(`refusing to run: no path for type(s) ${unknown.join(', ')}`);
    process.exit(1);
  }
  const missing = items.filter(i => !i.auth).map(i => i.kind);
  if (missing.length) {
    console.log('refusing to run: a category belongs to the administrator who created it, and '
        + 'CEDAR_ADMIN_USER_API_KEY is unset');
    process.exit(1);
  }
  await deleteAll(items);
  process.exit(0);
}

function authFor(kind) {
  return kind === 'category' ? admin?.auth : user1.auth;
}

// ── discovery ───────────────────────────────────────────────────────────────

const found = [];

// Everything under a stamped folder belongs to that run, so the stamp is inherited downwards rather
// than demanded of every name: suites create artifacts inside their working folder without always
// stamping them, and one such template survived a cleanup that matched on names alone.
async function walk(folderId, depth, inheritedStamp) {
  const listed = await call(user1.auth, 'GET', `/folders/${enc(folderId)}/contents?limit=500`);
  if (listed.status !== 200) {
    console.log(`! could not list ${folderId}: ${listed.status}`);
    return;
  }
  for (const node of listed.body?.resources ?? []) {
    const name = nameOf(node);
    const kind = kindOf(node);
    const stamp = inheritedStamp ?? name.match(STAMP)?.[0] ?? null;
    if (stamp) found.push({ kind, name, id: node['@id'], stamp, depth, auth: user1.auth });
    if (kind === 'folder') await walk(node['@id'], depth + 1, stamp);
  }
}

function walkCategories(node, depth, inheritedStamp) {
  const stamp = inheritedStamp ?? nameOf(node).match(STAMP)?.[0] ?? null;
  // The root and the vocabularies beside it carry no stamp, and a stamped category's children belong
  // to the same run even when renamed — one of the two strays had its identifier nulled by the
  // suite that renames it, so the identifier is not what to match on.
  if (stamp && depth > 0) {
    found.push({ kind: 'category', name: nameOf(node), id: node['@id'], stamp, depth, auth: authFor('category') });
  }
  for (const child of node.children ?? []) walkCategories(child, depth + 1, stamp);
}

await walk(user1.profile.homeFolderId, 0, null);
const tree = await call(user1.auth, 'GET', '/categories/tree');
if (tree.status === 200) walkCategories(tree.body, 0, null);
else console.log(`! could not read the category tree: ${tree.status}`);

const groups = await call(user1.auth, 'GET', '/groups', undefined, { base: GROUP_SERVER });
if (groups.status === 200) {
  for (const node of groups.body?.groups ?? []) {
    const name = nameOf(node);
    const stamp = name.match(STAMP)?.[0] ?? null;
    if (stamp) found.push({ kind: 'group', name, id: node['@id'], stamp, depth: 0, auth: user1.auth });
  }
} else {
  console.log(`! could not list groups: ${groups.status}`);
}

const tooYoung = found.filter(i => (ageMinutes(i.stamp) ?? Infinity) < minAgeMinutes);
const leftovers = found.filter(i => !tooYoung.includes(i));

if (!found.length) {
  console.log('nothing left behind');
  process.exit(0);
}

console.log(`${leftovers.length} leftover(s)${tooYoung.length ? `, ${tooYoung.length} too young to touch` : ''}:`);
for (const i of leftovers) {
  const age = ageMinutes(i.stamp);
  console.log(`  ${i.kind.padEnd(9)} ${age === null ? '?' : `${Math.round(age)}m`.padStart(6)}  ${i.name}`);
}
for (const i of tooYoung) console.log(`  skipped   ${Math.round(ageMinutes(i.stamp))}m  ${i.kind} ${i.name}`);

const orphanedCategories = leftovers.filter(i => i.kind === 'category' && !i.auth);
if (orphanedCategories.length) {
  console.log(`\n${orphanedCategories.length} category leftover(s) need CEDAR_ADMIN_USER_API_KEY, which is unset`);
}

if (!apply) {
  console.log('\nreport only — pass --apply to delete');
  process.exit(0);
}

console.log('');
const deleted = await deleteAll(leftovers.filter(i => i.auth));
console.log(`\ndeleted ${deleted} of ${leftovers.length}`);
