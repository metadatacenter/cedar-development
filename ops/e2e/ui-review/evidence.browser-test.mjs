import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {captureState} from './evidence.mjs';

// Needs only a Playwright Chromium; no CEDAR stack.
test('capture records declared regions, including shadow content, and names those that matched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-evidence-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  const page = await browser.newPage({viewport: {width: 800, height: 600}});
  await page.setContent(`<!doctype html><meta charset="utf-8"><nav class="paging"><button>Next</button></nav><div id="host"></div>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<section class="pager-container"><button>2</button></section>';</script>`);
  const states = [], actions = [];
  await captureState({page, directory, states, actions, flush: async () => {}, fullPage: false,
    regions: ['.paging', '.pager-container', '.renamed-region']}, 'sample', 'Static page');
  assert.deepEqual(states[0].regionsMatched, ['.paging', '.pager-container']);
  const metrics = JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'));
  assert.deepEqual(metrics.regions.map(region => region.selector), ['.paging', '.pager-container']);
  assert.ok(metrics.controls.some(control => control.label === '2' && control.pointerTarget?.belongsToControl));
  assert.deepEqual((await readdir(directory)).sort(), ['sample.aria.yml', 'sample.json', 'sample.png']);
  await assert.rejects(captureState({page, directory, states, actions, flush: async () => {}, regions: []}, 'sample'),
    /duplicate/);
});
