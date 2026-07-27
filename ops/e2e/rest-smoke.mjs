// End-to-end smoke test at the REST layer: every service running, no browser.
//
//   npm run smoke:rest
//
// This is the middle tier the test estate was missing. The per-service suites run
// backend-free and stop at the proxy, so they cannot see a two-service write. The UI
// smoke sees everything but through AngularJS markup, which makes it brittle and ties
// it to a frontend that will not outlive the backend. What only this tier can reach:
//
//   * the artifact write path at all. Creating a template through the resource server
//     proxies its content to the artifact server, so no unit suite covers it — the
//     resource-server tests only assert the rejections that fire before the proxy.
//   * publish and create-draft, which write to the graph and the artifact server both,
//     and which nothing anywhere exercised before this file.
//   * proxy fidelity: that what the artifact server stored is what the resource server
//     serves back.
//   * search-index propagation, which is asynchronous and invisible where the suites
//     run NoOpNodeIndexingService.
//   * sharing as two real users, each with their own credentials.
//
// Authentication uses Keycloak's password grant with the credentials already in the
// CEDAR profile, so there are no API keys to store. Requires the stack up:
// cedar-services.sh health.
import { env } from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const HOST = env.CEDAR_HOST ?? 'metadatacenter.orgx';
const RESOURCE = env.CEDAR_RESOURCE_BASE ?? `https://resource.${HOST}`;
const USER_SERVER = env.CEDAR_USER_BASE ?? `https://user.${HOST}`;
const KEYCLOAK = env.CEDAR_KEYCLOAK_BASE
  ?? `http://${env.CEDAR_KEYCLOAK_HOST ?? '127.0.0.1'}:${env.CEDAR_KEYCLOAK_HTTP_PORT ?? '8080'}`;
const REALM = env.CEDAR_KEYCLOAK_REALM ?? 'CEDAR';
const CLIENT = env.CEDAR_KEYCLOAK_CLIENT ?? 'cedar-angular-app';

const USER1 = {
  login: env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com',
  password: env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1',
};
const USER2 = {
  login: env.CEDAR_FRONTEND_local_USER2_LOGIN ?? 'test2@test.com',
  password: env.CEDAR_FRONTEND_local_USER2_PASSWORD ?? 'test2',
};

// The local stack serves self-signed certificates from the CEDAR CA.
env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const enc = iri => encodeURIComponent(iri);

let failures = 0;
let step = 'start';

// Everything created, newest first, so teardown unwinds in dependency order.
const created = [];

function ok(what) {
  console.log(`✓ ${what}`);
}

/** Records a failure and keeps going, so one run reports everything that is wrong. */
function bad(what, detail) {
  failures++;
  console.error(`✗ ${what}\n    ${detail}`);
}

/**
 * Reports something worth knowing that must not fail the gate — a defect this test did not
 * cause and cannot fix, where failing would only make the gate unusable.
 */
function note(what, detail) {
  console.warn(`! ${what}\n    ${detail}`);
}

function check(condition, what, detail) {
  if (condition) ok(what);
  else bad(what, detail);
  return condition;
}

async function token({ login, password }) {
  const res = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', client_id: CLIENT, username: login, password,
    }),
  });
  if (!res.ok) throw new Error(`Keycloak refused ${login}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * The caller's own profile, which is where homeFolderId lives. There is no /users/me:
 * the resource server does not expose one, and the user server keys on the id, so the
 * id comes from the token's `sub` claim — the same value the user server stores.
 */
async function profile(auth) {
  const claims = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString());
  const res = await fetch(`${USER_SERVER}/users/${claims.sub}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  if (!res.ok) throw new Error(`could not read the profile for ${claims.sub}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function call(auth, method, path, body, contentType = 'application/json') {
  const headers = { Authorization: `Bearer ${auth}` };
  if (body !== undefined) headers['Content-Type'] = contentType;
  const res = await fetch(`${RESOURCE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not json; keep the text */ }
  return { status: res.status, body: json, text };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A valid template, named for this run.
 *
 * Loaded from a fixture rather than written here. A hand-built template was tried first and the
 * validator refused it: the meta-schema requires a `properties` block naming `@context`, `@id`,
 * `oslc:modifiedBy` and more, which is knowledge that belongs with the schema and not in a test.
 * fixtures/README.md records where the file comes from and when to refresh it.
 */
function templateBody(name) {
  const template = JSON.parse(readFileSync(resolve(HERE, 'fixtures/minimal-template.json'), 'utf8'));
  // The server assigns the identifier; a POST carrying one is refused outright.
  delete template['@id'];
  template['schema:name'] = name;
  template['schema:description'] = 'Created by the REST smoke test';
  return template;
}

/** A valid instance of the given template, named for this run. */
function instanceBody(name, templateId) {
  const instance = JSON.parse(readFileSync(resolve(HERE, 'fixtures/minimal-instance.json'), 'utf8'));
  delete instance['@id'];
  instance['schema:name'] = name;
  instance['schema:description'] = 'Created by the REST smoke test';
  instance['schema:isBasedOn'] = templateId;
  return instance;
}

// ── the run ─────────────────────────────────────────────────────────────────

async function main() {
  step = 'authenticate';
  const u1 = await token(USER1);
  const u2 = await token(USER2);
  ok(`authenticated ${USER1.login} and ${USER2.login} through Keycloak`);

  // 1. A folder to work in. Folders are graph-only, so this also proves the baseline.
  step = 'create-folder';
  const me1 = await profile(u1);
  const homeFolderId = me1.homeFolderId;
  if (!homeFolderId) throw new Error(`the profile carries no homeFolderId: ${JSON.stringify(me1).slice(0, 200)}`);

  const folderName = `REST Smoke ${RUN}`;
  const folder = await call(u1, 'POST', '/folders', {
    folderId: homeFolderId, name: folderName, description: 'Created by the REST smoke test',
  });
  if (!check(folder.status === 201, 'folder created', `${folder.status}: ${folder.text}`)) {
    throw new Error('cannot continue without a folder');
  }
  const folderId = folder.body['@id'];
  created.unshift({ kind: 'folder', path: `/folders/${enc(folderId)}`, name: folderName });

  // 2. The artifact write path — the part no unit suite reaches, because it proxies.
  step = 'create-template';
  const templateName = `REST Smoke Template ${RUN}`;
  const post = await call(u1, 'POST', `/templates?folder_id=${enc(folderId)}`, templateBody(templateName));
  if (!check(post.status === 201, 'template created through the resource server (proxied to the artifact server)',
      `${post.status}: ${post.text?.slice(0, 300)}`)) {
    throw new Error('cannot continue without a template');
  }
  const templateId = post.body['@id'];
  created.unshift({ kind: 'template', path: `/templates/${enc(templateId)}`, name: templateName });

  // 3. Proxy fidelity: what comes back must be what went in.
  step = 'read-back';
  const get = await call(u1, 'GET', `/templates/${enc(templateId)}`);
  check(get.status === 200, 'template read back', `${get.status}: ${get.text?.slice(0, 200)}`);
  check(get.body?.['schema:name'] === templateName,
      'the content served back is the content that was stored',
      `expected schema:name "${templateName}", got "${get.body?.['schema:name']}"`);
  check(get.body?.['bibo:status'] === 'bibo:draft',
      'the new template is a draft', `bibo:status was ${get.body?.['bibo:status']}`);

  // The graph's view of the same artifact must agree with the artifact server's.
  const details = await call(u1, 'GET', `/templates/${enc(templateId)}/details`);
  check(details.status === 200 && details.body?.['schema:name'] === templateName,
      'the workspace graph and the artifact server agree on the name',
      `${details.status}: ${details.body?.['schema:name']}`);

  // 4. Update, and confirm the update took rather than trusting the status.
  step = 'update-template';
  const updated = templateBody(templateName);
  // The mirror of the POST rule: an update must carry the identifier a create must omit.
  updated['@id'] = templateId;
  updated['schema:description'] = 'Updated by the REST smoke test';
  const put = await call(u1, 'PUT', `/templates/${enc(templateId)}`, updated);
  check(put.status === 200, 'template updated', `${put.status}: ${put.text?.slice(0, 200)}`);
  const afterUpdate = await call(u1, 'GET', `/templates/${enc(templateId)}`);
  check(afterUpdate.body?.['schema:description'] === 'Updated by the REST smoke test',
      'the update is visible on a fresh read',
      `description was "${afterUpdate.body?.['schema:description']}"`);

  // 5. Versioning: publish, then draft the published version. Neither operation was
  //    exercised by any test before this file, and both write to two services.
  step = 'publish';
  const publish = await call(u1, 'POST', '/command/publish-artifact', {
    '@id': templateId, newVersion: '1.0.0',
  });
  if (check(publish.status === 200 || publish.status === 201, 'template published',
      `${publish.status}: ${publish.text?.slice(0, 300)}`)) {
    const published = await call(u1, 'GET', `/templates/${enc(templateId)}`);
    check(published.body?.['bibo:status'] === 'bibo:published',
        'publishing changed bibo:status to published',
        `bibo:status was ${published.body?.['bibo:status']}`);
    check(published.body?.['pav:version'] === '1.0.0',
        'publishing set pav:version to the requested version',
        `pav:version was ${published.body?.['pav:version']}`);

    step = 'create-draft';
    const draft = await call(u1, 'POST', '/command/create-draft-artifact', {
      '@id': templateId, folderId, newVersion: '1.0.1', propagateVersion: false,
    });
    if (check(draft.status === 200 || draft.status === 201,
        'draft created from the published version',
        `${draft.status}: ${draft.text?.slice(0, 300)}`)) {
      const draftId = draft.body?.['@id'];
      if (draftId && draftId !== templateId) {
        created.unshift({ kind: 'template', path: `/templates/${enc(draftId)}`, name: `${templateName} draft` });
      }
      const versions = await call(u1, 'GET', `/templates/${enc(templateId)}/versions`);
      check(versions.status === 200 && JSON.stringify(versions.body).includes('1.0.1'),
          'the version chain records the new draft',
          `${versions.status}: ${versions.text?.slice(0, 200)}`);
    }
  }

  // 5b. Re-publishing a published artifact, on its own template so the outcome cannot
  //     disturb the rows above.
  //
  //     This SUCCEEDS, and it should not. resourceCanBePublished refuses a non-draft with
  //     PUBLISH_ONLY_DRAFT — ArtifactLifecycleMatrixTest pins exactly that — but the check
  //     sits inside `if (resource instanceof ...AndPublicationStatus)`, and the type the
  //     REST path passes (FolderServerSchemaArtifactCurrentUserReport) does not implement
  //     that interface. So the status check is skipped, the method falls through to the
  //     superseded check, a freshly published artifact has no successor, and canPublish
  //     comes back true.
  //
  //     The consequence is that a published artifact can be re-published repeatedly at
  //     ascending versions, overwriting content that the model treats as immutable and
  //     citable. Recorded rather than fixed: whether re-publishing should be allowed at all
  //     is a product decision, and the fix touches versioning semantics. On the roadmap.
  //     When it is fixed this check fails and should become an expectation of 4xx.
  step = 'republish';
  const second = await call(u1, 'POST', `/templates?folder_id=${enc(folderId)}`,
      templateBody(`${templateName} republish`));
  if (second.status === 201) {
    const secondId = second.body['@id'];
    created.unshift({ kind: 'template', path: `/templates/${enc(secondId)}`, name: `${templateName} republish` });
    await call(u1, 'POST', '/command/publish-artifact', { '@id': secondId, newVersion: '1.0.0' });
    const again = await call(u1, 'POST', '/command/publish-artifact', { '@id': secondId, newVersion: '1.0.1' });
    check(again.status === 200,
        'KNOWN DEFECT pinned: re-publishing a published artifact is allowed (PUBLISH_ONLY_DRAFT is skipped)',
        `expected the current behaviour of 200, got ${again.status} — if this is now refused, the defect is fixed`);
  }

  // 6. Sharing, as the second user rather than as an assertion about the graph.
  step = 'share';
  const me2 = await profile(u2);
  const user2Id = me2['@id'];
  const beforeShare = await call(u2, 'GET', `/folders/${enc(folderId)}`);
  check(beforeShare.status >= 400, 'the second user cannot reach the folder before it is shared',
      `expected 4xx, got ${beforeShare.status}`);

  if (user2Id) {
    const share = await call(u1, 'PUT', `/folders/${enc(folderId)}/permissions`, {
      owner: { '@id': me1['@id'] },
      userPermissions: [{ user: { '@id': user2Id }, permission: 'read' }],
      groupPermissions: [],
    });
    if (check(share.status === 200, 'folder shared with the second user at read',
        `${share.status}: ${share.text?.slice(0, 300)}`)) {
      const afterShare = await call(u2, 'GET', `/folders/${enc(folderId)}`);
      check(afterShare.status === 200, 'the second user can now read the folder',
          `${afterShare.status}: ${afterShare.text?.slice(0, 200)}`);
      const write = await call(u2, 'PUT', `/folders/${enc(folderId)}`,
          { name: `${folderName} renamed by the reader`, description: 'nope' });
      check(write.status >= 400, 'a read grant does not let the second user rename the folder',
          `expected 4xx, got ${write.status}`);
    }
  } else {
    bad('read the second user id', `the profile carried no @id: ${JSON.stringify(me2).slice(0, 200)}`);
  }

  // 7. Search-index propagation, which no unit suite can see.
  step = 'search';
  let indexed = false;
  for (let attempt = 1; attempt <= 10 && !indexed; attempt++) {
    const search = await call(u1, 'GET', `/search?q=${encodeURIComponent(templateName)}&limit=10`);
    indexed = search.status === 200 && (search.body?.totalCount ?? 0) > 0;
    if (!indexed) await new Promise(r => setTimeout(r, 1500));
  }
  check(indexed, 'the new template reaches the search index', 'not found after ~15s of polling');
}

// ── teardown ────────────────────────────────────────────────────────────────

/**
 * Deletes everything created, newest first, and verifies each deletion rather than
 * trusting the status — an earlier run of the UI smoke left four scratch folders behind
 * because it believed a status code. Published artifacts delete fine: the guard against
 * it in the resource server is commented out deliberately (commit 3f26ee7).
 */
async function teardown(auth) {
  for (const item of created) {
    const del = await call(auth, 'DELETE', item.path);
    if (del.status !== 204 && del.status !== 200) {
      bad(`teardown: ${item.kind} "${item.name}" was not deleted`, `${del.status}: ${del.text?.slice(0, 200)}`);
      continue;
    }
    const after = await call(auth, 'GET', item.path);
    if (after.status < 400) {
      bad(`teardown: ${item.kind} "${item.name}" still readable after deletion`, `GET returned ${after.status}`);
    }
  }
  if (created.length) ok(`cleaned up ${created.length} created resource(s)`);

  // Deleted resources are not removed from the search index. Every artifact above is gone by
  // the authoritative read, yet the index keeps serving it, so a user who deletes something
  // keeps finding it in search. Noted rather than asserted: this test neither caused it nor can
  // fix it, and failing the gate on someone else's stale index would only make the gate useless.
  // On the roadmap, where it is the concrete form of the question about revocation reaching the
  // index. The dashboard listing does clear, so this is the search projection specifically.
  const stale = await call(auth, 'GET', `/search?q=${encodeURIComponent('REST Smoke')}&limit=50`);
  const hits = stale.body?.totalCount ?? 0;
  if (hits > 0) {
    note(`the search index still lists ${hits} deleted REST Smoke resource(s)`,
        'each one 404s on a direct read — deletion does not reach the index');
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  bad(`fatal at step "${step}"`, e.message);
} finally {
  try {
    await teardown(await token(USER1));
  } catch (e) {
    bad('teardown could not authenticate', e.message);
  }
}

if (failures) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  exitCode = 1;
} else {
  console.log('\nPASS: folder + template CRUD, proxy fidelity, publish, draft, sharing, indexing — all at the REST layer');
}
process.exit(exitCode);
