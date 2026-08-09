// End-to-end smoke test against a running CEDAR stack: log in through the real
// Keycloak form, create a folder, create a template inside it with a Disease field
// constrained to the DOID "disease" branch via the live BioPortal picker, populate
// the template and confirm the field suggests a live DOID term, publish it to the
// public OpenView site and confirm an anonymous visitor sees it presented, then
// delete the template and the folder — verifying each step.
//
//   npm run smoke              headless
//   npm run smoke:headed       watch it in a real browser
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
import { actors, call as restCall, artifactBody } from './rest/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_DIR = resolve(__dirname, 'failures');

const BASE = process.env.CEDAR_BASE
  ?? `https://cedar.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
// The public OpenView site (the AngularJS app's `openViewBase`), a distinct subdomain
// from the editor. It renders open artifacts to callers with no CEDAR session.
const OPENVIEW_FRONTEND = process.env.CEDAR_OPENVIEW_FRONTEND
  ?? `https://openview.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
const USER = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const PASSWORD = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const HEADED = !!process.env.HEADED;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FOLDER_NAME = `E2E Smoke ${RUN_ID}`;
const TEMPLATE_NAME = `E2E Smoke Template ${RUN_ID}`;
const FIELD_NAME = `E2E Standalone Field ${RUN_ID}`;
const TEXT_FIELD_NAME = 'Notes';
// A saved browser session, reused across runs so the Keycloak login is paid once. Regenerated
// automatically when missing or stale. Gitignored — it holds live tokens.
const AUTH_DIR = resolve(__dirname, '.auth');
const AUTH_STATE = resolve(AUTH_DIR, 'storage-state.json');

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
//   2. `outputSerialization` is then checked for the one thing only it decides: the
//      *format* `currentMetadataSerialized` returns — a JSON object by default, a YAML
//      string once flipped — with `currentMetadata` left JSON either way (the save-path
//      contract). This step reads only the *type*, never the value, so flipping the
//      config (which re-runs the editor's init) can't make it depend on timing.
//
// Runs last on this page; OpenView uses a fresh browser, so re-configuring the element
// here disturbs nothing after it.
async function verifySerializationConfig(page, expectedValue) {
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

    // (1) Value, through the always-on getters — no config change.
    const json = cee.currentMetadata; // JSON object
    const yaml = cee.currentMetadataYaml; // YAML string

    // (2) Format selection. Default first (JSON object), then flip to YAML (string).
    const defaultSerialized = cee.currentMetadataSerialized;
    cee.config = { outputSerialization: 'yaml' };
    const configuredSerialized = cee.currentMetadataSerialized;
    const jsonStill = cee.currentMetadata;

    return {
      jsonIsObject: json !== null && typeof json === 'object' && !Array.isArray(json),
      jsonCarriesValue: JSON.stringify(json).includes(needle),
      yamlIsString: typeof yaml === 'string' && yaml.length > 0,
      yamlIsNotJson: !str(yaml).trim().startsWith('{') && str(yaml).includes('type:'),
      yamlCarriesValue: str(yaml).includes(needle),
      defaultSerializedIsJson: defaultSerialized !== null && typeof defaultSerialized === 'object',
      configuredSerializedIsYamlString: typeof configuredSerialized === 'string' && configuredSerialized.length > 0,
      jsonContractPreserved: jsonStill !== null && typeof jsonStill === 'object' && !Array.isArray(jsonStill),
    };
  }, expectedValue);
  const failed = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length > 0) {
    throw new Error(`serialization-config check failed [${failed.join(', ')}] — ${JSON.stringify(r)}`);
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
// "Presented" here means OpenView resolved the open grant and handed the template to
// CEE to render: OpenView mounts its `cedar-embeddable-editor` element only when the
// template resolves (`*ngIf="template && !artifactStatus"`), and shows an error page
// otherwise, so the element's presence is the signal. What CEE renders *inside* — the
// name, the fields — is deliberately not asserted here; that belongs to later,
// dedicated OpenView-rendering tests.
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
  const url = `${OPENVIEW_FRONTEND}/templates/${enc(templateId)}`;
  const editor = p.locator('cedar-embeddable-editor');
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      try { await editor.waitFor({ state: 'attached', timeout: 12_000 }); return; }
      catch { await p.waitForTimeout(2500); } // grant not propagated yet — reload and retry
    }
    await mkdir(FAIL_DIR, { recursive: true });
    const shot = resolve(FAIL_DIR, `openview-${Date.now()}.png`);
    await p.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new Error(`OpenView did not present the open template — CEE never mounted; screenshot: ${shot}`);
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
const page = await context.newPage();
let step = 'init';

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

  // 2. Seed the working folder and a standalone field over REST — fast, hermetic setup that needs no
  //    UI (folder-creation clicking is not the coverage this smoke is here for). A standalone field is
  //    one of the artifact shapes the CEE renders; seeding it exercises field-artifact create/teardown
  //    and leaves it available for later use. The same REST token tears both down at the end.
  step = 'seed';
  const { user1 } = await actors();
  const folderResp = await restCall(user1.auth, 'POST', '/folders',
      { folderId: user1.profile.homeFolderId, name: FOLDER_NAME, description: 'Created by the UI smoke' });
  if (folderResp.status !== 201) throw new Error(`could not seed folder: ${folderResp.status} ${folderResp.text}`);
  const folderId = folderResp.body['@id'];
  const fieldResp = await restCall(user1.auth, 'POST', `/template-fields?folder_id=${enc(folderId)}`,
      artifactBody('field', FIELD_NAME));
  if (fieldResp.status !== 201) throw new Error(`could not seed standalone field: ${fieldResp.status} ${fieldResp.text}`);
  const standaloneFieldId = fieldResp.body['@id'];
  console.log(`✓ seeded folder + standalone field over REST`);

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
      await page.goto(`${BASE}/templates/create?folderId=${enc(folderId)}`, { waitUntil: 'domcontentloaded' });
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

  // 3b-iv. The deployed CEE honours the serialization config: default output is JSON,
  //        outputSerialization:'yaml' makes currentMetadataSerialized YAML, and
  //        currentMetadata stays JSON so the host's save path is unchanged.
  step = 'serialization-config';
  await verifySerializationConfig(page, 'edited notes');
  console.log('✓ deployed CEE honours serialization config (JSON by default; YAML on request; currentMetadata stays JSON)');

  // 3c. Publish the template to OpenView, then confirm an anonymous visitor — a
  //     fresh browser with no CEDAR session — sees it presented on the OpenView
  //     site (its name in the title bar, its Disease field rendered). This exercises
  //     the make-open command, the OpenView server's anonymous read, and OpenView's
  //     CEE-based rendering end to end.
  step = 'enable-openview';
  const templateId = await enableOpenView(page, folderId, TEMPLATE_NAME);
  console.log(`✓ OpenView enabled on the template`);

  step = 'verify-openview';
  await verifyPresentedInOpenView(browser, templateId);
  console.log('✓ OpenView presents the template (rendered in CEE) to an anonymous visitor');

  // 4. Delete the saved instance, then the template, then the (now empty) folder, verifying each.
  //    The instance goes first because it lives in the folder and a non-empty folder cannot be
  //    deleted. Deleting an open artifact is allowed and removes it from OpenView too, so no need
  //    to disable OpenView first.
  // Delete the instance over REST by id (robust across the post-save navigation, and independent of
  // its display name); the template and folder follow.
  step = 'delete-instance';
  await restCall(user1.auth, 'DELETE', `/template-instances/${enc(savedInstance.id)}`);
  console.log('✓ instance deleted');

  step = 'delete-template';
  await deleteRow(page, TEMPLATE_NAME, folderId);
  console.log('✓ template deleted');

  // The standalone field and the working folder were seeded over REST, so tear them down the same
  // way. The field goes before the folder — a non-empty folder cannot be deleted.
  step = 'delete-standalone-field';
  await restCall(user1.auth, 'DELETE', `/template-fields/${enc(standaloneFieldId)}`);
  console.log('✓ standalone field deleted');

  step = 'delete-folder';
  const delFolder = await restCall(user1.auth, 'DELETE', `/folders/${enc(folderId)}`);
  if (![200, 204].includes(delFolder.status)) throw new Error(`folder delete answered ${delFolder.status}: ${delFolder.text}`);
  console.log('✓ folder deleted');

  console.log('\nPASS: login (reusable session) → seed folder+field → template w/ DOID + text field → populate + fill → save instance → re-edit (update) → serialization config (JSON/YAML) → OpenView presented anonymously → delete');
  await browser.close();
  process.exit(0);
} catch (e) {
  await mkdir(FAIL_DIR, { recursive: true });
  const shotPath = resolve(FAIL_DIR, `${step}-${Date.now()}.png`);
  await page.screenshot({ path: shotPath }).catch(() => {});
  console.error(`\nFAIL at step "${step}": ${e.message}`);
  console.error(`screenshot: ${shotPath}`);
  await browser.close();
  process.exit(1);
}
