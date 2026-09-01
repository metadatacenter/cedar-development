#!/usr/bin/env node
// Delete a run from its manifest, using each resource's owner and a fresh ETag. Missing resources are
// already clean; every successful deletion is verified with a GET.
import { existsSync } from 'node:fs';
import { env } from 'node:process';
import {
  absolute, arg, assertSafeTargets, currentMutation, performanceResourceDescriptor, readJson,
  request, userToken, writeJson,
} from './lib.mjs';

assertSafeTargets();

const manifestArgument = arg('manifest');
if (!manifestArgument) throw new Error('--manifest must name an existing run.json');
const manifestPath = absolute(manifestArgument);
if (!existsSync(manifestPath)) throw new Error(`manifest does not exist: ${manifestPath}`);
const password = env.CEDAR_PERF_USER_PASSWORD;
if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const manifest = readJson(manifestPath);
const tokens = new Map();
const failures = [];

async function tokenFor(actorIndex) {
  if (actorIndex === 'admin') {
    if (!env.CEDAR_ADMIN_USER_API_KEY) throw new Error('CEDAR_ADMIN_USER_API_KEY is required to clean category fixtures');
    return env.CEDAR_ADMIN_USER_API_KEY;
  }
  if (tokens.has(actorIndex)) return tokens.get(actorIndex);
  const actor = manifest.actors[actorIndex];
  if (!actor) throw new Error(`manifest has no actor ${actorIndex}`);
  const token = await userToken(actor.username, password);
  tokens.set(actorIndex, token);
  return token;
}

async function collectDescendants(token, folderId, output) {
  const listing = await request(token, 'GET', `/folders/${encodeURIComponent(folderId)}/contents?limit=500`);
  if (listing.status === 404) return;
  if (listing.status !== 200) {
    throw new Error(`list ${folderId}: ${listing.status} ${listing.text}`);
  }
  for (const entry of listing.body?.resources ?? []) {
    const resource = performanceResourceDescriptor(entry);
    if (resource.kind === 'folder') await collectDescendants(token, resource.id, output);
    output.push(resource);
  }
}

// Churn normally deletes each artifact in the same iteration that creates it. If k6 is interrupted
// between those requests, the artifact cannot have been registered in the setup manifest. Discover
// such descendants inside the unmistakably stamped run root and delete them before the known fixture
// tree. Nothing outside that root is eligible for this recovery sweep.
const knownIds = new Set(manifest.resources.map(resource => resource.id));
let recoveredResidue = 0;
for (let actorIndex = 0; actorIndex < manifest.actors.length; actorIndex++) {
  const actor = manifest.actors[actorIndex];
  if (!actor?.rootFolderId) continue;
  const token = await tokenFor(actorIndex);
  const descendants = [];
  try {
    await collectDescendants(token, actor.rootFolderId, descendants);
  } catch (error) {
    failures.push(`${actor.username}: dynamic-residue discovery: ${error.message}`);
    continue;
  }
  for (const resource of descendants.filter(candidate => !knownIds.has(candidate.id))) {
    try {
      const deletion = await currentMutation(token, 'DELETE', resource.path);
      if (![200, 204, 404].includes(deletion.status)) {
        throw new Error(`DELETE ${deletion.status} ${deletion.text}`);
      }
      const after = await request(token, 'GET', resource.path);
      if (after.status !== 404) throw new Error(`verification GET ${after.status}, expected 404`);
      recoveredResidue++;
    } catch (error) {
      failures.push(`${resource.kind} ${resource.name}: interrupted-churn cleanup: ${error.message}`);
    }
  }
}

for (const resource of [...manifest.resources].reverse()) {
  if (resource.deletedAt) continue;
  const token = await tokenFor(resource.actor);
  const base = resource.base;
  const before = await request(token, 'GET', resource.path, undefined, { base });
  if (before.status === 404) {
    resource.deletedAt = new Date().toISOString();
    writeJson(manifestPath, manifest);
    continue;
  }
  if (before.status !== 200) {
    failures.push(`${resource.kind} ${resource.name}: preflight GET ${before.status} ${before.text}`);
    continue;
  }
  let deletion;
  try {
    deletion = await currentMutation(token, 'DELETE', resource.path, undefined, { base });
  } catch (error) {
    failures.push(`${resource.kind} ${resource.name}: ${error.message}`);
    continue;
  }
  if (deletion.status !== 200 && deletion.status !== 204 && deletion.status !== 404) {
    failures.push(`${resource.kind} ${resource.name}: DELETE ${deletion.status} ${deletion.text}`);
    continue;
  }
  const after = await request(token, 'GET', resource.path, undefined, { base });
  if (after.status !== 404) {
    failures.push(`${resource.kind} ${resource.name}: verification GET returned ${after.status}, expected 404`);
    continue;
  }
  resource.deletedAt = new Date().toISOString();
  writeJson(manifestPath, manifest);
}

// The manifest should cover every POST, but audit each home as a second, independent guard. A
// forgotten registration must not ride along inside an otherwise successful teardown.
for (let actorIndex = 0; actorIndex < manifest.actors.length; actorIndex++) {
  const actor = manifest.actors[actorIndex];
  if (!actor) continue;
  const token = await tokenFor(actorIndex);
  const home = await request(token, 'GET', `/folders/${encodeURIComponent(actor.homeFolderId)}/contents?limit=500`);
  if (home.status !== 200) {
    failures.push(`${actor.username}: residue audit could not list home (${home.status} ${home.text})`);
  } else if (JSON.stringify(home.body ?? {}).includes(manifest.runId)) {
    failures.push(`${actor.username}: residue audit still finds run ${manifest.runId} in the home folder`);
  }
}

manifest.cleanedAt = failures.length ? null : new Date().toISOString();
manifest.cleanupFailures = failures;
writeJson(manifestPath, manifest);

if (failures.length) {
  console.error(`Cleanup left ${failures.length} resource(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Cleaned ${manifest.resources.length} manifest resources and ${recoveredResidue} `
      + `interrupted-churn resources from ${manifest.runId}`);
}
