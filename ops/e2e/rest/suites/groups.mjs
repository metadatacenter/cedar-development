// Groups over HTTP: their lifecycle, their membership, and who is allowed to change either.
//
// Groups live on the group server rather than the resource server, and they are the vehicle for two
// distinct things — sharing with a named set of people, and sharing with everybody. This suite covers
// the groups themselves; group-sharing covers what a grant to one confers.
import { suite, check, checkStatus, group, mutateGroup, cleanup, everybodyGroup, enc, RUN,
  GROUP_SERVER } from '../lib.mjs';

export const name = 'groups';

/** The membership body is a full replacement, so every call must re-state everyone who stays. */
function members(...entries) {
  return { users: entries.map(([id, administrator, member]) => ({ user: { '@id': id }, administrator, member })) };
}

export async function run({ user1, user2 }) {
  const u1 = user1.profile['@id'];
  const u2 = user2.profile['@id'];

  // PATCH /groups/{id} is a JSON merge patch — a partial update carried with its own media type. It is
  // a distinct write path from PUT with the same administrator gate, so it gets the same checks.
  const patch = (auth, path, body) =>
      mutateGroup(auth, 'PATCH', path, body, { contentType: 'application/merge-patch+json' });

  suite('groups: lifecycle');

  const groupName = `REST Group ${RUN}`;
  const made = await group(user1.auth, 'POST', '/groups',
      { 'schema:name': groupName, 'schema:description': 'Created by the REST suites' });
  if (!checkStatus(made, 201, 'a group is created')) return {};
  const id = made.body['@id'];
  const at = `/groups/${enc(id)}`;
  cleanup('group', at, groupName, user1.auth, GROUP_SERVER);

  check(made.body['schema:name'] === groupName, 'it comes back under the name asked for',
      `it was named ${made.body['schema:name']}`);
  check(made.body.specialGroup === null, 'and carries no special marker',
      `specialGroup was ${JSON.stringify(made.body.specialGroup)}`);

  checkStatus(await group(user1.auth, 'GET', at), 200, 'it can be read back by id');

  const listed = await group(user1.auth, 'GET', '/groups');
  check((listed.body?.groups ?? []).some(g => g['@id'] === id), 'and appears in the listing',
      `the listing held ${(listed.body?.groups ?? []).length} group(s), not including it`);

  // The creator administers what they created. Without this, nobody could ever manage the group.
  const owners = await group(user1.auth, 'GET', `${at}/users`);
  const creator = (owners.body?.users ?? []).find(u => u.user?.['@id'] === u1);
  check(creator?.administrator === true && creator?.member === true,
      'the creator is both administrator and member',
      `the creator record was ${JSON.stringify(creator)}`);

  const renamed = `${groupName} renamed`;
  const rename = await mutateGroup(user1.auth, 'PUT', at,
      { 'schema:name': renamed, 'schema:description': 'Renamed by the REST suites' });
  if (checkStatus(rename, 200, 'the administrator can rename it')) {
    const after = await group(user1.auth, 'GET', at);
    check(after.body?.['schema:name'] === renamed, 'and the new name sticks',
        `it read back as ${after.body?.['schema:name']}`);
  }

  // A JSON merge patch by an administrator — touching only the description — must work (the patch path
  // carries its own admin gate, added alongside PUT's) and must leave the name untouched, which is the
  // point of a partial update. The name is deliberately not patched here: later cases depend on it.
  const patchedDesc = `Patched by the REST suites ${RUN}`;
  const patched = await patch(user1.auth, at, { 'schema:description': patchedDesc });
  if (checkStatus(patched, 200, 'the administrator can update it by merge-patch')) {
    const after = await group(user1.auth, 'GET', at);
    check(after.body?.['schema:description'] === patchedDesc, 'and the patched description sticks',
        `description read back as ${after.body?.['schema:description']}`);
    check(after.body?.['schema:name'] === renamed, 'while the untouched name is left as it was',
        `name read back as ${after.body?.['schema:name']}`);
  }

  suite('groups: the requests the validator must refuse');

  checkStatus(await group(user1.auth, 'POST', '/groups', { 'schema:description': 'no name' }), 400,
      'creating a group with no name is refused');

  const duplicate = await group(user1.auth, 'POST', '/groups',
      { 'schema:name': renamed, 'schema:description': 'a second group under a taken name' });
  checkStatus(duplicate, 409, 'a duplicate group name is refused as a conflict');
  if (duplicate.status === 201) cleanup('group', `/groups/${enc(duplicate.body['@id'])}`, renamed, user1.auth, GROUP_SERVER);

  checkStatus(await group(user1.auth, 'GET', `/groups/${enc('https://repo.metadatacenter.orgx/groups/nope')}`),
      404, 'reading a group that does not exist answers 404');

  suite('groups: everybody is a group, and a protected one');

  const everybody = await everybodyGroup(user1.auth);
  const all = await group(user1.auth, 'GET', '/groups');
  const marked = (all.body?.groups ?? []).filter(g => g.specialGroup === 'EVERYBODY');
  check(marked.length === 1, 'exactly one group carries the EVERYBODY marker',
      `${marked.length} groups carry it`);

  const everybodyAt = `/groups/${enc(everybody['@id'])}`;
  checkStatus(await mutateGroup(user1.auth, 'DELETE', everybodyAt), 400,
      'the everybody group cannot be deleted');
  checkStatus(await group(user1.auth, 'GET', everybodyAt), 200, 'and it is still there afterwards');

  // Renaming it is refused for the same structural reason as deletion: the update path rejects any
  // special group before it ever reaches an administrator check, so no one — administrator or not —
  // can rename it. The rename is still undone at once should it ever succeed, since the everybody
  // group is part of the installation and a test that left it renamed would have damaged the instance.
  const originalName = everybody['schema:name'];
  const touch = await mutateGroup(user1.auth, 'PUT', everybodyAt,
      { 'schema:name': `${originalName} touched by the REST suites`, 'schema:description': everybody['schema:description'] });
  if (touch.status === 200) {
    await mutateGroup(user1.auth, 'PUT', everybodyAt,
        { 'schema:name': originalName, 'schema:description': everybody['schema:description'] });
  }
  check(touch.status >= 400, 'and it cannot be renamed either',
      `expected 4xx, got ${touch.status} — if 200, the everybody group was just renamed and restored`);

  suite('groups: membership, and who may change it');

  const add = await mutateGroup(user1.auth, 'PUT', `${at}/users`, members([u1, true, true], [u2, false, true]));
  if (checkStatus(add, 200, 'the administrator adds the second user as a member')) {
    const roster = (add.body?.users ?? []);
    const second = roster.find(u => u.user?.['@id'] === u2);
    check(roster.length === 2, 'the group now holds two people', `it holds ${roster.length}`);
    check(second?.member === true && second?.administrator === false,
        'the second user is a member and not an administrator',
        `their record was ${JSON.stringify(second)}`);
  }

  // Reading a group is open to any logged-in user by design: you cannot choose a group to share with
  // unless you can see that it exists. Only writes are restricted to administrators.
  checkStatus(await group(user2.auth, 'GET', at), 200, 'a member can read the group');

  // A member is not an administrator, so a member cannot change the group. Each of these would be a
  // privilege escalation if it succeeded.
  checkStatus(await mutateGroup(user2.auth, 'PUT', at,
      { 'schema:name': `${renamed} by a member`, 'schema:description': 'attempt' }), 403,
      'a member cannot rename the group');
  checkStatus(await patch(user2.auth, at, { 'schema:name': `${renamed} by a member via patch` }), 403,
      'and cannot rename it by merge-patch either');
  checkStatus(await mutateGroup(user2.auth, 'PUT', `${at}/users`,
      members([u1, true, true], [u2, true, true]), { etagAuth: user1.auth }), 403,
      'and cannot make themselves an administrator');
  checkStatus(await mutateGroup(user2.auth, 'DELETE', at), 403, 'and cannot delete it');

  // Promotion, then the same rename by the promoted user, which is what proves the group is writable
  // by an administrator at all — without it the refusals above would pass on an unwritable group.
  const promote = await mutateGroup(user1.auth, 'PUT', `${at}/users`, members([u1, true, true], [u2, true, true]));
  if (checkStatus(promote, 200, 'the administrator promotes the second user')) {
    checkStatus(await mutateGroup(user2.auth, 'PUT', at,
        { 'schema:name': renamed, 'schema:description': 'renamed by the promoted administrator' }), 200,
        'and now that user can rename it');
  }

  const shrink = await mutateGroup(user1.auth, 'PUT', `${at}/users`, members([u1, true, true]));
  if (checkStatus(shrink, 200, 'the second user is removed from the group')) {
    check((shrink.body?.users ?? []).length === 1, 'one person is left',
        `${(shrink.body?.users ?? []).length} are left`);
  }

  suite('groups: an outsider cannot write a group they do not administer');

  // A group nobody but its creator has anything to do with, so what the second user manages to do to
  // it is unambiguous. The escalation this pins used to succeed: every user was given the
  // groupAdministrator role, which carried UPDATE_NOT_ADMINISTERED_GROUP — the override that skips the
  // "only administrators may change this group" check — so anyone could rename, re-staff or delete
  // anyone's group. The override now lives in a separate privileged role held only by the built-in
  // admin, so an ordinary outsider is refused.
  const targetName = `REST Group Outsider Target ${RUN}`;
  const target = await group(user1.auth, 'POST', '/groups',
      { 'schema:name': targetName, 'schema:description': 'The second user is not a member of this group' });
  if (checkStatus(target, 201, 'a group is created that the second user has no part in')) {
    const targetAt = `/groups/${enc(target.body['@id'])}`;
    cleanup('group', targetAt, targetName, user1.auth, GROUP_SERVER);
    const roster = await group(user1.auth, 'GET', `${targetAt}/users`);
    check(!(roster.body?.users ?? []).some(u => u.user?.['@id'] === u2),
        'the second user is confirmed absent from it',
        `the roster was ${JSON.stringify((roster.body?.users ?? []).map(u => u.user?.email))}`);

    checkStatus(await mutateGroup(user2.auth, 'PUT', targetAt,
        { 'schema:name': `${targetName} hijacked`, 'schema:description': 'renamed by an outsider' }), 403,
        'an outsider cannot rename a group they do not administer');
    checkStatus(await patch(user2.auth, targetAt, { 'schema:name': `${targetName} hijacked via patch` }), 403,
        'and cannot rename it by merge-patch either');
    checkStatus(await mutateGroup(user2.auth, 'PUT', `${targetAt}/users`, members([u2, true, true]),
        { etagAuth: user1.auth }), 403,
        'and cannot make themselves an administrator of it');
    checkStatus(await mutateGroup(user2.auth, 'DELETE', targetAt), 403,
        'and cannot delete it');
    checkStatus(await group(user1.auth, 'GET', targetAt), 200,
        'and it is untouched afterwards');
  }

  return { groupId: id, groupName: renamed, everybodyId: everybody['@id'] };
}
