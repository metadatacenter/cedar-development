#!/usr/bin/env node
// Write a component's bundle from a published package rather than from a rebuild.
//
// A rebuild of an old commit installs the packages its locks name, and Nexus deletes development
// packages a few days after publishing them. A published release keeps its tarball, so a
// comparison input that is a release, or a fixed reference that carries a release's code, is read
// from that tarball instead. npm pack checks the tarball against the integrity the registry
// records for the version.
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const PACKAGES = {cee: 'cedar-embeddable-editor', ced: 'cedar-embeddable-designer'};
export const NPMJS = 'https://registry.npmjs.org/';
const RELEASE = /^\d+\.\d+\.\d+$/;
const REFERENCES = join(dirname(fileURLToPath(import.meta.url)), 'references.json');

/** The package, version and registry a component's input is read from, or null for a rebuild. */
export function publishedBundle(component, {version, references} = {}) {
  const name = PACKAGES[component];
  if (version !== undefined) {
    if (!name || !RELEASE.test(version)) return null;
    return {package: name, version, registry: NPMJS, file: `${name}.js`};
  }
  const entry = references?.published?.[component];
  if (!entry) return null;
  if (entry.package !== name) throw new Error(`${component}: published reference names ${entry.package}, not ${name}`);
  if (!RELEASE.test(entry.version ?? '')) throw new Error(`${component}: published reference version ${entry.version} is not a release`);
  if (!/^https:\/\/\S+\/$/.test(entry.registry ?? '')) throw new Error(`${component}: published reference registry must be an https URL ending in /`);
  return {package: entry.package, version: entry.version, registry: entry.registry, file: `${name}.js`};
}

function fetchBundle(source, output) {
  const directory = mkdtempSync(join(tmpdir(), 'published-bundle-'));
  try {
    const tarball = execFileSync('npm', ['pack', `${source.package}@${source.version}`, '--registry', source.registry,
      '--pack-destination', directory, '--silent'], {encoding: 'utf8'}).trim().split('\n').pop();
    execFileSync('tar', ['-xzf', join(directory, tarball), '-C', directory, `package/${source.file}`]);
    copyFileSync(join(directory, 'package', source.file), output);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
  return createHash('sha256').update(readFileSync(output)).digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {component: {type: 'string'}, version: {type: 'string'}, output: {type: 'string'}}});
  if (!values.component || !values.output) {
    console.error('usage: published-bundle.mjs --component cee|ced [--version X.Y.Z] --output <file>');
    process.exit(2);
  }
  const references = JSON.parse(readFileSync(REFERENCES, 'utf8'));
  const source = publishedBundle(values.component, {version: values.version, references});
  if (!source) {
    console.log('published=false');
  } else {
    const digest = fetchBundle(source, values.output);
    console.error(`${source.package}@${source.version} from ${source.registry}: ${source.file}, sha256 ${digest}`);
    console.log('published=true');
  }
}
