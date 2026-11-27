import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enforced, blockingRegressions} from './budgets.mjs';

const row = (metric, status, scenario='s', cache='warm') => ({scenario, cache, metric, status, delta:{median:1}, limit:0.5});
const comparison = (rows, extra={}) => ({complete:true, selected:1, attempts:[{report:{comparison:rows}}], ...extra});

test('every measured component has an explicit budget decision', () => {
  assert.deepEqual(Object.keys(enforced).sort(), ['ced','cee','designer']);
  assert.deepEqual([...enforced.designer], ['readyMs']);
  assert.throws(() => blockingRegressions('workspace', {}), /No budget decision/);
});

test('a regression blocks only in a budgeted metric', () => {
  const rows = [row('readyMs','regression-warning'), row('blockingOver50Ms','regression-warning'), row('cls','regression-warning')];
  assert.equal(blockingRegressions('cee', {baseline:comparison(rows)}).length, 3);
  const designer = blockingRegressions('designer', {baseline:comparison(rows)});
  assert.deepEqual(designer.map(r => r.metric), ['readyMs']);
});

test('inconclusive and in-tolerance rows never block', () => {
  const rows = [row('readyMs','inconclusive'), row('cls','within-advisory-tolerance')];
  assert.deepEqual(blockingRegressions('ced', {baseline:comparison(rows)}), []);
});

test('the fixed reference blocks as the base does, and a reused reference is not counted twice', () => {
  const regressed = comparison([row('readyMs','regression-warning')]);
  const found = blockingRegressions('ced', {baseline:comparison([]), reference:regressed});
  assert.deepEqual(found.map(r => r.comparison), ['reference']);
  assert.equal(blockingRegressions('ced', {baseline:regressed, reference:{...regressed, reused:'baseline'}}).length, 1);
});

test('only the selected attempt decides', () => {
  const retried = {complete:true, selected:2, attempts:[{report:{comparison:[row('readyMs','regression-warning')]}},
    {report:{comparison:[row('readyMs','within-advisory-tolerance')]}}]};
  assert.deepEqual(blockingRegressions('cee', {baseline:retried}), []);
});
