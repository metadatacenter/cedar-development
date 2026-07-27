// YAML content negotiation, which is local to this build and therefore not in the published API
// docs. The transcoder has unit tests; this asserts the negotiation itself, over the wire.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const yaml = name => readFileSync(resolve(FIXTURES, name), 'utf8');

export const name = 'negotiation';

export async function run({ user1, folderId }) {
  const auth = user1.auth;
  suite('content negotiation: YAML in and out');

  const label = `Negotiated Template ${RUN}`;
  const post = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`, artifactBody('template', label));
  if (!checkStatus(post, 201, 'template created as JSON')) return {};
  const at = `/templates/${enc(post.body['@id'])}`;
  cleanup('template', at, label);

  // JSON stays the default when nothing is asked for.
  const asJson = await call(auth, 'GET', at);
  check((asJson.headers.get('content-type') ?? '').includes('json'),
      'a request with no Accept header is served JSON',
      `content-type was ${asJson.headers.get('content-type')}`);

  // YAML on request.
  const asYaml = await call(auth, 'GET', at, undefined, { accept: 'application/yaml' });
  if (checkStatus(asYaml, 200, 'the same template is served as YAML')) {
    const ct = asYaml.headers.get('content-type') ?? '';
    check(ct.includes('yaml'), 'the response is typed as YAML', `content-type was ${ct}`);
    check(!asYaml.text.trimStart().startsWith('{'), 'and the body is not JSON',
        `body began "${asYaml.text.slice(0, 40)}"`);
    check(asYaml.text.includes(label), 'and it carries the template name',
        'the name was not in the YAML');
  }

  // An Accept the endpoint cannot satisfy must be refused, not silently defaulted.
  const nonsense = await call(auth, 'GET', at, undefined, { accept: 'application/octet-stream' });
  check(nonsense.status === 406 || nonsense.status === 200,
      'an unsupported Accept is either refused with 406 or falls back deliberately',
      `got ${nonsense.status}`);
  if (nonsense.status === 200) {
    check((nonsense.headers.get('content-type') ?? '').includes('json'),
        'the fallback for an unsupported Accept is JSON',
        `content-type was ${nonsense.headers.get('content-type')}`);
  }

  suite('content negotiation: which YAML forms may be written');

  // Three forms, and the contract distinguishes them by what they carry rather than by a parameter.
  // ArtifactYamlTranscoder treats an id with none of the system-recorded keys (version, status,
  // modelVersion, provenance) as the compact read-time form and refuses it, because storing it would
  // silently regenerate that content. The fixtures here are derived from the artifact library's
  // paired JSON/YAML templates, which is where the forms are maintained.
  const created = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      yaml('template-minimal.yml'), { contentType: 'application/yaml' });
  if (checkStatus(created, 201, 'the minimal authoring form is accepted on create')) {
    const id = created.body['@id'];
    cleanup('template', `/templates/${enc(id)}`, `YAML minimal ${RUN}`);
    check(!!id, 'and the system assigns the identifier it omitted', 'no identifier came back');

    // The stored artifact must be readable as JSON: YAML on the way in must not leave a YAML-shaped
    // artifact behind.
    const asJson = await call(auth, 'GET', `/templates/${enc(id)}`);
    check(asJson.status === 200 && asJson.body?.['@type']?.includes('Template'),
        'what YAML created reads back as a proper JSON template',
        `${asJson.status}: ${(asJson.text ?? '').slice(0, 150)}`);

    // And an update in the full form — id plus the system keys — is accepted where compact is not.
    const full = yaml('template-full.yml').replace(/^id: .*$/m, `id: ${id}`);
    const put = await call(auth, 'PUT', `/templates/${enc(id)}`, full, { contentType: 'application/yaml' });
    checkStatus(put, 200, 'the full form is accepted on update');
  }

  // The two rejections come from different guards and must stay distinguishable: a test that only
  // checked for 400 would not notice if the compact guard stopped firing and the generic identifier
  // rule started catching it instead.
  const compact = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      yaml('template-compact.yml'), { contentType: 'application/yaml' });
  if (checkStatus(compact, 400, 'the compact form is refused on create')) {
    check(/compact form/i.test(compact.text ?? ''),
        'and refused specifically as the compact form, not as a stray identifier',
        `the message was "${(compact.text ?? '').slice(0, 200)}"`);
  }

  const fullOnCreate = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      yaml('template-full.yml'), { contentType: 'application/yaml' });
  if (checkStatus(fullOnCreate, 400, 'the full form is refused on create, because it carries an id')) {
    check(/@id/.test(fullOnCreate.text ?? ''),
        'and refused for the identifier rather than as the compact form',
        `the message was "${(fullOnCreate.text ?? '').slice(0, 200)}"`);
  }

  // x-yaml is the older spelling and must behave the same as application/yaml.
  const xYaml = await call(auth, 'GET', at, undefined, { accept: 'application/x-yaml' });
  check(xYaml.status === 200 && (xYaml.headers.get('content-type') ?? '').includes('yaml'),
      'application/x-yaml is honoured as well as application/yaml',
      `${xYaml.status}, content-type ${xYaml.headers.get('content-type')}`);

  return {};
}
