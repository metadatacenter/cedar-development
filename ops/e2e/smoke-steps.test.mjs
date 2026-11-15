import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeSteps } from './smoke-steps.mjs';

const inventory = JSON.parse(readFileSync(new URL('./browser-steps.json', import.meta.url), 'utf8'));
const entered = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8')
  .matchAll(/steps\.enter\('([^']+)'\)/g)].map((match) => match[1]);

test('the committed inventory names every step each browser script enters, in order', () => {
  assert.deepEqual(entered('./login-smoke-test.mjs'), inventory.scripts['login-smoke-test']);
  assert.deepEqual(entered('./metadata-first-save-smoke.mjs'), inventory.scripts['metadata-first-save-smoke']);
  assert.deepEqual(Object.keys(inventory.scripts).sort(), ['login-smoke-test', 'metadata-first-save-smoke']);
});

test('a script reports the steps it completed and the one it failed in', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-steps-'));
  try {
    const environment = { CEDAR_BROWSER_SMOKE_REPORTS: directory };
    const passing = smokeSteps('passing', environment);
    passing.enter('one');
    passing.enter('two');
    passing.pass();
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'passing.json'), 'utf8')),
      { schemaVersion: 1, script: 'passing', verdict: 'PASS', steps: ['one', 'two'], failedStep: null });
    const failing = smokeSteps('failing', environment);
    failing.enter('one');
    failing.enter('two');
    failing.fail();
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'failing.json'), 'utf8')),
      { schemaVersion: 1, script: 'failing', verdict: 'FAIL', steps: ['one'], failedStep: 'two' });
    smokeSteps('silent', {}).pass();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
