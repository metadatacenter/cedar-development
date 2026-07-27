// Sharing over HTTP, as two real users. The permission matrices in the Java suites assert what a
// grant confers; this asserts that asking for it over the API produces exactly that grant.
import { suite, check, checkStatus, call, cleanup, enc, RUN } from '../lib.mjs';

export const name = 'sharing';

export async function run({ user1, user2, homeFolderId }) {
  suite('sharing: a grant produces exactly the level asked for');

  const results = {};
  for (const level of ['read', 'write']) {
    const folderName = `Shared ${level} ${RUN}`;
    const made = await call(user1.auth, 'POST', '/folders',
        { folderId: homeFolderId, name: folderName, description: 'Created by the REST suites' });
    if (!checkStatus(made, 201, `${level}: folder created to share`)) continue;
    const id = made.body['@id'];
    const at = `/folders/${enc(id)}`;
    cleanup('folder', at, folderName);

    const before = await call(user2.auth, 'GET', at);
    check(before.status >= 400, `${level}: the second user cannot reach it before sharing`,
        `expected 4xx, got ${before.status}`);

    const share = await call(user1.auth, 'PUT', `${at}/permissions`, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user2.profile['@id'] }, permission: level }],
      groupPermissions: [],
    });
    if (!checkStatus(share, 200, `${level}: shared with the second user`)) continue;

    // What the API says it did.
    const acl = await call(user1.auth, 'GET', `${at}/permissions`);
    const grants = acl.body?.userPermissions ?? [];
    check(grants.length === 1 && grants[0]?.permission === level,
        `${level}: the ACL records exactly that level`,
        `ACL held ${JSON.stringify(grants).slice(0, 200)}`);

    // What the second user can actually do. The negative half is the point: asserting only that a
    // reader can read would pass just as well if read had quietly become write.
    checkStatus(await call(user2.auth, 'GET', at), 200, `${level}: the second user can read it`);
    const write = await call(user2.auth, 'PUT', at,
        { 'schema:name': `${folderName} renamed by the grantee`, 'schema:description': 'attempt' });
    if (level === 'read') {
      check(write.status >= 400, 'read: the grantee cannot rename it',
          `expected 4xx, got ${write.status}`);
    } else {
      check(write.status === 200, 'write: the grantee can rename it',
          `expected 200, got ${write.status}`);
    }
    results[level] = id;
  }

  suite('sharing: the requests the validator must refuse');

  const folderName = `Share Rejections ${RUN}`;
  const made = await call(user1.auth, 'POST', '/folders',
      { folderId: homeFolderId, name: folderName, description: 'Created by the REST suites' });
  if (checkStatus(made, 201, 'folder created for the rejection cases')) {
    const at = `/folders/${enc(made.body['@id'])}/permissions`;
    cleanup('folder', `/folders/${enc(made.body['@id'])}`, folderName);

    checkStatus(await call(user1.auth, 'PUT', at,
        { userPermissions: [], groupPermissions: [] }), 400,
        'a permissions request without an owner is refused');

    checkStatus(await call(user1.auth, 'PUT', at, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [
        { user: { '@id': user2.profile['@id'] }, permission: 'read' },
        { user: { '@id': user2.profile['@id'] }, permission: 'write' },
      ],
      groupPermissions: [],
    }), 400, 'naming one user twice is refused');

    checkStatus(await call(user1.auth, 'PUT', at, {
      owner: { '@id': user1.profile['@id'] },
      userPermissions: [{ user: { '@id': user1.profile['@id'] }, permission: 'read' }],
      groupPermissions: [],
    }), 400, 'listing the owner as a grantee is refused');
  }

  return results;
}
