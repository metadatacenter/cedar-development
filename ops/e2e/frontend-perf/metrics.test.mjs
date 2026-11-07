import {test} from 'node:test';
import assert from 'node:assert/strict';
import {distribution, layoutShiftScore, pageMetrics, summarize, htmlReport} from './metrics.mjs';

test('median and range omit unavailable metrics, including null', () => {
  assert.deepEqual(distribution([9, 2, null, undefined, 4, 6]), {n:4, median:5, min:2, max:9});
  assert.deepEqual(distribution([]), {n:0, median:null, min:null, max:null});
});
test('CLS uses maximum session window and excludes recent input', () => {
  const entries = [0, 500, 1600, 2100].map((startTime, i) => ({startTime, value:[.1,.2,.4,.1][i]}));
  entries.push({startTime:2200, value:10, hadRecentInput:true});
  assert.equal(layoutShiftScore(entries), .5);
  assert.equal(layoutShiftScore(Array.from({length:8}, (_, i) => ({startTime:i*900, value:1}))), 6);
});
test('missing paint is unavailable; blocking sum is not the whole task duration', () => {
  const result = pageMetrics({now:1000, supported:['longtask'], entries:{longtask:[{duration:120},{duration:40}]}, navigation:{startTime:0,responseStart:12}}, 700, {});
  assert.equal(result.blockingOver50Ms, 70);
  assert.equal(result.lcpMs, null);
  assert.equal(result.cls, null);
  assert.equal(result.ttfbMs, 12);
});
test('failed samples never improve the timing distribution; report escapes errors', () => {
  const report = {startedAt:'today', metadata:{}, samples:[
    {scenario:'CEE',profile:'normal',cache:'cold',status:'ok',metrics:{readyMs:500}},
    {scenario:'CEE',profile:'normal',cache:'cold',status:'failed',error:'<script>bad</script>',metrics:{readyMs:1}},
  ]};
  const [group] = summarize(report.samples);
  assert.equal(group.failures, 1);
  assert.equal(group.metrics.readyMs.median, 500);
  assert.ok(htmlReport(report).includes('&lt;script&gt;'));
  assert.ok(!htmlReport(report).includes('<script>bad'));
});
