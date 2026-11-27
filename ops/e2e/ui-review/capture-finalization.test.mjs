import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {finishCapture} from './capture-finalization.mjs';
import {hash} from './contract.mjs';
import {catalogSha256} from './catalog.mjs';

for (const fail of [false, true]) test(`calibration ${fail ? 'failure' : 'success'} preserves application evidence and publishes consistent status`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-finalization-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const state = {id: 'initial-1440', screenshot: 'initial.png', aria: 'initial.yml', metrics: 'initial.json', crops: []};
  const original = {state: 'another-state', error: 'Original application failure'};
  const result = {app: 'designer', profile: 'chromium', catalogSha256: catalogSha256('designer'),
    provenance: {build: 'test-build', current: true}, servedVerified: true,
    states: [state], files: {'initial.png': 'unchanged-digest'}, incomplete: [original], runtimeErrors: [], cleanupErrors: []};
  const calibrate = async path => {
    assert.equal(path, join(directory, 'calibration'));
    const pending = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'));
    assert.equal(pending.calibration.status, 'pending');
    assert(pending.incomplete.some(e => e.state === 'calibration'));
    assert.deepEqual(pending.states, [state]);
    if (fail) throw new Error('private fixture diagnostic');
  };
  if (fail) await assert.rejects(finishCapture(directory, result, calibrate), /private fixture diagnostic/);
  else await finishCapture(directory, result, calibrate);
  const raw = await readFile(join(directory, 'capture.json'), 'utf8'), captured = JSON.parse(raw);
  assert.deepEqual(captured.states, [state]);
  assert.deepEqual(captured.files, result.files);
  assert.deepEqual(captured.incomplete[0], original);
  assert.equal(captured.incomplete.length, fail ? 2 : 1);
  assert.equal(captured.calibration.status, fail ? 'failed' : 'complete');
  assert(!raw.includes('private fixture diagnostic'), 'concealed fixture details stay out of reviewer evidence');
  assert((await readFile(join(directory, 'reviewer-brief.md'), 'utf8')).includes(hash(raw)));
  assert((await readFile(join(directory, 'index.html'), 'utf8')).includes('Original application failure'));
  assert.equal(JSON.parse(await readFile(join(directory, 'coverage.json'), 'utf8')).app, 'designer');
});
