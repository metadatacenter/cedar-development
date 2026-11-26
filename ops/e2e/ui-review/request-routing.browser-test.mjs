import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {holdSearchRequests, refuseConnections, staleRevision} from './interactions.mjs';

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

test('a stale revision reaches the context guard one revision back, and a refused origin gets no answer', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const seen = [];
  await context.route('**/*', async route => {
    seen.push(route.request().headers()['if-match'] ?? null);
    await route.fulfill({contentType: 'text/html', body: 'ready'});
  });
  const page = await context.newPage();
  await page.goto('https://fixture.invalid/');
  const session = {page, expectedNetworkFailures: new Set()};
  const put = tag => page.evaluate(tag => fetch('/item', {method: 'PUT', headers: tag ? {'If-Match': tag} : {}}).then(r => r.text()), tag);
  const restoreRevision = await staleRevision(session, '**/item', 'stale');
  assert.equal(await put('"7-abc"'), 'ready');
  assert.equal(await put(null), 'ready');
  assert.deepEqual(seen.slice(-2), ['"6"', null], 'only a conditional write is sent one revision back');
  assert.ok(session.expectedNetworkFailures.has('stale'));
  await restoreRevision();
  assert.equal(await put('"7-abc"'), 'ready');
  assert.equal(seen.at(-1), '"7-abc"');
  assert.equal(session.expectedNetworkFailures.size, 0);
  const restoreConnection = await refuseConnections(session, ['https://fixture.invalid/api'], 'refused');
  const before = seen.length;
  assert.equal(await page.evaluate(() => fetch('/item').then(() => 'answered', () => 'failed')), 'failed');
  assert.equal(seen.length, before, 'a refused request never reaches the context');
  await restoreConnection();
  assert.equal(await page.evaluate(() => fetch('/item').then(r => r.text())), 'ready');
});
