#!/usr/bin/env node
// Ensure users → prepare → k6 → cleanup. k6 is checked before provisioning or setup so a missing
// executable cannot mutate the local installation or strand data.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import {
  absolute, arg, assertSafeTargets, burstRecoveryAssessment, durationSeconds, intArg, readJson, runId,
} from './lib.mjs';

assertSafeTargets();

const HERE = dirname(fileURLToPath(import.meta.url));
const profile = arg('profile', 'quick');
const defaultUsers = {
  quick: 10, contention: 20, hotset: 20, resilience: 10, churn: 10, burst: 50, soak: 50,
};
if (!defaultUsers[profile]) {
  throw new Error(`--profile must be quick, contention, hotset, resilience, churn, burst or soak; got ${profile}`);
}
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
const allowServiceRestart = arg('allow-service-restart', 'false') === 'true';
const faultDelaySeconds = intArg('fault-delay', 15, { min: 5, max: 120 });
const faultDowntimeSeconds = intArg('fault-downtime', 5, { min: 1, max: 60 });
const recoveryBudgetSeconds = intArg('recovery-budget', 30, { min: 10, max: 120 });
const churnRate = intArg('churn-rate', 2, { max: 20 });
const burstBaselineRate = intArg('baseline-rate', 5, { max: 100 });
const burstPeakRate = intArg('burst-rate', 40, { max: 500 });
const burstPhaseDuration = arg('phase-duration', '30s');
const burstRecoveryPercent = intArg('recovery-p95-percent', 150, { min: 100, max: 300 });
const slowRequestMs = intArg('slow-request-ms', 500, { min: 100, max: 60000 });
const slowRequestLogLimit = intArg('slow-request-log-limit', 3, { min: 0, max: 20 });
const vus = Number(arg('vus', String(users)));
if (!Number.isInteger(vus) || vus < 1 || vus > users) {
  throw new Error(`--vus must be an integer from 1 to the selected user count (${users}); got ${vus}`);
}

if (!env.CEDAR_PERF_USER_PASSWORD) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
if (profile === 'resilience' && !allowServiceRestart) {
  throw new Error('the resilience profile requires --allow-service-restart=true');
}
if (profile === 'resilience' && faultDowntimeSeconds >= recoveryBudgetSeconds) {
  throw new Error('--fault-downtime must be shorter than --recovery-budget');
}
if (profile === 'resilience') {
  const configuredSeconds = durationSeconds(duration || '90s') || 0;
  const minimum = faultDelaySeconds + recoveryBudgetSeconds + 10;
  if (configuredSeconds < minimum) {
    throw new Error(`resilience duration must be at least ${minimum}s for outage and post-recovery traffic`);
  }
}
if (profile === 'burst') {
  if (!durationSeconds(burstPhaseDuration)) {
    throw new Error(`--phase-duration must be a positive XmYs duration; got ${burstPhaseDuration}`);
  }
  if (burstPeakRate <= burstBaselineRate) {
    throw new Error('--burst-rate must be greater than --baseline-rate');
  }
}
const k6 = spawnSync('k6', ['version'], { encoding: 'utf8' });
if (k6.error?.code === 'ENOENT') {
  throw new Error('k6 is not installed; install it before running REST performance tests (brew install k6)');
}
if (k6.status !== 0) throw new Error(`k6 preflight failed: ${k6.stderr || k6.stdout}`);

mkdirSync(runDirectory, { recursive: true });

let activeChild;
let auxiliaryChild;
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
    auxiliaryChild?.kill(signal);
  });
}

function runAuxiliary(command, args, options = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    auxiliaryChild = child;
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => {
      if (auxiliaryChild === child) auxiliaryChild = undefined;
      resolveChild({ code: code ?? 1, signal });
    });
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
let faultResultPromise;
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
    CEDAR_PERF_CHURN_RATE: String(churnRate),
    CEDAR_PERF_BURST_BASELINE_RATE: String(burstBaselineRate),
    CEDAR_PERF_BURST_PEAK_RATE: String(burstPeakRate),
    CEDAR_PERF_BURST_PHASE_DURATION: burstPhaseDuration,
    CEDAR_PERF_BURST_PHASE_SECONDS: String(durationSeconds(burstPhaseDuration)),
    CEDAR_PERF_SLOW_REQUEST_MS: String(slowRequestMs),
    CEDAR_PERF_SLOW_REQUEST_LOG_LIMIT: String(slowRequestLogLimit),
  };
  if (profile === 'resilience') {
    const faultStartEpochMs = Date.now() + faultDelaySeconds * 1000;
    loadEnvironment.CEDAR_PERF_FAULT_START_EPOCH_MS = String(faultStartEpochMs);
    loadEnvironment.CEDAR_PERF_RECOVERY_BUDGET_MS = String(recoveryBudgetSeconds * 1000);
    faultResultPromise = runAuxiliary(process.execPath, [
      resolve(HERE, 'resource-fault.mjs'),
      `--start-epoch-ms=${faultStartEpochMs}`,
      `--downtime-seconds=${faultDowntimeSeconds}`,
      `--recovery-budget-seconds=${recoveryBudgetSeconds}`,
    ], { env });
  }
  const loaded = await run('k6', ['run', resolve(HERE, 'cedar-rest.k6.js')], { env: loadEnvironment });
  const pendingFault = faultResultPromise;
  faultResultPromise = undefined;
  const faulted = pendingFault ? await pendingFault : { code: 0 };
  testExit = loaded.code || faulted.code ? 1 : 0;
  if (profile === 'burst' && existsSync(summary)) {
    const assessment = burstRecoveryAssessment(readJson(summary), burstRecoveryPercent);
    const baseline = Number.isFinite(assessment.baseline) ? `${assessment.baseline.toFixed(1)} ms` : 'missing';
    const recovery = Number.isFinite(assessment.recovery) ? `${assessment.recovery.toFixed(1)} ms` : 'missing';
    const limit = Number.isFinite(assessment.limit) ? `${assessment.limit.toFixed(1)} ms` : 'missing';
    console.log(`Burst recovery comparison: baseline ${baseline}, recovery ${recovery}, limit ${limit}`);
    if (!assessment.pass) {
      console.error(`Burst recovery failed: ${assessment.reason}`);
      testExit = 1;
    }
  }
} catch (error) {
  console.error(error.stack ?? error.message);
  testExit = 1;
} finally {
  if (faultResultPromise) {
    try {
      const faulted = await faultResultPromise;
      if (faulted.code !== 0) testExit = 1;
    } catch (error) {
      console.error(error.stack ?? error.message);
      testExit = 1;
    }
  }
  if (setupStarted && existsSync(manifest)) {
    const cleaned = await run(process.execPath, [resolve(HERE, 'cleanup-run.mjs'), `--manifest=${manifest}`], { env });
    if (cleaned.code !== 0) testExit = 1;
  }
}

console.log(`Run artifacts: ${runDirectory}`);
process.exitCode = interrupted ? 130 : testExit;
