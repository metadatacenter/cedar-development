import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STATES, validateReview, verdict} from './contract.mjs';

const capture = () => ({captureSha256: 'digest', states: STATES.map(id => ({id})),
  provenance: {current: true}, servedVerified: true, incomplete: [], cleanupErrors: [], runtimeErrors: []});
const review = () => ({schemaVersion: 1, reviewer: 'independent reviewer', captureSha256: 'digest',
  independence: {freshContext: true, knownDefectsDisclosed: false}, inspectedStates: [...STATES],
  findings: [], acceptableObservations: 'The ordinary save has clear feedback.', limitations: 'Chromium only.',
  composition: {grouping: 'Related items remain together.', hierarchy: 'Identity precedes settings.',
    wrapping: 'Long content wraps where needed.', spaceUse: 'Controls use the available pane.'}});
test('a clean, complete review may contain no findings', () => {
  const c = capture(), r = review();
  assert.deepEqual(validateReview(c, r, new Set()), []);
  assert.equal(verdict(c, r, []), 'REVIEWED');
});
test('missing states, leaked answers, and different capture identities cannot pass', () => {
  for (const mutate of [r => r.inspectedStates.pop(), r => r.independence.freshContext = false,
    r => r.independence.knownDefectsDisclosed = true, r => r.captureSha256 = 'other']) {
    const c = capture(), r = review(); mutate(r);
    const errors = validateReview(c, r, new Set());
    assert.ok(errors.length); assert.equal(verdict(c, r, errors), 'INCOMPLETE');
  }
});
test('runtime, cleanup, collection and browser failures remain incomplete despite a positive review', () => {
  for (const mutate of [c => c.provenance.current = false, c => c.servedVerified = false,
    c => c.cleanupErrors.push('orphan'), c => c.runtimeErrors.push('crash'), c => c.incomplete.push('missing')]) {
    const c = capture(); mutate(c); assert.equal(verdict(c, review(), []), 'INCOMPLETE');
  }
});
test('findings must identify actual evidence and explain impact and reproduction', () => {
  const c = capture(), r = review();
  r.findings = [{id: 'one', title: 'Problem', kind: 'defect', severity: 'medium', steps: ['Click'],
    observed: 'Nothing changes', expected: 'Panel opens', impact: 'Control appears broken', evidence: ['screen.png']}];
  assert.ok(validateReview(c, r, new Set()).some(e => e.includes('unknown evidence')));
  assert.deepEqual(validateReview(c, r, new Set(['screen.png'])), []);
  assert.equal(verdict(c, r, []), 'FINDINGS');
  r.findings[0].steps = [];
  assert.ok(validateReview(c, r, new Set(['screen.png'])).length);
});
test('design concerns remain visible without being silently promoted to defects or accepted as clean', () => {
  const r = review(); r.findings = [{kind: 'design-proposal'}];
  assert.equal(verdict(capture(), r, []), 'DESIGN_REVIEW');
});
test('functional approval cannot substitute for composition review', () => {
  const r = review(); delete r.composition;
  assert.equal(validateReview(capture(), r, new Set()).filter(e => e.includes('composition')).length, 4);
});
test('malformed reviewer output is incomplete rather than crashing validation', () => {
  for (const r of [null, [], {...review(), inspectedStates: 17}, {...review(), findings: [null]}]) {
    const errors = validateReview(capture(), r, new Set());
    assert.ok(errors.length);
    assert.equal(verdict(capture(), r, errors), 'INCOMPLETE');
  }
});
