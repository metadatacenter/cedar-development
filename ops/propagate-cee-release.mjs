#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OPS = dirname(fileURLToPath(import.meta.url));

/**
 * The consumers, read from the train configuration beside this script.
 *
 * This list used to be written out here, and it drifted: `frontend-train.json` declared a
 * `ceeConsumer` for the Designer host and this array did not, so a release pinned seven of the
 * eight and the Designer went on serving the previous editor. Nothing said so — the propagation
 * reported every consumer it knew about as `ok`. Reading the configuration removes the second
 * copy that could disagree with it rather than correcting this one to match today.
 */
function consumerFrom(repository, label, entry) {
  const within = dirname(entry.manifest);
  return Object.freeze({
    label,
    directory: within === '.' ? repository : `${repository}/${within}`,
    legacyPeerDeps: entry.legacyPeerDeps === true,
  });
}

export function ceeConsumers(configPath = resolve(OPS, 'frontend-train.json')) {
  const config = readJson(configPath);
  const consumers = [];
  for (const frontend of config.frontends ?? []) {
    if (frontend.ceeConsumer) {
      consumers.push(consumerFrom(frontend.repository, frontend.id, frontend.ceeConsumer));
    }
  }
  for (const extra of config.additionalCeeConsumers ?? []) {
    consumers.push(consumerFrom(extra.repository, extra.label, extra));
  }
  if (!consumers.length) {
    throw new Error(`no CEE consumers are declared in ${configPath}`);
  }
  return Object.freeze(consumers);
}

export const CEE_CONSUMERS = ceeConsumers();

const DEPENDENCY = 'cedar-embeddable-editor';
const DEV_PREFIX = 'npm:@org.metadatacenter/cedar-embeddable-editor@';

export function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d{8}\.(?:[0-9a-f]{7,40}|\d{4}\.g[0-9a-f]{12}))?$/.test(version)) {
    throw new Error(`Invalid CEE release version: ${version}`);
  }
  return version;
}

export function dependencySpec(version) {
  validateVersion(version);
  return version.includes('-dev.') ? `${DEV_PREFIX}${version}` : version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function inspectConsumer(cedarHome, consumer, version) {
  const root = resolve(cedarHome, consumer.directory);
  const manifest = readJson(resolve(root, 'package.json'));
  const lock = readJson(resolve(root, 'package-lock.json'));
  const expectedSpec = dependencySpec(version);
  const errors = [];
  const manifestSpec = manifest.dependencies?.[DEPENDENCY];
  const lockRootSpec = lock.packages?.['']?.dependencies?.[DEPENDENCY];
  const installed = lock.packages?.[`node_modules/${DEPENDENCY}`];

  if (manifestSpec !== expectedSpec) {
    errors.push(`package.json has ${manifestSpec ?? 'no dependency'}, expected ${expectedSpec}`);
  }
  if (lockRootSpec !== expectedSpec) {
    errors.push(`package-lock root has ${lockRootSpec ?? 'no dependency'}, expected ${expectedSpec}`);
  }
  if (installed?.version !== version) {
    errors.push(`package-lock installs ${installed?.version ?? 'nothing'}, expected ${version}`);
  }

  const expectedRegistry = version.includes('-dev.')
    ? 'nexus.bmir.stanford.edu/repository/npm-cedar/'
    : 'registry.npmjs.org/cedar-embeddable-editor/';
  if (!installed?.resolved?.includes(expectedRegistry)) {
    errors.push(`package-lock resolved URL is not from ${expectedRegistry}`);
  }
  return { root, errors };
}

export function checkConsumers(cedarHome, version) {
  let failed = false;
  for (const consumer of CEE_CONSUMERS) {
    const { errors } = inspectConsumer(cedarHome, consumer, version);
    if (errors.length) {
      failed = true;
      console.error(`FAIL ${consumer.label} (${consumer.directory})`);
      for (const error of errors) console.error(`  ${error}`);
    } else {
      console.log(`ok   ${consumer.label} (${consumer.directory})`);
    }
  }
  if (failed) throw new Error('CEE consumer pins are not coherent');
}

function applyConsumers(cedarHome, version) {
  const spec = dependencySpec(version);
  for (const consumer of CEE_CONSUMERS) {
    const root = resolve(cedarHome, consumer.directory);
    const args = ['install', '--save-exact', `${DEPENDENCY}@${spec}`];
    if (consumer.legacyPeerDeps) args.push('--legacy-peer-deps');
    console.log(`\nUpdating ${consumer.label} (${consumer.directory})`);
    const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm install failed for ${consumer.label} with exit ${result.status}`);
    }
  }
}

function usage() {
  console.error('Usage: propagate-cee-release.mjs (--check|--apply) <version>');
}

function main(argv) {
  const [mode, rawVersion] = argv;
  if (!['--check', '--apply'].includes(mode) || !rawVersion || argv.length !== 2) {
    usage();
    return 2;
  }
  const version = validateVersion(rawVersion);
  const cedarHome = process.env.CEDAR_HOME;
  if (!cedarHome) throw new Error('CEDAR_HOME must point to the CEDAR checkout root');
  if (mode === '--apply') applyConsumers(cedarHome, version);
  checkConsumers(cedarHome, version);
  console.log(`PASS: all ${CEE_CONSUMERS.length} CEE consumer manifests and lockfiles pin ${version}`);
  return 0;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
