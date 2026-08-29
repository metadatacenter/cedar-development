#!/usr/bin/env node
// Find only unmistakably named REST performance roots across the dedicated user pool. Report by
// default; --apply removes runs older than the requested age in dependency order.
import { env } from 'node:process';
import {
  PERF_PREFIX, absolute, arg, assertSafeTargets, currentMutation, enc, intArg, readJson, request,
  runTimestampFromRootName, userToken,
} from './lib.mjs';

assertSafeTargets();

const usersPath = absolute(arg('users-file', 'reports/rest-perf/users.json'));
const minimumAgeHours = intArg('min-age-hours', 24, { min: 0, max: 8760 });
const apply = process.argv.includes('--apply');
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const inventory = readJson(usersPath);
const failures = [];
let candidates = 0;
let removed = 0;

function nameOf(resource) {
  return resource?.['schema:name'] ?? resource?.schema_name ?? '';
}

async function collect(token, folderId, output) {
  const listing = await request(token, 'GET', `/folders/${enc(folderId)}/contents?limit=500`);
  if (listing.status !== 200) throw new Error(`list ${folderId}: ${listing.status} ${listing.text}`);
  for (const resource of listing.body?.resources ?? []) {
    const id = resource['@id'];
    if (resource.resourceType === 'folder') {
      await collect(token, id, output);
      output.push({ kind: 'folder', id, path: `/folders/${enc(id)}`, name: nameOf(resource) });
    } else if (resource.resourceType === 'template') {
      output.push({ kind: 'template', id, path: `/templates/${enc(id)}`, name: nameOf(resource) });
    } else {
      throw new Error(`refusing unexpected ${resource.resourceType} ${id} inside performance root`);
    }
  }
}

for (const user of inventory.users ?? []) {
  const token = await userToken(user.username, password);
  const home = await request(token, 'GET', `/folders/${enc(user.homeFolderId)}/contents?limit=500`);
  if (home.status !== 200) {
    failures.push(`${user.username}: home listing ${home.status} ${home.text}`);
    continue;
  }
  for (const root of home.body?.resources ?? []) {
    if (root.resourceType !== 'folder') continue;
    const created = runTimestampFromRootName(nameOf(root));
    if (created === null) continue;
    const ageHours = (Date.now() - created) / 3_600_000;
    if (ageHours < minimumAgeHours) continue;
    candidates++;
    console.log(`${apply ? 'removing' : 'found'} ${user.username}: ${nameOf(root)} (${ageHours.toFixed(1)} h)`);
    if (!apply) continue;
    try {
      const resources = [];
      await collect(token, root['@id'], resources);
      resources.push({ kind: 'folder', id: root['@id'], path: `/folders/${enc(root['@id'])}`, name: nameOf(root) });
      for (const resource of resources) {
        const deletion = await currentMutation(token, 'DELETE', resource.path);
        if (![200, 204, 404].includes(deletion.status)) {
          throw new Error(`${resource.kind} ${resource.name}: DELETE ${deletion.status} ${deletion.text}`);
        }
        const after = await request(token, 'GET', resource.path);
        if (after.status !== 404) {
          throw new Error(`${resource.kind} ${resource.name}: verification GET ${after.status}, expected 404`);
        }
      }
      removed++;
    } catch (error) {
      failures.push(`${user.username}: ${nameOf(root)}: ${error.message}`);
    }
  }
}

console.log(`${candidates} abandoned run(s) matched; ${removed} removed`);
if (!apply && candidates) console.log('Report only; add --apply to delete these exact prefixed runs');
if (failures.length) {
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}
