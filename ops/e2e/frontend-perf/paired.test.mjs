import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessPairs, loadingFailures} from './paired.mjs';

function samples(before=1000, after=1000) {
  return Array.from({length:5},(_,i) => ['cold','warm'].flatMap(cache => ['baseline','candidate'].map(version => ({
    scenario:'cee',cache,version,repeat:i+1,status:'ok',metrics:{readyMs:version === 'baseline' ? before : after,blockingOver50Ms:100,cls:0},
  })))).flat();
}
const readiness = rows => assessPairs(rows,['cee'],5).find(r => r.cache === 'cold' && r.metric === 'readyMs');
test('advisory regression must exceed both absolute and relative tolerances', () => {
  assert.equal(readiness(samples(2000,2150)).status,'within-advisory-tolerance');
  assert.equal(readiness(samples(200,280)).status,'within-advisory-tolerance');
  assert.equal(readiness(samples(1000,1200)).status,'regression-warning');
});
test('missing, duplicate, failed and nonfinite samples cannot pass', () => {
  const missing = samples(); missing.pop();
  assert.ok(assessPairs(missing,['cee'],5).some(r => r.status === 'inconclusive'));
  const duplicate = samples(); duplicate.push(duplicate[0]);
  assert.equal(readiness(duplicate).status,'inconclusive');
  const failed = samples(); failed[0].status = 'failed';
  assert.equal(readiness(failed).status,'inconclusive');
  const invalid = samples(); invalid[0].metrics.cls = null;
  assert.equal(readiness(invalid).status,'inconclusive');
});
test('high variance and insufficient pairs are inconclusive, even without median regression', () => {
  const noisy = samples();
  for (const s of noisy) s.metrics.readyMs += [0,500,1000,1500,2000][s.repeat-1];
  assert.equal(readiness(noisy).status,'inconclusive');
  assert.equal(assessPairs(samples().filter(s => s.repeat === 1),['cee'],1)[0].status,'inconclusive');
});
test('loading failures include missing assets, external requests, duplicates and pending requests', () => {
  const good = {networkFailures:[],pendingRequests:0,resources:[{url:'https://perf.invalid/a.js',complete:true}]};
  assert.deepEqual(loadingFailures(good,'https://perf.invalid'),[]);
  assert.ok(loadingFailures({...good,resources:[...good.resources,...good.resources]},'https://perf.invalid').some(e => e.includes('Duplicate')));
  assert.ok(loadingFailures(good,'https://other.invalid').some(e => e.includes('Unexpected origin')));
  assert.ok(loadingFailures({...good,pendingRequests:1,networkFailures:[{status:404}]},'https://perf.invalid').length === 2);
});
