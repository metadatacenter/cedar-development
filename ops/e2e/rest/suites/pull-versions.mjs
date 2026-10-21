import {isDeepStrictEqual} from 'node:util';
import {suite, check, checkStatus, call, mutate, cleanup, artifactBody, enc, RUN} from '../lib.mjs';

export const name = 'pull-versions';

// The server stamps embedded definitions when their containing element is replaced. Compare
// everything else, including identities, authorship, constraints and metadata-named properties.
function withoutWriteTimes(value) {
  const copy = structuredClone(value);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(type => typeof type === 'string' && type.startsWith('https://schema.metadatacenter.org/core/'))) {
      delete node['pav:createdOn']; delete node['pav:lastUpdatedOn'];
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(copy); return copy;
}

/** Direct REST callers receive the same storage protections as Designer, without its preflight. */
export async function run({user1, folderId}) {
  const auth = user1.auth;
  suite('pull-versions: final template writes protect stored records');
  for (const nested of [false, true]) for (const assessed of [false, true]) {
    const label = `${nested ? 'nested' : 'root'} ${assessed ? 'after assessment' : 'without assessment'}`;
    const made = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', `${RUN} pull ${label}`));
    if (!checkStatus(made, 201, `${label}: create parent`)) continue;
    const id = made.body['@id'], at = `/templates/${enc(id)}`;
    cleanup('template', at, `Pull ${label} ${RUN}`);
    const before = await call(auth, 'GET', at);
    const after = structuredClone(before.body);
    const inserted = artifactBody(nested ? 'element' : 'field', 'New child');
    if (nested) {
      inserted.properties.Value = artifactBody('field', 'Value');
      inserted._ui.order.push('Value'); inserted._ui.propertyLabels.Value = 'Value';
      inserted.properties['@context'].properties.Value = {enum: ['https://example.org/pull/Value']};
    }
    after.properties.Added = inserted; after._ui.order.push('Added'); after._ui.propertyLabels.Added = 'Added';
    after.properties['@context'].properties.Added = {enum: ['https://example.org/pull/Added']};
    if (assessed) {
      const assessment = await call(auth, 'POST', `/command/check-update-template/${enc(id)}`, after);
      check(assessment.status === 200 && assessment.body.canBeUpdated === true && assessment.body.numberOfInstances === 0,
        `${label}: assessment explicitly reports zero records`, assessment.text);
    }
    const record = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
      artifactBody('instance', `${RUN} pull record ${label}`, {'schema:isBasedOn': id}));
    if (!checkStatus(record, 201, `${label}: record arrives before template write`)) continue;
    cleanup('instance', `/template-instances/${enc(record.body['@id'])}`, `Pull record ${label} ${RUN}`);
    checkStatus(await call(auth, 'PUT', at, after, {headers: {'If-Match': before.headers.get('etag')}}), 412,
      `${label}: schema write is rejected at storage`);
    const unchanged = await call(auth, 'GET', at);
    check(isDeepStrictEqual(unchanged.body, before.body) && unchanged.headers.get('etag') === before.headers.get('etag'),
      `${label}: refusal preserves complete parent and revision`, unchanged.text);
    const presentation = {...before.body, 'schema:description': 'A presentation edit with records'};
    checkStatus(await call(auth, 'PUT', at, presentation, {headers: {'If-Match': before.headers.get('etag')}}), 200,
      `${label}: presentation-only edits remain allowed`);
  }
  suite('pull-versions: schema change without records and publication immutability');
  const made = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', `${RUN} pull empty`));
  if (checkStatus(made, 201, 'create an unreferenced parent')) {
    const id = made.body['@id'], at = `/templates/${enc(id)}`;
    cleanup('template', at, `Pull empty ${RUN}`);
    const opened = await call(auth, 'GET', at);
    const changed = structuredClone(opened.body);
    changed.properties.Added = artifactBody('field', 'Added');
    changed._ui.order.push('Added'); changed._ui.propertyLabels.Added = 'Added';
    changed.properties['@context'].properties.Added = {enum: ['https://example.org/pull/Added']};
    checkStatus(await call(auth, 'PUT', at, changed, {headers: {'If-Match': opened.headers.get('etag')}}), 200,
      'an unreferenced schema can change');
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': id, newVersion: '1.0.0'}), 200, 'publish the parent');
    const released = await call(auth, 'GET', at);
    checkStatus(await call(auth, 'PUT', at, {...released.body, 'schema:description': 'Cannot edit release'},
      {headers: {'If-Match': released.headers.get('etag')}}), 400, 'published parents remain immutable');
  }
  suite('pull-versions: published child replacements through real version histories');
  for (const kind of ['field', 'element']) {
    const collection = `template-${kind}s`;
    const made = await call(auth, 'POST', `/${collection}?folder_id=${enc(folderId)}`, artifactBody(kind, `${RUN} pull ${kind}`));
    if (!checkStatus(made, 201, `${kind}: create source`)) continue;
    const source = made.body['@id'], sourceAt = `/${collection}/${enc(source)}`;
    cleanup(kind, sourceAt, `Pull ${kind} source ${RUN}`);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': source, newVersion: '1.0.0'}), 200,
      `${kind}: publish source`);
    const old = (await call(auth, 'GET', sourceAt)).body;
    const drafted = await call(auth, 'POST', '/command/create-draft-artifact',
      {'@id': source, folderId, newVersion: '2.0.0', propagateSharing: false});
    if (!checkStatus(drafted, 201, `${kind}: create successor draft`)) continue;
    const next = drafted.body['@id'], nextAt = `/${collection}/${enc(next)}`;
    cleanup(kind, nextAt, `Pull ${kind} successor ${RUN}`);
    const proposed = (await call(auth, 'GET', nextAt)).body;
    if (kind === 'field') proposed._valueConstraints = {...proposed._valueConstraints, minLength: 3};
    else {
      proposed.properties.Value = artifactBody('field', 'Value');
      proposed._ui.order.push('Value'); proposed._ui.propertyLabels.Value = 'Value';
      proposed.properties['@context'].properties.Value = {enum: ['https://example.org/pull/Value']};
    }
    checkStatus(await mutate(auth, 'PUT', nextAt, proposed), 200, `${kind}: edit successor definition`);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': next, newVersion: '2.0.0'}), 200,
      `${kind}: publish successor`);
    const release = (await call(auth, 'GET', nextAt)).body;
    const history = await call(auth, 'GET', `${sourceAt}/versions`);
    check(history.status === 200 && history.body.resources[0]['@id'] === next && history.body.resources[0]['bibo:status'] === 'bibo:published',
      `${kind}: real history lists the new published release first`, history.text);
    for (const records of [false, true]) {
      const label = `${kind} ${records ? 'with records' : 'without records'}`;
      const body = artifactBody('template', `${RUN} pull ${label}`);
      body.properties.Reused = old; body._ui.order.push('Reused'); body._ui.propertyLabels.Reused = 'Retained label';
      body.properties['@context'].properties.Reused = {enum: ['https://example.org/pull/Reused']};
      const parent = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, body);
      if (!checkStatus(parent, 201, `${label}: create linked parent`)) continue;
      const id = parent.body['@id'], at = `/templates/${enc(id)}`; cleanup('template', at, `Pull ${label} ${RUN}`);
      if (records) {
        const recordBody = artifactBody('instance', `${RUN} pull ${label} record`, {'schema:isBasedOn': id});
        recordBody['@context'].Reused = 'https://example.org/pull/Reused';
        const instance = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`,
          recordBody);
        if (!checkStatus(instance, 201, `${label}: create metadata record`)) continue;
        cleanup('instance', `/template-instances/${enc(instance.body['@id'])}`, `Pull ${label} record ${RUN}`);
      }
      const opened = await call(auth, 'GET', at); const changed = structuredClone(opened.body);
      changed.properties.Reused = release;
      checkStatus(await call(auth, 'PUT', at, changed, {headers: {'If-Match': opened.headers.get('etag')}}), records ? 412 : 200,
        `${label}: final write applies the instance policy`);
      const saved = await call(auth, 'GET', at);
      check(saved.body.properties.Reused['@id'] === (records ? source : next) && isDeepStrictEqual(saved.body._ui, opened.body._ui) &&
        isDeepStrictEqual(saved.body.properties['@context'], opened.body.properties['@context']), `${label}: stored identity and placement are correct`, saved.text);
    }
    const sameDraft = await call(auth, 'POST', '/command/create-draft-artifact',
      {'@id': next, folderId, newVersion: '3.0.0', propagateSharing: false});
    if (!checkStatus(sameDraft, 201, `${kind}: create an equivalent successor`)) continue;
    const sameId = sameDraft.body['@id'], sameAt = `/${collection}/${enc(sameId)}`;
    cleanup(kind, sameAt, `Pull ${kind} equivalent ${RUN}`);
    checkStatus(await call(auth, 'POST', '/command/publish-artifact', {'@id': sameId, newVersion: '3.0.0'}), 200,
      `${kind}: publish the equivalent successor`);
    const sameRelease = (await call(auth, 'GET', sameAt)).body;
    const body = artifactBody('template', `${RUN} pull ${kind} equivalent`);
    body.properties.Reused = release; body._ui.order.push('Reused'); body._ui.propertyLabels.Reused = 'Retained label';
    body.properties['@context'].properties.Reused = {enum: ['https://example.org/pull/Reused']};
    const parent = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, body);
    if (!checkStatus(parent, 201, `${kind}: create a parent for the equivalent pull`)) continue;
    const id = parent.body['@id'], at = `/templates/${enc(id)}`;
    cleanup('template', at, `Pull ${kind} equivalent parent ${RUN}`);
    const recordBody = artifactBody('instance', `${RUN} equivalent record`, {'schema:isBasedOn': id});
    recordBody['@context'].Reused = 'https://example.org/pull/Reused';
    const record = await call(auth, 'POST', `/template-instances?folder_id=${enc(folderId)}`, recordBody);
    if (!checkStatus(record, 201, `${kind}: create a record before the equivalent pull`)) continue;
    cleanup('instance', `/template-instances/${enc(record.body['@id'])}`, `Pull ${kind} equivalent record ${RUN}`);
    const before = await call(auth, 'GET', at), changed = structuredClone(before.body);
    changed.properties.Reused = sameRelease;
    checkStatus(await call(auth, 'PUT', at, changed, {headers: {'If-Match': before.headers.get('etag')}}), 200,
      `${kind}: equivalent published replacement is allowed with records`);
    const saved = (await call(auth, 'GET', at)).body;
    check(saved.properties.Reused['@id'] === sameId &&
      isDeepStrictEqual(withoutWriteTimes(saved.properties.Reused.properties), withoutWriteTimes(sameRelease.properties)) &&
      isDeepStrictEqual(saved._ui, before.body._ui), `${kind}: equivalent pull keeps the release schema and placement`,
      JSON.stringify({expected: sameRelease.properties, actual: saved.properties.Reused.properties}));
  }
  return {};
}
