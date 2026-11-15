import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scoreCalibration, sealReview, verifyReviewSeal} from './calibration.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cedar-calibration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'calibration'));
  const key = [{id: 'one', broken: true}, {id: 'two', broken: false},
    {id: 'three', broken: true, family: 'composition'}, {id: 'four', broken: false, family: 'composition'}];
  await writeFile(join(root, 'calibration-key.json'), JSON.stringify(key));
  return root;
}
test('composition misses and false alarms are scored separately from behavior', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'calibration-review.json'), JSON.stringify({cases: [
    {id: 'one', issue: true, reason: 'Observed failure'}, {id: 'two', issue: false, reason: 'Expected behavior'},
    {id: 'three', issue: false, reason: 'Missed grouping'}, {id: 'four', issue: true, reason: 'Unfounded concern'},
  ]}));
  const score = await scoreCalibration(join(root, 'calibration'), join(root, 'calibration-review.json'));
  assert.deepEqual(score.families.behavior, {detected: 1, defects: 1, falseAlarms: 0, controls: 1});
  assert.deepEqual(score.families.composition, {detected: 0, defects: 1, falseAlarms: 1, controls: 1});
});
test('duplicate or missing case assessments cannot produce a calibration score', async t => {
  const root = await fixture(t), path = join(root, 'calibration-review.json');
  for (const ids of [['one'], ['one', 'two', 'three', 'three'], ['one', 'two', 'three', 'unknown']]) {
    await writeFile(path, JSON.stringify({cases: ids.map(id => ({id, issue: false, reason: 'Assessment'}))}));
    await assert.rejects(scoreCalibration(join(root, 'calibration'), path));
  }
});
test('an app review cannot be rewritten after sealing or sealed after calibration', async t => {
  const root = await fixture(t), path = join(root, 'review.json');
  await writeFile(path, '{"findings":[]}');
  await sealReview(root);
  await verifyReviewSeal(root, path);
  await assert.rejects(sealReview(root));
  await writeFile(path, '{"findings":["revised"]}');
  await assert.rejects(verifyReviewSeal(root, path));
  const other = await fixture(t);
  await writeFile(join(other, 'calibration-review.json'), '{}');
  await assert.rejects(sealReview(other), /before calibration/);
});
