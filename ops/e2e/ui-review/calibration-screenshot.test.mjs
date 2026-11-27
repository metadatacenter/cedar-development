import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calibrationScreenshot} from './calibration-screenshot.mjs';

const protocol = () => new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
function fixture({failure = protocol(), always = false, changed = false} = {}) {
  const events = [];
  let shots = 0, reads = 0, paints = 0;
  return {events, counts: () => ({shots, reads, paints}), page: {
    waitForFunction: async (_fn, _arg, options) => {assert.equal(options.timeout, 5000); paints++;},
    evaluate: async () => ++reads > 1 && changed ? 'changed' : 'same',
    screenshot: async options => {assert.equal(options.timeout, 10000); if (++shots === 1 || always) throw failure;},
  }};
}
test('only the compositor protocol failure receives one retry, retaining both outcomes', async () => {
  const f = fixture();
  await calibrationScreenshot(f.page, '/tmp/case-before.png', {onEvent: async e => f.events.push(e)});
  assert.deepEqual(f.counts(), {shots: 2, reads: 2, paints: 2});
  assert.deepEqual(f.events.map(e => [e.attempt, e.outcome]), [[1, 'failed'], [2, 'recovered']]);
  assert.equal(f.events[0].image, 'case-before.png');
  assert.match(f.events[0].error, /Unable to capture/);
});
test('persistent compositor failure stops after two attempts', async () => {
  const f = fixture({always: true});
  await assert.rejects(calibrationScreenshot(f.page, '/tmp/case.png', {onEvent: async e => f.events.push(e)}), /Unable to capture/);
  assert.equal(f.counts().shots, 2);
  assert.deepEqual(f.events.map(e => e.outcome), ['failed', 'failed']);
});
test('timeouts and closed pages fail without a retry', async () => {
  for (const message of ['Timeout 10000ms exceeded', 'Target page, context or browser has been closed']) {
    const f = fixture({failure: new Error(message)});
    await assert.rejects(calibrationScreenshot(f.page, '/tmp/case.png'), error => error.message === message);
    assert.equal(f.counts().shots, 1);
  }
});
test('a changed fixture aborts recovery before a second screenshot', async () => {
  const f = fixture({changed: true});
  await assert.rejects(calibrationScreenshot(f.page, '/tmp/case.png', {onEvent: async e => f.events.push(e)}), /state changed/);
  assert.equal(f.counts().shots, 1);
  assert.deepEqual(f.events.map(e => e.outcome), ['failed', 'aborted']);
});
