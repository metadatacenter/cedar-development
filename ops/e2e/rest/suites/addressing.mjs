// Exercise the actual service boundary, including direct ports: no nginx rewriting is involved.
import { suite, check, checkStatus, call, mutate, updateArtifact, cleanup, artifactBody,
  KINDS, RUN, enc, OPENVIEW, ARTIFACT_SERVER } from '../lib.mjs';
export const name = 'addressing';
const selector = iri => iri.split('/').slice(-2).join('/');
const at = iri => '/' + selector(iri);
const resourceDirect = `http://${process.env.CEDAR_RESOURCE_SERVER_HOST ?? 'localhost'}:${process.env.CEDAR_RESOURCE_HTTP_PORT ?? '9007'}`;

export async function run({ user1, user2, admin, homeFolderId }) {
  suite('addressing: typed selectors and legacy identities');
  const auth = user1.auth;
  const folder = await call(auth, 'POST', '/folders', {
    folderId: selector(homeFolderId), name: `Addressing ${RUN}`, description: 'Typed addressing smoke',
  });
  if (!checkStatus(folder, 201, 'folder created using a type-qualified parent')) return {};
  const fid = folder.body['@id'];
  cleanup('folder', at(fid), `Addressing ${RUN}`, undefined, undefined, fid);
  const fullFolder = await call(auth, 'GET', '/folders/' + enc(fid));
  const shortFolder = await call(auth, 'GET', at(fid), undefined, { base: resourceDirect });
  checkStatus(shortFolder, 200, 'folder short route is readable');
  check(shortFolder.body?.['@id'] === fid && fullFolder.headers.get('etag') === shortFolder.headers.get('etag'),
    'folder aliases preserve identity and revision', shortFolder.text);
  checkStatus(await mutate(auth, 'PATCH', at(fid), { isOpen: true }, { etagPath: at(fid) }),
    200, 'folder openness accepts the bare identifier in its path');
  checkStatus(await call(null, 'GET', at(fid), undefined, { base: OPENVIEW }), 200,
    'OpenView folder works directly without a proxy rewrite');
  let template;
  for (const { kind, path } of KINDS) {
    const label = `Addressing ${kind} ${RUN}`;
    const extra = kind === 'instance' ? { 'schema:isBasedOn': template } : {};
    const created = await call(auth, 'POST', `${path}?folder_id=${enc(selector(fid))}`, artifactBody(kind, label, extra));
    if (!checkStatus(created, 201, `${kind}: create accepts a type-qualified folder query`)) continue;
    const id = created.body['@id'];
    if (kind === 'template') template = id;
    cleanup(kind, at(id), label, undefined, undefined, id);
    const modern = await call(auth, 'GET', at(id), undefined, { base: resourceDirect });
    const legacy = await call(auth, 'GET', `${path}/${enc(id)}`);
    checkStatus(modern, 200, `${kind}: new route reads`);
    check(JSON.stringify(modern.body) === JSON.stringify(legacy.body) && modern.headers.get('etag') === legacy.headers.get('etag'),
      `${kind}: old and new routes return the same document and revision`, legacy.text);
    checkStatus(await call(auth, 'GET', at(id), undefined, { base: ARTIFACT_SERVER }), 200,
      `${kind}: internal artifact route accepts the new address directly`);
    checkStatus(await call(user2.auth, 'GET', at(id)), 403, `${kind}: shorthand does not broaden workspace permission`);
    const open = await call(null, 'GET', at(id), undefined, { base: OPENVIEW });
    check(open.status === 200 && open.body?.['@id'] === id, `${kind}: OpenView short link preserves stored identity`, open.text);
    const body = { ...modern.body, 'schema:description': 'Updated through the short address' };
    checkStatus(await updateArtifact(auth, at(id), body), 200, `${kind}: short-address update accepts the full document identity`);
    checkStatus(await call(auth, 'PUT', at(id), body, { headers: { 'If-Match': modern.headers.get('etag') } }), 412,
      `${kind}: a legacy revision is fenced after a short-address update`);
  }
  if (template) {
    const copy = await call(auth, 'POST', '/command/copy-artifact-to-folder', {
      '@id': selector(template), targetFolderId: selector(fid), nameTemplate: `Addressing copy ${RUN}`,
    });
    if (checkStatus(copy, 201, 'copy accepts typed source and destination selectors')) {
      const id = copy.body['@id'];
      cleanup('template', at(id), `Addressing copy ${RUN}`, undefined, undefined, id);
      checkStatus(await mutate(auth, 'POST', '/command/move-resource-to-folder', {
        '@id': selector(id), targetFolderId: selector(homeFolderId),
      }, { etagPath: at(id) + '/details' }), 201, 'move accepts typed source and destination selectors');
    }
    const search = await call(auth, 'GET', `/search?is_based_on=${enc(selector(template))}`);
    checkStatus(search, 200, 'search accepts a typed template selector');
    check(new URL(search.body.paging.first).searchParams.get('is_based_on') === selector(template),
      'search paging links retain the type-qualified selector', JSON.stringify(search.body.paging));
  }
  checkStatus(await call(auth, 'GET', '/templates/' + enc(selector(fid))), 400,
    'a typed selector cannot be used on the wrong resource route');
  await groupAddressing(user1, user2);
  await categoryAddressing(user1, user2, admin);
  return {};
}

async function groupAddressing(user1, user2) {
  suite('addressing: group aliases');
  const direct = `http://${process.env.CEDAR_GROUP_SERVER_HOST ?? 'localhost'}:${process.env.CEDAR_GROUP_HTTP_PORT ?? '9009'}`;
  const request = (auth, method, path, body, opts = {}) => call(auth, method, path, body, { ...opts, base: direct });
  const label = `Addressed group ${RUN}`;
  const made = await request(user1.auth, 'POST', '/groups', { 'schema:name': label, 'schema:description': 'aliases' });
  if (!checkStatus(made, 201, 'group fixture created')) return;
  const id = made.body['@id'];
  const full = '/groups/' + enc(id);
  const short = at(id);
  cleanup('group', full, label, user1.auth, direct, id);
  for (const suffix of ['', '/users', '/membership/me']) {
    const legacy = await request(user1.auth, 'GET', full + suffix);
    const modern = await request(user1.auth, 'GET', short + suffix);
    checkStatus(modern, 200, `group${suffix}: UUID route is readable directly`);
    check(JSON.stringify(legacy.body) === JSON.stringify(modern.body) && legacy.headers.get('etag') === modern.headers.get('etag'),
      `group${suffix}: aliases return the same body and revision`, modern.text);
    checkStatus(await request(null, 'GET', short + suffix), 401, `group${suffix}: UUID route still requires authentication`);
  }
  checkStatus(await request(user2.auth, 'GET', short + '/users'), 403, 'group UUID does not disclose membership to a non-administrator');
  const before = await request(user1.auth, 'GET', full);
  const body = { 'schema:name': label, 'schema:description': 'changed through UUID' };
  checkStatus(await request(user1.auth, 'PUT', short, body), 428, 'group UUID update requires If-Match');
  checkStatus(await request(user2.auth, 'PUT', short, body, { headers: { 'If-Match': before.headers.get('etag') } }),
    403, 'group UUID update preserves administration checks');
  const changed = await request(user1.auth, 'PUT', short, body, { headers: { 'If-Match': before.headers.get('etag') } });
  checkStatus(changed, 200, 'group UUID update accepts the full-address revision');
  check(changed.body?.['@id'] === id, 'group UUID update preserves the stored IRI', changed.text);
  checkStatus(await request(user1.auth, 'PUT', full, body, { headers: { 'If-Match': before.headers.get('etag') } }),
    412, 'group full-address revision becomes stale after UUID update');
  const patch = await request(user1.auth, 'PATCH', short, { 'schema:description': 'patched through UUID' },
    { contentType: 'application/merge-patch+json', headers: { 'If-Match': changed.headers.get('etag') } });
  checkStatus(patch, 200, 'group UUID merge patch succeeds');
  const members = await request(user1.auth, 'GET', full + '/users');
  const roster = { users: (members.body?.users ?? []).map(({ user, administrator, member }) =>
    ({ user: { '@id': user['@id'] }, administrator, member })) };
  checkStatus(await request(user1.auth, 'PUT', short + '/users', roster,
    { headers: { 'If-Match': members.headers.get('etag') } }), 200, 'group UUID membership replacement accepts the full-address revision');
  checkStatus(await request(user1.auth, 'PUT', full + '/users', roster,
    { headers: { 'If-Match': members.headers.get('etag') } }), 412, 'group membership revision is shared by both addresses');
  checkStatus(await request(user1.auth, 'GET', '/groups/' + enc('categories/' + id.split('/').at(-1))),
    400, 'group route rejects a category selector');
  const current = await request(user1.auth, 'GET', full);
  checkStatus(await request(user1.auth, 'DELETE', short, undefined, { headers: { 'If-Match': current.headers.get('etag') } }),
    204, 'group UUID deletion accepts the full-address revision');
  checkStatus(await request(user1.auth, 'GET', full), 404, 'group UUID deletion removes the full-address resource');
}

async function categoryAddressing(user1, user2, admin) {
  suite('addressing: category aliases');
  if (!check(!!admin, 'category addressing has administrator credentials', 'administrator fixture unavailable')) return;
  const request = (auth, method, path, body, opts = {}) => call(auth, method, path, body, { ...opts, base: resourceDirect });
  const root = await request(admin.auth, 'GET', '/categories/root');
  if (!checkStatus(root, 200, 'category root alias remains readable')) return;
  const rootId = root.body['@id'];
  checkStatus(await request(admin.auth, 'DELETE', at(rootId), undefined, { headers: { 'If-Match': '*' } }),
    403, 'category root remains protected through its UUID');
  const label = `Addressed category ${RUN}`;
  const made = await request(admin.auth, 'POST', '/categories',
    { 'schema:name': label, 'schema:description': 'aliases', parentCategoryId: rootId });
  if (!checkStatus(made, 201, 'category fixture created')) return;
  const id = made.body['@id'];
  const full = '/categories/' + enc(id);
  const short = at(id);
  cleanup('category', full, label, admin.auth, undefined, id);
  for (const suffix of ['', '/permissions']) {
    const legacy = await request(admin.auth, 'GET', full + suffix);
    const modern = await request(admin.auth, 'GET', short + suffix);
    checkStatus(modern, 200, `category${suffix}: UUID route is readable directly`);
    check(JSON.stringify(legacy.body) === JSON.stringify(modern.body) && legacy.headers.get('etag') === modern.headers.get('etag'),
      `category${suffix}: aliases return the same body and revision`, modern.text);
    checkStatus(await request(null, 'GET', short + suffix), 401, `category${suffix}: UUID route still requires authentication`);
  }
  const before = await request(admin.auth, 'GET', full);
  const body = { 'schema:name': label, 'schema:description': 'changed through UUID' };
  checkStatus(await request(admin.auth, 'PUT', short, body), 428, 'category UUID update requires If-Match');
  checkStatus(await request(user2.auth, 'PUT', short, body, { headers: { 'If-Match': before.headers.get('etag') } }),
    403, 'category UUID update preserves capability checks');
  checkStatus(await request(admin.auth, 'PUT', short, body, { headers: { 'If-Match': before.headers.get('etag') } }),
    200, 'category UUID update accepts the full-address revision');
  checkStatus(await request(admin.auth, 'PUT', full, body, { headers: { 'If-Match': before.headers.get('etag') } }),
    412, 'category full-address revision becomes stale after UUID update');
  const permissions = await request(admin.auth, 'GET', full + '/permissions');
  const grants = { userPermissions: [], groupPermissions: [] };
  const replaced = await request(admin.auth, 'PUT', short + '/permissions', grants,
    { headers: { 'If-Match': permissions.headers.get('etag') } });
  checkStatus(replaced, 200, 'category UUID grant replacement accepts the full-address revision');
  checkStatus(await request(admin.auth, 'PUT', full + '/permissions', grants,
    { headers: { 'If-Match': permissions.headers.get('etag') } }), 412, 'category permission revision is shared by both addresses');
  const transfer = { newOwnerId: user1.profile['@id'] };
  checkStatus(await request(user2.auth, 'PATCH', short + '/permissions', transfer, { headers: { 'If-Match': '*' } }),
    403, 'category UUID transfer still requires ownership');
  const transferred = await request(admin.auth, 'PATCH', short + '/permissions', transfer,
    { headers: { 'If-Match': replaced.headers.get('etag') } });
  checkStatus(transferred, 200, 'category UUID ownership transfer succeeds');
  const currentPermissions = await request(user1.auth, 'GET', full + '/permissions');
  check(currentPermissions.body?.owner?.['@id'] === user1.profile['@id'],
    'category ownership changed at the full address', currentPermissions.text);
  checkStatus(await request(user1.auth, 'GET', '/categories/' + enc('groups/' + id.split('/').at(-1))),
    400, 'category route rejects a group selector');
  const current = await request(user1.auth, 'GET', full);
  checkStatus(await request(user1.auth, 'DELETE', short, undefined, { headers: { 'If-Match': current.headers.get('etag') } }),
    204, 'category UUID deletion accepts the full-address revision');
  checkStatus(await request(user1.auth, 'GET', full), 404, 'category UUID deletion removes the full-address resource');
}
