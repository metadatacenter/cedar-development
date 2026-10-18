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

/** A permissions request that explicitly preserves the owner. */
function permissions(ownerId, { users = [], groups = [] } = {}) {
  return {
    owner: { '@id': ownerId },
    userPermissions: users.map(([id, role]) => ({ user: { '@id': id }, role })),
    groupPermissions: groups.map(([id, role]) => ({ group: { '@id': id }, role })),
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
    checkStatus(await call(user2.auth, 'GET', shared.at), 403,
        'and still cannot reach the folder, since the group has no grant yet');

    // Read through the group.
    if (checkStatus(await mutate(user1.auth, 'PUT', `${shared.at}/permissions`,
        permissions(u1, { groups: [[gid, 'viewer']] })), 200, 'the folder is shared with the group as Viewer')) {
      checkStatus(await call(user2.auth, 'GET', shared.at), 200, 'the member can now read it');
      checkStatus(await rename(user2.auth, shared.at, `${shared.name} renamed by a group reader`), 403,
          'and cannot edit it');
    }

    // Raised to Manager through the same group.
    if (checkStatus(await mutate(user1.auth, 'PUT', `${shared.at}/permissions`,
        permissions(u1, { groups: [[gid, 'manager']] })), 200, 'the grant is raised to Manager')) {
      checkStatus(await rename(user2.auth, shared.at, `${shared.name} renamed by a group writer`), 200,
          'and the member can now edit it');
    }

    // Access follows membership: dropping the member must drop the access, with the grant untouched.
    if (checkStatus(await roster([u1, true, true]), 200, 'the member is removed from the group')) {
      checkStatus(await call(user2.auth, 'GET', shared.at), 403,
          'and loses access to the folder, though the group still holds the grant');
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

  suite('group sharing: overlapping grants retain only the remaining authority');

  async function memberGroup(label) {
    const groupName = `${label} ${RUN}`;
    const made = await group(user1.auth, 'POST', '/groups',
        { 'schema:name': groupName, 'schema:description': 'Overlapping grants in the REST suites' });
    if (!checkStatus(made, 201, `${label}: group created`)) return null;
    const id = made.body['@id'];
    const at = `/groups/${enc(id)}`;
    cleanup('group', at, groupName, user1.auth, GROUP_SERVER);
    if (!checkStatus(await mutateGroup(user1.auth, 'PUT', `${at}/users`, {
      users: [[u1, true], [u2, false]].map(([id, administrator]) =>
        ({ user: { '@id': id }, administrator, member: true })),
    }), 200, `${label}: the grantee joins the group`)) return null;
    return { id, at };
  }

  const stronger = await memberGroup('Overlap Editor');
  const weaker = await memberGroup('Overlap Viewer');
  if (stronger && weaker) {
    for (const source of ['direct', 'group']) {
      const target = await folder(`Overlap ${source}`);
      if (!check(!!target, `${source}: folder created for overlapping grants`, 'folder creation failed')) continue;
      const remaining = source === 'direct' ? { users: [[u2, 'viewer']] } : { groups: [[weaker.id, 'viewer']] };
      const overlapping = { ...remaining, groups: [...(remaining.groups ?? []), [stronger.id, 'editor']] };
      if (!checkStatus(await mutate(user1.auth, 'PUT', `${target.at}/permissions`, permissions(u1, overlapping)),
          200, `${source}: Viewer and group Editor are granted together`)) continue;
      const opened = await call(user2.auth, 'GET', target.at);
      const etag = opened.headers?.get('etag');
      if (!check(opened.status === 200 && !!etag, `${source}: the grantee reads a revision to edit`,
          `HTTP ${opened.status}, ETag ${etag}`)) continue;
      const changedName = `${target.name} edited`;
      checkStatus(await call(user2.auth, 'PUT', target.at,
          { 'schema:name': changedName, 'schema:description': 'Editor wins over Viewer' },
          { headers: { 'If-Match': etag } }), 200, `${source}: the stronger group grant permits a write`);
      check((await call(user1.auth, 'GET', target.at)).body?.['schema:name'] === changedName,
          `${source}: the permitted write is stored`, 'the rename was not stored');

      const removed = source === 'direct'
        ? await mutate(user1.auth, 'PUT', `${target.at}/permissions`, permissions(u1, remaining))
        : await mutateGroup(user1.auth, 'DELETE', stronger.at);
      if (!checkStatus(removed, source === 'direct' ? 200 : 204,
          `${source}: ${source === 'direct' ? 'the stronger grant is removed' : 'the stronger group is deleted'}`)) continue;

      // No convergence wait: graph authorization must immediately reflect the remaining Viewer.
      const reader = await call(user2.auth, 'GET', target.at);
      const readerTag = reader.headers?.get('etag');
      if (!check(reader.status === 200 && !!readerTag, `${source}: the remaining Viewer still reads immediately`,
          `HTTP ${reader.status}, ETag ${readerTag}`)) continue;
      const before = await call(user1.auth, 'GET', target.at);
      checkStatus(await call(user2.auth, 'PUT', target.at,
          { 'schema:name': `${target.name} forbidden`, 'schema:description': 'must not be stored' },
          { headers: { 'If-Match': readerTag } }), 403, `${source}: the remaining Viewer cannot write immediately`);
      const after = await call(user1.auth, 'GET', target.at);
      check(before.status === 200 && after.status === 200 &&
          after.body?.['schema:name'] === before.body?.['schema:name'] &&
          after.body?.['schema:description'] === before.body?.['schema:description'] &&
          after.headers?.get('etag') === before.headers?.get('etag'),
      `${source}: the refused write preserves the stored content and revision`, 'content or revision changed');
    }
  }

  suite('group sharing: sharing with everybody');

  const everybody = await everybodyGroup(user1.auth);
  const eid = everybody['@id'];
  const open = await folder('Everybody Shared');

  if (open) {
    checkStatus(await call(user2.auth, 'GET', open.at), 403,
        'the second user cannot reach the folder to begin with');

    if (checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`,
        permissions(u1, { groups: [[eid, 'viewer']] })), 200, 'the folder is shared with Everyone as Viewer')) {
      // The second user was never named, and belongs to no group created here.
      checkStatus(await call(user2.auth, 'GET', open.at), 200,
          'another user can read it without ever being named');
      checkStatus(await rename(user2.auth, open.at, `${open.name} renamed by everybody`), 403,
          'and cannot edit it');

      // The distinction that matters: everybody means every account, not the public. Without a
      // credential this must still be refused — openness is a different mechanism entirely.
      const anonymous = await call(null, 'GET', open.at);
      check(anonymous.status === 401,
          'but an anonymous caller is still refused: everybody means every account, not the public',
          `expected 401 without a credential, got ${anonymous.status}`);
    }

    checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`,
        permissions(u1, { groups: [[eid, 'manager']] })), 400,
        'the Everyone group cannot be granted Manager');
    checkStatus(await rename(user2.auth, open.at, `${open.name} renamed after a refused Manager grant`), 403,
        'the refused Manager grant leaves every account as Viewer');

    if (checkStatus(await mutate(user1.auth, 'PUT', `${open.at}/permissions`, permissions(u1)), 200,
        'the grant to everybody is withdrawn')) {
      checkStatus(await call(user2.auth, 'GET', open.at), 403,
          'and the other user loses access again');
    }
  }

  return { everybodyId: eid };
}
