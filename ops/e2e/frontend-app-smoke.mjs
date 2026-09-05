// Browser smoke for the two Angular applications the other smokes never open.
//
// The credential-free cache smoke proves the origins answer, and the full
// journey drives the workbench and OpenView. Monitoring and Bridging sit behind
// Keycloak with nothing driving them, so a framework upgrade could blank either
// one and every gate would stay green: Angular 22 did exactly that to OpenView,
// building clean and then dying at bootstrap with an injector error.
//
// This opens each application as a real user and waits for content only its own
// components can produce, then fails on the console errors that mean a broken
// application rather than a noisy one.
//
//   ../cedar-services.sh status        # the stack has to be up
//   npm run smoke:frontend-app
//
// Both applications use Keycloak's check-sso, so the session is established on
// first visit and shared by the second through the auth origin's cookies.
// Override the origins with CEDAR_MONITORING_BASE and CEDAR_BRIDGING_BASE, the
// user with CEDAR_FRONTEND_local_USER1_LOGIN and _PASSWORD, and set HEADED=1 to
// watch it.

import { chromium } from 'playwright';
import * as S from './selectors.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const host = process.env.CEDAR_HOST ?? 'metadatacenter.orgx';
const withoutTrailingSlash = value => value.replace(/\/$/, '');

const applications = [
  {
    name: 'Monitoring',
    base: withoutTrailingSlash(process.env.CEDAR_MONITORING_BASE ?? `https://monitoring.${host}`),
    // The dashboard's Material cards, one per monitoring page.
    marker: 'Health Checks',
  },
  {
    name: 'Bridging',
    base: withoutTrailingSlash(process.env.CEDAR_BRIDGING_BASE ?? `https://bridging.${host}`),
    // Bridging's landing card, which explains that the flow starts in CEDAR.
    marker: 'Create Datacite DOI',
    // The editor is loaded by tag rather than bundled into the application, so
    // its registration is the only thing proving the tag still resolves.
    customElement: 'cedar-embeddable-editor',
  },
];

const user = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const password = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const headed = !!process.env.HEADED;

// A console error naming one of these is the application failing to run, not a
// page being noisy. NG0201 is the injector error that blanked OpenView.
const FATAL = /NG0\d{3}|NullInjector|is not a known element|TypeError|ReferenceError|Cannot read propert/;

const failures = [];
const fail = message => {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
};
const ok = what => console.log(`  ok  ${what}`);

async function openApplication(page, app) {
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(String(error)));

  await page.goto(app.base, { waitUntil: 'domcontentloaded' });

  const loginForm = page.locator(S.KC_USERNAME).first();
  // A Material card title, which is a div rather than a heading, so it is
  // addressed by element and text rather than by role.
  const marker = page.locator('mat-card-title', { hasText: app.marker });
  const seen = await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'login').catch(() => null),
    marker.first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'rendered').catch(() => null),
  ]);

  if (seen === 'login') {
    await loginForm.fill(user);
    await page.locator(S.KC_PASSWORD).first().fill(password);
    await page.locator(S.KC_SUBMIT).first().click();
  } else if (seen !== 'rendered') {
    fail(`${app.name}: neither the Keycloak form nor the application appeared at ${app.base}`);
    return;
  }

  try {
    await marker.first().waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    fail(`${app.name}: never rendered a ${JSON.stringify(app.marker)} card`);
    return;
  }
  ok(`${app.name} renders its ${JSON.stringify(app.marker)} card for a signed-in user`);

  if (await page.locator('app-header').count() === 0) {
    fail(`${app.name}: rendered its dashboard without its own header`);
  } else {
    ok(`${app.name} draws its header`);
  }

  if (app.customElement) {
    const registered = await page.evaluate(
      name => !!customElements.get(name), app.customElement);
    if (registered) {
      ok(`${app.name} registers <${app.customElement}>`);
    } else {
      fail(`${app.name}: <${app.customElement}> is not registered, so its bundle did not load`);
    }
  }

  const fatal = consoleErrors.filter(text => FATAL.test(text));
  const noise = consoleErrors.filter(text => !FATAL.test(text));
  if (fatal.length > 0) {
    fail(`${app.name}: ${fatal.length} console error(s) the application cannot run through`);
    for (const text of fatal.slice(0, 5)) console.error(`        ${text.split('\n')[0]}`);
  } else {
    ok(`${app.name} reaches its dashboard with no fatal console error`);
  }
  for (const text of noise.slice(0, 3)) console.log(`  note: ${app.name}: ${text.split('\n')[0]}`);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
});
// The workbench's livereload socket is not part of this contract.
await context.route('**://*:35729/**', route => route.abort());

try {
  for (const app of applications) {
    console.log(`\n${app.name} — ${app.base}`);
    const page = await context.newPage();
    try {
      await openApplication(page, app);
    } finally {
      await page.close();
    }
  }
} finally {
  await context.close();
  await browser.close();
}

console.log('');
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s) in the Monitoring and Bridging applications`);
  process.exit(1);
}
console.log('PASS: Monitoring and Bridging both sign in and render their own dashboards');
