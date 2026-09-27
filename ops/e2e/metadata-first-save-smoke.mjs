// The combined application's metadata editor keeps its editor through a first save.
//
// A first save rewrites the address from the create URL to the edit URL and goes on editing the
// same form. When the rewrite bypassed AngularJS, the next digest noticed it and ngRoute rebuilt the
// view. The rebuilt controller then looked for the editor while the outgoing view was still
// leaving, found the outgoing one, and left its own editor unconfigured and empty. Whether the
// outgoing view had gone by then depended on frame timing, so the form came back blank only some of
// the time.
//
// This journey takes the timing away. Removal of any element holding an editor is held back for
// 300 ms, as a slow leave animation would hold it, which made the old failure certain. It then
// proves the save kept the page: the address is the edit URL, the typed value is still in the form,
// no second editor was ever created, and the next save updates the instance rather than creating
// another.
//
//   npm run smoke:first-save
//
// Needs the local stack (frontend, resource, user, artifact). Credentials and base URL come from the
// CEDAR profile environment, with the local-development values as fallbacks.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import * as S from './selectors.mjs';
import { actors, call, mutate, enc } from './rest/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CEDAR_BASE ?? `https://cedar.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
const USER = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const PASSWORD = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const VALUE = 'first-save smoke value';

const { user1 } = await actors();
const folderId = user1.profile.homeFolderId;
let templateId = null;
let instanceId = null;
const browser = await chromium.launch({ headless: !process.env.HEADED });

try {
  const template = JSON.parse(readFileSync(resolve(HERE, 'fixtures', 'freeze-template.json'), 'utf8'));
  template['schema:name'] = `First-save smoke ${RUN}`;
  const created = await call(user1.auth, 'POST', `/templates?folder_id=${enc(folderId)}`, template);
  assert.equal(created.status, 201, `the fixture template could not be created: ${created.status}`);
  templateId = created.body['@id'];

  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  // gulp's livereload script cannot load over https and blocks the page; see login-smoke-test.mjs.
  await context.route('**://*:35729/**', (route) => route.abort());
  await context.addInitScript(() => {
    const removeChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function (child) {
      if (child && child.querySelector && child.querySelector('cedar-embeddable-editor')) {
        setTimeout(() => removeChild.call(this, child), 300);
        return child;
      }
      return removeChild.call(this, child);
    };
    // Every editor element the page ever creates, so a rebuilt view cannot go unnoticed.
    window.__editorsCreated = 0;
    new MutationObserver(() => {
      document.querySelectorAll('cedar-embeddable-editor:not([data-counted])').forEach((editor) => {
        editor.setAttribute('data-counted', '');
        window.__editorsCreated += 1;
      });
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/instances/create/${enc(templateId)}?folderId=${enc(folderId)}`);
  await page.locator(S.KC_USERNAME).first().waitFor({ timeout: 30_000 });
  await page.locator(S.KC_USERNAME).first().fill(USER);
  await page.locator(S.KC_PASSWORD).first().fill(PASSWORD);
  await page.locator(S.KC_SUBMIT).first().click();

  const cee = page.locator('cedar-embeddable-editor');
  const field = cee.getByLabel('Text Field', { exact: true }).first();
  await field.waitFor({ timeout: 30_000 });
  await field.fill(VALUE);

  const create = page.waitForResponse((r) => /\/template-instances(\?|$)/.test(r.url()) && r.request().method() === 'POST');
  await page.locator('#button-save-metadata').click();
  assert.equal((await create).status(), 201, 'the first save did not create the instance');
  await page.waitForURL(/\/instances\/edit\//, { timeout: 20_000 });
  instanceId = decodeURIComponent(page.url().match(/\/instances\/edit\/(.+?)(?:\?|$)/)[1]);
  // Past the held removal, so a rebuilt view would have had its chance to replace the editor.
  await page.waitForTimeout(1500);

  assert.equal(await page.evaluate(() => window.__editorsCreated), 1, 'the first save rebuilt the view');
  assert.equal(await field.inputValue(), VALUE, 'the form lost the typed value after the first save');

  await field.fill(`${VALUE}, updated`);
  const update = page.waitForResponse((r) => r.url().includes('/template-instances/') && r.request().method() === 'PUT');
  await page.locator('#button-save-metadata').click();
  assert.equal((await update).status(), 200, 'the second save did not update the saved instance');
  const stored = await call(user1.auth, 'GET', `/template-instances/${enc(instanceId)}`);
  assert.equal(stored.body['Text Field']?.['@value'], `${VALUE}, updated`);

  console.log('PASS: the first save kept the editor, its value and the page, and the next save updated the instance');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (instanceId) await mutate(user1.auth, 'DELETE', `/template-instances/${enc(instanceId)}`).catch(() => {});
  if (templateId) await mutate(user1.auth, 'DELETE', `/templates/${enc(templateId)}`).catch(() => {});
}
