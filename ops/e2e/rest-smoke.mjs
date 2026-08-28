// End-to-end suites at the REST layer: every service running, no browser.
//
//   npm run smoke:rest              all suites
//   npm run smoke:rest -- folders   one suite, by name
//
// This is the middle tier of the estate. The per-service suites run backend-free and stop at the
// proxy, so they cannot follow the artifact write path at all. The browser smoke sees everything but
// through AngularJS markup, which makes it brittle and ties it to a frontend that will not outlive
// the backend. Prefer adding here.
//
// What only this tier reaches: the artifact write path, publish and create-draft, whether the graph
// and the artifact server agree, sharing as two real users, search-index propagation and paging, and
// YAML negotiation over the wire.
//
// Deliberately not covered, so the absence is a decision rather than an oversight:
//   * regenerate-search-index, generate-empty-search-index and the rules equivalents — destructive
//     admin operations that would wipe the local index out from under the rest of the run.
//   * load-valuesets-ontology and its status — long-running, and dependent on live BioPortal.
//   * auth-user-callback — Keycloak's own callback, not a user-facing route.
//   * templates/recommend and /recommend — need a built rules index, which is its own fixture problem.
//
// Requires the stack up: cedar-services.sh health.
import { argv } from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actors, call, teardown, summary, enc, RUN, suite, beginSuite, check, cleanup } from './rest/lib.mjs';

import * as folders from './rest/suites/folders.mjs';
import * as artifacts from './rest/suites/artifacts.mjs';
import * as versioning from './rest/suites/versioning.mjs';
import * as sharing from './rest/suites/sharing.mjs';
import * as search from './rest/suites/search.mjs';
import * as negotiation from './rest/suites/negotiation.mjs';
import * as download from './rest/suites/download.mjs';
import * as categories from './rest/suites/categories.mjs';
import * as validation from './rest/suites/validation.mjs';
import * as groups from './rest/suites/groups.mjs';
import * as groupSharing from './rest/suites/group-sharing.mjs';
import * as openness from './rest/suites/openness.mjs';
import * as finding from './rest/suites/finding.mjs';
import * as authentication from './rest/suites/authentication.mjs';
import * as pagination from './rest/suites/pagination.mjs';
import * as contract from './rest/suites/contract.mjs';
import * as inclusion from './rest/suites/inclusion.mjs';
import * as apidocs from './rest/suites/apidocs.mjs';
import * as freeze from './rest/suites/freeze.mjs';

const ALL = [folders, artifacts, versioning, groups, sharing, groupSharing, openness, categories, validation, search, finding, authentication, pagination, negotiation, download, contract, inclusion, apidocs, freeze];

const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = resolve(HERE, 'rest', 'expected-checks.json');
const reportArg = argv.find(a => a.startsWith('--report='));
const REPORT_PATH = resolve(process.cwd(), reportArg?.slice('--report='.length) ?? 'reports/rest-smoke.json');
const updateInventory = argv.includes('--update-inventory');

const requested = argv.slice(2).filter(a => !a.startsWith('-'));
const selected = requested.length
    ? ALL.filter(s => requested.includes(s.name))
    : ALL;

if (requested.length && selected.length !== requested.length) {
  const known = ALL.map(s => s.name).join(', ');
  console.error(`unknown suite. known suites: ${known}`);
  process.exit(2);
}

const started = Date.now();
let auth1;
let user1Profile;
let ran = 'nothing';

const stamp = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;
const nameOf = node => node?.['schema:name'] ?? node?.schema_name ?? '';

async function stampedLeftovers(auth, homeFolderId) {
  const leftovers = [];
  const home = await call(auth, 'GET', `/folders/${enc(homeFolderId)}/contents?limit=500`);
  if (home.status !== 200) return [{ where: 'home listing', detail: `${home.status}: ${home.text}` }];
  for (const node of home.body?.resources ?? []) {
    if (stamp.test(nameOf(node))) leftovers.push({ where: 'home', detail: nameOf(node) });
  }
  const categories = await call(auth, 'GET', '/categories/tree');
  if (categories.status !== 200) {
    leftovers.push({ where: 'category tree', detail: `${categories.status}: ${categories.text}` });
  } else {
    const walk = node => {
      if (stamp.test(nameOf(node))) leftovers.push({ where: 'category', detail: nameOf(node) });
      for (const child of node?.children ?? []) walk(child);
    };
    walk(categories.body);
  }
  return leftovers;
}

function checkIdentity(check) {
  return `${check.suite}\u001f${check.section}\u001f${check.name}`;
}

function expectedFor(suiteNames) {
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  return inventory.checks.filter(identity => {
    const suiteName = identity.slice(0, identity.indexOf('\u001f'));
    return suiteName === 'runner' || suiteNames.includes(suiteName);
  });
}

// Interrupting the run must still clean up after it. Node runs no `finally` on a signal, so a run
// killed part-way through leaves its whole working subtree in the first user's home and nothing
// reports it afterwards — thirty-two artifacts from one such run sat there for thirteen hours,
// through several later runs that each cleaned up after themselves and passed.
//
// The handler records the interruption and returns rather than tearing down itself. Installing a
// handler at all suppresses the default exit, so the run carries on: a teardown started from here
// deletes artifacts out from under suites that are still using them, which turns one interruption
// into a screenful of unrelated failures. The suite loop reads the flag between suites, and the
// existing `finally` does the cleanup. A second signal is the way out of a suite that will not
// return, at the cost of the cleanup this exists to perform.
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) {
      console.log(`\n${signal} again — exiting without cleaning up`);
      process.exit(130);
    }
    interrupted = true;
    console.log(`\n${signal} — finishing the current suite, then tearing down`);
  });
}

try {
  const { user1, user2, admin } = await actors();
  auth1 = user1.auth;
  user1Profile = user1.profile;
  const homeFolderId = user1.profile.homeFolderId;
  if (!homeFolderId) throw new Error('the first user has no homeFolderId');
  console.log(`authenticated both test users; ${selected.length} suite(s) to run`);

  beginSuite('runner');
  suite('runner: clean-stack preflight');
  const before = await stampedLeftovers(auth1, homeFolderId);
  check(before.length === 0, 'the stack starts with no leftovers from an earlier REST run',
      before.map(item => `${item.where}: ${item.detail}`).join('; '));

  // One working folder for the suites that need somewhere to put things, so the run leaves a single
  // subtree behind if teardown ever fails.
  const workName = `REST Suites ${RUN}`;
  const work = await call(auth1, 'POST', '/folders',
      { folderId: homeFolderId, name: workName, description: 'Working folder for the REST suites' });
  if (work.status !== 201) throw new Error(`could not create the working folder: ${work.status} ${work.text}`);
  const folderId = work.body['@id'];
  // Registered now rather than at the end: cleanup() pushes onto the front of the queue, so
  // whatever is registered first is deleted last — and this folder can only go once its contents
  // have, since a non-empty folder cannot be deleted.
  cleanup('folder', `/folders/${enc(folderId)}`, workName);

  const ctx = { user1, user2, admin, homeFolderId, folderId };
  for (const s of selected) {
    if (interrupted) {
      console.log(`\nstopping after "${ran}" — ${selected.length - selected.indexOf(s)} suite(s) not run`);
      break;
    }
    try {
      beginSuite(s.name);
      await s.run(ctx);
    } catch (e) {
      suite(s.name);
      check(false, `suite "${s.name}" threw`, e.stack ?? e.message);
    }
    ran = s.name;
  }

} catch (e) {
  suite('runner');
  check(false, 'the run could not start', e.stack ?? e.message);
} finally {
  if (auth1) await teardown(auth1);
  if (auth1 && user1Profile?.homeFolderId) {
    beginSuite('runner');
    suite('runner: clean-stack postflight');
    const after = await stampedLeftovers(auth1, user1Profile.homeFolderId);
    check(after.length === 0, 'the run leaves no stamped folders, artifacts, or categories behind',
        after.map(item => `${item.where}: ${item.detail}`).join('; '));
  }
}

let result = summary();
const observedChecks = result.checks.map(checkIdentity);
let inventoryMatched = true;
if (updateInventory) {
  if (result.failed || interrupted) {
    beginSuite('runner');
    suite('runner: expected-check inventory');
    check(false, 'a failing or interrupted run cannot replace the committed check inventory',
        `${result.failed} failure(s), interrupted=${interrupted}`);
    result = summary();
  } else {
    writeFileSync(INVENTORY_PATH, `${JSON.stringify({ version: 1, checks: observedChecks }, null, 2)}\n`);
    console.log(`\nupdated check inventory: ${INVENTORY_PATH}`);
  }
} else {
  const expectedChecks = expectedFor(selected.map(s => s.name));
  inventoryMatched = JSON.stringify(observedChecks) === JSON.stringify(expectedChecks);
  if (!inventoryMatched) {
    const expectedSet = new Set(expectedChecks);
    const observedSet = new Set(observedChecks);
    const missing = expectedChecks.filter(id => !observedSet.has(id));
    const unexpected = observedChecks.filter(id => !expectedSet.has(id));
    beginSuite('runner');
    suite('runner: expected-check inventory');
    check(false, 'the run executes the committed check inventory',
        `missing ${missing.length}: ${missing.slice(0, 8).join(' | ')}; `
        + `unexpected ${unexpected.length}: ${unexpected.slice(0, 8).join(' | ')}`);
    result = summary();
  }
}

const { passed, failed, skipped } = result;
const seconds = ((Date.now() - started) / 1000).toFixed(1);
// An interrupted run is neither pass nor fail: it cleaned up after itself, but it never reached the
// suites it did not run, so reporting PASS on what it managed would read as a verdict on the estate.
const verdict = interrupted ? 'INTERRUPTED' : failed ? 'FAIL' : 'PASS';
const report = {
  schemaVersion: 1,
  runId: RUN,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  durationSeconds: Number(seconds),
  verdict,
  interrupted,
  selectedSuites: selected.map(s => s.name),
  counts: { passed, failed, skipped, total: passed + failed + skipped },
  inventoryMatched,
  checks: result.checks,
};
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${verdict}: ${passed} passed, ${failed} failed, ${skipped} skipped, ${seconds}s`);
console.log(`report: ${REPORT_PATH}`);
process.exit(interrupted ? 130 : failed ? 1 : 0);
