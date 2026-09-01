#!/usr/bin/env node
// Recover abandoned runs from their manifests, then find any legacy unmistakably named roots across
// the dedicated user pool. Report by default; --apply removes old runs in dependency order.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { env } from 'node:process';
import {
  PERF_PREFIX, absolute, arg, assertSafeTargets, currentMutation, enc, intArg, readJson, request,
  runTimestampFromRootName, userToken,
} from './lib.mjs';

assertSafeTargets();

const usersPath = absolute(arg('users-file', 'reports/rest-perf/users.json'));
const runsDirectory = absolute(arg('runs-directory', 'reports/rest-perf/runs'));
const HERE = dirname(fileURLToPath(import.meta.url));
const minimumAgeHours = intArg('min-age-hours', 24, { min: 0, max: 8760 });
const apply = process.argv.includes('--apply');
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const inventory = readJson(usersPath);
const failures = [];
let candidates = 0;
let removed = 0;
const manifestRuns = new Set();

// A manifest is the stronger cleanup source: unlike a home-folder walk, it also knows about groups
// and the administrator-owned categories that do not live in any participant's folder tree.
if (existsSync(runsDirectory)) {
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(runsDirectory, entry.name, 'run.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = readJson(manifestPath); } catch { continue; }
    if (!manifest?.runId || manifest.cleanedAt) continue;
    const created = Date.parse(manifest.createdAt);
    if (Number.isNaN(created)) continue;
    const ageHours = (Date.now() - created) / 3_600_000;
    if (ageHours < minimumAgeHours) continue;
    manifestRuns.add(manifest.runId);
    candidates++;
    console.log(`${apply ? 'removing' : 'found'} manifest ${manifest.runId} (${ageHours.toFixed(1)} h)`);
    if (!apply) continue;
    const cleanup = spawnSync(process.execPath, [resolve(HERE, 'cleanup-run.mjs'),
      `--manifest=${manifestPath}`], { stdio: 'inherit', env });
    if (cleanup.status === 0) removed++;
    else {
      manifestRuns.delete(manifest.runId);
      failures.push(`${manifest.runId}: manifest cleanup exited ${cleanup.status ?? 'without a status'}`);
    }
  }
}

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
    } else if (resource.resourceType === 'element') {
      output.push({ kind: 'element', id, path: `/template-elements/${enc(id)}`, name: nameOf(resource) });
    } else if (resource.resourceType === 'field') {
      output.push({ kind: 'field', id, path: `/template-fields/${enc(id)}`, name: nameOf(resource) });
    } else if (resource.resourceType === 'instance') {
      output.push({ kind: 'instance', id, path: `/template-instances/${enc(id)}`, name: nameOf(resource) });
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
    if ([...manifestRuns].some(id => nameOf(root).includes(id))) continue;
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
