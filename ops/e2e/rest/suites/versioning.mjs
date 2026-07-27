// Publish and create-draft: two-service writes that no test exercised before these suites.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

export const name = 'versioning';

export async function run({ user1, folderId }) {
  const auth = user1.auth;
  suite('versioning: publish, then draft the published version');

  const name0 = `Versioned Template ${RUN}`;
  const post = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', name0));
  if (!checkStatus(post, 201, 'template created')) return {};
  const id = post.body['@id'];
  const at = `/templates/${enc(id)}`;
  cleanup('template', at, name0);

  check((await call(auth, 'GET', at)).body?.['bibo:status'] === 'bibo:draft',
      'a new template is a draft', 'it was not');

  const publish = await call(auth, 'POST', '/command/publish-artifact', { '@id': id, newVersion: '1.0.0' });
  if (checkStatus(publish, [200, 201], 'template published')) {
    const after = await call(auth, 'GET', at);
    check(after.body?.['bibo:status'] === 'bibo:published', 'publishing set the status to published',
        `status was ${after.body?.['bibo:status']}`);
    check(after.body?.['pav:version'] === '1.0.0', 'publishing set the requested version',
        `version was ${after.body?.['pav:version']}`);

    const draft = await call(auth, 'POST', '/command/create-draft-artifact',
        { '@id': id, folderId, newVersion: '1.0.1', propagateVersion: false });
    if (checkStatus(draft, [200, 201], 'draft created from the published version')) {
      const draftId = draft.body?.['@id'];
      if (draftId && draftId !== id) cleanup('template', `/templates/${enc(draftId)}`, `${name0} draft`);
      const versions = await call(auth, 'GET', `${at}/versions`);
      check(versions.status === 200 && JSON.stringify(versions.body ?? {}).includes('1.0.1'),
          'the version chain records the new draft',
          `${versions.status}: ${(versions.text ?? '').slice(0, 200)}`);
    }

    // A draft cannot be drafted again — the rule the lifecycle table pins, over HTTP.
    const draftAgain = await call(auth, 'POST', '/command/create-draft-artifact',
        { '@id': id, folderId, newVersion: '9.9.9', propagateVersion: false });
    check(draftAgain.status >= 400, 'drafting from a version that already has a successor is refused',
        `expected 4xx, got ${draftAgain.status}`);
  }

  suite('versioning: a known defect, pinned');

  // Re-publishing a published artifact SUCCEEDS and should not. resourceCanBePublished refuses a
  // non-draft with PUBLISH_ONLY_DRAFT, but the check sits inside
  // `if (resource instanceof ...AndPublicationStatus)` and the type the endpoint passes does not
  // implement that interface, so it is skipped silently. See the roadmap. When it is fixed this
  // check fails and should become an expectation of 4xx.
  const second = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', `Republish Probe ${RUN}`));
  if (second.status === 201) {
    const sid = second.body['@id'];
    cleanup('template', `/templates/${enc(sid)}`, `Republish Probe ${RUN}`);
    await call(auth, 'POST', '/command/publish-artifact', { '@id': sid, newVersion: '1.0.0' });
    const again = await call(auth, 'POST', '/command/publish-artifact', { '@id': sid, newVersion: '1.0.1' });
    check(again.status === 200,
        'KNOWN DEFECT pinned: re-publishing a published artifact is allowed',
        `expected the current behaviour of 200, got ${again.status} — if refused, the defect is fixed`);
  }

  return {};
}
