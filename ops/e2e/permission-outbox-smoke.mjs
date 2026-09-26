// Destructive local degradation test for the search-permission producer outbox.
//
// It stops the Homebrew Redis service, grants access to a throwaway template while Redis is down,
// restarts Redis, and proves the grant subsequently reaches term search. Redis is restarted and all
// fixtures are removed in finally, including when an assertion fails.
//
// Run only against the native local stack:
//   npm run smoke:permission-outbox -- --manage-homebrew-redis
// Use --convergence-only instead to measure freshness during a soak without interrupting Redis.
import { spawnSync } from 'node:child_process';
import {
  actors, artifactBody, call, enc, mutate, poll, RUN,
} from './rest/lib.mjs';

const convergenceOnly = process.argv.includes('--convergence-only');
if (!convergenceOnly && !process.argv.includes('--manage-homebrew-redis')) {
  console.error('refusing to stop Redis without --manage-homebrew-redis');
  process.exit(2);
}

const serviceName = process.env.CEDAR_HOMEBREW_REDIS_SERVICE ?? 'redis';
const stamp = RUN.replace(/[^0-9]/g, '');
let redisStopped = false;
let auth;
let ownerId;
let folderId;
let templateId;
let privateFolderId;
let failures = 0;

function assert(condition, what, detail = '') {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    failures++;
    console.error(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`);
  }
  return condition;
}

function brew(action) {
  const result = spawnSync('brew', ['services', action, serviceName], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`brew services ${action} ${serviceName} failed: ${result.stderr || result.stdout}`);
  }
}

function redisIsUp() {
  const result = spawnSync('redis-cli', ['-p', '6379', 'ping'], { encoding: 'utf8', timeout: 1500 });
  return result.status === 0 && result.stdout.trim() === 'PONG';
}

async function waitForRedis(up) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (redisIsUp() === up) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function finds(authToken, term, id) {
  const response = await call(authToken, 'GET', `/search?q=${enc(term)}&limit=50`);
  if (response.status !== 200) throw new Error(`Search returned ${response.status}: ${response.text}`);
  return (response.body?.resources ?? []).some(resource => resource['@id'] === id);
}

async function searchConverges(authToken, term, expected, what) {
  const start = performance.now();
  let matches = false;
  do {
    matches = (await finds(authToken, term, templateId)) === expected;
    if (matches) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() - start < 5000);
  const elapsed = performance.now() - start;
  assert(matches && elapsed <= 5000, `${what} reaches search within five seconds`,
      `elapsed ${Math.round(elapsed)} ms`);
  console.log(`    search convergence: ${Math.round(elapsed)} ms`);
  if (!matches || elapsed > 5000) throw new Error(`${what} did not converge; later transitions are not meaningful`);
}

try {
  const { user1, user2 } = await actors();
  auth = user1.auth;
  ownerId = user1.profile['@id'];
  const granteeId = user2.profile['@id'];
  const folderName = `Permission Outbox ${RUN}`;
  const term = `PermissionOutbox${stamp}`;

  const folder = await call(auth, 'POST', '/folders', {
    folderId: user1.profile.homeFolderId,
    name: folderName,
    description: 'Throwaway fixture for the permission outbox degradation test',
  });
  if (!assert(folder.status === 201, 'the throwaway folder is created', `${folder.status}: ${folder.text}`)) {
    throw new Error('fixture setup failed');
  }
  folderId = folder.body['@id'];

  const template = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
      artifactBody('template', `${term} template`));
  if (!assert(template.status === 201, 'the throwaway template is created',
      `${template.status}: ${template.text}`)) throw new Error('fixture setup failed');
  templateId = template.body['@id'];

  const indexed = await poll(async () => ({ done: await finds(auth, term, templateId) }),
      { tries: 15, delayMs: 1000 });
  assert(indexed.done, 'the owner sees the template in search before permission changes');
  assert(!(await finds(user2.auth, term, templateId)), 'the grantee cannot find it before the grant');

  if (!convergenceOnly) {
    console.log(`\n  stopping Homebrew ${serviceName}`);
    brew('stop');
    redisStopped = true;
    if (!await waitForRedis(false)) throw new Error('Redis did not stop within 15 seconds');
    assert(!redisIsUp(), 'Redis is unavailable to the permission producer');
  }

  const grant = await mutate(auth, 'PUT', `/templates/${enc(templateId)}/permissions`, {
    owner: { '@id': ownerId },
    userPermissions: [{ user: { '@id': granteeId }, role: 'viewer' }],
    groupPermissions: [],
  });
  assert(grant.status === 200, convergenceOnly ? 'the graph mutation succeeds' : 'the graph mutation succeeds while Redis is down',
      `${grant.status}: ${grant.text}`);
  assert((await call(user2.auth, 'GET', `/templates/${enc(templateId)}`)).status === 200,
      'the graph-backed grant is effective immediately');
  if (!convergenceOnly) {
    assert(!(await finds(user2.auth, term, templateId)),
        'the index remains unchanged while Redis is unavailable');

    console.log(`\n  restarting Homebrew ${serviceName}`);
    brew('start');
    if (!await waitForRedis(true)) throw new Error('Redis did not restart within 15 seconds');
    redisStopped = false;
    assert(redisIsUp(), 'Redis is available again');

    const projected = await poll(async () => ({ done: await finds(user2.auth, term, templateId) }),
        { tries: 20, delayMs: 1000 });
    assert(projected.done, 'the durable outbox relays the grant into search after Redis recovers',
        `not visible after ${projected.attempts} attempts`);
  } else {
    await searchConverges(user2.auth, term, true, 'direct ACL grant');
  }

  const revoke = await mutate(auth, 'PUT', `/templates/${enc(templateId)}/permissions`, {
    owner: { '@id': ownerId }, userPermissions: [], groupPermissions: [],
  });
  assert(revoke.status === 200, 'the direct grant is revoked', `${revoke.status}: ${revoke.text}`);
  await searchConverges(user2.auth, term, false, 'ACL revocation');

  const shareFolder = await mutate(auth, 'PUT', `/folders/${enc(folderId)}/permissions`, {
    owner: { '@id': ownerId },
    userPermissions: [{ user: { '@id': granteeId }, role: 'viewer' }], groupPermissions: [],
  });
  assert(shareFolder.status === 200, 'the parent folder is shared', `${shareFolder.status}: ${shareFolder.text}`);
  await searchConverges(user2.auth, term, true, 'inherited folder ACL grant');

  const privateFolder = await call(auth, 'POST', '/folders', {
    folderId: user1.profile.homeFolderId,
    name: `Permission Outbox Private ${RUN}`, description: 'Private destination for relay convergence',
  });
  if (!assert(privateFolder.status === 201, 'the private destination is created')) {
    throw new Error('private folder setup failed');
  }
  privateFolderId = privateFolder.body['@id'];
  const move = await mutate(auth, 'POST', '/command/move-resource-to-folder', {
    '@id': templateId, targetFolderId: privateFolderId,
  }, { etagPath: `/templates/${enc(templateId)}/details` });
  assert([200, 201, 204].includes(move.status), 'the template moves out of the shared folder',
      `${move.status}: ${move.text}`);
  await searchConverges(user2.auth, term, false, 'move removing inherited access');

} catch (error) {
  failures++;
  console.error(`  ✗ degradation test aborted\n      ${error.stack ?? error.message}`);
} finally {
  if (redisStopped || (!convergenceOnly && !redisIsUp())) {
    console.log(`\n  restoring Homebrew ${serviceName}`);
    try {
      brew('start');
      await waitForRedis(true);
    } catch (error) {
      failures++;
      console.error(`  ✗ Redis restoration failed\n      ${error.message}`);
    }
  }
  if (auth && templateId) {
    await mutate(auth, 'DELETE', `/templates/${enc(templateId)}`);
  }
  if (auth && privateFolderId) {
    await mutate(auth, 'DELETE', `/folders/${enc(privateFolderId)}`);
  }
  if (auth && folderId) {
    await mutate(auth, 'DELETE', `/folders/${enc(folderId)}`);
  }
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}: permission ${convergenceOnly ? 'convergence' : 'outbox degradation'} (${failures} failure(s))`);
process.exit(failures ? 1 : 0);
