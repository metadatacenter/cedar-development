// Sharing over HTTP, as two real users. The permission matrices in the Java suites assert what a
// grant confers; this asserts that asking for it over the API produces exactly that grant.
import { isDeepStrictEqual } from 'node:util';
import { suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, RUN, OPENVIEW } from '../lib.mjs';
import { responseContractProblem } from '../response-contract.mjs';

export const name = 'sharing';

export async function run({ user1, user2, homeFolderId, folderId }) {
  suite('sharing: a grant produces exactly the role asked for');

  // Editor and Manager differ in what Manager alone may do: change the grants, make a resource
  // open, and move it. Each grantee is asked all three, so a Manager grant that confers only
  // Editor authority fails as surely as an Editor who is allowed them. A move needs somewhere the
  // grantee may move into, so the second user holds Editor on this destination throughout.
  const destinationName = `Sharing Move Destination ${RUN}`;
  const destination = await call(user1.auth, 'POST', '/folders',
      { folderId, name: destinationName, description: 'Created by the REST suites' });
  let destinationId;
  if (checkStatus(destination, 201, 'a move destination is created')) {
    destinationId = destination.body['@id'];
    cleanup('folder', `/folders/${enc(destinationId)}`, destinationName);
    checkStatus(await mutate(user1.auth, 'PUT', `/folders/${enc(destinationId)}/permissions`, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user2.profile['@id'] }, role: 'editor' }],
      groupPermissions: [],
    }), 200, 'and the second user may move into it');
  }
  const listedIn = async (parent, id) => {
    const contents = await call(user1.auth, 'GET', `/folders/${enc(parent)}/contents?limit=500`);
    return contents.status === 200
      ? (contents.body?.resources ?? []).some(resource => resource['@id'] === id)
      : undefined;
  };

  const results = {};
  for (const role of ['viewer', 'editor', 'manager']) {
    const folderName = `Shared ${role} ${RUN}`;
    const made = await call(user1.auth, 'POST', '/folders',
        { folderId: homeFolderId, name: folderName, description: 'Created by the REST suites' });
    if (!checkStatus(made, 201, `${role}: folder created to share`)) continue;
    const id = made.body['@id'];
    const at = `/folders/${enc(id)}`;
    cleanup('folder', at, folderName);

    const before = await call(user2.auth, 'GET', at);
    checkStatus(before, 403, `${role}: the second user cannot reach it before sharing`);

    const requestedPermissions = {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user2.profile['@id'] }, role }],
      groupPermissions: [],
    };
    const share = await mutate(user1.auth, 'PUT', `${at}/permissions`, requestedPermissions);
    if (!checkStatus(share, 200, `${role}: shared with the second user`)) continue;
    checkStatus(await mutate(user1.auth, 'PUT', `${at}/permissions`, requestedPermissions), 200,
        `${role}: repeating the same grant is accepted`);

    // What the API says it did. Replacing an ACL with the same document must not duplicate a grant.
    const acl = await call(user1.auth, 'GET', `${at}/permissions`);
    const contractProblem = responseContractProblem('permissions', acl);
    check(!contractProblem, `${role}: the permissions read matches its OpenAPI response schema`, contractProblem);
    const grants = acl.body?.userPermissions ?? [];
    check(grants.length === 1 && grants[0]?.role === role,
        `${role}: the ACL records exactly that role`,
        `ACL held ${JSON.stringify(grants).slice(0, 200)}`);

    // What the second user can actually do. The negative half is the point: asserting only that a
    // Viewer can read would pass just as well if Viewer had quietly become Editor.
    checkStatus(await call(user2.auth, 'GET', at), 200, `${role}: the second user can read it`);
    const write = await mutate(user2.auth, 'PUT', at,
        { 'schema:name': `${folderName} renamed by the grantee`, 'schema:description': 'attempt' });
    if (role === 'viewer') {
      checkStatus(write, 403, 'viewer: the grantee cannot rename it');
    } else {
      check(write.status === 200, `${role}: the grantee can rename it`,
          `expected 200, got ${write.status}`);
      await managerOnly(role, id, at, requestedPermissions);
    }
    results[role] = id;
  }

  // What only a Manager may do, asked of an Editor and a Manager alike. A refusal must also leave
  // the folder as it was, since a refusal answered after the write would otherwise pass.
  async function managerOnly(role, id, at, grant) {
    const allowed = role === 'manager';
    const expected = allowed ? 200 : 403;
    const may = allowed ? 'can' : 'cannot';

    const aclBefore = await call(user1.auth, 'GET', `${at}/permissions`);
    checkStatus(await mutate(user2.auth, 'PUT', `${at}/permissions`, grant), expected,
        `${role}: the grantee ${may} change its grants`);
    const aclAfter = await call(user1.auth, 'GET', `${at}/permissions`);
    check(aclBefore.status === 200 && aclAfter.status === 200
        && isDeepStrictEqual(aclBefore.body, aclAfter.body),
    `${role}: and the grants are still exactly the owner's`,
    `before ${aclBefore.status} ${aclBefore.text?.slice(0, 160)}, after ${aclAfter.status} ${aclAfter.text?.slice(0, 160)}`);

    const opened = await mutate(user2.auth, 'POST', '/command/make-folder-open', { '@id': id }, { etagPath: at });
    checkStatus(opened, expected, `${role}: the grantee ${may} make it open`);
    const anonymous = await call(null, 'GET', at, undefined, { base: OPENVIEW });
    check(anonymous.status === (allowed ? 200 : 401),
        `${role}: and OpenView ${allowed ? 'serves' : 'still refuses'} it anonymously`,
        `OpenView answered ${anonymous.status}`);
    if (allowed && opened.status === 200) {
      checkStatus(await mutate(user2.auth, 'POST', '/command/make-folder-not-open', { '@id': id },
          { etagPath: at }), 200, `${role}: the grantee can close it again`);
    }

    if (!destinationId) return;
    const moved = await mutate(user2.auth, 'POST', '/command/move-resource-to-folder',
        { '@id': id, targetFolderId: destinationId }, { etagPath: at });
    checkStatus(moved, allowed ? [200, 201] : 403, `${role}: the grantee ${may} move it`);
    const inDestination = await listedIn(destinationId, id);
    const inHome = await listedIn(homeFolderId, id);
    check(inDestination === allowed && inHome === !allowed,
        `${role}: and it is ${allowed ? 'in the destination and no longer' : 'still'} in the owner's home`,
        `listed in the destination: ${inDestination}; in the home folder: ${inHome}`);
  }

  suite('sharing: revocation refuses a write with an already acquired content ETag');

  const retainedName = `Revoked Write ${RUN}`;
  const retained = await call(user1.auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', retainedName));
  if (checkStatus(retained, 201, 'a template is created for the retained-ETag write')) {
    const at = `/templates/${enc(retained.body['@id'])}`;
    cleanup('template', at, retainedName);
    const acl = granted => ({ owner: { '@id': user1.profile['@id'] }, groupPermissions: [],
      userPermissions: granted ? [{ user: { '@id': user2.profile['@id'] }, role: 'editor' }] : [] });
    if (checkStatus(await mutate(user1.auth, 'PUT', `${at}/permissions`, acl(true)), 200,
        'the grantee receives Editor access before opening the template')) {
      const opened = await call(user2.auth, 'GET', at);
      const etag = opened.headers?.get('etag');
      if (check(opened.status === 200 && !!etag, 'the grantee holds the template and its content ETag',
          `HTTP ${opened.status}, ETag ${etag}`) &&
          checkStatus(await mutate(user1.auth, 'PUT', `${at}/permissions`, acl(false)), 200,
          'the owner revokes the grant after the template was opened')) {
        const before = await call(user1.auth, 'GET', at);
        const body = { ...opened.body, 'schema:description': 'A write attempted after revocation' };
        // call(), deliberately: mutate() would stop at the now-forbidden preflight GET and never PUT.
        const send = () => call(user2.auth, 'PUT', at, body, { headers: { 'If-Match': etag } });
        checkStatus(await send(), 403, 'the same session cannot PUT with its retained ETag after revocation');
        const after = await call(user1.auth, 'GET', at);
        check(before.status === 200 && after.status === 200 && isDeepStrictEqual(before.body, after.body) &&
            before.headers?.get('etag') === after.headers?.get('etag'),
        'the rejected PUT changes neither stored content nor revision', 'content or revision changed');
        checkStatus(await call(user2.auth, 'GET', at), 403, 'the revoked grantee also loses read access');
        if (checkStatus(await mutate(user1.auth, 'PUT', `${at}/permissions`, acl(true)), 200,
            'the owner restores Editor access')) {
          checkStatus(await send(), 200, 'the unchanged request succeeds after restoration with the original ETag');
          const stored = await call(user1.auth, 'GET', at);
          check(stored.status === 200 && stored.body?.['schema:description'] === body['schema:description'] &&
              !!stored.headers?.get('etag') && stored.headers.get('etag') !== etag,
          'only the authorized retry stores the edit and advances the revision', 'the authorized edit was not stored');
        }
      }
    }
  }

  suite('sharing: permission request validation');

  const folderName = `Share Rejections ${RUN}`;
  const made = await call(user1.auth, 'POST', '/folders',
      { folderId: homeFolderId, name: folderName, description: 'Created by the REST suites' });
  if (checkStatus(made, 201, 'folder created for the rejection cases')) {
    const at = `/folders/${enc(made.body['@id'])}/permissions`;
    cleanup('folder', `/folders/${enc(made.body['@id'])}`, folderName);

    if (checkStatus(await mutate(user1.auth, 'PUT', at,
        { userPermissions: [], groupPermissions: [] }), 200,
        'a permissions request may omit the unchanged owner')) {
      const unchanged = await call(user1.auth, 'GET', at);
      check(unchanged.body?.owner?.['@id'] === user1.profile['@id'],
          'omitting the owner leaves ownership unchanged',
          `owner was ${unchanged.body?.owner?.['@id'] ?? '(missing)'}`);
    }

    checkStatus(await mutate(user1.auth, 'PUT', at, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [
        { user: { '@id': user2.profile['@id'] }, role: 'viewer' },
        { user: { '@id': user2.profile['@id'] }, role: 'manager' },
      ],
      groupPermissions: [],
    }), 400, 'naming one user twice is refused');

    checkStatus(await mutate(user1.auth, 'PUT', at, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user1.profile['@id'] }, role: 'viewer' }],
      groupPermissions: [],
    }), 400, 'listing the owner as a grantee is refused');
  }

  suite('sharing: the user directory a share dialog picks from');

  // GET /users is what the frontend reads to offer people to share with. It is open to any logged-in
  // user by design — you cannot grant to someone you cannot name — and refused outright to an
  // anonymous caller. Assert both, and that the list actually contains the two people the grants above
  // were made between, each usable as a grant target (it carries the @id those requests key on).
  const listed = await call(user1.auth, 'GET', '/users');
  if (checkStatus(listed, 200, 'a logged-in user can list the user directory')) {
    const ids = new Set((listed.body?.users ?? []).map(u => u['@id']));
    check(ids.has(user1.profile['@id']) && ids.has(user2.profile['@id']),
        'the directory holds both test users, keyed by the @id a grant targets',
        `it held ${ids.size} user(s), not including both test users`);
    const sample = (listed.body?.users ?? []).find(u => u['@id'] === user2.profile['@id']);
    check(sample?.email !== undefined || sample?.['schema:name'] !== undefined,
        'and each entry carries something to show a person by (email or name)',
        `the entry was ${JSON.stringify(sample)}`);
  }
  checkStatus(await call(null, 'GET', '/users'), 401, 'an anonymous caller cannot list users');

  return results;
}
