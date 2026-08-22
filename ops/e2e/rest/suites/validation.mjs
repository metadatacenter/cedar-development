// Validation and conversion: two commands that proxy to the artifact server, so no per-service suite
// can reach them, and which sit under the product's central promise — that a template means something.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { suite, check, checkStatus, call, cleanup, enc, RUN } from '../lib.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const load = name => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
const yaml = name => readFileSync(resolve(FIXTURES, name), 'utf8');

export const name = 'validation';

export async function run({ user1, folderId }) {
  const auth = user1.auth;

  // Validating an instance is not a purely syntactic check: the server resolves the template the
  // instance is based on and refuses with 400 when it cannot be found. So the instance fixture needs
  // a template that actually exists, which means creating one first.
  const host = await call(auth, 'POST', `/templates?folder_id=${folderId ? encodeURIComponent(folderId) : ''}`,
      Object.assign(load('minimal-template.json'), { '@id': null, 'schema:name': `Validation Host ${RUN}` }));
  let hostId;
  if (checkStatus(host, 201, 'a host template is created for instance validation')) {
    hostId = host.body['@id'];
    cleanup('template', `/templates/${encodeURIComponent(hostId)}`, `Validation Host ${RUN}`);
  }

  suite('validate: a well-formed artifact of each kind');

  // Every kind has its own meta-schema, and resource_type selects which one is applied. A fixture
  // that validates as one kind should not validate as another, which is the second half below.
  const kinds = [
    ['template', 'minimal-template.json'],
    // The with-id variant, because the element meta-schema requires @id — see the asymmetry pinned
    // at the end of this suite.
    ['element', 'element-with-id.json'],
    ['field', 'minimal-field.json'],
    ['instance', 'minimal-instance.json'],
  ];
  for (const [kind, file] of kinds) {
    if (kind === 'instance' && !hostId) continue;
    const body = load(file);
    if (kind === 'instance') body['schema:isBasedOn'] = hostId;
    const res = await call(auth, 'POST', `/command/validate?resource_type=${kind}`, body);
    if (!checkStatus(res, 200, `${kind}: validation answers`)) continue;
    check(res.body?.validates === 'true', `${kind}: the fixture validates`,
        `validates=${res.body?.validates}, errors=${JSON.stringify(res.body?.errors ?? []).slice(0, 250)}`);
    check(Array.isArray(res.body?.errors) && res.body.errors.length === 0,
        `${kind}: and reports no errors`, `errors were ${JSON.stringify(res.body?.errors).slice(0, 200)}`);
  }

  suite('validate: a broken artifact is reported, not accepted');

  // Removing a property the meta-schema requires. The interesting part is not that it fails but that
  // the failure is *described*: a report that says "false" with no error would be useless to a caller,
  // and a 500 would be worse.
  const broken = load('minimal-template.json');
  delete broken.properties['oslc:modifiedBy'];
  const bad = await call(auth, 'POST', '/command/validate?resource_type=template', broken);
  if (checkStatus(bad, 200, 'a broken template still gets a 200 with a report')) {
    check(bad.body?.validates === 'false', 'the report says it does not validate',
        `validates=${bad.body?.validates}`);
    const errors = bad.body?.errors ?? [];
    check(errors.length > 0, 'and carries at least one error', 'the error list was empty');
    const first = errors[0] ?? {};
    check(typeof first.message === 'string' && first.message.length > 0,
        'the error has a message', `error was ${JSON.stringify(first).slice(0, 200)}`);
    check(typeof first.location === 'string',
        'and a location, so a caller can point at the offending part',
        `error was ${JSON.stringify(first).slice(0, 200)}`);
    check(JSON.stringify(first).includes('oslc:modifiedBy'),
        'and names the property that is missing',
        `the error did not mention it: ${JSON.stringify(first).slice(0, 200)}`);
  }

  // Nonsense is invalid rather than fatal.
  const nonsense = await call(auth, 'POST', '/command/validate?resource_type=template',
      { 'schema:name': 'not a template' });
  if (checkStatus(nonsense, 200, 'an object that is not an artifact gets a report too')) {
    check(nonsense.body?.validates === 'false', 'and it does not validate',
        `validates=${nonsense.body?.validates}`);
  }

  // An instance validated as a template must fail: otherwise resource_type is decorative.
  const crossedBody = load('minimal-instance.json');
  if (hostId) crossedBody['schema:isBasedOn'] = hostId;
  const crossed = await call(auth, 'POST', '/command/validate?resource_type=template', crossedBody);
  if (crossed.status === 200) {
    check(crossed.body?.validates === 'false',
        'an instance does not validate as a template — resource_type selects the schema',
        'the instance validated as a template, so the parameter is not being honoured');
  } else {
    check(false, 'an instance validated as a template answers', `${crossed.status}`);
  }

  suite('validate: the resource_type parameter itself');

  // These used to answer 500 while the body correctly described itself as invalidArgument. The cause
  // was one line: CedarErrorPack defaulted its status to INTERNAL_SERVER_ERROR and errorType() did not
  // derive it, though CedarErrorType.INVALID_ARGUMENT already declares BAD_REQUEST. errorType() now
  // adopts the type's status unless one was chosen explicitly, so the status and the reported type
  // agree. Asserting both together is the point: either alone would not show they had diverged.
  const unknownType = await call(auth, 'POST', '/command/validate?resource_type=banana',
      load('minimal-template.json'));
  if (checkStatus(unknownType, 400, 'an unknown resource_type is refused with 400')) {
    check(/invalidArgument/.test(unknownType.text ?? ''),
        'and the body agrees, reporting invalidArgument',
        `body was ${(unknownType.text ?? '').slice(0, 200)}`);
  }

  checkStatus(await call(auth, 'POST', '/command/validate', load('minimal-template.json')),
      400, 'a missing resource_type is refused with 400');

  suite('convert: each declared output format');

  // OutputFormatType declares exactly three. Asserting the shape of each, not just a 200, because a
  // converter that returns the input unchanged would pass a status-only check.
  const instance = load('minimal-instance.json');
  if (hostId) instance['schema:isBasedOn'] = hostId;

  const asJson = await call(auth, 'POST', '/command/convert?format=json', instance);
  if (checkStatus(asJson, 200, 'convert to json')) {
    check(asJson.body?.['schema:isBasedOn'] !== undefined,
        'the json form keeps the instance fields', `body began ${(asJson.text ?? '').slice(0, 120)}`);
  }

  const asJsonLd = await call(auth, 'POST', '/command/convert?format=jsonld', instance);
  if (checkStatus(asJsonLd, 200, 'convert to jsonld')) {
    check(asJsonLd.body?.['@context'] !== undefined,
        'the jsonld form carries an @context', `body began ${(asJsonLd.text ?? '').slice(0, 120)}`);
  }

  const asNquad = await call(auth, 'POST', '/command/convert?format=rdf-nquad', instance);
  if (checkStatus(asNquad, 200, 'convert to rdf-nquad')) {
    const text = asNquad.text ?? '';
    check(text.trimStart().startsWith('<'), 'the nquad form is triples rather than JSON',
        `body began "${text.slice(0, 80)}"`);
    check(text.includes(' .'), 'and statements are terminated', 'no statement terminator was found');
  }

  suite('convert: the format parameter itself');

  // No format at all: the endpoint applies a deliberate default (OutputFormatTypeDetector picks one),
  // so it is accepted rather than an error.
  const noFormat = await call(auth, 'POST', '/command/convert', instance);
  checkStatus(noFormat, 200, 'convert with no format applies a default and is accepted');

  // Fixed by the same one-line change as the resource_type cases above.
  const badFormat = await call(auth, 'POST', '/command/convert?format=banana', instance);
  if (checkStatus(badFormat, 400, 'an unknown format is refused with 400')) {
    check(/invalidArgument/.test(badFormat.text ?? ''),
        'and the body agrees, reporting invalidArgument',
        `body was ${(badFormat.text ?? '').slice(0, 200)}`);
  }

  suite('validate/create: the @id shapes a pre-create body can take');

  // The meta-schema types @id as ["string","null"] and requires the key, so an artifact that has not
  // been created yet carries @id: null — and that one shape both validates and creates, so the
  // validate-then-create workflow needs no placeholder. The other two are refused, each by the rule
  // that only the server assigns an identifier: omitting the key leaves nothing to tell "assign me
  // one" from "I forgot", and a real IRI asserts an identity nothing can resolve and the server is
  // about to replace. Create used to accept the omitted key, which made it the one shape that created
  // here and failed validation there.
  const base = () => Object.assign(load('minimal-template.json'), { 'schema:name': `Id Shape ${RUN}` });
  const validate = body => call(auth, 'POST', '/command/validate?resource_type=template', body);
  const create = async (body, label) => {
    const r = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, body);
    if (r.status === 201 && r.body?.['@id']) cleanup('template', `/templates/${enc(r.body['@id'])}`, label);
    return r;
  };

  const withNull = base(); withNull['@id'] = null;
  check((await validate(withNull)).body?.validates === 'true', 'an @id of null validates', 'it did not');
  checkStatus(await create(withNull, 'Id Shape null'), 201, 'and an @id of null creates — one body for both');

  const omitted = base(); delete omitted['@id'];
  check((await validate(omitted)).body?.validates === 'false',
      'an omitted @id does not validate — the meta-schema requires the key be present',
      'it validated, so the required-key rule is not being applied');
  check((await create(omitted, 'Id Shape omitted')).status === 400,
      'and an omitted @id does not create either — the key is how a client asks for one',
      'create accepted a body with no @id key');

  const realId = base();
  realId['@id'] = 'https://repo.metadatacenter.orgx/templates/11111111-1111-1111-1111-111111111111';
  check((await validate(realId)).body?.validates === 'true', 'a real IRI validates', 'it did not');
  check((await create(realId, 'Id Shape iri')).status === 400,
      'but create refuses a client-supplied IRI — it mints the id itself', 'create did not refuse it');

  suite('the identifier shapes a YAML body may take');

  // The same question over YAML, and the answer is the mirror image for two of the three shapes —
  // deliberately, because the two dialects say "no identifier yet" differently. JSON carries the key
  // with null in it, because the meta-schema requires the key. YAML has no such requirement and no use
  // for a placeholder, so the authoring form simply omits it and the transcoder refuses an explicit
  // null, naming the alternative. A real IRI is refused in both.
  const asYaml = { contentType: 'application/yaml' };
  const yamlTemplate = shape => {
    const full = yaml('template-full.yml');
    if (shape === 'omitted') return full.replace(/^id: .*\n/m, '');
    if (shape === 'null') return full.replace(/^id: .*$/m, 'id: null');
    return full.replace(/^id: .*$/m, 'id: https://repo.metadatacenter.orgx/templates/11111111-1111-1111-1111-111111111111');
  };
  const createYaml = async (shape, label) => {
    const r = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, yamlTemplate(shape), asYaml);
    if (r.status === 201 && r.body?.['@id']) cleanup('template', `/templates/${enc(r.body['@id'])}`, label);
    return r;
  };

  const yamlOmitted = await createYaml('omitted', `Yaml Id omitted ${RUN}`);
  if (checkStatus(yamlOmitted, 201, 'a YAML body that omits the identifier creates — omission is how YAML asks')) {
    const yamlId = yamlOmitted.body['@id'];
    check(!!yamlId, 'and the server assigned one', 'no identifier came back');

    const put = await call(auth, 'PUT', `/templates/${enc(yamlId)}`,
        yaml('template-full.yml').replace(/^id: .*$/m, `id: ${yamlId}`), asYaml);
    checkStatus(put, 200, 'and an update naming that identifier is accepted');

    const putWithout = await call(auth, 'PUT', `/templates/${enc(yamlId)}`, yamlTemplate('omitted'), asYaml);
    check(putWithout.status === 400,
        'while an update that omits it is refused — an update says which artifact it is updating',
        `expected 400, got ${putWithout.status}`);
  }

  const yamlNull = await createYaml('null', `Yaml Id null ${RUN}`);
  check(yamlNull.status === 400 && /omit the key/.test(yamlNull.text ?? ''),
      'an explicit null is refused, and the refusal names omission as the way to ask',
      `${yamlNull.status}: ${(yamlNull.text ?? '').slice(0, 160)}`);

  const yamlIri = await createYaml('iri', `Yaml Id iri ${RUN}`);
  check(yamlIri.status === 400,
      'and a real IRI is refused over YAML as it is over JSON — the server assigns identifiers',
      `expected 400, got ${yamlIri.status}`);

  // Validate negotiates YAML, which is what lets a client that authors in YAML check its work before
  // sending it. It was JSON only, and a YAML body reached Jackson and answered 500 — a server error for
  // the client's own business, on the one write-adjacent route that did not accept what the write
  // routes do.
  for (const [fixture, kind] of [['template-minimal.yml', 'template'], ['template-full.yml', 'template'],
                                 ['element-full.yml', 'element'], ['field-minimal.yml', 'field']]) {
    const validated = await call(auth, 'POST', `/command/validate?resource_type=${kind}`, yaml(fixture), asYaml);
    check(validated.status === 200 && validated.body?.validates === 'true',
        `${fixture} validates as YAML`,
        `${validated.status}: ${(validated.text ?? '').slice(0, 160)}`);
  }

  // And a body it cannot read is the client's mistake, so it answers 400 rather than 500 — which is
  // what this route used to do with any YAML at all.
  const unreadable = await call(auth, 'POST', '/command/validate?resource_type=template',
      'type: template\nname: X\nid: https://repo.metadatacenter.org/templates/11111111-1111-1111-1111-111111111111\n',
      asYaml);
  check(unreadable.status === 400,
      'YAML that cannot be read answers 400, not 500',
      `${unreadable.status}: ${(unreadable.text ?? '').slice(0, 160)}`);

  return {};
}
