// Shared harness for the REST-level end-to-end suites.
//
// The suites drive the real stack over HTTP with no browser. Everything they need is here:
// authentication, a request helper, assertions that collect rather than abort, and a teardown
// registry that verifies each deletion instead of trusting a status code.
import { env } from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOST = env.CEDAR_HOST ?? 'metadatacenter.orgx';
export const RESOURCE = env.CEDAR_RESOURCE_BASE ?? `https://resource.${HOST}`;
export const USER_SERVER = env.CEDAR_USER_BASE ?? `https://user.${HOST}`;
export const GROUP_SERVER = env.CEDAR_GROUP_BASE ?? `https://group.${HOST}`;
// The artifact server, addressed directly on its port rather than through `artifact.${HOST}`. The
// resource server proxies every artifact write and read to it, so the contract suite compares the two
// sides of that hop — but the vhost is closed. The artifact server holds no resource-level ACL and
// authorizes on global roles alone, so anything that reaches it can read or change any artifact in
// the installation; production and this host both answer 404 there, and only the internal address
// remains. Reaching it at all is a property of running the suite beside the stack.
export const ARTIFACT_SERVER = env.CEDAR_ARTIFACT_BASE
  ?? `http://${env.CEDAR_ARTIFACT_SERVER_HOST ?? 'localhost'}:${env.CEDAR_ARTIFACT_HTTP_PORT ?? '9001'}`;
export const TERMINOLOGY = env.CEDAR_TERMINOLOGY_BASE ?? `https://terminology.${HOST}`;
// The OpenView *server*, not the OpenView frontend. `openview.${HOST}` is the AngularJS app; the API
// has no vhost of its own, so it is addressed directly on its port.
export const OPENVIEW = env.CEDAR_OPENVIEW_BASE
  ?? `http://${env.CEDAR_OPENVIEW_SERVER_HOST ?? 'localhost'}:${env.CEDAR_OPENVIEW_HTTP_PORT ?? '9013'}`;
const KEYCLOAK = env.CEDAR_KEYCLOAK_BASE
  ?? `http://${env.CEDAR_KEYCLOAK_HOST ?? '127.0.0.1'}:${env.CEDAR_KEYCLOAK_HTTP_PORT ?? '8080'}`;
const REALM = env.CEDAR_KEYCLOAK_REALM ?? 'CEDAR';
const CLIENT = env.CEDAR_KEYCLOAK_CLIENT ?? 'cedar-angular-app';

// The local stack serves self-signed leaves from the CEDAR CA.
env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const enc = iri => encodeURIComponent(iri);

// ── results ─────────────────────────────────────────────────────────────────

const results = { passed: 0, failed: 0 };
let currentSuite = '';

export function suite(name) {
  currentSuite = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
}

export function ok(what) {
  results.passed++;
  console.log(`  ✓ ${what}`);
}

/** A failure. Recorded and reported; the suite keeps going so one run shows everything. */
export function bad(what, detail) {
  results.failed++;
  console.error(`  ✗ ${what}\n      ${detail}`);
}

export function check(condition, what, detail) {
  if (condition) ok(what); else bad(what, detail);
  return !!condition;
}

/** Asserts a status, reporting the body when it differs — the body is where the reason is. */
export function checkStatus(res, expected, what) {
  const list = Array.isArray(expected) ? expected : [expected];
  return check(list.includes(res.status), what,
      `expected ${list.join(' or ')}, got ${res.status}: ${(res.text ?? '').slice(0, 300)}`);
}

export function summary() {
  return results;
}

// ── authentication ──────────────────────────────────────────────────────────

async function token(login, password) {
  const res = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: CLIENT, username: login, password }),
  });
  if (!res.ok) throw new Error(`Keycloak refused ${login}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * The caller's own profile, which is where homeFolderId lives. There is no /users/me: the
 * resource server exposes none, and the user server keys on the id, so the id comes from the
 * token's `sub` claim.
 */
async function profile(auth) {
  const claims = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString());
  const res = await fetch(`${USER_SERVER}/users/${claims.sub}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  if (!res.ok) throw new Error(`could not read the profile for ${claims.sub}: ${res.status}`);
  return res.json();
}

/** Both test users, authenticated, with their profiles. */
export async function actors() {
  const u1 = await token(env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com',
      env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1');
  const u2 = await token(env.CEDAR_FRONTEND_local_USER2_LOGIN ?? 'test2@test.com',
      env.CEDAR_FRONTEND_local_USER2_PASSWORD ?? 'test2');
  const out = {
    user1: { auth: u1, profile: await profile(u1) },
    user2: { auth: u2, profile: await profile(u2) },
  };
  // The administrator, by API key rather than password: the CEDAR admin user is not a Keycloak login
  // with a password in the profile, but its key is. Some surfaces are admin-only — the category tree
  // is writable only by someone with write on the root — so without this they cannot be exercised
  // at all. Absent means the suites that need it skip rather than fail.
  const adminKey = env.CEDAR_ADMIN_USER_API_KEY;
  if (adminKey) out.admin = { auth: adminKey };
  return out;
}

// ── requests ────────────────────────────────────────────────────────────────

/**
 * One request against the resource server. Returns the status, the parsed body when it is JSON,
 * and always the raw text, because an error body is often the only useful thing in a failure.
 */
/**
 * The Authorization header for a credential. A JWT from the password grant is a Bearer token; an
 * administrator's API key is not, and CEDAR's own scheme is `apiKey <key>`. Detected by shape so a
 * suite can pass either without caring which it has.
 */
export function authHeader(auth) {
  return auth.split('.').length === 3 ? `Bearer ${auth}` : `apiKey ${auth}`;
}

/**
 * One request. `auth` may be null for an anonymous call — which the OpenView server expects and
 * every other service must refuse.
 *
 * opts.base sends it somewhere other than the resource server; opts.headers replaces the
 * Authorization header outright, which is how the authentication audit sends malformed credentials.
 */
export async function call(auth, method, path, body, opts = {}) {
  const headers = auth ? { Authorization: authHeader(auth) } : {};
  if (body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
  if (opts.accept) headers['Accept'] = opts.accept;
  Object.assign(headers, opts.headers ?? {});
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  const res = await fetch(`${opts.base ?? RESOURCE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined
        : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON — keep the text */ }
  if (method === 'POST' && res.status === 201) noteCreated(json, opts.base);
  return { status: res.status, body: json, text, headers: res.headers };
}

/** A request against the group server, which owns groups and their membership. */
export function group(auth, method, path, body, opts = {}) {
  return call(auth, method, path, body, { ...opts, base: GROUP_SERVER });
}

/** A request straight to the artifact server, bypassing the resource server's graph and proxy. */
export function artifact(auth, method, path, body, opts = {}) {
  return call(auth, method, path, body, { ...opts, base: ARTIFACT_SERVER });
}

/**
 * The group every user belongs to, which is how "share with everybody" is expressed: a grant to this
 * group, denormalized onto the node as its everybody permission. Found by its special marker rather
 * than by name, since the name is configurable.
 */
export async function everybodyGroup(auth) {
  const res = await group(auth, 'GET', '/groups');
  if (res.status !== 200) throw new Error(`could not list groups: ${res.status} ${res.text}`);
  const found = (res.body?.groups ?? []).find(g => g.specialGroup === 'EVERYBODY');
  if (!found) throw new Error('no group carries the EVERYBODY marker');
  return found;
}

/**
 * Waits for something the stack does asynchronously. Search indexing is queued through the worker,
 * so a permission change is not visible the instant the API returns; polling is the only sound way
 * to assert on it. Returns the last value whether or not it ever satisfied the predicate, so the
 * caller reports the real outcome rather than a timeout.
 */
export async function poll(probe, { tries = 12, delayMs = 1500 } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    last = await probe(attempt);
    if (last?.done) return { ...last, attempts: attempt };
    if (attempt < tries) await new Promise(r => setTimeout(r, delayMs));
  }
  return { ...last, attempts: tries, timedOut: true };
}

// ── fixtures ────────────────────────────────────────────────────────────────

function fixture(name) {
  return JSON.parse(readFileSync(resolve(HERE, '..', 'fixtures', name), 'utf8'));
}

/**
 * A valid artifact of the given kind, named for the run.
 *
 * Loaded from fixtures rather than written inline: the meta-schema requires a `properties` block
 * naming `@context`, `@id`, `oslc:modifiedBy` and more, which is knowledge that belongs with the
 * schema. See fixtures/README.md.
 *
 * The identifier is nulled rather than dropped, which is what a client says when it wants one
 * assigned: a create carrying a real IRI is refused, and so is one leaving the key out, because an
 * absent key cannot be told from a forgotten one. An update needs the real identifier restored.
 */
export function artifactBody(kind, name, extra = {}) {
  const files = {
    template: 'minimal-template.json',
    element: 'minimal-element.json',
    field: 'minimal-field.json',
    instance: 'minimal-instance.json',
  };
  const body = fixture(files[kind]);
  body['@id'] = null;
  body['schema:name'] = name;
  body['schema:description'] = `Created by the REST suites (${RUN})`;
  return Object.assign(body, extra);
}

/** Where each artifact kind lives, and whether it carries a version chain. */
export const KINDS = [
  { kind: 'template', path: '/templates', versioned: true },
  { kind: 'element', path: '/template-elements', versioned: true },
  { kind: 'field', path: '/template-fields', versioned: true },
  { kind: 'instance', path: '/template-instances', versioned: false },
];

// ── teardown ────────────────────────────────────────────────────────────────

const registry = [];

/** Where each kind is addressed, for a path built from an identifier alone. */
const COLLECTION_PATH = {
  instance: '/template-instances',
  template: '/templates',
  element: '/template-elements',
  field: '/template-fields',
  folder: '/folders',
};

// Every folder and artifact a POST minted, in creation order, each attributed to the suite that was
// running when it appeared, alongside the identifiers teardown was told about. Comparing the two is
// what catches a suite that creates without registering: teardown reports only the deletions it was
// asked for, so such a suite leaves a subtree behind inside a run that passes. One run left
// thirty-two artifacts in the first user's home exactly that way.
const created = [];
const registeredIds = new Set();

/**
 * The kind a resource is, read off the identifier it was assigned rather than the endpoint that
 * assigned it: publish, create-draft and copy each mint a new artifact from a path naming the old
 * one, so the request path is not what says which collection the result landed in.
 */
function kindOfId(id) {
  return Object.entries(COLLECTION_PATH).find(([, path]) => id.includes(`${path}/`))?.[0];
}

function noteCreated(json, base) {
  if (base && base !== RESOURCE) return;   // a group belongs to the group server's own teardown
  const id = json?.['@id'];
  if (typeof id !== 'string') return;
  const kind = kindOfId(id);
  if (!kind || created.some(c => c.id === id)) return;
  created.push({ kind, id, name: json['schema:name'] ?? json.schema_name ?? '(unnamed)', suite: currentSuite });
}

/**
 * Registers something for deletion. Newest first, so teardown unwinds in dependency order. An
 * optional credential covers the things the first user cannot delete — a category belongs to the
 * administrator who created it — and an optional base covers what lives on another service, such as
 * a group.
 */
export function cleanup(kind, path, name, auth, base) {
  registry.unshift({ kind, path, name, auth, base });
  registeredIds.add(decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)));
}

/**
 * Deletes what the run created and never registered, and names the suite that created each one.
 * Deleting keeps the stack clean for the next run; reporting is what stops a leak from riding along
 * inside a passing run, which is how a whole working subtree survived unnoticed.
 */
async function sweepUnregistered(auth) {
  const suspects = created.filter(c => !registeredIds.has(c.id));
  let swept = 0;
  for (const kind of ['instance', 'template', 'element', 'field', 'folder']) {
    // Newest first within a kind: a nested folder is created after the folder holding it, and a
    // folder still holding anything cannot be deleted.
    for (const item of suspects.filter(s => s.kind === kind).reverse()) {
      const path = `${COLLECTION_PATH[kind]}/${enc(item.id)}`;
      const probe = await call(auth, 'GET', path);
      if (probe.status >= 400) continue;   // the suite deleted it itself, so nothing leaked
      bad(`teardown: ${kind} "${item.name}" is left behind by the "${item.suite}" suite`,
          `created but never registered with cleanup(); ${item.id}`);
      const del = await call(auth, 'DELETE', path);
      if (del.status !== 204 && del.status !== 200) {
        bad(`teardown: ${kind} "${item.name}" could not be swept`, `${del.status}: ${(del.text ?? '').slice(0, 200)}`);
        continue;
      }
      swept++;
    }
  }
  return swept;
}

/**
 * Deletes everything registered and verifies each one is gone by reading it back. An earlier UI
 * smoke left four scratch folders behind because it believed a status code.
 */
export async function teardown(auth) {
  let removed = 0;
  for (const item of registry) {
    const as = item.auth ?? auth;
    const where = { base: item.base };
    const del = await call(as, 'DELETE', item.path, undefined, where);
    // 404 means it is already gone, which is exactly the end state teardown is verifying — a suite
    // that deletes what it created (the contract suite deletes an artifact to prove the delete reaches
    // both stores) registered cleanup as a safety net that is simply not needed this run.
    if (del.status === 404) { removed++; continue; }
    if (del.status !== 204 && del.status !== 200) {
      bad(`teardown: ${item.kind} "${item.name}" not deleted`, `${del.status}: ${(del.text ?? '').slice(0, 200)}`);
      continue;
    }
    const after = await call(as, 'GET', item.path, undefined, where);
    if (after.status < 400) {
      bad(`teardown: ${item.kind} "${item.name}" still readable after deletion`, `GET returned ${after.status}`);
      continue;
    }
    removed++;
  }
  const swept = await sweepUnregistered(auth);
  if (removed) console.log(`\n  cleaned up ${removed} resource(s)`);
  if (swept) console.log(`  swept ${swept} unregistered resource(s) — see the failures above`);
  registry.length = 0;
  created.length = 0;
  registeredIds.clear();
}
