// Every error answer is the shared error body.
//
// A CEDAR service refuses a request with CedarError: a JSON object carrying the status twice, as a
// name and as a number, an error key and reason, a message, and the named parameters and objects a
// refusal reports. A client can then read every refusal the same way, whichever service, route or
// layer gave it. The servers' own suites check that each route documents its refusals in that shape.
// This suite checks what the running services answer.
//
// It reads every operation from each server's committed OpenAPI document and sends it requests that
// must be refused: one without credentials, one naming identifiers that do not exist, and one whose
// JSON body is malformed, wherever the operation takes credentials, an identifier or a JSON body. A
// route no service declares is asked for too. A second section repeats refusals that once answered a
// body of their own and can be reached without changing anything.
//
// The request without credentials must be answered 401 and nothing else. It carries a body that
// parses, so an operation that authenticates first has no other reason to refuse it, and a 404 for
// the identifier or a 400 for the body would mean the operation looked before it authenticated. The
// request also carries every required query parameter and a required If-Match header, since an
// operation may check those before it authenticates. An operation that still reads its input first
// is named, with the reason, in VALIDATES_FIRST below, and may answer the status named there instead.
//
// Nothing a probe sends can change state. A probe names identifiers that do not exist, so there is
// nothing for it to change. A credentialed body is not JSON, so it cannot be stored, and the body
// sent without credentials is an empty object, which names nothing. An operation that takes neither
// an identifier nor a body is sent only the request without credentials, so an action that needs no
// input, such as rebuilding an index, is refused before it starts. Requests that would reach an
// external service before anything could refuse them are not sent, and each such omission is a named
// entry below, printed with every run.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import {
  suite, check, skip, call, enc, HOST, RESOURCE, USER_SERVER, GROUP_SERVER, MESSAGING, MONITOR, BRIDGE,
  TERMINOLOGY, ARTIFACT_SERVER, OPENVIEW, WORKER,
} from '../lib.mjs';

export const name = 'errors';

const HERE = dirname(fileURLToPath(import.meta.url));
const CEDAR_HOME = env.CEDAR_HOME ?? resolve(HERE, '..', '..', '..', '..', '..');

/** A service addressed on its own port, as the harness addresses the services that have no vhost. */
const local = (service, port) => env[`CEDAR_${service}_BASE`]
  ?? `http://${env[`CEDAR_${service}_SERVER_HOST`] ?? 'localhost'}:${env[`CEDAR_${service}_HTTP_PORT`] ?? port}`;

/** Every server that commits an OpenAPI document, where the suite reaches it. */
const SERVERS = [
  { server: 'resource', base: RESOURCE },
  { server: 'artifact', base: ARTIFACT_SERVER },
  { server: 'repo', base: local('REPO', '9002') },
  { server: 'terminology', base: TERMINOLOGY },
  { server: 'user', base: USER_SERVER },
  { server: 'group', base: GROUP_SERVER },
  { server: 'worker', base: WORKER },
  { server: 'messaging', base: MESSAGING },
  { server: 'openview', base: OPENVIEW },
  { server: 'monitor', base: MONITOR },
  { server: 'bridge', base: BRIDGE },
];

/** The kinds of request every operation that can take one is sent, in the order they are checked. */
const KINDS = [
  { kind: 'anonymous', what: 'a request without credentials is refused in a CedarError' },
  { kind: 'identifier', what: 'a nonexistent identifier is refused in a CedarError' },
  { kind: 'body', what: 'a malformed JSON body is refused in a CedarError' },
  { kind: 'route', what: 'a route the service does not serve is answered with a CedarError' },
];

/**
 * Requests the suite does not send, each with the reason. A probe an entry matches is left out and
 * reported. The operation's other probes are still sent.
 */
const EXCLUDED = [
  { server: 'bridge', method: 'GET', path: '/datacite/get-doi-metadata/{id}', kinds: ['identifier'],
    reason: 'asks DataCite for the DOI before anything can refuse the request, on the repository credentials '
      + 'the deployment holds' },
  { server: 'terminology', path: /^\/bioportal\//, kinds: ['identifier'],
    reason: 'asks BioPortal before anything can refuse the request, on the API key the deployment holds' },
];

/**
 * Operations that read their input before they authenticate, each with the status they answer a
 * request without credentials and the reason. The status is accepted in place of 401 for exactly
 * these operations. An entry the operation no longer needs, because it now answers 401, is printed
 * with every run so that it can be removed.
 */
export const VALIDATES_FIRST = [
  // None today. On 2026-11-16 every operation of the eleven servers answered a well-formed request
  // without credentials with 401. Four answered 400 to the malformed body and missing query parameter
  // that the probe sent before, which shows only that they parse what they are sent first.
];

/**
 * Requests that need not be refused, each with the reason. A success they answer is not a failure.
 */
const ANSWERED = [
  { server: 'monitor', method: 'GET', path: '/logs/trace/{globalRequestId}',
    reason: 'reports the trace of a request identifier, which is empty for one no service logged' },
];

/**
 * Error answers the services document but no request here can provoke, because provoking one changes
 * state or asks an external service. Their bodies are checked by the servers' own suites, against
 * stand-ins for the artifact server, the regeneration job, DataCite and the external registries.
 */
const UNREACHABLE = [
  ['resource', 'POST /command/inclusions-subgraph-update 502',
    'needs a propagation write the artifact server refuses, so it needs a write'],
  ['worker', 'POST /command/regenerate-inclusion-subgraph 409', 'needs a regeneration in flight, which rebuilds '
    + 'the inclusion graph'],
  ['bridge', 'GET /datacite/get-doi-metadata/{id} 404 and 502, POST /datacite/create-doi 4xx and 502 from DataCite',
    'needs DataCite to answer'],
  ['bridge', 'GET /ext-auth/{authority}/search-by-name and GET /ext-auth/{authority}/{id} 4xx and 502 '
    + 'from a registry, and 503 when it does not answer',
    'asks the registry, three of them on credentials the deployment holds. Each authority route is probed only '
      + 'under a segment no authority is registered under, which is refused before any registry is asked.'],
  ['every server', 'GET /healthcheck 500, monitor GET /health-check/{server} 500',
    'a health report, not an error body, answered when a dependency is down'],
];

/** The fields a CedarError may carry. It is a closed schema. */
const CEDAR_ERROR_FIELDS = new Set(['status', 'statusCode', 'errorKey', 'errorReasonKey', 'errorType', 'message',
  'parameters', 'objects', 'entities', 'suggestedAction', 'operation', 'errorId']);
const REQUIRED_FIELDS = ['status', 'statusCode', 'errorKey', 'errorReasonKey', 'message', 'parameters', 'objects'];

const MALFORMED_JSON = '{"';
// A body that parses and names nothing, sent without credentials so that only authentication can refuse it.
const EMPTY_JSON = '{}';
const ANSWER_TIMEOUT_MS = 30000;
const PROBES_IN_FLIGHT = 6;
const WRITES = new Set(['put', 'post', 'patch', 'delete']);
// The server errors an operation may answer when it documents them, because it relays a service
// that did not answer or answered badly. Any other 5xx to a request naming nothing is a crash.
const GATEWAY = new Set([502, 503]);

/**
 * Why an answer is not a CedarError, or null when it is one. The status in the body must be the
 * status of the answer, and the body must carry the fields a client reads and no others.
 */
export function cedarErrorProblem(res) {
  const type = res.headers?.get?.('content-type') ?? '';
  if (!type.startsWith('application/json')) return `answered ${type || 'no content type'}`;
  const body = res.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body is not a JSON object';
  if (body.statusCode !== res.status) return `statusCode ${JSON.stringify(body.statusCode)} is not the status`;
  if (typeof body.status !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(body.status)) {
    return `status ${JSON.stringify(body.status)} is not a status name`;
  }
  const missing = REQUIRED_FIELDS.filter(field => !Object.hasOwn(body, field));
  if (missing.length) return `carries no ${missing.join(', ')}`;
  for (const field of ['parameters', 'objects']) {
    if (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field])) return `${field} is not an object`;
  }
  const extra = Object.keys(body).filter(field => !CEDAR_ERROR_FIELDS.has(field));
  if (extra.length) return `carries ${extra.join(', ')}, which a CedarError does not`;
  return null;
}

function readSpec(server) {
  const file = resolve(CEDAR_HOME, `cedar-${server}-server`, `cedar-${server}-server-application`,
      'src', 'main', 'resources', 'assets', 'swagger-api', 'swagger.json');
  try {
    return { spec: JSON.parse(readFileSync(file, 'utf8')), file };
  } catch (error) {
    return { file, error: error.message };
  }
}

/** A value for a path parameter that names nothing, in the form the collection it follows takes. */
function nonexistent(previousSegment) {
  const uuid = randomUUID();
  if (previousSegment === 'ext-auth') return `no-such-authority-${uuid.slice(0, 8)}`;
  if (previousSegment === 'users') return `https://metadatacenter.org/users/${uuid}`;
  if (['templates', 'template-elements', 'template-fields', 'template-instances', 'folders', 'categories',
    'groups'].includes(previousSegment)) return `https://repo.${HOST}/${previousSegment}/${uuid}`;
  return uuid;
}

function concretePath(path) {
  const segments = path.split('/');
  return segments.map((segment, index) => /^\{.+\}$/.test(segment)
    ? enc(nonexistent(segments[index - 1])) : segment).join('/');
}

/** The operation's parameters, with references resolved. */
function parameters(spec, op) {
  return (op.parameters ?? []).map(parameter => parameter.$ref
    ? spec.components?.parameters?.[parameter.$ref.split('/').pop()] ?? {}
    : parameter);
}

/** A value for a required query parameter that names nothing, in the form its schema takes. */
function placeholder(parameter) {
  const schema = parameter.schema ?? {};
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (schema.type === 'integer' || schema.type === 'number') return '1';
  if (schema.type === 'boolean') return 'false';
  if (/(^|_)(id|uri)$/i.test(parameter.name)) return `https://repo.${HOST}/templates/${randomUUID()}`;
  if (parameter.name === 'resource_type') return 'template';
  if (parameter.name === 'state') return 'draft';
  return 'x';
}

/**
 * What a request needs beyond its path to be well formed: every required query parameter, and an
 * If-Match header where one is required. A revision that names nothing satisfies the header's
 * presence and matches no stored revision.
 */
function wellFormed(spec, op) {
  const query = new URLSearchParams();
  const headers = {};
  for (const parameter of parameters(spec, op)) {
    if (!parameter.required) continue;
    if (parameter.in === 'query') query.set(parameter.name, placeholder(parameter));
    if (parameter.in === 'header' && parameter.name.toLowerCase() === 'if-match') headers['If-Match'] = '"0"';
  }
  const search = query.toString();
  return { suffix: search ? `?${search}` : '', headers };
}

function requestBodyTypes(spec, op) {
  let body = op.requestBody;
  if (body?.$ref) body = spec.components?.requestBodies?.[body.$ref.split('/').pop()];
  return Object.keys(body?.content ?? {});
}

// An operation's security requirements are alternatives, and an empty one admits a caller with no
// credentials, so an operation requires credentials only when every alternative names a scheme. One
// that makes a credential optional is answered rather than refused without one, and is not probed so.
function requiresCredentials(spec, op) {
  const requirements = op.security ?? spec.security ?? [];
  return requirements.length > 0 && requirements.every(requirement => Object.keys(requirement).length > 0);
}

function excludedBy(server, method, path, kind) {
  return EXCLUDED.find(entry => entry.server === server && entry.kinds.includes(kind)
    && (!entry.method || entry.method === method)
    && (entry.path instanceof RegExp ? entry.path.test(path) : entry.path === path));
}

/** The probes one operation is sent, and the ones it is not, with the reason. */
export function plan(server, spec, method, path, op) {
  const verb = method.toUpperCase();
  const secured = requiresCredentials(spec, op);
  const types = requestBodyTypes(spec, op);
  const takesJson = types.some(type => type === 'application/json' || type === '*/*');
  const takesIdentifier = path.includes('{');
  const probes = [];
  const omitted = [];
  const answered = ANSWERED.find(entry => entry.server === server && entry.method === verb && entry.path === path);
  const add = (kind, request) => {
    const excluded = excludedBy(server, verb, path, kind);
    if (excluded) omitted.push({ kind, reason: excluded.reason });
    else probes.push({ kind, request, ...(answered && kind === 'identifier' ? { answered: answered.reason } : {}),
      ...(gatewayStatuses.length ? { gateway: gatewayStatuses } : {}) });
  };
  // A gateway answer is a refusal only where the operation documents one: it relays another service.
  const gatewayStatuses = Object.keys(op.responses ?? {}).map(Number).filter(status => GATEWAY.has(status));
  // Whatever an operation is sent, it names nothing and carries no usable body, so a route that
  // failed to refuse it would still have nothing to act on.
  const validatesFirst = VALIDATES_FIRST.find(entry => entry.server === server && entry.method === verb
    && entry.path === path);
  if (secured) {
    const { suffix, headers } = wellFormed(spec, op);
    add('anonymous', { method: verb, path: `${concretePath(path)}${suffix}`, headers,
      body: takesJson ? EMPTY_JSON : undefined, auth: 'none' });
    if (validatesFirst) probes.at(-1).validatesFirst = validatesFirst;
  }
  if (takesIdentifier && (!WRITES.has(method) || !takesJson)) {
    add('identifier', { method: verb, path: concretePath(path), auth: secured ? 'user' : 'none' });
  }
  if (takesJson) add('body', { method: verb, path: concretePath(path), body: MALFORMED_JSON, auth: secured ? 'user' : 'none' });
  if (!probes.length && !omitted.length) {
    omitted.push({ kind: 'none', reason: types.length
      ? 'takes no credentials, identifier or JSON body: nothing it could refuse here'
      : 'takes no credentials, identifier or body: nothing it could refuse here' });
  }
  return { probes, omitted };
}

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_TIMEOUT_MS / 1000} s`)), ANSWER_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function send(base, request, credentials) {
  const auth = request.auth === 'none' ? null : credentials[request.auth];
  const opts = { base, headers: request.headers };
  if (base === ARTIFACT_SERVER && request.auth === 'none') opts.artifactService = false;
  try {
    return await withTimeout(call(auth, request.method, request.path, request.body, opts));
  } catch (error) {
    return { failed: error.cause?.code ?? error.message };
  }
}

/** Runs the probes a few at a time and returns their answers in the order they were planned. */
async function answerAll(base, probes, credentials) {
  const answers = new Array(probes.length);
  let next = 0;
  await Promise.all(Array.from({ length: PROBES_IN_FLIGHT }, async () => {
    while (next < probes.length) {
      const index = next++;
      const probe = probes[index];
      let res = await send(base, probe.request, credentials);
      const tried = [res];
      // A refusal for want of a permission may stand in front of the lookup. An administrator's read
      // reaches it, so the answer behind the gate is checked too.
      if (res.status === 403 && probe.kind === 'identifier' && probe.request.method === 'GET' && credentials.admin) {
        res = await send(base, { ...probe.request, auth: 'admin' }, credentials);
        tried.push(res);
      }
      answers[index] = tried;
    }
  }));
  return answers;
}

function describe(probe, res) {
  const what = `${probe.request.method} ${probe.request.path.slice(0, 120)}`;
  if (res.failed) return `${what}: ${res.failed}`;
  return `${what}: ${res.status} ${cedarErrorProblem(res) ?? ''} ${(res.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`;
}

const histogram = statuses => Object.entries(statuses.reduce((counts, status) => {
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, {})).sort().map(([status, count]) => `${status}×${count}`).join(' ');

async function probeServer({ server, base }, credentials, coverage) {
  suite(`errors: ${server} answers every refusal in the shared error body`);
  const { spec, file, error } = readSpec(server);
  if (!check(!!spec, `${server}: the committed OpenAPI document is read`, `${file}: ${error}`)) {
    for (const { what } of KINDS) skip(`${server}: ${what}`, 'no OpenAPI document');
    return;
  }
  const byKind = Object.fromEntries(KINDS.map(({ kind }) => [kind, []]));
  const omitted = [];
  let operations = 0;
  for (const [path, operationsAt] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(operationsAt)) {
      if (!['get', 'put', 'post', 'patch', 'delete'].includes(method)) continue;
      operations++;
      const planned = plan(server, spec, method, path, op);
      for (const probe of planned.probes) byKind[probe.kind].push(probe);
      for (const omission of planned.omitted) omitted.push({ operation: `${method.toUpperCase()} ${path}`, ...omission });
    }
  }
  byKind.route.push({ kind: 'route', request: { method: 'GET', path: `/${randomUUID()}/${randomUUID()}`, auth: 'none' } });

  // The artifact server takes the installation's service key beside a user's credential. Without it,
  // only the requests that carry no credentials at all can be sent.
  const keyless = server === 'artifact' && !env.CEDAR_ARTIFACT_SERVICE_API_KEY;
  const counts = [];
  for (const { kind, what } of KINDS) {
    // A server with no operation of a kind has nothing to refuse, so it gets no check of that kind.
    if (!byKind[kind].length) {
      counts.push(`0 ${kind} (no operation takes ${kind === 'body' ? 'a JSON body'
        : kind === 'identifier' ? 'an identifier' : 'credentials'})`);
      continue;
    }
    const probes = keyless && kind !== 'anonymous' && kind !== 'route' ? [] : byKind[kind];
    if (!probes.length) {
      skip(`${server}: ${what}`, 'CEDAR_ARTIFACT_SERVICE_API_KEY is unset');
      continue;
    }
    const answers = await answerAll(base, probes, credentials);
    const failures = [];
    const statuses = [];
    answers.forEach((tried, index) => tried.forEach(res => {
      const probe = probes[index];
      statuses.push(res.failed ? 'none' : res.status);
      const permitted = probe.validatesFirst?.status;
      if (kind === 'anonymous' && !res.failed && res.status !== 401 && res.status !== permitted) {
        failures.push(`${describe(probe, res)} (a request without credentials must be answered 401)`);
      } else if (kind === 'anonymous' && res.status === 401 && permitted) {
        coverage.authenticatesFirst.push(`${server}: ${probe.request.method} ${probe.request.path.slice(0, 100)} `
          + `now answers 401, so its VALIDATES_FIRST entry can go`);
      } else if (!res.failed && res.status < 400 && probe.answered) {
        coverage.answered.push(`${server}: ${probe.request.method} ${probe.request.path.slice(0, 100)} answered `
          + `${res.status}, which it may: it ${probe.answered}`);
      } else if (res.failed || res.status < 400 || cedarErrorProblem(res)) {
        failures.push(describe(probe, res));
      } else if (res.status >= 500 && probe.gateway?.includes(res.status)) {
        coverage.serverErrors.push(`${server}: ${describe(probe, res)}`);
      } else if (res.status >= 500) {
        failures.push(`${describe(probe, res)} (a server error, which the operation does not document as a gateway answer)`);
      }
    }));
    check(failures.length === 0, `${server}: ${what}`,
        `${failures.length} of ${statuses.length} answers:\n        ${failures.slice(0, 40).join('\n        ')}`
          + (failures.length > 40 ? `\n        and ${failures.length - 40} more` : ''));
    counts.push(`${statuses.length} ${kind} (${histogram(statuses)})`);
  }
  coverage.servers.push({ server, operations, counts, omitted });
}

/** Refusals that once answered a body of their own, sent where none of them can change anything. */
async function priorBodies({ user1, homeFolderId, folderId }) {
  suite('errors: refusals that once had a body of their own answer the shared error body');
  const auth = user1.auth;
  const home = `/folders/${enc(homeFolderId)}/deletion`;
  const refusal = (res, what, { message = false } = {}) => {
    const problem = res.status < 400 ? `answered ${res.status}` : cedarErrorProblem(res)
      ?? (message && !res.body?.message ? 'carries no message' : null);
    return check(!problem, what, `${res.status}: ${problem}: ${(res.text ?? '').slice(0, 200)}`);
  };
  // A home folder is refused before its contents are read, so neither request inventories anything.
  refusal(await call(auth, 'GET', home), 'the deletion inventory of a home folder is refused');
  refusal(await call(auth, 'POST', home, { token: 'a'.repeat(64) }), 'and so is a confirmation of its deletion');
  // A token in no inventory's form is refused before anything is read or deleted.
  refusal(await call(auth, 'POST', `/folders/${enc(folderId)}/deletion`, { token: 'not-a-token' }),
      'a deletion confirmation without a valid token is refused');
  // The DOI routes read the artifact through the resource server before DataCite is asked anything, so
  // an artifact that does not exist stops them there. The refusal says why rather than giving a status alone.
  const missing = enc(`https://repo.${HOST}/templates/${randomUUID()}`);
  refusal(await call(auth, 'GET', `/datacite/create-doi?source_artifact_id=${missing}`, undefined, { base: BRIDGE }),
      'opening the DOI form for an artifact that does not exist is refused with a message', { message: true });
  refusal(await call(auth, 'POST', `/datacite/create-doi?source_artifact_id=${missing}&state=draft`, {},
      { base: BRIDGE }), 'and so is registering a DOI for it', { message: true });
}

export async function run({ user1, admin, homeFolderId, folderId }) {
  const started = Date.now();
  const credentials = { user: user1.auth, admin: admin?.auth };
  const coverage = { servers: [], answered: [], serverErrors: [], authenticatesFirst: [] };
  for (const server of SERVERS) await probeServer(server, credentials, coverage);
  await priorBodies({ user1, homeFolderId, folderId });

  console.log('\n  covered:');
  for (const { server, operations, counts } of coverage.servers) {
    console.log(`    ${server}: ${operations} operations; ${counts.join('; ')}`);
  }
  for (const line of coverage.answered) console.log(`    ${line}`);
  if (VALIDATES_FIRST.length) console.log('  read their input before authenticating:');
  for (const { server, method, path, status, reason } of VALIDATES_FIRST) {
    console.log(`    ${server}: ${method} ${path} answers ${status} without credentials: ${reason}`);
  }
  for (const line of coverage.authenticatesFirst) console.log(`    ${line}`);
  // A server error fails its check unless the operation documents it as a gateway answer.
  if (coverage.serverErrors.length) console.log('  refused with a gateway answer the operation documents:');
  for (const line of coverage.serverErrors) console.log(`    ${line}`);
  console.log('  not sent:');
  for (const { server, omitted } of coverage.servers) {
    const reasons = new Map();
    for (const { operation, kind, reason } of omitted) {
      const key = `${kind === 'none' ? '' : `${kind} probe: `}${reason}`;
      reasons.set(key, [...(reasons.get(key) ?? []), operation]);
    }
    for (const [reason, operations] of reasons) {
      console.log(`    ${server}: ${operations.length} ${reason}\n      ${operations.join(', ')}`);
    }
  }
  console.log('  documented but not provoked:');
  for (const [server, answer, reason] of UNREACHABLE) console.log(`    ${server}: ${answer}: ${reason}`);
  if (!credentials.admin) console.log('  no administrator key: a refusal behind a permission gate was not followed');
  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return {};
}
