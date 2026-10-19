import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquire, describeHolder, holderOf, lockPath, release } from "./split-lock.mjs";
import { record } from "./split-steps.mjs";

const held = new AsyncLocalStorage();
const journey = new AsyncLocalStorage();
const defaultPath = join(dirname(lockPath(dirname(fileURLToPath(import.meta.url)))), "authentication.lock");

/** Explicit authentication only: ordinary editing and background token refresh remain parallel.
 * Hold from the initiating navigation/click through authenticated page readiness, since signing in
 * also initializes the user's backend state. REST password grants use the same machine-wide lock.
 * A killed process leaves a recoverable PID lock; a live holder causes a bounded, diagnostic wait.
 */
export async function withAuthentication(activity, action, { path = defaultPath, timeoutMs = 60000, retryMs = 100 } = {}) {
  const parent = held.getStore();
  if (parent?.active && parent.path === path) return action();
  const holder = { ...holderOf(), activity };
  const began = Date.now();
  for (;;) {
    const result = acquire(path, holder);
    if (result.acquired) break;
    if (Date.now() - began >= timeoutMs)
      throw new Error(`Authentication wait timed out for ${activity}: ${describeHolder(result.holder)}`);
    await delay(Math.min(retryMs, Math.max(1, timeoutMs - (Date.now() - began))));
  }
  const scope = { path, active: true };
  let outcome = "fail";
  try {
    record({ event: "authentication-start", activity, waitedMs: Date.now() - began });
    const value = await held.run(scope, action);
    outcome = "pass";
    return value;
  } finally {
    scope.active = false;
    try { record({ event: "authentication-end", activity, outcome, elapsedMs: Date.now() - began }); }
    finally { release(path, holder); }
  }
}

/** Enforce the registry classification at execution time, including calls through shared helpers. */
export const withJourneyAuthentication = (entry, action) => journey.run(entry, action);

export function withBrowserAuthentication(activity, action) {
  const entry = journey.getStore();
  if (entry && !entry.authentication)
    throw new Error(`Journey ${entry.key} authenticates (${activity}) but has no authentication reason in journey-registry.mjs`);
  return withAuthentication(activity, action);
}
