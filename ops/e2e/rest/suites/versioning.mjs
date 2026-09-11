// Publish and create-draft: two-service writes that no test exercised before these suites.
import { suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, poll, RUN } from '../lib.mjs';

export const name = 'versioning';

export async function run({ user1, user2, folderId, homeFolderId }) {
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
        { '@id': id, folderId, newVersion: '1.0.1', propagateSharing: false });
    if (checkStatus(draft, [200, 201], 'draft created from the published version')) {
      const draftId = draft.body?.['@id'];
      if (draftId && draftId !== id) cleanup('template', `/templates/${enc(draftId)}`, `${name0} draft`);
      const versions = await call(auth, 'GET', `${at}/versions`);
      check(versions.status === 200 && JSON.stringify(versions.body ?? {}).includes('1.0.1'),
          'the version chain records the new draft',
          `${versions.status}: ${(versions.text ?? '').slice(0, 200)}`);

      const fromDraft = await call(auth, 'POST', '/command/create-draft-artifact',
          { '@id': draftId, folderId, newVersion: '1.0.2', propagateSharing: false });
      if (fromDraft.status === 201 && fromDraft.body?.['@id']) {
        cleanup('template', `/templates/${enc(fromDraft.body['@id'])}`, `${name0} invalid draft`);
      }
      check(fromDraft.status >= 400, 'a draft cannot itself be drafted',
          `expected 4xx, got ${fromDraft.status}: ${(fromDraft.text ?? '').slice(0, 120)}`);
    }

    // Once a published version has a successor, it cannot produce another branch.
    const draftAgain = await call(auth, 'POST', '/command/create-draft-artifact',
        { '@id': id, folderId, newVersion: '9.9.9', propagateSharing: false });
    check(draftAgain.status >= 400, 'drafting again from a published version with a successor is refused',
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

  suite('versioning: versions advance and published content is immutable');

  const guardName = `Version Guard ${RUN}`;
  const guard = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', guardName));
  if (checkStatus(guard, 201, 'a template is created for lifecycle guards')) {
    const gid = guard.body['@id'];
    const gat = `/templates/${enc(gid)}`;
    cleanup('template', gat, guardName);

    checkStatus(await call(auth, 'POST', '/command/publish-artifact',
        { '@id': gid, newVersion: 'not-a-version' }), 400,
        'a malformed publication version is refused');
    checkStatus(await call(auth, 'POST', '/command/publish-artifact',
        { '@id': gid, newVersion: '0.0.0' }), 400,
        'a publication version below the current draft is refused');
    const stillDraft = await call(auth, 'GET', gat);
    check(stillDraft.body?.['bibo:status'] === 'bibo:draft'
        && stillDraft.body?.['pav:version'] === '0.0.1',
        'failed publication attempts leave the draft and version unchanged',
        `status ${stillDraft.body?.['bibo:status']}, version ${stillDraft.body?.['pav:version']}`);

    if (checkStatus(await call(auth, 'POST', '/command/publish-artifact',
        { '@id': gid, newVersion: '1.0.0' }), [200, 201], 'the next valid version publishes')) {
      for (const newVersion of ['1.0.0', '0.9.9']) {
        checkStatus(await call(auth, 'POST', '/command/create-draft-artifact',
            { '@id': gid, folderId, newVersion, propagateSharing: false }), 400,
            `a draft version ${newVersion === '1.0.0' ? 'equal to' : 'below'} its source is refused`);
      }

      const published = await call(auth, 'GET', gat);
      const replacement = structuredClone(published.body);
      replacement['schema:description'] = 'A published artifact must not accept this change';
      const changed = await call(auth, 'PUT', gat, replacement,
          { headers: { 'If-Match': published.headers.get('etag') } });
      if (checkStatus(changed, 400, 'published content cannot be updated')) {
        check((changed.text ?? '').includes('publishedArtifactCanNotBeChanged'),
            'the refusal identifies the published-content invariant',
            `body was ${(changed.text ?? '').slice(0, 200)}`);
      }
      const unchanged = await call(auth, 'GET', gat);
      check(unchanged.body?.['schema:description'] !== replacement['schema:description'],
          'the rejected update leaves published content unchanged',
          'the replacement description was stored despite the rejection');

      // This is the current, deliberate policy: publication makes content immutable but does not
      // make the resource undeletable. The documentation disagreement remains a separate roadmap item.
      checkStatus(await mutate(auth, 'DELETE', gat), [200, 204],
          'a published artifact remains deletable under the current policy');
      checkStatus(await call(auth, 'GET', gat), 404,
          'the published artifact is absent after that deletion');
    }
  }

  suite('versioning: ownership transfer moves versioning authority');

  const transferName = `Version Owner Transfer ${RUN}`;
  const transfer = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', transferName));
  if (checkStatus(transfer, 201, 'a template is created to transfer')) {
    const tid = transfer.body['@id'];
    const tat = `/templates/${enc(tid)}`;
    cleanup('template', tat, transferName);
    const ownership = await mutate(auth, 'POST', '/command/transfer-resource-ownership', {
      '@id': tid,
      newOwnerId: user2.profile['@id'],
    }, { etagPath: `${tat}/permissions` });
    if (checkStatus(ownership, 200, 'the owner transfers the artifact to the second user')) {
      const formerOwner = await call(auth, 'POST', '/command/publish-artifact',
          { '@id': tid, newVersion: '1.0.0' });
      check(formerOwner.status >= 400, 'the former owner can no longer publish it',
          `expected 4xx, got ${formerOwner.status}`);
      checkStatus(await call(user2.auth, 'POST', '/command/publish-artifact',
          { '@id': tid, newVersion: '1.0.0' }), [200, 201],
          'the new owner can publish it');
      checkStatus(await mutate(user2.auth, 'POST', '/command/transfer-resource-ownership', {
        '@id': tid,
        newOwnerId: user1.profile['@id'],
      }, { etagPath: `${tat}/permissions` }), 200,
      'the new owner can transfer it back to the former owner');
    }
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

  suite('versioning: drafting a published template copies its instances');

  // `newFolderName` asks for the published template's instances to be copied alongside the draft.
  // The command creates the folder and answers 201 straight away; the copying itself runs on the
  // worker queue, so the folder existing proves nothing. A clone that fails leaves the folder empty
  // and says nothing, which is what a person sees: a new folder holding none of their metadata. The
  // count is therefore the assertion, and the folder is only the place to count.
  const INSTANCES = 2;
  const cloneName = `Cloned Template ${RUN}`;
  const cloneSource = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', cloneName));
  if (checkStatus(cloneSource, 201, 'a template is created to clone instances from')) {
    const cloneId = cloneSource.body['@id'];
    cleanup('template', `/templates/${enc(cloneId)}`, cloneName);
    const published = await call(auth, 'POST', '/command/publish-artifact',
        { '@id': cloneId, newVersion: '1.0.0' });

    if (checkStatus(published, [200, 201], 'the template to clone from is published')) {
      for (let i = 1; i <= INSTANCES; i++) {
        const instanceName = `Cloned Instance ${i} ${RUN}`;
        const made = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
            artifactBody('instance', instanceName, { 'schema:isBasedOn': cloneId }));
        if (made.status === 201) {
          cleanup('instance', `/template-instances/${enc(made.body['@id'])}`, instanceName);
        }
      }

      const copiesName = `Cloned Instances ${RUN}`;
      const draft = await call(auth, 'POST', '/command/create-draft-artifact',
          { '@id': cloneId, folderId, newVersion: '1.0.1', propagateSharing: true, newFolderName: copiesName });
      if (checkStatus(draft, [200, 201], 'a draft is created asking for the instances to be copied')) {
        const draftId = draft.body?.['@id'];
        if (draftId && draftId !== cloneId) {
          cleanup('template', `/templates/${enc(draftId)}`, `${cloneName} draft`);
        }

        // The copies land under the owner's home folder, one folder per owner, so home is where to
        // look rather than the folder the draft was asked for.
        const parent = homeFolderId ?? folderId;
        const folder = await poll(async () => {
          const contents = await call(auth, 'GET', `/folders/${enc(parent)}/contents?limit=500`);
          const hit = (contents.body?.resources ?? []).find(
              r => r.resourceType === 'folder' && r['schema:name'] === copiesName);
          return hit ? { done: true, id: hit['@id'] } : { done: false };
        });

        if (check(folder.done, 'the folder for the copied instances appears',
            `no folder named "${copiesName}" after ${folder.attempts} tries`)) {
          cleanup('folder', `/folders/${enc(folder.id)}`, copiesName);
          const counted = await poll(async () => {
            const contents = await call(auth, 'GET', `/folders/${enc(folder.id)}/contents?limit=500`);
            const copies = (contents.body?.resources ?? []).filter(r => r.resourceType === 'instance');
            return { done: copies.length >= INSTANCES, copies };
          });
          for (const copy of counted.copies ?? []) {
            cleanup('instance', `/template-instances/${enc(copy['@id'])}`, copy['schema:name']);
          }
          check((counted.copies ?? []).length === INSTANCES,
              'and it holds every instance the published template had',
              `${(counted.copies ?? []).length} of ${INSTANCES} after ${counted.attempts} tries`
              + ' — a clone that fails dead-letters and leaves the folder empty');
        }
      }
    }
  }

  return {};
}
