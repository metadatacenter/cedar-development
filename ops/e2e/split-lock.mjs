// One split tier at a time on a machine. Two runs against the same stack see each other's fixtures in
// every listing that spans folders, contend for the same sign-ins, and before this lock existed wrote
// their evidence to the same files.
//
// The lock is a file that holds the running tier's PID, start time, command and working directory.
// It is created atomically: the holder is written to a file of its own and then linked to the lock's
// name, which fails when the name exists, so no run ever reads a half-written lock. A second run that
// finds the lock refuses at once and names its holder. A holder that is no longer running, or whose
// PID now belongs to a process that started after the lock was written, left the lock behind when it
// was killed, and the new run replaces it and says so.
//
// The lock lives in $CEDAR_HOME/.cedar/locks/, the directory of state shared by every session on the
// machine, whichever checkout of cedar-development it runs from. The e2e reports directory belongs to
// one checkout, so a run from a worktree or another clone would never see a lock kept there.
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * $CEDAR_HOME when it is set, else the directory that holds this checkout of cedar-development, found
 * by walking up from the e2e directory, else null.
 */
export function cedarHome(here, environment = process.env) {
  if (environment.CEDAR_HOME) return resolve(environment.CEDAR_HOME);
  for (let directory = resolve(here); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "cedar-development", "ops", "e2e"))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

/** The lock's path. Without a CEDAR home, the e2e reports directory is the only shared place left. */
export function lockPath(here, environment = process.env) {
  const home = cedarHome(here, environment);
  return home ? join(home, ".cedar", "locks", "split-tier.lock") : join(here, "reports", "split-tier.lock");
}

/** The holder this process writes into the lock. */
export function holderOf(command = process.argv, now = new Date()) {
  return {
    pid: process.pid,
    startedAt: now.toISOString(),
    command: command.join(" "),
    cwd: process.cwd(),
    host: hostname(),
  };
}

/**
 * Whether a holder is still running: its PID answers, and the process with that PID did not start
 * after the lock was written. The start time comes from ps, to the second.
 */
export function running(holder) {
  if (!Number.isInteger(holder?.pid) || holder.pid <= 0) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  const started = spawnSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).stdout?.trim();
  const processStart = Date.parse(started ?? ""), lockStart = Date.parse(holder.startedAt ?? "");
  return !(Number.isFinite(processStart) && Number.isFinite(lockStart) && processStart > lockStart + 2000);
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return error.code === "ENOENT" ? undefined : null;
  }
}

const same = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

/**
 * Takes the lock for `holder`. Returns `{acquired: true, holder, replaced}`, where `replaced` is the
 * stale holder whose lock this one replaced or null, or `{acquired: false, holder}` naming the run that
 * holds it. `isRunning` decides whether a holder is alive.
 */
export function acquire(path, holder, { isRunning = running } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const mine = `${path}.${holder.pid}.${Date.now()}`;
  writeFileSync(mine, JSON.stringify(holder, null, 2) + "\n");
  let replaced = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(mine, path);
        return { acquired: true, holder, replaced };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const current = read(path);
      if (current === undefined) continue;
      if (current !== null && isRunning(current)) return { acquired: false, holder: current };
      // The stale lock is moved aside first, and removed only if it is still the one judged stale.
      // Another run may have replaced it in the meantime, and that run's lock is put back.
      const aside = `${path}.stale.${holder.pid}`;
      try {
        renameSync(path, aside);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const moved = read(aside);
      if (current !== null && !same(moved, current)) {
        try {
          linkSync(aside, path);
        } catch {}
        unlinkSync(aside);
        return { acquired: false, holder: moved };
      }
      unlinkSync(aside);
      replaced = current ?? { unreadable: true };
    }
    throw new Error(`could not take ${path} after five attempts`);
  } finally {
    try {
      unlinkSync(mine);
    } catch {}
  }
}

/** Removes the lock if `holder` still holds it, and says whether it did. */
export function release(path, holder) {
  if (!same(read(path), holder)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** How a refusal names the holder. */
export function describeHolder(holder, now = Date.now()) {
  if (!holder) return "an unreadable lock";
  const age = Math.round((now - Date.parse(holder.startedAt)) / 1000);
  return `PID ${holder.pid}, started ${holder.startedAt}` +
    (Number.isFinite(age) ? ` (${age} s ago)` : "") +
    (holder.host ? ` on ${holder.host}` : "") +
    `, command: ${holder.command}`;
}
