import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cedarErrorProblem, plan } from './suites/errors.mjs';

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
  for (const server of ['resource', 'artifact', 'repo', 'terminology', 'user', 'valuerecommender', 'impex', 'group',
    'submission', 'worker', 'messaging', 'openview', 'monitor', 'bridge']) {
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
  assert.deepEqual(of('bridge', 'GET', '/datacite/get-doi-metadata/{id}').probes.map(p => p.kind), ['anonymous']);
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
