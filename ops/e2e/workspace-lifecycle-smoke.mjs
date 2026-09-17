// Authentication and retired-route coverage. Uses only the local test account.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const mode = process.argv[2] || 'messaging';
assert.ok(['messaging', 'logout', 'all'].includes(mode));
const base = process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
const browser = await chromium.launch({headless: !process.env.HEADED});
const context = await browser.newContext({ignoreHTTPSErrors: true});
const page = await context.newPage();
page.setDefaultTimeout(25000);
const errors = [], messaging = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => {if(new URL(r.url()).hostname.startsWith('messaging.')) messaging.push(r.url());});
async function login() {
 await page.locator('#username, .destinations').first().waitFor();
 if(await page.locator('#username').isVisible()) {
  await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || 'test1@test.com');
  await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || 'test1');
  await page.locator('#kc-login').click();
 }
 await page.locator('.destinations').waitFor();
 assert.equal(await page.evaluate(() => typeof window.angular), 'undefined');
}
try {
 await page.goto(base + '/messaging');await login();
 assert.equal(new URL(page.url()).pathname, '/dashboard');
 assert.equal(await page.getByRole('link', {name: 'Messaging', exact: true}).count(), 0);
 assert.deepEqual(messaging, []);
 console.log('PASS: retired Messaging route returns to Angular Workspace without messaging requests');
 assert.deepEqual(errors, []);
} finally {await browser.close();}
