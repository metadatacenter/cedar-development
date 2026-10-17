import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOURNEYS } from "./journey-registry.mjs";

// The split tier's plan says which processes run, in which lane and in which order. split-tier.mjs
// carries it out. Every lane is one sequence of Node processes, so the module-level state each script
// keeps, such as the fixtures it created and the step it is in, belongs to one lane only.
//
// A sequential plan runs the full modern Workspace smoke, its journeys included, and then the other
// scripts, one after another, as the tier always has. Any other plan runs these lanes at once:
//
//   core       modern-workspace-smoke.mjs with its inline chain alone.
//   identity   every journey that signs the second test user in, and every script that signs users
//              in, logs out or administers a group, one after another.
//   general-N  the remaining journeys and scripts, balanced across N lanes.
//
// A lane runs its journeys in one focused-journey-smoke.mjs process, under a root folder of its own,
// and then its scripts. Balancing assigns the longest unit first, each to the lane with the least
// work so far, using the durations the newest split reports measured.

/** The modern Workspace smoke. The sequential plan runs all of it, the core lane its chain alone. */
export const CORE = Object.freeze({ name: "modern-workspace", args: ["modern-workspace-smoke.mjs"] });

/**
 * The split tier's other scripts, in the order a sequential run takes them. `identity` says why a
 * script belongs in the identity lane.
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
 * Seconds per journey key and per script, each from the newest report that measured it. A journey's
 * duration is its step in the timeline, which both report versions name by key. A step that failed,
 * and a script that failed, measured only how long they took to fail, so they are skipped.
 */
export function durationsFrom(reports) {
  const durations = new Map();
  for (const report of reports) {
    const failures = Array.isArray(report?.failures)
      ? report.failures
      : [{ script: report?.failingScript, step: report?.failingStep }];
    const failed = new Set(failures.map(failure => failure?.script + "\u0000" + failure?.step));
    for (const step of Array.isArray(report?.steps) ? report.steps : []) {
      if (typeof step?.seconds !== "number" || typeof step.step !== "string") continue;
      if (failed.has(step.script + "\u0000" + step.step) || durations.has(step.step)) continue;
      durations.set(step.step, step.seconds);
    }
    for (const script of Array.isArray(report?.scripts) ? report.scripts : []) {
      if (typeof script?.seconds !== "number" || script.exitCode !== 0 || durations.has(script.name)) continue;
      durations.set(script.name, script.seconds);
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

/**
 * The plan for a lane setting. One lane means the sequential run. A higher setting means that many
 * general lanes beside the core and identity lanes. Each lane lists its journey keys and its scripts,
 * the processes it runs in order, and the seconds its measured units add up to. A unit no report has
 * measured counts as the median of the measured units of its kind.
 */
export function plan({ lanes = DEFAULT_LANES, durations = new Map(), stamp = Date.now(),
  journeys = JOURNEYS, scripts = SCRIPTS } = {}) {
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > MAX_LANES)
    throw new RangeError(`lanes must be an integer from 1 to ${MAX_LANES}`);
  const measured = names => names.map(name => durations.get(name)).filter(value => typeof value === "number");
  const journeyDefault = median(measured(journeys.map(entry => entry.key)));
  const scriptDefault = median(measured(scripts.map(script => script.name)));
  const units = [
    ...journeys.map((entry, order) => ({ kind: "journey", name: entry.key, identity: entry.signsInAsAnotherUser,
      seconds: durations.get(entry.key) ?? journeyDefault, measured: durations.has(entry.key), order })),
    ...scripts.map((script, order) => ({ kind: "script", name: script.name, args: script.args,
      identity: Boolean(script.identity), seconds: durations.get(script.name) ?? scriptDefault,
      measured: durations.has(script.name), order: journeys.length + order })),
  ];
  const estimates = Object.fromEntries(units.map(unit => [unit.name, { seconds: round(unit.seconds), measured: unit.measured }]));
  if (lanes === 1) {
    return {
      sequential: true,
      generalLanes: 0,
      estimates,
      lanes: [{
        name: "sequential",
        root: null,
        keys: journeys.map(entry => entry.key),
        scripts: [CORE.name, ...scripts.map(script => script.name)],
        plannedSeconds: round(units.reduce((sum, unit) => sum + unit.seconds, 0)),
        processes: [{ ...CORE, args: [...CORE.args] }, ...scripts.map(script => ({ name: script.name, args: [...script.args] }))],
      }],
    };
  }
  const longestFirst = list => [...list].sort((a, b) => b.seconds - a.seconds || a.order - b.order);
  const lane = (name, assigned) => {
    const keys = assigned.filter(unit => unit.kind === "journey").map(unit => unit.name);
    const laneScripts = assigned.filter(unit => unit.kind === "script");
    const root = keys.length ? rootName(stamp, name) : null;
    return {
      name,
      root,
      keys,
      scripts: laneScripts.map(unit => unit.name),
      plannedSeconds: round(assigned.reduce((sum, unit) => sum + unit.seconds, 0)),
      processes: [
        ...(keys.length ? [{ name, args: ["focused-journey-smoke.mjs", `--root=${root}`, ...keys] }] : []),
        ...laneScripts.map(unit => ({ name: unit.name, args: [...unit.args] })),
      ],
    };
  };
  const identity = units.filter(unit => unit.identity);
  const general = Array.from({ length: lanes }, () => ({ assigned: [], seconds: 0 }));
  for (const unit of longestFirst(units.filter(unit => !unit.identity))) {
    const target = general.reduce((least, candidate) => candidate.seconds < least.seconds ? candidate : least);
    target.assigned.push(unit);
    target.seconds += unit.seconds;
  }
  return {
    sequential: false,
    generalLanes: lanes,
    estimates,
    lanes: [
      { name: "core", root: null, keys: [], scripts: [CORE.name], plannedSeconds: null,
        processes: [{ name: CORE.name, args: [...CORE.args, "--chain-only"] }] },
      lane("identity", [...longestFirst(identity.filter(unit => unit.kind === "journey")),
        ...identity.filter(unit => unit.kind === "script")]),
      ...general.map((entry, index) => lane(`general-${index + 1}`, entry.assigned)),
    ].filter(entry => entry.processes.length),
  };
}
