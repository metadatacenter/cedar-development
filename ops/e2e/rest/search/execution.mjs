import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Fixture intents and identities always force a durable snapshot. Successful read checks may
// coalesce snapshots; a crash still leaves RUNNING evidence, which can never satisfy the gate.
export function checkpointWriter(report, path, { now = () => performance.now(), intervalMs = 500,
  write = (path, payload) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', payload, { mode: 0o600 });
    renameSync(path + '.tmp', path);
  } } = {}) {
  const stats = report.performance.checkpoints = { writes: 0, elapsedMs: 0 };
  let last = -Infinity;
  return (force = true) => {
    const started = now();
    if (!force && started - last < intervalMs) return;
    stats.writes++;
    write(path, JSON.stringify(report, null, 2) + '\n');
    stats.elapsedMs += now() - started;
    last = now();
  };
}

export async function timedPhase(report, name, action) {
  const start = performance.now();
  try { return await action(); }
  finally { report.performance.phases[name] = Math.round(performance.now() - start); }
}
