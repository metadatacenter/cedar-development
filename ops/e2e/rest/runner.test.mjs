import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('partial inventory updates fail before HTTP, reports or inventory writes', () => {
  const runner = fileURLToPath(new URL('../rest-smoke.mjs', import.meta.url));
  const inventory = new URL('./expected-checks.json', import.meta.url);
  const before = readFileSync(inventory, 'utf8');
  const directory = mkdtempSync(join(tmpdir(), 'cedar-rest-runner-'));
  const report = join(directory, 'report.json');
  // A regression that gets as far as authentication must fail this test without touching a stack.
  const guard = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => process.exit(98);');
  try {
    for (const args of [['sharing', '--update-inventory'], ['--update-inventory', 'sharing', 'pagination']]) {
      const result = spawnSync(process.execPath, ['--import', guard, runner, ...args, `--report=${report}`],
          { cwd: directory, encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--update-inventory requires every REST suite/);
      assert.equal(existsSync(report), false, 'a refused invocation must not overwrite a report');
      assert.equal(readFileSync(inventory, 'utf8'), before);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a deadline that is not a positive number of seconds is refused before HTTP', () => {
  const runner = fileURLToPath(new URL('../rest-smoke.mjs', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'cedar-rest-runner-'));
  const guard = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => process.exit(98);');
  try {
    for (const value of ['0', '-5', 'soon']) {
      const result = spawnSync(process.execPath, ['--import', guard, runner, `--deadline=${value}`],
          { cwd: directory, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--deadline must be a positive number of seconds/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every request carries a timeout, so a service that never answers cannot hold the tier', async t => {
  const { call, REQUEST_TIMEOUT_MS } = await import('./lib.mjs');
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal;
    return new Response('{}', { status: 200 });
  });
  await call(null, 'GET', '/anything');
  assert.ok(signal instanceof AbortSignal);
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 300_000);
});
