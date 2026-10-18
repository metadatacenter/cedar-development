import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { corpus, definitions, materialize, byAlias } from './corpus.mjs';
import { queries, expectedAliases, journeyScenarios } from './queries.mjs';
import { contentMatrix, accessMatrix, pagingMatrix, plan, validateInventory } from './matrix.mjs';
import { exactResults, assertNoDisclosure, scopedQuery, searchPath, converge, walkSearch, resultMetadata, resultAuthority } from './assertions.mjs';
import { parseOptions, main } from './runner.mjs';
import { Fixtures } from './fixtures.mjs';
import { completion, recorder } from './suite.mjs';

const response = (ids, totalCount = ids.length) => ({ status: 200,
  body: { resources: ids.map(id => ({ '@id': id, 'schema:name': id })), totalCount } });

test('matrix covers every declared query, identity and endpoint, with no absent oracle members', () => {
  assert.equal(validateInventory(), true);
  assert.equal(queries.length, 75);
  assert.equal(contentMatrix.length, 300);
  assert.equal(accessMatrix.length, 240);
  assert.equal(pagingMatrix.length, 24);
  for (const query of queries) for (const actor of ['owner', 'reader']) for (const endpoint of ['search', 'search-deep'])
    assert.equal(contentMatrix.filter(row => row.test.id === query.id && row.actor === actor && row.endpoint === endpoint).length, 1);
  for (const source of ['direct', 'group', 'inherited']) for (const role of ['viewer', 'editor', 'manager'])
    for (const state of ['private', 'granted', 'revoked'])
      assert.equal(accessMatrix.filter(row => row.source === source && row.role === role && row.state === state).length, 8);
});

test('field-value fixture contrasts and exact permissions are independently pinned', () => {
  const records = Object.fromEntries(corpus.instances.map(item => [item.alias, item]));
  assert.equal(records['ny-stats'].values.publisher, 'City of New York');
  assert.equal(records.swapped.values.publisher, 'Statistics');
  assert.equal(records.swapped.values.title, 'City of New York');
  assert.equal(records['private-twin'].name, records['ny-stats'].name);
  assert.equal(records['private-twin'].access, 'private');
  const query = queries.find(item => item.id === 'and-fields');
  assert.deepEqual(expectedAliases(query, 'owner'), ['ny-stats', 'private-twin']);
  assert.deepEqual(expectedAliases(query, 'reader'), ['ny-stats']);
  assert.deepEqual(expectedAliases(queries.find(item => item.id === 'schema-independent-permission'), 'reader'), ['shared-private-schema']);
});

test('full artifact graph is deterministic and preserves distinct names, values, URIs and repetitions', () => {
  const first = materialize(), second = materialize();
  assert.deepEqual(first, second);
  assert.equal(first.size, 53);
  const names = first.get('names-template');
  assert.equal(names.properties.publisherCode['schema:name'], 'Publisher Name');
  assert.equal(names.properties.publisherCode['skos:prefLabel'], 'Publishing organisation');
  assert.equal(names._ui.propertyLabels.publisherCode, 'Public facing label');
  const ny = first.get('ny-stats');
  assert.equal(ny['schema:isBasedOn'], first.get('catalog-template')['@id']);
  assert.equal(ny.topic['@id'], first.get('term-other-label').topic['@id']);
  assert.notEqual(ny.topic['@id'], first.get('term-other-uri').topic['@id']);
  assert.deepEqual(first.get('repeated-values').Tags.map(item => item['@value']), ['alpha', 'beta', 'alpha']);
  assert.equal(first.get('absent').publisher, undefined);
  for (const key of Object.keys(byAlias.get('catalog-template').children)) {
    assert.ok(first.get('absent')['@context'][key], `Optional value still requires its context binding: ${key}`);
    assert.ok(first.get('catalog-template').properties['@context'].required.includes(key));
  }
  assert.deepEqual(first.get('null-value').publisher, { '@value': null });
  assert.deepEqual(first.get('empty-value').publisher, { '@value': '' });
  assert.equal(first.get('nested-cross').Visits[0].Disease['@value'], 'CRC');
  assert.equal(first.get('nested-cross').Visits[1].Tissue['@value'], 'colon');
  for (const spec of definitions) assert.equal(first.get(spec.alias)['@type'],
    spec.kind === 'instance' ? undefined : `https://schema.metadatacenter.org/core/${{ field: 'TemplateField', element: 'TemplateElement', template: 'Template' }[spec.kind]}`);
});

for (const [name, broken] of [
  ['missing hit', response(['A'])], ['foreign hit', response(['A', 'B', 'foreign'])],
  ['forbidden hit', response(['A', 'B', 'private'])], ['duplicate hit', response(['A', 'B', 'A'])],
  ['wrong count', response(['A', 'B'], 3)], ['backend outage', { status: 503, body: { resources: [], totalCount: 0 } }],
  ['missing shape', { status: 200, body: {} }], ['missing identity', { status: 200, body: { resources: [{}], totalCount: 1 } }],
]) test(`exact result oracle rejects ${name}`, () => assert.throws(() => exactResults(broken, ['A', 'B'])));

test('order is checked only when promised, while duplicates never pass', () => {
  exactResults(response(['B', 'A']), ['A', 'B']);
  assert.throws(() => exactResults(response(['B', 'A']), ['A', 'B'], { ordered: true }));
  exactResults(response([]), []);
  assert.throws(() => assertNoDisclosure(response(['private']), ['private']));
  assert.throws(() => assertNoDisclosure({ status: 200, body: { resources: [], debug: 'private' } }, ['private']));
});

test('matching IDs cannot conceal wrong displayed names, kinds or inflated permissions', () => {
  const expected = new Map([['A', { name: 'Current name', kind: 'instance' }]]);
  const correct = { '@id': 'A', 'schema:name': 'Current name', resourceType: 'instance', activeUserCanRead: true,
    currentUserPermissions: { role: 'viewer', owner: false, capabilities: ['readResource'] } };
  resultMetadata({ body: { resources: [correct] } }, expected);
  resultAuthority(correct, 'viewer', false);
  for (const patch of [{ 'schema:name': 'Old name' }, { resourceType: 'template' }, { activeUserCanRead: false }])
    assert.throws(() => resultMetadata({ body: { resources: [{ ...correct, ...patch }] } }, expected));
  for (const patch of [{ role: 'manager' }, { owner: true }, { capabilities: ['readResource', 'updateResource'] }])
    assert.throws(() => resultAuthority({ ...correct, currentUserPermissions: { ...correct.currentUserPermissions, ...patch } }, 'viewer', false));
});

test('run scoping brackets the entire Boolean expression and URL encoding round trips', () => {
  const scope = 'SearchCorpusabc123', query = 'title:Statistics OR url:https://example.org/a?x=1&y=two#part';
  assert.equal(scopedQuery(query, scope), `${scope} AND (${query})`);
  assert.equal(scopedQuery(query, ''), query);
  assert.throws(() => scopedQuery(query, 'unsafe OR *'));
  const path = searchPath({ query, types: ['instance'] }, scope, { endpoint: 'search-deep', continuation: 'opaque+/=token' });
  const url = new URL(path, 'https://example.org');
  assert.equal(url.searchParams.get('q'), `${scope} AND (${query})`);
  assert.equal(url.searchParams.get('continuation'), 'opaque+/=token');
  assert.equal(url.searchParams.has('offset'), false);
});

test('convergence proves readiness or fails within a fixed budget; it does not silently skip', async () => {
  let now = 0, tries = 0;
  const config = { timeoutMs: 20, intervalMs: 5, now: () => now, sleep: async ms => { now += ms; } };
  const outcome = await converge(async () => { assert.ok(++tries >= 3); }, config);
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.elapsedMs, 10);
  await assert.rejects(converge(async () => { throw new Error('absent'); }, config), /did not converge.*absent/);
});

test('paging walks small pages to an exact union and rejects repeats, omissions and stuck tokens', async () => {
  const query = queries[0];
  let pages = [response(['A', 'B'], 3), response(['C'], 3)];
  await walkSearch(async () => pages.shift(), query, '', ['A', 'B', 'C']);
  pages = [response(['A', 'B'], 3), response(['B'], 3)];
  await assert.rejects(walkSearch(async () => pages.shift(), query, '', ['A', 'B', 'C']), /Duplicate/);
  pages = [response(['A'], 3)];
  await assert.rejects(walkSearch(async () => pages.shift(), query, '', ['A', 'B', 'C']), /Exact result set/);
  await assert.rejects(walkSearch(async () => ({ ...response([], 3), body: { ...response([], 3).body, continuation: 'same' } }),
    query, '', ['A', 'B', 'C'], { continuation: true }), /Continuation repeated/);
});

test('missing, duplicated, failed or unplanned cells cannot certify an implementation', async () => {
  const report = { checks: [] }, check = recorder(report);
  await check('one', () => {});
  await check('two', () => { throw new Error('wrong artifact'); });
  assert.deepEqual(completion(report, ['one', 'two', 'three']).missing, ['three']);
  assert.deepEqual(completion(report, ['one', 'two']).failed, ['two']);
  await assert.rejects(check('one', () => {}), /executed twice/);
  assert.equal(completion({ checks: [{ id: 'one' }, { id: 'one' }] }, ['one']).complete, false);
  assert.equal(completion(report, ['one']).complete, false);
});

test('offline modes cannot call live execution, even with mixed or misspelled flags', async t => {
  let live = 0;
  t.mock.method(console, 'log', () => {});
  assert.equal(await main([], { executeLive: async () => { live++; } }), 0);
  assert.equal(await main(['--plan', '--tier=all'], { executeLive: async () => { live++; } }), 0);
  for (const flags of [['--live', '--plan'], ['--live', '--check'], ['--live', '--validate'], ['--live'], ['--lve'], ['--tier=no']])
    assert.throws(() => parseOptions(flags));
  assert.equal(live, 0);
  assert.equal(plan().status, 'OFFLINE_PLAN_NOT_EXECUTED');
  assert.ok(plan().openContracts.length && plan().exclusions.length);
});

test('offline guard rejects HTTP and raw TCP rather than trusting tests not to call the stack', async () => {
  assert.throws(() => fetch('http://127.0.0.1:9002'), /Network access is forbidden/);
  const net = await import('node:net');
  assert.throws(() => net.connect(9002, '127.0.0.1'), /Network access is forbidden/);
});

function fakeStore() {
  const store = new Map(), calls = [];
  let sequence = 0;
  const request = async (actor, method, path, body, options = {}) => {
    calls.push({ actor, method, path, body: structuredClone(body), options });
    if (method === 'POST') {
      const collection = path.split('?')[0].slice(1), id = `https://example.org/${collection}/${++sequence}`;
      const value = { ...body, '@id': id };
      store.set(`/${collection}/${encodeURIComponent(id)}`, value);
      return { status: 201, body: value };
    }
    if (method === 'DELETE') { store.delete(path); return { status: 204 }; }
    return store.has(path) ? { status: 200, body: structuredClone(store.get(path)), headers: new Headers({ etag: '"1"' }) }
      : { status: 404 };
  };
  return { request, store, calls };
}
test('fixture ledger survives a lost readback and cleanup targets only recorded identities', async () => {
  const fake = fakeStore(), report = { fixtures: [], mutations: [] };
  const f = new Fixtures({ request: fake.request, owner: 'o', reader: 'r', scope: 'SearchCorpusabc', report });
  await f.folder('root', 'home');
  await f.create('field', 'template-fields', { '@id': null, 'schema:name': 'Known' }, { folder: f.id('root') });
  const before = [...fake.store.keys()];
  fake.store.set('/templates/unrelated', { '@id': 'unrelated' });
  assert.deepEqual(await f.cleanup(), []);
  assert.deepEqual([...fake.store.keys()], ['/templates/unrelated']);
  assert.deepEqual(fake.calls.filter(call => call.method === 'DELETE').map(call => call.path), before.reverse());
  assert.ok(fake.calls.filter(call => call.method === 'DELETE').every(call => call.options.conditional));

  const failing = fakeStore(), brokenReport = { fixtures: [], mutations: [] };
  let rejectRead = true;
  const g = new Fixtures({ request: async (...args) => {
    if (args[1] === 'GET' && rejectRead) { rejectRead = false; throw new Error('lost readback'); }
    return failing.request(...args);
  }, owner: 'o', reader: 'r', scope: 'SearchCorpusdef', report: brokenReport });
  await assert.rejects(g.create('failed', 'templates', {}), /lost readback/);
  assert.equal(g.created.length, 1);
  assert.deepEqual(await g.cleanup(), []);
  assert.equal(failing.store.size, 0);
});

test('ambiguous create and failed cleanup remain explicit failures', async () => {
  const report = { fixtures: [], mutations: [] };
  const f = new Fixtures({ request: async () => { throw new Error('lost POST'); }, owner: 'o', reader: 'r', report });
  await assert.rejects(f.create('unknown', 'templates', {}), /lost POST/);
  assert.match((await f.cleanup())[0].message, /unresolved/);
  const fake = fakeStore(), report2 = { fixtures: [], mutations: [] };
  const g = new Fixtures({ request: fake.request, owner: 'o', reader: 'r', report: report2 });
  await g.create('known', 'templates', {});
  g.request = async () => ({ status: 503, text: 'down' });
  assert.equal((await g.cleanup()).length, 1);
});

test('a definite validation refusal is recorded as rejected rather than an unresolved create', async () => {
  const report = { fixtures: [], mutations: [] };
  const f = new Fixtures({ request: async () => ({ status: 400, text: 'invalidData' }), report });
  await assert.rejects(f.create('invalid', 'templates', {}), /invalidData/);
  assert.equal(report.fixtures[0].state, 'rejected');
  assert.deepEqual(await f.cleanup(), []);
});

test('browser scenarios have a fixed manifest and use actual returned/rendered identities', () => {
  const source = readFileSync(new URL('./journey.mjs', import.meta.url), 'utf8');
  const ids = [...source.matchAll(/check\('journey\/([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, journeyScenarios.map(item => item.id));
  assert.match(source, /data-resource-id/);
  assert.match(source, /exactResults/);
  assert.ok(journeyScenarios.filter(item => item.case).every(item => queries.some(query => query.id === item.case)));
});
