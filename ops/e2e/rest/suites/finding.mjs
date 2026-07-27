// Finding things, and whether what you can find matches what you are allowed to see.
//
// Search has two backends, which is the single most important thing to know here. The sharing views,
// the identifier lookups and the "all" listing are answered from the graph and follow a permission
// change at once. A search by term is answered from the index the worker maintains, reached through a
// queue. So nothing about term search is instantaneous, every assertion about it polls, and a negative
// assertion is only made once the corresponding positive one has been observed — proving something
// cannot be found before it has finished being indexed would prove nothing at all.
//
// Each route to visibility gets its own artifact: a direct grant, a grant to a group, a grant to
// everybody, and a grant on the folder something sits in. Only the grant to everybody reaches term
// search, because it is denormalized onto the node rather than carried in the per-user list; the other
// three are pinned as defects, with the measurements that establish them recorded at each pin.
import { suite, check, checkStatus, call, group, cleanup, artifactBody, poll, enc, RUN, GROUP_SERVER } from '../lib.mjs';

export const name = 'finding';

/** Search terms have to be distinctive, or another run's leftovers answer for this one. */
const STAMP = RUN.replace(/[^0-9]/g, '');

export async function run({ user1, user2, folderId }) {
  const u1 = user1.profile['@id'];
  const u2 = user2.profile['@id'];

  const permissions = (ownerId, { users = [], groups = [] } = {}) => ({
    owner: { '@id': ownerId },
    userPermissions: users.map(([id, permission]) => ({ user: { '@id': id }, permission })),
    groupPermissions: groups.map(([id, permission]) => ({ group: { '@id': id }, permission })),
  });

  /** Does a term search as this user turn up this identifier? */
  async function findsByTerm(auth, tag, id) {
    const res = await call(auth, 'GET', `/search?q=${enc(tag)}&limit=50`);
    return (res.body?.resources ?? []).some(r => r['@id'] === id);
  }

  /**
   * Does one of the sharing views hold this identifier? These views take no search term — passing one
   * turns the request back into an ordinary term search — so the whole view is read and scanned.
   */
  async function inSharingView(auth, sharing, id) {
    const res = await call(auth, 'GET', `/search?sharing=${sharing}&limit=200`);
    return (res.body?.resources ?? []).some(r => r['@id'] === id);
  }

  const until = (probe) => poll(async () => ({ done: await probe() }), { tries: 10, delayMs: 1200 });
  /**
   * A short wait before pinning something as absent. The absences below were measured over two
   * minutes and never resolved, so a long budget here would only make the suite slow; a few seconds
   * is enough to notice if one of them starts working.
   */
  const briefly = (probe) => poll(async () => ({ done: await probe() }), { tries: 3, delayMs: 1200 });

  /** A template in the run's working folder, tagged so only this run finds it. */
  async function template(slug) {
    const tag = `Finding${STAMP}${slug}`;
    const post = await call(user1.auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
        artifactBody('template', `${tag} template`));
    if (post.status !== 201) return null;
    const id = post.body['@id'];
    cleanup('template', `/templates/${enc(id)}`, `${tag} template`);
    return { id, tag, at: `/templates/${enc(id)}` };
  }

  suite('finding: what the owner can find, and what another user cannot');

  const direct = await template('Direct');
  if (!check(!!direct, 'a template is created to find', 'it could not be created')) return {};

  const indexed = await until(() => findsByTerm(user1.auth, direct.tag, direct.id));
  if (!check(indexed.done, 'the owner finds their own template once it is indexed',
      `it never appeared for its owner after ${indexed.attempts} attempts — the rest of this suite would be meaningless`)) return {};

  // Sound only because the line above proved indexing had finished.
  check(!(await findsByTerm(user2.auth, direct.tag, direct.id)),
      'another user does not find it while it is unshared',
      'an unshared template was visible in another user\'s search');

  suite('finding: a direct grant, and the one place it fails to arrive');

  // The two halves of search do not share a backend. The sharing views, the identifier lookups and
  // the "all" listing are answered from the graph, so they follow a grant immediately. A term search
  // — the ordinary search box — is answered from the index, which is where the grant goes missing.
  if (checkStatus(await call(user1.auth, 'PUT', `${direct.at}/permissions`,
      permissions(u1, { users: [[u2, 'read']] })), 200, 'the template is shared with the second user')) {
    checkStatus(await call(user2.auth, 'GET', direct.at), 200, 'who can open it at once');

    const inView = await until(() => inSharingView(user2.auth, 'shared-with-me', direct.id));
    check(inView.done, 'and sees it in what is shared with them',
        `it never appeared in shared-with-me after ${inView.attempts} attempts`);

    check(!(await inSharingView(user1.auth, 'shared-with-me', direct.id)),
        'while the owner does not see their own template as shared with them',
        'the owner\'s own template appeared in their shared-with-me view');

    // A grant never reaches the indexed document's materialized user list, so the term search filter
    // never matches for the grantee. Measured over two minutes, and the indexed document is byte for
    // byte identical before and after the grant, so this is not slow propagation. The effect is that
    // someone you shared with can open the artifact and see it listed under what is shared with them,
    // but searching for it by name finds nothing. On the roadmap.
    const appeared = await briefly(() => findsByTerm(user2.auth, direct.tag, direct.id));
    check(!appeared.done,
        'KNOWN DEFECT pinned: but a search by name does not find it, though every graph-backed view does',
        'the grantee found it by name — the grant now reaches the index and this pin should become a positive assertion');
  }

  // Withdrawal, on the graph side, is immediate. Whether withdrawal reaches the index cannot be
  // tested while the grant itself never gets there.
  if (checkStatus(await call(user1.auth, 'PUT', `${direct.at}/permissions`, permissions(u1)), 200,
      'the grant is withdrawn')) {
    check((await call(user2.auth, 'GET', direct.at)).status >= 400,
        'and the second user loses access to the artifact immediately',
        'the artifact stayed readable after the grant was withdrawn');
    check(!(await inSharingView(user2.auth, 'shared-with-me', direct.id)),
        'and it leaves what is shared with them',
        'it was still listed as shared with them after the grant was withdrawn');
  }

  suite('finding: a grant to a group confers access but not findability');

  const viaGroup = await template('Group');
  const groupName = `REST Finding Group ${RUN}`;
  const made = await group(user1.auth, 'POST', '/groups',
      { 'schema:name': groupName, 'schema:description': 'Created by the REST suites' });
  if (viaGroup && checkStatus(made, 201, 'a group is created to share through')) {
    const gid = made.body['@id'];
    cleanup('group', `/groups/${enc(gid)}`, groupName, user1.auth, GROUP_SERVER);
    checkStatus(await group(user1.auth, 'PUT', `/groups/${enc(gid)}/users`,
        { users: [{ user: { '@id': u1 }, administrator: true, member: true },
                  { user: { '@id': u2 }, administrator: false, member: true }] }), 200,
        'with the second user as a member');

    if (checkStatus(await call(user1.auth, 'PUT', `${viaGroup.at}/permissions`,
        permissions(u1, { groups: [[gid, 'read']] })), 200, 'and the template is shared with the group')) {
      checkStatus(await call(user2.auth, 'GET', viaGroup.at), 200,
          'the member can open it through the group alone');
      const appeared = await briefly(() => findsByTerm(user2.auth, viaGroup.tag, viaGroup.id));
      check(!appeared.done,
          'KNOWN DEFECT pinned: but cannot find it by name either — a group grant reaches the index no better than a direct one',
          'the member found it by name — the grant now reaches the index and this pin should become a positive assertion');
    }
  }

  suite('finding: a grant to everybody becomes findable');

  const toAll = await template('Everybody');
  const everybody = await (async () => (await group(user1.auth, 'GET', '/groups')).body?.groups
      ?.find(g => g.specialGroup === 'EVERYBODY'))();
  if (toAll && check(!!everybody, 'the everybody group is present', 'it could not be found')) {
    if (checkStatus(await call(user1.auth, 'PUT', `${toAll.at}/permissions`,
        permissions(u1, { groups: [[everybody['@id'], 'read']] })), 200,
        'the template is shared with everybody')) {
      const appeared = await until(() => findsByTerm(user2.auth, toAll.tag, toAll.id));
      check(appeared.done, 'another account finds it without being named anywhere',
          `it had not reached their search after ${appeared.attempts} attempts`);

      // The view behind the "Shared with everybody" listing.
      const inView = await until(() => inSharingView(user2.auth, 'shared-with-everybody', toAll.id));
      check(inView.done, 'and it appears in what is shared with everybody',
          `it never appeared in shared-with-everybody after ${inView.attempts} attempts`);
    }
  }

  suite('finding: a grant on a folder reaches its contents, except in search');

  // Access is inherited downwards, so sharing a folder shares its contents. The index has to agree,
  // which means the grant on the folder has to propagate to every artifact beneath it.
  const boxName = `Finding Box ${RUN}`;
  const box = await call(user1.auth, 'POST', '/folders',
      { folderId, name: boxName, description: 'Created by the REST suites' });
  if (checkStatus(box, 201, 'a folder is created to share')) {
    const boxId = box.body['@id'];
    cleanup('folder', `/folders/${enc(boxId)}`, boxName);
    const tag = `Finding${STAMP}Inside`;
    const post = await call(user1.auth, 'POST', `/templates?folder_id=${enc(boxId)}`,
        artifactBody('template', `${tag} template`));
    if (checkStatus(post, 201, 'holding one template')) {
      const insideId = post.body['@id'];
      cleanup('template', `/templates/${enc(insideId)}`, `${tag} template`);

      const own = await until(() => findsByTerm(user1.auth, tag, insideId));
      check(own.done, 'which its owner can find', `it never appeared for its owner after ${own.attempts} attempts`);
      check(!(await findsByTerm(user2.auth, tag, insideId)),
          'and the second user cannot', 'it was visible before the folder was shared');

      if (checkStatus(await call(user1.auth, 'PUT', `/folders/${enc(boxId)}/permissions`,
          permissions(u1, { users: [[u2, 'read']] })), 200, 'the folder is shared with the second user')) {
        checkStatus(await call(user2.auth, 'GET', `/templates/${enc(insideId)}`), 200,
            'who can read the template inside it straight away');
        const appeared = await briefly(() => findsByTerm(user2.auth, tag, insideId));
        check(!appeared.done,
            'KNOWN DEFECT pinned: but cannot find that template by name, so a shared folder\'s contents stay unsearchable',
            'the template inside was found by name — the grant now reaches the index and this pin should become a positive assertion');
      }
    }
  }

  return {};
}
