// Folders and the filesystem commands: the operations a user performs constantly and which had
// no REST coverage beyond the create the other suites depend on.
import { suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

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
  checkStatus(await call(auth, 'GET', `${parentAt}/details`), 200, 'folder details');
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
  const home = `/folders/${enc(homeFolderId)}`;
  const deleteHome = await mutate(auth, 'DELETE', home);
  check(deleteHome.status >= 400, 'the home folder cannot be deleted',
      `expected 4xx, got ${deleteHome.status}`);
  const renameHome = await mutate(auth, 'PUT', home,
      { 'schema:name': `Home renamed by the REST suites ${RUN}`, 'schema:description': 'attempt' });
  check(renameHome.status >= 400, 'the home folder cannot be renamed',
      `expected 4xx, got ${renameHome.status} — if 200, the home folder was just renamed for real`);
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

    const move = await call(auth, 'POST', '/command/move-resource-to-folder',
        { '@id': artId, targetFolderId: destId });
    if (checkStatus(move, [200, 201, 204], 'template moved to another folder')) {
      checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder',
          { '@id': artId, targetFolderId: destId }), [200, 201, 204],
          'repeating the same move is accepted');
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
    const rename = await call(auth, 'POST', '/command/rename-resource',
        { '@id': artId, 'schema:name': newName, 'schema:description': 'renamed by command' });
    if (checkStatus(rename, [200, 201, 204], 'template renamed by command')) {
      const after = await call(auth, 'GET', `/templates/${enc(artId)}/details`);
      check(after.body?.['schema:name'] === newName, 'the command rename is visible on a fresh read',
          `name was "${after.body?.['schema:name']}"`);
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

  return { parentId, destId };
}
