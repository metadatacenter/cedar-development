// Exercise the actual service boundary, including direct ports: no nginx rewriting is involved.
import { suite, check, checkStatus, call, mutate, updateArtifact, cleanup, artifactBody,
  KINDS, RUN, enc, OPENVIEW, ARTIFACT_SERVER } from '../lib.mjs';
export const name = 'addressing';
const selector = iri => iri.split('/').slice(-2).join('/');
const at = iri => '/' + selector(iri);
const resourceDirect = `http://${process.env.CEDAR_RESOURCE_SERVER_HOST ?? 'localhost'}:${process.env.CEDAR_RESOURCE_HTTP_PORT ?? '9007'}`;

export async function run({ user1, user2, homeFolderId }) {
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
  checkStatus(await mutate(auth, 'POST', '/command/make-folder-open', { '@id': selector(fid) }, { etagPath: at(fid) }),
    200, 'folder openness accepts a type-qualified selector');
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
  return {};
}
