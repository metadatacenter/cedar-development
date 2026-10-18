import assert from 'node:assert/strict';
import { definitions } from './corpus.mjs';
import { hiddenFromReader, expectedAliases } from './queries.mjs';
import { contentMatrix, accessMatrix, accessConfigurations, accessStates, pagingMatrix, lifecycleChecks } from './matrix.mjs';
import { exactResults, assertNoDisclosure, converge, searchPath, walkSearch, resultMetadata, resultAuthority } from './assertions.mjs';

export function recorder(report, checkpoint = () => {}) {
  const seen = new Set();
  return async (id, action) => {
    assert.ok(!seen.has(id), `Matrix cell executed twice: ${id}`);
    seen.add(id);
    const start = Date.now();
    try {
      const detail = await action();
      report.checks.push({ id, status: 'pass', elapsedMs: Date.now() - start, ...(detail ? { detail } : {}) });
    } catch (error) {
      report.checks.push({ id, status: 'fail', elapsedMs: Date.now() - start, message: error.message });
    }
    checkpoint();
  };
}
export function completion(report, expected) {
  const actual = report.checks.map(check => check.id);
  const missing = expected.filter(id => !actual.includes(id));
  const unexpected = actual.filter(id => !expected.includes(id));
  return { missing, unexpected, failed: report.checks.filter(check => check.status === 'fail').map(check => check.id),
    complete: missing.length === 0 && unexpected.length === 0 && new Set(actual).size === actual.length };
}

export async function awaitCorpus(fixtures, request, report) {
  for (const actor of ['owner', 'reader']) {
    const expected = definitions.filter(spec => actor === 'owner' || !hiddenFromReader.has(spec.alias)).map(spec => fixtures.id(spec.alias));
    const test = { query: fixtures.scope, types: ['field', 'element', 'template', 'instance'] };
    report.readiness.push({ actor, ...await converge(async () => {
      exactResults(await request(actor, 'GET', searchPath(test, '')), expected);
    }, { describe: `${actor} whole-corpus baseline` }) });
  }
}

export async function runRest({ fixtures, request, report, scope, check }) {
  const metadata = new Map(definitions.map(spec => [fixtures.id(spec.alias), { name: spec.name, kind: spec.kind }]));
  for (const row of contentMatrix) await check(row.id, async () => {
    const path = searchPath(row.test, scope, { endpoint: row.endpoint });
    const response = await request(row.actor, 'GET', path);
    exactResults(response, row.expected.map(alias => fixtures.id(alias)));
    resultMetadata(response, metadata);
  });
  for (const row of pagingMatrix) await check(row.id, () => walkSearch(
    path => request(row.actor, 'GET', path), row.test, scope,
    expectedAliases(row.test, row.actor).map(alias => fixtures.id(alias)), { continuation: row.mode === 'continuation' }));

  // Each configuration owns its instance and folder. Permission changes never touch existing user
  // groups, home ACLs, or artifacts outside this run. The owner/member identities remain constant.
  for (const [number, config] of accessConfigurations.entries()) {
    const alias = `SearchAccess${number}`, parent = `access-parent-${number}`, child = `access-child-${number}`;
    await fixtures.folder(parent, fixtures.id('root'));
    await fixtures.folder(child, fixtures.id(parent));
    await fixtures.mutable(alias, fixtures.id(child));
    const id = fixtures.id(alias);
    const testFor = query => ({ query: query === 'value' ? `Notes:${alias}` : alias, types: ['instance'] });
    await converge(async () => exactResults(await request('owner', 'GET', searchPath(testFor('name'), scope)), [id]),
      { describe: `${alias} owner indexed before absence checks` });
    for (const state of accessStates) {
      if (state !== 'private') {
        const grant = state === 'granted';
        const target = config.source.includes('inherited') ? parent : alias;
        const kind = config.source === 'inherited' ? 'direct' : config.source === 'everybody-inherited' ? 'everybody' : config.source;
        await fixtures.permissions(target, grant ? { [kind]: config.role } : {});
        if (!grant) {
          // Security assertion is immediate; eventual index cleanup must not hide a disclosure.
          for (const endpoint of ['search', 'search-deep'])
            assertNoDisclosure(await request('reader', 'GET', searchPath(testFor('value'), scope, { endpoint })), [id]);
        }
        await converge(async () => exactResults(await request('reader', 'GET', searchPath(testFor('name'), scope)), grant ? [id] : []),
          { describe: `${config.source}/${config.role}/${state} projection` });
      }
      const read = await request('reader', 'GET', fixtures.path(alias));
      assert.equal(read.status, state === 'granted' ? 200 : 403, 'Graph read and declared permission state differ');
      for (const row of accessMatrix.filter(row => row.source === config.source && row.role === config.role && row.state === state))
        await check(row.id, async () => {
          const response = await request(row.actor, 'GET', searchPath({ ...testFor(row.query), parameters: { sharing: row.sharing } }, scope,
            { endpoint: row.endpoint }));
          exactResults(response, row.visible ? [id] : []);
          for (const hit of response.body.resources) resultAuthority(hit, config.role, row.actor === 'owner');
        });
    }
  }
  await lifecycle({ fixtures, request, scope, check });
}

async function lifecycle({ fixtures: f, request, scope, check }) {
  const alias = 'SearchLifecycleRecord';
  await f.mutable(alias);
  const id = f.id(alias), test = query => ({ query, types: ['instance'] });
  const search = (actor, query) => request(actor, 'GET', searchPath(test(query), scope));
  const expect = (actor, query, ids) => exactResultsSearch(actor, query, ids);
  async function exactResultsSearch(actor, query, ids) { exactResults(await search(actor, query), ids); }
  const settled = (actor, query, ids) => converge(() => expect(actor, query, ids), { describe: `${actor}: ${query}` });
  const record = (key, action) => check(`lifecycle/${key}`, action);
  await settled('owner', alias, [id]);
  await settled('owner', `Notes:${alias}`, [id]);
  await f.update(alias, body => { body['schema:name'] = `${f.scope} Renamedlifecycle`; body.Notes = { '@value': 'Changedlifecycle' }; });
  await record('rename-new', () => settled('owner', 'Renamedlifecycle', [id]));
  await record('rename-old-gone', () => settled('owner', alias, []));
  await record('value-new', () => settled('owner', 'Notes:Changedlifecycle', [id]));
  await record('value-old-gone', () => settled('owner', `Notes:${alias}`, []));

  await f.update(alias, body => {
    body['@context'].topic = 'https://example.org/search-corpus/properties/topic';
    body.topic = { '@id': 'https://example.org/terms/lifecycle-old', 'rdfs:label': 'Oldlifeterm' };
  });
  await settled('owner', 'topic:https://example.org/terms/lifecycle-old', [id]);
  await settled('owner', 'topic:Oldlifeterm', [id]);
  await f.update(alias, body => { body.topic = { '@id': 'https://example.org/terms/lifecycle-new', 'rdfs:label': 'Newlifeterm' }; });
  await record('term-uri-new', () => settled('owner', 'topic:https://example.org/terms/lifecycle-new', [id]));
  await record('term-uri-old-gone', () => settled('owner', 'topic:https://example.org/terms/lifecycle-old', []));
  await record('term-label-new', () => settled('owner', 'topic:Newlifeterm', [id]));
  await record('term-label-old-gone', () => settled('owner', 'topic:Oldlifeterm', []));

  await f.permissions(alias, { direct: 'viewer', group: 'viewer' });
  await record('overlap-granted', () => settled('reader', 'Notes:Changedlifecycle', [id]));
  await f.permissions(alias, { direct: 'viewer' });
  await record('overlap-group-removed', () => settled('reader', 'Notes:Changedlifecycle', [id]));
  await f.permissions(alias, {});
  await record('overlap-last-grant-removed', async () => {
    assertNoDisclosure(await search('reader', 'Notes:Changedlifecycle'), [id]);
    await settled('reader', 'Notes:Changedlifecycle', []);
  });
  await f.permissions(alias, { group: 'viewer' });
  await record('membership-granted', () => settled('reader', 'Notes:Changedlifecycle', [id]));
  await f.membership(false);
  await record('membership-removed', async () => {
    assert.equal((await request('reader', 'GET', f.path(alias))).status, 403);
    assertNoDisclosure(await search('reader', 'Notes:Changedlifecycle'), [id]);
    await settled('reader', 'Notes:Changedlifecycle', []);
  });
  await f.membership(true);
  await record('membership-restored', () => settled('reader', 'Notes:Changedlifecycle', [id]));
  await f.permissions(alias, {});
  await settled('reader', 'Notes:Changedlifecycle', []);
  await f.move(alias, 'inherited-child');
  await record('move-inherited-grant', () => settled('reader', 'Notes:Changedlifecycle', [id]));
  await f.move(alias, 'root');
  await record('move-private-revocation', async () => {
    assertNoDisclosure(await search('reader', 'Notes:Changedlifecycle'), [id]);
    await settled('reader', 'Notes:Changedlifecycle', []);
  });
  await f.remove(alias);
  await record('delete-removes-content', () => settled('owner', 'Notes:Changedlifecycle', []));
  await record('delete-read-404', async () => assert.equal((await request('owner', 'GET', f.path(alias))).status, 404));

  const pitIds = [];
  for (let i = 0; i < 3; i++) {
    const key = `SearchContinuation${i}`;
    pitIds.push(await f.mutable(key));
    await f.update(key, body => { body.Notes = { '@value': 'Continuationwitness' }; });
    await f.permissions(key, { direct: 'viewer' });
  }
  await settled('reader', 'Notes:Continuationwitness', pitIds);
  const pitTest = test('Notes:Continuationwitness');
  const first = await request('reader', 'GET', searchPath(pitTest, scope, { endpoint: 'search-deep', limit: 1, continuation: 'start' }));
  assert.equal(first.status, 200);
  assert.equal(first.body.resources.length, 1);
  assert.ok(first.body.continuation, 'Three hits at limit one must produce a continuation');
  await record('continuation-cross-user-refused', async () => {
    const reply = await request('owner', 'GET', searchPath(pitTest, scope,
      { endpoint: 'search-deep', limit: 1, continuation: first.body.continuation }));
    assert.equal(reply.status, 400, 'Continuation must be bound to its caller');
  });
  await record('continuation-sharing-change-refused', async () => {
    const reply = await request('reader', 'GET', searchPath({ ...pitTest, parameters: { sharing: 'shared-with-everybody' } }, scope,
      { endpoint: 'search-deep', limit: 1, continuation: first.body.continuation }));
    assert.equal(reply.status, 400, 'Continuation must be bound to its sharing view');
  });
  for (let i = 0; i < 3; i++) await f.permissions(`SearchContinuation${i}`, {});
  await record('continuation-revocation', async () => {
    let token = first.body.continuation;
    const seen = new Set();
    for (let page = 0; token && page < 5; page++) {
      assert.ok(!seen.has(token), 'Revoked continuation must advance through denied rows');
      seen.add(token);
      const response = await request('reader', 'GET', searchPath(pitTest, scope, { endpoint: 'search-deep', limit: 1, continuation: token }));
      assertNoDisclosure(response, pitIds);
      assert.equal(response.body.resources.length, 0);
      token = response.body.continuation;
    }
    assert.ok(!token, 'Revoked continuation did not terminate');
  });
}

export const restCheckIds = [...contentMatrix, ...pagingMatrix, ...accessMatrix].map(row => row.id).concat(lifecycleChecks);
