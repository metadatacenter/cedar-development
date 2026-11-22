import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {scoreCalibration, sealReview, verifyReviewSeal, drawCases, BEHAVIOR_PROBES, CASES_PER_FAMILY, THEMES} from './calibration.mjs';
import {COMPOSITION_PROBES} from './composition-calibration.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cedar-calibration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const keys = join(root, 'keys');
  await mkdir(join(root, 'calibration')); await mkdir(keys);
  const key = [{id: 'one', broken: true}, {id: 'two', broken: false},
    {id: 'three', broken: true, family: 'composition'}, {id: 'four', broken: false, family: 'composition'}];
  for (const {id} of key) await writeFile(join(root, 'calibration', id + '.png'), 'image ' + id);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const packet = JSON.stringify(key.map(({id}) => ({id, images: [id + '.png'], imageSha256: {[id + '.png']: digest('image ' + id)}})));
  await writeFile(join(root, 'calibration/packet.json'), packet);
  await writeFile(join(keys, createHash('sha256').update(packet).digest('hex') + '.json'), JSON.stringify(key));
  return {root, keys};
}
// A deterministic stand-in for crypto.randomInt (mulberry32), so a draw can be checked repeatedly.
function seeded(seed) {
  let state = seed >>> 0;
  return max => {
    state = (state + 0x6D2B79F5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), state | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * max);
  };
}

test('composition misses and false alarms are scored separately from behavior', async t => {
  const {root, keys} = await fixture(t);
  await writeFile(join(root, 'calibration-review.json'), JSON.stringify({cases: [
    {id: 'one', issue: true, reason: 'Observed failure'}, {id: 'two', issue: false, reason: 'Expected behavior'},
    {id: 'three', issue: false, reason: 'Missed grouping'}, {id: 'four', issue: true, reason: 'Unfounded concern'},
  ]}));
  const score = await scoreCalibration(join(root, 'calibration'), join(root, 'calibration-review.json'), {keys});
  assert.deepEqual(score.families.behavior, {detected: 1, defects: 1, falseAlarms: 0, controls: 1});
  assert.deepEqual(score.families.composition, {detected: 0, defects: 1, falseAlarms: 1, controls: 1});
});
test('duplicate or missing case assessments cannot produce a calibration score', async t => {
  const {root, keys} = await fixture(t), path = join(root, 'calibration-review.json');
  for (const ids of [['one'], ['one', 'two', 'three', 'three'], ['one', 'two', 'three', 'unknown']]) {
    await writeFile(path, JSON.stringify({cases: ids.map(id => ({id, issue: false, reason: 'Assessment'}))}));
    await assert.rejects(scoreCalibration(join(root, 'calibration'), path, {keys}));
  }
});
test('a changed packet, or one without its key, cannot be scored', async t => {
  const {root, keys} = await fixture(t), path = join(root, 'calibration-review.json');
  await writeFile(path, JSON.stringify({cases: ['one', 'two', 'three', 'four'].map(id => ({id, issue: false, reason: 'Assessment'}))}));
  await writeFile(join(root, 'calibration/packet.json'), '[]');
  await assert.rejects(scoreCalibration(join(root, 'calibration'), path, {keys}), /No answer key matches/);
});
test('a missing or changed calibration image cannot be scored', async t => {
  for (const damage of [file => rm(file), file => writeFile(file, 'altered')]) {
    const {root, keys} = await fixture(t), path = join(root, 'calibration-review.json');
    await writeFile(path, JSON.stringify({cases: ['one', 'two', 'three', 'four'].map(id => ({id, issue: false, reason: 'Assessment'}))}));
    await damage(join(root, 'calibration/two.png'));
    await assert.rejects(scoreCalibration(join(root, 'calibration'), path, {keys}), /missing or changed since capture: two\.png/);
  }
});
test('an app review cannot be rewritten after sealing or sealed after calibration', async t => {
  const {root} = await fixture(t), path = join(root, 'review.json');
  await writeFile(path, '{"findings":[]}');
  await sealReview(root);
  await verifyReviewSeal(root, path);
  await assert.rejects(sealReview(root));
  await writeFile(path, '{"findings":["revised"]}');
  await assert.rejects(verifyReviewSeal(root, path));
  const {root: other} = await fixture(t);
  await writeFile(join(other, 'calibration-review.json'), '{}');
  await assert.rejects(sealReview(other), /before calibration/);
});
test('each draw holds every probe, a bounded mix of concerns and controls, and no repeated rendering', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const cases = drawCases(seeded(seed));
    assert.equal(cases.length, 2 * CASES_PER_FAMILY);
    assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
    assert(cases.every(c => /^[a-z]\d\d$/.test(c.id) && c.theme >= 0 && c.theme < THEMES.length));
    assert.equal(new Set(cases.map(c => [c.kind, c.broken, c.category, c.theme].join())).size, cases.length);
    for (const [family, probes] of [['behavior', BEHAVIOR_PROBES], ['composition', COMPOSITION_PROBES]]) {
      const members = cases.filter(c => c.family === family);
      assert.equal(members.length, CASES_PER_FAMILY);
      const concerns = members.filter(c => c.broken).length;
      assert(concerns >= 2 && concerns <= CASES_PER_FAMILY - 2, `${family}: ${concerns} concerns`);
      for (const probe of probes) assert(members.some(c => c.kind === probe.kind), `${family}: ${probe.kind} missing`);
      for (const c of members) assert(probes.find(p => p.kind === c.kind)[c.broken ? 'broken' : 'control'].includes(c.category));
    }
  }
});
test('draws differ in identifiers, order and answers', () => {
  const draws = [1, 2, 3, 4, 5].map(seed => drawCases(seeded(seed)));
  const answers = draws.map(cases => cases.map(c => `${c.kind}:${c.broken}`).join());
  assert.equal(new Set(answers).size, draws.length);
  assert.equal(new Set(draws.map(cases => cases.map(c => c.id).join())).size, draws.length);
});
