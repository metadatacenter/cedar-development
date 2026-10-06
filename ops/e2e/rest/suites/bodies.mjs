// Every write that takes a JSON body, given each kind of body it must refuse.
//
// A request body is read four ways across the services: through CedarRequestBody with a NonEmpty
// assertion, by converting it with the strict Jackson mapper, as a raw string the handler parses
// itself, and through a request type of its own. Whether a property the write does not take is
// refused was also decided write by write. A body that is not JSON, has no content, is an array or a
// bare value, is an empty object, or carries a property the write does not take must be refused with
// 400 whichever way it is read. Two such bodies used to answer 500, and an empty permissions document
// removed every grant on its resource.
//
// A schema artifact's body is the artifact itself, and the meta-schemas leave open which other
// top-level properties one may carry, so an artifact write is not sent a property it does not take.
// Whether they should close that set is a rule still to be decided.
//
// Each write is sent its malformed bodies with the current If-Match where it is conditional, so the
// body and not the precondition decides the answer. The publishing and drafting commands are left
// out: one that took a body by mistake would publish the artifact the other rows write to, and both
// read their bodies through the same strict paths the rows here exercise.
import {
  suite, check, checkStatus, call, mutate, group, cleanup, artifactBody, enc, RUN, GROUP_SERVER,
} from '../lib.mjs';

export const name = 'bodies';

/** The bodies a write must refuse, made from the write's valid body. */
const MALFORMED = [
  { name: 'a body that is not JSON', body: () => '{"schema:name": ' },
  { name: 'an empty body', body: () => '' },
  { name: 'an array', body: () => [] },
  { name: 'a bare number', body: () => 42 },
  { name: 'an empty object', body: () => ({}) },
  { name: 'a property the write does not take', body: valid => ({ ...valid, bogusProperty: true }), closed: true },
];

export async function run({ user1, admin, folderId }) {
  const auth = user1.auth;
  suite('bodies: the fixtures every write is sent to');

  const folderName = `Bodies Folder ${RUN}`;
  const folder = await call(auth, 'POST', '/folders', { folderId, name: folderName, description: 'body table' });
  if (!checkStatus(folder, 201, 'a folder is created to write to')) return {};
  const fid = folder.body['@id'];
  const folderAt = `/folders/${enc(fid)}`;
  cleanup('folder', folderAt, folderName);

  const templateName = `Bodies Template ${RUN}`;
  const template = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', templateName));
  if (!checkStatus(template, 201, 'a template is created to write to')) return {};
  const tid = template.body['@id'];
  const templateAt = `/templates/${enc(tid)}`;
  cleanup('template', templateAt, templateName);

  const groupName = `Bodies Group ${RUN}`;
  const made = await group(auth, 'POST', '/groups', { 'schema:name': groupName, 'schema:description': 'body table' });
  if (!checkStatus(made, 201, 'a group is created to write to')) return {};
  const gid = made.body['@id'];
  const groupAt = `/groups/${enc(gid)}`;
  cleanup('group', groupAt, groupName, auth, GROUP_SERVER);
  const members = (await group(auth, 'GET', `${groupAt}/users`)).body?.users ?? [];
  const membership = {
    users: members.map(m => ({ user: { '@id': m.user['@id'] }, administrator: m.administrator, member: m.member })),
  };

  let categoryAt;
  let rootCategoryId;
  if (check(!!admin, 'the administrator key is configured, so the category writes can be sent')) {
    rootCategoryId = (await call(admin.auth, 'GET', '/categories/root')).body?.['@id'];
    const categoryName = `Bodies Category ${RUN}`;
    const category = await call(admin.auth, 'POST', '/categories', {
      'schema:name': categoryName, 'schema:description': 'body table', parentCategoryId: rootCategoryId,
      'schema:identifier': `bodies-${RUN}`,
    });
    if (checkStatus(category, 201, 'a category is created to write to')) {
      categoryAt = `/categories/${enc(category.body['@id'])}`;
      cleanup('category', categoryAt, categoryName, admin.auth);
    }
  }

  // A write: how it is sent, and the body it takes when nothing is wrong with it.
  const writes = [
    { name: 'create a folder', method: 'POST', path: '/folders',
      valid: { folderId, name: `Bodies Extra ${RUN}`, description: 'never created' } },
    { name: 'rename a folder', method: 'PUT', path: folderAt, etag: folderAt,
      valid: { 'schema:name': `${folderName} renamed`, 'schema:description': 'renamed' } },
    { name: "replace a folder's permissions", method: 'PUT', path: `${folderAt}/permissions`,
      etag: `${folderAt}/permissions`, valid: { userPermissions: [], groupPermissions: [] } },
    { name: 'create a template', method: 'POST', path: `/templates?folder_id=${enc(folderId)}`, artifact: true,
      valid: artifactBody('template', `Bodies Extra Template ${RUN}`) },
    { name: 'create an element', method: 'POST', path: `/template-elements?folder_id=${enc(folderId)}`,
      artifact: true, valid: artifactBody('element', `Bodies Extra Element ${RUN}`) },
    { name: 'create a field', method: 'POST', path: `/template-fields?folder_id=${enc(folderId)}`, artifact: true,
      valid: artifactBody('field', `Bodies Extra Field ${RUN}`) },
    { name: 'update a template', method: 'PUT', path: templateAt, etag: templateAt, artifact: true,
      valid: template.body },
    { name: 'check whether a template can be updated', method: 'POST', artifact: true,
      path: `/command/check-update-template/${enc(tid)}`, valid: template.body },
    { name: 'rename by command', method: 'POST', path: '/command/rename-resource', etag: folderAt,
      valid: { '@id': fid, 'schema:name': `${folderName} again` } },
    { name: 'move by command', method: 'POST', path: '/command/move-resource-to-folder',
      etag: `${templateAt}/details`, valid: { '@id': tid, targetFolderId: fid } },
    { name: 'copy by command', method: 'POST', path: '/command/copy-artifact-to-folder',
      valid: { '@id': tid, targetFolderId: fid } },
    { name: 'open a folder', method: 'POST', path: '/command/make-folder-open', etag: folderAt,
      valid: { '@id': fid } },
    { name: 'open an artifact', method: 'POST', path: '/command/make-artifact-open', etag: `${templateAt}/details`,
      valid: { '@id': tid } },
    { name: 'preview an inclusion update', method: 'POST', path: '/command/inclusions-subgraph-preview',
      valid: { '@id': tid } },
    { name: 'create a group', method: 'POST', path: '/groups', base: GROUP_SERVER,
      valid: { 'schema:name': `Bodies Extra Group ${RUN}`, 'schema:description': 'never created' } },
    { name: 'rename a group', method: 'PUT', path: groupAt, etag: groupAt, base: GROUP_SERVER,
      valid: { 'schema:name': `${groupName} renamed`, 'schema:description': 'renamed' } },
    { name: 'patch a group', method: 'PATCH', path: groupAt, etag: groupAt, base: GROUP_SERVER,
      contentType: 'application/merge-patch+json', valid: { 'schema:description': 'patched' } },
    { name: "replace a group's members", method: 'PUT', path: `${groupAt}/users`, etag: `${groupAt}/users`,
      base: GROUP_SERVER, valid: membership },
  ];
  if (categoryAt) {
    writes.push(
      { name: 'create a category', method: 'POST', path: '/categories', auth: admin.auth,
        valid: { 'schema:name': `Bodies Extra Category ${RUN}`, 'schema:description': 'never created',
          parentCategoryId: rootCategoryId, 'schema:identifier': `bodies-extra-${RUN}` } },
      { name: 'rename a category', method: 'PUT', path: categoryAt, etag: categoryAt, auth: admin.auth,
        valid: { 'schema:name': `Bodies Category ${RUN} renamed`, 'schema:description': 'renamed' } },
      { name: 'attach a category', method: 'POST', path: '/command/attach-category',
        valid: { artifactId: tid, categoryId: decodeURIComponent(categoryAt.split('/').pop()) } });
  }

  suite('bodies: every write refuses every malformed body with 400');

  for (const write of writes) {
    for (const malformed of MALFORMED) {
      if (write.artifact && malformed.closed) continue;
      const body = malformed.body(write.valid);
      const who = write.auth ?? auth;
      const opts = { base: write.base, contentType: write.contentType };
      const answer = write.etag
          ? await mutate(who, write.method, write.path, body, { ...opts, etagPath: write.etag })
          : await call(who, write.method, write.path, body, opts);
      // A write that took a body it should have refused may have made something; it goes too.
      const madeId = answer.status >= 200 && answer.status < 300 ? answer.body?.['@id'] : undefined;
      if (madeId && ![fid, tid, gid].includes(madeId)) {
        if (write.base === GROUP_SERVER) cleanup('group', `/groups/${enc(madeId)}`, 'accepted by mistake', who, GROUP_SERVER);
        else if (write.path.startsWith('/categories')) cleanup('category', `/categories/${enc(madeId)}`, 'accepted by mistake', who);
        else if (madeId.includes('/folders/')) cleanup('folder', `/folders/${enc(madeId)}`, 'accepted by mistake');
        else {
          const kind = ['template-instances', 'template-elements', 'template-fields', 'templates']
              .find(path => madeId.includes(`/${path}/`));
          if (kind) cleanup({ templates: 'template', 'template-elements': 'element', 'template-fields': 'field',
            'template-instances': 'instance' }[kind], `/${kind}/${enc(madeId)}`, 'accepted by mistake');
        }
      }
      check(answer.status === 400, `${write.name}: ${malformed.name} is refused with 400`,
          `got ${answer.status}: ${(answer.text ?? '').slice(0, 200)}`);
    }
  }

  return {};
}
