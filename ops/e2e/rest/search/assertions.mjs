import assert from 'node:assert/strict';

export function exactResults(response, expectedIds, { total = true, ordered = false } = {}) {
  assert.equal(response.status, 200, `Search status ${response.status}: ${response.text ?? ''}`);
  assert.ok(Array.isArray(response.body?.resources), 'Search must return a resources array');
  const ids = response.body.resources.map(row => row['@id']);
  assert.ok(ids.every(id => typeof id === 'string' && id), 'Every result must carry an identifier');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate hits are not a passing set comparison');
  assert.deepEqual(ordered ? ids : [...ids].sort(), ordered ? expectedIds : [...expectedIds].sort(),
    'Exact result set differs (extra hits, including foreign or forbidden artifacts, are failures)');
  if (total) assert.equal(response.body.totalCount, expectedIds.length, 'totalCount must match the static permitted set');
  return ids;
}

export function assertNoDisclosure(response, forbiddenIds) {
  assert.equal(response.status, 200, `Search failed: ${response.status}`);
  assert.ok(Array.isArray(response.body?.resources));
  const body = JSON.stringify(response.body);
  for (const id of forbiddenIds) assert.ok(!body.includes(id), `Forbidden identity disclosed: ${id}`);
}

export function resultMetadata(response, expected) {
  for (const row of response.body.resources) {
    const item = expected.get(row['@id']);
    assert.ok(item, `Unexpected resource ${row['@id']}`);
    assert.equal(row['schema:name'], item.name, 'Search displayed a stale or incorrect artifact name');
    assert.equal(row.resourceType, item.kind, 'Search returned the wrong artifact kind');
    assert.equal(row.activeUserCanRead, true, 'A term search returned a redacted/unreadable row');
  }
}

export function resultAuthority(row, role, owner) {
  const permissions = row.currentUserPermissions;
  assert.ok(Array.isArray(permissions?.capabilities), 'Search omitted current user capabilities');
  assert.equal(permissions.owner, owner, 'Search misreported ownership');
  assert.ok(permissions.capabilities.includes('readResource'), 'Search omitted read authority');
  if (!owner) {
    assert.equal(permissions.role, role, 'Search inflated or reduced the declared role');
    assert.equal(permissions.capabilities.includes('updateResource'), role !== 'viewer', 'Incorrect edit capability');
    assert.equal(permissions.capabilities.includes('manageGrants'), role === 'manager', 'Incorrect grant-management capability');
  }
}

export function scopedQuery(query, scope) {
  if (!scope) return query;
  assert.match(scope, /^SearchCorpus[0-9a-f]+$/, 'Scope must be one safe, unique token');
  return `${scope} AND (${query})`;
}

export function searchPath(test, scope, { endpoint = 'search', limit = 100, offset = 0, continuation } = {}) {
  const params = new URLSearchParams({ q: scopedQuery(test.query, scope), resource_types: test.types.join(','),
    version: 'all', publication_status: 'all', limit: String(limit), sort: 'name', ...test.parameters });
  if (continuation !== undefined) params.set('continuation', continuation);
  else params.set('offset', String(offset));
  return `/${endpoint}?${params}`;
}

// Used only for asynchronous setup/mutations, never to retry a failed static query until it passes.
export async function converge(probe, { timeoutMs = 20000, intervalMs = 250, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), describe = 'index projection' } = {}) {
  const start = now();
  let attempts = 0, last;
  do {
    attempts++;
    try { await probe(); return { attempts, elapsedMs: now() - start }; }
    catch (error) { last = error; }
    if (now() - start >= timeoutMs) break;
    await sleep(Math.min(intervalMs, timeoutMs - (now() - start)));
  } while (true);
  throw new Error(`${describe} did not converge in ${now() - start} ms (${attempts} probes): ${last?.message}`, { cause: last });
}

export async function walkSearch(request, test, scope, expectedIds, { continuation = false, pageSize = 2 } = {}) {
  const rows = [], seenTokens = new Set();
  let token = 'start';
  // The extra empty page is intentional for offset walks; limits bound buggy endless pagination.
  for (let page = 0; page <= Math.ceil(expectedIds.length / pageSize) + 1; page++) {
    const response = await request(searchPath(test, scope, { endpoint: 'search-deep', limit: pageSize,
      ...(continuation ? { continuation: token } : { offset: page * pageSize }) }));
    assert.equal(response.status, 200, response.text);
    assert.ok(Array.isArray(response.body?.resources), 'Missing paged resources');
    assert.equal(response.body.totalCount, expectedIds.length, 'Static paging total changed');
    assert.ok(response.body.resources.length <= pageSize, 'Page limit ignored');
    for (const link of Object.values(response.body.paging ?? {})) {
      if (typeof link !== 'string' || !link) continue;
      assert.equal(new URL(link, 'https://resource.example').searchParams.get('q'),
        scopedQuery(test.query, scope), 'Returned pagination link changed the expression');
    }
    rows.push(...response.body.resources);
    if (continuation) {
      token = response.body.continuation;
      if (!token) break;
      assert.ok(!seenTokens.has(token), 'Continuation repeated without advancing');
      seenTokens.add(token);
    } else if (response.body.resources.length < pageSize) break;
    assert.ok(page < Math.ceil(expectedIds.length / pageSize) + 1, 'Search walk did not terminate');
  }
  exactResults({ status: 200, body: { resources: rows, totalCount: expectedIds.length } }, expectedIds);
  const names = rows.map(row => row['schema:name']);
  assert.deepEqual(names, [...names].sort(), 'Name order changed across pages');
  return rows;
}
