import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForPage, tabKey} from './interactions.mjs';

const navigation = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
test('navigation replacement retries only the readiness read until it is true', async () => {
  let reads = 0;
  await waitForPage({evaluate: async () => {
    if (++reads <= 2) throw navigation();
    return reads >= 4;
  }}, () => false, undefined, {interval: 1});
  assert.equal(reads, 4);
});
test('navigation replacement retains the original readiness deadline and cause', async () => {
  let reads = 0;
  await assert.rejects(waitForPage({evaluate: async () => {reads++; throw navigation();}}, () => false, undefined, {timeout: 0}), error => {
    assert.match(error.message, /did not become true within 0ms/);
    assert.match(error.cause.message, /Execution context was destroyed/);
    return true;
  });
  assert.equal(reads, 1);
});
test('predicate errors and closed pages are not treated as navigation', async () => {
  for (const message of ['TypeError: broken predicate', 'Target page, context or browser has been closed']) {
    let reads = 0;
    await assert.rejects(waitForPage({evaluate: async () => {reads++; throw new Error(message);}}, () => false), error => error.message === message);
    assert.equal(reads, 1);
  }
});

test('page readiness cannot finish before the predicate becomes true', async () => {
  let attempts = 0;
  await waitForPage({evaluate: async () => ++attempts >= 3}, () => false, undefined, {interval: 1});
  assert.equal(attempts, 3);
});

test('page readiness fails when the condition never becomes true', async () => {
  await assert.rejects(waitForPage({evaluate: async () => false}, () => false, undefined, {timeout: 0}),
    /did not become true/);
});


test('Safari uses Option-Tab for full keyboard navigation only on macOS', () => {
  const page = engine => ({context: () => ({browser: () => ({browserType: () => ({name: () => engine})})})});
  assert.equal(tabKey(page('webkit'), 'Tab', 'darwin'), 'Alt+Tab');
  assert.equal(tabKey(page('webkit'), 'Shift+Tab', 'darwin'), 'Alt+Shift+Tab');
  assert.equal(tabKey(page('webkit'), 'Tab', 'linux'), 'Tab');
  assert.equal(tabKey(page('chromium'), 'Tab', 'darwin'), 'Tab');
});
