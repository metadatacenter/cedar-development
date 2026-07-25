// End-to-end smoke test against a running CEDAR stack: log in through the real
// Keycloak form, create a folder on the dashboard, verify it appears, delete it.
//
//   npm run smoke              headless
//   npm run smoke:headed       watch it in a real browser
//
// Requires the local stack to be up (frontend, resource, user, group at least):
//   cedar-services.sh status
//
// Credentials and base URL come from the CEDAR profile environment
// (CEDAR_FRONTEND_local_USER1_LOGIN / _PASSWORD, CEDAR_HOST), with the standard
// local-dev values as fallbacks. Exit code 0 = pass; on failure a screenshot is
// written to failures/.
//
// The dashboard gestures (row lookup, menus, delete confirmation) mirror the
// selectors verified by the tutorial runner (cedar-tutorial/runner/lib.mjs).
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

const FOLDER_NAME = `E2E Smoke ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

// ── dashboard helpers (selectors verified by the tutorial runner) ───────────
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
    await page.goto(`${BASE}/dashboard`);
    await page.getByRole('button', { name: 'New' }).click();
    await menuItem(page, 'Folder');
    const dialog = page.getByRole('dialog').or(page.locator('.modal'));
    await dialog.getByRole('textbox').fill(FOLDER_NAME);
    await dialog.getByRole('button', { name: 'Save' }).click();
    for (let poll = 1; poll <= 6; poll++) {
      await page.goto(`${BASE}/dashboard`);
      await page.getByRole('button', { name: 'New' }).waitFor();
      await page.waitForTimeout(500);
      if (await row(page, FOLDER_NAME).count()) { created = true; break; }
      await page.waitForTimeout(1500);
    }
    if (!created) console.warn(`  folder create attempt ${attempt} did not appear — retrying`);
  }
  if (!created) throw new Error(`folder "${FOLDER_NAME}" never appeared on the dashboard`);
  console.log(`✓ folder created: ${FOLDER_NAME}`);

  // 3. Delete it again, and confirm it is gone. The whole gesture retries: the
  //    row menu is an Angular dropdown that binds its handlers asynchronously,
  //    and a click that lands too early fires the anchor's href instead of the
  //    action — silently, with no request ever sent.
  step = 'delete-folder';
  let gone = false;
  for (let attempt = 1; attempt <= 3 && !gone; attempt++) {
    await page.goto(`${BASE}/dashboard`);
    await page.getByRole('button', { name: 'New' }).waitFor();
    if (!(await row(page, FOLDER_NAME).count())) { gone = true; break; }
    try {
      await openRowMenu(page, FOLDER_NAME);
      await menuItem(page, 'Delete');
      await page.getByRole('button', { name: 'Yes, delete it!' })
          .click({ timeout: 10_000 });
    } catch {
      console.warn(`  delete gesture attempt ${attempt} did not reach the confirm dialog — retrying`);
      continue;
    }
    for (let poll = 1; poll <= 4 && !gone; poll++) {
      await page.goto(`${BASE}/dashboard`);
      await page.getByRole('button', { name: 'New' }).waitFor();
      await page.waitForTimeout(500);
      if (!(await row(page, FOLDER_NAME).count())) gone = true;
      else await page.waitForTimeout(1500);
    }
    if (!gone) console.warn(`  folder still listed after delete attempt ${attempt} — retrying`);
  }
  if (!gone) throw new Error(`folder "${FOLDER_NAME}" still listed after deletion`);
  console.log('✓ folder deleted');

  console.log('\nPASS: login → create folder → delete folder');
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
