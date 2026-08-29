import http from 'k6/http';
import { check, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const manifestPath = __ENV.CEDAR_PERF_MANIFEST;
if (!manifestPath) throw new Error('CEDAR_PERF_MANIFEST must name a prepared run.json');
const manifest = JSON.parse(open(manifestPath));
const profile = __ENV.CEDAR_PERF_PROFILE || 'quick';
const password = __ENV.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');

const resource = __ENV.CEDAR_RESOURCE_BASE || manifest.target.resource;
const keycloak = __ENV.CEDAR_KEYCLOAK_BASE || 'http://127.0.0.1:8080';
const realm = __ENV.CEDAR_KEYCLOAK_REALM || 'CEDAR';
const client = __ENV.CEDAR_KEYCLOAK_CLIENT || 'cedar-angular-app';
const configuredVus = Number(__ENV.CEDAR_PERF_VUS || (profile === 'soak' ? 50 : 10));
const configuredDuration = __ENV.CEDAR_PERF_DURATION;
const contentionWidth = Math.min(Number(__ENV.CEDAR_PERF_CONTENTION_WIDTH || 20), manifest.actors.length);

const allowedHosts = ['localhost', '127.0.0.1', 'metadatacenter.orgx'];
const targetHost = resource.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
if (__ENV.CEDAR_PERF_ALLOW_REMOTE !== '1'
    && !allowedHosts.includes(targetHost)
    && !targetHost.endsWith('.metadatacenter.orgx')) {
  throw new Error(`refusing REST performance target ${targetHost}; set CEDAR_PERF_ALLOW_REMOTE=1 explicitly`);
}

const unexpectedResponses = new Rate('cedar_unexpected_responses');
const operationDuration = new Trend('cedar_operation_duration', true);

// A stale response is expected only by the contention workload. All successful statuses remain
// expected; authentication/authorization errors and server errors contribute to http_req_failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 412));

const profiles = {
  quick: {
    scenarios: {
      mixed: {
        executor: 'ramping-vus',
        exec: 'mixed',
        startVUs: 1,
        stages: configuredDuration
          ? [{ duration: configuredDuration, target: configuredVus }]
          : [
              { duration: '30s', target: 1 },
              { duration: '1m', target: Math.min(5, configuredVus) },
              { duration: '2m', target: configuredVus },
              { duration: '1m', target: 0 },
            ],
        gracefulRampDown: '15s',
      },
    },
  },
  contention: {
    scenarios: {
      contention: {
        executor: 'constant-vus',
        exec: 'contention',
        vus: 1,
        duration: configuredDuration || '2m',
      },
    },
  },
  soak: {
    scenarios: {
      mixed: {
        executor: 'constant-vus',
        exec: 'mixed',
        vus: configuredVus,
        duration: configuredDuration || '30m',
      },
    },
  },
};

if (!profiles[profile]) throw new Error(`unknown CEDAR_PERF_PROFILE ${profile}`);

export const options = {
  ...profiles[profile],
  insecureSkipTLSVerify: true,
  batch: Math.max(20, contentionWidth),
  batchPerHost: Math.max(20, contentionWidth),
  discardResponseBodies: false,
  thresholds: {
    checks: ['rate>0.99'],
    cedar_unexpected_responses: ['rate<0.01'],
    // Initial guardrail only. Establish operation-specific baselines before tightening latency gates.
    cedar_operation_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.01'],
  },
};

function form(value) {
  return encodeURIComponent(value);
}

function login(username) {
  const response = http.post(`${keycloak}/realms/${realm}/protocol/openid-connect/token`,
      `grant_type=password&client_id=${form(client)}&username=${form(username)}&password=${form(password)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        tags: { operation: 'authentication', name: 'Keycloak token' },
        responseCallback: http.expectedStatuses(200),
      });
  if (response.status !== 200) return null;
  return response.json('access_token');
}

export function setup() {
  if (!manifest.setupComplete) fail(`fixture setup did not complete: ${manifestPath}`);
  const tokens = [];
  for (const actor of manifest.actors) {
    const token = login(actor.username);
    if (!token) fail(`could not authenticate ${actor.username}`);
    tokens.push(token);
  }
  return { tokens };
}

const localTokens = {};
const actorState = {};

function tokenFor(data, index) {
  return localTokens[index] || data.tokens[index];
}

function refresh(index) {
  const token = login(manifest.actors[index].username);
  if (token) localTokens[index] = token;
  return token;
}

function etag(response) {
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase() === 'etag') return value;
  }
  return null;
}

function revisionNumber(value) {
  const match = value?.match(/^(?:W\/)?"(\d+)/);
  return match ? Number(match[1]) : null;
}

function cedar(data, actorIndex, method, path, body, operation, extraHeaders = {}) {
  const perform = token => http.request(method, `${resource}${path}`,
      body === undefined ? null : JSON.stringify(body), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        tags: { operation, name: operation },
      });
  let response = perform(tokenFor(data, actorIndex));
  if (response.status === 401) {
    const renewed = refresh(actorIndex);
    if (renewed) response = perform(renewed);
  }
  operationDuration.add(response.timings.duration, { operation });
  return response;
}

function accepted(response, statuses, label) {
  const ok = check(response, { [label]: result => statuses.includes(result.status) });
  unexpectedResponses.add(!ok, { operation: label });
  return ok;
}

function readArtifact(data, index, actor) {
  const response = cedar(data, index, 'GET', `/templates/${encodeURIComponent(actor.readTemplate.id)}`,
      undefined, 'artifact GET');
  accepted(response, [200], 'artifact GET succeeds');
}

function listFolder(data, index, actor) {
  const response = cedar(data, index, 'GET',
      `/folders/${encodeURIComponent(actor.rootFolderId)}/contents?limit=50`, undefined, 'folder contents');
  accepted(response, [200], 'folder contents succeeds');
}

function search(data, index) {
  const response = cedar(data, index, 'GET',
      `/search?q=${encodeURIComponent(manifest.runId)}&limit=20`, undefined, 'search');
  accepted(response, [200], 'search succeeds');
}

function updateArtifact(data, index, actor) {
  const path = `/templates/${encodeURIComponent(actor.mutableTemplate.id)}`;
  const current = cedar(data, index, 'GET', path, undefined, 'artifact update preflight');
  const revision = etag(current);
  if (!accepted(current, [200], 'artifact update preflight succeeds') || !revision) {
    unexpectedResponses.add(true, { operation: 'artifact update missing ETag' });
    return;
  }
  const body = current.json();
  body['schema:description'] = `${manifest.prefix} update ${__VU}-${__ITER}`;
  const updated = cedar(data, index, 'PUT', path, body, 'conditional artifact update', { 'If-Match': revision });
  accepted(updated, [200], 'conditional artifact update succeeds');
  check(updated, { 'artifact update returns a fresh ETag': result => etag(result) && etag(result) !== revision });
}

function moveArtifact(data, index, actor) {
  const state = actorState[index] || (actorState[index] = { inSource: true, open: false });
  const id = actor.movableTemplate.id;
  const details = cedar(data, index, 'GET', `/templates/${encodeURIComponent(id)}/details`,
      undefined, 'move preflight');
  const revision = etag(details);
  if (!accepted(details, [200], 'move preflight succeeds') || !revision) {
    unexpectedResponses.add(true, { operation: 'move missing ETag' });
    return;
  }
  const targetFolderId = state.inSource ? actor.destinationFolderId : actor.sourceFolderId;
  const moved = cedar(data, index, 'POST', '/command/move-resource-to-folder',
      { '@id': id, targetFolderId }, 'conditional artifact move', { 'If-Match': revision });
  if (accepted(moved, [200, 201, 204], 'conditional artifact move succeeds')) state.inSource = !state.inSource;
  check(moved, { 'artifact move returns a fresh ETag': result => etag(result) && etag(result) !== revision });
}

function toggleOpenView(data, index, actor) {
  const state = actorState[index] || (actorState[index] = { inSource: true, open: false });
  const id = actor.openViewTemplate.id;
  const details = cedar(data, index, 'GET', `/templates/${encodeURIComponent(id)}/details`,
      undefined, 'OpenView preflight');
  const revision = etag(details);
  if (!accepted(details, [200], 'OpenView preflight succeeds') || !revision) {
    unexpectedResponses.add(true, { operation: 'OpenView missing ETag' });
    return;
  }
  const command = state.open ? 'make-artifact-not-open' : 'make-artifact-open';
  const changed = cedar(data, index, 'POST', `/command/${command}`, { '@id': id },
      'conditional OpenView toggle', { 'If-Match': revision });
  if (accepted(changed, [200], 'conditional OpenView toggle succeeds')) state.open = !state.open;
  check(changed, { 'OpenView toggle returns a fresh ETag': result => etag(result) && etag(result) !== revision });
}

export function mixed(data) {
  const index = (__VU - 1) % manifest.actors.length;
  const actor = manifest.actors[index];
  switch (__ITER % 10) {
    case 0:
    case 1:
    case 2:
    case 3:
      readArtifact(data, index, actor);
      break;
    case 4:
    case 5:
      listFolder(data, index, actor);
      break;
    case 6:
      search(data, index);
      break;
    case 7:
      updateArtifact(data, index, actor);
      break;
    case 8:
      moveArtifact(data, index, actor);
      break;
    case 9:
      toggleOpenView(data, index, actor);
      break;
  }
}

export function contention(data) {
  const ownerIndex = 0;
  const id = manifest.shared.contendedTemplate.id;
  const path = `/templates/${encodeURIComponent(id)}`;
  const current = cedar(data, ownerIndex, 'GET', path, undefined, 'contention preflight');
  const revision = etag(current);
  if (!accepted(current, [200], 'contention preflight succeeds') || !revision) {
    unexpectedResponses.add(true, { operation: 'contention missing ETag' });
    return;
  }
  const body = current.json();
  body['schema:description'] = `${manifest.prefix} contention ${__ITER}`;
  const requests = [];
  for (let index = 0; index < contentionWidth; index++) {
    requests.push({
      method: 'PUT',
      url: `${resource}${path}`,
      body: JSON.stringify(body),
      params: {
        headers: {
          Authorization: `Bearer ${tokenFor(data, index)}`,
          'Content-Type': 'application/json',
          'If-Match': revision,
        },
        tags: { operation: 'ETag contention PUT', name: 'ETag contention PUT' },
      },
    });
  }
  const responses = http.batch(requests);
  const successes = responses.filter(response => response.status === 200).length;
  const conflicts = responses.filter(response => response.status === 412).length;
  const exact = successes === 1 && conflicts === contentionWidth - 1;
  check(responses, {
    'exactly one contending update succeeds': () => successes === 1,
    'all other contending updates are stale': () => conflicts === contentionWidth - 1,
  });
  unexpectedResponses.add(!exact, { operation: 'ETag contention result' });
  for (const response of responses) operationDuration.add(response.timings.duration, { operation: 'ETag contention PUT' });

  const after = cedar(data, ownerIndex, 'GET', path, undefined, 'contention verification');
  accepted(after, [200], 'contention verification succeeds');
  check(after, {
    'contention advances the revision exactly once': result => {
      const beforeRevision = revisionNumber(revision);
      const afterRevision = revisionNumber(etag(result));
      return beforeRevision !== null && afterRevision === beforeRevision + 1;
    },
  });
}

export function handleSummary(data) {
  const output = __ENV.CEDAR_PERF_SUMMARY || 'k6-summary.json';
  const checks = data.metrics.checks?.values?.rate;
  const p95 = data.metrics.cedar_operation_duration?.values?.['p(95)'];
  return {
    [output]: JSON.stringify(data, null, 2),
    stdout: `\nCEDAR REST ${profile}: checks ${checks === undefined ? 'n/a' : (checks * 100).toFixed(2) + '%'}, HTTP p95 ${p95 === undefined ? 'n/a' : p95.toFixed(1) + ' ms'}\n`,
  };
}
