// Validation and conversion: two commands that proxy to the artifact server, so no per-service suite
// can reach them, and which sit under the product's central promise — that a template means something.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { suite, check, checkStatus, call, cleanup, note, RUN } from '../lib.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const load = name => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

export const name = 'validation';

export async function run({ user1, folderId }) {
  const auth = user1.auth;

  // Validating an instance is not a purely syntactic check: the server resolves the template the
  // instance is based on and refuses with 400 when it cannot be found. So the instance fixture needs
  // a template that actually exists, which means creating one first.
  const host = await call(auth, 'POST', `/templates?folder_id=${folderId ? encodeURIComponent(folderId) : ''}`,
      Object.assign(load('minimal-template.json'), { '@id': undefined, 'schema:name': `Validation Host ${RUN}` }));
  let hostId;
  if (host.status === 201) {
    hostId = host.body['@id'];
    cleanup('template', `/templates/${encodeURIComponent(hostId)}`, `Validation Host ${RUN}`);
  } else {
    note('instance validation could not be exercised against a real template',
        `the host template was not created: ${host.status}`);
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

  suite('validate: what a caller can and cannot validate before creating');

  // Validation requires @id; a create refuses it. So the exact body a client is about to POST does
  // not validate, and a client that wants to check first has to add a placeholder identifier. That is
  // a real trap for anyone building against this API, and it is invisible unless both halves are
  // asserted together.
  const forCreate = load('minimal-template.json');
  delete forCreate['@id'];
  const withoutId = await call(auth, 'POST', '/command/validate?resource_type=template', forCreate);
  if (checkStatus(withoutId, 200, 'a create-shaped body (no identifier) can be validated')) {
    check(withoutId.body?.validates === 'false',
        'but it does not validate, because the meta-schema requires @id while a create forbids it',
        `validates=${withoutId.body?.validates}`);
    check(JSON.stringify(withoutId.body?.errors ?? []).includes('@id'),
        'and the error names @id, so the cause is discoverable',
        `errors were ${JSON.stringify(withoutId.body?.errors ?? []).slice(0, 200)}`);
  }

  const withPlaceholder = Object.assign(load('minimal-template.json'),
      { '@id': 'https://repo.metadatacenter.orgx/templates/11111111-1111-1111-1111-111111111111' });
  const placeheld = await call(auth, 'POST', '/command/validate?resource_type=template', withPlaceholder);
  check(placeheld.status === 200 && placeheld.body?.validates === 'true',
      'the same body validates once any identifier is supplied',
      `validates=${placeheld.body?.validates}, errors=${JSON.stringify(placeheld.body?.errors ?? []).slice(0, 150)}`);

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

  // No format at all: whatever the default is, it must be a deliberate one rather than an error.
  const noFormat = await call(auth, 'POST', '/command/convert', instance);
  if (noFormat.status === 200) {
    note('convert with no format is accepted', 'a default applies; OutputFormatTypeDetector chooses it');
  } else {
    check(noFormat.status >= 400 && noFormat.status < 500,
        'convert with no format is refused with 4xx', `got ${noFormat.status}`);
  }

  // Fixed by the same one-line change as the resource_type cases above.
  const badFormat = await call(auth, 'POST', '/command/convert?format=banana', instance);
  if (checkStatus(badFormat, 400, 'an unknown format is refused with 400')) {
    check(/invalidArgument/.test(badFormat.text ?? ''),
        'and the body agrees, reporting invalidArgument',
        `body was ${(badFormat.text ?? '').slice(0, 200)}`);
  }

  return {};
}
