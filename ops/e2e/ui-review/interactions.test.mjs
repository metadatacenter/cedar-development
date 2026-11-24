import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForPage, tabKey} from './interactions.mjs';

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
