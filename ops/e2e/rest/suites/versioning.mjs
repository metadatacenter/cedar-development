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

  suite('versioning: a published artifact cannot be published again');

  // A published artifact is immutable, so re-publishing it is refused. The publish endpoint now reads
  // the artifact's real status back from the artifact server and rejects a non-draft, rather than
  // trusting a precomputed can-publish flag that was wrongly true for an already-published artifact.
  const second = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', `Republish Probe ${RUN}`));
  if (second.status === 201) {
    const sid = second.body['@id'];
    cleanup('template', `/templates/${enc(sid)}`, `Republish Probe ${RUN}`);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', { '@id': sid, newVersion: '1.0.0' }),
        [200, 201], 'the probe template is published once');
    const again = await call(auth, 'POST', '/command/publish-artifact', { '@id': sid, newVersion: '1.0.1' });
    check(again.status >= 400,
        're-publishing an already-published artifact is refused',
        `expected 4xx, got ${again.status}: ${(again.text ?? '').slice(0, 120)}`);
  }

  suite('versioning: check-update-template');

  // check-update reports the changes between a stored template and a supplied definition, and how many
  // instances a destructive change would affect. With no instances there is nothing to migrate, so it
  // can always be updated; with an instance, the unchanged definition yields no changes.
  const cuName = `Check Update ${RUN}`;
  const cu = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', cuName));
  if (checkStatus(cu, 201, 'a template is created to check for update')) {
    const cuId = cu.body['@id'];
    cleanup('template', `/templates/${enc(cuId)}`, cuName);
    const body = (await call(auth, 'GET', `/templates/${enc(cuId)}`)).body;

    const zero = await call(auth, 'POST', `/command/check-update-template/${enc(cuId)}`, body);
    if (checkStatus(zero, 200, 'check-update answers for a template with no instances')) {
      check(zero.body?.canBeUpdated === true, 'a template with no instances can always be updated',
          `canBeUpdated was ${zero.body?.canBeUpdated}`);
    }

    const instName = `Check Update Instance ${RUN}`;
    const inst = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
        artifactBody('instance', instName, { 'schema:isBasedOn': cuId }));
    if (checkStatus(inst, 201, 'an instance is created on it')) {
      cleanup('instance', `/template-instances/${enc(inst.body['@id'])}`, instName);
      const same = await call(auth, 'POST', `/command/check-update-template/${enc(cuId)}`, body);
      if (checkStatus(same, 200, 'check-update answers with an instance present')) {
        check(same.body?.numberOfInstances === 1 && same.body?.destructiveChanges === 0
            && same.body?.nonDestructiveChanges === 0 && same.body?.canBeUpdated === true,
            'the unchanged definition reports one instance and no changes',
            `report was ${JSON.stringify(same.body).slice(0, 200)}`);
      }
    }
  }

  suite('versioning: publish-create-draft-template');

  // Publish a template and, in one call, create a fresh draft from it with the supplied definition.
  const pcdName = `Publish-Create-Draft ${RUN}`;
  const pcd = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', pcdName));
  if (checkStatus(pcd, 201, 'a template is created to publish-and-draft')) {
    const pcdId = pcd.body['@id'];
    cleanup('template', `/templates/${enc(pcdId)}`, pcdName);  // the source, which becomes published
    const body = (await call(auth, 'GET', `/templates/${enc(pcdId)}`)).body;
    const res = await call(auth, 'POST', `/command/publish-create-draft-template/${enc(pcdId)}`, body);
    if (checkStatus(res, [200, 201], 'publish-create-draft-template returns')) {
      const draftId = res.body?.['@id'];
      if (draftId && draftId !== pcdId) cleanup('template', `/templates/${enc(draftId)}`, `${pcdName} draft`);
      check((await call(auth, 'GET', `/templates/${enc(pcdId)}`)).body?.['bibo:status'] === 'bibo:published',
          'the source template is now published', 'the source was not published');
      check(res.body?.['bibo:status'] === 'bibo:draft', 'and the returned artifact is a new draft',
          `the returned status was ${res.body?.['bibo:status']}`);
    }
  }

  return {};
}
