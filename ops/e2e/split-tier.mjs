// The split tier drives the Angular Workspace, the Designer host and the account pages. By default it
// runs in lanes, each a sequence of Node processes, all lanes at once, and split-lanes.mjs says which
// process runs in which lane. With `--lanes=1` it runs one script after another and stops at the
// first failure, as the `&&` chain it replaced did.
//
//   node split-tier.mjs [--lanes=N] [--report=PATH] [--plan]
//
// N is the number of general lanes beside the core and identity lanes, from 1 to 4. The default is 2,
// and 1 means the sequential run. `--plan` prints the lanes and exits without running anything.
//
// The core lane starts first. The others start once it has made its fixtures, so its searches find
// them before the other lanes' fixtures reach the search index. A lane stops at its first failure,
// and every other lane runs to its end, so one run names every lane that fails. A first SIGINT or
// SIGTERM stops every lane's processes, each of which closes its browser and removes its fixtures.
// A second one kills them with their browsers and forgoes that cleanup.
//
// The report names every lane with its journeys and scripts, how long each lane and each process
// took and how it ended, the step every failing lane failed in, every step with its duration, and
// the machine's load average and swap at start, at peak and at end, since a burst of uniform
// timeouts is usually load. It defaults to reports/split-smoke.json, and `cedarcli test e2e` passes
// a path of its own.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_LANES, MAX_LANES, durationsFrom, latestReports, plan } from "./split-lanes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = 2;
// How long the other lanes wait at most for the core lane to make its fixtures.
const CORE_LEAD_LIMIT_MS = 30000;
// How long the processes have to clean up after the first signal before they are killed.
const CLEANUP_GRACE_MS = 120000;
// npm forwards the terminal's interrupt to the process it runs, which has already received it.
const SAME_SIGNAL_MS = 1000;

const argv = process.argv.slice(2);
const option = name => argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const lanesOption = option("lanes") ?? String(DEFAULT_LANES);
const lanes = Number(lanesOption);
if (!/^\d+$/.test(lanesOption) || lanes < 1 || lanes > MAX_LANES) {
  console.error(`--lanes must be an integer from 1 to ${MAX_LANES}, not ${lanesOption}`);
  process.exit(2);
}
const reportPath = option("report") ?? join(here, "reports", "split-smoke.json");
const stepsPath = reportPath.replace(/\.json$/, "") + ".steps.jsonl";
const layout = plan({
  lanes,
  durations: durationsFrom(latestReports([join(here, "reports"), join(here, "reports", "smoke-gate")])),
});

function describe(lane) {
  const parts = [];
  if (lane.keys.length) parts.push(`${lane.keys.length} journeys: ${lane.keys.join(", ")}`);
  if (lane.scripts.length) parts.push(`scripts: ${lane.scripts.join(", ")}`);
  return parts.join("; ");
}

if (argv.includes("--plan")) {
  console.log(layout.sequential ? "Sequential run" : `${layout.generalLanes} general lanes beside the core and identity lanes`);
  for (const lane of layout.lanes)
    console.log(`  ${lane.name}${lane.plannedSeconds === null ? "" : ` (planned ${lane.plannedSeconds} s)`}: ${describe(lane)}`);
  const unmeasured = Object.entries(layout.estimates).filter(([, estimate]) => !estimate.measured).map(([name]) => name);
  if (unmeasured.length) console.log(`  No report measured: ${unmeasured.join(", ")}`);
  process.exit(0);
}

function swap() {
  try {
    if (process.platform === "darwin") {
      const text = spawnSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).stdout;
      const total = /total = ([\d.]+)M/.exec(text), used = /used = ([\d.]+)M/.exec(text);
      return total && used ? { totalMB: Number(total[1]), usedMB: Number(used[1]) } : null;
    }
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = name => Number(new RegExp("^" + name + ":\\s+(\\d+)", "m").exec(info)?.[1]);
    return { totalMB: Math.round(kb("SwapTotal") / 1024), usedMB: Math.round((kb("SwapTotal") - kb("SwapFree")) / 1024) };
  } catch {
    return null;
  }
}
const machine = () => ({ load: loadavg().map(value => Math.round(value * 100) / 100), swap: swap() });
const seconds = (from, to = Date.now()) => Math.round((to - from) / 100) / 10;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function events() {
  if (!existsSync(stepsPath)) return [];
  return readFileSync(stepsPath, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const running = new Set();
let interrupted = null, firstSignalAt = 0, forced = false;

/** A process's descendants, deepest last. Playwright starts each browser in a process group of its own. */
function descendants(pid) {
  const children = (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "")
    .split("\n").filter(Boolean).map(Number);
  return children.flatMap(child => [child, ...descendants(child)]);
}

function force() {
  if (forced) return;
  forced = true;
  for (const child of running)
    for (const pid of [...descendants(child.pid), child.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) {
      if (Date.now() - firstSignalAt < SAME_SIGNAL_MS) return;
      console.log(`--- split tier: ${signal} again; killing every lane's processes and browsers without cleanup`);
      force();
      return;
    }
    interrupted = signal;
    firstSignalAt = Date.now();
    console.log(`--- split tier: ${signal}; stopping every lane, whose processes close their browsers and remove their fixtures`);
    for (const child of running) child.kill("SIGTERM");
    setTimeout(() => {
      console.log(`--- split tier: processes still running ${CLEANUP_GRACE_MS / 1000} s after ${signal}; killing them`);
      force();
    }, CLEANUP_GRACE_MS).unref();
  });
}

/** Copies a stream to the runner's own, a line at a time, each line prefixed with its process. */
function relay(stream, target, prefix) {
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", line => target.write(prefix + line + "\n"));
}

/**
 * Runs one process to its end. Each process leads a process group of its own, so an interrupt from the
 * terminal reaches the runner alone, and the runner decides what each process is sent.
 */
function run(unit) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, unit.args, {
      cwd: here,
      detached: true,
      stdio: layout.sequential ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, CEDAR_SPLIT_STEPS: stepsPath, CEDAR_SPLIT_SCRIPT: unit.name },
    });
    running.add(child);
    if (!layout.sequential) {
      relay(child.stdout, process.stdout, `[${unit.name}] `);
      relay(child.stderr, process.stderr, `[${unit.name}] `);
    }
    child.on("error", error => {
      running.delete(child);
      resolve({ code: 127, error: error.message });
    });
    // The process has exited at "exit", and its output has all been relayed at "close".
    let ended;
    child.on("exit", (code, signal) => {
      running.delete(child);
      ended = { code: code ?? 1, signal };
    });
    child.on("close", () => resolve(ended));
  });
}

mkdirSync(dirname(reportPath), { recursive: true });
rmSync(stepsPath, { force: true });
const startedAt = new Date();
const atStart = machine();
const peak = { load: atStart.load[0], swapUsedMB: atStart.swap?.usedMB ?? null };
const sampler = setInterval(() => {
  const now = machine();
  peak.load = Math.max(peak.load, now.load[0]);
  if (now.swap) peak.swapUsedMB = Math.max(peak.swapUsedMB ?? 0, now.swap.usedMB);
}, 10000);
const scripts = [];
const scriptEnds = {};

async function runLane(lane, record) {
  record.startedAfterSeconds = seconds(startedAt.getTime());
  const began = Date.now();
  for (const unit of lane.processes) {
    if (interrupted || record.exitCode) {
      record.notRun.push(unit.name);
      continue;
    }
    const unitBegan = Date.now();
    console.log(`--- split tier: ${lane.name}: ${unit.name} (node ${unit.args.join(" ")})`);
    const outcome = await run(unit);
    scriptEnds[unit.name] = Date.now();
    scripts.push({
      name: unit.name,
      lane: lane.name,
      command: ["node", ...unit.args],
      exitCode: outcome.code,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      startedAfterSeconds: seconds(startedAt.getTime(), unitBegan),
      seconds: seconds(unitBegan),
    });
    if (outcome.code !== 0) {
      record.exitCode = outcome.code;
      record.failingScript = unit.name;
    }
    console.log(`--- split tier: ${lane.name}: ${unit.name} exited ${outcome.code} after ${seconds(unitBegan)} s`);
  }
  record.seconds = seconds(began);
}

const records = layout.lanes.map(lane => ({
  name: lane.name,
  root: lane.root,
  keys: lane.keys,
  scripts: lane.scripts,
  plannedSeconds: lane.plannedSeconds,
  startedAfterSeconds: null,
  seconds: null,
  exitCode: 0,
  failingScript: null,
  failingStep: null,
  failure: null,
  notRun: [],
}));
console.log(layout.sequential
  ? "--- split tier: one script after another"
  : `--- split tier: ${layout.lanes.length} lanes, ${layout.generalLanes} of them general`);
for (const lane of layout.lanes) console.log(`    ${lane.name}: ${describe(lane)}`);

if (layout.sequential) {
  await runLane(layout.lanes[0], records[0]);
} else {
  // The core lane runs its chain alone. Its Designer search must find the element it made moments
  // before, and the search index takes writes in turn, so the other lanes start once the core has
  // made its fixtures, which it has when it enters its next step, or once it has ended.
  const core = runLane(layout.lanes[0], records[0]);
  let coreEnded = false;
  core.then(() => { coreEnded = true; });
  const leadBegan = Date.now();
  while (!coreEnded && !interrupted && Date.now() - leadBegan < CORE_LEAD_LIMIT_MS &&
    !events().some(event => event.script === layout.lanes[0].processes[0].name && event.event === "step" && event.step === "create-template"))
    await sleep(250);
  if (!interrupted) console.log(`--- split tier: starting the other lanes ${seconds(leadBegan)} s after the core lane`);
  await Promise.all([core, ...layout.lanes.slice(1).map((lane, index) => runLane(lane, records[index + 1]))]);
}
clearInterval(sampler);

// One record per event, in the order they happened. A step lasts until the next event its process
// writes, and the last one until the process exits.
const all = events();
const timeline = [];
all.forEach((event, index) => {
  if (event.event !== "step") return;
  const next = all.slice(index + 1).find(other => other.script === event.script);
  const until = next ? Date.parse(next.at) : scriptEnds[event.script];
  timeline.push({
    script: event.script,
    step: event.step,
    seconds: until ? Math.round((until - Date.parse(event.at)) / 100) / 10 : null,
  });
});
const failures = [];
for (const record of records) {
  if (!record.failingScript) continue;
  const failure = all.filter(event => event.script === record.failingScript && event.event === "fail").at(-1);
  record.failingStep = failure?.step ?? null;
  record.failure = failure?.message ?? null;
  failures.push({
    lane: record.name,
    script: record.failingScript,
    step: record.failingStep,
    exitCode: record.exitCode,
    message: record.failure,
    finishedAt: new Date(scriptEnds[record.failingScript]).toISOString(),
  });
}
failures.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
const first = failures[0];
const finishedAt = new Date();
const ends = all.filter(event => event.event === "end");
const report = {
  schemaVersion: SCHEMA_VERSION,
  verdict: interrupted ? "INTERRUPTED" : failures.length ? "FAIL" : "PASS",
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: seconds(startedAt.getTime(), finishedAt.getTime()),
  sequential: layout.sequential,
  generalLanes: layout.generalLanes,
  ...(interrupted ? { interrupted } : {}),
  machine: { start: atStart, peak, end: machine() },
  failingScript: first?.script ?? null,
  failingStep: first?.step ?? null,
  failure: first?.message ?? null,
  failures,
  checks: ends.reduce((sum, end) => sum + (typeof end.checks === "number" ? end.checks : 0), 0),
  lanes: records,
  scripts,
  notRun: records.flatMap(record => record.notRun),
  steps: timeline,
  inventory: [...new Set(timeline.map(entry => entry.script + ":" + entry.step))],
  ends,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const slowest = [...timeline].filter(entry => entry.seconds !== null).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log(`--- split tier: ${report.verdict} in ${report.durationSeconds} s; report ${reportPath}`);
for (const record of records)
  console.log(`    ${record.name}: ${record.seconds ?? 0} s, exit ${record.exitCode}` +
    (record.failingScript ? `, failed in ${record.failingScript}${record.failingStep ? ", step " + record.failingStep : ""}` : "") +
    (record.notRun.length ? `; not run: ${record.notRun.join(", ")}` : ""));
for (const failure of failures)
  if (failure.message) console.log(`    ${failure.lane}: ${failure.message.split("\n")[0].slice(0, 300)}`);
if (slowest.length) console.log("    slowest steps: " + slowest.map(entry => `${entry.step} ${entry.seconds} s`).join(", "));
console.log(`    load ${atStart.load[0]} at start, ${peak.load} at peak, ${report.machine.end.load[0]} at end` +
  (peak.swapUsedMB !== null ? `; swap used ${atStart.swap?.usedMB} MB at start, ${peak.swapUsedMB} MB at peak` : ""));
process.exitCode = interrupted ? 130 : first ? first.exitCode || 1 : 0;
