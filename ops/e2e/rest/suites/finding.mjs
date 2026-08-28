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
import {
  suite, check, checkStatus, call, updateArtifact, group, everybodyGroup, cleanup, artifactBody,
  poll, enc, RUN, GROUP_SERVER,
} from '../lib.mjs';

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
   * Polls until a term search stops returning this id — the negative a delete, a revoke or a rename
   * has to reach. It waits a real budget rather than pinning an instantaneous absence, because it is
   * asserting that a mutation *did* propagate through the queue.
   */
  const dropsByTerm = (auth, tag, id) =>
      poll(async () => ({ done: !(await findsByTerm(auth, tag, id)) }), { tries: 10, delayMs: 1200 });

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

  suite('finding: a direct grant reaches every view, search included');

  // The two halves of search do not share a backend. The sharing views, the identifier lookups and
  // the "all" listing are answered from the graph, so they follow a grant immediately. A term search
  // — the ordinary search box — is answered from the index, which the grant reaches once the resource
  // is re-materialized with the grantee in its user list.
  if (checkStatus(await call(user1.auth, 'PUT', `${direct.at}/permissions`,
      permissions(u1, { users: [[u2, 'read']] })), 200, 'the template is shared with the second user')) {
    checkStatus(await call(user2.auth, 'GET', direct.at), 200, 'who can open it at once');

    const inView = await until(() => inSharingView(user2.auth, 'shared-with-me', direct.id));
    check(inView.done, 'and sees it in what is shared with them',
        `it never appeared in shared-with-me after ${inView.attempts} attempts`);

    check(!(await inSharingView(user1.auth, 'shared-with-me', direct.id)),
        'while the owner does not see their own template as shared with them',
        'the owner\'s own template appeared in their shared-with-me view');

    // The grant reaches the indexed document's materialized user list, so a term search by the grantee
    // matches. This once failed: the materialization query bound one `user` across its owner and grant
    // traversals, dropping any grantee who was not also an owner, so the grantee's key never reached
    // the index. Fixed in CypherQueryBuilderFilesystemResourcePermission by unioning the two sets.
    const appeared = await until(() => findsByTerm(user2.auth, direct.tag, direct.id));
    check(appeared.done,
        'and a search by name finds it once the grant reaches the index',
        `the grantee never found it by name after ${appeared.attempts} attempts — the grant did not reach the search index`);
  }

  // Withdrawal is immediate on the graph side; now that a grant reaches the index, its withdrawal has
  // to reach the index too. This is the fail-dangerous direction: a user whose access was revoked must
  // stop finding the artifact, not keep it in their search results.
  if (checkStatus(await call(user1.auth, 'PUT', `${direct.at}/permissions`, permissions(u1)), 200,
      'the grant is withdrawn')) {
    check((await call(user2.auth, 'GET', direct.at)).status >= 400,
        'and the second user loses access to the artifact immediately',
        'the artifact stayed readable after the grant was withdrawn');
    check(!(await inSharingView(user2.auth, 'shared-with-me', direct.id)),
        'and it leaves what is shared with them',
        'it was still listed as shared with them after the grant was withdrawn');
    const revoked = await dropsByTerm(user2.auth, direct.tag, direct.id);
    check(revoked.done, 'and a term search no longer finds it for them',
        `a revoked user still found it by name after ${revoked.attempts} attempts — the fail-dangerous case`);
  }

  suite('finding: a grant to a group confers access and findability');

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
      // The grantee here is the group; the materialization reaches its members through MEMBEROF, so a
      // member's key lands in the indexed user list and their term search matches — the same union fix.
      const appeared = await until(() => findsByTerm(user2.auth, viaGroup.tag, viaGroup.id));
      check(appeared.done,
          'and the member can find it by name through the group grant',
          `the member never found it by name after ${appeared.attempts} attempts — the group grant did not reach the search index`);
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

  suite('finding: a grant on a folder reaches its contents, search included');

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
        // The folder grant propagates to the contained template's materialization (the CONTAINS*0..
        // traversal), so the grantee's key reaches the inner template's index document and search matches.
        const appeared = await until(() => findsByTerm(user2.auth, tag, insideId));
        check(appeared.done,
            'and the second user can find the template inside by name',
            `the template inside was never found by name after ${appeared.attempts} attempts — the folder grant did not reach the search index`);
      }
    }
  }

  // ── Index mutations that already project correctly ─────────────────────────────
  // Part of the "reliable search-index mutations" work. These lock in the mutation paths that already
  // project correctly — delete, revoke-of-everybody, and rename — so that later changes to the index
  // cannot silently regress them. Measured green and stably so — four consecutive probe runs, no
  // staleness in any.
  //
  // They work for one shared reason. Each ends in a full document reindex keyed by `cid`: delete calls
  // removeAllFromIndex(cid); a permission change and a rename both run removeDocumentFromIndex(cid) then
  // indexDocument(...) (SearchPermissionExecutorService.upsertOnePermissions and the resource server's
  // update path). The everybody grant survives that round trip because it is denormalized onto the node;
  // a per-user or per-group grant does not — which is exactly the defect the pins above record.

  suite('finding: a deleted artifact leaves the search index');

  const doomed = await template('Delete');
  if (doomed) {
    const seen = await until(() => findsByTerm(user1.auth, doomed.tag, doomed.id));
    if (check(seen.done, 'the artifact is indexed before deletion',
        `it never appeared for its owner after ${seen.attempts} attempts — the deletion assertion would prove nothing`)) {
      checkStatus(await call(user1.auth, 'DELETE', doomed.at), 204, 'it is deleted');
      check((await call(user1.auth, 'GET', doomed.at)).status === 404,
          'and the resource server no longer holds it', 'it was still readable after deletion');
      const gone = await dropsByTerm(user1.auth, doomed.tag, doomed.id);
      check(gone.done, 'and a term search no longer finds it',
          `it stayed findable ${gone.attempts} attempts after deletion — the index kept a document for a deleted artifact`);
    }
  }

  suite('finding: revoking the everybody grant removes it from search');

  // The everybody grant reaches term search through a node property rather than the per-user list, so
  // its revocation exercises a different projection path than the per-user revoke asserted above. Both
  // are the fail-dangerous direction: a user whose access is withdrawn must stop finding the artifact.
  const shared = await template('Revoke');
  const everybody2 = await everybodyGroup(user1.auth).catch(() => null);
  if (shared && check(!!everybody2, 'the everybody group is present', 'it could not be found')) {
    if (checkStatus(await call(user1.auth, 'PUT', `${shared.at}/permissions`,
        permissions(u1, { groups: [[everybody2['@id'], 'read']] })), 200, 'the template is shared with everybody')) {
      const seen = await until(() => findsByTerm(user2.auth, shared.tag, shared.id));
      if (check(seen.done, 'a second user finds it by term while it is shared',
          `it never became findable after ${seen.attempts} attempts — nothing to revoke`)) {
        checkStatus(await call(user1.auth, 'PUT', `${shared.at}/permissions`, permissions(u1)), 200,
            'the everybody grant is withdrawn');
        check((await call(user2.auth, 'GET', shared.at)).status >= 400,
            'and the second user loses access at once', 'the artifact stayed readable after revocation');
        const gone = await dropsByTerm(user2.auth, shared.tag, shared.id);
        check(gone.done, 'and a term search no longer finds it for them',
            `a revoked user still found it by term after ${gone.attempts} attempts — the fail-dangerous case`);
      }
    }
  }

  suite('finding: a rename reindexes under the new name');

  const renamed = await template('RenameOld');
  if (renamed) {
    const seen = await until(() => findsByTerm(user1.auth, renamed.tag, renamed.id));
    if (check(seen.done, 'the artifact is findable under its original name',
        `it never appeared under its first name after ${seen.attempts} attempts`)) {
      const current = await call(user1.auth, 'GET', renamed.at);
      const newTag = `Finding${STAMP}RenameNew`;
      const body = current.body;              // carries its @id, which an update requires
      body['schema:name'] = `${newTag} template`;
      if (checkStatus(await updateArtifact(user1.auth, renamed.at, body, { current }), 200,
          'it is renamed')) {
        const underNew = await until(() => findsByTerm(user1.auth, newTag, renamed.id));
        check(underNew.done, 'a term search finds it under the new name',
            `the new name never became searchable after ${underNew.attempts} attempts`);
        const oldGone = await dropsByTerm(user1.auth, renamed.tag, renamed.id);
        check(oldGone.done, 'and no longer finds it under the old one',
            `the old name still matched ${oldGone.attempts} attempts after the rename — the index kept the stale name`);
      }
    }
  }

  return {};
}
