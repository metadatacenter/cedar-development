// Validation and conversion: two commands that proxy to the artifact server, so no per-service suite
// can reach them, and which sit under the product's central promise — that a template means something.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { suite, check, checkStatus, call, updateArtifact, artifactBody, cleanup, enc, RUN, BRIDGE, TERMINOLOGY } from '../lib.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const load = name => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
const yaml = name => readFileSync(resolve(FIXTURES, name), 'utf8');

export const name = 'validation';

// Compare exact stored content while allowing only the metadata a successful update changes.
const content = body => {
  const copy = structuredClone(body);
  delete copy['pav:lastUpdatedOn']; delete copy['oslc:modifiedBy'];
  return copy;
};
const answers = body => Object.fromEntries(['Measurements','Code','Choice','Keep'].map(key=>[key,body[key]]));
const withoutYamlId = text => text.replace(/^id:.*\r?\n/m,'');

async function numericRangeJourney(auth, folderId) {
  suite('validate: current-template quality findings and structural save gates');
  const template = artifactBody('template', `Current constraints ${RUN}`);
  const terms = {};
  for (const key of ['Measurements','Code','Choice','Keep']) {
    const field = artifactBody('field',key);
    if (key === 'Measurements') {
      field._ui.inputType = 'numeric';
      field._valueConstraints = {requiredValue:true,numberType:'xsd:decimal'};
      field.required = ['@value','@type'];
    }
    if (key === 'Choice') {
      field._ui.inputType = 'radio';
      field._valueConstraints = {requiredValue:false,multipleChoice:false,literals:[{label:'Allowed'},{label:'Other'}]};
    }
    terms[key] = 'https://schema.metadatacenter.org/properties/constraint-journey-' + key;
    template.properties[key] = key === 'Measurements' ? {type:'array',minItems:0,items:field} : field;
    template.properties['@context'].properties[key] = {enum:[terms[key]]};
    template.properties['@context'].required.push(key);
    template.required.push(key); template._ui.order.push(key); template._ui.propertyLabels[key] = key;
  }
  const created = await call(auth,'POST',`/templates?folder_id=${enc(folderId)}`,template);
  if (!checkStatus(created,201,'create a template before its numeric, regex and literal constraints tighten')) return;
  const templatePath = '/templates/' + enc(created.body['@id']);
  cleanup('template',templatePath,template['schema:name']);
  const instance = artifactBody('instance',`Quality answers ${RUN}`,{'schema:isBasedOn':created.body['@id']});
  // The YAML renderer supplies this standard mapping. Start with the same canonical context so
  // the whole-document assertion below can require exact preservation of every other property.
  Object.assign(instance['@context'],{'pav:derivedFrom':{'@type':'@id'}},terms);
  instance.Measurements = ['100','200'].map(value=>({'@value':value,'@type':'xsd:decimal'}));
  instance.Code = {'@value':'lowercase'}; instance.Choice = {'@value':'Other'}; instance.Keep = {'@value':'Preserved sibling'};
  const saved = await call(auth,'POST',`/template-instances?folder_id=${enc(folderId)}`,instance);
  if (!checkStatus(saved,201,'save answers before the template constraints are tightened')) return;
  const path = '/template-instances/' + enc(saved.body['@id']);
  cleanup('instance',path,instance['schema:name']);
  let current = await call(auth,'GET',path);
  if (!checkStatus(current,200,'read the record before tightening constraints')) return;
  check(!!current.headers.get('etag'),'the record has a revision for conditional updates');
  const latestTemplate = await call(auth,'GET',templatePath);
  Object.assign(latestTemplate.body.properties.Measurements.items._valueConstraints,{minValue:150,maxValue:175});
  latestTemplate.body.properties.Code._valueConstraints.regex = '^[A-Z]+$';
  latestTemplate.body.properties.Choice._valueConstraints.literals = [{label:'Allowed'}];
  if (!checkStatus(await updateArtifact(auth,templatePath,latestTemplate.body),200,'tighten bounds, regex and literal membership while the client holds the old record')) return;
  const validation = await call(auth,'POST','/command/validate?resource_type=instance',current.body);
  check(validation.status === 200 && validation.body?.validates === 'true' && validation.body?.canSave === true && validation.body?.isValid === false,
    'well-formed answers outside current constraints are saveable quality findings',validation.text);
  for (const [code,location] of [['minValue','/Measurements/0/@value'],['maxValue','/Measurements/1/@value'],['regex','/Code/@value'],['choiceMembership','/Choice/@value']]) {
    check(validation.body?.findings?.some(f=>f.code === code && f.path === location && f.category === 'constraint') &&
        validation.body?.warnings?.some(f=>f.location === location),`${code} has a stable finding code, constraint category, exact path and warning`,validation.text);
  }
  for (const format of ['json','yaml']) {
    const before = current;
    const body = format === 'json' ? before.body : (await call(auth,'GET',path,undefined,{accept:'application/yaml'})).text;
    const response = await call(auth,'PUT',path,body,
      {contentType:format === 'json' ? 'application/json' : 'application/yaml',headers:{'If-Match':before.headers.get('etag')}});
    checkStatus(response,200,`${format} updates preserve answers outside current numeric, regex and literal constraints`);
    current = await call(auth,'GET',path);
    check(isDeepStrictEqual(content(current.body),content(before.body)),`${format} update preserves every answer, sibling and unrelated property`,
      JSON.stringify({before:content(before.body),after:content(current.body)},null,2));
  }
  for (const format of ['json','yaml']) {
    const body = format === 'json' ? instance : withoutYamlId((await call(auth,'GET',path,undefined,{accept:'application/yaml'})).text);
    const response = await call(auth,'POST',`/template-instances?folder_id=${enc(folderId)}`,body,
      {contentType:format === 'json' ? 'application/json' : 'application/yaml'});
    if (checkStatus(response,201,`${format} creates permit the same well-formed value-quality violations`)) {
      const createdPath = '/template-instances/' + enc(response.body['@id']);
      cleanup('instance',createdPath,`Quality ${format} create`);
      const reopened = await call(auth,'GET',createdPath);
      check(isDeepStrictEqual(answers(reopened.body),answers(instance)),`${format} create preserves exact numeric text, rejected-choice text and sibling content`);
    }
  }

  // A present empty answer is incomplete, while an absent required structural property is malformed.
  const empty = structuredClone(current.body); empty.Measurements[0]['@value'] = null;
  const emptyReport = await call(auth,'POST','/command/validate?resource_type=instance',empty);
  check(emptyReport.status === 200 && emptyReport.body?.canSave === true && emptyReport.body?.isValid === false &&
      emptyReport.body?.findings?.some(f=>f.category === 'completeness' && f.path === '/Measurements/0/@value'),
    'a present null numeric answer is incomplete and saveable, not a missing structural value',emptyReport.text);
  for (const [label,damage] of [
    ['malformed numeric text',b=>{b.Measurements[0]['@value']='not a number';}],
    ['missing numeric @type',b=>{delete b.Measurements[0]['@type'];}],
    ['missing numeric @value',b=>{delete b.Measurements[0]['@value'];}],
    ['missing required property',b=>{delete b.Measurements;}],
  ]) {
    const broken = structuredClone(current.body); damage(broken);
    const report = await call(auth,'POST','/command/validate?resource_type=instance',broken);
    check(report.status === 200 && report.body?.validates === 'false' && report.body?.canSave === false && report.body?.errors?.length > 0,
      `${label} is a structural refusal in the common report`,report.text);
    checkStatus(await call(auth,'PUT',path,broken,{headers:{'If-Match':current.headers.get('etag')}}),400,`${label} cannot update a record`);
    const unchanged = await call(auth,'GET',path);
    check(isDeepStrictEqual(unchanged.body,current.body) && unchanged.headers.get('etag') === current.headers.get('etag'),
      `${label} refusal preserves the entire record and its ETag`);
    broken['@id'] = null;
    checkStatus(await call(auth,'POST',`/template-instances?folder_id=${enc(folderId)}`,broken),400,`${label} cannot create a record`);
  }
  const yamlBefore = await call(auth,'GET',path,undefined,{accept:'application/yaml'});
  const malformedYaml = yamlBefore.text.replace(/(\bvalue:\s*)["']?100["']?(?=\s*\n)/,'$1"not a number"');
  if (check(malformedYaml !== yamlBefore.text,'the YAML structural probe changes a numeric scalar')) {
    checkStatus(await call(auth,'PUT',path,malformedYaml,{contentType:'application/yaml',headers:{'If-Match':current.headers.get('etag')}}),400,
      'YAML malformed numeric text cannot update a record');
    const unchanged = await call(auth,'GET',path);
    check(isDeepStrictEqual(unchanged.body,current.body) && unchanged.headers.get('etag') === current.headers.get('etag'),
      'YAML structural refusal preserves the entire record and its ETag');
    checkStatus(await call(auth,'POST',`/template-instances?folder_id=${enc(folderId)}`,withoutYamlId(malformedYaml),{contentType:'application/yaml'}),400,
      'YAML malformed numeric text cannot create a record');
  }

  const definition = await call(auth,'GET',templatePath), inconsistent = structuredClone(definition.body);
  inconsistent.properties.Measurements.items._valueConstraints.defaultValue = '999';
  const defaultReport = await call(auth,'POST','/command/validate?resource_type=template',inconsistent);
  check(defaultReport.status === 200 && defaultReport.body?.canSave === false && defaultReport.body?.validates === 'false',
    'an out-of-range numeric default makes the template unsaveable',defaultReport.text);
  checkStatus(await call(auth,'PUT',templatePath,inconsistent,{headers:{'If-Match':definition.headers.get('etag')}}),400,
    'an inconsistent numeric default cannot update a template');
  const unchangedDefinition = await call(auth,'GET',templatePath);
  check(isDeepStrictEqual(unchangedDefinition.body,definition.body) && unchangedDefinition.headers.get('etag') === definition.headers.get('etag'),
    'rejected template defaults preserve the definition and its ETag');
  inconsistent['@id'] = null;
  checkStatus(await call(auth,'POST',`/templates?folder_id=${enc(folderId)}`,inconsistent),400,
    'an inconsistent numeric default cannot create a template');

  const correction = structuredClone(current.body);
  correction.Measurements[0]['@value'] = '150'; correction.Measurements[1]['@value'] = '175';
  correction.Code['@value'] = 'CORRECTED'; correction.Choice['@value'] = 'Allowed';
  checkStatus(await call(auth,'PUT',path,correction,{headers:{'If-Match':current.headers.get('etag')}}),200,
    'exact boundaries, a matching string and an allowed choice save');
  const reopened = await call(auth,'GET',path);
  check(isDeepStrictEqual(content(reopened.body),content(correction)) && reopened.headers.get('etag') !== current.headers.get('etag'),
    'all corrected answers reopen exactly, with every other property preserved and a new ETag');
  const correctedReport = await call(auth,'POST','/command/validate?resource_type=instance',reopened.body);
  check(correctedReport.status === 200 && correctedReport.body?.canSave === true && correctedReport.body?.isValid === true,
    'corrected answers satisfy the current template as well as the save policy',correctedReport.text);
}

async function semanticVerification(auth) {
  suite('validate: semantic facts distinguish invalid, omitted and unavailable checks');
  const iri = 'urn:cedar:e2e:semantic-probe';
  const verify = valueConstraints => call(auth,'POST','/bioportal/validate-term',{iri,valueConstraints},{base:TERMINOLOGY});
  const unchecked = await verify({});
  check(unchecked.status === 200 && unchecked.body?.status === 'notChecked' && unchecked.body?.code === 'semanticNotChecked' && unchecked.body?.iri === iri,
    'no terminology constraints means not checked, never proof of existence',unchecked.text);
  const missingRelease = await verify({ontologies:[{acronym:'CEDAR_E2E_MISSING_RELEASE',version:{id:'missing-release'}}]});
  check(missingRelease.status === 200 && missingRelease.body?.status === 'unavailable' && missingRelease.body?.code === 'semanticUnavailable',
    'an unavailable pinned release is not an invalid term and cannot fall back to latest',missingRelease.text);
  const excluded = await verify({actions:[{termUri:iri,action:'delete',type:'OntologyClass',source:'DOID'}]});
  check(excluded.status === 200 && excluded.body?.status === 'failed' && excluded.body?.code === 'controlledTermMembership' && excluded.body?.iri === iri,
    'an exact identifier exclusion is a failed membership fact without a label lookup',excluded.text);
  checkStatus(await verify({futureConstraint:true}),400,'unknown semantic constraint fields are rejected rather than silently omitted');
  checkStatus(await verify({branches:[{uri:'urn:cedar:e2e:root',acronym:'DOID',maxDepth:-1}]}),400,
    'a negative branch depth is malformed rather than an unconstrained success');
  const authorityIri = 'https://example.org/not-an-orcid';
  const authority = await call(auth,'POST','/ext-auth/orcid/verify',{iri:authorityIri},{base:BRIDGE});
  check(authority.status === 200 && authority.body?.status === 'failed' && authority.body?.code === 'authorityIdentifier' && authority.body?.iri === authorityIri,
    'authority-specific verification refuses a foreign identifier and preserves its spelling',authority.text);
  checkStatus(await call(auth,'POST','/ext-auth/orcid/verify',{iri:123},{base:BRIDGE}),400,
    'malformed authority requests are rejected before verification');
}

export async function run({ user1, folderId }) {
  const auth = user1.auth;
  await numericRangeJourney(auth, folderId);
  await semanticVerification(auth);
  suite('validation');

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

    const put = await updateArtifact(auth, `/templates/${enc(yamlId)}`,
        yaml('template-full.yml').replace(/^id: .*$/m, `id: ${yamlId}`), asYaml);
    checkStatus(put, 200, 'and an update naming that identifier is accepted');

    const putWithout = await updateArtifact(
        auth, `/templates/${enc(yamlId)}`, yamlTemplate('omitted'), asYaml);
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
