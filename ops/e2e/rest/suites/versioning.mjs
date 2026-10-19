// Publish and create-draft: two-service writes that no test exercised before these suites.
import { isDeepStrictEqual } from 'node:util';
import { suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, mintId, poll, RUN } from '../lib.mjs';

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
      checkStatus(fromDraft, 400, 'a draft cannot itself be drafted');
    }

    // Once a published version has a successor, it cannot produce another branch.
    const draftAgain = await call(auth, 'POST', '/command/create-draft-artifact',
        { '@id': id, folderId, newVersion: '9.9.9', propagateSharing: false });
    checkStatus(draftAgain, 400, 'drafting again from a published version with a successor is refused');
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
    checkStatus(again, 400, 're-publishing an already-published artifact is refused');
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
      // The former owner still owns the folder the template sits in, so they can still read it, and
      // the command refuses them under the rule that only an owner publishes. An operation only the
      // owner may perform answers 403 to anyone else, whatever role they hold, with the rule's own key.
      const formerOwner = await call(auth, 'POST', '/command/publish-artifact',
          { '@id': tid, newVersion: '1.0.0' });
      check(formerOwner.status === 403 && formerOwner.body?.errorKey === 'versioningOnlyByOwner',
          'the former owner can no longer publish it',
          `expected 403 versioningOnlyByOwner, got ${formerOwner.status}: ${(formerOwner.text ?? '').slice(0, 300)}`);
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

  suite('versioning: reconnect deleted versions and maintain graph/search flags');
  for (const [kind, collection] of [['template', 'templates'], ['element', 'template-elements'], ['field', 'template-fields']]) {
    const label = `VersionChain${kind}${RUN.replace(/[^0-9]/g, '')}`;
    checkStatus(await call(auth, 'POST', `/${collection}?folder_id=${enc(folderId)}`,
        {...artifactBody(kind, label), 'bibo:status': 'bibo:published'}), 400,
        `${kind}: creation cannot bypass publication`);
    const made = await call(auth, 'POST', `/${collection}?folder_id=${enc(folderId)}`, artifactBody(kind, label));
    if (!checkStatus(made, 201, `${kind}: create chain root`)) continue;
    const a = made.body['@id'];
    const at = id => `/${collection}/${enc(id)}`;
    cleanup(kind, at(a), label);
    const original = await call(auth, 'GET', at(a));
    for (const change of [{'bibo:status': 'bibo:published'}, {'pav:version': '4.0.0'}, {'pav:previousVersion': a}]) {
      checkStatus(await call(auth, 'PUT', at(a), {...original.body, ...change},
          {headers: {'If-Match': original.headers.get('etag')}}), 400, `${kind}: ordinary editing cannot change lifecycle metadata`);
    }
    if (!checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': a, newVersion: '1.0.0'}), 200,
        `${kind}: publish root`)) continue;
    const next = await call(auth, 'POST', '/command/create-draft-artifact',
        {'@id': a, folderId, newVersion: '2.0.0', propagateSharing: false});
    if (!checkStatus(next, 201, `${kind}: create second version`)) continue;
    const b = next.body['@id']; cleanup(kind, at(b), `${label} B`);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': b, newVersion: '2.0.0'}), 200,
        `${kind}: publish second version`);
    const copied = await call(auth, 'POST', '/command/copy-artifact-to-folder',
        {'@id': b, targetFolderId: folderId, nameTemplate: `Independent${kind}${RUN.replace(/[^0-9]/g, '')}`});
    if (checkStatus(copied, 201, `${kind}: copy a later published version`)) {
      const copyId = copied.body['@id']; cleanup(kind, at(copyId), `${label} independent copy`);
      const copy = (await call(auth, 'GET', at(copyId))).body;
      check(copy?.['pav:version'] === '0.0.1' && copy?.['bibo:status'] === 'bibo:draft'
          && !Object.hasOwn(copy, 'pav:previousVersion') && copy?.['pav:derivedFrom'] === b,
          `${kind}: copy starts a separate draft series and keeps derivation only`, JSON.stringify(copy));
    }
    const competing = await Promise.all([1, 2].map(() => call(auth, 'POST', '/command/create-draft-artifact',
        {'@id': b, folderId, newVersion: '3.0.0', propagateSharing: false})));
    const winners = competing.filter(r => r.status === 201);
    for (const r of winners) cleanup(kind, at(r.body['@id']), `${label} C`);
    if (!check(winners.length === 1, `${kind}: concurrent drafting creates exactly one successor`,
        competing.map(r => r.status).join(', '))) continue;
    const c = winners[0].body['@id'];
    const before = (await call(auth, 'GET', at(c))).body;
    checkStatus(await mutate(auth, 'DELETE', at(b)), [202, 204], `${kind}: delete the published middle version`);
    const repaired = await poll(async () => {
      const body = (await call(auth, 'GET', at(c))).body;
      return {done: body?.['pav:previousVersion'] === a, body};
    });
    check(repaired.done, `${kind}: the draft document reconnects to the earlier release`, JSON.stringify(repaired.body));
    const expected = structuredClone(before); expected['pav:previousVersion'] = a;
    check(isDeepStrictEqual(repaired.body, expected),
        `${kind}: reconnecting preserves all other document content and provenance`, 'unexpected document changes');
    const root = (await call(auth, 'GET', `${at(a)}/details`)).body;
    const draft = (await call(auth, 'GET', `${at(c)}/details`)).body;
    check(root?.isLatestVersion === false && root?.isLatestPublishedVersion === true && root?.isLatestDraftVersion === false,
        `${kind}: previous release is promoted without displacing the draft`, JSON.stringify(root));
    check(draft?.isLatestVersion === true && draft?.isLatestDraftVersion === true && draft?.isLatestPublishedVersion === false,
        `${kind}: the draft remains the latest version`, JSON.stringify(draft));
    const listed = await call(auth, 'GET', `/folders/${enc(folderId)}/contents?version=latest-by-status&limit=500`);
    const listedIds = (listed.body?.resources ?? []).filter(r => r['schema:name'] === label).map(r => r['@id']).sort();
    check(isDeepStrictEqual(listedIds, [a,c].sort()), `${kind}: graph Latest listing agrees with the surviving series`, JSON.stringify(listedIds));
    const results = await poll(async () => {
      const result = await call(auth, 'GET', `/search?q=${enc(label)}&version=latest-by-status&limit=20`);
      const ids = (result.body?.resources ?? []).filter(r => r['schema:name'] === label).map(r => r['@id']).sort();
      return {done: JSON.stringify(ids) === JSON.stringify([a,c].sort()), ids};
    });
    check(results.done, `${kind}: Latest search contains exactly the surviving release and draft`, JSON.stringify(results.ids));
    // Reconnecting a published successor is a system-maintained history update, not a content edit.
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': c, newVersion: '3.0.0'}), 200,
        `${kind}: publish the surviving draft`);
    const publishedBefore = (await call(auth, 'GET', at(c))).body;
    checkStatus(await mutate(auth, 'DELETE', at(a)), [202, 204], `${kind}: delete the first version`);
    const detached = await poll(async () => {
      const body = (await call(auth, 'GET', at(c))).body;
      return {done: body && !Object.hasOwn(body, 'pav:previousVersion'), body};
    });
    const detachedExpected = structuredClone(publishedBefore); delete detachedExpected['pav:previousVersion'];
    check(detached.done && isDeepStrictEqual(detached.body, detachedExpected),
        `${kind}: published successor loses only its predecessor pointer`, JSON.stringify(detached.body));
    const lastDraft = await call(auth, 'POST', '/command/create-draft-artifact',
        {'@id': c, folderId, newVersion: '3.0.1', propagateSharing: false});
    if (checkStatus(lastDraft, 201, `${kind}: surviving latest release can continue development`)) {
      const d = lastDraft.body['@id']; cleanup(kind, at(d), `${label} D`);
      checkStatus(await mutate(auth, 'DELETE', at(d)), [202, 204], `${kind}: delete the latest draft`);
      const restored = (await call(auth, 'GET', `${at(c)}/details`)).body;
      check(restored?.isLatestVersion === true && restored?.isLatestPublishedVersion === true && restored?.isLatestDraftVersion === false,
          `${kind}: deleting the draft restores the latest release`, JSON.stringify(restored));
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
    const loaded = await call(auth, 'GET', `/templates/${enc(pcdId)}`);
    const body = loaded.body;
    checkStatus(await call(auth, 'POST', `/command/publish-create-draft-template/${enc(pcdId)}`, body),
      428, 'publish-create-draft requires the loaded source ETag');
    const res = await call(auth, 'POST', `/command/publish-create-draft-template/${enc(pcdId)}`, body,
      { headers: { 'If-Match': loaded.headers.get('etag') } });
    if (checkStatus(res, [200, 201], 'publish-create-draft-template returns')) {
      const draftId = res.body?.['@id'];
      if (draftId && draftId !== pcdId) cleanup('template', `/templates/${enc(draftId)}`, `${pcdName} draft`);
      check((await call(auth, 'GET', `/templates/${enc(pcdId)}`)).body?.['bibo:status'] === 'bibo:published',
          'the source template is now published', 'the source was not published');
      check(res.body?.['bibo:status'] === 'bibo:draft', 'and the returned artifact is a new draft',
          `the returned status was ${res.body?.['bibo:status']}`);
    }
  }

  suite('versioning: drafts under a supplied identity');

  // Workspace's Create Draft and the Designer's Create new draft mint the draft's identity and send
  // it, so a lost reply is settled by reading that identity: the draft committed when it names the
  // source as its previous version. An identity already taken is refused before anything is written.
  const versionsOf = async id => (await call(auth, 'GET', `/templates/${enc(id)}/versions`)).body?.totalCount;
  const occupantName = `Occupied Draft Identity ${RUN}`;
  const occupant = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', occupantName));
  if (checkStatus(occupant, 201, 'a template is created to occupy a draft identity')) {
    const occupantId = occupant.body['@id'];
    const occupantAt = `/templates/${enc(occupantId)}`;
    cleanup('template', occupantAt, occupantName);
    const occupantBefore = await call(auth, 'GET', occupantAt);
    const occupantUnchanged = async () => {
      const now = await call(auth, 'GET', occupantAt);
      return now.headers.get('etag') === occupantBefore.headers.get('etag')
          && isDeepStrictEqual(now.body, occupantBefore.body);
    };

    const draftSourceName = `Supplied Draft Source ${RUN}`;
    const draftSource = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
        artifactBody('template', draftSourceName));
    if (checkStatus(draftSource, 201, 'create-draft-artifact: a template is created to draft')) {
      const sourceId = draftSource.body['@id'];
      cleanup('template', `/templates/${enc(sourceId)}`, draftSourceName);
      if (checkStatus(await call(auth, 'POST', '/command/publish-artifact', { '@id': sourceId, newVersion: '1.0.0' }),
          [200, 201], 'create-draft-artifact: and published')) {
        const request = { '@id': sourceId, folderId, newVersion: '1.0.1', propagateSharing: false };
        const taken = await call(auth, 'POST', '/command/create-draft-artifact', { ...request, draftId: occupantId });
        if (checkStatus(taken, 412, 'create-draft-artifact: a draftId another artifact holds is refused')) {
          check((taken.text ?? '').includes('nodeAlreadyPresent'),
              'create-draft-artifact: and the refusal says the identity is already present',
              `body was ${(taken.text ?? '').slice(0, 200)}`);
        }
        const versionsAfterTaken = await versionsOf(sourceId);
        check(await occupantUnchanged() && versionsAfterTaken === 1,
            'create-draft-artifact: and nothing is written',
            `the source has ${versionsAfterTaken} versions, or the occupant changed`);

        const draftId = mintId('templates');
        // Registered before the request: what to delete does not depend on the reply.
        cleanup('template', `/templates/${enc(draftId)}`, `${draftSourceName} draft`);
        const draft = await call(auth, 'POST', '/command/create-draft-artifact', { ...request, draftId });
        if (checkStatus(draft, 201, 'create-draft-artifact: the draft is created under the supplied draftId')) {
          check(draft.body?.['@id'] === draftId, 'create-draft-artifact: and the reply names that identity',
              `the reply named ${draft.body?.['@id']}`);
          const stored = await call(auth, 'GET', `/templates/${enc(draftId)}`);
          check(stored.status === 200 && stored.body?.['pav:previousVersion'] === sourceId
                && stored.body?.['bibo:status'] === 'bibo:draft' && stored.body?.['pav:version'] === '1.0.1',
              'create-draft-artifact: the draft reads back as the successor of its source',
              `${stored.status}: ${JSON.stringify({ previous: stored.body?.['pav:previousVersion'],
                status: stored.body?.['bibo:status'], version: stored.body?.['pav:version'] })}`);
          const versionsAfterDraft = await versionsOf(sourceId);
          check(versionsAfterDraft === 2, 'create-draft-artifact: the source has exactly two versions',
              `it has ${versionsAfterDraft}`);
          // The identity is now taken, and the server says so before it considers that the source
          // already has a successor. A client therefore reads the repeat as "check again", never as
          // a failure.
          const repeated = await call(auth, 'POST', '/command/create-draft-artifact', { ...request, draftId });
          if (checkStatus(repeated, 412, 'create-draft-artifact: a repeated request is refused')) {
            check((repeated.text ?? '').includes('nodeAlreadyPresent'),
                'create-draft-artifact: and the refusal of the repeat says the identity is already present',
                `body was ${(repeated.text ?? '').slice(0, 200)}`);
          }
          const afterRepeat = await call(auth, 'GET', `/templates/${enc(draftId)}`);
          const versionsAfterRepeat = await versionsOf(sourceId);
          check(afterRepeat.headers.get('etag') === stored.headers.get('etag') && versionsAfterRepeat === 2,
              'create-draft-artifact: and the repeat writes nothing',
              `ETag ${stored.headers.get('etag')} then ${afterRepeat.headers.get('etag')}; ${versionsAfterRepeat} versions`);
        }
      }
    }

    const pcdSourceName = `Supplied Publish-Create-Draft ${RUN}`;
    const pcdSource = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
        artifactBody('template', pcdSourceName));
    if (checkStatus(pcdSource, 201, 'publish-create-draft-template: a template is created to publish and draft')) {
      const sourceId = pcdSource.body['@id'];
      const sourceAt = `/templates/${enc(sourceId)}`;
      cleanup('template', sourceAt, pcdSourceName);
      const opened = await call(auth, 'GET', sourceAt);
      const etag = opened.headers.get('etag');
      const command = draft => `/command/publish-create-draft-template/${enc(sourceId)}?draft_id=${enc(draft)}`;
      const send = draft => call(auth, 'POST', command(draft), opened.body, { headers: { 'If-Match': etag } });

      const taken = await send(occupantId);
      if (checkStatus(taken, 412,
          'publish-create-draft-template: a draft_id another artifact holds is refused before publishing')) {
        check((taken.text ?? '').includes('nodeAlreadyPresent'),
            'publish-create-draft-template: and the refusal says the identity is already present',
            `body was ${(taken.text ?? '').slice(0, 200)}`);
      }
      const unpublished = await call(auth, 'GET', sourceAt);
      const versionsAfterTaken = await versionsOf(sourceId);
      check(unpublished.body?.['bibo:status'] === 'bibo:draft' && unpublished.headers.get('etag') === etag
            && await occupantUnchanged() && versionsAfterTaken === 1,
          'publish-create-draft-template: and nothing is written',
          `status ${unpublished.body?.['bibo:status']}, ETag ${etag} then ${unpublished.headers.get('etag')}, `
          + `${versionsAfterTaken} versions`);
      checkStatus(await send('not-an-identifier'), 400,
          'publish-create-draft-template: a draft_id that is not a template identifier is refused');
      const afterMalformed = await call(auth, 'GET', sourceAt);
      check(afterMalformed.body?.['bibo:status'] === 'bibo:draft' && afterMalformed.headers.get('etag') === etag,
          'publish-create-draft-template: and the source is not published',
          `status ${afterMalformed.body?.['bibo:status']}, ETag ${etag} then ${afterMalformed.headers.get('etag')}`);

      const draftId = mintId('templates');
      cleanup('template', `/templates/${enc(draftId)}`, `${pcdSourceName} draft`);
      const created = await send(draftId);
      if (checkStatus(created, 200, 'publish-create-draft-template: the draft is created under the supplied draft_id')) {
        check(created.body?.['@id'] === draftId, 'publish-create-draft-template: and the reply names that identity',
            `the reply named ${created.body?.['@id']}`);
        const stored = await call(auth, 'GET', `/templates/${enc(draftId)}`);
        const published = await call(auth, 'GET', sourceAt);
        check(stored.status === 200 && stored.body?.['pav:previousVersion'] === sourceId
              && published.body?.['bibo:status'] === 'bibo:published',
            'publish-create-draft-template: the source is published and the draft succeeds it',
            `draft ${stored.status} after ${stored.body?.['pav:previousVersion']}; source ${published.body?.['bibo:status']}`);
        const versionsAfterDraft = await versionsOf(sourceId);
        check(versionsAfterDraft === 2, 'publish-create-draft-template: the source has exactly two versions',
            `it has ${versionsAfterDraft}`);
        checkStatus(await send(draftId), 412, 'publish-create-draft-template: a repeat with the opened ETag is refused');
        const versionsAfterRepeat = await versionsOf(sourceId);
        check(versionsAfterRepeat === 2, 'publish-create-draft-template: and makes no third version',
            `the source has ${versionsAfterRepeat} versions`);
      }
    }
  }

  suite('versioning: publish-create-draft-template stores nothing when a later step would refuse');

  // The command publishes the source, creates its successor and applies the submitted definition.
  // What a later step would refuse is refused before publishing, so nothing changes, the opened ETag
  // stays valid, and a corrected retry under the same identity makes exactly one successor.
  const invalidName = `Refused Definition ${RUN}`;
  const invalidSource = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', invalidName));
  if (checkStatus(invalidSource, 201, 'an invalid definition: a template is created to receive it')) {
    const sourceId = invalidSource.body['@id'];
    const sourceAt = `/templates/${enc(sourceId)}`;
    cleanup('template', sourceAt, invalidName);
    const opened = await call(auth, 'GET', sourceAt);
    const etag = opened.headers.get('etag');
    const broken = structuredClone(opened.body);
    delete broken.properties['oslc:modifiedBy'];
    // The validator must refuse the definition, or the refusal below would prove nothing.
    const verdict = await call(auth, 'POST', '/command/validate?resource_type=template', broken);
    check(verdict.status === 200 && verdict.body?.validates === 'false',
        'an invalid definition: without its oslc:modifiedBy declaration the definition does not validate',
        `${verdict.status}, validates=${verdict.body?.validates}`);
    const draftId = mintId('templates');
    cleanup('template', `/templates/${enc(draftId)}`, `${invalidName} draft`);
    const command = `/command/publish-create-draft-template/${enc(sourceId)}?draft_id=${enc(draftId)}`;
    const refused = await call(auth, 'POST', command, broken, { headers: { 'If-Match': etag } });
    if (checkStatus(refused, 400, 'an invalid definition: the command refuses it')) {
      const errors = refused.body?.objects?.validationReport?.errors;
      check(Array.isArray(errors) && errors.length > 0, 'an invalid definition: and the refusal carries the validation report',
          `body was ${(refused.text ?? '').slice(0, 200)}`);
    }
    const after = await call(auth, 'GET', sourceAt);
    check(after.body?.['bibo:status'] === 'bibo:draft' && after.body?.['pav:version'] === opened.body?.['pav:version']
          && after.headers.get('etag') === etag,
        'an invalid definition: the source is still the draft that was opened, at the same ETag',
        `status ${after.body?.['bibo:status']}, version ${after.body?.['pav:version']}, `
        + `ETag ${etag} then ${after.headers.get('etag')}`);
    const versionsAfterRefusal = await versionsOf(sourceId);
    const successor = await call(auth, 'GET', `/templates/${enc(draftId)}`);
    check(versionsAfterRefusal === 1 && successor.status === 404, 'an invalid definition: and no successor exists',
        `${versionsAfterRefusal} versions; the draft identity answered ${successor.status}`);

    const corrected = await call(auth, 'POST', command, opened.body, { headers: { 'If-Match': etag } });
    if (checkStatus(corrected, 200, 'an invalid definition: the corrected definition with the same If-Match is accepted')) {
      const stored = await call(auth, 'GET', `/templates/${enc(draftId)}`);
      const versionsAfterRetry = await versionsOf(sourceId);
      check(corrected.body?.['@id'] === draftId && stored.body?.['pav:previousVersion'] === sourceId
            && versionsAfterRetry === 2,
          'an invalid definition: and exactly one successor follows the source',
          `reply ${corrected.body?.['@id']}, previous ${stored.body?.['pav:previousVersion']}, ${versionsAfterRetry} versions`);
      checkStatus(await call(auth, 'POST', command, opened.body, { headers: { 'If-Match': etag } }), 412,
          'an invalid definition: a repeat of the corrected request is refused');
      const versionsAfterRepeat = await versionsOf(sourceId);
      check(versionsAfterRepeat === 2, 'an invalid definition: and the source still has exactly two versions',
          `it has ${versionsAfterRepeat}`);
    }
  }

  // The draft is created in the source's folder, so an owner who may no longer create there is
  // refused before the source is published. The second user owns the folder and controls the grant.
  const parentName = `Viewer Parent ${RUN}`;
  const parent = await call(user2.auth, 'POST', '/folders', { folderId: user2.profile.homeFolderId,
    name: parentName, description: `Created by the REST suites (${RUN})` });
  if (checkStatus(parent, 201, 'a parent the owner may not create in: the second user creates a folder')) {
    const parentId = parent.body['@id'];
    const parentAt = `/folders/${enc(parentId)}`;
    cleanup('folder', parentAt, parentName, user2.auth);
    const grant = role => mutate(user2.auth, 'PUT', `${parentAt}/permissions`, {
      owner: { '@id': user2.profile['@id'] },
      userPermissions: [{ user: { '@id': user1.profile['@id'] }, role }],
      groupPermissions: [],
    });
    if (checkStatus(await grant('editor'), 200,
        'a parent the owner may not create in: the first user is made an editor of it')) {
      const ownedName = `Template in a Viewer Parent ${RUN}`;
      const owned = await call(auth, 'POST', `/templates?folder_id=${enc(parentId)}`,
          artifactBody('template', ownedName));
      if (checkStatus(owned, 201, 'a parent the owner may not create in: the first user creates a template there')) {
        const ownedId = owned.body['@id'];
        const ownedAt = `/templates/${enc(ownedId)}`;
        cleanup('template', ownedAt, ownedName);
        const draftId = mintId('templates');
        cleanup('template', `/templates/${enc(draftId)}`, `${ownedName} draft`);
        const command = `/command/publish-create-draft-template/${enc(ownedId)}?draft_id=${enc(draftId)}`;
        let opened;
        if (checkStatus(await grant('viewer'), 200,
            'a parent the owner may not create in: the first user is downgraded to viewer')) {
          opened = await call(auth, 'GET', ownedAt);
          const etag = opened.headers.get('etag');
          checkStatus(await call(auth, 'POST', command, opened.body, { headers: { 'If-Match': etag } }), 403,
              'a parent the owner may not create in: the command is refused');
          const after = await call(auth, 'GET', ownedAt);
          check(after.body?.['bibo:status'] === 'bibo:draft' && after.headers.get('etag') === etag,
              'a parent the owner may not create in: the source is still the draft that was opened, at the same ETag',
              `status ${after.body?.['bibo:status']}, ETag ${etag} then ${after.headers.get('etag')}`);
          const versions = await versionsOf(ownedId);
          const successor = await call(auth, 'GET', `/templates/${enc(draftId)}`);
          check(versions === 1 && successor.status === 404, 'a parent the owner may not create in: and no successor exists',
              `${versions} versions; the draft identity answered ${successor.status}`);
        }
        // Teardown removes the template as the first user, which needs the editor grant back. With the
        // grant back, the refused request is retried unchanged, under the same draft_id and If-Match.
        if (checkStatus(await grant('editor'), 200, "a parent the owner may not create in: the first user's grant is restored")
            && opened) {
          const send = () => call(auth, 'POST', command, opened.body, { headers: { 'If-Match': opened.headers.get('etag') } });
          const retried = await send();
          if (checkStatus(retried, 200, 'a parent the owner may not create in: once the grant is back, the same request is accepted')) {
            const stored = await call(auth, 'GET', `/templates/${enc(draftId)}`);
            const versionsAfterRetry = await versionsOf(ownedId);
            check(retried.body?.['@id'] === draftId && stored.body?.['pav:previousVersion'] === ownedId
                  && versionsAfterRetry === 2,
                'a parent the owner may not create in: and exactly one successor follows the source',
                `reply ${retried.body?.['@id']}, previous ${stored.body?.['pav:previousVersion']}, ${versionsAfterRetry} versions`);
            checkStatus(await send(), 412, 'a parent the owner may not create in: a repeat of the accepted request is refused');
            const versionsAfterRepeat = await versionsOf(ownedId);
            check(versionsAfterRepeat === 2, 'a parent the owner may not create in: and the source still has exactly two versions',
                `it has ${versionsAfterRepeat}`);
          }
        }
      }
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
