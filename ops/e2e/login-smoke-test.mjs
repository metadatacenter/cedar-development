// End-to-end smoke test against a running CEDAR stack: log in through the real
// Keycloak form, create a folder, create a template inside it with a Disease field
// constrained to the DOID "disease" branch via the live BioPortal picker, populate
// the template and confirm the field suggests a live DOID term, then delete the
// template and the folder — verifying each step.
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
// The dashboard gestures (row lookup, menus, delete confirmation, template
// save) mirror the selectors verified by the tutorial runner
// (cedar-tutorial/runner/lib.mjs and steps.mjs).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_DIR = resolve(__dirname, 'failures');

const BASE = process.env.CEDAR_BASE
  ?? `https://cedar.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
const USER = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const PASSWORD = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const HEADED = !!process.env.HEADED;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FOLDER_NAME = `E2E Smoke ${RUN_ID}`;
const TEMPLATE_NAME = `E2E Smoke Template ${RUN_ID}`;

// ── dashboard helpers (selectors verified by the tutorial runner) ───────────
const enc = iri => encodeURIComponent(iri);

const row = (page, title) => page.locator('div.resource-instance', {
  has: page.getByText(title, { exact: true }),
}).first();

async function menuItem(page, label) {
  await page.locator(`a:text-is(${JSON.stringify(label)}):visible`).first().click();
}

async function openRowMenu(page, title) {
  const r = row(page, title);
  await r.scrollIntoViewIfNeeded();
  await r.locator('button.more-button').click();
  await page.waitForTimeout(800); // let the Angular dropdown bind its handlers
}

// Navigate to a listing (the dashboard root, or a folder when folderId given)
// and wait until it is interactive.
async function gotoListing(page, folderId) {
  const url = folderId ? `${BASE}/dashboard?folderId=${enc(folderId)}` : `${BASE}/dashboard`;
  await page.goto(url);
  await page.getByRole('button', { name: 'New' }).waitFor();
  await page.waitForTimeout(500);
}

// Delete a row by name, retrying the whole gesture: the row menu is an Angular
// dropdown that binds its handlers asynchronously, and a click that lands too
// early fires the anchor's href instead of the action — silently, with no
// request ever sent.
async function deleteRow(page, name, folderId) {
  // Retry budget is generous on purpose: right after a full stack restart the
  // search index that backs the listing lags the delete by tens of seconds, so
  // the row can stay visible well after the backend has removed it. 5 gesture
  // attempts x 8 polls x 1.5s ~= 60s of tolerance before we call it a failure.
  for (let attempt = 1; attempt <= 5; attempt++) {
    await gotoListing(page, folderId);
    if (!(await row(page, name).count())) return;
    try {
      await openRowMenu(page, name);
      await menuItem(page, 'Delete');
      await page.getByRole('button', { name: 'Yes, delete it!' })
          .click({ timeout: 10_000 });
    } catch {
      console.warn(`  delete gesture attempt ${attempt} for "${name}" did not reach the confirm dialog — retrying`);
      continue;
    }
    for (let poll = 1; poll <= 8; poll++) {
      await gotoListing(page, folderId);
      if (!(await row(page, name).count())) return;
      await page.waitForTimeout(1500);
    }
    console.warn(`  "${name}" still listed after delete attempt ${attempt} — retrying`);
  }
  throw new Error(`"${name}" still listed after deletion`);
}

// ── controlled-term helpers (selectors verified by the tutorial runner:
//    cedar-tutorial/runner/steps.mjs + term-steps.mjs) ───────────────────────

// Field-editor inputs bind ng-model-options debounce ~1s; set atomically then wait.
async function setText(loc, value) {
  await loc.click();
  await loc.fill(value);
  await loc.page().waitForTimeout(1100);
}

// Add a plain text field on the open template designer and name it.
async function addTextField(page, name, help) {
  await page.locator('a:has(i.fa-font)').click(); // text field palette icon
  await setText(page.getByRole('textbox', { name: 'Enter Field Name' }).last(), name);
  if (help) await setText(page.getByRole('textbox', { name: 'Enter Field Help Text' }).last(), help);
}

// Constrain the just-added text field to the "disease" BRANCH of DOID via the live
// BioPortal picker: Values tab → Add → gear → ontology mode → search the ontology →
// select DOID → pick the "disease" tree node → stage Branch → Add. This exercises
// the terminology server's live ontology search and class-tree browse end to end.
async function constrainToDoidDiseaseBranch(page) {
  const rowText = 'Human Disease Ontology (DOID)';
  await page.locator("[ng-click*=\"setTab('values')\"]").filter({ visible: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Add', exact: true }).click(); // open the picker
  await page.waitForTimeout(800);
  await page.locator('i.fa-cog').first().click();                       // advanced options
  // The mode radio is a hidden/styled input whose AngularJS ng-change only fires on a
  // real DOM click; check({force}) and coordinate clicks don't trigger it, leaving the
  // picker in term mode. Dispatch a DOM click straight at the element (verified to switch
  // tsc.searchScope to 'ontologies').
  await page.locator('#search-scope-2').dispatchEvent('click');        // "search for an ontology"
  await page.waitForTimeout(500);
  await page.getByRole('textbox', { name: 'Search field' }).fill('Human Disease Ontology');
  // The ontology list loads on demand (a ~600KB BioPortal-backed call, filtered client-side), so
  // the first search can run against an empty cache and show "No results". BioPortal is slow and
  // flaky, and the load is slowest right after a stack restart, so re-run the search generously
  // (~4 min) before giving up.
  const doidRow = page.getByText(rowText, { exact: false }).first();
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    await page.locator('i.fa-search').last().click();                   // run the search
    try { await doidRow.waitFor({ timeout: 5000 }); found = true; }
    catch { await page.waitForTimeout(2000); }
  }
  if (!found) throw new Error('DOID did not appear in the ontology picker — the ontology list may be empty');
  await doidRow.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);                                      // DOID class tree loads
  const node = page.locator('[ng-click*="getClassDetailsCallback"]')
    .filter({ hasText: /^\s*disease\s*$/i }).first();                   // the DOID:4 root branch
  await node.waitFor({ timeout: 20_000 });
  await node.click();
  await page.waitForTimeout(1500);
  await page.locator('[ng-click*="stageBranchValueConstraint"]').first().click(); // stage Branch
  await page.waitForTimeout(400);
  await page.locator("[ng-click*='addValueConstraint']").first().click({ force: true }); // commit
  await page.locator('[ng-click*="stageBranchValueConstraint"]')
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
  const box = page.locator('input[placeholder="Start typing to filter"]').first();
  await box.waitFor({ timeout: 20_000 });
  const opt = page.getByRole('option', { name: new RegExp(query, 'i') })
    .or(page.locator('mat-option', { hasText: new RegExp(query, 'i') }));
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

// ─────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  ignoreHTTPSErrors: true, // local CA
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
let step = 'init';

try {
  // 1. Login through Keycloak. The app redirects unauthenticated visitors to
  //    the Keycloak form; the "New" button only exists once authenticated.
  step = 'login';
  await page.goto(`${BASE}/dashboard`);
  await page.locator('#username, input[name="username"]').first().fill(USER);
  await page.locator('#password, input[name="password"]').first().fill(PASSWORD);
  await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click();
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 60_000 });
  console.log(`✓ logged in as ${USER}`);

  // 2. Create the folder. CEDAR occasionally answers with a transient server
  //    error, and a fresh folder can lag the listing via indexing — so retry
  //    the gesture and poll for the row (pattern proven by the tutorial runner).
  step = 'create-folder';
  let created = false;
  for (let attempt = 1; attempt <= 3 && !created; attempt++) {
    await gotoListing(page);
    await page.getByRole('button', { name: 'New' }).click();
    await menuItem(page, 'Folder');
    const dialog = page.getByRole('dialog').or(page.locator('.modal'));
    await dialog.getByRole('textbox').fill(FOLDER_NAME);
    await dialog.getByRole('button', { name: 'Save' }).click();
    for (let poll = 1; poll <= 6; poll++) {
      await gotoListing(page);
      if (await row(page, FOLDER_NAME).count()) { created = true; break; }
      await page.waitForTimeout(1500);
    }
    if (!created) console.warn(`  folder create attempt ${attempt} did not appear — retrying`);
  }
  if (!created) throw new Error(`folder "${FOLDER_NAME}" never appeared on the dashboard`);

  // Enter the folder to learn its id (needed for the template deep link).
  await row(page, FOLDER_NAME).dblclick();
  await page.waitForURL(/folderId=/);
  const folderId = decodeURIComponent(new URL(page.url()).searchParams.get('folderId'));
  console.log(`✓ folder created: ${FOLDER_NAME}`);

  // 3. Create a template inside the folder via the designer deep link, name
  //    it, and save (the toast confirms server-side creation).
  step = 'create-template';
  await page.goto(`${BASE}/templates/create?folderId=${enc(folderId)}`);
  await page.getByRole('textbox', { name: 'Name' }).fill(TEMPLATE_NAME);
  await page.waitForTimeout(1100); // flush the debounced name edit

  // 3a. Add a Disease field and constrain it to the DOID "disease" branch through
  //     the live BioPortal picker (exercises the terminology server end to end).
  step = 'constrain-disease-field';
  await addTextField(page, 'Disease', 'The disease studied, from the Human Disease Ontology');
  await constrainToDoidDiseaseBranch(page);
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

  // 4. Delete the template, then the (now empty) folder, verifying each.
  step = 'delete-template';
  await deleteRow(page, TEMPLATE_NAME, folderId);
  console.log('✓ template deleted');

  step = 'delete-folder';
  await deleteRow(page, FOLDER_NAME);
  console.log('✓ folder deleted');

  console.log('\nPASS: login → folder → template w/ DOID-constrained Disease field → populate suggestion → delete');
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
