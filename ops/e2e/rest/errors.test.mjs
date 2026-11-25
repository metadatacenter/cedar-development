import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as errors from './suites/errors.mjs';
import { withSuite, summary } from './lib.mjs';

const { cedarErrorProblem, plan } = errors;

const CEDAR_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const json = { get: name => (name === 'content-type' ? 'application/json' : null) };
const answer = (status, body, headers = json) => ({ status, body, headers });
const cedarError = (statusCode, status, fields = {}) => ({
  status, statusCode, errorKey: null, errorReasonKey: null, errorType: null, message: null,
  parameters: {}, objects: {}, entities: {}, suggestedAction: 'none', operation: null, errorId: null, ...fields,
});

test('a CedarError whose status is the answer\'s passes', () => {
  assert.equal(cedarErrorProblem(answer(404, cedarError(404, 'NOT_FOUND'))), null);
  assert.equal(cedarErrorProblem(answer(502, cedarError(502, 'BAD_GATEWAY', {
    errorKey: 'upstreamServerError', objects: { report: { outcomes: [] } },
  }))), null);
  assert.equal(cedarErrorProblem(answer(404, cedarError(404, 'NOT_FOUND', {
    errorKey: 'upstreamServerError', message: 'ORCID holds no entry for "0000-0001-2345-6789" (HTTP 404).',
    parameters: { upstreamStatusCode: 404, upstreamService: 'ORCID' },
    objects: { authorityAnswer: { found: false, requestedId: '0000-0001-2345-6789', name: null, rawResponse: null, errors: [] } },
  }))), null);
});

test('each body a refusal once answered with is not a CedarError', () => {
  const bodies = {
    'a recursive deletion refusal': { code: 'FOLDER_DELETE_PROTECTED_ROOT', message: 'Home and system folders cannot be deleted.' },
    'an inclusion update report': { tree: {}, outcomes: [{ status: 'FAILED' }], complete: false },
    'a running regeneration job': { id: 'job', status: 'RUNNING', submittedAt: 1 },
    'DataCite\'s own refusal': { errors: [{ status: '404', title: 'The resource you are looking for doesn\'t exist.' }] },
    'an external authority\'s refused lookup': {
      found: false, requestedId: '0000-0001-2345-6789', name: null, rawResponse: { error: 'not found' }, errors: ['not found'],
    },
    'an external authority\'s refused search': {
      request: { limit: 100, offset: 0 }, totalCount: 0, currentOffset: 0, paging: {}, found: false, results: {},
      page: 0, pageSize: 100, errors: ['bad query'],
    },
  };
  for (const [name, body] of Object.entries(bodies)) assert.ok(cedarErrorProblem(answer(409, body)), name);
});

test('a CedarError with the wrong status, a field of its own or no JSON type is refused', () => {
  assert.match(cedarErrorProblem(answer(400, cedarError(404, 'NOT_FOUND'))), /not the status/);
  assert.match(cedarErrorProblem(answer(400, { ...cedarError(400, 'BAD_REQUEST'), code: 'X' })), /carries code/);
  const { message, ...withoutMessage } = cedarError(400, 'BAD_REQUEST');
  assert.match(cedarErrorProblem(answer(400, withoutMessage)), /carries no message/);
  assert.match(cedarErrorProblem(answer(502, '<html>', { get: () => 'text/html' })), /text\/html/);
});

/** Every operation in every committed document, with the probes the suite would send it. */
function plans() {
  const all = [];
  for (const server of ['resource', 'artifact', 'repo', 'terminology', 'user', 'group', 'worker',
    'messaging', 'openview', 'monitor', 'bridge']) {
    const spec = JSON.parse(readFileSync(resolve(CEDAR_HOME, `cedar-${server}-server`, `cedar-${server}-server-application`,
        'src/main/resources/assets/swagger-api/swagger.json'), 'utf8'));
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (['get', 'put', 'post', 'patch', 'delete'].includes(method)) {
          all.push({ server, method: method.toUpperCase(), path, ...plan(server, spec, method, path, op) });
        }
      }
    }
  }
  return all;
}

test('no request reaches DataCite, BioPortal or an external registry', () => {
  const all = plans();
  const of = (server, method, path) => all.find(p => p.server === server && p.method === method && p.path === path);
  assert.deepEqual(of('bridge', 'GET', '/datacite/doi-metadata/{id}').probes.map(p => p.kind), ['anonymous']);
  for (const path of ['/bioportal/search', '/bioportal/ontologies/{ontology}/classes/{id}/descendants']) {
    assert.deepEqual(of('terminology', 'GET', path).probes, [], path);
  }
  for (const p of all.filter(p => p.server === 'terminology' && p.path.startsWith('/bioportal/') && p.method === 'GET')) {
    assert.ok(p.probes.every(probe => probe.kind === 'anonymous'), p.path);
  }
  for (const p of all.filter(p => p.path.startsWith('/ext-auth/'))) {
    for (const probe of p.probes) assert.match(probe.request.path, /^\/ext-auth\/no-such-authority-/, p.path);
  }
});

test('an operation that makes a credential optional is not probed without one', () => {
  const spec = { paths: {} };
  const required = { security: [{ api_key: [] }], responses: {} };
  const optional = { security: [{ api_key: [] }, {}], responses: {} };
  assert.deepEqual(plan('x', spec, 'get', '/things', required).probes.map(p => p.kind), ['anonymous']);
  assert.deepEqual(plan('x', spec, 'get', '/things', optional).probes, []);
  assert.deepEqual(plan('x', spec, 'get', '/things/{id}', optional).probes.map(p => [p.kind, p.request.auth]),
    [['identifier', 'none']]);
});

test('a credentialed write names nothing that exists or carries no JSON, and one taking no input is sent none', () => {
  for (const p of plans()) {
    for (const probe of p.probes) {
      if (probe.request.method === 'GET') continue;
      if (probe.request.auth !== 'none') {
        assert.ok(p.path.includes('{') || probe.request.body === '{"', `${p.server} ${p.method} ${p.path}`);
      }
      if (!p.path.includes('{') && probe.request.body === undefined) {
        assert.equal(probe.request.auth, 'none', `${p.server} ${p.method} ${p.path} takes no input`);
      }
    }
  }
});

test('an anonymous probe sends a body that parses, every required query parameter and a required If-Match', () => {
  for (const p of plans()) {
    for (const probe of p.probes.filter(probe => probe.kind === 'anonymous')) {
      const where = `${p.server} ${p.method} ${p.path}`;
      assert.ok(probe.request.body === undefined || probe.request.body === '{}', where);
    }
  }
  const of = (server, method, path) => plans().find(p => p.server === server && p.method === method && p.path === path)
    .probes.find(probe => probe.kind === 'anonymous').request;
  assert.match(of('terminology', 'GET', '/bioportal/property_search').path, /\?q=x$/);
  assert.match(of('bridge', 'POST', '/datacite/create-doi').path, /\?source_artifact_id=.*&state=draft$/);
  assert.equal(of('resource', 'DELETE', '/templates/{template_id}').headers['If-Match'], '"0"');
});

/** Every service as a stub: a CedarError with the status the answer function gives each request. */
function stubStack(t, answer) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const status = answer(new URL(url), options);
    const name = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 500: 'INTERNAL_SERVER_ERROR' }[status];
    return new Response(JSON.stringify(cedarError(status, name)),
        { status, headers: { 'content-type': 'application/json' } });
  });
}

const user = { auth: 'user-token', profile: {} };
let stubbed = 0;
async function anonymousVerdicts(t, answer) {
  stubStack(t, answer);
  const name = `errors-stub-${stubbed++}`;
  await withSuite(name, () => errors.run({ user1: user, homeFolderId: 'home', folderId: 'folder' }));
  return summary([name]).checks.filter(c => c.name.endsWith('a request without credentials is refused in a CedarError'));
}

test('an operation that looks up its identifier or reads its body before authenticating fails the anonymous check', async t => {
  const verdicts = await anonymousVerdicts(t, (url, options) => {
    if (options.headers?.Authorization) return 404;
    // No authentication on any route that names an identifier: the lookup answers first.
    return /\/(templates|folders|groups|users)\//.test(decodeURIComponent(url.pathname)) ? 404 : 401;
  });
  const failed = verdicts.filter(c => c.status === 'failed').map(c => c.name.split(':')[0]);
  for (const server of ['resource', 'artifact', 'group', 'user']) assert.ok(failed.includes(server), server);

  const bodyFirst = await anonymousVerdicts(t, (_url, options) =>
    options.headers?.Authorization ? 404 : options.body !== undefined ? 400 : 401);
  assert.ok(bodyFirst.some(c => c.name.startsWith('resource:') && c.status === 'failed'));
});

test('every anonymous check passes when each service answers 401 without credentials', async t => {
  const verdicts = await anonymousVerdicts(t, (_url, options) => (options.headers?.Authorization ? 404 : 401));
  assert.equal(verdicts.length, 11);
  assert.ok(verdicts.every(c => c.status === 'passed'), JSON.stringify(verdicts.filter(c => c.status !== 'passed')));
});

test('an operation named as validating first may answer its named status, and only that one', async t => {
  const entry = { server: 'terminology', method: 'GET', path: '/bioportal/property_search', status: 400,
    reason: 'an entry for this test' };
  errors.VALIDATES_FIRST.push(entry);
  try {
    const answer = status => (url, options) => (options.headers?.Authorization ? 404
      : url.pathname.endsWith('/bioportal/property_search') ? status : 401);
    const terminology = verdicts => verdicts.find(c => c.name.startsWith('terminology:')).status;
    assert.equal(terminology(await anonymousVerdicts(t, answer(400))), 'passed');
    assert.equal(terminology(await anonymousVerdicts(t, answer(404))), 'failed');
    assert.equal(terminology(await anonymousVerdicts(t, answer(401))), 'passed');
  } finally {
    errors.VALIDATES_FIRST.splice(errors.VALIDATES_FIRST.indexOf(entry), 1);
  }
});

test('a server error fails the identifier and body checks unless the operation documents it as a gateway answer', async t => {
  const verdictsFor = async status => {
    stubStack(t, (url, options) => (!options.headers?.Authorization ? 401
      : url.pathname.includes('/no-such-authority-') ? 502 : status));
    const name = `errors-stub-${stubbed++}`;
    await withSuite(name, () => errors.run({ user1: user, homeFolderId: 'home', folderId: 'folder' }));
    return summary([name]).checks;
  };
  const crashed = await verdictsFor(500);
  for (const what of ['resource: a nonexistent identifier', 'resource: a malformed JSON body']) {
    assert.equal(crashed.find(c => c.name.startsWith(what)).status, 'failed', what);
  }
  const refused = await verdictsFor(404);
  assert.equal(refused.find(c => c.name.startsWith('resource: a nonexistent identifier')).status, 'passed');
  // The bridge's authority routes document 502, which a registry that answers badly produces.
  assert.equal(refused.find(c => c.name.startsWith('bridge: a nonexistent identifier')).status, 'passed');
});
