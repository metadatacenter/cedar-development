import test from 'node:test';
import assert from 'node:assert/strict';
import { runSuites, workerCount } from './scheduler.mjs';
import { withSuite, suite, check, summary, call, cleanup, teardown, enc } from './lib.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('bounded overlap drains before exclusive and unknown suites', async () => {
  let active = 0, peak = 0;
  const done = [];
  const suites = ['artifacts', 'contract', 'search', 'download', 'new-suite'].map(name => ({ name }));
  await runSuites(suites, 2, async s => {
    if (['contract', 'new-suite'].includes(s.name)) {
      assert.equal(active, 0);
      assert.equal(done.filter(n => ['artifacts', 'search', 'download'].includes(n)).length, 3);
    }
    peak = Math.max(peak, ++active);
    await pause(5);
    active--;
    done.push(s.name);
  });
  assert.equal(peak, 2);
  assert.deepEqual(done.slice(-2), ['contract', 'new-suite']);
  const serial = [];
  await runSuites(suites, 1, async s => serial.push(s.name));
  assert.deepEqual(serial, suites.map(s => s.name));
});

test('interruption stops queued suites and drains active ones', async () => {
  let interrupted = false;
  const done = [];
  await runSuites(['artifacts', 'search', 'download', 'contract'].map(name => ({ name })), 2,
    async s => {
      await pause(s.name === 'artifacts' ? 2 : 10);
      interrupted = true;
      done.push(s.name);
    }, () => interrupted);
  assert.deepEqual(done, ['artifacts', 'search']);
});

test('unexpected callback failure drains in-flight work before rejecting', async () => {
  let drained = false;
  await assert.rejects(runSuites([{ name: 'artifacts' }, { name: 'search' }], 2, async s => {
    if (s.name === 'artifacts') throw new Error('failed');
    await pause(10);
    drained = true;
  }), /failed/);
  assert.equal(drained, true);
  for (const value of [0, -1, 5, 1.5, 'bad']) assert.throws(() => workerCount(value));
});

test('overlapping contexts retain check labels and unwind their own fixtures', async () => {
  const originalFetch = globalThis.fetch;
  const live = new Set();
  const deleted = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') {
      const id = JSON.parse(options.body)['@id'];
      live.add(id);
      return new Response(JSON.stringify({ '@id': id }), { status: 201 });
    }
    const id = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    if (options.method === 'DELETE') {
      deleted.push(id);
      live.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: live.has(id) ? 200 : 404, headers: { etag: '"1"' } });
  };
  try {
    const parent = 'https://repo.example/folders/root';
    await call('test', 'POST', '/folders', { '@id': parent });
    cleanup('folder', `/folders/${enc(parent)}`, 'root');
    await Promise.all(['alpha', 'beta'].map(name => withSuite(name, async () => {
      suite(`${name}: first`);
      await pause(name === 'alpha' ? 8 : 1);
      check(true, 'first');
      for (const suffix of ['parent', 'child']) {
        const id = `https://repo.example/folders/${name}-${suffix}`;
        await call('test', 'POST', '/folders', { '@id': id });
        cleanup('folder', `/folders/${enc(id)}`, suffix);
      }
      suite(`${name}: second`);
      await pause(1);
      check(true, 'second');
    })));
    const result = summary(['alpha', 'beta']);
    assert.deepEqual(result.checks.map(c => [c.suite, c.section, c.name]), [
      ['alpha', 'alpha: first', 'first'], ['alpha', 'alpha: second', 'second'],
      ['beta', 'beta: first', 'first'], ['beta', 'beta: second', 'second'],
    ]);
    await teardown('test', ['alpha', 'beta'], 2);
    const names = deleted.map(id => id.split('/').at(-1));
    for (const name of ['alpha', 'beta']) {
      assert.deepEqual(names.filter(n => n.startsWith(name)), [`${name}-child`, `${name}-parent`]);
    }
    assert.equal(names.at(-1), 'root');
    assert.equal(live.size, 0);
    assert.equal(summary().failed, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
