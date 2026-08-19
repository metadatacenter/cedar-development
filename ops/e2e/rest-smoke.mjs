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
import { actors, call, teardown, summary, enc, RUN, suite, check, cleanup } from './rest/lib.mjs';

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
let ran = 'nothing';

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
  const homeFolderId = user1.profile.homeFolderId;
  if (!homeFolderId) throw new Error('the first user has no homeFolderId');
  console.log(`authenticated both test users; ${selected.length} suite(s) to run`);

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
}

const { passed, failed } = summary();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
// An interrupted run is neither pass nor fail: it cleaned up after itself, but it never reached the
// suites it did not run, so reporting PASS on what it managed would read as a verdict on the estate.
const verdict = interrupted ? 'INTERRUPTED' : failed ? 'FAIL' : 'PASS';
console.log(`\n${verdict}: ${passed} passed, ${failed} failed, ${seconds}s`);
process.exit(interrupted ? 130 : failed ? 1 : 0);
