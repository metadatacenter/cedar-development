// The split tier drives the Angular Workspace, the Designer host and the account pages. By default it
// runs in lanes at the same time, which take their work from one queue. With `--lanes=1` it runs one
// script after another and stops at the first failure, as the `&&` chain it replaced did.
//
//   node split-tier.mjs [--lanes=N] [--timeout-cap=SECONDS] [--report=PATH] [--plan]
//
// N is the number of general lanes beside the core and identity lanes, from 1 to 4. The default is 2,
// and 1 means the sequential run. split-lanes.mjs says what each lane may run and how the queue hands
// out its units. `--plan` prints the queue, its rules and the projected finish, and runs nothing.
//
// Every unit has a deadline derived from its measured duration, never longer than the cap, which
// defaults to 1,200 seconds. split-lanes.mjs states the formula. A unit that overruns is killed with
// its browsers and swept: what it created is removed through REST. The run fails, its report names the
// unit, the lane and the elapsed time, and the other lanes carry on with the remaining units.
//
// One run goes at a time. A run takes the lock in $CEDAR_HOME/.cedar/locks/ (split-lock.mjs), and a
// second run refuses at once with status 75, naming the holder. split-runner.mjs carries out the plan
// and says what a signal does.
//
// The report names every lane with the units it ran and how long each took, its busy and idle time,
// any timeout and what its sweep removed, every failure, every step with its duration, and the
// machine's load average and swap at start, at peak and at end, since a burst of uniform timeouts is
// usually load. It defaults to reports/split-smoke.json, and `cedarcli test e2e` passes a path of its
// own.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEADLINE, DEFAULT_LANES, MAX_LANES, durationsFrom, latestReports, plan } from "./split-lanes.mjs";
import { lockPath } from "./split-lock.mjs";
import { runTier } from "./split-runner.mjs";
import { beginHistory } from "./journey-history.mjs";
import { sweep } from "./split-sweep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = name => argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const integer = (name, fallback, low, high) => {
  const text = option(name) ?? String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < low || value > high) {
    console.error(`--${name} must be an integer from ${low} to ${high}, not ${text}`);
    process.exit(2);
  }
  return value;
};
const lanes = integer("lanes", DEFAULT_LANES, 1, MAX_LANES);
const capSeconds = integer("timeout-cap", DEADLINE.capSeconds, 10, 7200);
const deadline = { ...DEADLINE, capSeconds };
const reportPath = option("report") ?? join(here, "reports", "split-smoke.json");
const layout = plan({
  lanes,
  seed: option("seed") ?? null,
  deadline,
  durations: durationsFrom(latestReports([join(here, "reports"), join(here, "reports", "smoke-gate")])),
});

function describe(unit) {
  return `${unit.name} (${unit.measured ? Math.round(unit.seconds * 10) / 10 + " s" : "unmeasured"}, ` +
    `deadline ${unit.deadlineSeconds} s)`;
}

if (argv.includes("--plan")) {
  const { factor, marginSeconds, floorSeconds } = deadline;
  console.log(`Deadline per unit: min(${capSeconds}, max(${floorSeconds}, ${factor} × measured + ${marginSeconds})) s; ` +
    `${capSeconds} s for a unit no report has measured`);
  if (layout.sequential) {
    console.log("Sequential run, one process after another, stopping at the first failure:");
    for (const unit of layout.lanes[0].processes) console.log("  " + describe(unit));
    console.log(`  Projected: ${layout.lanes[0].plannedSeconds} s`);
    process.exit(0);
  }
  console.log(`${layout.generalLanes} general lanes beside the core and identity lanes, sharing one queue.`);
  console.log(`  core runs the chain first, ${describe(layout.chain)}, and then takes general units.`);
  console.log("  identity takes identity units one at a time while any remain, then general units. No other lane");
  console.log("  takes an identity unit, so no two run at once.");
  console.log("  general lanes take general units. They start once the core lane has made its fixtures.");
  console.log("  A lane that fails or times out takes no further units. Each unit runs once.");
  console.log(layout.seed === null ? "Queue, longest first. A free lane takes the first unit it may run:" : `Queue shuffled with seed ${layout.seed}:`);
  for (const unit of layout.units)
    console.log(`  ${unit.identity ? "identity" : "general "} ${unit.kind === "journey" ? "journey" : "script "} ${describe(unit)}`);
  console.log(`Projected finish: ${layout.projection.finishSeconds} s, if every unit takes its estimate:`);
  for (const lane of layout.projection.lanes)
    console.log(`  ${lane.name}: busy ${lane.busySeconds} s, done at ${lane.finishSeconds} s, ${lane.units.length} units`);
  console.log("The order is fixed, but which lane runs which unit is decided while the tier runs, by whichever");
  console.log("lane is free first, so the lanes a run reports may differ from this projection.");
  const unmeasured = layout.units.filter(unit => !unit.measured).map(unit => unit.name);
  if (unmeasured.length) console.log(`No report measured: ${unmeasured.join(", ")}`);
  process.exit(0);
}

if (lanes === 1 && option("seed") !== undefined) throw new Error("Use --seed with parallel lanes or focused journeys; --lanes=1 preserves legacy order");
const history = beginHistory({ cwd: here, kind: "split", selection: layout.sequential ? layout.lanes[0].processes.map(unit => unit.name) :
  [layout.chain.name, ...layout.units.map(unit => unit.name)], seed: option("seed") ?? null, retryOf: option("retry-of") });
const { exitCode } = await runTier({
  history,
  environment: option("record-inventory") || process.env.CEDAR_JOURNEY_RECORD_INVENTORY
    ? { CEDAR_JOURNEY_RECORD_INVENTORY: option("record-inventory") ?? process.env.CEDAR_JOURNEY_RECORD_INVENTORY } : {},
  layout,
  reportPath,
  cwd: here,
  lockFile: lockPath(here),
  sweep,
});
process.exitCode = exitCode;
