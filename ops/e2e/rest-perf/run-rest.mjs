#!/usr/bin/env node
// Ensure users → prepare → k6 → cleanup. k6 is checked before provisioning or setup so a missing
// executable cannot mutate the local installation or strand data.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { absolute, arg, assertSafeTargets, intArg, runId } from './lib.mjs';

assertSafeTargets();

const HERE = dirname(fileURLToPath(import.meta.url));
const profile = arg('profile', 'quick');
const defaultUsers = { quick: 10, contention: 20, hotset: 20, soak: 50 };
if (!defaultUsers[profile]) throw new Error(`--profile must be quick, contention, hotset or soak; got ${profile}`);
const users = intArg('users', defaultUsers[profile], { max: 500 });
const rounds = intArg('rounds', 3, { max: 20 });
const poolSize = intArg('pool-size', 50, { min: 50, max: 500 });
const ensuredUsers = Math.max(users, poolSize);
const id = arg('run-id', runId());
const seed = arg('seed', id);
const runDirectory = absolute(arg('run-directory', `reports/rest-perf/runs/${id}`));
const manifest = resolve(runDirectory, 'run.json');
const summary = resolve(runDirectory, 'k6-summary.json');
const usersFile = absolute(arg('users-file', 'reports/rest-perf/users.json'));
const duration = arg('duration');
const vus = Number(arg('vus', String(users)));
if (!Number.isInteger(vus) || vus < 1 || vus > users) {
  throw new Error(`--vus must be an integer from 1 to the selected user count (${users}); got ${vus}`);
}

if (!env.CEDAR_PERF_USER_PASSWORD) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
const k6 = spawnSync('k6', ['version'], { encoding: 'utf8' });
if (k6.error?.code === 'ENOENT') {
  throw new Error('k6 is not installed; install it before running REST performance tests (brew install k6)');
}
if (k6.status !== 0) throw new Error(`k6 preflight failed: ${k6.stderr || k6.stdout}`);

mkdirSync(runDirectory, { recursive: true });

let activeChild;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) {
      console.error(`${signal} again; exiting without further cleanup`);
      process.exit(130);
    }
    interrupted = true;
    console.error(`${signal}; stopping the active phase, then cleaning up`);
    activeChild?.kill(signal);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    activeChild = child;
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      resolveChild({ code: code ?? 1, signal });
    });
  });
}

let testExit = 1;
let setupStarted = false;
try {
  const provisioned = await run(process.execPath, [
    resolve(HERE, 'provision-users.mjs'),
    `--count=${ensuredUsers}`,
    `--output=${usersFile}`,
  ], { env });
  if (provisioned.code !== 0) throw new Error(`performance-user provisioning failed with exit ${provisioned.code}`);

  setupStarted = true;
  const prepared = await run(process.execPath, [
    resolve(HERE, 'prepare-run.mjs'),
    `--users-file=${usersFile}`,
    `--users=${users}`,
    `--profile=${profile}`,
    `--rounds=${rounds}`,
    `--run-id=${id}`,
    `--seed=${seed}`,
    `--manifest=${manifest}`,
  ], { env });
  if (prepared.code !== 0) throw new Error(`fixture preparation failed with exit ${prepared.code}`);

  const loadEnvironment = {
    ...env,
    CEDAR_PERF_PROFILE: profile,
    CEDAR_PERF_MANIFEST: manifest,
    CEDAR_PERF_SUMMARY: summary,
    ...(duration ? { CEDAR_PERF_DURATION: duration } : {}),
    CEDAR_PERF_VUS: String(vus),
    CEDAR_PERF_ROUNDS: String(rounds),
    CEDAR_PERF_SEED: seed,
  };
  const loaded = await run('k6', ['run', resolve(HERE, 'cedar-rest.k6.js')], { env: loadEnvironment });
  testExit = loaded.code;
} catch (error) {
  console.error(error.stack ?? error.message);
  testExit = 1;
} finally {
  if (setupStarted && existsSync(manifest)) {
    const cleaned = await run(process.execPath, [resolve(HERE, 'cleanup-run.mjs'), `--manifest=${manifest}`], { env });
    if (cleaned.code !== 0) testExit = 1;
  }
}

console.log(`Run artifacts: ${runDirectory}`);
process.exitCode = interrupted ? 130 : testExit;
