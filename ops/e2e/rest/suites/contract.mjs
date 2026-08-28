// Cross-service contract: the resource server ↔ the artifact server.
//
// The resource server owns the workspace graph (folders, permissions, existence) in Neo4j and proxies
// every artifact's *content* to the artifact server, which knows nothing of folders or who may see
// what. Two stores, one artifact — kept consistent only through the resource server. The per-service
// suites stop at their own boundary and the happy-path smoke never reads the far side, so a drift
// between the two is invisible until runtime. This suite reads both sides of the hop and pins where
// they must agree and where they deliberately diverge.
//
// It addresses the artifact server directly, so it only runs against the live stack, like the rest of
// this estate. The two historically-found inter-layer bugs — a media-type reported with the wrong
// status, and a graphless artifact — were both found by chance rather than by a test like this.
import {
  suite, check, checkStatus, call, updateArtifact, artifact, cleanup, artifactBody, enc, RUN,
  ARTIFACT_SERVER,
} from '../lib.mjs';

export const name = 'contract';

export async function run({ user1, folderId }) {
  const auth = user1.auth;

  suite('contract: a create through the resource server reaches both stores, faithfully');

  // Created the ordinary way — through the resource server, which writes the graph node and proxies
  // the content to the artifact server.
  const label = `Contract ${RUN}`;
  const made = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', label));
  if (!checkStatus(made, 201, 'a template is created through the resource server')) return {};
  const id = made.body['@id'];
  const at = `/templates/${enc(id)}`;
  cleanup('template', at, label);

  // The same @id resolves on both servers, and the content the artifact server stored is what the
  // resource server serves back — the proxy is faithful, not a reshaping layer.
  const viaResource = await call(auth, 'GET', at);
  const viaArtifact = await artifact(auth, 'GET', at);
  checkStatus(viaResource, 200, 'the resource server serves it');
  if (checkStatus(viaArtifact, 200, 'and the artifact server holds it under the same id')) {
    check(viaArtifact.body?.['@id'] === id, 'both stores agree on the identifier',
        `artifact server had ${viaArtifact.body?.['@id']}`);
    const fields = ['@id', '@type', 'schema:name', 'pav:version', 'bibo:status'];
    const mismatched = fields.filter(f => JSON.stringify(viaResource.body?.[f]) !== JSON.stringify(viaArtifact.body?.[f]));
    check(mismatched.length === 0, 'the resource server serves back the content the artifact server stored',
        `these fields differed across the hop: ${mismatched.join(', ')}`);
  }

  // The graph is the resource server's own contribution: /details is graph-backed and carries the
  // folder the artifact lives in, which the artifact server's record has no notion of.
  const details = await call(auth, 'GET', `${at}/details`);
  if (checkStatus(details, 200, 'the resource server answers graph-backed details')) {
    check(details.body?.pathInfo !== undefined || details.body?.folderId !== undefined,
        'details carry the folder context the artifact server does not have',
        `neither pathInfo nor folderId was present: ${Object.keys(details.body ?? {}).join(', ')}`);
  }
  const onArtifact = await artifact(auth, 'GET', `${at}/details`);
  check(onArtifact.status === 404 || onArtifact.status === 405,
      'and the artifact server has no such graph endpoint',
      `expected 404/405 for /details on the artifact server, got ${onArtifact.status}`);

  suite('contract: a delete through the resource server clears both stores');

  const del = await call(auth, 'DELETE', at);
  if (checkStatus(del, [200, 204], 'the resource server deletes it')) {
    checkStatus(await call(auth, 'GET', at), 404, 'the resource server no longer finds it');
    checkStatus(await artifact(auth, 'GET', at), 404, 'and the artifact server no longer holds it');
  }

  suite('contract: an update keeps the content store and the graph on the same name');

  // A rename is the subtle sync point: the resource server re-reads the name out of the artifact
  // server's *response* and writes it into the graph node by hand. If those two ever disagree, a
  // folder listing (graph) shows a stale name while the artifact holds the new one — renamed
  // everywhere the user looks except the list. Assert the artifact content, the graph node and the
  // resource server's own read all end up on the new name.
  const upLabel = `Contract Update ${RUN}`;
  const toUpdate = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', upLabel));
  if (checkStatus(toUpdate, 201, 'a template is created to rename')) {
    const uid = toUpdate.body['@id'];
    const uat = `/templates/${enc(uid)}`;
    cleanup('template', uat, upLabel);
    const newName = `${upLabel} renamed`;
    const body = artifactBody('template', newName);
    body['@id'] = uid;
    if (checkStatus(await updateArtifact(auth, uat, body), 200, 'the rename is accepted')) {
      const rsName = (await call(auth, 'GET', uat)).body?.['schema:name'];
      const asName = (await artifact(auth, 'GET', uat)).body?.['schema:name'];
      const graphName = (await call(auth, 'GET', `${uat}/details`)).body?.['schema:name'];
      check(rsName === newName, 'the resource server serves the new name', `it served "${rsName}"`);
      check(asName === newName, 'the artifact server stored the new name', `it stored "${asName}"`);
      check(graphName === newName, 'and the graph node carries the new name too',
          `the graph said "${graphName}" — a rename reaching the content but not the graph shows a stale name in every folder listing`);
    }
  }

  suite('contract: publishing writes through to both stores');

  // Publishing writes to both stores — the artifact server freezes the content at a version and status,
  // and the graph records the same. A publish that reached only one would leave the artifact
  // half-published: immutable content the workspace still thinks is a draft, or the reverse.
  const pubLabel = `Contract Publish ${RUN}`;
  const toPublish = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', pubLabel));
  if (checkStatus(toPublish, 201, 'a template is created to publish')) {
    const pid = toPublish.body['@id'];
    const pat = `/templates/${enc(pid)}`;
    cleanup('template', pat, pubLabel);
    if (checkStatus(await call(auth, 'POST', '/command/publish-artifact', { '@id': pid, newVersion: '1.0.0' }),
        [200, 201], 'the template is published')) {
      const as = await artifact(auth, 'GET', pat);
      const graph = await call(auth, 'GET', `${pat}/details`);
      check(as.body?.['bibo:status'] === 'bibo:published', 'the artifact server stored the published status',
          `it stored ${as.body?.['bibo:status']}`);
      check(as.body?.['pav:version'] === '1.0.0', 'at the published version',
          `it stored ${as.body?.['pav:version']}`);
      check(graph.body?.['bibo:status'] === 'bibo:published', 'and the graph agrees it is published',
          `the graph said ${graph.body?.['bibo:status']} — a one-store publish would strand it half-published`);
    }
  }

  suite('contract: a draft from a published version lands in both stores');

  // create-draft is the two-store write with the most moving parts: it mints a *new* artifact at the
  // next version and must register it in both stores. Publish first, then draft, then read the draft
  // straight from the artifact server and confirm the graph has a node for it.
  const drLabel = `Contract Draft ${RUN}`;
  const drBase = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', drLabel));
  if (checkStatus(drBase, 201, 'a template is created to publish then draft')) {
    const bid = drBase.body['@id'];
    cleanup('template', `/templates/${enc(bid)}`, drLabel);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', { '@id': bid, newVersion: '1.0.0' }),
        [200, 201], 'it is published first');
    const draft = await call(auth, 'POST', '/command/create-draft-artifact',
        { '@id': bid, folderId, newVersion: '1.0.1', propagateVersion: false });
    if (checkStatus(draft, [200, 201], 'a draft is created from it')) {
      const did = draft.body?.['@id'];
      if (did && did !== bid) cleanup('template', `/templates/${enc(did)}`, `${drLabel} draft`);
      const as = await artifact(auth, 'GET', `/templates/${enc(did)}`);
      const graph = await call(auth, 'GET', `/templates/${enc(did)}/details`);
      check(as.status === 200 && as.body?.['bibo:status'] === 'bibo:draft',
          'the artifact server holds the new draft', `artifact GET ${as.status}, status ${as.body?.['bibo:status']}`);
      check(as.body?.['pav:version'] === '1.0.1', 'at the drafted version', `it stored ${as.body?.['pav:version']}`);
      checkStatus(graph, 200, 'and the graph has a node for the draft');
    }
  }

  suite('contract: a move changes the graph, not the artifact content');

  // Folders live only in the graph, so moving an artifact is a graph-only operation: the content on the
  // artifact server must come through byte-for-byte unchanged. A regression that rewrote content on a
  // move would quietly bump versions or drop fields.
  const mvLabel = `Contract Move ${RUN}`;
  const destName = `Contract Move Dest ${RUN}`;
  const toMove = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', mvLabel));
  const dest = await call(auth, 'POST', '/folders', { folderId, name: destName, description: 'Created by the REST suites' });
  if (checkStatus(toMove, 201, 'a template is created to move') && checkStatus(dest, 201, 'a destination folder is created')) {
    const mid = toMove.body['@id'];
    const mat = `/templates/${enc(mid)}`;
    const destId = dest.body['@id'];
    // The destination folder is registered first so it is torn down last — the template it will hold
    // must be deleted before the folder, or the non-empty folder cannot be removed.
    cleanup('folder', `/folders/${enc(destId)}`, destName);
    cleanup('template', mat, mvLabel);
    const before = await artifact(auth, 'GET', mat);
    if (checkStatus(await call(auth, 'POST', '/command/move-resource-to-folder', { '@id': mid, targetFolderId: destId }),
        [200, 201, 204], 'the move is accepted')) {
      const after = await artifact(auth, 'GET', mat);
      const fields = ['@id', '@type', 'schema:name', 'pav:version', 'bibo:status'];
      const changed = fields.filter(f => JSON.stringify(before.body?.[f]) !== JSON.stringify(after.body?.[f]));
      check(changed.length === 0, 'the artifact content is untouched by the move',
          `these fields changed on the artifact server: ${changed.join(', ')}`);
      const there = await call(auth, 'GET', `/folders/${enc(destId)}/contents`);
      check(JSON.stringify(there.body ?? {}).includes(mid),
          'and the graph now lists it under the destination folder',
          'the destination folder contents did not include the moved template');
    }
  }

  suite('contract: an artifact written straight to the artifact server is invisible to the workspace');

  // The drift hazard, pinned. A write that bypasses the resource server reaches the content store but
  // never the graph, so the artifact exists yet has no folder and no owner. Every resource-server read
  // is graph-gated, so it answers 404 — the artifact is orphaned, reachable only by its raw id on the
  // artifact server. This is why content must only ever be written through the resource server.
  const orphanLabel = `Contract Orphan ${RUN}`;
  const orphan = await artifact(auth, 'POST', '/templates', artifactBody('template', orphanLabel));
  if (checkStatus(orphan, 201, 'a template is written directly to the artifact server')) {
    const oid = orphan.body['@id'];
    const oat = `/templates/${enc(oid)}`;
    cleanup('template', oat, orphanLabel, auth, ARTIFACT_SERVER);   // must be removed on the artifact server

    check((await artifact(auth, 'GET', oat)).status === 200,
        'the artifact server holds it', 'the artifact server did not return it');
    checkStatus(await call(auth, 'GET', oat), 404,
        'but the resource server cannot find it — no graph node, no existence');
    checkStatus(await call(auth, 'GET', `${oat}/details`), 404, 'nor its details');
    checkStatus(await call(auth, 'GET', `${oat}/report`), 404, 'nor its report');
  }

  suite('contract: a rejection at the artifact server crosses the hop as itself, not a 500');

  // A malformed body is refused the same way whether sent to the resource server or straight to the
  // artifact server: the proxy relays the downstream status class rather than collapsing it to a 500.
  // This is the media-type-status bug's family — an inter-layer status that used to drift.
  const junk = { 'schema:name': 'not a template at all' };
  const rsJunk = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, junk);
  const asJunk = await artifact(auth, 'POST', '/templates', junk);
  check(rsJunk.status === 400, 'the resource server refuses a malformed create with 400',
      `got ${rsJunk.status}`);
  check(asJunk.status === 400, 'the artifact server refuses the same body with 400',
      `got ${asJunk.status}`);
  check(rsJunk.status === asJunk.status, 'the two agree on the status for the same bad body',
      `resource ${rsJunk.status} vs artifact ${asJunk.status}`);
  if (asJunk.status === 201 && asJunk.body?.['@id']) {
    cleanup('template', `/templates/${enc(asJunk.body['@id'])}`, 'stray junk', auth, ARTIFACT_SERVER);
  }

  // An unknown id is absent on both, not an error on either.
  const missing = `/templates/${enc('https://repo.metadatacenter.orgx/templates/00000000-0000-0000-0000-000000000000')}`;
  checkStatus(await call(auth, 'GET', missing), 404, 'an unknown id is 404 on the resource server');
  checkStatus(await artifact(auth, 'GET', missing), 404, 'and 404 on the artifact server');

  return {};
}
