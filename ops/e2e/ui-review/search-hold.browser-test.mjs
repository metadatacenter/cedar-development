import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {holdSearchRequests} from './interactions.mjs';

test('held searches drain before unroute and continue through the existing context guard', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  let guarded = 0;
  await context.route('**/*', async route => {
    if (route.request().method() === 'POST') guarded++;
    await route.fulfill({contentType: 'text/html', body: 'ready'});
  });
  const page = await context.newPage();
  await page.goto('https://fixture.invalid/');
  const held = await holdSearchRequests(page);
  const requested = page.waitForRequest(request => request.method() === 'POST');
  await page.evaluate(() => {window.answer = fetch('/search', {method: 'POST'}).then(response => response.text());});
  await requested;
  await held.waitForSearch();
  assert.equal(guarded, 0, 'search must remain held while loading is captured');
  await held.release();
  assert.equal(await page.evaluate(() => window.answer), 'ready');
  assert.equal(guarded, 1, 'the original context guard still receives the released request');
  assert.equal(await page.evaluate(() => fetch('/search', {method: 'POST'}).then(response => response.text())), 'ready');
  assert.equal(guarded, 2, 'later searches are no longer held');
});
