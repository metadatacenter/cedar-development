// Downloading and reading artifacts as JSON and YAML, and the compact YAML form.
//
// The `negotiation` suite covers YAML on GET/PUT and the compact-refused-on-write contract, but only
// for templates and only on the CRUD routes. The `POST /{kind}/{id}/download` endpoints — which offer
// the same Accept-header JSON/YAML choice plus a YAML-only `?compact` flag — were untested for every
// kind, and the compact *output* form was untested anywhere. This suite closes both: the full
// download matrix per kind, the read-only nature of the compact form, and YAML/compact on the plain
// GET across all four kinds.
//
// full YAML carries id and the system keys (status, version, modelVersion, created/modified on/by);
// compact YAML keeps id/type/name/children but drops the system keys — the differential asserted below.
import { suite, check, checkStatus, call, cleanup, artifactBody, KINDS, enc, RUN } from '../lib.mjs';

export const name = 'download';

// The two YAML media types the API accepts. Both /download and the CRUD routes advertise both in
// their @Produces, so either works; the download matrix requests the common, IANA-registered
// application/yaml, and a separate check confirms the x-yaml alias is honored too.
const DL_YAML = 'application/yaml';
const XYAML = 'application/x-yaml';
const GET_YAML = 'application/yaml';
// The provenance/version keys that a full serialization carries and a compact one omits. Anchored to
// a line start (with the YAML two-space indent tolerated) so a substring inside a value never matches.
const SYSTEM_KEY = /\n(status|version|modelVersion|createdOn|createdBy|modifiedOn|modifiedBy):/;

const header = (res, name) => (res.headers.get(name) || '');

export async function run({ user1, folderId }) {
  const auth = user1.auth;

  suite('download: JSON, YAML, and compact YAML for every artifact kind');

  let baseTemplateId;
  let compactTemplateYaml;   // kept for the read-only cross-check below
  for (const { kind, path } of KINDS) {
    const label = `Download ${kind} ${RUN}`;
    const extra = kind === 'instance' && baseTemplateId ? { 'schema:isBasedOn': baseTemplateId } : {};
    const post = await call(auth, 'POST', `${path}?folder_id=${enc(folderId)}`, artifactBody(kind, label, extra));
    if (!checkStatus(post, 201, `${kind}: created to download`)) continue;
    const id = post.body['@id'];
    const at = `${path}/${enc(id)}`;
    if (kind === 'template') baseTemplateId = id;
    cleanup(kind, at, label);
    const dl = `${at}/download`;

    // JSON — the default (no Accept, or */*, or application/json).
    const j = await call(auth, 'POST', dl);
    if (checkStatus(j, 200, `${kind}: downloads as JSON`)) {
      check(header(j, 'content-type').includes('json'), `${kind}: JSON download is typed JSON`,
          `content-type was ${header(j, 'content-type')}`);
      const cd = header(j, 'content-disposition');
      check(cd.includes('attachment') && cd.includes('.json'),
          `${kind}: JSON download is an attachment named .json`, `content-disposition was ${cd}`);
      check(j.body?.['@id'] === id, `${kind}: JSON download is the artifact itself`,
          `@id was ${j.body?.['@id']}`);
    }

    // YAML — full form.
    const yf = await call(auth, 'POST', dl, undefined, { accept: DL_YAML });
    let fullYaml = null;
    if (checkStatus(yf, 200, `${kind}: downloads as YAML`)) {
      fullYaml = yf.text ?? '';
      check(header(yf, 'content-type').includes('yaml'), `${kind}: YAML download is typed YAML`,
          `content-type was ${header(yf, 'content-type')}`);
      check(header(yf, 'content-disposition').includes('.yaml'),
          `${kind}: YAML download is an attachment named .yaml`,
          `content-disposition was ${header(yf, 'content-disposition')}`);
      check(/\ntype:/.test('\n' + fullYaml) || /^type:/.test(fullYaml),
          `${kind}: the YAML has the artifact body`, `body began ${fullYaml.slice(0, 60)}`);
      check(SYSTEM_KEY.test('\n' + fullYaml), `${kind}: the full YAML carries the system keys`,
          'no system key found in the full form');
    }

    // YAML — compact form.
    const yc = await call(auth, 'POST', `${dl}?compact=true`, undefined, { accept: DL_YAML });
    if (checkStatus(yc, 200, `${kind}: downloads as compact YAML`) && fullYaml !== null) {
      const compactYaml = yc.text ?? '';
      if (kind === 'template') compactTemplateYaml = compactYaml;
      check(header(yc, 'content-type').includes('yaml'), `${kind}: compact download is typed YAML`,
          `content-type was ${header(yc, 'content-type')}`);
      check(!SYSTEM_KEY.test('\n' + compactYaml),
          `${kind}: the compact YAML drops the system keys the full form carries`,
          'a system key survived into the compact form');
      check(compactYaml.length < fullYaml.length,
          `${kind}: the compact form is smaller than the full form`,
          `compact ${compactYaml.length} >= full ${fullYaml.length} bytes`);
    }
  }

  suite('download: both YAML media types are accepted');

  // The download matrix above uses application/yaml; confirm the x-yaml alias is honored too, so
  // download matches the CRUD routes, which advertise both. (A regression here would be download's
  // @Produces losing one of the two YAML media types.)
  if (baseTemplateId) {
    const xy = await call(auth, 'POST', `/templates/${enc(baseTemplateId)}/download`, undefined,
        { accept: XYAML });
    check(xy.status === 200 && (xy.headers.get('content-type') || '').includes('yaml'),
        'download also accepts application/x-yaml',
        `expected 200 + yaml, got ${xy.status} / ${xy.headers.get('content-type')}`);
  }

  suite('download: a compact body creates a new artifact rather than writing one back');

  // The compact form describes an artifact being authored: it carries no identifier, because a
  // repository assigns that on save. So a compact download can be POSTed — and what it creates is a
  // new artifact, not an overwrite of the one it came from. That is the asymmetry worth pinning now:
  // the form cannot name a stored artifact, so it cannot silently replace one.
  if (compactTemplateYaml) {
    const back = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
        compactTemplateYaml, { contentType: GET_YAML });
    check(back.status === 201, 'a compact YAML download is accepted as a create',
        `expected 201, got ${back.status}: ${(back.text ?? '').slice(0, 160)}`);
    const createdId = back.body?.['@id'];
    check(Boolean(createdId) && createdId !== baseTemplateId,
        'and what it creates is a new artifact, not the one it was downloaded from',
        `downloaded ${baseTemplateId}, created ${createdId}`);
    if (createdId) {
      cleanup('template', `/templates/${enc(createdId)}`, 'compact create');
    }
  }

  suite('download: the plain GET negotiates YAML and compact for every kind');

  // negotiation.mjs proves this for templates on GET; here it is extended to element/field/instance,
  // and to the compact *output* form that nothing exercised.
  for (const { kind, path } of KINDS) {
    const label = `GetNegotiate ${kind} ${RUN}`;
    const extra = kind === 'instance' && baseTemplateId ? { 'schema:isBasedOn': baseTemplateId } : {};
    const post = await call(auth, 'POST', `${path}?folder_id=${enc(folderId)}`, artifactBody(kind, label, extra));
    if (!checkStatus(post, 201, `${kind}: created for GET negotiation`)) continue;
    const at = `${path}/${enc(post.body['@id'])}`;
    cleanup(kind, at, label);

    const yamlGet = await call(auth, 'GET', at, undefined, { accept: GET_YAML });
    let full = null;
    if (checkStatus(yamlGet, 200, `${kind}: GET returns YAML for application/yaml`)) {
      full = yamlGet.text ?? '';
      check(header(yamlGet, 'content-type').includes('yaml'), `${kind}: the GET response is typed YAML`,
          `content-type was ${header(yamlGet, 'content-type')}`);
    }
    const compactGet = await call(auth, 'GET', `${at}?compact=true`, undefined, { accept: GET_YAML });
    if (checkStatus(compactGet, 200, `${kind}: GET returns compact YAML for ?compact=true`) && full !== null) {
      const compact = compactGet.text ?? '';
      check(!SYSTEM_KEY.test('\n' + compact) && compact.length < full.length,
          `${kind}: the compact GET drops system keys and is smaller than full`,
          `compact ${compact.length} vs full ${full.length}; system key present: ${SYSTEM_KEY.test('\n' + compact)}`);
    }
  }

  return {};
}
