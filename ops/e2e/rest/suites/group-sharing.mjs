// Sharing through a group, and sharing with everybody.
//
// These are the two indirect routes to access, and they are not the same thing. A grant to a group
// reaches whoever is in the group, so access follows membership and changes when membership changes.
// A grant to the everybody group reaches every account in the installation — but still only accounts:
// it is not public access, and this suite pins that difference, because the two are easy to conflate
// and only one of them is safe for unpublished work. Anonymous access is openness, covered separately.
import { suite, check, checkStatus, call, group, mutate, mutateGroup, cleanup, everybodyGroup, enc,
  RUN, GROUP_SERVER } from '../lib.mjs';

export const name = 'group-sharing';

/** A permissions request. The owner is mandatory; a request without one is refused outright. */
function permissions(ownerId, { users = [], groups = [] } = {}) {
  return {
    owner: { '@id': ownerId },
    userPermissions: users.map(([id, permission]) => ({ user: { '@id': id }, permission })),
    groupPermissions: groups.map(([id, permission]) => ({ group: { '@id': id }, permission })),
  };
}

export async function run({ user1, user2, homeFolderId }) {
  const u1 = user1.profile['@id'];
  const u2 = user2.profile['@id'];

  /** A folder owned by the first user, registered for teardown. */
  async function folder(label) {
    const name = `${label} ${RUN}`;
    const made = await call(user1.auth, 'POST', '/folders',
        { folderId: homeFolderId, name, description: 'Created by the REST suites' });
    if (made.status !== 201) return null;
    cleanup('folder', `/folders/${enc(made.body['@id'])}`, name);
    return { id: made.body['@id'], at: `/folders/${enc(made.body['@id'])}`, name };
  }

  const rename = (auth, at, name) =>
      mutate(auth, 'PUT', at, { 'schema:name': name, 'schema:description': 'write attempt by the REST suites' });

  suite('group sharing: a grant to a group reaches its members');

  const shared = await folder('Group Shared');
  const groupName = `REST Sharing Group ${RUN}`;
  const made = await group(user1.auth, 'POST', '/groups',
      { 'schema:name': groupName, 'schema:description': 'Created by the REST suites' });

  if (checkStatus(made, 201, 'a group is created to share through') && shared) {
    const gid = made.body['@id'];
    const groupAt = `/groups/${enc(gid)}`;
    cleanup('group', groupAt, groupName, user1.auth, GROUP_SERVER);

    const roster = (...entries) =>
        mutateGroup(user1.auth, 'PUT', `${groupAt}/users`,
            { users: entries.map(([id, administrator, member]) => ({ user: { '@id': id }, administrator, member })) });

    checkStatus(await roster([u1, true, true], [u2, false, true]), 200,
        'the second user is a member of it');
    check((await call(user2.auth, 'GET', shared.at)).status >= 400,
        'and still cannot reach the folder, since the group has no grant yet',
        'the folder was readable before any grant existed');

    // Read through the group.
    if (checkStatus(await mutate(user1.auth, 'PUT', `${shared.at}/permissions`,
        permissions(u1, { groups: [[gid, 'read']] })), 200, 'the folder is shared with the group as read')) {
      checkStatus(await call(user2.auth, 'GET', shared.at), 200, 'the member can now read it');
      check((await rename(user2.auth, shared.at, `${shared.name} renamed by a group reader`)).status >= 400,
          'and cannot write it', 'a group read grant allowed a write');
    }

    // Raised to write through the same group.
    if (checkStatus(await mutate(user1.auth, 'PUT', `${shared.at}/permissions`,
        permissions(u1, { groups: [[gid, 'write']] })), 200, 'the grant is raised to write')) {
      checkStatus(await rename(user2.auth, shared.at, `${shared.name} renamed by a group writer`), 200,
          'and the member can now write it');
    }

    // Access follows membership: dropping the member must drop the access, with the grant untouched.
    if (checkStatus(await roster([u1, true, true]), 200, 'the member is removed from the group')) {
      check((await call(user2.auth, 'GET', shared.at)).status >= 400,
          'and loses access to the folder, though the group still holds the grant',
          'the folder stayed readable after the user left the group');
    }

    // And returns when they rejoin, which proves the loss above was the membership and not the grant.
    if (checkStatus(await roster([u1, true, true], [u2, false, true]), 200, 'the user rejoins the group')) {
      checkStatus(await call(user2.auth, 'GET', shared.at), 200, 'and has access again');
    }

    // The grant is recorded against the group, not silently expanded into per-user grants.
    const acl = await call(user1.auth, 'GET', `${shared.at}/permissions`);
    const groupGrants = acl.body?.groupPermissions ?? [];
    check(groupGrants.length === 1 && groupGrants[0]?.group?.['@id'] === gid,
        'the ACL records the grant against the group itself',
        `the ACL held ${JSON.stringify(groupGrants).slice(0, 200)}`);
    check((acl.body?.userPermissions ?? []).length === 0,
        'and holds no per-user grant for the member',
        `it held ${JSON.stringify(acl.body?.userPermissions).slice(0, 200)}`);
  }

  suite('group sharing: sharing with everybody');

  const everybody = await everybodyGroup(user1.auth);
  const eid = everybody['@id'];
  const open = await folder('Everybody Shared');

  if (open) {
    check((await call(user2.auth, 'GET', open.at)).status >= 400,
        'the second user cannot reach the folder to begin with',
        'it was readable before being shared');

    if (checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`,
        permissions(u1, { groups: [[eid, 'read']] })), 200, 'the folder is shared with everybody as read')) {
      // The second user was never named, and belongs to no group created here.
      checkStatus(await call(user2.auth, 'GET', open.at), 200,
          'another user can read it without ever being named');
      check((await rename(user2.auth, open.at, `${open.name} renamed by everybody`)).status >= 400,
          'and cannot write it', 'sharing with everybody as read allowed a write');

      // The distinction that matters: everybody means every account, not the public. Without a
      // credential this must still be refused — openness is a different mechanism entirely.
      const anonymous = await call(null, 'GET', open.at);
      check(anonymous.status === 401,
          'but an anonymous caller is still refused: everybody means every account, not the public',
          `expected 401 without a credential, got ${anonymous.status}`);
    }

    if (checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`,
        permissions(u1, { groups: [[eid, 'write']] })), 200, 'the grant to everybody is raised to write')) {
      checkStatus(await rename(user2.auth, open.at, `${open.name} renamed by an everybody writer`), 200,
          'and any account can now write it');
    }

    if (checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`, permissions(u1)), 200,
        'the grant to everybody is withdrawn')) {
      check((await call(user2.auth, 'GET', open.at)).status >= 400,
          'and the other user loses access again',
          'the folder stayed readable after the everybody grant was withdrawn');
    }
  }

  return { everybodyId: eid };
}
