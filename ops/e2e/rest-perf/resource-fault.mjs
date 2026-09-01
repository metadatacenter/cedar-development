#!/usr/bin/env node
// One opt-in, bounded local fault: stop resource-server, hold it down briefly, start it through the
// normal controller, and refuse to finish until the admin health endpoint is green again.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from 'node:process';

import { RESOURCE, intArg } from './lib.mjs';

const localHosts = new Set(['localhost', '127.0.0.1', 'resource.metadatacenter.orgx']);
const targetHost = new URL(RESOURCE).hostname;
if (!localHosts.has(targetHost)) {
  throw new Error(`resource fault injection is local-only; refusing target ${targetHost}`);
}

const cedarHome = env.CEDAR_HOME;
if (!cedarHome) throw new Error('CEDAR_HOME is required for resource fault injection');
const controller = resolve(cedarHome, 'cedar-development/ops/cedar-services.sh');
if (!existsSync(controller)) throw new Error(`CEDAR service controller not found: ${controller}`);

const startEpochMs = intArg('start-epoch-ms', 0, { min: 1 });
const downtimeSeconds = intArg('downtime-seconds', 5, { min: 1, max: 60 });
const recoveryBudgetSeconds = intArg('recovery-budget-seconds', 30, { min: 10, max: 120 });
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

let stopped = false;
let recoveryPromise;
let interrupted = false;

function controllerAction(action) {
  return spawnSync('bash', [controller, action, 'resource'], {
    cwd: cedarHome,
    env,
    stdio: 'inherit',
  }).status ?? 1;
}

async function waitForHealth(deadline) {
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9107/healthcheck');
      last = `HTTP ${response.status}`;
      if (response.status === 200) return;
    } catch (error) {
      last = error.message;
    }
    await delay(1000);
  }
  throw new Error(`resource-server did not recover before its deadline (${last})`);
}

async function recover() {
  if (!recoveryPromise) {
    recoveryPromise = (async () => {
      if (controllerAction('start') !== 0) throw new Error('could not restart resource-server');
      await waitForHealth(Date.now() + recoveryBudgetSeconds * 1000);
      stopped = false;
      console.log('Resource fault: resource-server is healthy again');
    })();
  }
  return recoveryPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    if (!stopped && !recoveryPromise) process.exit(130);
    console.error(`${signal}; restoring resource-server before the fault helper exits`);
    void recover().then(() => process.exit(130), error => {
      console.error(error.stack ?? error.message);
      process.exit(1);
    });
  });
}

try {
  const waitMs = startEpochMs - Date.now();
  if (waitMs > 0) await delay(waitMs);
  if (interrupted) await new Promise(() => {});
  console.log(`Resource fault: stopping resource-server for ${downtimeSeconds}s`);
  // Assume the stop may have taken effect even if the controller reports a late bookkeeping error;
  // finally must always attempt recovery after the stop command has begun.
  stopped = true;
  if (controllerAction('stop') !== 0) throw new Error('could not stop resource-server');
  await delay(downtimeSeconds * 1000);
  await recover();
} finally {
  if (stopped) await recover();
}
