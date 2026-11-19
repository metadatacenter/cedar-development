import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {automaticChecks, layoutViolations, summarizeChecks} from './automatic-checks.mjs';
import {captureState} from './evidence.mjs';

// Needs only a Playwright Chromium; no CEDAR stack.
async function layout(t, body, viewport = {width: 600, height: 400}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({viewport})).newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/1.4 sans-serif}</style>${body}`);
  return page.evaluate(layoutViolations);
}
const rules = violations => violations.map(v => v.rule).sort();

test('a page wider than its viewport is reported once, at the document', async t => {
  const found = await layout(t, '<div style="width:900px">Wide</div>');
  assert.deepEqual(found.filter(v => v.rule === 'horizontal-page-overflow').map(v => v.target), ['document']);
});

test('text its own box cuts off is reported, but not an ellipsis, a line clamp or visually hidden text', async t => {
  const found = await layout(t, `
    <div class="cut" style="width:60px;overflow:hidden;white-space:nowrap">Participant identifier</div>
    <div class="ellipsis" style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Participant identifier</div>
    <div class="clamp" style="width:80px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1">Participant identifier and more words</div>
    <span class="hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Required field</span>`);
  assert.deepEqual(found.filter(v => v.rule === 'clipped-text').map(v => v.target), ['div.cut']);
});

test('a control the viewport cuts off is reported, unless its region scrolls sideways or it waits wholly off screen', async t => {
  const found = await layout(t, `<style>button{position:absolute;width:120px}</style>
    <button class="cut" style="left:540px;top:0">Save</button>
    <button class="skip" style="left:-9999px;top:0">Skip to content</button>
    <div style="position:absolute;top:60px;width:300px;overflow-x:auto;white-space:nowrap">
      <button class="chip" style="position:static;margin-left:250px">Next page</button></div>`);
  assert.deepEqual(found.filter(v => v.rule === 'control-outside-viewport').map(v => v.target), ['button.cut']);
});

test('text drawn over other text is reported, but not text hidden behind an opaque header or lines set tight', async t => {
  const found = await layout(t, `<style>p{margin:0}</style>
    <div style="position:relative;height:60px"><span class="label" style="position:absolute;left:0;top:10px">Participant identifier</span>
      <span class="value" style="position:absolute;left:40px;top:12px">P-0042 recorded</span></div>
    <div style="position:relative;height:60px"><span class="behind" style="position:absolute;left:0;top:10px">Scrolled row</span>
      <header style="position:absolute;left:0;top:4px;width:300px;height:30px;background:#fff">Sticky header</header></div>
    <p style="line-height:0.9">First line<br><a href="#">second line link</a></p>`);
  assert.deepEqual(found.filter(v => v.rule === 'overlapping-text').map(v => v.target),
    ['div > span.label under div > span.value']);
});

test('text an ellipsis hides is not compared with what lies beyond the ellipsis', async t => {
  const found = await layout(t, `<div style="display:flex;width:400px">
    <span style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Angular Migration, fields only, with a long name</span>
    <time style="margin-left:4px">25 Sept</time></div>`);
  assert.deepEqual(rules(found), []);
});

test('while a dialog is open, the covered page is not compared with the dialog', async t => {
  const found = await layout(t, `<p style="margin:20px">Page text that the dialog covers in part</p>
    <div role="dialog" aria-modal="true" style="position:absolute;left:60px;top:10px;padding:8px;background:transparent">Dialog title text</div>`);
  assert.deepEqual(rules(found), []);
});

test('each captured state keeps its axe and layout results, and the capture groups them across states', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-checks-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  const page = await (await browser.newContext({viewport: {width: 600, height: 400}})).newPage();
  await page.setContent('<!doctype html><html lang="en"><meta charset="utf-8"><title>Sample</title><main><button class="icon"></button></main>');
  const states = [];
  for (const id of ['narrow', 'wide'])
    await captureState({page, directory, states, actions: [], flush: async () => {}, regions: [], fullPage: false}, id);
  const recorded = JSON.parse(await readFile(join(directory, 'narrow.checks.json'), 'utf8'));
  assert.ok(recorded.some(v => v.source === 'axe' && v.rule === 'button-name' && v.target === 'button'));
  assert.equal(states[0].checks, 'narrow.checks.json');
  const summary = await summarizeChecks(directory, 'workspace', states,
    [{app: 'workspace', rule: 'button-name', target: /^button$/, reason: 'Sample exception'}]);
  const group = summary.groups.find(g => g.rule === 'button-name');
  assert.deepEqual(group.states, ['narrow', 'wide']);
  assert.equal(group.exception, 'Sample exception');
  assert.equal((await summarizeChecks(directory, 'designer', states, [])).groups.find(g => g.rule === 'button-name').exception, null);
});

test('checking a page moves neither focus nor scroll position', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({viewport: {width: 400, height: 300}})).newPage();
  await page.setContent('<!doctype html><html lang="en"><title>Sample</title><div style="height:900px"></div><button>Save</button><div style="height:900px"></div>');
  await page.getByRole('button', {name: 'Save'}).focus();
  const before = await page.evaluate(() => [scrollY, document.activeElement.textContent]);
  await automaticChecks(page);
  assert.deepEqual(await page.evaluate(() => [scrollY, document.activeElement.textContent]), before);
});
