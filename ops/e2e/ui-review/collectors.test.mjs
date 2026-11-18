import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APPS, REGIONS, requiredStates, unmatchedRegions} from './catalog.mjs';
import {collectorFor} from './run.mjs';

// A browser stand-in that absorbs every call and is never thenable, so a collector's top-level
// sequence runs without a stack. Each recorded operation is skipped: this checks which states a
// collector records, not whether the product behaves.
function inert() {
  return new Proxy(function () {}, {
    get: (_, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : inert(),
    apply: () => inert(),
  });
}
async function dryRun(app) {
  let minted = 0;
  const recorded = [];
  const session = {
    page: inert(), base: 'https://ui-review.test', user: {profile: {homeFolderId: 'https://repo.test/folders/home'}},
    actions: [], expectedNetworkFailures: new Set(), states: [],
    flush: async () => {}, login: async () => {}, openNew: async () => {}, ready: async () => {},
    addField: async () => {}, action: async () => {}, capture: async () => {},
    put: async collection => `https://repo.test/${collection}/${++minted}`,
    request: async () => ({status: 200, body: {}}),
  };
  await (await collectorFor(app))(session, async id => {recorded.push(id);});
  return recorded;
}

test('every collector records exactly its catalog states, once each', async () => {
  for (const app of APPS) {
    const recorded = await dryRun(app);
    assert.equal(new Set(recorded).size, recorded.length, `${app}: a state is recorded twice`);
    assert.deepEqual([...recorded].sort(), [...requiredStates(app)].sort(), `${app}: collector and catalog differ`);
  }
});

test('every application declares the regions its capture must find', () => {
  assert.deepEqual(Object.keys(REGIONS).sort(), [...APPS].sort());
  for (const app of APPS) {
    assert.ok(REGIONS[app].length, `${app}: no regions`);
    assert.equal(new Set(REGIONS[app]).size, REGIONS[app].length, `${app}: duplicate region selector`);
  }
});

test('a region selector that matches in no state is reported', () => {
  const [first, ...rest] = REGIONS.workspace;
  assert.deepEqual(unmatchedRegions('workspace', [{regionsMatched: rest}, {regionsMatched: []}]), [first]);
  assert.deepEqual(unmatchedRegions('workspace', [{regionsMatched: [first]}, {regionsMatched: rest}]), []);
  assert.deepEqual(unmatchedRegions('workspace', []), REGIONS.workspace);
});
