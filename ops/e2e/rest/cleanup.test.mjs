import test from 'node:test';
import assert from 'node:assert/strict';
import { withSuite, summary, cleanup, teardown, call } from './lib.mjs';

let sequence = 0;
const response = (status, headers = {}) => new Response(status === 204 ? null : '{}', { status, headers });

for (const status of [200, 401, 403, 404, 500, 503]) {
  test(`registered cleanup requires 404, verification returns ${status}`, async t => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    let reads = 0, deletes = 0;
    t.mock.method(globalThis, 'fetch', (_url, options) => {
      if (options.method === 'DELETE') { deletes++; return response(204); }
      return ++reads === 1 ? response(200, { etag: '"1"' }) : response(status);
    });
    const name = `registered-cleanup-${sequence++}`;
    await withSuite(name, () => cleanup('template', '/templates/offline', 'offline'));
    await teardown('offline', [name]);
    assert.equal(reads, 2);
    assert.equal(deletes, 1);
    assert.equal(summary([name]).failed, status === 404 ? 0 : 1);
  });
}

for (const status of [401, 403, 404, 500, 503]) {
  test(`unregistered cleanup cannot infer deletion from HTTP ${status}`, async t => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', (_url, options) => {
      if (options.method === 'POST') return new Response(JSON.stringify({
        '@id': 'https://repo.example/templates/unregistered', 'schema:name': 'unregistered',
      }), { status: 201 });
      assert.equal(options.method, 'GET', 'never delete after an inconclusive read');
      return response(status);
    });
    const name = `unregistered-cleanup-${sequence++}`;
    await withSuite(name, () => call('offline', 'POST', '/templates', {}));
    await teardown('offline', [name]);
    assert.equal(summary([name]).failed, status === 404 ? 0 : 1);
  });
}

test('a failed cleanup read does not stop later fixture cleanup', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const deleted = new Set();
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (options.method === 'DELETE') { deleted.add(url); return response(204); }
    if (deleted.has(url)) return response(url.endsWith('/bad') ? 500 : 404);
    return response(200, { etag: '"1"' });
  });
  const name = `cleanup-continues-${sequence++}`;
  await withSuite(name, () => {
    cleanup('template', '/templates/good', 'good');
    cleanup('template', '/templates/bad', 'bad');
  });
  await teardown('offline', [name]);
  assert.equal(deleted.size, 2);
  assert.equal(summary([name]).failed, 1);
});

test('a transport failure still permits cleanup of the remaining fixtures', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let deleted = false;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.endsWith('/bad')) throw new Error('connection reset');
    if (options.method === 'DELETE') { deleted = true; return response(204); }
    return deleted ? response(404) : response(200, { etag: '"1"' });
  });
  const name = `cleanup-transport-${sequence++}`;
  await withSuite(name, () => {
    cleanup('template', '/templates/good', 'good');
    cleanup('template', '/templates/bad', 'bad');
  });
  await teardown('offline', [name]);
  assert.equal(deleted, true);
  assert.equal(summary([name]).failed, 1);
});

test('unregistered fixtures are still swept after a transport failure on another fixture', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let deleted = false;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (options.method === 'POST') return new Response(options.body, { status: 201 });
    if (url.includes('broken')) throw new Error('connection reset');
    if (options.method === 'DELETE') { deleted = true; return response(204); }
    return deleted ? response(404) : response(200, { etag: '"1"' });
  });
  const name = `unregistered-transport-${sequence++}`;
  await withSuite(name, async () => {
    for (const label of ['good', 'broken']) await call('offline', 'POST', '/templates', {
      '@id': `https://repo.example/templates/${label}`, 'schema:name': label,
    });
  });
  await teardown('offline', [name]);
  assert.equal(deleted, true);
  assert.equal(summary([name]).failed, 2, 'the unreadable fixture and the unregistered leak both fail');
});
