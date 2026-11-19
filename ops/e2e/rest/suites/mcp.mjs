// The REST MCP, cedar-artifact-rest-mcp, gives a language model the resource server's artifact
// operations as tools. Its own build drives those tools against a stub transport, which proves the
// tools and not what the server makes of what they send. This suite starts the built server over
// stdio, as an MCP client does, signed in as the first test user, and takes templates through
// validation, creation, reading, update and deletion. It then does the same for one element, one
// field and one sparse instance of a created template, since each kind has tools and a path of its
// own. Each step is confirmed through the resource server directly rather than taken from the
// tool's word.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { suite, check, call, cleanup, artifactBody, enc, RESOURCE, RUN } from '../lib.mjs';

export const name = 'mcp';

const CEDAR_HOME = env.CEDAR_HOME ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MCP_HOME = join(CEDAR_HOME, 'mcp', 'cedar-artifact-rest-mcp');
const JAR = join(MCP_HOME, 'target', 'cedar-artifact-rest-mcp.jar');
const BUILD = `cd ${MCP_HOME} && mvn -q package -DskipTests`;
// Canned templates from the artifact library's suite: a small one, one with a type, and a nested one.
const CANNED = join(CEDAR_HOME, 'cedar-artifact-library', 'src', 'test', 'resources', 'templates-json');
const TEMPLATES = ['SimpleTemplate.json', 'SimpleTemplateWithType.json', 'ContributorV2.0.0.json'];
// Each kind's tool noun and collection, and the identifier a created one is reported under.
const KINDS = Object.fromEntries([
  ['template', 'templates'], ['element', 'template-elements'], ['field', 'template-fields'],
  ['instance', 'template-instances'],
].map(([noun, collection]) => [noun, {
  noun, collection, iri: new RegExp(`https?://[^\\s"']*/${collection}/[0-9A-Fa-f-]{8,}`),
}]));
const ANSWER_MS = 60_000;

/** The newest modification time under a path, so a jar older than its sources is caught. */
function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map(entry => newest(join(path, entry))));
}

/** The built jar, or why it cannot be used. */
function builtJar() {
  let jar;
  try {
    jar = statSync(JAR).mtimeMs;
  } catch {
    return { problem: `${JAR} is not built; run: ${BUILD}` };
  }
  const sources = Math.max(newest(join(MCP_HOME, 'src', 'main')), newest(join(MCP_HOME, 'pom.xml')));
  return jar >= sources ? {} : { problem: `${JAR} is older than its sources; run: ${BUILD}` };
}

/** One MCP server over stdio, spoken to in JSON-RPC as a client does. */
function startServer(apiKey) {
  const java = env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', 'java') : 'java';
  const child = spawn(java, ['-jar', JAR], {
    env: { ...env, CEDAR_BASE_URL: RESOURCE, CEDAR_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const waiting = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    waiting.get(message.id)?.(message);
  });
  const exited = new Promise(done => child.on('exit', code => done(code)));

  async function request(method, params) {
    const id = nextId++;
    const answer = new Promise(done => waiting.set(id, done));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    let timer;
    const timeout = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`no answer to ${method} within ${ANSWER_MS} ms`)), ANSWER_MS);
    });
    const ended = exited.then(code => { throw new Error(`the server exited with ${code}: ${stderr}`); });
    try {
      return await Promise.race([answer, timeout, ended]);
    } finally {
      clearTimeout(timer);
      waiting.delete(id);
    }
  }

  return {
    async initialize() {
      const answer = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cedar-rest-smoke', version: RUN },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return answer;
    },
    /** A tool's answer as its text and whether the tool called it an error. */
    async tool(toolName, args) {
      const answer = await request('tools/call', { name: toolName, arguments: args });
      if (answer.error) return { isError: true, text: JSON.stringify(answer.error) };
      const text = (answer.result?.content ?? []).map(item => item.text ?? '').join('\n');
      return { isError: answer.result?.isError === true, text };
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** Creates an artifact through its kind's tool, and confirms it through the resource server. */
async function create(server, auth, artifact, label, noun = 'template') {
  const kind = KINDS[noun];
  const created = await server.tool(`create_${noun}`, { artifact });
  const id = created.text.match(kind.iri)?.[0];
  if (!check(!created.isError && !!id, `${label}: create_${noun} creates it and reports its @id`,
      created.text.slice(0, 400))) return null;
  const at = `/${kind.collection}/${enc(id)}`;
  cleanup(noun, at, label);
  const stored = await call(auth, 'GET', at);
  check(stored.status === 200, `${label}: the resource server holds the created ${noun}`,
      `GET returned ${stored.status}: ${(stored.text ?? '').slice(0, 200)}`);
  return { id, at, stored: stored.body };
}

/** Deletes an artifact through its kind's tool, and confirms through the resource server that it is gone. */
async function remove(server, auth, made, label, noun = 'template') {
  const deleted = await server.tool(`delete_${noun}`, { id: made.id });
  check(!deleted.isError, `${label}: delete_${noun} deletes it`, deleted.text.slice(0, 400));
  const after = await call(auth, 'GET', made.at);
  check(after.status === 404, `${label}: the resource server no longer holds it`, `GET returned ${after.status}`);
}

/**
 * Reads an artifact back through its kind's tool, updates its description through the full form
 * the update tool asks for, and confirms the change through the resource server.
 */
async function readAndUpdate(server, auth, made, label, noun) {
  const fetched = await server.tool(`get_${noun}`, { id: made.id });
  check(!fetched.isError && fetched.text.includes(made.id), `${label}: get_${noun} reads it back`,
      fetched.text.slice(0, 400));
  const full = await server.tool(`get_${noun}`, { id: made.id, compact: false });
  const changed = `changed by the REST smoke ${RUN}`;
  const edited = full.text.replace(/^description: .*$/m, `description: ${changed}`);
  if (check(!full.isError && edited !== full.text, `${label}: get_${noun} gives the full form to edit`,
      full.text.slice(0, 400))) {
    const updated = await server.tool(`update_${noun}`, { id: made.id, artifact: edited });
    check(!updated.isError, `${label}: update_${noun} replaces it`, updated.text.slice(0, 400));
  }
  const stored = await call(auth, 'GET', made.at);
  check(stored.body?.['schema:description'] === changed, `${label}: the resource server holds the change`,
      `schema:description was ${JSON.stringify(stored.body?.['schema:description'])}`);
}

/** The verdict in a validation report, which the tool returns as the server's JSON whatever it says. */
function validates(text) {
  try {
    const report = JSON.parse(text);
    return report?.validates === true || report?.validates === 'true';
  } catch {
    return false;
  }
}

export async function run({ user1 }) {
  suite('mcp: the REST MCP takes templates through the resource server');

  const { problem } = builtJar();
  if (!check(!problem, 'the REST MCP jar is built from its current sources', problem)) return;
  const apiKey = user1.profile.apiKeys?.find(key => key.enabled)?.key;
  if (!check(!!apiKey, 'the first test user has an enabled API key', 'its profile lists none')) return;

  const server = startServer(apiKey);
  try {
    const initialized = await server.initialize();
    if (!check(initialized.result?.serverInfo?.name === 'cedar-artifact-rest-mcp',
        'the server answers an MCP initialize request', JSON.stringify(initialized).slice(0, 400))) return;

    for (const file of TEMPLATES) {
      const label = `${file} ${RUN}`;
      const document = JSON.parse(readFileSync(join(CANNED, file), 'utf8'));
      document['schema:name'] = label;
      // A created template starts a new series, which the server begins at Draft 0.0.1 with no
      // predecessor. The Contributor template is a later version of a stored one.
      document['pav:version'] = '0.0.1';
      document['bibo:status'] = 'bibo:draft';
      delete document['pav:previousVersion'];
      const artifact = JSON.stringify(document);

      const validated = await server.tool('validate_artifact', { artifact });
      check(!validated.isError && validates(validated.text), `${file}: validate_artifact accepts it`,
          validated.text.slice(0, 400));

      const made = await create(server, user1.auth, artifact, file);
      if (!made) continue;
      const fetched = await server.tool('get_template', { id: made.id });
      check(!fetched.isError && fetched.text.includes(label), `${file}: get_template reads it back`,
          fetched.text.slice(0, 400));
      await remove(server, user1.auth, made, file);
    }

    // An update follows the path the tool describes: fetch the full form, edit it, and send it back.
    // The change is confirmed by reading the template from the resource server.
    const label = `update ${RUN}`;
    const made = await create(server, user1.auth, `type: template\nname: ${label}\ndescription: original\n`, 'update');
    if (made) {
      const full = await server.tool('get_template', { id: made.id, compact: false });
      const edited = full.text.replace(/^description: .*$/m, 'description: changed');
      if (check(!full.isError && edited !== full.text, 'update: get_template gives the full form to edit',
          full.text.slice(0, 400))) {
        const updated = await server.tool('update_template', { id: made.id, artifact: edited });
        check(!updated.isError, 'update: update_template replaces it', updated.text.slice(0, 400));
      }
      const stored = await call(user1.auth, 'GET', made.at);
      check(stored.body?.['schema:description'] === 'changed', 'update: the resource server holds the change',
          `schema:description was ${JSON.stringify(stored.body?.['schema:description'])}`);
      await remove(server, user1.auth, made, 'update');
    }

    // An element and a field, each created from the same valid document the other suites use.
    for (const noun of ['element', 'field']) {
      const kindLabel = `MCP ${noun} ${RUN}`;
      const document = JSON.stringify(artifactBody(noun, kindLabel, { 'schema:description': 'original' }));
      const kindMade = await create(server, user1.auth, document, noun, noun);
      if (!kindMade) continue;
      await readAndUpdate(server, user1.auth, kindMade, noun, noun);
      await remove(server, user1.auth, kindMade, noun, noun);
    }

    // A sparse instance: lean YAML naming its template and nothing else. The create tool promises
    // that the server completes it against that template, so the stored instance must carry the
    // template's field, empty, and validate against the template it names.
    const basisLabel = `MCP instance basis ${RUN}`;
    const basis = await create(server, user1.auth,
        `type: template\nname: ${basisLabel}\ndescription: basis\nchildren:\n- key: Note\n  type: text-field\n  name: Note\n`,
        'instance basis');
    if (basis) {
      const instanceLabel = `MCP instance ${RUN}`;
      const instance = await create(server, user1.auth,
          `type: instance\nname: ${instanceLabel}\ndescription: original\nisBasedOn: ${basis.id}\n`, 'instance', 'instance');
      if (instance) {
        check(instance.stored?.['schema:isBasedOn'] === basis.id && Object.hasOwn(instance.stored ?? {}, 'Note'),
            'instance: the server completed the sparse instance against its template',
            `isBasedOn ${JSON.stringify(instance.stored?.['schema:isBasedOn'])}, keys ${Object.keys(instance.stored ?? {}).join(', ')}`);
        await readAndUpdate(server, user1.auth, instance, 'instance', 'instance');
        await remove(server, user1.auth, instance, 'instance', 'instance');
      }
      await remove(server, user1.auth, basis, 'instance basis');
    }
  } catch (error) {
    check(false, 'the REST MCP answers every request', error.message);
  } finally {
    server.stop();
  }
}
