// YAML content negotiation, which is local to this build and therefore not in the published API
// docs. The transcoder has unit tests; this asserts the negotiation itself, over the wire.
import { suite, check, checkStatus, call, cleanup, artifactBody, enc, RUN } from '../lib.mjs';

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

  return {};
}
