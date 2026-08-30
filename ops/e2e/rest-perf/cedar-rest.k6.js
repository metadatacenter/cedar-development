import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { scheduledValue } from './schedule.js';

const manifestPath = __ENV.CEDAR_PERF_MANIFEST;
if (!manifestPath) throw new Error('CEDAR_PERF_MANIFEST must name a prepared run.json');
const manifest = JSON.parse(open(manifestPath));
const profile = __ENV.CEDAR_PERF_PROFILE || 'quick';
const password = __ENV.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');

const resource = __ENV.CEDAR_RESOURCE_BASE || manifest.target.resource;
const groupServer = __ENV.CEDAR_GROUP_BASE || manifest.target.group || 'https://group.metadatacenter.orgx';
const keycloak = __ENV.CEDAR_KEYCLOAK_BASE || 'http://127.0.0.1:8080';
const realm = __ENV.CEDAR_KEYCLOAK_REALM || 'CEDAR';
const client = __ENV.CEDAR_KEYCLOAK_CLIENT || 'cedar-angular-app';
const configuredVus = Number(__ENV.CEDAR_PERF_VUS || (profile === 'soak' ? 50 : 10));
const configuredDuration = __ENV.CEDAR_PERF_DURATION;
const contentionWidth = Math.min(Number(__ENV.CEDAR_PERF_CONTENTION_WIDTH || 20), manifest.actors.length);
const matrixRounds = Number(__ENV.CEDAR_PERF_ROUNDS || manifest.matrixRounds || 3);
const scheduleSeed = String(__ENV.CEDAR_PERF_SEED || manifest.scheduleSeed || manifest.runId);
const faultStartEpochMs = Number(__ENV.CEDAR_PERF_FAULT_START_EPOCH_MS || 0);
const recoveryBudgetMs = Number(__ENV.CEDAR_PERF_RECOVERY_BUDGET_MS || 0);
const churnRate = Number(__ENV.CEDAR_PERF_CHURN_RATE || 2);
const burstBaselineRate = Number(__ENV.CEDAR_PERF_BURST_BASELINE_RATE || 5);
const burstPeakRate = Number(__ENV.CEDAR_PERF_BURST_PEAK_RATE || 40);
const burstPhaseDuration = __ENV.CEDAR_PERF_BURST_PHASE_DURATION || '30s';
const burstPhaseSeconds = Number(__ENV.CEDAR_PERF_BURST_PHASE_SECONDS || 30);

const allowedHosts = ['localhost', '127.0.0.1', 'metadatacenter.orgx'];
const targetHost = resource.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
if (__ENV.CEDAR_PERF_ALLOW_REMOTE !== '1'
    && !allowedHosts.includes(targetHost)
    && !targetHost.endsWith('.metadatacenter.orgx')) {
  throw new Error(`refusing REST performance target ${targetHost}; set CEDAR_PERF_ALLOW_REMOTE=1 explicitly`);
}

const unexpectedResponses = new Rate('cedar_unexpected_responses');
const invariantFailures = new Rate('cedar_invariant_failures');
const hotsetConflictRate = new Rate('cedar_hotset_conflict_rate');
const resilienceUnexpected = new Rate('cedar_resilience_unexpected');
const resilienceOutageResponses = new Counter('cedar_resilience_outage_responses');
const resilienceRecoveredResponses = new Counter('cedar_resilience_recovered_responses');
const churnCompleted = new Counter('cedar_churn_completed');
const burstBaselineCompleted = new Counter('cedar_burst_baseline_completed');
const burstPeakCompleted = new Counter('cedar_burst_peak_completed');
const burstRecoveryCompleted = new Counter('cedar_burst_recovery_completed');
const burstBaselineDuration = new Trend('cedar_burst_baseline_duration', true);
const burstPeakDuration = new Trend('cedar_burst_peak_duration', true);
const burstRecoveryDuration = new Trend('cedar_burst_recovery_duration', true);
const operationDuration = new Trend('cedar_operation_duration', true);
const artifactKinds = ['template', 'element', 'field', 'instance'];
const destructiveKinds = ['template', 'element', 'field', 'instance', 'folder', 'group', 'category'];
const wildcardTypes = [
  'wildcard-content', 'wildcard-artifact-graph', 'wildcard-folder-graph',
  'wildcard-artifact-acl', 'wildcard-folder-acl', 'wildcard-group-record',
  'wildcard-group-membership', 'wildcard-category-record', 'wildcard-category-acl',
];
const soakOperations = [
  'template-read', 'element-read', 'field-read', 'instance-read',
  'template-read', 'element-read', 'field-read', 'instance-read',
  'folder-list', 'search', 'template-update', 'element-update',
  'field-update', 'instance-update', 'folder-list', 'search',
  'artifact-move', 'openview-toggle', 'artifact-acl', 'folder-acl',
  'group-record', 'group-membership', 'category-record', 'category-acl',
];
const hotsetOperations = ['template', 'element', 'field', 'instance', 'folder', 'group', 'category'];
const resilienceOperations = ['read', 'read', 'read', 'update'];
const burstOperations = ['read', 'read', 'read', 'update'];
const churnCollections = {
  template: '/templates',
  element: '/template-elements',
  field: '/template-fields',
  instance: '/template-instances',
};
const churnFixtures = Object.fromEntries(artifactKinds.map(kind => [
  kind, JSON.parse(open(`../fixtures/minimal-${kind}.json`)),
]));

function routeMetricName(operation) {
  return `cedar_route_${operation.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_duration`;
}

const measuredOperations = [
  'artifact GET', 'folder contents', 'search', 'artifact update preflight',
  'conditional artifact update', 'move preflight', 'conditional artifact move',
  'OpenView preflight', 'conditional OpenView toggle',
  'contention preflight', 'contention verification',
  'artifact graph preflight', 'artifact graph move', 'artifact graph OpenView',
  'folder graph preflight', 'folder graph update', 'folder graph move', 'folder graph OpenView',
  'artifact ACL preflight', 'artifact ACL update', 'folder ACL preflight', 'folder ACL update',
  'group record preflight', 'group record PUT', 'group record PATCH',
  'group membership preflight', 'group membership update',
  'category record preflight', 'category record update',
  'category ACL preflight', 'category ACL update',
  'update-delete preflight', 'update-delete update', 'update-delete delete',
  'double-delete preflight', 'double-delete delete',
  'wildcard-delete preflight', 'wildcard delete', 'wildcard recreate',
  'wildcard preflight', 'wildcard update', 'wildcard verification',
  ...artifactKinds.flatMap(kind =>
    [`contention ${kind} GET`, `contention ${kind} PUT`, `contention ${kind} verification`]),
  ...artifactKinds.flatMap(kind =>
    [`soak ${kind} GET`, `soak ${kind} update preflight`, `soak ${kind} conditional PUT`]),
  ...artifactKinds.flatMap(kind => [`hotset ${kind} GET`, `hotset ${kind} PUT`]),
  'hotset folder GET', 'hotset folder PUT', 'hotset group GET', 'hotset group PATCH',
  'hotset category GET', 'hotset category PUT',
  'resilience artifact GET', 'resilience update preflight', 'resilience conditional PUT',
  ...artifactKinds.flatMap(kind => [
    `churn ${kind} POST`, `churn ${kind} GET`, `churn ${kind} PUT`,
    `churn ${kind} DELETE`, `churn ${kind} verification`,
  ]),
  ...['baseline', 'peak', 'recovery'].flatMap(phase => artifactKinds.flatMap(kind => [
    `burst ${phase} ${kind} GET`, `burst ${phase} ${kind} PUT`,
  ])),
  'soak artifact ACL preflight', 'soak artifact ACL update',
  'soak artifact ACL verification', 'soak artifact ACL access verification',
  'soak folder ACL preflight', 'soak folder ACL update',
  'soak folder ACL verification', 'soak folder ACL access verification',
  'soak group record preflight', 'soak group record PATCH',
  'soak group membership preflight', 'soak group membership update',
  'soak group membership verification', 'soak group membership access verification',
  'soak category record preflight', 'soak category record update',
  'soak category ACL preflight', 'soak category ACL update',
  'soak category ACL verification', 'soak category ACL access verification',
  ...destructiveKinds.flatMap(kind => [
    `update-delete ${kind} GET`, `update-delete ${kind} PUT`, `update-delete ${kind} DELETE`,
    `update-delete ${kind} verification`, `double-delete ${kind} GET`, `double-delete ${kind} DELETE`,
    `double-delete ${kind} verification`,
    `wildcard-delete ${kind} GET`, `wildcard-delete ${kind} DELETE`, `wildcard-delete ${kind} PUT`,
  ]),
  ...wildcardTypes.flatMap(type => [`${type} GET`, `${type} mutation`, `${type} verification`]),
];
const routeMetrics = Object.fromEntries(
    measuredOperations.map(operation => [operation, new Trend(routeMetricName(operation), true)]));

const quickRouteOperations = [
  'artifact GET', 'folder contents', 'search', 'artifact update preflight',
  'conditional artifact update', 'move preflight', 'conditional artifact move',
  'OpenView preflight', 'conditional OpenView toggle',
];
const contentionRouteOperations = measuredOperations.filter(operation =>
  /^(contention |artifact graph |folder graph |artifact ACL |folder ACL |group record |group membership |category record |category ACL |update-delete |double-delete |wildcard)/.test(operation));
const soakRouteOperations = measuredOperations.filter(operation => operation.startsWith('soak '))
    .concat(['folder contents', 'search', 'move preflight', 'conditional artifact move',
      'OpenView preflight', 'conditional OpenView toggle']);

function routeThresholds(operations, readLimit, mutationLimit) {
  return Object.fromEntries([...new Set(operations)].map(operation => {
    const readLike = /GET|preflight|verification|contents|search/i.test(operation);
    return [routeMetricName(operation), [`p(95)<${readLike ? readLimit : mutationLimit}`]];
  }));
}

const profileRouteThresholds = {
  quick: routeThresholds(quickRouteOperations, 750, 2000),
  contention: routeThresholds(contentionRouteOperations, 2500, 5000),
  hotset: routeThresholds(measuredOperations.filter(operation => operation.startsWith('hotset ')), 750, 2500),
  resilience: routeThresholds(
      measuredOperations.filter(operation => operation.startsWith('resilience ')), 750, 1500),
  churn: routeThresholds(measuredOperations.filter(operation => operation.startsWith('churn ')), 750, 1500),
  burst: routeThresholds(measuredOperations.filter(operation => operation.startsWith('burst ')), 750, 1500),
  soak: routeThresholds(soakRouteOperations, 750, 1500),
};

function recordDuration(operation, response) {
  operationDuration.add(response.timings.duration, { operation });
  routeMetrics[operation]?.add(response.timings.duration);
}

const matrixCases = [
  ...['template', 'element', 'field', 'instance'].map(kind => ({ type: 'content', kind })),
  { type: 'artifact-graph' }, { type: 'folder-graph' },
  { type: 'artifact-acl' }, { type: 'folder-acl' },
  { type: 'group-record' }, { type: 'group-membership' },
  { type: 'category-record' }, { type: 'category-acl' },
  ...destructiveKinds.map(kind => ({ type: 'update-delete', kind })),
  ...destructiveKinds.map(kind => ({ type: 'double-delete', kind })),
  ...destructiveKinds.map(kind => ({ type: 'wildcard-delete', kind })),
  ...wildcardTypes.map(type => ({ type })),
];

// A stale response is expected only by the contention and hot-set workloads. All successful statuses remain
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
        executor: 'per-vu-iterations',
        exec: 'contention',
        vus: 1,
        iterations: matrixCases.length * matrixRounds,
        maxDuration: configuredDuration || '20m',
      },
    },
  },
  soak: {
    scenarios: {
      soak: {
        executor: 'constant-vus',
        exec: 'soak',
        vus: configuredVus,
        duration: configuredDuration || '30m',
      },
    },
  },
  hotset: {
    scenarios: {
      hotset: {
        executor: 'constant-vus',
        exec: 'hotset',
        vus: configuredVus,
        duration: configuredDuration || '10m',
      },
    },
  },
  resilience: {
    scenarios: {
      resilience: {
        executor: 'constant-vus',
        exec: 'resilience',
        vus: configuredVus,
        duration: configuredDuration || '90s',
      },
    },
  },
  churn: {
    scenarios: {
      churn: {
        executor: 'constant-arrival-rate',
        exec: 'churn',
        rate: churnRate,
        timeUnit: '1s',
        duration: configuredDuration || '5m',
        preAllocatedVUs: configuredVus,
        maxVUs: configuredVus,
      },
    },
  },
  burst: {
    scenarios: {
      burst_baseline: {
        executor: 'constant-arrival-rate',
        exec: 'burstBaseline',
        rate: burstBaselineRate,
        timeUnit: '1s',
        duration: burstPhaseDuration,
        preAllocatedVUs: configuredVus,
        maxVUs: configuredVus,
        gracefulStop: '5s',
      },
      burst_peak: {
        executor: 'constant-arrival-rate',
        exec: 'burstPeak',
        startTime: `${burstPhaseSeconds + 5}s`,
        rate: burstPeakRate,
        timeUnit: '1s',
        duration: burstPhaseDuration,
        preAllocatedVUs: configuredVus,
        maxVUs: configuredVus,
        gracefulStop: '5s',
      },
      burst_recovery: {
        executor: 'constant-arrival-rate',
        exec: 'burstRecovery',
        startTime: `${2 * (burstPhaseSeconds + 5)}s`,
        rate: burstBaselineRate,
        timeUnit: '1s',
        duration: burstPhaseDuration,
        preAllocatedVUs: configuredVus,
        maxVUs: configuredVus,
        gracefulStop: '5s',
      },
    },
  },
};

if (!profiles[profile]) throw new Error(`unknown CEDAR_PERF_PROFILE ${profile}`);
if (profile === 'resilience' && (!Number.isFinite(faultStartEpochMs) || faultStartEpochMs <= 0
    || !Number.isFinite(recoveryBudgetMs) || recoveryBudgetMs <= 0)) {
  throw new Error('resilience requires fault start and recovery budget timing from run-rest.mjs');
}

export const options = {
  ...profiles[profile],
  insecureSkipTLSVerify: true,
  batch: Math.max(20, contentionWidth),
  batchPerHost: Math.max(20, contentionWidth),
  discardResponseBodies: false,
  thresholds: {
    checks: ['rate>0.99'],
    cedar_unexpected_responses: ['rate<0.01'],
    cedar_invariant_failures: ['rate==0'],
    // Initial guardrail only. Establish operation-specific baselines before tightening latency gates.
    cedar_operation_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.01'],
    ...profileRouteThresholds[profile],
    ...(profile === 'hotset' ? {
      cedar_hotset_conflict_rate: ['rate>0.01', 'rate<0.95'],
    } : {}),
    ...(profile === 'resilience' ? {
      cedar_resilience_unexpected: ['rate==0'],
      cedar_resilience_outage_responses: ['count>0'],
      cedar_resilience_recovered_responses: ['count>20'],
    } : {}),
    ...(profile === 'churn' ? {
      cedar_churn_completed: ['count>10'],
      dropped_iterations: ['count==0'],
    } : {}),
    ...(profile === 'burst' ? {
      cedar_burst_baseline_completed: ['count>10'],
      cedar_burst_peak_completed: ['count>10'],
      cedar_burst_recovery_completed: ['count>10'],
      dropped_iterations: ['count==0'],
    } : {}),
  },
};

function form(value) {
  return encodeURIComponent(value);
}

function authorization(credential) {
  return credential && credential.split('.').length === 3 ? `Bearer ${credential}` : `apiKey ${credential}`;
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

function cedar(data, actorIndex, method, path, body, operation, extraHeaders = {}, base = resource,
    expectedStatuses) {
  const perform = token => http.request(method, `${base}${path}`,
      body === undefined ? null : JSON.stringify(body), {
        headers: {
          Authorization: authorization(token),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        tags: { operation, name: operation },
        ...(expectedStatuses ? { responseCallback: http.expectedStatuses(...expectedStatuses) } : {}),
      });
  let response = perform(actorIndex === 'admin' ? adminCredential() : tokenFor(data, actorIndex));
  if (response.status === 401 && typeof actorIndex === 'number') {
    const renewed = refresh(actorIndex);
    if (renewed) response = perform(renewed);
  }
  recordDuration(operation, response);
  return response;
}

function adminCredential() {
  const credential = __ENV.CEDAR_ADMIN_USER_API_KEY;
  if (!credential) fail('CEDAR_ADMIN_USER_API_KEY is required for category performance cases');
  return credential;
}

function accepted(response, statuses, label) {
  const ok = check(response, { [label]: result => statuses.includes(result.status) });
  if (!ok) {
    console.error(`${label}: expected ${statuses.join('/')} but received ${response.status}`
      + ` (seed=${scheduleSeed} VU=${__VU} iteration=${__ITER})`);
  }
  unexpectedResponses.add(!ok, { operation: label });
  return ok;
}

function invariant(target, label, predicate) {
  const ok = check(target, { [label]: predicate });
  invariantFailures.add(!ok, { operation: label });
  if (!ok) {
    console.error(`${label}: semantic state did not match the completed mutation`
      + ` (seed=${scheduleSeed} VU=${__VU} iteration=${__ITER})`);
  }
  return ok;
}

function entriesFor(body, key) {
  return Array.isArray(body?.[key]) ? body[key] : [];
}

function hasUserEntry(body, key, userId) {
  return entriesFor(body, key).some(entry => entry?.user?.['@id'] === userId);
}

// k6 caches Response.json() values and does not promise that callers can mutate that cached object.
// Parse the wire body again whenever it is going to become a mutation request. Without this copy,
// assignments can leave the outgoing representation unchanged while the server still advances its
// revision for an otherwise valid replacement PUT.
function mutableResponseBody(response) {
  return JSON.parse(response.body);
}

function toggledUserPermissionBody(currentBody, userId, permission) {
  const entries = entriesFor(currentBody, 'userPermissions');
  const granting = !hasUserEntry(currentBody, 'userPermissions', userId);
  currentBody.userPermissions = entries.filter(entry => entry?.user?.['@id'] !== userId);
  if (granting) {
    currentBody.userPermissions.push({ user: { '@id': userId }, permission });
  }
  return { body: currentBody, granting };
}

function toggledMembershipBody(currentBody, userId) {
  const entries = entriesFor(currentBody, 'users');
  const joining = !hasUserEntry(currentBody, 'users', userId);
  currentBody.users = entries.filter(entry => entry?.user?.['@id'] !== userId);
  if (joining) {
    currentBody.users.push({
      user: { '@id': userId }, administrator: false, member: true,
    });
  }
  return { body: currentBody, joining };
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
  const body = mutableResponseBody(current);
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

const resilienceFailureStatuses = [0, 502, 503, 504];

function recordResilienceResponse(response, requestedAt, label) {
  const recoveryDeadline = faultStartEpochMs + recoveryBudgetMs;
  const inFaultBudget = requestedAt >= faultStartEpochMs - 1000 && requestedAt < recoveryDeadline;
  const outageResponse = resilienceFailureStatuses.includes(response.status);
  const expected = response.status === 200 || (inFaultBudget && outageResponse);
  check(response, { [`${label} matches its resilience phase`]: () => expected });
  resilienceUnexpected.add(!expected, { operation: label });
  if (outageResponse) {
    resilienceOutageResponses.add(1, { operation: label });
    // A dead gateway answers much faster than a healthy application. Back off with deterministic
    // per-VU jitter so the fault test does not turn ten disciplined clients into a retry storm.
    sleep(0.2 + ((__VU * 17 + __ITER) % 100) / 1000);
  }
  if (requestedAt >= recoveryDeadline && response.status === 200) {
    resilienceRecoveredResponses.add(1, { operation: label });
  }
  if (!expected) {
    console.error(`${label}: HTTP ${response.status} outside the bounded outage window`
      + ` (seed=${scheduleSeed} VU=${__VU} iteration=${__ITER})`);
  }
  return response.status === 200;
}

function resilienceRequest(data, index, method, path, body, operation, headers = {}) {
  const requestedAt = Date.now();
  const response = cedar(data, index, method, path, body, operation, headers, resource,
      [0, 200, 502, 503, 504]);
  return { response, healthy: recordResilienceResponse(response, requestedAt, operation) };
}

export function resilience(data) {
  const index = (__VU - 1) % manifest.actors.length;
  const actor = manifest.actors[index];
  const operation = scheduledValue(resilienceOperations, scheduleSeed, index, __ITER);
  const path = `/templates/${encodeURIComponent(
      operation === 'read' ? actor.readTemplate.id : actor.mutableTemplate.id)}`;
  if (operation === 'read') {
    resilienceRequest(data, index, 'GET', path, undefined, 'resilience artifact GET');
    return;
  }

  const currentResult = resilienceRequest(
      data, index, 'GET', path, undefined, 'resilience update preflight');
  if (!currentResult.healthy) return;
  const revision = etag(currentResult.response);
  if (!revision) {
    invariant(currentResult.response, 'resilience healthy preflight returns an ETag', () => false);
    return;
  }
  const marker = `${manifest.prefix} resilience ${scheduleSeed} ${__VU}-${__ITER}`;
  const body = mutableResponseBody(currentResult.response);
  body['schema:description'] = marker;
  const updated = resilienceRequest(data, index, 'PUT', path, body, 'resilience conditional PUT', {
    'If-Match': revision,
  });
  if (updated.healthy) {
    invariant(updated.response, 'resilience successful update advances exactly one revision', result => {
      const beforeRevision = revisionNumber(revision);
      const afterRevision = revisionNumber(etag(result));
      return beforeRevision !== null && afterRevision === beforeRevision + 1;
    });
    invariant(updated.response, 'resilience successful update returns submitted state',
        result => result.json()?.['schema:description'] === marker);
  }
}

function churnBody(kind, actor) {
  const body = JSON.parse(JSON.stringify(churnFixtures[kind]));
  body['@id'] = null;
  body['schema:name'] = `${manifest.prefix} churn ${kind} ${manifest.runId} ${__VU}-${__ITER}`;
  body['schema:description'] = `${manifest.prefix} bounded churn fixture for ${manifest.runId}`;
  if (kind === 'instance') body['schema:isBasedOn'] = actor.mutableTemplate.id;
  return body;
}

// Exercise full repository turnover at a deliberately low arrival rate. Every lifecycle is placed
// below its actor's stamped root and normally removes itself. cleanup-run.mjs also walks those roots,
// so an interrupt between POST and DELETE is recoverable without recording dynamic IDs from k6.
export function churn(data) {
  const index = (__VU - 1) % manifest.actors.length;
  const actor = manifest.actors[index];
  const kind = scheduledValue(artifactKinds, scheduleSeed, index, __ITER);
  const collection = churnCollections[kind];
  let lifecycleOk = true;

  const created = cedar(data, index, 'POST',
      `${collection}?folder_id=${encodeURIComponent(actor.rootFolderId)}`, churnBody(kind, actor),
      `churn ${kind} POST`);
  lifecycleOk = accepted(created, [201], `churn ${kind} create succeeds`) && lifecycleOk;
  const id = created.status === 201 ? created.json()?.['@id'] : null;
  if (!id) {
    invariant(created, `churn ${kind} create returns an identifier`, () => false);
    return;
  }

  const path = `${collection}/${encodeURIComponent(id)}`;
  const current = cedar(data, index, 'GET', path, undefined, `churn ${kind} GET`);
  lifecycleOk = accepted(current, [200], `churn ${kind} read succeeds`) && lifecycleOk;
  const revision = etag(current);
  lifecycleOk = invariant(current, `churn ${kind} read returns an ETag`, () => Boolean(revision)) && lifecycleOk;

  let deleteRevision = revision || '*';
  if (current.status === 200 && revision) {
    const marker = `${manifest.prefix} churn update ${scheduleSeed} ${__VU}-${__ITER}`;
    const body = mutableResponseBody(current);
    body['schema:description'] = marker;
    const updated = cedar(data, index, 'PUT', path, body, `churn ${kind} PUT`, { 'If-Match': revision });
    lifecycleOk = accepted(updated, [200], `churn ${kind} conditional update succeeds`) && lifecycleOk;
    if (updated.status === 200) {
      deleteRevision = etag(updated) || '*';
      lifecycleOk = invariant(updated, `churn ${kind} update advances exactly one revision`, result => {
        const beforeRevision = revisionNumber(revision);
        const afterRevision = revisionNumber(etag(result));
        return beforeRevision !== null && afterRevision === beforeRevision + 1;
      }) && lifecycleOk;
      lifecycleOk = invariant(updated, `churn ${kind} update returns submitted state`,
          result => result.json()?.['schema:description'] === marker) && lifecycleOk;
    }
  }

  const deleted = cedar(data, index, 'DELETE', path, undefined, `churn ${kind} DELETE`,
      { 'If-Match': deleteRevision });
  lifecycleOk = accepted(deleted, [204], `churn ${kind} conditional delete succeeds`) && lifecycleOk;
  const absent = cedar(data, index, 'GET', path, undefined, `churn ${kind} verification`, {}, resource, [404]);
  lifecycleOk = accepted(absent, [404], `churn ${kind} deletion is durable`) && lifecycleOk;
  if (lifecycleOk) churnCompleted.add(1, { kind });
}

function burstMetric(phase) {
  if (phase === 'baseline') return { duration: burstBaselineDuration, completed: burstBaselineCompleted };
  if (phase === 'peak') return { duration: burstPeakDuration, completed: burstPeakCompleted };
  return { duration: burstRecoveryDuration, completed: burstRecoveryCompleted };
}

function burstPhase(data, phase) {
  const index = (__VU - 1) % manifest.actors.length;
  const actor = manifest.actors[index];
  const artifacts = actor.burst?.artifacts;
  if (!artifacts) fail(`burst fixture is incomplete for ${actor.username}`);
  const kind = scheduledValue(artifactKinds, `${scheduleSeed}:kind`, index, __ITER);
  const operation = scheduledValue(burstOperations, `${scheduleSeed}:operation`, index, __ITER);
  const fixture = artifacts[kind];
  const metrics = burstMetric(phase);
  const getOperation = `burst ${phase} ${kind} GET`;
  const current = cedar(data, index, 'GET', fixture.path, undefined, getOperation);
  metrics.duration.add(current.timings.duration, { phase, kind, method: 'GET' });
  let complete = accepted(current, [200], `${getOperation} succeeds`);

  if (operation === 'update' && current.status === 200) {
    const revision = etag(current);
    complete = invariant(current, `${getOperation} returns an ETag`, () => Boolean(revision)) && complete;
    if (revision) {
      const marker = `${manifest.prefix} burst ${phase} ${kind} ${scheduleSeed} ${__VU}-${__ITER}`;
      const body = mutableResponseBody(current);
      body['schema:description'] = marker;
      const putOperation = `burst ${phase} ${kind} PUT`;
      const updated = cedar(data, index, 'PUT', fixture.path, body, putOperation, { 'If-Match': revision });
      metrics.duration.add(updated.timings.duration, { phase, kind, method: 'PUT' });
      complete = accepted(updated, [200], `${putOperation} succeeds`) && complete;
      if (updated.status === 200) {
        complete = invariant(updated, `${putOperation} advances exactly one revision`, result => {
          const beforeRevision = revisionNumber(revision);
          const afterRevision = revisionNumber(etag(result));
          return beforeRevision !== null && afterRevision === beforeRevision + 1;
        }) && complete;
        complete = invariant(updated, `${putOperation} returns submitted state`,
            result => result.json()?.['schema:description'] === marker) && complete;
      }
    }
  }
  if (complete) metrics.completed.add(1, { phase, kind, operation });
}

export function burstBaseline(data) { burstPhase(data, 'baseline'); }
export function burstPeak(data) { burstPhase(data, 'peak'); }
export function burstRecovery(data) { burstPhase(data, 'recovery'); }

function requireSoakFixture(actor) {
  if (!actor.soak?.artifacts || !actor.soak.group || !actor.soak.category || !actor.soak.peer
      || !actor.soak.groupAccessFolder) {
    fail(`soak fixture is incomplete for ${actor.username}`);
  }
  return actor.soak;
}

function soakArtifactRead(data, index, actor, kind) {
  const fixture = requireSoakFixture(actor).artifacts[kind];
  const operation = `soak ${kind} GET`;
  const response = cedar(data, index, 'GET', fixture.path, undefined, operation);
  accepted(response, [200], `${operation} succeeds`);
}

function soakArtifactUpdate(data, index, actor, kind) {
  const fixture = requireSoakFixture(actor).artifacts[kind];
  const preflightOperation = `soak ${kind} update preflight`;
  const updateOperation = `soak ${kind} conditional PUT`;
  const current = cedar(data, index, 'GET', fixture.path, undefined, preflightOperation);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const body = mutableResponseBody(current);
  body['schema:description'] = `${manifest.prefix} soak ${kind} ${__VU}-${__ITER}`;
  const updated = cedar(data, index, 'PUT', fixture.path, body, updateOperation, { 'If-Match': revision });
  if (accepted(updated, [200], `${updateOperation} succeeds`)) {
    check(updated, {
      [`${updateOperation} returns a fresh ETag`]: result => etag(result) && etag(result) !== revision,
    });
  }
}

function soakAclUpdate(data, index, actor, kind) {
  const soakFixture = requireSoakFixture(actor);
  const fixture = kind === 'artifact' ? soakFixture.aclArtifact : soakFixture.aclFolder;
  const path = `${fixture.path}/permissions`;
  const preflightOperation = `soak ${kind} ACL preflight`;
  const updateOperation = `soak ${kind} ACL update`;
  const current = cedar(data, index, 'GET', path, undefined, preflightOperation);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const { body, granting } = toggledUserPermissionBody(
      mutableResponseBody(current), soakFixture.peer.cedarUserId, 'read');
  const updated = cedar(data, index, 'PUT', path, body, updateOperation, { 'If-Match': revision });
  if (accepted(updated, [200], `${updateOperation} succeeds`)) {
    check(updated, {
      [`${updateOperation} returns a fresh ETag`]: result => etag(result) && etag(result) !== revision,
    });
    const verificationOperation = `soak ${kind} ACL verification`;
    const verified = cedar(data, index, 'GET', path, undefined, verificationOperation);
    if (accepted(verified, [200], `${verificationOperation} succeeds`)) {
      invariant(verified, `${verificationOperation} reflects ${granting ? 'grant' : 'revocation'}`,
          result => hasUserEntry(result.json(), 'userPermissions', soakFixture.peer.cedarUserId) === granting);
    }
    const accessOperation = `soak ${kind} ACL access verification`;
    const expectedStatus = granting ? 200 : 403;
    const access = cedar(data, soakFixture.peer.index, 'GET', path, undefined, accessOperation, {}, resource,
        [expectedStatus]);
    if (accepted(access, [expectedStatus],
        `${accessOperation} sees ${granting ? 'grant' : 'revocation'}`)) {
      invariant(access, `${accessOperation} enforces ${granting ? 'grant' : 'revocation'}`,
          result => result.status === expectedStatus);
    }
  }
}

function soakGroupUpdate(data, index, actor, membership) {
  const soakFixture = requireSoakFixture(actor);
  const path = membership ? `${soakFixture.group.path}/users` : soakFixture.group.path;
  const preflightOperation = membership ? 'soak group membership preflight' : 'soak group record preflight';
  const updateOperation = membership ? 'soak group membership update' : 'soak group record PATCH';
  const current = cedar(data, index, 'GET', path, undefined, preflightOperation, {}, groupServer);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const transition = membership
    ? toggledMembershipBody(mutableResponseBody(current), soakFixture.peer.cedarUserId)
    : null;
  const body = membership ? transition.body : {
    'schema:description': `${manifest.prefix} soak group ${__VU}-${__ITER}`,
  };
  const updated = cedar(data, index, membership ? 'PUT' : 'PATCH', path, body, updateOperation, {
    'If-Match': revision,
    ...(membership ? {} : { 'Content-Type': 'application/merge-patch+json' }),
  }, groupServer);
  if (accepted(updated, [200], `${updateOperation} succeeds`)) {
    check(updated, {
      [`${updateOperation} returns a fresh ETag`]: result => etag(result) && etag(result) !== revision,
    });
    if (membership) {
      const verificationOperation = 'soak group membership verification';
      const verified = cedar(data, index, 'GET', path, undefined, verificationOperation, {}, groupServer);
      if (accepted(verified, [200], `${verificationOperation} succeeds`)) {
        invariant(verified, `${verificationOperation} reflects ${transition.joining ? 'join' : 'leave'}`,
            result => hasUserEntry(result.json(), 'users', soakFixture.peer.cedarUserId) === transition.joining);
      }
      const accessOperation = 'soak group membership access verification';
      const accessPath = `${soakFixture.groupAccessFolder.path}/permissions`;
      const expectedStatus = transition.joining ? 200 : 403;
      const access = cedar(data, soakFixture.peer.index, 'GET', accessPath, undefined, accessOperation, {}, resource,
          [expectedStatus]);
      if (accepted(access, [expectedStatus],
          `${accessOperation} sees ${transition.joining ? 'join' : 'leave'}`)) {
        invariant(access, `${accessOperation} enforces ${transition.joining ? 'join' : 'leave'}`,
            result => result.status === expectedStatus);
      }
    }
  }
}

function soakCategoryUpdate(data, index, actor, permissions) {
  const soakFixture = requireSoakFixture(actor);
  const path = permissions ? `${soakFixture.category.path}/permissions` : soakFixture.category.path;
  const requestActor = permissions ? 'admin' : index;
  const preflightOperation = permissions ? 'soak category ACL preflight' : 'soak category record preflight';
  const updateOperation = permissions ? 'soak category ACL update' : 'soak category record update';
  const current = cedar(data, requestActor, 'GET', path, undefined, preflightOperation);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const currentBody = mutableResponseBody(current);
  const transition = permissions
    ? toggledUserPermissionBody(currentBody, soakFixture.peer.cedarUserId, 'write')
    : null;
  const body = permissions ? transition.body : {
    'schema:name': currentBody['schema:name'],
    'schema:description': `${manifest.prefix} soak category ${__VU}-${__ITER}`,
  };
  const updated = cedar(data, requestActor, 'PUT', path, body, updateOperation, { 'If-Match': revision });
  if (accepted(updated, [200], `${updateOperation} succeeds`)) {
    check(updated, {
      [`${updateOperation} returns a fresh ETag`]: result => etag(result) && etag(result) !== revision,
    });
    if (permissions) {
      const verificationOperation = 'soak category ACL verification';
      const verified = cedar(data, 'admin', 'GET', path, undefined, verificationOperation);
      if (accepted(verified, [200], `${verificationOperation} succeeds`)) {
        invariant(verified, `${verificationOperation} reflects ${transition.granting ? 'grant' : 'revocation'}`,
            result => hasUserEntry(result.json(), 'userPermissions', soakFixture.peer.cedarUserId)
              === transition.granting);
      }
      const accessOperation = 'soak category ACL access verification';
      const expectedStatus = transition.granting ? 200 : 403;
      const access = cedar(data, soakFixture.peer.index, 'GET', path, undefined, accessOperation, {}, resource,
          [expectedStatus]);
      if (accepted(access, [expectedStatus],
          `${accessOperation} sees ${transition.granting ? 'grant' : 'revocation'}`)) {
        invariant(access, `${accessOperation} enforces ${transition.granting ? 'grant' : 'revocation'}`,
            result => result.status === expectedStatus);
      }
    }
  }
}

// Steady-state breadth is deliberately separate from the destructive contention matrix. Every VU
// owns its artifacts, folders, group and category, so a 412 here is a failure rather than an
// expected loser. Every 24-iteration cycle retains the exact half-read, half-mutation multiset, but
// its seeded order differs by actor and cycle. A failure reports its seed, VU and iteration.
export function soak(data) {
  const index = (__VU - 1) % manifest.actors.length;
  const actor = manifest.actors[index];
  switch (scheduledValue(soakOperations, scheduleSeed, index, __ITER)) {
    case 'template-read': soakArtifactRead(data, index, actor, 'template'); break;
    case 'element-read': soakArtifactRead(data, index, actor, 'element'); break;
    case 'field-read': soakArtifactRead(data, index, actor, 'field'); break;
    case 'instance-read': soakArtifactRead(data, index, actor, 'instance'); break;
    case 'folder-list': listFolder(data, index, actor); break;
    case 'search': search(data, index); break;
    case 'template-update': soakArtifactUpdate(data, index, actor, 'template'); break;
    case 'element-update': soakArtifactUpdate(data, index, actor, 'element'); break;
    case 'field-update': soakArtifactUpdate(data, index, actor, 'field'); break;
    case 'instance-update': soakArtifactUpdate(data, index, actor, 'instance'); break;
    case 'artifact-move': moveArtifact(data, index, actor); break;
    case 'openview-toggle': toggleOpenView(data, index, actor); break;
    case 'artifact-acl': soakAclUpdate(data, index, actor, 'artifact'); break;
    case 'folder-acl': soakAclUpdate(data, index, actor, 'folder'); break;
    case 'group-record': soakGroupUpdate(data, index, actor, false); break;
    case 'group-membership': soakGroupUpdate(data, index, actor, true); break;
    case 'category-record': soakCategoryUpdate(data, index, actor, false); break;
    case 'category-acl': soakCategoryUpdate(data, index, actor, true); break;
  }
}

function hotsetOutcome(response, revision, marker, label) {
  if (!accepted(response, [200, 412], `${label} converges or rejects stale state`)) return;
  hotsetConflictRate.add(response.status === 412, { operation: label });
  invariant(response, `${label} success advances exactly one revision`, result => {
    if (result.status === 412) return true;
    const beforeRevision = revisionNumber(revision);
    const afterRevision = revisionNumber(etag(result));
    return beforeRevision !== null && afterRevision === beforeRevision + 1;
  });
  invariant(response, `${label} success returns the submitted state`, result =>
    result.status === 412 || result.json()?.['schema:description'] === marker);
}

function hotsetArtifact(data, index, kind) {
  const fixture = manifest.shared.content?.[kind];
  if (!fixture) fail(`hotset fixture is missing shared ${kind} content`);
  const getOperation = `hotset ${kind} GET`;
  const putOperation = `hotset ${kind} PUT`;
  const current = cedar(data, index, 'GET', fixture.path, undefined, getOperation);
  const revision = requireEtag(current, getOperation);
  if (!revision) return;
  const marker = `${manifest.prefix} hotset ${kind} ${scheduleSeed} ${__VU}-${__ITER}`;
  const body = mutableResponseBody(current);
  body['schema:description'] = marker;
  const updated = cedar(data, index, 'PUT', fixture.path, body, putOperation,
      { 'If-Match': revision }, resource, [200, 412]);
  hotsetOutcome(updated, revision, marker, putOperation);
}

function hotsetFolder(data, index) {
  const fixture = manifest.shared.graphFolder;
  if (!fixture) fail('hotset fixture is missing the shared folder');
  const current = cedar(data, index, 'GET', fixture.path, undefined, 'hotset folder GET');
  const revision = requireEtag(current, 'hotset folder GET');
  if (!revision) return;
  const currentBody = current.json();
  const marker = `${manifest.prefix} hotset folder ${scheduleSeed} ${__VU}-${__ITER}`;
  const updated = cedar(data, index, 'PUT', fixture.path, {
    '@id': fixture.id,
    'schema:name': currentBody['schema:name'],
    'schema:description': marker,
  }, 'hotset folder PUT', { 'If-Match': revision }, resource, [200, 412]);
  hotsetOutcome(updated, revision, marker, 'hotset folder PUT');
}

function hotsetGroup(data, index) {
  const fixture = manifest.shared.group;
  if (!fixture) fail('hotset fixture is missing the shared group');
  const current = cedar(data, index, 'GET', fixture.path, undefined, 'hotset group GET', {}, groupServer);
  const revision = requireEtag(current, 'hotset group GET');
  if (!revision) return;
  const marker = `${manifest.prefix} hotset group ${scheduleSeed} ${__VU}-${__ITER}`;
  const updated = cedar(data, index, 'PATCH', fixture.path, { 'schema:description': marker },
      'hotset group PATCH', {
        'If-Match': revision,
        'Content-Type': 'application/merge-patch+json',
      }, groupServer, [200, 412]);
  hotsetOutcome(updated, revision, marker, 'hotset group PATCH');
}

function hotsetCategory(data, index) {
  const fixture = manifest.shared.category;
  if (!fixture) fail('hotset fixture is missing the shared category');
  const current = cedar(data, index, 'GET', fixture.path, undefined, 'hotset category GET');
  const revision = requireEtag(current, 'hotset category GET');
  if (!revision) return;
  const marker = `${manifest.prefix} hotset category ${scheduleSeed} ${__VU}-${__ITER}`;
  const updated = cedar(data, index, 'PUT', fixture.path, {
    'schema:name': current.json()?.['schema:name'],
    'schema:description': marker,
  }, 'hotset category PUT', { 'If-Match': revision }, resource, [200, 412]);
  hotsetOutcome(updated, revision, marker, 'hotset category PUT');
}

// Unlike the finite contention matrix, this keeps a small set of live revision domains hot for the
// entire duration. Conflicts are required, but successful writers must keep making forward progress.
export function hotset(data) {
  const index = (__VU - 1) % manifest.actors.length;
  const operation = scheduledValue(hotsetOperations, scheduleSeed, index, __ITER);
  if (artifactKinds.includes(operation)) hotsetArtifact(data, index, operation);
  else if (operation === 'folder') hotsetFolder(data, index);
  else if (operation === 'group') hotsetGroup(data, index);
  else hotsetCategory(data, index);
}

function batchRequest(data, actorIndex, method, base, path, body, operation, revision,
    { contentType = 'application/json', expected = [200, 412] } = {}) {
  const credential = actorIndex === 'admin' ? adminCredential() : tokenFor(data, actorIndex);
  return {
    method,
    url: `${base}${path}`,
    body: body === undefined ? null : JSON.stringify(body),
    params: {
      headers: {
        Authorization: authorization(credential),
        ...(body === undefined ? {} : { 'Content-Type': contentType }),
        ...(revision === undefined ? {} : { 'If-Match': revision }),
      },
      tags: { operation, name: operation },
      responseCallback: http.expectedStatuses(...expected),
    },
  };
}

function executeBatch(requests, operations) {
  const responses = http.batch(requests);
  for (let index = 0; index < responses.length; index++) recordDuration(operations[index], responses[index]);
  return responses;
}

function exactCas(responses, successStatuses, label, { loserStatuses = [412], expectedSuccesses = 1 } = {}) {
  const successes = responses.filter(response => successStatuses.includes(response.status)).length;
  const losers = responses.filter(response => loserStatuses.includes(response.status)).length;
  const exact = successes === expectedSuccesses && losers === responses.length - expectedSuccesses;
  if (!exact) {
    const histogram = {};
    for (const response of responses) histogram[response.status] = (histogram[response.status] || 0) + 1;
    console.error(`${label}: statuses ${JSON.stringify(histogram)}`);
  }
  check(responses, {
    [`${label}: exactly ${expectedSuccesses} mutation succeeds`]: () => successes === expectedSuccesses,
    [`${label}: every losing mutation is rejected`]: () => losers === responses.length - expectedSuccesses,
  });
  unexpectedResponses.add(!exact, { operation: label });
  return exact;
}

function requireEtag(response, label) {
  const revision = etag(response);
  if (!accepted(response, [200], `${label} succeeds`) || !revision) {
    unexpectedResponses.add(true, { operation: `${label} missing ETag` });
    return null;
  }
  return revision;
}

function verifyRevision(data, actorIndex, base, path, before, operation, label) {
  const after = cedar(data, actorIndex, 'GET', path, undefined, operation, {}, base);
  accepted(after, [200], `${label} verification succeeds`);
  check(after, {
    [`${label}: revision advances exactly once`]: result => {
      const beforeRevision = revisionNumber(before);
      const afterRevision = revisionNumber(etag(result));
      return beforeRevision !== null && afterRevision === beforeRevision + 1;
    },
  });
}

function contentRace(data, kind) {
  const fixture = manifest.shared.content[kind];
  const getOperation = `contention ${kind} GET`;
  const putOperation = `contention ${kind} PUT`;
  const verifyOperation = `contention ${kind} verification`;
  const current = cedar(data, 0, 'GET', fixture.path, undefined, getOperation);
  const revision = requireEtag(current, `${kind} content preflight`);
  if (!revision) return;
  const body = mutableResponseBody(current);
  body['schema:description'] = `${manifest.prefix} ${kind} contention ${__ITER}`;
  const operations = Array(contentionWidth).fill(putOperation);
  const requests = operations.map((operation, index) =>
    batchRequest(data, index, 'PUT', resource, fixture.path, body, operation, revision));
  exactCas(executeBatch(requests, operations), [200], `${kind} content contention`);
  verifyRevision(data, 0, resource, fixture.path, revision, verifyOperation, `${kind} content contention`);
}

function graphRace(data, kind) {
  const fixture = kind === 'artifact' ? manifest.shared.graphArtifact : manifest.shared.graphFolder;
  const stateKey = `${kind}Graph`;
  const state = actorState[stateKey] || (actorState[stateKey] = { inSource: true, open: false });
  const getPath = kind === 'artifact' ? `${fixture.path}/details` : fixture.path;
  const preflightOperation = `${kind} graph preflight`;
  const current = cedar(data, 0, 'GET', getPath, undefined, preflightOperation);
  const revision = requireEtag(current, `${kind} graph preflight`);
  if (!revision) return;
  const currentBody = current.json();
  const targetFolderId = state.inSource ? fixture.destinationFolderId : fixture.sourceFolderId;
  const requests = [];
  const operations = [];
  for (let index = 0; index < contentionWidth; index++) {
    if (index % 3 === 0 && kind === 'folder') {
      const operation = 'folder graph update';
      operations.push(operation);
      requests.push(batchRequest(data, index, 'PUT', resource, fixture.path, {
        '@id': fixture.id,
        'schema:name': currentBody['schema:name'],
        'schema:description': `${manifest.prefix} folder graph ${__ITER}-${index}`,
      }, operation, revision));
    } else if (index % 2 === 0) {
      const operation = `${kind} graph move`;
      operations.push(operation);
      requests.push(batchRequest(data, index, 'POST', resource, '/command/move-resource-to-folder', {
        '@id': fixture.id, targetFolderId,
      }, operation, revision, { expected: [201, 412] }));
    } else {
      const operation = `${kind} graph OpenView`;
      const command = state.open ? `make-${kind}-not-open` : `make-${kind}-open`;
      operations.push(operation);
      requests.push(batchRequest(data, index, 'POST', resource, `/command/${command}`, { '@id': fixture.id },
          operation, revision));
    }
  }
  const responses = executeBatch(requests, operations);
  exactCas(responses, [200, 201], `${kind} graph cross-operation contention`);
  const winner = responses.findIndex(response => response.status === 200 || response.status === 201);
  if (winner >= 0) {
    if (operations[winner].endsWith('move')) state.inSource = !state.inSource;
    if (operations[winner].endsWith('OpenView')) state.open = !state.open;
  }
  verifyRevision(data, 0, resource, getPath, revision, 'contention verification',
      `${kind} graph cross-operation contention`);
}

function aclRace(data, kind) {
  const fixture = kind === 'artifact' ? manifest.shared.aclArtifact : manifest.shared.aclFolder;
  const path = `${fixture.path}/permissions`;
  const preflightOperation = `${kind} ACL preflight`;
  const updateOperation = `${kind} ACL update`;
  const current = cedar(data, 0, 'GET', path, undefined, preflightOperation);
  const revision = requireEtag(current, `${kind} ACL preflight`);
  if (!revision) return;
  const operations = Array(contentionWidth).fill(updateOperation);
  const requests = operations.map((operation, index) =>
    batchRequest(data, index, 'PUT', resource, path, current.json(), operation, revision));
  exactCas(executeBatch(requests, operations), [200], `${kind} ACL contention`);
  verifyRevision(data, 0, resource, path, revision, 'contention verification', `${kind} ACL contention`);
}

function groupRace(data, membership) {
  const fixture = manifest.shared.group;
  const path = membership ? `${fixture.path}/users` : fixture.path;
  const preflightOperation = membership ? 'group membership preflight' : 'group record preflight';
  const current = cedar(data, 0, 'GET', path, undefined, preflightOperation, {}, groupServer);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const requests = [];
  const operations = [];
  for (let index = 0; index < contentionWidth; index++) {
    if (membership) {
      const operation = 'group membership update';
      operations.push(operation);
      requests.push(batchRequest(data, index, 'PUT', groupServer, path, manifest.shared.groupUsers,
          operation, revision));
    } else if (index % 2 === 0) {
      const operation = 'group record PUT';
      operations.push(operation);
      requests.push(batchRequest(data, index, 'PUT', groupServer, path, {
        'schema:name': `${manifest.prefix} contended group ${manifest.runId} ${__ITER}-${index}`,
        'schema:description': `${manifest.prefix} group PUT`,
      }, operation, revision));
    } else {
      const operation = 'group record PATCH';
      operations.push(operation);
      requests.push(batchRequest(data, index, 'PATCH', groupServer, path, {
        'schema:description': `${manifest.prefix} group PATCH ${__ITER}-${index}`,
      }, operation, revision, { contentType: 'application/merge-patch+json' }));
    }
  }
  const label = membership ? 'group membership contention' : 'group PUT/PATCH contention';
  exactCas(executeBatch(requests, operations), [200], label);
  verifyRevision(data, 0, groupServer, path, revision, 'contention verification', label);
}

function categoryRace(data, permissions) {
  const fixture = manifest.shared.category;
  const path = permissions ? `${fixture.path}/permissions` : fixture.path;
  const preflightOperation = permissions ? 'category ACL preflight' : 'category record preflight';
  const updateOperation = permissions ? 'category ACL update' : 'category record update';
  const current = cedar(data, 0, 'GET', path, undefined, preflightOperation);
  const revision = requireEtag(current, preflightOperation);
  if (!revision) return;
  const operations = Array(contentionWidth).fill(updateOperation);
  const requests = operations.map((operation, index) => batchRequest(data, index, 'PUT', resource, path,
      permissions ? current.json() : {
        'schema:name': `${manifest.prefix} contended category ${manifest.runId} ${__ITER}-${index}`,
        'schema:description': `${manifest.prefix} category update`,
      }, operation, revision));
  const label = permissions ? 'category ACL contention' : 'category record contention';
  exactCas(executeBatch(requests, operations), [200], label);
  verifyRevision(data, 0, resource, path, revision, 'contention verification', label);
}

function destructiveFixture(race, kind, round) {
  const offset = round * destructiveKinds.length + destructiveKinds.indexOf(kind);
  const fixture = manifest.destructive[race][offset];
  if (!fixture) fail(`manifest has no ${race} ${kind} fixture for round ${round + 1}`);
  return fixture;
}

function fixtureBase(kind) {
  return kind === 'group' ? groupServer : resource;
}

function fixtureActor(kind) {
  return kind === 'category' ? 'admin' : 0;
}

function replacementBody(kind, current, iteration) {
  const currentBody = mutableResponseBody(current);
  if (['template', 'element', 'field', 'instance'].includes(kind)) {
    const body = currentBody;
    body['schema:description'] = `${manifest.prefix} destructive ${kind} ${iteration}`;
    return body;
  }
  if (kind === 'folder') return {
    '@id': currentBody['@id'],
    'schema:name': currentBody['schema:name'],
    'schema:description': `${manifest.prefix} destructive folder ${iteration}`,
  };
  return {
    'schema:name': currentBody['schema:name'],
    'schema:description': `${manifest.prefix} destructive ${kind} ${iteration}`,
  };
}

function updateDeleteRace(data, kind, round) {
  const fixture = destructiveFixture('updateDelete', kind, round);
  const base = fixtureBase(kind);
  const actor = fixtureActor(kind);
  const getOperation = `update-delete ${kind} GET`;
  const putOperation = `update-delete ${kind} PUT`;
  const deleteOperation = `update-delete ${kind} DELETE`;
  const current = cedar(data, actor, 'GET', fixture.path, undefined, getOperation, {}, base);
  const revision = requireEtag(current, `${kind} update/delete preflight`);
  if (!revision) return;
  const requests = [
    batchRequest(data, actor, 'PUT', base, fixture.path, replacementBody(kind, current, __ITER), putOperation,
        revision, { expected: [200, 412] }),
    batchRequest(data, actor, 'DELETE', base, fixture.path, undefined, deleteOperation, revision,
        { expected: [204, 412] }),
  ];
  const responses = executeBatch(requests, [putOperation, deleteOperation]);
  exactCas(responses, [200, 204], `${kind} update/delete race`);
  const after = cedar(data, actor, 'GET', fixture.path, undefined, `update-delete ${kind} verification`, {}, base,
      [200, 404]);
  if (responses[0].status === 200) {
    accepted(after, [200], `${kind} update winner remains`);
    check(after, {
      [`${kind} update winner advances once`]: result => revisionNumber(etag(result)) === revisionNumber(revision) + 1,
    });
  } else {
    accepted(after, [404], `${kind} delete winner remains deleted`);
  }
}

function doubleDeleteRace(data, kind, round) {
  const fixture = destructiveFixture('doubleDelete', kind, round);
  const base = fixtureBase(kind);
  const actor = fixtureActor(kind);
  const getOperation = `double-delete ${kind} GET`;
  const deleteOperation = `double-delete ${kind} DELETE`;
  const current = cedar(data, actor, 'GET', fixture.path, undefined, getOperation, {}, base);
  const revision = requireEtag(current, `${kind} double-delete preflight`);
  if (!revision) return;
  const operations = Array(contentionWidth).fill(deleteOperation);
  const requests = operations.map(operation => batchRequest(data, actor, 'DELETE', base, fixture.path, undefined,
      operation, revision, { expected: [204, 404, 412] }));
  const responses = executeBatch(requests, operations);
  if (['template', 'element', 'field', 'instance'].includes(kind)) {
    const acceptedDeletes = responses.filter(response => response.status === 204).length;
    const rejectedDeletes = responses.filter(response => response.status === 404 || response.status === 412).length;
    const exact = acceptedDeletes >= 1 && acceptedDeletes + rejectedDeletes === responses.length;
    check(responses, {
      [`${kind} double-delete: at least one durable deletion is accepted`]: () => acceptedDeletes >= 1,
      [`${kind} double-delete: every response converges or rejects stale state`]: () => exact,
    });
    unexpectedResponses.add(!exact, { operation: `${kind} double-delete race` });
  } else {
    exactCas(responses, [204], `${kind} double-delete race`, { loserStatuses: [404, 412] });
  }
  const after = cedar(data, actor, 'GET', fixture.path, undefined, `double-delete ${kind} verification`, {}, base,
      [404]);
  accepted(after, [404], `${kind} double-delete leaves the resource absent`);
}

function wildcardDelete(data, kind, round) {
  const fixture = destructiveFixture('wildcardDelete', kind, round);
  const base = fixtureBase(kind);
  const actor = fixtureActor(kind);
  const getOperation = `wildcard-delete ${kind} GET`;
  const deleteOperation = `wildcard-delete ${kind} DELETE`;
  const putOperation = `wildcard-delete ${kind} PUT`;
  const current = cedar(data, actor, 'GET', fixture.path, undefined, getOperation, {}, base);
  if (!requireEtag(current, `${kind} wildcard-delete preflight`)) return;
  const deletion = cedar(data, actor, 'DELETE', fixture.path, undefined, deleteOperation,
      { 'If-Match': '*' }, base);
  accepted(deletion, [204], `${kind} wildcard delete succeeds while present`);
  const recreate = cedar(data, actor, 'PUT', fixture.path, replacementBody(kind, current, __ITER), putOperation,
      { 'If-Match': '*' }, base, [412]);
  accepted(recreate, [412], `${kind} wildcard cannot recreate a deleted resource`);
}

function wildcardMutation(data, type) {
  let actor = 0;
  let base = resource;
  let path;
  let method = 'PUT';
  let body;
  let contentType = 'application/json';
  const state = actorState;
  const getOperation = `${type} GET`;
  const mutationOperation = `${type} mutation`;
  const verificationOperation = `${type} verification`;
  if (type === 'wildcard-content') {
    path = manifest.shared.content.template.path;
  } else if (type === 'wildcard-artifact-graph') {
    const fixture = manifest.shared.graphArtifact;
    const graph = state.artifactGraph || (state.artifactGraph = { inSource: true, open: false });
    path = `${fixture.path}/details`;
    const current = cedar(data, actor, 'GET', path, undefined, getOperation);
    const revision = requireEtag(current, `${type} preflight`);
    if (!revision) return;
    const command = graph.open ? 'make-artifact-not-open' : 'make-artifact-open';
    const changed = cedar(data, actor, 'POST', `/command/${command}`, { '@id': fixture.id },
        mutationOperation, { 'If-Match': '*' });
    if (accepted(changed, [200], `${type} succeeds`)) graph.open = !graph.open;
    verifyRevision(data, actor, resource, path, revision, verificationOperation, type);
    return;
  } else if (type === 'wildcard-folder-graph') {
    path = manifest.shared.graphFolder.path;
  } else if (type === 'wildcard-artifact-acl') {
    path = `${manifest.shared.aclArtifact.path}/permissions`;
  } else if (type === 'wildcard-folder-acl') {
    path = `${manifest.shared.aclFolder.path}/permissions`;
  } else if (type === 'wildcard-group-record') {
    base = groupServer;
    path = manifest.shared.group.path;
    method = 'PATCH';
    contentType = 'application/merge-patch+json';
  } else if (type === 'wildcard-group-membership') {
    base = groupServer;
    path = `${manifest.shared.group.path}/users`;
  } else if (type === 'wildcard-category-record') {
    path = manifest.shared.category.path;
  } else if (type === 'wildcard-category-acl') {
    path = `${manifest.shared.category.path}/permissions`;
  }
  const current = cedar(data, actor, 'GET', path, undefined, getOperation, {}, base);
  const revision = requireEtag(current, `${type} preflight`);
  if (!revision) return;
  if (type === 'wildcard-content') {
    body = mutableResponseBody(current);
    body['schema:description'] = `${manifest.prefix} wildcard content ${__ITER}`;
  } else if (type === 'wildcard-folder-graph') {
    body = replacementBody('folder', current, __ITER);
  } else if (type.endsWith('-acl') || type === 'wildcard-group-membership') {
    body = current.json();
  } else if (type === 'wildcard-group-record') {
    body = { 'schema:description': `${manifest.prefix} wildcard group ${__ITER}` };
  } else if (type === 'wildcard-category-record') {
    body = replacementBody('category', current, __ITER);
  }
  const changed = cedar(data, actor, method, path, body, mutationOperation, {
    'If-Match': '*', 'Content-Type': contentType,
  }, base);
  accepted(changed, [200], `${type} succeeds`);
  verifyRevision(data, actor, base, path, revision, verificationOperation, type);
}

export function contention(data) {
  const caseIndex = __ITER % matrixCases.length;
  const round = Math.floor(__ITER / matrixCases.length);
  const testCase = matrixCases[caseIndex];
  switch (testCase.type) {
    case 'content': contentRace(data, testCase.kind); break;
    case 'artifact-graph': graphRace(data, 'artifact'); break;
    case 'folder-graph': graphRace(data, 'folder'); break;
    case 'artifact-acl': aclRace(data, 'artifact'); break;
    case 'folder-acl': aclRace(data, 'folder'); break;
    case 'group-record': groupRace(data, false); break;
    case 'group-membership': groupRace(data, true); break;
    case 'category-record': categoryRace(data, false); break;
    case 'category-acl': categoryRace(data, true); break;
    case 'update-delete': updateDeleteRace(data, testCase.kind, round); break;
    case 'double-delete': doubleDeleteRace(data, testCase.kind, round); break;
    case 'wildcard-delete': wildcardDelete(data, testCase.kind, round); break;
    default: wildcardMutation(data, testCase.type);
  }
}

export function handleSummary(data) {
  const output = __ENV.CEDAR_PERF_SUMMARY || 'k6-summary.json';
  const checks = data.metrics.checks?.values?.rate;
  const p95 = data.metrics.cedar_operation_duration?.values?.['p(95)'];
  const slowest = Object.entries(data.metrics)
      .filter(([name, metric]) => name.startsWith('cedar_route_') && metric.values?.['p(95)'] !== undefined)
      .map(([name, metric]) => ({ name: name.replace(/^cedar_route_|_duration$/g, ''), p95: metric.values['p(95)'] }))
      .sort((left, right) => right.p95 - left.p95)
      .slice(0, 8)
      .map(route => `  ${route.name}: ${route.p95.toFixed(1)} ms`)
      .join('\n');
  data.cedar = {
    profile,
    scheduleSeed,
    users: manifest.actors.length,
    vus: configuredVus,
  };
  return {
    [output]: JSON.stringify(data, null, 2),
    stdout: `\nCEDAR REST ${profile}: checks ${checks === undefined ? 'n/a' : (checks * 100).toFixed(2) + '%'}, HTTP p95 ${p95 === undefined ? 'n/a' : p95.toFixed(1) + ' ms'}, seed ${scheduleSeed}\n${slowest ? `Slowest route p95:\n${slowest}\n` : ''}`,
  };
}
