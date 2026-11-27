import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APPS, PROFILES, REGIONS, profile, requiredStates, unmatchedRegions} from './catalog.mjs';
import {collectorFor} from './run.mjs';
import {CORPUS_TEMPLATES, corpusPath} from './fixtures.mjs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// A browser stand-in that absorbs every call and is never thenable, so a collector's top-level
// sequence runs without a stack. Each recorded operation is skipped: this checks which states a
// collector records, not whether the product behaves. An evaluation answers as an unobstructed,
// enabled control, which is what the displayed-position pointer asks.
const hitTarget = {x: 0, y: 0, belongs: true, disabled: false, label: 'stand-in', receiver: 'BUTTON'};
function inert() {
  return new Proxy(function () {}, {
    get: (_, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => ''
      : key === 'evaluate' ? async () => hitTarget : inert(),
    apply: () => inert(),
  });
}
async function dryRun(app, profileName = 'chromium', capturedStates = [], failAt = null) {
  let minted = 0;
  const recorded = [];
  const session = {
    page: inert(), base: 'https://ui-review.test', user: {profile: {homeFolderId: 'https://repo.test/folders/home'}},
    otherUser: {profile: {firstName: 'Test', lastName: 'User 2'}},
    actions: [], expectedNetworkFailures: new Set(), states: capturedStates,
    flush: async () => {}, login: async () => {}, openNew: async () => {}, ready: async () => {},
    addField: async () => {}, action: async () => {}, capture: async () => {},
    put: async collection => `https://repo.test/${collection}/${++minted}`,
    defaultFontSize: profile(profileName).defaultFontSize, setDefaultFontSize: async () => {}, touch: !!profile(profileName).context.hasTouch,
    request: async () => ({status: 200, body: {}, headers: new Headers({etag: '"stand-in"'})}),
    anonymousRead: async () => ({status: 200}),
  };
  const record = async id => {
    if (id === failAt) throw new Error('Deliberate collector failure');
    recorded.push(id); capturedStates.push({id});
  };
  record.failure = () => {};
  await (await collectorFor(app))(session, record);
  return recorded;
}

test('every collector records exactly its catalog states, once each', async t => {
  // Fixtures read corpus templates from a sibling checkout; stand in for them with empty templates.
  const home = await mkdtemp(join(tmpdir(), 'ui-review-dry-run-')), previous = process.env.CEDAR_HOME;
  t.after(async () => {process.env.CEDAR_HOME = previous; await rm(home, {recursive: true, force: true});});
  process.env.CEDAR_HOME = home;
  for (const number of Object.values(CORPUS_TEMPLATES)) {
    await mkdir(dirname(corpusPath(number)), {recursive: true});
    await writeFile(corpusPath(number), JSON.stringify({properties: {}}));
  }
  for (const profileName of Object.keys(PROFILES)) for (const app of APPS) {
    const recorded = await dryRun(app, profileName);
    assert.equal(new Set(recorded).size, recorded.length, `${app} (${profileName}): a state is recorded twice`);
    assert.deepEqual([...recorded].sort(), [...requiredStates(app, profileName)].sort(), `${app} (${profileName}): collector and catalog differ`);
  }
  for (const failed of ['single', 'term-picker-open-1440', 'preferences-modal']) {
    const designer = await dryRun('designer', 'chromium', [], failed);
    assert(designer.includes('missing-template'), failed + ': independent error screen');
    if (failed !== 'preferences-modal') assert(designer.includes('preferences-modal'), failed + ': independent settings');
    if (failed === 'single') assert(designer.includes('type-text-preview'), 'fresh field-type fixture');
  }
  const workspace = await dryRun('workspace', 'chromium', [], 'rename-conflict-1440');
  for (const id of ['description-editing-1440', 'profile-1440', 'privacy-375', 'text-200-375']) assert(workspace.includes(id), id);
  const metadata = await dryRun('metadata-editor', 'chromium', [], 'type-temporal-1440');
  for (const id of ['list-too-short-1440', 'readonly-link-1440', 'save-conflict-375', 'text-200-375']) assert(metadata.includes(id), id);
  const openview = await dryRun('openview', 'chromium', [], 'template-1440');
  assert(!openview.includes('template-end-1440'), 'dependent states are skipped');
  for (const id of ['template-768', 'folder-preview-1440', 'loading-375']) assert(openview.includes(id), id);
});

test('every application declares the regions its capture must find', () => {
  assert.deepEqual(Object.keys(REGIONS).sort(), [...APPS].sort());
  for (const app of APPS) {
    assert.ok(REGIONS[app].length, `${app}: no regions`);
    assert.equal(new Set(REGIONS[app]).size, REGIONS[app].length, `${app}: duplicate region selector`);
  }
});

test('Designer retains overlapping follow-ups and links scrolled Configuration evidence', async () => {
  const states = [];
  await dryRun('designer', 'chromium', states);
  const related = id => states.find(state => state.id === id).relatedStates;
  assert.ok(related('keyboard').includes('nested-creation-keyboard-open'));
  assert.ok(related('keyboard').includes('disabled-move-checked'));
  assert.ok(related('nested').includes('nested-creation-idle'));
  assert.ok(related('nested').includes('nested-activation-checked'));
  assert.ok(related('width-375').includes('configuration-end-375'));
  assert.ok(related('both-panels-768').includes('configuration-end-768'));
  assert.ok(related('both-panels-multiple-1100').includes('multiple-1100-creation-keyboard-open'));
  assert.ok(related('type-pfas').includes('type-pfas-configuration-end'));
  assert.ok(related('type-doi').includes('type-doi-configuration-end'));
  assert.ok(related('type-page-break').includes('type-page-break-configuration-end'));
  assert.ok(related('both-panels-900').includes('configuration-end-900'));
  assert.ok(related('multiple-1100-creation-keyboard-open').includes('multiple-1100-creation-page-break-reached'));
  assert.ok(related('type-controlled-terms-preview').includes('overview-selection-header-reached'));
  assert.ok(related('draft-offered').includes('draft-offered-375'));
  assert.ok(related('term-picker-open-375').includes('term-picker-initial-feedback-375'));
  assert.ok(related('term-picker-ontologies-375').includes('term-picker-ontologies-release-last-375'));
  assert.ok(related('term-picker-ontologies-375').includes('term-picker-search-restored-375'));
  assert.ok(related('attribute-value-readonly-checked').includes('attribute-value-keyboard-focus'));
  for (const state of states) {
    assert.equal(new Set(state.relatedStates).size, state.relatedStates?.length ?? 0);
    assert.ok(!state.relatedStates?.includes(state.id));
  }
});

test('a region selector that matches in no state is reported', () => {
  const [first, ...rest] = REGIONS.workspace;
  assert.deepEqual(unmatchedRegions('workspace', [{regionsMatched: rest}, {regionsMatched: []}]), [first]);
  assert.deepEqual(unmatchedRegions('workspace', [{regionsMatched: [first]}, {regionsMatched: rest}]), []);
  assert.deepEqual(unmatchedRegions('workspace', []), REGIONS.workspace);
});
