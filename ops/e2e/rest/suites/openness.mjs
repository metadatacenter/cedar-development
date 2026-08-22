// Openness: the OpenView path, which is the only way CEDAR serves an artifact to someone who is not
// logged in at all.
//
// This is not sharing with everybody. Sharing with everybody widens a grant to every account and still
// demands a credential; making an artifact open lets an anonymous caller confirm it, through the
// OpenView server rather than the resource server. The two are independent, and this suite holds them
// apart: an open artifact stays unreadable anonymously on the resource server, and a
// shared-with-everybody artifact stays unreadable anonymously anywhere.
//
// The OpenView server answers with an empty body — it is an access decision, not a copy of the
// artifact — so these checks are about status codes only.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN, KINDS, OPENVIEW } from '../lib.mjs';

export const name = 'openness';

export async function run({ user1, user2, folderId }) {
  const auth = user1.auth;

  /** The OpenView server, with no credential of any kind. */
  const anonymously = (path) => call(null, 'GET', path, undefined, { base: OPENVIEW });
  const open = (command, id) => call(auth, 'POST', `/command/${command}`, { '@id': id });

  suite('openness: an open artifact is readable without logging in');

  // A folder of its own, so making things open here cannot widen anything the other suites rely on.
  const holderName = `Openness ${RUN}`;
  const holder = await call(auth, 'POST', '/folders',
      { folderId, name: holderName, description: 'Created by the REST suites' });
  if (!checkStatus(holder, 201, 'a folder is created to hold the open artifacts')) return {};
  const holderId = holder.body['@id'];
  cleanup('folder', `/folders/${enc(holderId)}`, holderName);

  // Every artifact kind, because each has its own OpenView route and they can drift apart. Templates
  // come first in KINDS, which matters: an instance has to be based on one that exists.
  let firstTemplateId;
  for (const { kind, path } of KINDS) {
    const label = `Open ${kind} ${RUN}`;
    const extra = kind === 'instance' && firstTemplateId ? { 'schema:isBasedOn': firstTemplateId } : {};
    const post = await call(auth, 'POST', `${path}?folder_id=${enc(holderId)}`, artifactBody(kind, label, extra));
    if (!checkStatus(post, 201, `${kind}: created`)) continue;
    const id = post.body['@id'];
    if (kind === 'template') firstTemplateId = id;
    const at = `${path}/${enc(id)}`;
    cleanup(kind, at, label);

    const before = await anonymously(at);
    check(before.status === 401, `${kind}: not open, so OpenView refuses an anonymous caller`,
        `expected 401, got ${before.status}: ${(before.text ?? '').slice(0, 160)}`);

    if (!checkStatus(await open('make-artifact-open', id), 200, `${kind}: made open by its owner`)) continue;

    const after = await anonymously(at);
    check(after.status === 200, `${kind}: OpenView now serves it anonymously`,
        `expected 200, got ${after.status}: ${(after.text ?? '').slice(0, 160)}`);

    // Openness is an OpenView affordance. It must not turn the resource server into a public API.
    const direct = await call(null, 'GET', at);
    check(direct.status === 401,
        `${kind}: and the resource server still refuses the same anonymous caller`,
        `expected 401 from the resource server, got ${direct.status}`);

    if (checkStatus(await open('make-artifact-not-open', id), 200, `${kind}: made not open again`)) {
      const closed = await anonymously(at);
      check(closed.status === 401, `${kind}: and OpenView refuses it once more`,
          `expected 401, got ${closed.status}`);
    }
  }

  suite('openness: an open folder carries its contents');

  // Openness is inherited: the server treats an artifact as open when an ancestor folder is open,
  // without the artifact itself being marked. A folder made open by accident therefore exposes
  // everything beneath it, which is worth pinning deliberately.
  const nestedName = `Openness Inherited ${RUN}`;
  const nested = await call(auth, 'POST', '/folders',
      { folderId: holderId, name: nestedName, description: 'Created by the REST suites' });
  if (checkStatus(nested, 201, 'a folder is created to be made open')) {
    const nestedId = nested.body['@id'];
    cleanup('folder', `/folders/${enc(nestedId)}`, nestedName);

    const label = `Inherited template ${RUN}`;
    const post = await call(auth, 'POST', `/templates?folder_id=${enc(nestedId)}`, artifactBody('template', label));
    if (checkStatus(post, 201, 'holding a template that is not itself open')) {
      const at = `/templates/${enc(post.body['@id'])}`;
      cleanup('template', at, label);

      check((await anonymously(at)).status === 401, 'which is refused anonymously to begin with',
          'it was served before anything was made open');

      if (checkStatus(await open('make-folder-open', nestedId), 200, 'the folder is made open')) {
        const inherited = await anonymously(at);
        check(inherited.status === 200,
            'and the template inside becomes readable anonymously without being marked open itself',
            `expected 200, got ${inherited.status}`);
      }

      if (checkStatus(await open('make-folder-not-open', nestedId), 200, 'the folder is made not open')) {
        check((await anonymously(at)).status === 401, 'and the template is refused again',
            'it stayed readable after the folder was closed');
      }
    }
  }

  suite('openness: an open folder carries a whole subtree, and lists it anonymously');

  // Two things the suite above leaves open, and they are served by different code. An artifact one
  // level down reaches `isArtifactOpenImplicitly`; a folder listing walks the path itself looking for
  // an open ancestor, so depth is where the two implementations can disagree. And reading by
  // identifier is not the whole anonymous surface: `GET /folders/{id}` on the OpenView server
  // enumerates a folder's contents, which is how an accidentally opened folder becomes browsable
  // rather than merely readable by someone who already knows an identifier.
  const branch = [];
  let parentId = holderId;
  for (const level of ['Subtree top', 'Subtree middle', 'Subtree leaf']) {
    const label = `${level} ${RUN}`;
    const made = await call(auth, 'POST', '/folders',
        { folderId: parentId, name: label, description: 'Created by the REST suites' });
    if (!checkStatus(made, 201, `${level.toLowerCase()} folder created`)) break;
    parentId = made.body['@id'];
    branch.push({ label, id: parentId });
    cleanup('folder', `/folders/${enc(parentId)}`, label);
  }

  if (branch.length === 3) {
    const [top, , leaf] = branch;
    const buried = `Buried template ${RUN}`;
    const post = await call(auth, 'POST', `/templates?folder_id=${enc(leaf.id)}`, artifactBody('template', buried));
    if (checkStatus(post, 201, 'a template is created two folders below the one to be opened')) {
      const at = `/templates/${enc(post.body['@id'])}`;
      cleanup('template', at, buried);
      const listing = (id) => anonymously(`/folders/${enc(id)}`);
      const names = (res) => (res.body?.resources ?? []).map(r => r.schema_name ?? r['schema:name']);

      check((await anonymously(at)).status === 401, 'the buried template is refused anonymously to begin with',
          'it was served before anything was made open');
      check((await listing(leaf.id)).status === 401, 'and its folder cannot be listed anonymously either',
          'the listing was served before anything was made open');

      if (checkStatus(await open('make-folder-open', top.id), 200, 'the top of the branch is made open')) {
        check((await anonymously(at)).status === 200,
            'the template two levels below becomes readable anonymously',
            'openness reached one level but not two');

        const leafListing = await listing(leaf.id);
        if (check(leafListing.status === 200, 'the folder holding it can be listed anonymously',
            `expected 200, got ${leafListing.status}`)) {
          check(names(leafListing).includes(buried), 'and the listing names the template it holds',
              `listed ${JSON.stringify(names(leafListing))}`);
        }

        const topListing = await listing(top.id);
        if (check(topListing.status === 200, 'so can the open folder itself',
            `expected 200, got ${topListing.status}`)) {
          check(names(topListing).includes(branch[1].label), 'and it names the folder nested inside it',
              `listed ${JSON.stringify(names(topListing))}`);
        }

        // Openness travels down a path, never up it. Without this the two checks above would pass
        // just as well if opening a folder had exposed everything around it.
        check((await listing(holderId)).status === 401,
            'the folder above the open one stays refused, so openness does not travel upwards',
            'the parent of the open folder was listed anonymously');
      }

      if (checkStatus(await open('make-folder-not-open', top.id), 200, 'the top of the branch is closed again')) {
        check((await anonymously(at)).status === 401, 'the buried template is refused once more',
            'it stayed readable after the branch was closed');
        check((await listing(leaf.id)).status === 401, 'and the listing is refused with it',
            'the folder stayed listable after the branch was closed');
      }
    }
  }

  suite('openness: who may make something open, and what the commands refuse');

  const guardedName = `Openness Guarded ${RUN}`;
  const guarded = await call(auth, 'POST', `/templates?folder_id=${enc(holderId)}`,
      artifactBody('template', guardedName));
  if (checkStatus(guarded, 201, 'a template is created to guard')) {
    const gid = guarded.body['@id'];
    cleanup('template', `/templates/${enc(gid)}`, guardedName);

    // Making something open is a publication decision, so it takes write access, not mere reach.
    checkStatus(await call(user2.auth, 'POST', '/command/make-artifact-open', { '@id': gid }), [403, 404],
        'a user with no access to the artifact cannot make it open');
    check((await anonymously(`/templates/${enc(gid)}`)).status === 401,
        'and it stayed closed', 'the refused command made it open anyway');

    checkStatus(await call(null, 'POST', '/command/make-artifact-open', { '@id': gid }), 401,
        'an anonymous caller cannot make it open');
  }

  // The four open commands guard the identifier: a body with no @id is a malformed request and is
  // refused as one, rather than becoming a lookup for the null id that answered 404.
  for (const command of ['make-artifact-open', 'make-artifact-not-open', 'make-folder-open', 'make-folder-not-open']) {
    const res = await call(auth, 'POST', `/command/${command}`, { note: 'no @id here' });
    check(res.status === 400,
        `${command} refuses a body with no @id as a bad request`,
        `expected 400, got ${res.status}: ${(res.text ?? '').slice(0, 160)}`);
  }

  checkStatus(await anonymously(`/templates/${enc('https://repo.metadatacenter.orgx/templates/does-not-exist')}`),
      404, 'OpenView answers 404 for an artifact that does not exist');

  return {};
}
