// End-to-end smoke test against a running CEDAR stack: log in through the real
// Keycloak form; exercise Workspace folder, sharing, group, membership, rename and
// delete mutations with current ETags; create a template with a Disease field
// constrained to the DOID "disease" branch via the live BioPortal picker; save it
// twice without reloading; populate it and confirm a live DOID suggestion; publish
// it to OpenView and confirm an anonymous visitor sees it; then clean up everything.
//
//   npm run smoke                        production monolith, headless
//   npm run smoke:headed                 production monolith, headed
//   npm run smoke:split:authenticated    extracted Workspace + Designer, headless
//
// Requires the local stack to be up (frontend, resource, user, group, artifact
// at least): cedar-services.sh status
//
// Credentials and base URL come from the CEDAR profile environment
// (CEDAR_FRONTEND_local_USER1_LOGIN / _PASSWORD, CEDAR_HOST), with the standard
// local-dev values as fallbacks. Exit code 0 = pass; on failure a screenshot is
// written to failures/.
//
// Selectors live in ./selectors.mjs, which is the one place to edit when the
// template editor's markup moves. They were originally established by the tutorial
// runner, now in cedar-mkdocs/runner, which still keeps its own copies.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as S from './selectors.mjs';
// REST helpers, used to seed setup fixtures (folder, standalone field) without driving the UI, and
// to tear them down. The browser drives only the gestures under test (designer, metadata editor).
import { actors, call as restCall, mutate as restMutate, artifactBody,
  group as groupCall, mutateGroup } from './rest/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_DIR = resolve(__dirname, 'failures');

const BASE = process.env.CEDAR_BASE
  ?? `https://cedar.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
// Defaulting to BASE preserves the production-monolith journey. Supplying a distinct
// Designer origin turns the same mature smoke into the authenticated split-frontend
// acceptance journey without duplicating its fixture setup, selectors or teardown.
const DESIGNER_BASE = process.env.CEDAR_DESIGNER_BASE ?? BASE;
// The public OpenView site (the AngularJS app's `openViewBase`), a distinct subdomain
// from the editor. It renders open artifacts to callers with no CEDAR session.
const OPENVIEW_FRONTEND = process.env.CEDAR_OPENVIEW_FRONTEND
  ?? `https://openview.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
const USER = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const PASSWORD = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const HEADED = !!process.env.HEADED;
const EXPECTED_CEE_VERSION = process.env.CEDAR_EXPECT_CEE_VERSION;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// One stable working folder in the caller's home folder, reused by every run and created on first
// use, rather than a fresh `E2E Smoke <timestamp>` each time. A run that died before its teardown
// used to strand its folder in the home folder, and nine of them had accumulated there. The
// artifacts inside stay timestamped, so successive runs still cannot collide.
const FOLDER_NAME = 'Smoke Tests';
const TEMPLATE_NAME = `E2E Smoke Template ${RUN_ID}`;
const FIELD_NAME = `E2E Standalone Field ${RUN_ID}`;
const TEXT_FIELD_NAME = 'Notes';
const MUTATION_FOLDER_NAME = `E2E ETag Folder ${RUN_ID}`;
const MUTATION_FOLDER_FINAL_NAME = `${MUTATION_FOLDER_NAME} twice`;
const MUTATION_GROUP_NAME = `E2E ETag Group ${RUN_ID}`;
// A saved browser session, reused across runs so the Keycloak login is paid once. Regenerated
// automatically when missing or stale. Gitignored — it holds live tokens.
const AUTH_DIR = resolve(__dirname, '.auth');
const AUTH_STATE = resolve(AUTH_DIR, 'storage-state.json');

// ── working folder ─────────────────────────────────────────────────────────

// Resolve the run's working folder, creating it the first time.
//
// There is no lookup by path — `/folders?path=…` answers 405 — so the home folder's contents are
// listed and matched by name. That is also the only reliable way to ask: the search index can be
// stale in both directions, listing artifacts that were deleted and omitting ones that exist.
async function findOrCreateWorkingFolder(user) {
  const home = user.profile?.homeFolderId;
  if (!home) throw new Error('the first user has no homeFolderId');
  const listed = await restCall(user.auth, 'GET', `/folders/${enc(home)}/contents?limit=500`);
  if (listed.status !== 200) throw new Error(`could not list the home folder: ${listed.status} ${listed.text}`);
  const existing = (listed.body?.resources ?? []).find(r => r.resourceType === 'folder'
      && (r.schema_name ?? r['schema:name']) === FOLDER_NAME);
  if (existing) return { id: existing['@id'], created: false };
  const made = await restCall(user.auth, 'POST', '/folders',
      { folderId: home, name: FOLDER_NAME, description: 'Working folder for the UI smoke' });
  if (made.status !== 201) throw new Error(`could not create the "${FOLDER_NAME}" folder: ${made.status} ${made.text}`);
  return { id: made.body['@id'], created: true };
}

// Report what the run left in the working folder.
//
// The folder itself now outlives the run, which costs a check the old flow got for free: it deleted
// the folder last, and a non-empty folder cannot be deleted, so teardown was proven complete by that
// delete succeeding. This restores the guarantee explicitly — this run's own artifacts must be gone,
// and anything else still in there is named rather than asserted on, since it belongs to an earlier
// run that died and is not this one's failure to report.
async function assertWorkingFolderCleared(user, folderId, ownIds) {
  const listed = await restCall(user.auth, 'GET', `/folders/${enc(folderId)}/contents?limit=500`);
  if (listed.status !== 200) throw new Error(`could not list "${FOLDER_NAME}": ${listed.status} ${listed.text}`);
  const rows = listed.body?.resources ?? [];
  const own = new Set(ownIds);
  const survived = rows.filter(r => own.has(r['@id']));
  if (survived.length > 0) {
    const names = survived.map(r => `${r.resourceType} ${r.schema_name ?? r['schema:name']}`).join(', ');
    throw new Error(`teardown left this run's artifacts behind: ${names}`);
  }
  const older = rows.filter(r => !own.has(r['@id']));
  if (older.length > 0) {
    console.log(`  note: "${FOLDER_NAME}" also holds ${older.length} artifact(s) from earlier runs:`);
    for (const r of older) console.log(`        ${r.resourceType} ${r.schema_name ?? r['schema:name'] ?? '(unnamed)'}`);
  }
}

// ── dashboard helpers ──────────────────────────────────────────────────────
const enc = iri => encodeURIComponent(iri);

const row = (page, title) => page.locator(S.ROW, {
  has: page.getByText(title, { exact: true }),
}).first();

async function menuItem(page, label) {
  await page.locator(`a:text-is(${JSON.stringify(label)}):visible`).first().click();
}

async function openRowMenu(page, title) {
  const r = row(page, title);
  await r.scrollIntoViewIfNeeded();
  await r.locator(S.ROW_MENU_BUTTON).click();
  await page.waitForTimeout(800); // let the Angular dropdown bind its handlers
}

// Click the delete confirmation, once it can actually do something.
//
// The dialog binds its click handler as it animates in. Playwright clicks as soon
// as the button is visible, stable and enabled, none of which implies a handler is
// attached yet, so the click can be swallowed and the delete never issued — the
// same race openRowMenu settles for the dropdown above, and the cause of the
// "sent no DELETE request" retries.
async function confirmDelete(page) {
  const yes = page.getByRole('button', { name: S.DELETE_CONFIRM_NAME });
  await yes.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(600);
  await yes.click({ timeout: 10_000 });
}

// Navigate to a listing (the dashboard root, or a folder when folderId given)
// and wait until it is interactive.
async function gotoListing(page, folderId) {
  const url = folderId ? `${BASE}/dashboard?folderId=${enc(folderId)}` : `${BASE}/dashboard`;
  // `domcontentloaded`, not the default `load`. Keycloak's session check renders a
  // `3p-cookies/step1.html` iframe, and an iframe holds the load event open, so a stall in that
  // probe timed out navigations that had otherwise finished — intermittently, at whichever
  // dashboard visit happened to hit it. The wait below is the real readiness signal, and every
  // other navigation here is followed by one too.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New' }).waitFor();
  await page.waitForTimeout(500);
}

// Prove the real cross-application gesture before the mutating journey begins.
//
// This is intentionally driven from the Workspace menu rather than constructed by
// the test: the contract under test is that Workspace captures its complete URL,
// launches Designer on its configured origin, and Designer returns to that exact
// untrusted-but-validated URL. Waiting for the Designer Name field also proves that
// Keycloak SSO completed on the second origin. The production-monolith run skips this
// probe because both route owners intentionally share one origin there.
async function verifySplitNavigation(page) {
  if (new URL(DESIGNER_BASE).origin === new URL(BASE).origin) return;

  await gotoListing(page);
  const workspaceUrl = page.url();

  await page.locator('#button-create').click();
  await page.locator('#button-create-template').click();
  await page.waitForURL(url => url.origin === new URL(DESIGNER_BASE).origin
      && url.pathname === '/templates/create', { timeout: 30_000 });

  const launched = new URL(page.url());
  if (launched.searchParams.get('returnTo') !== workspaceUrl) {
    throw new Error(`Workspace launch did not preserve its exact URL: expected ${workspaceUrl}, got ${launched.searchParams.get('returnTo')}`);
  }
  await page.getByRole('textbox', { name: 'Name' }).waitFor({ timeout: 30_000 });

  // Cancel is the create-flow's explicit return action. Unlike the generic header
  // arrow it deliberately clears a newly initialized form's dirty flag before
  // leaving, so this probe tests the contract without depending on a confirmation
  // modal's animation timing.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(url => url.href === workspaceUrl, { timeout: 30_000 });
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 30_000 });
  console.log('✓ Workspace launched Designer with an exact return URL; Designer SSO and cancel-return succeeded');
}

// Exercise the live Workspace application's own services against the real servers. These are less
// brittle than reproducing every click in the old sharing dialog, while still running the shipped
// browser code, its Angular authorization layer, CORS, and the real conditional endpoints.
async function verifyWorkspaceConditionalMutations(page, folderId, mutableFolderId, groupId) {
  await gotoListing(page, folderId);
  await page.evaluate(async ({folderId, mutableFolderId, groupId, firstName, secondName}) => {
    const injector = window.angular.element(document).injector();
    if (!injector) throw new Error('Workspace Angular injector is unavailable');
    const resources = injector.get('resourceService');
    const backend = injector.get('AuthorizedBackendService');
    const folder = id => ({'@id': id, resourceType: 'folder'});
    const call = register => new Promise((resolve, reject) => register(resolve, error => {
      const status = error?.status ?? 'unknown';
      const detail = error?.data?.errorMessage ?? error?.data?.message ?? error?.statusText ?? 'request failed';
      reject(new Error(`${status}: ${detail}`));
    }));
    const currentResource = resource => call((ok, fail) => resources.getCurrentResource(resource, ok, fail));
    const rename = async (id, name) => {
      const current = await currentResource(folder(id));
      await call((ok, fail) => backend.doCall(resources.renameNode(current, name, null), ok, fail));
    };

    await rename(mutableFolderId, firstName);
    await rename(mutableFolderId, secondName);

    const workspaceFolder = folder(folderId);
    const permissions = await call((ok, fail) => resources.getResourceShare(workspaceFolder, ok, fail));
    await call((ok, fail) => resources.setResourceShare(workspaceFolder, permissions, ok, fail));
    await call((ok, fail) => resources.setResourceShare(workspaceFolder, permissions, ok, fail));

    const group = await call((ok, fail) => resources.getGroup(groupId, ok, fail));
    group['schema:description'] = 'Workspace conditional update one';
    await call((ok, fail) => resources.updateGroup(group, ok, fail));
    group['schema:description'] = 'Workspace conditional update two';
    await call((ok, fail) => resources.updateGroup(group, ok, fail));

    const members = await call((ok, fail) => resources.getGroupMembers(group, ok, fail));
    group.users = members.users;
    await call((ok, fail) => resources.updateGroupMembers(group, ok, fail));
    await call((ok, fail) => resources.updateGroupMembers(group, ok, fail));
    await call((ok, fail) => resources.deleteGroup(group, ok, fail));
  }, {
    folderId,
    mutableFolderId,
    groupId,
    firstName: `${MUTATION_FOLDER_NAME} once`,
    secondName: MUTATION_FOLDER_FINAL_NAME,
  });
  console.log('✓ Workspace conditionally renamed a folder twice, replaced permissions twice, and completed group update/membership/delete lifecycles');
}

// Delete a row by name, retrying the whole gesture.
//
// The gesture can no-op in silence. The row menu is an Angular dropdown that
// binds its handlers asynchronously, and a click that lands too early fires the
// anchor's href instead of the action, so no request is ever sent; the confirm
// dialog can also be clicked without the delete being issued. Watching the
// listing cannot tell any of that apart from a delete that did happen while the
// search index behind the listing still lags it, which is why this waits for the
// DELETE response itself and treats the three outcomes differently:
//
//   no response      the gesture never reached the server, so retry it — the one
//                    case where another attempt is worth anything
//   non-2xx          the server refused, so fail now and report the status,
//                    because repeating the gesture cannot change the answer
//   2xx              the delete happened; only then poll the listing, and if it
//                    stays stale, say so rather than calling the delete a failure
//
// Diagnosed from an access log showing 285 requests and not one folder DELETE
// across five attempts, while the run reported "still listed after deletion" —
// which reads like a backend fault for something the backend never saw.
async function deleteRow(page, name, folderId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await gotoListing(page, folderId);
    if (!(await row(page, name).count())) return;

    let response;
    try {
      await openRowMenu(page, name);
      await menuItem(page, 'Delete');
      // Armed before the click: a fast response would otherwise be missed.
      const pending = page
          .waitForResponse(r => r.request().method() === 'DELETE', { timeout: 8_000 })
          .catch(() => null);
      await confirmDelete(page);
      response = await pending;
    } catch {
      console.warn(`  delete gesture attempt ${attempt} for "${name}" did not reach the confirm dialog — retrying`);
      continue;
    }

    if (!response) {
      console.warn(`  delete gesture attempt ${attempt} for "${name}" sent no DELETE request — retrying`);
      continue;
    }
    if (!response.ok()) {
      throw new Error(`DELETE for "${name}" answered ${response.status()}: ${response.url()}`);
    }
    const ifMatch = await response.request().headerValue('if-match');
    if (!ifMatch) {
      throw new Error(`DELETE for "${name}" reached the server without If-Match: ${response.url()}`);
    }

    // The server has deleted it. The listing is served from the search index,
    // which can lag by tens of seconds just after a restart.
    for (let poll = 1; poll <= 8; poll++) {
      await gotoListing(page, folderId);
      if (!(await row(page, name).count())) return;
      await page.waitForTimeout(1500);
    }
    console.warn(`  "${name}" deleted (HTTP ${response.status()}) but still listed 12s later — the search index is lagging`);
    return;
  }
  throw new Error(`"${name}" was never deleted: 5 gestures, none of which sent a DELETE request`);
}

// ── controlled-term helpers ────────────────────────────────────────────────

// Field-editor inputs bind ng-model-options debounce ~1s; set atomically then wait.
async function setText(loc, value) {
  await loc.click();
  await loc.fill(value);
  await loc.page().waitForTimeout(1100);
}

// Add a plain text field on the open template designer and name it.
async function addTextField(page, name, help) {
  await page.locator(S.PALETTE_TEXT_FIELD).click(); // text field palette icon
  await setText(page.getByRole('textbox', { name: 'Enter Field Name' }).last(), name);
  if (help) await setText(page.getByRole('textbox', { name: 'Enter Field Help Text' }).last(), help);
}

// Save the same loaded Designer representation twice without reloading. The first response must
// advance the validator held by the live editor model; the second request must use that new value.
// A one-save smoke cannot distinguish correct propagation from a client that forever reuses the
// ETag it got on the initial GET.
async function verifyRepeatedTemplateUpdates(page) {
  const description = page.getByRole('textbox', { name: 'Description' }).first();
  const save = page.getByRole('button', { name: 'Save Template' });
  const validators = [];

  for (const value of ['Concurrency smoke: first update', 'Concurrency smoke: second update']) {
    await setText(description, value);
    const pending = page.waitForResponse(response => response.request().method() === 'PUT'
        && /\/templates\//.test(response.url()), { timeout: 20_000 });
    await save.click();
    const response = await pending;
    if (!response.ok()) {
      throw new Error(`Designer repeated update answered ${response.status()}: ${response.url()}`);
    }
    const ifMatch = await response.request().headerValue('if-match');
    const etag = await response.headerValue('etag');
    if (!ifMatch || !etag) {
      throw new Error(`Designer update omitted ${!ifMatch ? 'If-Match' : 'ETag'} on ${response.url()}`);
    }
    validators.push({ifMatch, etag});
  }

  if (validators[1].ifMatch !== validators[0].etag) {
    throw new Error(`Designer did not advance its live validator: first response ${validators[0].etag}, second request ${validators[1].ifMatch}`);
  }
  console.log(`✓ Designer saved the same live template twice (${validators[0].ifMatch} → ${validators[0].etag} → ${validators[1].etag})`);
}

// Constrain the just-added text field to the "disease" BRANCH of DOID via the live
// BioPortal picker: Values tab → Add → gear → ontology mode → search the ontology →
// select DOID → pick the "disease" tree node → stage Branch → Add. This exercises
// the terminology server's live ontology search and class-tree browse end to end.
async function constrainToDoidDiseaseBranch(page) {
  const rowText = 'Human Disease Ontology (DOID)';
  await page.locator(S.FIELD_VALUES_TAB).filter({ visible: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Add', exact: true }).click(); // open the picker
  await page.waitForTimeout(800);
  await page.locator(S.PICKER_ADVANCED_GEAR).first().click();                       // advanced options
  // The mode radio is a hidden/styled input whose AngularJS ng-change only fires on a
  // real DOM click; check({force}) and coordinate clicks don't trigger it, leaving the
  // picker in term mode. Dispatch a DOM click straight at the element (verified to switch
  // tsc.searchScope to 'ontologies').
  await page.locator(S.SEARCH_SCOPE_ONTOLOGIES).dispatchEvent('click');        // "search for an ontology"
  await page.waitForTimeout(500);
  await page.getByRole('textbox', { name: 'Search field' }).fill('Human Disease Ontology');
  // The ontology list loads on demand (a ~600KB BioPortal-backed call, filtered client-side), so
  // a search that runs while the load is still in flight shows "No results". Re-searching covers
  // that window, which is widest right after a stack restart.
  //
  // It covers nothing else, though. If the load has already failed, the cache is empty and stays
  // empty for this page, so every re-search reads the same empty cache. This loop is deliberately
  // short for that reason: failing out of it hands the decision to the caller, which reloads the
  // page and gets the service to load the list afresh. A long loop here only delays that.
  const doidRow = page.getByText(rowText, { exact: false }).first();
  let found = false;
  for (let i = 0; i < 6 && !found; i++) {
    await page.locator(S.PICKER_SEARCH).last().click();                   // run the search
    try { await doidRow.waitFor({ timeout: 5000 }); found = true; }
    catch { await page.waitForTimeout(2000); }
  }
  if (!found) throw new Error('DOID did not appear in the ontology picker — the ontology list is empty');
  await doidRow.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);                                      // DOID class tree loads
  const node = page.locator(S.CLASS_TREE_NODE)
    .filter({ hasText: /^\s*disease\s*$/i }).first();                   // the DOID:4 root branch
  await node.waitFor({ timeout: 20_000 });
  await node.click();
  await page.waitForTimeout(1500);
  await page.locator(S.STAGE_BRANCH).first().click(); // stage Branch
  await page.waitForTimeout(400);
  await page.locator(S.ADD_VALUE_CONSTRAINT).first().click({ force: true }); // commit
  await page.locator(S.STAGE_BRANCH)
    .waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});     // picker closed
  await page.waitForTimeout(800);
}

// Reach the Metadata Editor for a template via the row ⋮ → Populate (the deep link
// hits a transient init warning). Retry until the SPA nav commits.
async function openPopulate(page, folderId, templateName) {
  await gotoListing(page, folderId);
  for (let attempt = 1; attempt <= 4; attempt++) {
    await openRowMenu(page, templateName);
    await menuItem(page, 'Populate');
    try {
      await page.waitForURL(/instances\/create/, { waitUntil: 'commit', timeout: 8000 });
      return;
    } catch {
      if (attempt === 4) throw new Error('Populate did not navigate after 4 attempts');
    }
  }
}

// In the populate form, type a disease into the controlled Disease field and verify
// the terminology server suggests a matching DOID term (then pick it to fill). This
// is the end-to-end check that the value constraint resolves to live suggestions.
async function verifyDiseaseSuggestion(page, query) {
  const box = page.locator(S.CONTROLLED_TERM_INPUT).first();
  await box.waitFor({ timeout: 20_000 });
  const opt = page.getByRole('option', { name: new RegExp(query, 'i') })
    .or(page.locator(S.SUGGESTION_OPTION, { hasText: new RegExp(query, 'i') }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await box.click();
    await box.fill('');
    await box.pressSequentially(query, { delay: 60 }); // keyup drives the lookup; fill() won't
    try {
      await opt.first().waitFor({ timeout: 15_000 });
      await opt.first().click();
      return;
    } catch {
      if (attempt === 3) throw new Error(`no DOID suggestion offered for "${query}"`);
      await page.waitForTimeout(1000);
    }
  }
}

// Save the populated instance from the Metadata Editor (V2 / embeddable editor) and confirm it is
// created. The save button reads the instance from the embeddable editor's `currentMetadata`, which
// carries an explicit `@id: null` for a not-yet-created instance; the create POST answering 201 is the
// proof. This also regression-guards a bug where that null `@id` sent the save down the update branch,
// which called getTemplateInstance(null) and threw before any request left the browser — so "no create
// request was sent" is called out as its own failure. Returns the created instance's id and name.
async function saveInstanceInEditor(page) {
  const pending = page
    .waitForResponse(r => /\/template-instances(\?|$)/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 20_000 })
    .catch(() => null);
  await page.locator('#button-save-metadata').click();
  const resp = await pending;
  if (!resp) throw new Error('save sent no create-instance request — the metadata editor save handler threw before calling the server');
  if (resp.status() !== 201) throw new Error(`instance save answered ${resp.status()}`);
  // The create redirects (a full navigation) to /instances/edit/<id>. Recover the id from that URL
  // rather than the response body, which the navigation would race and lose. Reading the status above
  // needs no body, so it is safe.
  await page.waitForURL(/instances\/edit\//, { timeout: 20_000 });
  const m = page.url().match(/instances\/edit\/(.+?)(?:\?|$)/);
  if (!m) throw new Error('post-save redirect did not carry an instance id');
  return { id: decodeURIComponent(m[1]) };
}

// Fill a plain (unconstrained) text field the CEE renders. The CEE labels each field, so match the
// labeled control first; fall back to a text input inside the field block carrying the label text.
async function fillCeeTextField(page, name, value) {
  const cee = page.locator('cedar-embeddable-editor');
  // Wait for the labeled input to render — on the edit view the CEE hydrates the loaded instance
  // asynchronously ("CEDAR Embeddable Editor initializing…"), so the field is not there immediately.
  const byLabel = cee.getByLabel(name, { exact: false }).first();
  try {
    await byLabel.waitFor({ state: 'visible', timeout: 25_000 });
    await byLabel.fill(value);
    return;
  } catch { /* fall through to a structural match */ }
  const input = cee.locator('div', { hasText: name })
    .filter({ has: page.locator('input[type="text"], textarea') }).last()
    .locator('input[type="text"], textarea').first();
  await input.waitFor({ timeout: 10_000 });
  await input.fill(value);
}

// Read the identity from the CEE UI itself, so a green behavioral journey cannot hide which
// package actually rendered it. Playwright's CSS engine crosses the custom element's open shadow
// root. An optional expected value turns this report into an exact release-acceptance assertion.
async function readCeeVersion(page) {
  const versionLabel = page.locator('cedar-embeddable-editor .cee-version').first();
  await versionLabel.waitFor({ state: 'attached', timeout: 20_000 });
  const version = (await versionLabel.textContent())?.trim();
  if (!version) throw new Error('deployed CEE rendered no package version');
  if (EXPECTED_CEE_VERSION && version !== EXPECTED_CEE_VERSION) {
    throw new Error(`deployed CEE is ${version}; expected ${EXPECTED_CEE_VERSION}`);
  }
  return version;
}

// Re-edit the just-saved instance. The create redirects to the instance edit view; the field must
// render there (it once stayed stuck "CEDAR Embeddable Editor initializing…" because the redirect set
// the instance on the CEE element mid-re-init — now fixed by loading the edit view cleanly). Change
// the text field and save again — this drives the UPDATE branch, which carries the instance's real
// @id (the branch create's null-@id bug never reached). A 200 on the update call is the proof; if the
// editor is stuck, fillCeeTextField below times out, catching a regression of the redirect fix.
async function reEditInstance(page, newValue) {
  await page.waitForURL(/instances\/edit/, { timeout: 20_000 }); // the post-save redirect lands here
  await page.locator('cedar-embeddable-editor').waitFor({ state: 'attached', timeout: 20_000 });
  await fillCeeTextField(page, TEXT_FIELD_NAME, newValue); // waits for the field to hydrate
  const pending = page
    .waitForResponse(r => /\/template-instances\/[^?]+$/.test(r.url().split('?')[0])
        && ['PUT', 'POST'].includes(r.request().method()), { timeout: 20_000 })
    .catch(() => null);
  await page.locator('#button-save-metadata').click();
  const resp = await pending;
  if (!resp) throw new Error('re-edit sent no update request');
  if (resp.status() !== 200) throw new Error(`instance update answered ${resp.status()}`);
}

// Exercise the serialization config against the deployed CEE bundle, in the browser.
//
// The library round-trip is proven in the CEE harness; this proves the shipped web
// component honours the config a host sets — the one thing node tests cannot.
//
// Two independent things are checked, and deliberately kept apart so neither can make
// the other flaky:
//   1. The value is read through the two *always-on* getters — `currentMetadata` (JSON)
//      and `currentMetadataYaml` (YAML) — which take no config and so cannot disturb the
//      instance. Both must carry the value, each in its own format. The re-edit's value
//      lands in the model asynchronously and can lag the update's HTTP 200 by a beat, so
//      we first wait for it to appear in both getters; only then are the assertions read.
//      A genuine value-carriage regression still fails — the wait just times out and the
//      assertions run against the (still value-less) metadata, reporting exactly what is
//      missing.
//   2. The same two getters are read again from a throwaway element built from the template
//      under test, which is where a format regression would show first: an element that has
//      only ever been given a template, with no host configuration at all, must still offer
//      the instance as both a JSON object and a YAML string.
//
//      This checked `outputSerialization` and `currentMetadataSerialized` until CEE 2.0.0
//      removed both. One getter that changed its return type by configuration was the whole
//      of that contract, and two always-on getters say the same thing without a key: a host
//      reads whichever it wants, and nothing it sets can take the other away.
//
// Runs last on this page. The throwaway elements are hidden and removed again, and the live
// editor is only read from, so nothing after this is disturbed.
async function verifySerializationConfig(page, expectedValue, templateObject) {
  // Wait for the re-edited value to propagate into both getters before asserting.
  // Reading a getter is side-effect-free, so polling cannot disturb the instance.
  // On timeout we fall through: the assertions below then report precisely which
  // getter is missing the value, so a real regression is not masked by the wait.
  await page
    .waitForFunction(
      (needle) => {
        const cee = document.querySelector('cedar-embeddable-editor');
        if (!cee) return false;
        const yaml = cee.currentMetadataYaml;
        const yamlStr = typeof yaml === 'string' ? yaml : '';
        return JSON.stringify(cee.currentMetadata).includes(needle) && yamlStr.includes(needle);
      },
      expectedValue,
      { timeout: 15_000 },
    )
    .catch(() => {});

  const r = await page.evaluate((needle) => {
    const cee = document.querySelector('cedar-embeddable-editor');
    const str = (v) => (typeof v === 'string' ? v : '');

    // Value, through the always-on getters — no config involved.
    const json = cee.currentMetadata; // JSON object
    const yaml = cee.currentMetadataYaml; // YAML string

    return {
      jsonIsObject: json !== null && typeof json === 'object' && !Array.isArray(json),
      jsonCarriesValue: JSON.stringify(json).includes(needle),
      yamlIsString: typeof yaml === 'string' && yaml.length > 0,
      yamlIsNotJson: !str(yaml).trim().startsWith('{') && str(yaml).includes('type:'),
      yamlCarriesValue: str(yaml).includes(needle),
    };
  }, expectedValue);

  // Both formats, on a throwaway element built from the template under test. It is
  // hidden while it renders and removed once read.
  const formats = await page.evaluate(async (template) => {
    const build = async (config) => {
      const el = document.createElement('cedar-embeddable-editor');
      el.style.display = 'none';
      if (config) el.config = config;
      document.body.appendChild(el);
      el.templateObject = template;
      // The form is built asynchronously, and the two getters do not become ready
      // together: JSON is offered as soon as the instance exists, YAML once the
      // template has also been parsed, which the YAML writer needs. Waiting on
      // `currentMetadata` alone therefore reads YAML a beat early and sees the empty
      // string — a race that looks exactly like a missing format. Waiting for both is
      // what the live-editor half of this step already does. On timeout we fall
      // through, so a format that never arrives still fails the assertions below.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const json = el.currentMetadata;
        const yaml = el.currentMetadataYaml;
        const jsonReady = json !== null && typeof json === 'object' && Object.keys(json).length > 0;
        if (jsonReady && typeof yaml === 'string' && yaml.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return el;
    };

    // Configured, because an element assigned only a template never builds: both
    // getters then answer empty — `{}` and `''` — which is CEE's behaviour rather
    // than this step's subject. A `{}` passes any "is it JSON" test vacuously, so a
    // config-less element proves nothing about format either way. The config here is
    // the smallest one that is not about serialization at all.
    const built = await build({ defaultLanguage: 'en' });
    const json = built.currentMetadata;
    const yaml = built.currentMetadataYaml;
    built.remove();

    return {
      builtOffersPopulatedJson: json !== null && typeof json === 'object' && Object.keys(json).length > 0,
      builtOffersYamlString: typeof yaml === 'string' && yaml.length > 0,
    };
  }, templateObject);

  Object.assign(r, formats);
  const failed = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length > 0) {
    throw new Error(`both-serializations check failed [${failed.join(', ')}] — ${JSON.stringify(r)}`);
  }
}

// ── OpenView helpers ───────────────────────────────────────────────────────────

// Publish a template to OpenView via the row ⋮ → "Enable OpenView" menu item. That
// item POSTs make-artifact-open and shows a success flash — there is no confirm
// dialog (unlike delete). The command body carries the artifact's @id, which is the
// one place the smoke can learn it, and which the OpenView URL is built from, so this
// captures it off the request and returns it.
async function enableOpenView(page, folderId, templateName) {
  await gotoListing(page, folderId);
  await openRowMenu(page, templateName);
  const item = page.locator(S.MENU_ENABLE_OPENVIEW).filter({ visible: true }).first();
  await item.waitFor({ timeout: 8000 });
  // Armed before the click so a fast response is not missed.
  const pending = page
    .waitForResponse(r => r.url().includes('/command/make-artifact-open')
      && r.request().method() === 'POST', { timeout: 15_000 })
    .catch(() => null);
  await item.click();
  const resp = await pending;
  if (!resp) throw new Error('Enable OpenView sent no make-artifact-open request');
  if (!resp.ok()) throw new Error(`make-artifact-open answered ${resp.status()}`);
  const id = JSON.parse(resp.request().postData() ?? '{}')['@id'];
  if (!id) throw new Error('make-artifact-open request carried no @id');
  return id;
}

// Confirm the open template is served and presented by the OpenView site to a
// visitor with no CEDAR session at all. A fresh, cookie-less browser context is the
// point of the check: openness means "anyone with the link", so it must not borrow
// the logged-in session.
//
// "Presented" here means OpenView resolved the open grant and CEE actually upgraded and
// rendered the template. Merely finding the tag is not enough: a missing CEE script leaves the
// unknown custom element attached while the page shows only its footer, which used to let this
// check pass. Require a registered custom element, rendered shadow content, and the template name.
//
// The OpenView server's view of the grant can lag the make-open command by a moment,
// and the app fetches once per load and latches an error, so reload while the editor
// is absent rather than polling in place.
async function verifyPresentedInOpenView(browser, templateId) {
  const anon = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const p = await anon.newPage();
  const pageErrors = [];
  p.on('pageerror', error => pageErrors.push(error.message));
  const url = `${OPENVIEW_FRONTEND}/templates/${enc(templateId)}`;
  const editor = p.locator('cedar-embeddable-editor');
  try {
    let rendered = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await editor.waitFor({ state: 'attached', timeout: 12_000 });
        await p.waitForFunction((expectedName) => {
          const cee = document.querySelector('cedar-embeddable-editor');
          if (!customElements.get('cedar-embeddable-editor') || !cee?.shadowRoot) return false;
          return cee.shadowRoot.querySelectorAll('*').length > 0
            && cee.shadowRoot.textContent.includes(expectedName);
        }, TEMPLATE_NAME, { timeout: 12_000 });
        if (pageErrors.length > 0) {
          throw new Error(`OpenView raised browser errors: ${pageErrors.join(' | ')}`);
        }
        rendered = true;
        break;
      }
      catch { await p.waitForTimeout(2500); } // grant not propagated yet — reload and retry
    }
    if (rendered) return await readCeeVersion(p);
    await mkdir(FAIL_DIR, { recursive: true });
    const shot = resolve(FAIL_DIR, `openview-${Date.now()}.png`);
    await p.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const errors = pageErrors.length > 0 ? `; browser errors: ${pageErrors.join(' | ')}` : '';
    throw new Error(`OpenView did not present the open template — CEE never rendered${errors}; screenshot: ${shot}`);
  } finally {
    await anon.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  ignoreHTTPSErrors: true, // local CA
  viewport: { width: 1280, height: 900 },
  ...(existsSync(AUTH_STATE) ? { storageState: AUTH_STATE } : {}),
});
// Block gulp's livereload script, which is the reason navigations used to stall.
//
// `connect-livereload` writes `<script src="//HOST:35729/livereload.js">` into every HTML
// response, so on an https page the URL becomes `https://cedar…:35729/…` while gulp serves
// that port as plain HTTP. The request therefore cannot complete, and because it arrives
// through `document.write` it is a blocking script — when the browser sat on it,
// DOMContentLoaded never fired and the navigation timed out. It was intermittent, which is
// what made it read as a different flake each run. Measured: 11 of 12 dashboard loads took
// ~265 ms and one hung past 30 s with that script and three queued behind it.
//
// Aborting it is not papering over a product bug: livereload is a dev-loop convenience that
// cannot work over TLS at all, and nothing here tests it. Reloads are explicit in this suite.
await context.route('**://*:35729/**', route => route.abort());

const page = await context.newPage();
let step = 'init';
let cleanupUser1;
let mutationFolderId;
let mutationGroupId;

try {
  // 1. Reuse a saved session if the storage state carried a valid one; otherwise log in through
  //    Keycloak and save the state for the next run. Unauthenticated visitors are redirected to the
  //    Keycloak form, so the form's presence (vs the "New" button) tells the two paths apart.
  step = 'login';
  // `domcontentloaded` for the same reason as `gotoListing`; the race below is the readiness wait.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  const loginForm = page.locator(S.KC_USERNAME).first();
  const newButton = page.getByRole('button', { name: 'New' });
  // A reused session lands on the dashboard; a missing/stale one is redirected to the Keycloak form.
  // Race the two so neither path pays the other's timeout (`isVisible` can't be used here — it is an
  // immediate check and would fire mid-redirect).
  const seen = await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'login').catch(() => null),
    newButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'reused').catch(() => null),
  ]);
  if (seen === 'login') {
    await loginForm.fill(USER);
    await page.locator(S.KC_PASSWORD).first().fill(PASSWORD);
    await page.locator(S.KC_SUBMIT).first().click();
    await newButton.waitFor({ timeout: 60_000 });
    await mkdir(AUTH_DIR, { recursive: true });
    await context.storageState({ path: AUTH_STATE }); // pay the login once; reuse next run
    console.log(`✓ logged in as ${USER} (session saved for reuse)`);
  } else if (seen === 'reused') {
    console.log(`✓ reused saved session for ${USER}`);
  } else {
    throw new Error('neither the Keycloak login form nor the dashboard appeared');
  }

  step = 'split-navigation';
  await verifySplitNavigation(page);

  // 2. Seed the working folder and a standalone field over REST — fast, hermetic setup that needs no
  //    UI (folder-creation clicking is not the coverage this smoke is here for). A standalone field is
  //    one of the artifact shapes the CEE renders; seeding it exercises field-artifact create/teardown
  //    and leaves it available for later use. The same REST token tears both down at the end.
  step = 'seed';
  const { user1 } = await actors();
  cleanupUser1 = user1;
  const { id: folderId, created } = await findOrCreateWorkingFolder(user1);
  const fieldResp = await restCall(user1.auth, 'POST', `/template-fields?folder_id=${enc(folderId)}`,
      artifactBody('field', FIELD_NAME));
  if (fieldResp.status !== 201) throw new Error(`could not seed standalone field: ${fieldResp.status} ${fieldResp.text}`);
  const standaloneFieldId = fieldResp.body['@id'];
  console.log(`✓ ${created ? 'created' : 'reused'} the "${FOLDER_NAME}" folder, seeded a standalone field over REST`);

  // Exercise concurrency-sensitive Workspace mutations before entering Designer. Setup uses REST;
  // every mutation below runs through the loaded frontend's actual Angular services.
  step = 'workspace-conditional-mutations';
  const mutationFolder = await restCall(user1.auth, 'POST', '/folders', {
    folderId,
    name: MUTATION_FOLDER_NAME,
    description: 'Disposable folder for frontend ETag coverage',
  });
  if (mutationFolder.status !== 201) {
    throw new Error(`could not create mutation folder: ${mutationFolder.status} ${mutationFolder.text}`);
  }
  mutationFolderId = mutationFolder.body['@id'];
  const mutationGroup = await groupCall(user1.auth, 'POST', '/groups', {
    'schema:name': MUTATION_GROUP_NAME,
    'schema:description': 'Disposable group for frontend ETag coverage',
  });
  if (mutationGroup.status !== 201) {
    throw new Error(`could not create mutation group: ${mutationGroup.status} ${mutationGroup.text}`);
  }
  mutationGroupId = mutationGroup.body['@id'];
  await verifyWorkspaceConditionalMutations(page, folderId, mutationFolderId, mutationGroupId);
  mutationGroupId = null;
  await deleteRow(page, MUTATION_FOLDER_FINAL_NAME, folderId);
  mutationFolderId = null;
  console.log('✓ Workspace deleted the renamed folder with a freshly read If-Match validator');

  // 3. Create a template inside the folder via the designer deep link, name it, add
  //    a Disease field and constrain it to the DOID "disease" branch through the
  //    live BioPortal picker (which exercises the terminology server end to end).
  //
  //    The block retries as a unit, and it has to be the whole block. The editor
  //    loads BioPortal's ontology list once per page load, and a load that fails
  //    can leave the picker's cache empty for the life of that page, so retrying
  //    the ontology search inside the picker re-reads the same empty cache and
  //    cannot ever succeed. Only a fresh page load gives the service another
  //    attempt, which means starting again from the deep link.
  //
  //    Nothing is saved server-side until the save step below, so an attempt that
  //    fails here leaves no template behind.
  const CONSTRAIN_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= CONSTRAIN_ATTEMPTS; attempt++) {
    try {
      step = 'create-template';
      // `domcontentloaded` for the same reason as `gotoListing`; filling the Name box below waits
      // for it. This navigation had been retried by the surrounding loop for the same stall.
      const designerReturn = `${BASE}/dashboard?folderId=${enc(folderId)}`;
      await page.goto(`${DESIGNER_BASE}/templates/create?folderId=${enc(folderId)}&returnTo=${enc(designerReturn)}`,
          { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'Name' }).fill(TEMPLATE_NAME);
      await page.waitForTimeout(1100); // flush the debounced name edit

      step = 'constrain-disease-field';
      await addTextField(page, 'Disease', 'The disease studied, from the Human Disease Ontology');
      await constrainToDoidDiseaseBranch(page);

      // A second, plain (unconstrained) text field. The template now carries two field shapes the
      // CEE must render and collect — a controlled term and free text — and this is the field the
      // re-edit step below mutates.
      step = 'add-text-field';
      await addTextField(page, TEXT_FIELD_NAME, 'Free-text notes');
      break;
    } catch (e) {
      if (attempt === CONSTRAIN_ATTEMPTS) throw e;
      console.warn(`  constrain attempt ${attempt} failed (${e.message.split('\n')[0]}) — reloading the editor for a fresh ontology load`);
    }
  }
  console.log('✓ Disease field constrained to the DOID "disease" branch (live BioPortal)');

  step = 'save-template';
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: 'Save Template' }).click();
  await page.getByText(/has been (created|updated)/i).first().waitFor({ timeout: 20_000 });
  await page.waitForURL(/\/templates\/edit\//, { timeout: 20_000 });
  step = 'repeat-template-update';
  await verifyRepeatedTemplateUpdates(page);
  // Confirm it is listed inside the folder.
  let templateListed = false;
  for (let poll = 1; poll <= 6 && !templateListed; poll++) {
    await gotoListing(page, folderId);
    if (await row(page, TEMPLATE_NAME).count()) templateListed = true;
    else await page.waitForTimeout(1500);
  }
  if (!templateListed) throw new Error(`template "${TEMPLATE_NAME}" never appeared in the folder`);
  console.log(`✓ template created in folder: ${TEMPLATE_NAME}`);

  // 3b. Populate the template and confirm the constrained Disease field offers a
  //     live DOID suggestion (type a disease, verify a matching term appears). The
  //     instance is not saved, so teardown stays a simple template + folder delete.
  step = 'populate-suggestions';
  await openPopulate(page, folderId, TEMPLATE_NAME);
  await page.waitForTimeout(1200);
  await verifyDiseaseSuggestion(page, 'asthma');
  console.log('✓ populate: Disease field suggested a DOID term for "asthma"');
  const deployedCeeVersion = await readCeeVersion(page);
  console.log(`✓ Metadata Editor rendered with CEE ${deployedCeeVersion}`);

  // Fill the plain text field too, so the instance carries free text alongside the controlled term
  // and the re-edit step has something to change.
  step = 'fill-text-field';
  await fillCeeTextField(page, TEXT_FIELD_NAME, 'initial notes');
  console.log(`✓ filled the "${TEXT_FIELD_NAME}" text field`);

  // 3b-ii. Save the populated instance from the Metadata Editor and confirm it is created. This
  //        exercises the V2/embeddable-editor save path end to end — the one that once threw a stack
  //        trace on a new instance's null @id and saved nothing.
  step = 'save-instance';
  await page.waitForTimeout(500);
  const savedInstance = await saveInstanceInEditor(page);
  console.log(`✓ Metadata Editor saved the populated instance (create → 201, redirected to edit)`);

  // 3b-iii. Re-edit through the post-save redirect (which must render, then update).
  step = 're-edit-instance';
  await reEditInstance(page, 'edited notes');
  console.log('✓ Metadata Editor rendered the post-save edit view, re-edited, and updated');

  // 3b-iv. The deployed CEE offers the instance in both formats, from getters a host
  //        cannot configure away: currentMetadata as JSON and currentMetadataYaml as a
  //        string, each carrying the value just saved. The second half builds its own
  //        element, so it needs the template this instance is based on: the live editor
  //        names it, and the REST token already in hand fetches it.
  step = 'both-serializations';
  const basedOn = await page.evaluate(
    () => document.querySelector('cedar-embeddable-editor').currentMetadata['schema:isBasedOn']);
  const templateResp = await restCall(user1.auth, 'GET', `/templates/${enc(basedOn)}`);
  if (templateResp.status !== 200) {
    throw new Error(`could not fetch the template under test: ${templateResp.status} ${templateResp.text}`);
  }
  await verifySerializationConfig(page, 'edited notes', templateResp.body);
  console.log('✓ deployed CEE offers the instance as both JSON and YAML, from getters a host cannot configure away');

  // 3c. Publish the template to OpenView, then confirm an anonymous visitor — a
  //     fresh browser with no CEDAR session — sees it presented on the OpenView
  //     site (its name in the title bar, its Disease field rendered). This exercises
  //     the make-open command, the OpenView server's anonymous read, and OpenView's
  //     CEE-based rendering end to end.
  step = 'enable-openview';
  const templateId = await enableOpenView(page, folderId, TEMPLATE_NAME);
  console.log(`✓ OpenView enabled on the template`);

  step = 'verify-openview';
  const openViewCeeVersion = await verifyPresentedInOpenView(browser, templateId);
  if (openViewCeeVersion !== deployedCeeVersion) {
    throw new Error(`CEE version mismatch: Metadata Editor has ${deployedCeeVersion}, OpenView has ${openViewCeeVersion}`);
  }
  console.log(`✓ OpenView presents the template anonymously with CEE ${openViewCeeVersion}`);

  // 4. Delete the saved instance, then the template, then the (now empty) folder, verifying each.
  //    The instance goes first because it lives in the folder and a non-empty folder cannot be
  //    deleted. Deleting an open artifact is allowed and removes it from OpenView too, so no need
  //    to disable OpenView first.
  // Delete the instance over REST by id (robust across the post-save navigation, and independent of
  // its display name); the template and folder follow.
  step = 'delete-instance';
  const deleteInstance = await restMutate(user1.auth, 'DELETE',
      `/template-instances/${enc(savedInstance.id)}`);
  if (deleteInstance.status !== 204 && deleteInstance.status !== 200) {
    throw new Error(`instance DELETE answered ${deleteInstance.status}: ${deleteInstance.text}`);
  }
  console.log('✓ instance deleted');

  step = 'delete-template';
  await deleteRow(page, TEMPLATE_NAME, folderId);
  console.log('✓ template deleted');

  // The standalone field was seeded over REST, so tear it down the same way. The working folder
  // stays: it is `Smoke Tests` in the home folder and every run shares it.
  step = 'delete-standalone-field';
  const deleteField = await restMutate(user1.auth, 'DELETE',
      `/template-fields/${enc(standaloneFieldId)}`);
  if (deleteField.status !== 204 && deleteField.status !== 200) {
    throw new Error(`standalone-field DELETE answered ${deleteField.status}: ${deleteField.text}`);
  }
  console.log('✓ standalone field deleted');

  step = 'verify-folder-cleared';
  await assertWorkingFolderCleared(user1, folderId, [savedInstance.id, templateId, standaloneFieldId]);
  console.log(`✓ "${FOLDER_NAME}" holds none of this run's artifacts`);

  console.log(`\nPASS [CEE ${deployedCeeVersion}]: login (reusable session) → conditional Workspace mutations → "${FOLDER_NAME}" folder + seeded field → template w/ DOID + text field → two conditional saves without reload → populate + fill → save instance → re-edit (update) → both serializations (JSON/YAML) → OpenView presented anonymously → conditional delete → folder cleared`);
  await browser.close();
  process.exit(0);
} catch (e) {
  await mkdir(FAIL_DIR, { recursive: true });
  const shotPath = resolve(FAIL_DIR, `${step}-${Date.now()}.png`);
  await page.screenshot({ path: shotPath }).catch(() => {});
  console.error(`\nFAIL at step "${step}": ${e.message}`);
  console.error(`screenshot: ${shotPath}`);
  if (cleanupUser1 && mutationGroupId) {
    await mutateGroup(cleanupUser1.auth, 'DELETE', `/groups/${enc(mutationGroupId)}`).catch(() => {});
  }
  if (cleanupUser1 && mutationFolderId) {
    await restMutate(cleanupUser1.auth, 'DELETE', `/folders/${enc(mutationFolderId)}`).catch(() => {});
  }
  await browser.close();
  process.exit(1);
}
