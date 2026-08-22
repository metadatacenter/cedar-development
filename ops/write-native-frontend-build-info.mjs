#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  workspace: { application: 'cedar-workspace', directory: 'cedar-workspace' },
  designer: { application: 'cedar-template-designer', directory: 'cedar-template-designer' },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, files);
    else if (entry.isFile() || lstatSync(path).isSymbolicLink()) files.push(path);
  }
  return files;
}

export function servedTreeSha256(repoRoot) {
  const appRoot = resolve(repoRoot, 'app');
  const excluded = resolve(appRoot, 'config/build-info.json');
  const paths = collectFiles(appRoot)
    .filter(path => path !== excluded)
    .map(path => ({
      absolute: path,
      relative: relative(repoRoot, path).split(sep).join('/'),
    }))
    .sort((left, right) => Buffer.from(left.relative).compare(Buffer.from(right.relative)));

  const manifest = paths.map(({ absolute, relative: relativePath }) =>
    `${sha256(readFileSync(absolute))}  ${relativePath}\n`).join('');
  return sha256(manifest);
}

export function writeBuildInfo({ cedarHome, target, sourceCommit, sourceDirty, environment }) {
  const definition = TARGETS[target];
  if (!definition) throw new Error(`Unknown split frontend target: ${target}`);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Source commit must be a full Git SHA');
  if (!['true', 'false'].includes(sourceDirty)) throw new Error('Source dirty must be true or false');

  const repoRoot = resolve(cedarHome, definition.directory);
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const info = {
    application: definition.application,
    version: manifest.version,
    versionModifier: environment.CEDAR_VERSION_MODIFIER || '',
    sourceCommit,
    sourceDirty: sourceDirty === 'true',
    bundleSha256: servedTreeSha256(repoRoot),
  };
  writeFileSync(resolve(repoRoot, 'app/config/build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function main(argv) {
  const [target, sourceCommit, sourceDirty] = argv;
  if (argv.length !== 3) {
    throw new Error('Usage: write-native-frontend-build-info.mjs <workspace|designer> <source-commit> <true|false>');
  }
  const cedarHome = process.env.CEDAR_HOME;
  if (!cedarHome) throw new Error('CEDAR_HOME must point to the CEDAR checkout root');
  const info = writeBuildInfo({
    cedarHome,
    target,
    sourceCommit,
    sourceDirty,
    environment: process.env,
  });
  console.log(`${info.application} ${info.sourceCommit} ${info.bundleSha256}`);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
