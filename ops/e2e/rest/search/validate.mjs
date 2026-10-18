import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitions, materialize } from './corpus.mjs';

// Offline only: run the existing validator/reader against in-memory materialized artifacts with a
// prebuilt local jar. Never build dependencies, download schemas or contact an application server.
export function validateArtifacts({ home = fileURLToPath(new URL('../../../../../', import.meta.url)), java, jar } = {}) {
  if (!java) {
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      java = resolve(result.stdout.trim(), 'bin/java');
    } else java = process.env.JAVA_HOME ? resolve(process.env.JAVA_HOME, 'bin/java') : 'java';
  }
  const version = spawnSync(java, ['-version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, 'Java 17 must already be installed');
  assert.match(version.stderr, /version "17\./, 'Use Java 17 for the offline validator');
  if (!jar) {
    const target = resolve(home, 'cedar-artifact-server/cedar-artifact-server-application/target');
    assert.ok(existsSync(target), 'Build the artifact-server jar separately; this command never builds');
    const jars = readdirSync(target).filter(name => /^cedar-artifact-server-application-.*\.jar$/.test(name));
    assert.equal(jars.length, 1, 'Need exactly one prebuilt artifact-server application jar');
    jar = resolve(target, jars[0]);
  }
  const bodies = materialize(), requests = [{ op: 'hello' }];
  for (const spec of definitions) {
    const body = bodies.get(spec.alias);
    if (spec.kind === 'template') requests.push({ op: 'cache-template', id: body['@id'], template: body });
    requests.push({ seq: spec.alias, op: 'validate', kind: spec.kind, artifact: body,
      ...(spec.template ? { templateId: bodies.get(spec.template)['@id'] } : {}) });
  }
  const run = spawnSync(java, ['-cp', jar, resolve(home, 'cedar-development/ops/cedar_validation_bridge.java')],
    { input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 60000, maxBuffer: 20e6 });
  assert.equal(run.status, 0, `Validator failed: ${run.error?.message ?? run.stderr}`);
  const answers = run.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const checked = answers.filter(answer => answer.op === 'validate');
  assert.equal(checked.length, definitions.length, 'Validator omitted artifacts');
  for (const result of checked) {
    assert.equal(result.status, 'valid', `${result.seq}: ${JSON.stringify(result.errors ?? result)}`);
    if (result.seq && bySchema(result.seq)) assert.equal(result.reader?.status, 'read', `${result.seq}: reader ${JSON.stringify(result.reader)}`);
  }
  return { status: 'OFFLINE_ARTIFACTS_VALID', count: checked.length, jar, java,
    limitations: 'Local compiled validator/reader only. Server create, indexing, search and browser behavior have not been executed.' };
}
const bySchema = alias => definitions.find(spec => spec.alias === alias)?.kind !== 'instance';
