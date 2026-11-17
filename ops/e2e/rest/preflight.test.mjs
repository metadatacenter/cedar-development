import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, access, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {signalPreflight} from './preflight.mjs';

test('standalone REST runs need no coordination file or delay', async () => {
  await signalPreflight(undefined, 'run', {sleep: () => assert.fail('unexpected wait')});
});

test('preflight signals only after the next fixture timestamp boundary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cedar-preflight-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'ready.json');
  let time = 1234, release;
  const pending = signalPreflight(path, '2026-11-17T19-00-01', {
    now: () => time,
    sleep: async ms => {
      assert.equal(ms, 766);
      await new Promise(resolve => {release = resolve;});
      time += ms;
    },
  });
  await assert.rejects(access(path));
  release();
  await pending;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    schemaVersion: 1, runId: '2026-11-17T19-00-01', preflightComplete: true,
  });
  await assert.rejects(access(path + '.tmp'));
});
