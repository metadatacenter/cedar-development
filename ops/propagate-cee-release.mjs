#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CEE_CONSUMERS = Object.freeze([
  { label: 'Workspace', directory: 'cedar-workspace', legacyPeerDeps: false },
  { label: 'Production monolith', directory: 'cedar-template-editor', legacyPeerDeps: false },
  { label: 'Bridging', directory: 'cedar-bridging/cedar-bridging-src', legacyPeerDeps: false },
  { label: 'OpenView', directory: 'cedar-openview/cedar-openview-src', legacyPeerDeps: true },
  { label: 'Angular demo', directory: 'cedar-component-demo/cedar-cee-demo-angular-src', legacyPeerDeps: true },
  { label: 'Ember demo', directory: 'cedar-component-demo/cedar-cee-demo-ember-src', legacyPeerDeps: false },
  { label: 'React demo', directory: 'cedar-component-demo/cedar-cee-demo-react', legacyPeerDeps: false },
]);

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
