import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {componentReport, declaredComponents, executedBytes, scriptCoverage} from './ui-coverage.mjs';

test('a byte counts as run when the innermost range holding it ran', () => {
  // A 100-byte script that ran, holding a function at 20–60 that never did, which holds a block
  // at 30–40 V8 also marks unrun, and an inner function at 70–90 that ran.
  const functions = [
    {ranges: [{startOffset: 0, endOffset: 100, count: 1}]},
    {ranges: [{startOffset: 20, endOffset: 60, count: 0}, {startOffset: 30, endOffset: 40, count: 0}]},
    {ranges: [{startOffset: 70, endOffset: 90, count: 3}]},
  ];
  assert.equal(executedBytes(100, functions), 60);
});

test('script coverage keeps one row per served script and totals them', () => {
  const ran = {ranges: [{startOffset: 0, endOffset: 10, count: 1}]};
  const coverage = scriptCoverage([
    {url: 'https://workspace.example.orgx/main.js?v=1', source: 'x'.repeat(10), functions: [ran]},
    {url: 'https://workspace.example.orgx/main.js?v=2', source: 'x'.repeat(10), functions: [ran]},
    {url: 'https://workspace.example.orgx/lazy.js', source: 'x'.repeat(30), functions: [{ranges: [{startOffset: 0, endOffset: 30, count: 0}]}]},
    {url: 'chrome-extension://abc/inject.js', source: 'x', functions: [ran]},
  ]);
  assert.deepEqual(coverage.scripts.map(row => [row.url, row.executedPercent]),
    [['https://workspace.example.orgx/lazy.js', 0], ['https://workspace.example.orgx/main.js', 100]]);
  assert.deepEqual(coverage.total, {bytes: 40, executedBytes: 10, executedPercent: 25});
});

test('the inventory reads element selectors, sets attribute selectors apart and skips tests', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ui-coverage-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, 'app/src/parts'), {recursive: true});
  await writeFile(join(home, 'app/src/parts/card.ts'), `@Component({selector: 'app-card', template: ''})`);
  await writeFile(join(home, 'app/src/parts/tip.ts'), `@Directive({selector: "[appTip]"})`);
  await writeFile(join(home, 'app/src/parts/card.spec.ts'), `@Component({selector: 'app-test-host'})`);
  await writeFile(join(home, 'app/src/app.component.dev.ts'), `@Component({selector: 'app-root'})`);
  const declared = await declaredComponents(home, [{repository: 'app', root: 'app/src'}]);
  assert.deepEqual(declared.components.map(c => c.tag), ['app-card']);
  assert.deepEqual(declared.attributes.map(a => a.selector), ['[appTip]']);
});

test('a registered custom element stands in for the component it renders, and duplicates count once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ui-coverage-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, 'pkg/src'), {recursive: true});
  await writeFile(join(home, 'pkg/src/wrapper.ts'), `@Component({selector: 'app-wrapper'}) export class Wrapper {}`);
  await writeFile(join(home, 'pkg/src/fonts.ts'), `@Component({selector: 'app-fonts'})`);
  await writeFile(join(home, 'pkg/src/fonts.host-fonts.ts'), `@Component({selector: 'app-fonts'})`);
  await writeFile(join(home, 'pkg/src/tags.ts'), `export const TAG = 'pkg-editor'; export const PICKER = 'pkg-picker';`);
  const sources = [{repository: 'pkg', root: 'pkg/src', elements: {'pkg-editor': 'app-wrapper', 'pkg-picker': null}}];
  const declared = await declaredComponents(home, sources);
  assert.deepEqual(declared.components.map(c => c.tag), ['app-fonts', 'pkg-editor', 'pkg-picker']);
  await writeFile(join(home, 'pkg/src/tags.ts'), `export const TAG = 'pkg-editor';`);
  await assert.rejects(declaredComponents(home, sources), /no longer registers the custom element pkg-picker/);
});

test('the report separates components on screen, rendered only, and never rendered', () => {
  const declared = {components: [
    {tag: 'app-list', repository: 'one'}, {tag: 'app-menu', repository: 'one'}, {tag: 'app-sharing', repository: 'one'},
  ], attributes: [{selector: '[appTip]'}]};
  const censuses = [
    {app: 'workspace', profile: 'chromium', states: {home: {present: ['app-list', 'app-menu', 'mat-icon'], visible: ['app-list']}}},
    {app: 'workspace', profile: 'webkit-touch', states: {home: {present: ['app-list'], visible: ['app-list']}}},
  ];
  const report = componentReport(censuses, declared);
  assert.deepEqual(report.byRepository.one, {declared: 3, shown: 1, renderedOnly: ['app-menu'], neverRendered: ['app-sharing'], uncapturable: []});
  assert.deepEqual(report.components[0].shown, ['workspace chromium', 'workspace webkit-touch']);
  assert.deepEqual(report.undeclared, ['mat-icon']);
  assert.equal(report.attributeSelectors, 1);
});

test('an uncapturable component is reported with its reason and left out of the count', () => {
  const declared = {components: [{tag: 'app-list', repository: 'one'}, {tag: 'app-fonts', repository: 'one'}], attributes: []};
  const censuses = [{app: 'workspace', profile: 'chromium', states: {home: {present: ['app-list', 'app-fonts'], visible: ['app-list']}}}];
  const report = componentReport(censuses, declared, {'app-fonts': 'Renders nothing.'});
  assert.deepEqual(report.byRepository.one, {declared: 1, shown: 1, renderedOnly: [], neverRendered: [], uncapturable: ['app-fonts']});
  assert.equal(report.components[1].uncapturable, 'Renders nothing.');
});
