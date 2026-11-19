import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {captureState} from './evidence.mjs';
import {keyboard, pointer} from './interactions.mjs';

// Needs only a Playwright Chromium; no CEDAR stack.
test('capture records declared regions, including shadow content, and names those that matched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-evidence-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  const page = await (await browser.newContext({viewport: {width: 800, height: 600}})).newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><nav class="paging"><button>Next</button></nav><div id="host"></div>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<section class="pager-container"><button>2</button></section>';</script>`);
  const states = [], actions = [];
  await captureState({page, directory, states, actions, flush: async () => {}, fullPage: false,
    regions: ['.paging', '.pager-container', '.renamed-region']}, 'sample', 'Static page');
  assert.deepEqual(states[0].regionsMatched, ['.paging', '.pager-container']);
  const metrics = JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'));
  assert.deepEqual(metrics.regions.map(region => region.selector), ['.paging', '.pager-container']);
  assert.ok(metrics.controls.some(control => control.label === '2' && control.pointerTarget?.belongsToControl));
  assert.deepEqual((await readdir(directory)).sort(), ['sample.aria.yml', 'sample.checks.json', 'sample.json', 'sample.png']);
  await assert.rejects(captureState({page, directory, states, actions, flush: async () => {}, regions: []}, 'sample'),
    /duplicate/);
});

test('keyboard stops keep a crop of each focused control, named after the next state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-focus-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  const page = await (await browser.newContext({viewport: {width: 600, height: 400}})).newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0}button{display:block;margin:40px;width:200px;height:60px;border:0;background:#c00}
    button:focus{outline:4px solid #00c}</style><div style="height:900px"></div><button>First</button><button>Second</button><div style="height:900px"></div>`);
  await page.evaluate(() => scrollTo(0, 860));
  const session = {page, directory, pendingCrops: [], actions: [], flush: async () => {}};
  await keyboard(session, page.locator('body'), {stops: 2});
  const states = [];
  await captureState({page, directory, states, actions: session.actions, flush: async () => {}, regions: [], pendingCrops: session.pendingCrops, fullPage: false}, 'tabbed');
  assert.deepEqual(states[0].crops, ['tabbed-focus-1.png', 'tabbed-focus-2.png']);
  assert.deepEqual(session.pendingCrops, []);
  assert.deepEqual(session.actions.map(a => [a.focus.label, a.inViewport]), [['First', true], ['Second', true]]);
  // The crop must show the focused control itself, not whatever sits at its viewport position on an unscrolled page.
  const png = await readFile(join(directory, 'tabbed-focus-1.png'));
  const centre = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3);
  }, 'data:image/png;base64,' + png.toString('base64'));
  // Engines shade a focused control differently, so test its hue: the white page that sits at the same
  // viewport position before scrolling has none.
  const [red, green, blue] = centre;
  assert(red > green + 30 && red > blue + 30, `crop centre ${centre} is not the red control`);
});

test('a touch profile activates a control by tapping its displayed position', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({hasTouch: true, viewport: {width: 400, height: 300}});
  const page = await context.newPage();
  await page.setContent(`<!doctype html><button>Apply</button><p id="status"></p><script>
    const b=document.querySelector('button');b.addEventListener('touchstart',()=>{document.body.dataset.touched='yes'});
    b.addEventListener('click',()=>{document.querySelector('#status').textContent='applied'});</script>`);
  const session = {page, touch: true, actions: [], flush: async () => {}};
  await pointer(session, page.getByRole('button', {name: 'Apply'}));
  assert.equal(await page.locator('#status').textContent(), 'applied');
  assert.equal(await page.evaluate(() => document.body.dataset.touched), 'yes');
});

test('card crops show the visible card on a scrolled page', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-cards-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  const page = await (await browser.newContext({viewport: {width: 600, height: 400}})).newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0}app-field-card{display:block;margin:20px;height:120px;background:#0a0}</style>
    <div style="height:900px;background:#fff"></div><app-field-card></app-field-card><div style="height:900px"></div>`);
  await page.evaluate(() => scrollTo(0, 820));
  const states = [];
  await captureState({page, directory, states, actions: [], flush: async () => {}, regions: [], fullPage: false}, 'scrolled');
  assert.deepEqual(states[0].crops, ['scrolled-card-1.png']);
  const png = await readFile(join(directory, 'scrolled-card-1.png'));
  const centre = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [image.width, image.height, ...[...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3)];
  }, 'data:image/png;base64,' + png.toString('base64'));
  assert.deepEqual(centre, [560, 120, 0, 170, 0]);
});
