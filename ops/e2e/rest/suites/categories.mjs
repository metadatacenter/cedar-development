// Categories: the classification tree, and attaching artifacts to it. Twelve routes, none of which
// had REST coverage.
import { suite, check, checkStatus, call, cleanup, artifactBody, note, ok, enc, RUN } from '../lib.mjs';

export const name = 'categories';

export async function run({ user1, user2, admin, folderId }) {
  const auth = user1.auth;
  suite('categories: the tree');

  const root = await call(auth, 'GET', '/categories/root');
  if (!checkStatus(root, 200, 'the root category is readable')) return {};
  const rootId = root.body?.['@id'];
  check(!!rootId, 'the root category has an identifier', `body was ${(root.text ?? '').slice(0, 150)}`);

  checkStatus(await call(auth, 'GET', '/categories'), 200, 'the category list is readable');
  checkStatus(await call(auth, 'GET', '/categories/tree'), 200, 'the category tree is readable');

  // Any authenticated user may read a category: it is a shared vocabulary, not private data. Pinned
  // because it is the opposite of every other resource kind, and asserted through a second user so it
  // is a claim about the endpoint rather than about ownership.
  checkStatus(await call(user2.auth, 'GET', '/categories/root'), 200,
      'a second user may also read the root — categories are a shared vocabulary');

  suite('categories: who may extend the vocabulary');

  // A normal user may read the tree but not add to it: creating under the root needs write access to
  // the root, which only an administrator has. That is consistent with a category being shared
  // vocabulary rather than personal data, and it is the reason the rest of this suite runs as the
  // administrator.
  const asUser = await call(auth, 'POST', '/categories', {
    'schema:name': `Should not be created ${RUN}`,
    'schema:description': 'attempt by a normal user',
    parentCategoryId: rootId,
    'schema:identifier': `rest-suites-denied-${RUN}`,
  });
  if (asUser.status === 201) {
    cleanup('category', `/categories/${enc(asUser.body['@id'])}`, 'unexpectedly created');
    check(false, 'a normal user cannot create a category under the root',
        'the category was created instead of refused');
  } else {
    check(asUser.status === 403, 'a normal user cannot create a category under the root',
        `expected 403, got ${asUser.status}`);
  }

  if (!admin) {
    note('the category write surface was not exercised',
        'CEDAR_ADMIN_USER_API_KEY is unset, and only an administrator may write the tree');
    return { rootId };
  }
  const adm = admin.auth;

  suite('categories: create, read, update, delete (as administrator)');

  const label = `Category ${RUN}`;
  const made = await call(adm, 'POST', '/categories', {
    'schema:name': label,
    'schema:description': 'Created by the REST suites',
    parentCategoryId: rootId,
    'schema:identifier': `rest-suites-${RUN}`,
  });
  if (!checkStatus(made, 201, 'category created')) return { rootId };
  const id = made.body['@id'];
  const at = `/categories/${enc(id)}`;
  cleanup('category', at, label, adm);

  const got = await call(adm, 'GET', at);
  checkStatus(got, 200, 'category read back');
  check(got.body?.['schema:name'] === label, 'the category carries the name it was given',
      `name was "${got.body?.['schema:name']}"`);

  // Reading a category's ACL needs WRITE access, which is stricter than a folder's — a folder's
  // permissions need only read. Worth pinning: the same operation costs a different permission
  // depending on the kind of thing it is asked about.
  checkStatus(await call(adm, 'GET', `${at}/permissions`), 200,
      'the owner can read the category ACL');
  const otherAcl = await call(auth, 'GET', `${at}/permissions`);
  check(otherAcl.status === 403, 'a normal user cannot read it — the ACL needs write access',
      `expected 403, got ${otherAcl.status}`);

  const renamed = `${label} renamed`;
  const put = await call(adm, 'PUT', at,
      { 'schema:name': renamed, 'schema:description': 'renamed by the REST suites' });
  if (checkStatus(put, 200, 'category renamed')) {
    const after = await call(adm, 'GET', at);
    check(after.body?.['schema:name'] === renamed, 'the rename is visible on a fresh read',
        `name was "${after.body?.['schema:name']}"`);
  }

  // A child, so the tree has depth and the parent cannot be deleted out from under it.
  const childLabel = `${label} child`;
  const child = await call(adm, 'POST', '/categories', {
    'schema:name': childLabel,
    'schema:description': 'Created by the REST suites',
    parentCategoryId: id,
    'schema:identifier': `rest-suites-child-${RUN}`,
  });
  if (checkStatus(child, 201, 'nested category created')) {
    cleanup('category', `/categories/${enc(child.body['@id'])}`, childLabel, adm);
    const tree = await call(adm, 'GET', '/categories/tree');
    check(JSON.stringify(tree.body ?? {}).includes(childLabel),
        'the child appears in the tree', 'the tree did not mention it');
  }

  suite('categories: attaching artifacts, and the grant it needs');

  const artLabel = `Categorised Template ${RUN}`;
  const art = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', artLabel));
  if (checkStatus(art, 201, 'template created to categorise')) {
    const artId = art.body['@id'];
    cleanup('template', `/templates/${enc(artId)}`, artLabel);

    // Classifying your own artifact under a category needs a grant on the category, not merely on
    // the artifact. With an administrator-owned vocabulary that means a user cannot categorise
    // anything until someone grants them ATTACH — worth knowing, because it is the difference
    // between a working category picker and an empty one.
    const before = await call(auth, 'POST', '/command/attach-category',
        { artifactId: artId, categoryId: id });
    check(before.status === 403,
        'a user cannot attach a category they have no grant on, even to their own artifact',
        `expected 403, got ${before.status}`);

    // ATTACH is a real, enforced permission — unlike four of the six filesystem levels. Granting it
    // is what makes the attach possible, and asserting the pair is what shows the grant did the work.
    const grant = await call(adm, 'PUT', `${at}/permissions`, {
      owner: { '@id': admin.profile?.['@id'] ?? undefined },
      userPermissions: [{ user: { '@id': user1.profile['@id'] }, permission: 'attach' }],
      groupPermissions: [],
    });
    if (grant.status !== 200) {
      // The owner field needs the administrator's own id, which the API-key actor does not carry a
      // profile for. Fall back to reading it off the category's current ACL.
      const acl = await call(adm, 'GET', `${at}/permissions`);
      const ownerId = acl.body?.owner?.['@id'];
      if (ownerId) {
        const retry = await call(adm, 'PUT', `${at}/permissions`, {
          owner: { '@id': ownerId },
          userPermissions: [{ user: { '@id': user1.profile['@id'] }, permission: 'attach' }],
          groupPermissions: [],
        });
        checkStatus(retry, 200, 'the administrator grants ATTACH on the category');
      } else {
        check(false, 'the administrator grants ATTACH on the category',
            `${grant.status}: ${(grant.text ?? '').slice(0, 200)}`);
      }
    } else {
      ok('the administrator grants ATTACH on the category');
    }

    const attach = await call(auth, 'POST', '/command/attach-category',
        { artifactId: artId, categoryId: id });
    if (checkStatus(attach, [200, 201, 204], 'with ATTACH granted, the user can categorise their artifact')) {
      const report = await call(auth, 'GET', `/templates/${enc(artId)}/report`);
      check(JSON.stringify(report.body ?? {}).includes(id),
          'the artifact report names the attached category',
          'the report did not mention it');
    }

    // Attaching twice must not double-count or fail obscurely.
    const again = await call(auth, 'POST', '/command/attach-category',
        { artifactId: artId, categoryId: id });
    check(again.status < 500, 'attaching the same category twice is not a server error',
        `got ${again.status}`);

    const detach = await call(auth, 'POST', '/command/detach-category',
        { artifactId: artId, categoryId: id });
    if (checkStatus(detach, [200, 201, 204], 'and can detach it again')) {
      const report = await call(auth, 'GET', `/templates/${enc(artId)}/report`);
      check(!JSON.stringify(report.body ?? {}).includes(id),
          'the report no longer names it', 'the report still mentions the category');
    }

    checkStatus(await call(auth, 'POST', '/command/attach-categories',
        { artifactId: artId, categoryIds: [id] }), [200, 201, 204],
        'several categories can be attached at once');
  }

  suite('categories: the rules');

  checkStatus(await call(auth, 'GET',
      `/categories/${enc('https://repo.metadatacenter.orgx/categories/00000000-0000-0000-0000-000000000000')}`),
      404, 'an unknown category answers 404');

  // A second user may read the vocabulary but must not extend or alter someone else's branch.
  const intrude = await call(auth, 'PUT', at,
      { 'schema:name': 'Renamed by an intruder', 'schema:description': 'nope' });
  check(intrude.status >= 400, 'a normal user cannot rename an administrator\'s category',
      `expected 4xx, got ${intrude.status}`);
  const stillNamed = await call(adm, 'GET', at);
  check(stillNamed.body?.['schema:name'] === renamed, 'and the refusal changed nothing',
      `name is now "${stillNamed.body?.['schema:name']}"`);

  return { rootId, categoryId: id };
}
