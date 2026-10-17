import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOURNEYS } from "./journey-registry.mjs";

// The split tier's plan says what runs, where it may run and how long it may take. split-tier.mjs
// carries it out. A unit is one journey or one script.
//
// A sequential plan runs the full modern Workspace smoke, its journeys included, and then the other
// scripts, one after another, as the tier always has. Any other plan runs these lanes at once:
//
//   core       modern-workspace-smoke.mjs with its inline chain alone, and then units from the queue.
//   identity   every unit that signs the second test user in, logs out or administers a group, one
//              at a time, and then units from the queue.
//   general-N  units from the queue.
//
// The lanes share one queue. A lane that is free takes the next unit it may run, so the lanes that
// finish their own work early take a share of everyone else's, and which lane runs which unit is
// decided while the tier runs. The queue hands out the unit with the longest measured duration first.
// Identity units go to the identity lane alone, one at a time, because sign-ins contend in Keycloak
// and in the graph writes each one triggers, and a logout ends its context's single sign-on session.
//
// A lane runs its journeys in one focused-journey-smoke.mjs process that stays up and takes them one
// at a time, under a root folder of its own, and runs each script as a process of its own.
//
// Every unit has a deadline derived from its measured duration (see deadlineSeconds). The durations
// come from the newest split reports.

/** The modern Workspace smoke. The sequential plan runs all of it. */
export const CORE = Object.freeze({ name: "modern-workspace", args: ["modern-workspace-smoke.mjs"] });

/** The core lane's chain: the modern Workspace smoke without its journeys. */
export const CHAIN = Object.freeze({ name: "modern-workspace-chain", args: [...CORE.args, "--chain-only"] });

/**
 * The split tier's other scripts, in the order a sequential run takes them. `identity` says why a
 * script belongs to the identity lane.
 */
export const SCRIPTS = Object.freeze([
  { name: "ced-host", args: ["ced-host-smoke.mjs"] },
  { name: "account-profile", args: ["account-pages-smoke.mjs", "profile"] },
  { name: "account-settings", args: ["account-pages-smoke.mjs", "settings"] },
  { name: "account-groups", args: ["account-pages-smoke.mjs", "groups"],
    identity: "administers a group and signs the second user in" },
  { name: "account-privacy", args: ["account-pages-smoke.mjs", "privacy"] },
  { name: "workspace-lifecycle", args: ["workspace-lifecycle-smoke.mjs", "all"], identity: "logs out" },
  { name: "folder-delete", args: ["recursive-folder-delete-smoke.mjs"],
    identity: "grants to the second user and writes in their home" },
].map(script => Object.freeze(script)));

/** General lanes by default. The machine runs with nearly full swap, and each lane is a browser. */
export const DEFAULT_LANES = 2;
export const MAX_LANES = 4;

/**
 * How a unit's deadline follows from its measured duration:
 *
 *   deadline = min(cap, max(floor, factor × measured + margin))
 *
 * The factor allows for load. On the 16-core workstation a unit of ten seconds or more has taken at
 * most 1.7 times as long in one run as in another, so three times its newest measurement leaves room
 * for a heavier load than any yet seen without waiting long on a hung unit. The margin lets a unit
 * that is failing report its own failure. Playwright waits 25 to 30 seconds before an action fails,
 * so a unit that runs slow and then fails needs one such wait beyond its usual time. The floor keeps
 * a unit measured at a second or two from being judged hung after one long wait, which a sign-in or a
 * settled listing can need under load. The shorter units have varied by up to 3.7 times, but none has
 * yet taken more than 18 seconds. The cap bounds every unit, and it is the deadline of a unit no
 * report has measured, since nothing says how long that one should take. It also bounds the full
 * smoke a sequential run starts, which takes about 500 seconds.
 */
export const DEADLINE = Object.freeze({ factor: 3, marginSeconds: 30, floorSeconds: 60, capSeconds: 1200 });

/** A unit's deadline in seconds, from its estimate `{seconds, measured}`. */
export function deadlineSeconds(estimate, { factor, marginSeconds, floorSeconds, capSeconds } = DEADLINE) {
  if (!estimate?.measured || typeof estimate.seconds !== "number") return capSeconds;
  return Math.min(capSeconds, Math.max(floorSeconds, Math.ceil(factor * estimate.seconds + marginSeconds)));
}

/** Seconds assumed for a unit no report has measured, when no measured unit of its kind exists either. */
const UNMEASURED_SECONDS = 10;

/** A lane's root folder. It sorts after "Angular", the prefix of the core lane's fixtures. */
export const rootName = (stamp, lane) => `Focused journey ${stamp} ${lane}`;

/**
 * The newest split reports, newest first, from the directories given. Unreadable files are skipped,
 * since a report another run is writing is no reason to stop this one.
 */
export function latestReports(directories, limit = 12) {
  const files = [];
  for (const directory of directories) {
    let names;
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^split-smoke.*\.json$/.test(name)) continue;
      const path = join(directory, name);
      try {
        files.push({ path, modified: statSync(path).mtimeMs });
      } catch {}
    }
  }
  const reports = [];
  for (const { path } of files.sort((a, b) => b.modified - a.modified)) {
    if (reports.length >= limit) break;
    try {
      reports.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {}
  }
  return reports;
}

/**
 * Seconds per journey key and per script, each from the newest report that measured it. A report of
 * schema 3 lists every unit it ran with its duration, cleanup included. Older reports give a journey's
 * duration as its step in the timeline, which every version names by key, and a script's as its
 * process. A unit, step or script that failed measured only how long it took to fail, so it is skipped.
 * Before schema 3, the core lane's chain ran under the full smoke's name, with --chain-only.
 */
export function durationsFrom(reports) {
  const durations = new Map();
  const keep = (name, seconds) => {
    if (typeof seconds === "number" && typeof name === "string" && !durations.has(name)) durations.set(name, seconds);
  };
  for (const report of reports) {
    for (const unit of Array.isArray(report?.units) ? report.units : [])
      if (unit?.outcome === "pass") keep(unit.name, unit.seconds);
    const failures = Array.isArray(report?.failures)
      ? report.failures
      : [{ script: report?.failingScript, step: report?.failingStep }];
    const failed = new Set(failures.map(failure => failure?.script + "\u0000" + failure?.step));
    for (const step of Array.isArray(report?.steps) ? report.steps : []) {
      if (typeof step?.seconds !== "number" || typeof step.step !== "string") continue;
      if (failed.has(step.script + "\u0000" + step.step)) continue;
      keep(step.step, step.seconds);
    }
    for (const script of Array.isArray(report?.scripts) ? report.scripts : []) {
      if (script?.exitCode !== 0) continue;
      const chain = script.name === CORE.name && Array.isArray(script.command) && script.command.includes("--chain-only");
      keep(chain ? CHAIN.name : script.name, script.seconds);
    }
  }
  return durations;
}

function median(values) {
  if (!values.length) return UNMEASURED_SECONDS;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = seconds => Math.round(seconds * 10) / 10;

/** Longest first, and in registry order among units of the same length. */
export const longestFirst = (a, b) => b.seconds - a.seconds || a.order - b.order;

/**
 * The queue the lanes share. `next(lane)` hands the lane the longest unit it may run, or undefined
 * when none is left for it. The identity lane takes identity units while any remain, and never while
 * another is in flight; every other lane takes only general units. `finish(unit)` marks a unit done,
 * and `requeue(unit)` returns one a lane took but could not start.
 */
export function createQueue(units) {
  const pending = [...units].sort(longestFirst);
  const inFlight = new Set();
  const take = predicate => {
    const index = pending.findIndex(predicate);
    if (index < 0) return undefined;
    const [unit] = pending.splice(index, 1);
    inFlight.add(unit);
    return unit;
  };
  return {
    next(lane) {
      if (lane.identity && ![...inFlight].some(unit => unit.identity)) {
        const unit = take(candidate => candidate.identity);
        if (unit) return unit;
      }
      return take(candidate => !candidate.identity);
    },
    finish(unit) {
      inFlight.delete(unit);
    },
    requeue(unit) {
      inFlight.delete(unit);
      pending.push(unit);
      pending.sort(longestFirst);
    },
    pending: () => [...pending],
    inFlight: () => [...inFlight],
  };
}

/**
 * When each lane would finish if every unit took its estimate. The core lane joins the queue once
 * its chain is done, and the others once the core lane has made its fixtures. Each time a lane is
 * free it takes the next unit it may run, as the runner does. The order of the queue is fixed, but
 * which lane takes which unit depends on how long the units really take.
 */
export function simulate({ lanes, units, chainSeconds = 0, leadSeconds = 0 }) {
  const queue = createQueue(units);
  const state = lanes.map(lane => ({ lane, at: lane.core ? chainSeconds : leadSeconds, busy: 0, units: [], done: false }));
  for (;;) {
    const free = state.filter(entry => !entry.done);
    if (!free.length) break;
    const entry = free.reduce((earliest, candidate) => candidate.at < earliest.at ? candidate : earliest);
    const unit = queue.next(entry.lane);
    if (!unit) {
      entry.done = true;
      continue;
    }
    entry.units.push(unit.name);
    entry.at += unit.seconds;
    entry.busy += unit.seconds;
    queue.finish(unit);
  }
  const finished = state.map(entry => ({
    name: entry.lane.name, finishSeconds: round(entry.at), busySeconds: round(entry.busy + (entry.lane.core ? chainSeconds : 0)),
    units: entry.units,
  }));
  return { lanes: finished, finishSeconds: round(Math.max(0, ...finished.map(entry => entry.finishSeconds))) };
}

/**
 * The plan for a lane setting. One lane means the sequential run: the processes it runs in order,
 * each with its estimate and deadline. A higher setting means that many general lanes beside the core
 * and identity lanes, the chain the core lane runs first, the queue's units longest first, and when
 * each lane would finish. A unit no report has measured counts as the median of the measured units of
 * its kind for balancing, and its deadline is the cap.
 */
export function plan({ lanes = DEFAULT_LANES, durations = new Map(), stamp = Date.now(),
  journeys = JOURNEYS, scripts = SCRIPTS, deadline = DEADLINE } = {}) {
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > MAX_LANES)
    throw new RangeError(`lanes must be an integer from 1 to ${MAX_LANES}`);
  const measured = names => names.map(name => durations.get(name)).filter(value => typeof value === "number");
  const journeyDefault = median(measured(journeys.map(entry => entry.key)));
  const scriptDefault = median(measured(scripts.map(script => script.name)));
  const estimate = (name, fallback) => ({ seconds: durations.get(name) ?? fallback, measured: durations.has(name) });
  const unit = fields => {
    const { seconds, measured: isMeasured } = estimate(fields.name, fields.fallback);
    const { fallback, ...rest } = fields;
    return { ...rest, seconds, measured: isMeasured, deadlineSeconds: deadlineSeconds({ seconds, measured: isMeasured }, deadline) };
  };
  const units = [
    ...journeys.map((entry, order) => unit({ kind: "journey", name: entry.key, identity: entry.signsInAsAnotherUser,
      fallback: journeyDefault, order })),
    ...scripts.map((script, order) => unit({ kind: "script", name: script.name, args: [...script.args],
      identity: Boolean(script.identity), fallback: scriptDefault, order: journeys.length + order })),
  ];
  const estimates = Object.fromEntries(units.map(entry => [entry.name, { seconds: round(entry.seconds), measured: entry.measured }]));
  if (lanes === 1) {
    const processes = [
      unit({ kind: "script", name: CORE.name, args: [...CORE.args], identity: false, fallback: scriptDefault, order: -1 }),
      ...units.filter(entry => entry.kind === "script"),
    ].map(({ order, identity, ...rest }) => rest);
    return {
      sequential: true,
      generalLanes: 0,
      deadline,
      estimates,
      lanes: [{
        name: "sequential",
        root: null,
        keys: journeys.map(entry => entry.key),
        scripts: processes.map(process => process.name),
        plannedSeconds: round(processes.reduce((sum, process) => sum + process.seconds, 0)),
        processes,
      }],
    };
  }
  const chain = unit({ kind: "chain", name: CHAIN.name, args: [...CHAIN.args], identity: false, fallback: scriptDefault, order: -1 });
  delete chain.order;
  const laneList = [
    { name: "core", core: true, identity: false },
    ...(units.some(entry => entry.identity) ? [{ name: "identity", core: false, identity: true }] : []),
    ...Array.from({ length: lanes }, (_, index) => ({ name: `general-${index + 1}`, core: false, identity: false })),
  ].map(lane => ({ ...lane, root: rootName(stamp, lane.name) }));
  const queued = [...units].sort(longestFirst);
  const projection = simulate({ lanes: laneList, units: queued, chainSeconds: chain.seconds });
  return {
    sequential: false,
    generalLanes: lanes,
    deadline,
    estimates: { ...estimates, [chain.name]: { seconds: round(chain.seconds), measured: chain.measured } },
    chain,
    lanes: laneList,
    units: queued,
    projection,
  };
}
