#!/usr/bin/env node

import fs from 'node:fs';

const [source, destination, packageName, packageVersion] = process.argv.slice(2);
if (!source || !destination || !packageName || !packageVersion) {
  throw new Error('usage: stage-npm-shrinkwrap.mjs SOURCE DESTINATION PACKAGE_NAME PACKAGE_VERSION');
}
if (!fs.existsSync(source)) {
  throw new Error(`frontend package has no source lockfile: ${source}`);
}

const lock = JSON.parse(fs.readFileSync(source, 'utf8'));
if (!Number.isInteger(lock.lockfileVersion) || !lock.packages || !lock.packages['']) {
  throw new Error(`frontend lockfile has no npm package graph: ${source}`);
}

lock.name = packageName;
lock.version = packageVersion;
lock.packages[''].name = packageName;
lock.packages[''].version = packageVersion;
fs.writeFileSync(destination, `${JSON.stringify(lock, null, 2)}\n`);
