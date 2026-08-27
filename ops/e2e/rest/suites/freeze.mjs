// Freeze-on-publish: publishing a template pins every served controlled-term constraint to its
// current vocabulary version, across all four constraint kinds (ontology, branch, class, value set).
//
// This is the one behavior that spans the whole versioning stack — the artifact-library freeze walk,
// the resource-server publish hook + terminology-backed resolver, and the terminology server's
// resolve-current / class-IRI / vs-collection endpoints — and none of it was covered at the REST
// layer. It also guards a real cross-service failure mode: a stale validation-library in the artifact
// server silently dropped the injected `version` field on the publish PUT, which no test caught.
//
// The freeze is inert when the terminology local store is off (the production default), so this suite
// probes resolve-current first and SKIPS when DOID/CEDARVS are not served locally — asserting a pin
// there would be wrong.
import { suite, check, checkStatus, skip, call, artifact, cleanup, enc, RUN, TERMINOLOGY, authHeader } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'freeze';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'freeze-template.json');

/** The terminology triple for a resolve-current path, or null when it 404s / is not served locally. */
async function resolveCurrent(auth, query) {
  const res = await fetch(`${TERMINOLOGY}/bioportal/${query}`, { headers: { Authorization: authHeader(auth) } });
  return res.ok ? res.json() : null;
}

/** Every controlled-term entry in a template, flattened: its kind, a key, and the pinned version id. */
function constraints(node, out = []) {
  if (node && typeof node === 'object') {
    const vc = node._valueConstraints;
    if (vc) {
      for (const kind of ['ontologies', 'branches', 'classes', 'valueSets']) {
        for (const e of vc[kind] || []) {
          out.push({ kind, key: e.acronym || e.vsCollection || e.uri, versionId: e.version?.id ?? null });
        }
      }
    }
    for (const k of Object.keys(node)) constraints(node[k], out);
  }
  return out;
}

export async function run({ user1, folderId }) {
  const auth = user1.auth;
  suite('freeze: publishing pins every served controlled-term constraint to its current version');

  // The two vocabularies the fixture constrains to. Absent locally ⇒ freeze is a no-op ⇒ skip.
  const doid = await resolveCurrent(auth, 'ontologies/DOID/versions/current');
  const cedarvs = await resolveCurrent(auth, 'vs-collections/version-current?collection=CEDARVS');
  if (!doid || !cedarvs) {
    const reason = `the local terminology store does not serve DOID/CEDARVS (DOID: ${!!doid}, CEDARVS: ${!!cedarvs})`;
    for (const what of [
      'a template constrained to DOID (ontology/branch/class) and CEDARVS is created',
      'it publishes (the injected version fields pass validation)',
      'the DOID ontology constraint is pinned to DOID\'s current version',
      'the DOID branch constraint is pinned (resolved by acronym)',
      'the DOID class constraints are pinned (resolved by class IRI → owning ontology)',
      'the CEDARVS value-set constraint is pinned to the collection\'s current version',
      'an unserved value-set constraint is left unpinned',
    ]) skip(what, reason);
    return;
  }

  const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  template['schema:name'] = `Freeze ${RUN}`;
  const created = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, template);
  if (!checkStatus(created, 201, 'a template constrained to DOID (ontology/branch/class) and CEDARVS is created')) {
    return;
  }
  const pid = created.body['@id'];
  cleanup('template', `/templates/${enc(pid)}`, template['schema:name']);

  const published = await call(auth, 'POST', '/command/publish-artifact', { '@id': pid, newVersion: '1.0.0' });
  if (!checkStatus(published, [200, 201], 'it publishes (the injected version fields pass validation)')) {
    return;
  }

  // Read the stored content from the artifact server — the source of truth for what was frozen in.
  const stored = await artifact(auth, 'GET', `/templates/${enc(pid)}`);
  const entries = constraints(stored.body);
  const of = kind => entries.filter(e => e.kind === kind);

  // Every served entry is pinned to the correct current triple, one per constraint kind.
  check(of('ontologies').some(e => e.key === 'DOID' && e.versionId === doid.id),
      'the DOID ontology constraint is pinned to DOID\'s current version', JSON.stringify(of('ontologies')));
  check(of('branches').length > 0 && of('branches').every(e => e.versionId === doid.id),
      'the DOID branch constraint is pinned (resolved by acronym)', JSON.stringify(of('branches')));
  check(of('classes').length > 0 && of('classes').every(e => e.versionId === doid.id),
      'the DOID class constraints are pinned (resolved by class IRI → owning ontology)', JSON.stringify(of('classes')));
  check(of('valueSets').some(e => e.key === 'CEDARVS' && e.versionId === cedarvs.id),
      'the CEDARVS value-set constraint is pinned to the collection\'s current version', JSON.stringify(of('valueSets')));

  // Negative: an entry the terminology store does not serve is left unpinned, never guessed.
  const unserved = of('valueSets').find(e => e.key === 'ZZVS');
  check(!!unserved && unserved.versionId === null,
      'an unserved value-set constraint is left unpinned', JSON.stringify(unserved));
}
