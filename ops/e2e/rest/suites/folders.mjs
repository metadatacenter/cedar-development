// Folders and the filesystem commands: the operations a user performs constantly and which had
// no REST coverage beyond the create the other suites depend on.
import { isDeepStrictEqual } from 'node:util';
import { suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, mintId, RUN } from '../lib.mjs';

export const name = 'folders';

export async function run({ user1, homeFolderId }) {
  const auth = user1.auth;
  suite('folders: create, read, rename, contents, delete');

  const mk = async (parent, name) => {
    const res = await call(auth, 'POST', '/folders',
        { folderId: parent, name, description: `Created by the REST suites (${RUN})` });
    return res;
  };

  const parentName = `Folders Parent ${RUN}`;
  const parent = await mk(homeFolderId, parentName);
  if (!checkStatus(parent, 201, 'folder created')) return {};
  const parentId = parent.body['@id'];
  const parentAt = `/folders/${enc(parentId)}`;
  cleanup('folder', parentAt, parentName);

  checkStatus(await call(auth, 'GET', parentAt), 200, 'folder read back');
  const details = await call(auth, 'GET', `${parentAt}/details`);
  if (checkStatus(details, 200, 'folder details')) {
    const current = details.body?.currentUserPermissions;
    const capabilities = new Set(current?.capabilities ?? []);
    const expectedCapabilities = new Set([
      'readResource', 'listFolderContents', 'updateResource', 'createInFolder',
      'copyIntoFolder', 'moveIntoFolder', 'deleteResource', 'manageGrants', 'moveResource',
      'manageOpenView', 'transferOwnership',
    ]);
    check(current?.role == null && current?.owner === true,
        'folder ownership is represented separately from the role',
        `authority was ${JSON.stringify({ role: current?.role, owner: current?.owner })}`);
    check(capabilities.size === expectedCapabilities.size
          && [...expectedCapabilities].every(value => capabilities.has(value)),
        'folder authority exposes exactly the folder capability set',
        `capabilities were ${JSON.stringify([...capabilities])}`);
    const actions = new Set(current?.availableActions ?? []);
    check(!actions.has('copyFromResource'), 'a folder is not presented as a copy source',
        `available actions were ${JSON.stringify([...actions])}`);
  }
  checkStatus(await call(auth, 'GET', `${parentAt}/permissions`), 200, 'folder permissions');
  checkStatus(await call(auth, 'GET', `${parentAt}/contents`), 200, 'folder contents');
  checkStatus(await call(auth, 'GET', `${parentAt}/contents-extract`), 200, 'folder contents-extract');

  // A child, so contents has something to report and the move below has somewhere to go.
  const childName = `Folders Child ${RUN}`;
  const child = await mk(parentId, childName);
  if (checkStatus(child, 201, 'nested folder created')) {
    const childId = child.body['@id'];
    cleanup('folder', `/folders/${enc(childId)}`, childName);
    const contents = await call(auth, 'GET', `${parentAt}/contents`);
    const names = JSON.stringify(contents.body ?? {});
    check(names.includes(childName), 'the child appears in its parent\'s contents',
        `contents did not mention it: ${names.slice(0, 200)}`);
  }

  // Rename through PUT, and confirm it took.
  const renamed = `${parentName} renamed`;
  const put = await mutate(auth, 'PUT', parentAt,
      { 'schema:name': renamed, 'schema:description': 'renamed by the REST suites' });
  if (checkStatus(put, 200, 'folder renamed')) {
    const after = await call(auth, 'GET', parentAt);
    check(after.body?.['schema:name'] === renamed, 'the rename is visible on a fresh read',
        `name was "${after.body?.['schema:name']}"`);
  }

  suite('folders: contents filtering and sorting');

  // A template beside the child folder, so the parent holds two resource types to filter over.
  // Contents are graph-backed, so they appear immediately — no indexing wait.
  const tmplName = `Folders Contents Template ${RUN}`;
  const tmpl = await call(auth, 'POST', `/templates?folder_id=${enc(parentId)}`, artifactBody('template', tmplName));
  if (checkStatus(tmpl, 201, 'a template is created alongside the child folder')) {
    cleanup('template', `/templates/${enc(tmpl.body['@id'])}`, tmplName);

    const foldersOnly = await call(auth, 'GET', `${parentAt}/contents?resource_types=folder&limit=50`);
    if (checkStatus(foldersOnly, 200, 'contents filtered to folders returns')) {
      const kinds = new Set((foldersOnly.body?.resources ?? []).map(r => r.resourceType));
      check(kinds.has('folder') && !kinds.has('template'),
          'a folder-only listing holds the child folder and not the template',
          `kinds were ${[...kinds].join(', ')}`);
    }

    const templatesOnly = await call(auth, 'GET', `${parentAt}/contents?resource_types=template&limit=50`);
    if (checkStatus(templatesOnly, 200, 'contents filtered to templates returns')) {
      const kinds = new Set((templatesOnly.body?.resources ?? []).map(r => r.resourceType));
      check(kinds.has('template') && !kinds.has('folder'),
          'a template-only listing holds the template and not the child folder',
          `kinds were ${[...kinds].join(', ')}`);
    }

    const byName = await call(auth, 'GET', `${parentAt}/contents?sort=name&limit=50`);
    if (checkStatus(byName, 200, 'contents sorted by name returns')) {
      const names = (byName.body?.resources ?? []).map(r => r['schema:name']).filter(Boolean);
      const asc = [...names].sort((a, b) => a.localeCompare(b));
      check(JSON.stringify(names) === JSON.stringify(asc), 'the contents come back in ascending name order',
          `order was ${JSON.stringify(names).slice(0, 200)}`);
    }
  }

  suite('folders: the rules');

  // Two folders cannot share a name under one parent. This is the 409 added earlier; asserting it
  // here is what proves the status survived the trip out through HTTP.
  const dup = await mk(homeFolderId, renamed);
  if (dup.status === 201) {
    cleanup('folder', `/folders/${enc(dup.body['@id'])}`, `${renamed} (duplicate)`);
    check(false, 'a duplicate folder name under one parent is refused',
        'the duplicate was created instead of refused');
  } else {
    check(dup.status === 409, 'a duplicate folder name under one parent answers 409 Conflict',
        `expected 409, got ${dup.status}: ${(dup.text ?? '').slice(0, 200)}`);
  }

  checkStatus(await call(auth, 'GET',
      `/folders/${enc('https://repo.metadatacenter.orgx/folders/00000000-0000-0000-0000-000000000000')}`),
      404, 'an unknown folder answers 404');

  // The home folder can be neither deleted nor renamed. Both refusals are safe to assert, since a
  // refusal changes nothing — and the rename attempt is deliberately one that must fail: an earlier
  // version of this suite renamed test1's home folder for real (the rename was not guarded then) and
  // it had to be put back by hand. This asserts the guard now holds.
  //
  // Both refusals are 400. The owner holds write access to their home folder, so neither refusal
  // concerns permission. Each refuses the folder because it is a home folder. The delete handler
  // states that refusal as 400 folderCanNotBeDeleted with the reason userHomeFolder, the recursive
  // deletion endpoint refuses the same folder with 400, and the rename guard answers 400
  // folderCanNotBeChanged.
  const home = `/folders/${enc(homeFolderId)}`;
  const deleteHome = await mutate(auth, 'DELETE', home);
  checkStatus(deleteHome, 400, 'the home folder cannot be deleted');
  const renameHome = await mutate(auth, 'PUT', home,
      { 'schema:name': `Home renamed by the REST suites ${RUN}`, 'schema:description': 'attempt' });
  check(renameHome.status === 400, 'the home folder cannot be renamed',
      `expected 400, got ${renameHome.status} — if 200, the home folder was just renamed for real: `
      + (renameHome.text ?? '').slice(0, 300));
  const stillHome = await call(auth, 'GET', home);
  check(stillHome.body?.isUserHome === true, 'and it is still the user\'s home afterwards',
      `isUserHome was ${stillHome.body?.isUserHome}`);

  suite('folders: move, rename and copy commands');

  // A destination and an artifact to move into it.
  const destName = `Folders Destination ${RUN}`;
  const dest = await mk(homeFolderId, destName);
  if (!checkStatus(dest, 201, 'destination folder created')) return { parentId };
  const destId = dest.body['@id'];
  cleanup('folder', `/folders/${enc(destId)}`, destName);

  const artName = `Movable Template ${RUN}`;
  const art = await call(auth, 'POST', `/templates?folder_id=${enc(parentId)}`, artifactBody('template', artName));
  if (checkStatus(art, 201, 'template created for the move')) {
    const artId = art.body['@id'];
    cleanup('template', `/templates/${enc(artId)}`, artName);

    const moveBody = { '@id': artId, targetFolderId: destId };
    const graphBeforeMove = await call(auth, 'GET', `/templates/${enc(artId)}/details`);
    const moveEtag = graphBeforeMove.headers?.get('etag');
    checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder', moveBody), 428,
        'a move without the source If-Match is refused');
    checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder', moveBody,
        { headers: { 'If-Match': '"0"' } }), 412,
    'a move with a stale source If-Match is refused');
    const move = await call(auth, 'POST', '/command/move-resource-to-folder', moveBody,
        { headers: moveEtag ? { 'If-Match': moveEtag } : {} });
    if (checkStatus(move, [200, 201, 204], 'template moved to another folder')) {
      const movedEtag = move.headers?.get('etag');
      check(!!movedEtag && movedEtag !== moveEtag,
          'the move returns a fresh source ETag', `before ${moveEtag}, after ${movedEtag}`);
      checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder',
          moveBody, { headers: moveEtag ? { 'If-Match': moveEtag } : {} }), 412,
      'the pre-move ETag cannot move the resource again');
      checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder', moveBody,
          { headers: { 'If-Match': '*' } }), [200, 201, 204],
      'the wildcard accepts a repeat move while the source still exists');
      const there = await call(auth, 'GET', `/folders/${enc(destId)}/contents`);
      const occurrences = (there.body?.resources ?? []).filter(resource => resource['@id'] === artId).length;
      check(occurrences === 1,
          'the moved template occurs exactly once in the destination folder',
          `the destination folder contained ${occurrences} copies of it`);
      const gone = await call(auth, 'GET', `/folders/${enc(parentId)}/contents`);
      check(!JSON.stringify(gone.body ?? {}).includes(artName),
          'and it is no longer in the folder it came from',
          'the source folder still lists it');
    }

    const newName = `${artName} via command`;
    const beforeRename = await call(auth, 'GET', `/templates/${enc(artId)}`);
    const renameEtag = beforeRename.headers?.get('etag');
    checkStatus(await call(auth, 'POST', '/command/rename-resource',
        { '@id': artId, 'schema:name': newName, 'schema:description': 'renamed by command' }),
    428, 'template command rename without If-Match is refused');
    const rename = await call(auth, 'POST', '/command/rename-resource',
        { '@id': artId, 'schema:name': newName, 'schema:description': 'renamed by command' },
        { headers: renameEtag ? { 'If-Match': renameEtag } : {} });
    if (checkStatus(rename, [200, 201, 204], 'template renamed by command')) {
      const after = await call(auth, 'GET', `/templates/${enc(artId)}/details`);
      check(after.body?.['schema:name'] === newName, 'the command rename is visible on a fresh read',
          `name was "${after.body?.['schema:name']}"`);
      checkStatus(await call(auth, 'POST', '/command/rename-resource',
          { '@id': artId, 'schema:name': `${newName} stale` },
          { headers: renameEtag ? { 'If-Match': renameEtag } : {} }),
      412, 'template command rename with a stale If-Match is refused');
    }

    const copy = await call(auth, 'POST', '/command/copy-artifact-to-folder',
        { '@id': artId, targetFolderId: destId, nameTemplate: `${artName} copy` });
    if (copy.status === 200 || copy.status === 201) {
      const copyId = copy.body?.['@id'];
      if (copyId) cleanup('template', `/templates/${enc(copyId)}`, `${artName} copy`);
      check(copyId && copyId !== artId, 'copying an artifact yields a new identifier',
          `the copy reported ${copyId}`);
    } else {
      check(false, 'artifact copied to a folder', `${copy.status}: ${(copy.text ?? '').slice(0, 200)}`);
    }
  }

  suite('folders: a malformed command body');

  // All three used to answer 500: move and copy read jsonBody.get(...).asText() unguarded, so a
  // missing field was a null dereference, and rename read its identifier without checking it. They
  // now read through CedarParameter with must(...).be(NonEmpty), matching the sibling
  // CommandCategoriesResource, so a malformed request is a bad request rather than a server fault.
  checkStatus(await call(auth, 'POST', '/command/rename-resource', { 'schema:name': 'no id supplied' }),
      400, 'rename-resource answers 400 to a body with no identifier');
  checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder', { targetFolderId: destId }),
      400, 'move-resource-to-folder answers 400 to a body with no identifier');
  checkStatus(await call(auth, 'POST', '/command/copy-artifact-to-folder', { targetFolderId: destId }),
      400, 'copy-artifact-to-folder answers 400 to a body with no identifier');

  suite('folders: create under a supplied identity');

  // Workspace's New folder dialog mints the folder's identity and creates it with an unconditional
  // PUT. A lost reply is settled by reading that identity, and a repeat must be told apart from a
  // malformed request by its status alone.
  const suppliedName = `Folders Supplied Identity ${RUN}`;
  const suppliedId = mintId('folders');
  const suppliedAt = `/folders/${enc(suppliedId)}`;
  // Registered before the request: what to delete does not depend on the reply.
  cleanup('folder', suppliedAt, suppliedName);
  const suppliedBody = { '@id': suppliedId, folderId: parentId, name: suppliedName,
    description: `Created by the REST suites (${RUN})` };
  const suppliedFolder = await call(auth, 'PUT', suppliedAt, suppliedBody);
  if (checkStatus(suppliedFolder, 201, 'an unconditional PUT creates a folder under the supplied identity')) {
    check(suppliedFolder.body?.['@id'] === suppliedId, 'and the reply names that identity',
        `the reply named ${suppliedFolder.body?.['@id']}`);
    const read = await call(auth, 'GET', suppliedAt);
    checkStatus(read, 200, 'the supplied folder identity reads back');
    checkStatus(await call(auth, 'PUT', suppliedAt, suppliedBody), 428,
        'an unconditional repeat answers 428 rather than a body-shape refusal');
    const after = await call(auth, 'GET', suppliedAt);
    check(after.status === 200 && after.headers.get('etag') === read.headers.get('etag')
          && after.body?.['schema:name'] === suppliedName,
        'and the refused repeat changes nothing',
        `${after.status}, ETag ${read.headers.get('etag')} then ${after.headers.get('etag')}`);
    const contents = await call(auth, 'GET', `${parentAt}/contents?limit=50`);
    const occurrences = (contents.body?.resources ?? []).filter(r => r['@id'] === suppliedId).length;
    check(occurrences === 1, 'the requested parent holds the folder exactly once',
        `the parent listed it ${occurrences} times`);
  }

  suite('folders: copy under a supplied identity');

  // Workspace's Copy dialog mints the copy's identity and sends it as copyId. The copy is then
  // looked up by that identity and its derivation, never by its name, and a repeat cannot copy twice.
  const copySourceName = `Folders Copy Source ${RUN}`;
  const copySource = await call(auth, 'POST', `/templates?folder_id=${enc(parentId)}`,
      artifactBody('template', copySourceName));
  if (copySource.status === 201) cleanup('template', `/templates/${enc(copySource.body['@id'])}`, copySourceName);
  const copyTargetName = `Folders Copy Target ${RUN}`;
  const copyTarget = await mk(parentId, copyTargetName);
  if (copyTarget.status === 201) cleanup('folder', `/folders/${enc(copyTarget.body['@id'])}`, copyTargetName);
  if (checkStatus(copySource, 201, 'a template is created to copy under a supplied identity')
      && checkStatus(copyTarget, 201, 'and a folder to copy it into')) {
    const sourceId = copySource.body['@id'];
    const targetId = copyTarget.body['@id'];
    const targetHolds = async () => {
      const contents = await call(auth, 'GET', `/folders/${enc(targetId)}/contents?limit=50`);
      return (contents.body?.resources ?? []).map(r => r['@id']);
    };
    const copyName = `${copySourceName} copy`;
    const copyId = mintId('templates');
    cleanup('template', `/templates/${enc(copyId)}`, copyName);
    const copyRequest = { '@id': sourceId, targetFolderId: targetId, nameTemplate: copyName, copyId };
    const copied = await call(auth, 'POST', '/command/copy-artifact-to-folder', copyRequest);
    if (checkStatus(copied, 201, 'the copy is created under the supplied copyId')) {
      check(copied.body?.['@id'] === copyId, 'and the reply names that identity',
          `the reply named ${copied.body?.['@id']}`);
      const stored = await call(auth, 'GET', `/templates/${enc(copyId)}`);
      check(stored.status === 200 && stored.body?.['pav:derivedFrom'] === sourceId,
          'the copy reads back at that identity, derived from its source',
          `${stored.status}, derived from ${stored.body?.['pav:derivedFrom']}`);

      const repeated = await call(auth, 'POST', '/command/copy-artifact-to-folder', copyRequest);
      if (checkStatus(repeated, 412, 'a repeated copy to the same identity is refused')) {
        check((repeated.text ?? '').includes('nodeAlreadyPresent'),
            'and the refusal says the copy identity is already present',
            `body was ${(repeated.text ?? '').slice(0, 200)}`);
      }
      const held = await targetHolds();
      check(held.length === 1 && held[0] === copyId, 'the target holds exactly the one copy',
          `the target held ${JSON.stringify(held)}`);
    }

    // An identity another artifact holds: the copy is refused and that artifact is untouched.
    const occupantName = `Folders Occupied Identity ${RUN}`;
    const occupant = await call(auth, 'POST', `/templates?folder_id=${enc(parentId)}`,
        artifactBody('template', occupantName));
    if (checkStatus(occupant, 201, 'a template is created to occupy an identity')) {
      const occupantId = occupant.body['@id'];
      const occupantAt = `/templates/${enc(occupantId)}`;
      cleanup('template', occupantAt, occupantName);
      const before = await call(auth, 'GET', occupantAt);
      const refused = await call(auth, 'POST', '/command/copy-artifact-to-folder',
          { ...copyRequest, nameTemplate: `${copyName} onto an occupied identity`, copyId: occupantId });
      if (checkStatus(refused, 412, 'a copy to an identity another artifact holds is refused')) {
        check((refused.text ?? '').includes('nodeAlreadyPresent'),
            'and the refusal says the occupied identity is already present',
            `body was ${(refused.text ?? '').slice(0, 200)}`);
      }
      const afterRefusal = await call(auth, 'GET', occupantAt);
      check(afterRefusal.headers.get('etag') === before.headers.get('etag')
            && isDeepStrictEqual(afterRefusal.body, before.body),
          'and the artifact holding that identity is unchanged', 'its content or ETag changed');
      const held = await targetHolds();
      check(held.length === 1 && held[0] === copyId, 'and no copy was written to the target',
          `the target held ${JSON.stringify(held)}`);
    }

    // An identity in a collection other than the source's cannot hold the copy.
    const misplacedId = mintId('template-fields');
    cleanup('field', `/template-fields/${enc(misplacedId)}`, `${copyName} in the wrong collection`);
    checkStatus(await call(auth, 'POST', '/command/copy-artifact-to-folder',
        { ...copyRequest, nameTemplate: `${copyName} in the wrong collection`, copyId: misplacedId }), 400,
        'a copyId in a collection other than the source\'s is refused');
    const misplaced = await call(auth, 'GET', `/template-fields/${enc(misplacedId)}`);
    const heldAfterMisplaced = await targetHolds();
    check(misplaced.status === 404 && heldAfterMisplaced.length === 1,
        'and nothing is stored under it or in the target',
        `the identity answered ${misplaced.status}; the target held ${JSON.stringify(heldAfterMisplaced)}`);

    // Nor can a value that is not an identifier at all.
    checkStatus(await call(auth, 'POST', '/command/copy-artifact-to-folder',
        { ...copyRequest, nameTemplate: `${copyName} under a malformed identity`, copyId: 'not-an-identifier' }), 400,
        'a copyId that is not an identifier is refused');
    const heldAfterMalformed = await targetHolds();
    check(heldAfterMalformed.length === 1, 'and no copy is written for it',
        `the target held ${JSON.stringify(heldAfterMalformed)}`);
  }

  return { parentId, destId };
}
