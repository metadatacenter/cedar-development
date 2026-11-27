import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {calibrationScreenshot} from './calibration-screenshot.mjs';

test('a failed screenshot is recovered on the same rendered page without replaying its action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calibration-screenshot-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(root, {recursive: true, force: true});});
  const page = await browser.newPage();
  await page.setContent('<button onclick="this.textContent = Number(this.textContent) + 1">0</button><input value="original">');
  await page.locator('button').click();
  await page.locator('input').fill('edited');
  const screenshot = page.screenshot.bind(page), events = [];
  let shots = 0;
  page.screenshot = async options => {
    if (++shots === 1) throw new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
    return screenshot(options);
  };
  const path = join(root, 'after.png');
  await calibrationScreenshot(page, path, {onEvent: async e => events.push(e)});
  assert.equal(shots, 2);
  assert.equal(await page.locator('button').textContent(), '1');
  assert.equal(await page.locator('input').inputValue(), 'edited');
  assert((await stat(path)).size > 0);
  assert.deepEqual(events.map(e => e.outcome), ['failed', 'recovered']);
  // A value-property change is invisible to outerHTML but must still prohibit recovery.
  page.screenshot = async () => {
    await page.locator('input').fill('changed after failure');
    throw new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
  };
  await assert.rejects(calibrationScreenshot(page, join(root, 'changed.png')), /state changed/);
});
