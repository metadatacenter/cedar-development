import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {distribution, layoutShiftScore, pageMetrics, summarize, htmlReport, instrumentation, profiles} from './metrics.mjs';

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

test('network accounting retains redirect hops, cache hits and unfinished requests without query secrets', async () => {
  const cdp = new EventEmitter(); cdp.send = async () => {};
  const meter = await instrumentation({addInitScript:async()=>{},newCDPSession:async()=>cdp},{},profiles.normal);
  meter.start();
  cdp.emit('Network.requestWillBeSent',{requestId:'a',timestamp:1,request:{url:'https://lab/start?token=secret'}});
  cdp.emit('Network.requestWillBeSent',{requestId:'a',timestamp:2,request:{url:'https://lab/end'},redirectResponse:{encodedDataLength:50,status:302}});
  cdp.emit('Network.responseReceived',{requestId:'a',response:{url:'https://lab/end',status:200,fromDiskCache:false}});
  cdp.emit('Network.loadingFinished',{requestId:'a',timestamp:3,encodedDataLength:100});
  cdp.emit('Network.requestWillBeSent',{requestId:'b',timestamp:3,request:{url:'https://lab/cached'}});
  cdp.emit('Network.requestServedFromCache',{requestId:'b'});
  cdp.emit('Network.loadingFinished',{requestId:'b',timestamp:4,encodedDataLength:0});
  cdp.emit('Network.requestWillBeSent',{requestId:'c',timestamp:4,request:{url:'https://lab/pending'}});
  const snapshot = meter.snapshot();
  assert.equal(snapshot.requests,4);
  assert.equal(snapshot.transferBytes,150);
  assert.equal(snapshot.cachedRequests,1);
  assert.equal(snapshot.pendingRequests,1);
  assert.equal(snapshot.resources[0].durationMs,1000);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});
