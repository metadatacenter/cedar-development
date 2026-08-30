import assert from 'node:assert/strict';
import test from 'node:test';
import {
  burstRecoveryAssessment, durationSeconds, performanceResourceDescriptor,
  PERF_PREFIX, parallelLimit, runId, runTimestampFromRootName, tokenSubject,
} from '../lib.mjs';

test('run ids are unique stamped identifiers that the cleanup parser accepts', () => {
  const first = runId();
  const second = runId();
  assert.notEqual(first, second);
  const parsed = runTimestampFromRootName(`${PERF_PREFIX} User 17 ${first}`);
  assert.equal(typeof parsed, 'number');
  assert.ok(Math.abs(Date.now() - parsed) < 5_000);
});

test('cleanup parser refuses names outside the exact performance root convention', () => {
  assert.equal(runTimestampFromRootName('REST Suites 2026-08-29T12-00-00'), null);
  assert.equal(runTimestampFromRootName(`${PERF_PREFIX} User 1 not-a-date`), null);
  assert.equal(runTimestampFromRootName(`${PERF_PREFIX} User 1 2026-99-99T99-99-99-999Z-abcdef`), null);
  assert.equal(runTimestampFromRootName(`${PERF_PREFIX} User 1 2026-08-29T12-00-00-000Z-abcdef extra`), null);
});

test('tokenSubject reads the Keycloak subject without needing signing material', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');
  assert.equal(tokenSubject(`${header}.${payload}.signature`), 'user-123');
});

test('duration parser accepts the bounded profile syntax', () => {
  assert.equal(durationSeconds('90s'), 90);
  assert.equal(durationSeconds('2m'), 120);
  assert.equal(durationSeconds('1m30s'), 90);
  assert.equal(durationSeconds('0s'), null);
  assert.equal(durationSeconds('1h'), null);
});

test('folder entries map to cleanup paths and unknown kinds are refused', () => {
  assert.deepEqual(performanceResourceDescriptor({
    '@id': 'https://repo.example/templates/a b',
    'schema:name': 'fixture',
    resourceType: 'template',
  }), {
    id: 'https://repo.example/templates/a b',
    kind: 'template',
    name: 'fixture',
    path: '/templates/https%3A%2F%2Frepo.example%2Ftemplates%2Fa%20b',
  });
  assert.throws(() => performanceResourceDescriptor({ '@id': 'x', resourceType: 'user' }),
      /refusing unexpected user/);
});

test('burst recovery must return near its measured baseline', () => {
  const summary = recovery => ({ metrics: {
    cedar_burst_baseline_duration: { values: { 'p(95)': 200 } },
    cedar_burst_recovery_duration: { values: { 'p(95)': recovery } },
  } });
  assert.deepEqual(burstRecoveryAssessment(summary(299)), {
    pass: true, baseline: 200, recovery: 299, limit: 300, reason: null,
  });
  assert.equal(burstRecoveryAssessment(summary(301)).pass, false);
  assert.match(burstRecoveryAssessment({}).reason, /missing/);
});

test('parallelLimit preserves result order and observes the concurrency ceiling', async () => {
  let active = 0;
  let maximum = 0;
  const values = await parallelLimit([1, 2, 3, 4, 5], 2, async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});
