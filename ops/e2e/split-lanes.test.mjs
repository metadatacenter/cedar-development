import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { CROSS_BROWSER_JOURNEYS, execution, expandedJourneys } from "./journey-engines.mjs";
import {JOURNEYS} from "./journey-registry.mjs";
import {
  CHAIN, CORE, DEADLINE, DEFAULT_LANES, MAX_LANES, SCRIPTS, createQueue, deadlineSeconds, durationsFrom,
  latestReports, plan, simulate,
} from "./split-lanes.mjs";

// The split tier runs whatever the plan and its queue say. A journey the plan drops is never run, and
// one it hands out twice collides with itself on the names it creates.
const executions = expandedJourneys(JOURNEYS);
const keys = executions.map(entry => entry.name);
const identityKeys = executions.filter(entry => entry.authentication).map(entry => entry.name);
const identityScripts = SCRIPTS.filter(script => script.identity).map(script => script.name);
const durations = new Map(JOURNEYS.map((entry, index) => [entry.key, 1 + (index * 7) % 23]));

test("one lane is the sequential run, in the order the tier always ran", () => {
  const layout = plan({lanes: 1, durations});
  assert.equal(layout.sequential, true);
  assert.equal(layout.lanes.length, 1);
  assert.deepEqual(layout.lanes[0].processes.map(process => process.args),
    [CORE.args, ...executions.filter(entry => entry.browser !== "chromium").map(entry => ["focused-journey-smoke.mjs", entry.name]), ...SCRIPTS.map(script => script.args)]);
  assert.deepEqual(layout.lanes[0].processes[0].args, ["modern-workspace-smoke.mjs"]);
  assert.deepEqual(layout.lanes[0].keys, keys);
  assert.ok(layout.lanes[0].processes.every(process => Number.isInteger(process.deadlineSeconds)));
});

for (const lanes of [2, 3, MAX_LANES]) {
  test(`${lanes} general lanes share one queue holding every journey and script once`, () => {
    const layout = plan({lanes, durations, stamp: 1760000000000});
    assert.equal(layout.sequential, false);
    assert.deepEqual(layout.lanes.map(lane => lane.name),
      ["core", ...Array.from({length: lanes}, (_, index) => `general-${index + 1}`)]);
    assert.deepEqual(layout.chain.args, [...CORE.args, "--chain-only"]);
    assert.equal(layout.chain.name, CHAIN.name);
    const queued = layout.units.map(unit => unit.name);
    assert.deepEqual([...queued].sort(), [...keys, ...SCRIPTS.map(script => script.name)].sort());
    assert.deepEqual(layout.units.filter(unit => unit.identity).map(unit => unit.name).sort(),
      [...identityKeys, ...identityScripts].sort());
    // Every unit in the projection runs exactly once.
    const projected = layout.projection.lanes.flatMap(lane => lane.units);
    assert.deepEqual([...projected].sort(), [...queued].sort());
  });
}

test("same-user recovery is identity work and retains its reason in the execution plan", () => {
  const layout = plan({ lanes: 2 });
  for (const name of ["draft-recovery", "uncertain-create"]) {
    const unit = layout.units.find(unit => unit.name === name);
    assert.equal(unit.identity, true);
    assert.equal(unit.authentication, "reauthenticates the first user");
  }
});

test("every engine runs the real-stack chain once within the existing lanes", () => {
  for (const lanes of [1, 2, DEFAULT_LANES]) {
    const layout = plan({ lanes });
    const processes = layout.sequential ? layout.lanes[0].processes : [layout.chain, ...layout.units];
    const chains = processes.filter(unit => unit.args?.[0] === "modern-workspace-smoke.mjs");
    const browser = unit => unit.args.find(arg => arg.startsWith("--browser="))?.slice(10) ?? "chromium";
    assert.deepEqual(chains.map(browser).sort(), ["chromium", "firefox", "webkit"]);
    for (const chain of chains.filter(unit => browser(unit) !== "chromium"))
      assert.ok(chain.args.includes("--chain-only"), "additional engines run the selected chain, not every journey");
    assert.equal(layout.lanes.length, lanes === 1 ? 1 : lanes + 1, "additional engines do not create additional lanes");
  }
});

test("new browser chains borrow the core timing for queue order without claiming a measured deadline", () => {
  const layout = plan({ lanes: 2, durations: new Map([[CHAIN.name, 75], ["ced-host", 8]]) });
  for (const browser of ["firefox", "webkit"]) {
    const chain = layout.units.find(unit => unit.name === `${CHAIN.name}-${browser}`);
    assert.equal(chain.seconds, 75);
    assert.equal(chain.measured, false);
    assert.equal(chain.deadlineSeconds, DEADLINE.capSeconds);
    assert.ok(layout.units.indexOf(chain) < layout.units.findIndex(unit => unit.name === "ced-host"));
  }
});

test("each lane works under a root of its own that sorts after the core lane's fixtures", () => {
  const layout = plan({lanes: DEFAULT_LANES, durations, stamp: 1760000000000});
  const roots = layout.lanes.map(lane => lane.root);
  assert.equal(new Set(roots).size, roots.length);
  for (const root of roots) assert.ok(root.localeCompare("Angular journey template 1760000000000") > 0, root);
});

const unit = (name, seconds, identity = false, order = 0) => ({name, seconds, identity, order, kind: "journey", measured: true});

test("the queue hands out the longest unit to whichever lane asks, identity units included", () => {
  const queue = createQueue([unit("short", 1, false, 0), unit("long", 9, false, 1), unit("who", 5, true, 2),
    unit("whom", 7, true, 3), unit("tie-a", 4, false, 4), unit("tie-b", 4, false, 5)]);
  assert.equal(queue.next().name, "long");
  const first = queue.next();
  assert.equal(first.name, "whom", "an identity unit goes in its place by length");
  assert.equal(queue.next().name, "who", "a second identity unit may run while the first is in flight");
  assert.equal(queue.next().name, "tie-a", "units of the same length go in registry order");
  queue.finish(first);
  assert.equal(queue.next().name, "tie-b");
  assert.equal(queue.next().name, "short");
  assert.equal(queue.next(), undefined);
  assert.deepEqual(queue.pending(), []);
});

test("identity units may be in flight together, and a unit that could not start goes back in order", () => {
  const queue = createQueue([unit("a", 5, true, 0), unit("b", 4, true, 1), unit("g", 3, false, 2), unit("h", 2, false, 3)]);
  const a = queue.next();
  assert.equal(a.name, "a");
  assert.equal(queue.next().name, "b", "the authentication lock serializes sign-ins, not the units around them");
  queue.requeue(a);
  assert.deepEqual(queue.pending().map(entry => entry.name), ["a", "g", "h"]);
  assert.deepEqual(queue.inFlight().map(entry => entry.name), ["b"]);
});

test("the core lane takes a share of the queue once its chain is done", () => {
  const units = [
    ...["g1", "g2", "g3", "g4", "g5", "g6"].map((name, order) => unit(name, 10, false, order)),
    unit("i1", 5, true, 6),
  ];
  const lanes = [{name: "core", core: true}, {name: "general-1"}, {name: "general-2"}];
  const projection = simulate({lanes, units, chainSeconds: 10});
  assert.deepEqual(projection.lanes.map(lane => [lane.name, lane.units]),
    [["core", ["g3", "g6"]], ["general-1", ["g1", "g4", "i1"]], ["general-2", ["g2", "g5"]]]);
  // Had the core lane stopped after its chain, the two general lanes would have needed 35 s.
  assert.equal(projection.finishSeconds, 30);
});

test("a deadline is three times the measured duration plus 30 s, at least 60 s and at most the cap", () => {
  assert.deepEqual(DEADLINE, {factor: 3, marginSeconds: 30, floorSeconds: 60, capSeconds: 1200});
  assert.equal(deadlineSeconds({seconds: 2, measured: true}), 60, "the floor");
  assert.equal(deadlineSeconds({seconds: 35.4, measured: true}), 137, "3 × 35.4 + 30, rounded up");
  assert.equal(deadlineSeconds({seconds: 521.7, measured: true}), 1200, "the cap");
  assert.equal(deadlineSeconds({seconds: 4, measured: false}), 1200, "a unit no report measured gets the cap");
  assert.equal(deadlineSeconds({seconds: 50, measured: true}, {...DEADLINE, capSeconds: 120}), 120);
  assert.equal(deadlineSeconds({seconds: 2, measured: true}, {factor: 2, marginSeconds: 1, floorSeconds: 1, capSeconds: 9}), 5);
  const layout = plan({lanes: 2, durations: new Map([["folder-ui", 3]]), deadline: {...DEADLINE, capSeconds: 300}});
  assert.equal(layout.units.find(entry => entry.name === "folder-ui").deadlineSeconds, 60);
  assert.equal(layout.units.find(entry => entry.name === "publication").deadlineSeconds, 300);
});

test("a unit no report measured counts as the median of its kind", () => {
  const journeys = ["a", "b", "c", "new"].map(key => ({key, authentication: false}));
  const layout = plan({lanes: 2, durations: new Map([["a", 2], ["b", 4], ["c", 30]]), journeys, scripts: []});
  assert.deepEqual(layout.estimates.new, {seconds: 4, measured: false});
  assert.deepEqual(layout.estimates.c, {seconds: 30, measured: true});
  assert.deepEqual(layout.lanes.map(lane => lane.name), ["core", "general-1", "general-2"]);
});

test(`a lane setting outside 1 to ${MAX_LANES} is refused`, () => {
  for (const lanes of [0, MAX_LANES + 1, 1.5, "2"]) assert.throws(() => plan({lanes}), RangeError);
});

test("durations come from the newest report that measured each unit, never from a failure", () => {
  const sequential = {
    schemaVersion: 1, failingScript: "modern-workspace", failingStep: "save-status",
    steps: [{script: "modern-workspace", step: "save-status", seconds: 25}, {script: "modern-workspace", step: "duplication", seconds: 9}],
    scripts: [{name: "modern-workspace", exitCode: 1, seconds: 300}, {name: "ced-host", exitCode: 0, seconds: 14.4}],
  };
  const lanes = {
    schemaVersion: 2,
    failures: [{lane: "general-1", script: "general-1", step: "older-artifacts"}],
    steps: [{script: "general-1", step: "duplication", seconds: 12}, {script: "general-1", step: "older-artifacts", seconds: 40},
      {script: "general-2", step: "publication", seconds: null}],
    scripts: [{name: "ced-host", exitCode: 0, seconds: 16},
      {name: "modern-workspace", command: ["node", "modern-workspace-smoke.mjs", "--chain-only"], exitCode: 0, seconds: 44}],
  };
  const queued = {
    schemaVersion: 3,
    units: [{name: "uncertain-create", outcome: "pass", seconds: 31}, {name: "save-status", outcome: "timeout", seconds: 90},
      {name: "modern-workspace-chain", outcome: "pass", seconds: 41}],
    steps: [{script: "core", step: "uncertain-create", seconds: 29}],
    scripts: [],
  };
  const measured = durationsFrom([queued, lanes, sequential]);
  assert.equal(measured.get("uncertain-create"), 31, "a schema 3 unit's duration includes its cleanup");
  assert.equal(measured.get(CHAIN.name), 41);
  assert.equal(measured.get("duplication"), 12);
  assert.equal(measured.get("ced-host"), 16);
  assert.equal(measured.has("older-artifacts"), false);
  assert.equal(measured.has("save-status"), false, "a timeout measures nothing, nor does an older failure");
  assert.equal(measured.has("publication"), false);
  assert.equal(measured.has("modern-workspace"), false, "the chain is not the full smoke");
  assert.equal(durationsFrom([lanes]).get(CHAIN.name), 44, "a schema 2 chain ran under the full smoke's name");
});

test("the newest readable split reports come first", () => {
  const directory = mkdtempSync(join(tmpdir(), "split-lanes-"));
  try {
    writeFileSync(join(directory, "split-smoke-old.json"), JSON.stringify({verdict: "old"}));
    writeFileSync(join(directory, "split-smoke-new.json"), JSON.stringify({verdict: "new"}));
    writeFileSync(join(directory, "split-smoke-torn.json"), "{");
    writeFileSync(join(directory, "split-smoke-new.steps.jsonl"), "{}\n");
    writeFileSync(join(directory, "rest-smoke-x.json"), JSON.stringify({verdict: "rest"}));
    utimesSync(join(directory, "split-smoke-old.json"), 1000, 1000);
    assert.deepEqual(latestReports([directory, join(directory, "absent")]).map(report => report.verdict), ["new", "old"]);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test("two units that share state are never in flight together", () => {
  const unit = (name, seconds, shares = null) => ({ kind: "journey", name, seconds, shares, identity: false });
  const queue = createQueue([unit("filters", 30, "preferences"), unit("kept", 20, "preferences"), unit("other", 10)]);
  const general = { name: "general-1", identity: false };
  const first = queue.next(general);
  assert.equal(first.name, "filters");
  // The other preference journey waits; a unit sharing nothing is still handed out.
  assert.equal(queue.next(general).name, "other");
  assert.equal(queue.next(general), undefined);
  queue.finish(first);
  assert.equal(queue.next(general).name, "kept");
});

test("the plan carries each journey's shared state to its unit", () => {
  const layout = plan({ lanes: 2, durations, stamp: 1 });
  for (const entry of JOURNEYS)
    assert.equal(layout.units.find(unit => unit.name === entry.key).shares, entry.shares ?? null, entry.key);
});


test("browser variants retain shared-state and authentication contracts with separate measurements", () => {
  const layout = plan({ lanes: 2, durations });
  for (const key of CROSS_BROWSER_JOURNEYS) {
    const base = JOURNEYS.find(entry => entry.key === key);
    assert.ok(base, key);
    for (const browser of ["firefox", "webkit"]) {
      const unit = layout.units.find(entry => entry.name === `${key}@${browser}`);
      assert.equal(unit.journeyKey, key);
      assert.equal(unit.browser, browser);
      assert.equal(unit.shares, base.shares ?? null);
      assert.equal(unit.authentication, base.authentication ?? null);
      assert.equal(unit.seconds, durations.get(key));
      assert.equal(unit.measured, false);
      assert.equal(unit.deadlineSeconds, DEADLINE.capSeconds);
      assert.equal(execution(unit.name).entry, base);
    }
  }
  const queue = createQueue(layout.units.filter(unit => unit.journeyKey === "metadata-return-context"));
  const first = queue.next();
  assert.equal(queue.next(), undefined, "engine variants cannot race the same account preference");
  queue.finish(first);
  assert.ok(queue.next());
});

test("engine selection rejects misspellings before starting the stack and preserves canonical inventory keys", () => {
  assert.equal(execution("account-switch", "webkit").name, "account-switch@webkit");
  assert.equal(execution("account-switch@firefox").entry.key, "account-switch");
  for (const name of ["missing", "account-switch@safari", "account-switch@webkit@other"])
    assert.throws(() => execution(name));
});

test("engine reuse avoids launches without stranding other work or bypassing shared-state locks", () => {
  const units = [
    { ...unit('long', 30), browser: 'chromium' },
    { ...unit('first', 20), browser: 'firefox', shares: 'preferences' },
    { ...unit('second', 10), browser: 'firefox', shares: 'preferences' },
  ];
  const queue = createQueue(units);
  const first = queue.next('firefox');
  assert.equal(first.name, 'first');
  assert.equal(queue.next('firefox').name, 'long', 'busy shared state cannot be bypassed');
  queue.finish(first);
  assert.equal(queue.next('webkit').name, 'second', 'a lane takes another engine when its own has no work');
  const seeded = createQueue(units.map((entry, shuffleRank) => ({ ...entry, shuffleRank })));
  assert.equal(seeded.next('firefox').name, 'long', 'a seeded independence run keeps its requested order');
});
