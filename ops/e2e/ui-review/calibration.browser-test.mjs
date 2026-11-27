import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {captureCase, captureCalibration, BEHAVIOR_PROBES, THEMES} from './calibration.mjs';
import {COMPOSITION_PROBES} from './composition-calibration.mjs';

test('a recovered screenshot retains operator diagnostics outside the concealed reviewer packet', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-review-calibration-recovery-'));
  const originalLaunch = chromium.launch;
  t.after(async () => {chromium.launch = originalLaunch; await rm(root, {recursive: true, force: true});});
  let shots = 0;
  chromium.launch = async function (options) {
    const browser = await originalLaunch.call(this, options), newPage = browser.newPage.bind(browser);
    browser.newPage = async options => {
      const page = await newPage(options), screenshot = page.screenshot.bind(page);
      page.screenshot = async options => {
        if (++shots === 1) throw new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
        return screenshot(options);
      };
      return page;
    };
    return browser;
  };
  const directory = join(root, 'calibration'), keys = join(root, 'keys');
  await captureCalibration(directory, {keys, cases: [
    {id: 'q07', family: 'composition', kind: 'row', broken: false, category: 'aligned-row-controls', theme: 2},
  ]});
  assert.equal(shots, 2);
  const packetFiles = await readdir(directory);
  assert.deepEqual(packetFiles.sort(), ['packet.json', 'q07-screen.png']);
  const [file] = await readdir(join(keys, 'diagnostics'));
  const diagnostic = JSON.parse(await readFile(join(keys, 'diagnostics', file), 'utf8'));
  assert.equal(diagnostic.directory, directory);
  assert.match(diagnostic.browser, /^\d+\./);
  assert.deepEqual(diagnostic.events.map(e => e.outcome), ['failed', 'recovered']);
  assert.match(diagnostic.events[0].error, /Unable to capture screenshot/);
});

// Needs only a Playwright Chromium; no CEDAR stack. A fixture whose premise fails in any wording
// would refuse a capture, or worse, score a reviewer against a wrong answer.
test('every probe variant satisfies its premise in every wording set', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-review-calibration-'));
  const browser = await chromium.launch();
  t.after(async () => {await browser.close(); await rm(directory, {recursive: true, force: true});});
  let n = 0;
  for (const [family, probes] of [['behavior', BEHAVIOR_PROBES], ['composition', COMPOSITION_PROBES]])
    for (const probe of probes)
      for (const broken of [true, false])
        for (const category of probe[broken ? 'broken' : 'control'])
          for (let theme = 0; theme < THEMES.length; theme++) {
            const item = {id: `x${String(n++).padStart(3, '0')}`, family, kind: probe.kind, broken, category, theme};
            const entry = await captureCase(browser, directory, item);
            assert.equal(entry.id, item.id);
            assert(entry.images.length, `${category}/${theme}: no image`);
            if (probe.kind === 'save-enable')
              assert(!entry.accessibility.includes(THEMES[theme].prompt), 'entered values must not retain an unmet-requirement hint');
            if (probe.kind === 'occlusion') {
              const number = broken ? 1 : 2;
              assert(entry.accessibility.includes(`text: Page ${number}`), 'page label must match the click outcome');
              assert(entry.accessibility.includes(`${THEMES[theme].item} ${broken ? 1 : 9}`), 'rows must match the displayed page');
              assert(!entry.accessibility.includes(`text: Page ${broken ? 2 : 1}`), 'no conflicting old page label');
            }
          }
});

test('the answer key is written outside the packet and the packet carries no verdict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-review-calibration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cases = [
    {id: 'b12', family: 'behavior', kind: 'panel', broken: true, category: 'inert-panel-control', theme: 1},
    {id: 'q07', family: 'composition', kind: 'row', broken: false, category: 'aligned-row-controls', theme: 2},
  ];
  await mkdir(join(root, 'packet'));
  await captureCalibration(join(root, 'packet', 'calibration'), {keys: join(root, 'keys'), cases});
  const packetFiles = await readdir(join(root, 'packet'), {recursive: true});
  assert(!packetFiles.some(file => /key/.test(file)), 'no key in the packet');
  const packet = await readFile(join(root, 'packet', 'calibration', 'packet.json'), 'utf8');
  for (const secret of ['broken', 'category', 'inert-panel-control', 'aligned-row', 'family']) assert(!packet.includes(secret), secret);
  const [keyFile] = await readdir(join(root, 'keys'));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'keys', keyFile), 'utf8')), cases);
});
