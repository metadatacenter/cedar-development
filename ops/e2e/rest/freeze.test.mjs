import test from 'node:test';
import assert from 'node:assert/strict';
import { withSuite, summary } from './lib.mjs';
import { run } from './suites/freeze.mjs';

let sequence = 0;
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

async function exercise(t, fetch) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', fetch);
  const name = `freeze-regression-${sequence++}`;
  let failure;
  try {
    await withSuite(name, () => run({ user1: { auth: 'offline' }, folderId: 'offline-folder' }));
  } catch (error) { failure = error; }
  return { ...summary([name]), failure };
}

test('only a 404 capability response permits the seven freeze skips', async t => {
  let requests = 0;
  const result = await exercise(t, (_url, options) => {
    assert.equal(options.method, 'GET');
    requests++;
    return answer(404);
  });
  assert.equal(requests, 2);
  assert.equal(result.failure, undefined);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 7);
});

for (const status of [204, 401, 403, 500, 502, 503]) {
  test(`HTTP ${status} discovery fails even when the other vocabulary is absent`, async t => {
    let requests = 0;
    const result = await exercise(t, () => answer(++requests === 1 ? 404 : status));
    assert.match(result.failure?.message ?? '', new RegExp(`HTTP ${status}`));
    assert.equal(result.skipped, 0);
  });
}

test('malformed successful discovery and transport errors cannot become skips', async t => {
  const malformed = await exercise(t, () => answer(200, {}));
  assert.match(malformed.failure?.message ?? '', /no version id/);
  assert.equal(malformed.skipped, 0);
  const unavailable = await exercise(t, () => { throw new Error('connection refused'); });
  assert.match(unavailable.failure?.message ?? '', /connection refused/);
  assert.equal(unavailable.skipped, 0);
});

test('available vocabularies execute all seven assertions', async t => {
  const previous = process.env.CEDAR_ARTIFACT_SERVICE_API_KEY;
  process.env.CEDAR_ARTIFACT_SERVICE_API_KEY = 'offline-service-key';
  t.after(() => {
    if (previous === undefined) delete process.env.CEDAR_ARTIFACT_SERVICE_API_KEY;
    else process.env.CEDAR_ARTIFACT_SERVICE_API_KEY = previous;
  });
  const id = 'https://repo.example/templates/offline';
  const result = await exercise(t, (url, options) => {
    if (url.includes('/versions/current')) return answer(200, { id: 'doid-version' });
    if (url.includes('/version-current')) return answer(200, { id: 'vs-version' });
    if (options.method === 'POST' && url.includes('/templates?')) return answer(201, { '@id': id });
    if (options.method === 'POST' && url.includes('/command/publish-artifact')) return answer(200);
    if (options.method === 'GET' && url.includes('/templates/')) return answer(200, {
      _valueConstraints: {
        ontologies: [{ acronym: 'DOID', version: { id: 'doid-version' } }],
        branches: [{ version: { id: 'doid-version' } }],
        classes: [{ version: { id: 'doid-version' } }],
        valueSets: [{ vsCollection: 'CEDARVS', version: { id: 'vs-version' } }, { vsCollection: 'ZZVS' }],
      },
    });
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  });
  assert.equal(result.failure, undefined);
  assert.equal(result.passed, 7);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
});
