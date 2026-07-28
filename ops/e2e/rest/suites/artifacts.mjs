// CRUD for every artifact kind, through the resource server.
//
// This is the core write path of the product and had no coverage of any sort before these suites:
// a create proxies its content to the artifact server, so the per-service tests cannot follow it,
// and they only assert the rejections that fire before the proxy.
import { suite, check, checkStatus, call, cleanup, artifactBody, KINDS, enc, RUN } from '../lib.mjs';

export const name = 'artifacts';

export async function run({ user1, user2, folderId }) {
  suite('artifacts: create, read, update, delete per kind');
  const auth = user1.auth;
  const made = {};

  // A template first: an instance must be based on one, so the order matters.
  for (const { kind, path, versioned } of KINDS) {
    const label = `${kind} ${RUN}`;
    const extra = kind === 'instance' && made.template
        ? { 'schema:isBasedOn': made.template.id }
        : {};
    const post = await call(auth, 'POST', `${path}?folder_id=${enc(folderId)}`,
        artifactBody(kind, label, extra));
    if (!checkStatus(post, 201, `${kind}: created`)) continue;

    const id = post.body['@id'];
    const at = `${path}/${enc(id)}`;
    made[kind] = { id, at, label };
    cleanup(kind, at, label);

    // Read back, and check it is the same artifact rather than merely a 200.
    const get = await call(auth, 'GET', at);
    checkStatus(get, 200, `${kind}: read back`);
    check(get.body?.['schema:name'] === label, `${kind}: served content matches what was stored`,
        `expected "${label}", got "${get.body?.['schema:name']}"`);

    // The graph's view must agree with the artifact server's.
    const details = await call(auth, 'GET', `${at}/details`);
    checkStatus(details, 200, `${kind}: details`);
    check(details.body?.['schema:name'] === label,
        `${kind}: the graph and the artifact server agree on the name`,
        `details said "${details.body?.['schema:name']}"`);

    const report = await call(auth, 'GET', `${at}/report`);
    checkStatus(report, 200, `${kind}: report`);

    // Only the schema kinds are versioned; asserting /versions on an instance would pin a 404
    // that says nothing.
    if (versioned) {
      checkStatus(await call(auth, 'GET', `${at}/versions`), 200, `${kind}: versions`);
    }

    checkStatus(await call(auth, 'GET', `${at}/permissions`), 200, `${kind}: permissions`);

    // Update. The mirror of the create rule: an update must carry the identifier a create must omit.
    const updated = artifactBody(kind, label, extra);
    updated['@id'] = id;
    updated['schema:description'] = 'Updated by the REST suites';
    const put = await call(auth, 'PUT', at, updated);
    if (checkStatus(put, 200, `${kind}: updated`)) {
      const after = await call(auth, 'GET', at);
      check(after.body?.['schema:description'] === 'Updated by the REST suites',
          `${kind}: the update is visible on a fresh read`,
          `description was "${after.body?.['schema:description']}"`);
    }
  }

  suite('artifacts: the rules a create and an update must follow');

  // A create carrying an identifier is refused, and an update without one is too. The pair is worth
  // asserting together: they are opposite requirements on the same field, which is the kind of
  // asymmetry a client gets wrong.
  const withId = artifactBody('template', `id-on-create ${RUN}`);
  withId['@id'] = 'https://repo.metadatacenter.orgx/templates/deadbeef-0000-0000-0000-000000000000';
  checkStatus(await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, withId),
      400, 'a create carrying an identifier is refused');

  if (made.template) {
    const noId = artifactBody('template', made.template.label);
    checkStatus(await call(auth, 'PUT', made.template.at, noId),
        400, 'an update without an identifier is refused');
  }

  // Nonsense in, error out — not a 500.
  const junk = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      { 'schema:name': 'not a template at all' });
  check(junk.status === 400, 'a body that is not an artifact is refused with 400',
      `expected 400, got ${junk.status} — a 500 here would mean an unhandled path`);

  // A versioned artifact created without pav:version is a client mistake — a 400, not a 500. Fields
  // are the case that regressed: the artifact server accepts a field with no version where it rejects
  // a template or element, so the field alone reached the resource server's own NonEmpty check, whose
  // 400 was then swallowed by a broad catch and reported as a 500. A field body works here precisely
  // because it is otherwise well-formed enough to be accepted that far.
  const noVersion = artifactBody('field', `no-version ${RUN}`);
  delete noVersion['pav:version'];
  const nv = await call(auth, 'POST', `/template-fields?folder_id=${enc(folderId)}`, noVersion);
  if (nv.status === 201) cleanup('field', `/template-fields/${enc(nv.body['@id'])}`, `no-version ${RUN}`);
  check(nv.status === 400, 'a versioned artifact with no pav:version is refused with 400',
      `expected 400, got ${nv.status} — a 500 here is the swallowed-status regression`);

  // An unknown identifier reads as absent rather than as an error.
  checkStatus(await call(auth, 'GET',
      `/templates/${enc('https://repo.metadatacenter.orgx/templates/00000000-0000-0000-0000-000000000000')}`),
      404, 'an unknown artifact answers 404');

  suite('artifacts: a DOI is set once, and only by someone with write access');

  // POST /command/annotations/doi sets an artifact's DOI. It needs write access, and a DOI is
  // write-once: setting the same value again is idempotent, changing it to a different value is
  // refused (doiCanNotBeAltered), and a user with no access to the artifact cannot set one at all.
  const doiName = `DOI Probe ${RUN}`;
  const forDoi = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', doiName));
  if (checkStatus(forDoi, 201, 'a template is created to give a DOI')) {
    const did = forDoi.body['@id'];
    cleanup('template', `/templates/${enc(did)}`, doiName);
    const doi = '10.1234/cedar-rest-suite';

    checkStatus(await call(auth, 'POST', '/command/annotations/doi', { '@id': did, doi }),
        200, 'the owner sets the DOI');
    checkStatus(await call(auth, 'POST', '/command/annotations/doi', { '@id': did, doi }),
        200, 'and setting the same DOI again is idempotent');

    const altered = await call(auth, 'POST', '/command/annotations/doi', { '@id': did, doi: '10.9999/changed' });
    if (checkStatus(altered, 400, 'but changing it to a different DOI is refused')) {
      check((altered.text ?? '').includes('doiCanNotBeAltered'),
          'and the body says the DOI cannot be altered',
          `body was ${(altered.text ?? '').slice(0, 200)}`);
    }

    checkStatus(await call(user2.auth, 'POST', '/command/annotations/doi', { '@id': did, doi: '10.5555/outsider' }),
        403, 'and a user with no write access to the artifact cannot set a DOI');
  }

  return made;
}
