import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from 'node:process';

export const HOST = env.CEDAR_HOST ?? 'metadatacenter.orgx';
export const RESOURCE = env.CEDAR_RESOURCE_BASE ?? `https://resource.${HOST}`;
export const USER_SERVER = env.CEDAR_USER_BASE ?? `https://user.${HOST}`;
export const GROUP_SERVER = env.CEDAR_GROUP_BASE ?? `https://group.${HOST}`;
export const KEYCLOAK = env.CEDAR_KEYCLOAK_BASE
  ?? `http://${env.CEDAR_KEYCLOAK_HOST ?? '127.0.0.1'}:${env.CEDAR_KEYCLOAK_HTTP_PORT ?? '8080'}`;
export const REALM = env.CEDAR_KEYCLOAK_REALM ?? 'CEDAR';
export const CLIENT = env.CEDAR_KEYCLOAK_CLIENT ?? 'cedar-angular-app';
export const PERF_PREFIX = 'CEDAR REST PERF';

// Native development uses locally issued leaves from the CEDAR CA. This harness refuses remote
// targets by default below; the bypass is therefore constrained to the local performance system.
env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function intArg(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}; got ${raw}`);
  }
  return value;
}

export function durationSeconds(value) {
  const match = String(value).match(/^(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return null;
  const seconds = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return seconds > 0 ? seconds : null;
}

export function burstRecoveryAssessment(summary, recoveryPercent = 150, allowanceMs = 100) {
  const baseline = summary?.metrics?.cedar_burst_baseline_duration?.values?.['p(95)'];
  const recovery = summary?.metrics?.cedar_burst_recovery_duration?.values?.['p(95)'];
  if (!Number.isFinite(baseline) || !Number.isFinite(recovery)) {
    return { pass: false, baseline, recovery, limit: null, reason: 'baseline or recovery p95 is missing' };
  }
  const limit = Math.max(baseline * recoveryPercent / 100, baseline + allowanceMs);
  return {
    pass: recovery <= limit,
    baseline,
    recovery,
    limit,
    reason: recovery <= limit ? null : `recovery p95 ${recovery.toFixed(1)} ms exceeds ${limit.toFixed(1)} ms`,
  };
}

export function runId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Parse only the exact root-folder convention used by this harness. */
export function runTimestampFromRootName(name) {
  const escaped = PERF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = name.match(new RegExp(
      `^${escaped} User \\d+ (\\d{4}-\\d{2}-\\d{2}T\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z-[0-9a-f]{6}$`));
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function enc(value) {
  return encodeURIComponent(value);
}

/** Convert a folder-contents entry into the exact resource-server CRUD path used for cleanup. */
export function performanceResourceDescriptor(resource) {
  const id = resource?.['@id'];
  if (!id) throw new Error('folder contents returned a resource without @id');
  const collection = {
    folder: 'folders',
    template: 'templates',
    element: 'template-elements',
    field: 'template-fields',
    instance: 'template-instances',
  }[resource.resourceType];
  if (!collection) throw new Error(`refusing unexpected ${resource.resourceType} ${id} inside performance root`);
  return {
    kind: resource.resourceType,
    id,
    path: `/${collection}/${enc(id)}`,
    name: resource['schema:name'] ?? resource.schema_name ?? '',
  };
}

export function authHeader(token) {
  return token.split('.').length === 3 ? `Bearer ${token}` : `apiKey ${token}`;
}

export function tokenSubject(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
}

export function assertSafeTargets({ allowRemote = env.CEDAR_PERF_ALLOW_REMOTE === '1' } = {}) {
  if (allowRemote) return;
  const allowed = new Set(['localhost', '127.0.0.1', '::1', 'metadatacenter.orgx']);
  for (const [label, value] of Object.entries({ RESOURCE, USER_SERVER, GROUP_SERVER, KEYCLOAK })) {
    const hostname = new URL(value).hostname;
    if (!allowed.has(hostname) && !hostname.endsWith('.metadatacenter.orgx')) {
      throw new Error(`${label} targets ${hostname}; REST performance tests are local-only unless CEDAR_PERF_ALLOW_REMOTE=1`);
    }
  }
}

export async function request(token, method, path, body, { base = RESOURCE, headers = {} } = {}) {
  const requestHeaders = token ? { Authorization: authHeader(token) } : {};
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  Object.assign(requestHeaders, headers);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* Preserve non-JSON response text. */ }
  return { status: response.status, body: json, text, headers: response.headers };
}

export async function userToken(username, password) {
  const response = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT,
      username,
      password,
    }),
  });
  if (!response.ok) throw new Error(`Keycloak refused ${username}: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

export async function userProfile(token, { attempts = 12, delayMs = 1000 } = {}) {
  const subject = tokenSubject(token);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await request(token, 'GET', `/users/${subject}`, undefined, { base: USER_SERVER });
    if (last.status === 200 && last.body?.homeFolderId) return last.body;
    if (attempt < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  throw new Error(`CEDAR did not provision user ${subject}: ${last?.status} ${last?.text ?? ''}`);
}

export async function currentMutation(token, method, path, body, { etagPath = path, base = RESOURCE } = {}) {
  const current = await request(token, 'GET', etagPath, undefined, { base });
  const etag = current.headers?.get('etag');
  if (!etag) throw new Error(`ETag preflight ${etagPath} returned ${current.status} without an ETag: ${current.text}`);
  return request(token, method, path, body, { base, headers: { 'If-Match': etag } });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Write manifests atomically so an interrupted setup leaves valid cleanup input. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function absolute(path) {
  return resolve(process.cwd(), path);
}

export async function parallelLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
