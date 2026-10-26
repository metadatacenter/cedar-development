import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {JOURNEYS} from "./journey-registry.mjs";
import {
  CHAIN, CORE, DEADLINE, DEFAULT_LANES, MAX_LANES, SCRIPTS, createQueue, deadlineSeconds, durationsFrom,
  latestReports, plan, simulate,
} from "./split-lanes.mjs";

// The split tier runs whatever the plan and its queue say. A journey the plan drops is never run, one
// it hands out twice collides with itself on the names it creates, and an identity unit outside the
// identity lane signs in alongside the others.
const keys = JOURNEYS.map(entry => entry.key);
const identityKeys = JOURNEYS.filter(entry => entry.authentication).map(entry => entry.key);
const identityScripts = SCRIPTS.filter(script => script.identity).map(script => script.name);
const durations = new Map(JOURNEYS.map((entry, index) => [entry.key, 1 + (index * 7) % 23]));

test("one lane is the sequential run, in the order the tier always ran", () => {
  const layout = plan({lanes: 1, durations});
  assert.equal(layout.sequential, true);
  assert.equal(layout.lanes.length, 1);
  assert.deepEqual(layout.lanes[0].processes.map(process => process.args),
    [CORE.args, ...SCRIPTS.map(script => script.args)]);
  assert.deepEqual(layout.lanes[0].processes[0].args, ["modern-workspace-smoke.mjs"]);
  assert.deepEqual(layout.lanes[0].keys, keys);
  assert.ok(layout.lanes[0].processes.every(process => Number.isInteger(process.deadlineSeconds)));
});

for (const lanes of [2, 3, MAX_LANES]) {
  test(`${lanes} general lanes share one queue holding every journey and script once`, () => {
    const layout = plan({lanes, durations, stamp: 1760000000000});
    assert.equal(layout.sequential, false);
    assert.deepEqual(layout.lanes.map(lane => lane.name),
      ["core", "identity", ...Array.from({length: lanes}, (_, index) => `general-${index + 1}`)]);
    assert.deepEqual(layout.chain.args, [...CORE.args, "--chain-only"]);
    assert.equal(layout.chain.name, CHAIN.name);
    const queued = layout.units.map(unit => unit.name);
    assert.deepEqual([...queued].sort(), [...keys, ...SCRIPTS.map(script => script.name)].sort());
    assert.deepEqual(layout.units.filter(unit => unit.identity).map(unit => unit.name).sort(),
      [...identityKeys, ...identityScripts].sort());
    // Every unit in the projection runs exactly once, and identity units only in the identity lane.
    const projected = layout.projection.lanes.flatMap(lane => lane.units);
    assert.deepEqual([...projected].sort(), [...queued].sort());
    for (const lane of layout.projection.lanes.filter(lane => lane.name !== "identity"))
      assert.ok(lane.units.every(name => !layout.units.find(unit => unit.name === name).identity), lane.name);
  });
}

test("same-user recovery is identity work and retains its reason in the execution plan", () => {
  const layout = plan({ lanes: 2 });
  for (const name of ["draft-recovery", "uncertain-create"]) {
    const unit = layout.units.find(unit => unit.name === name);
    assert.equal(unit.identity, true);
    assert.equal(unit.authentication, "reauthenticates the first user");
    assert.ok(layout.projection.lanes.find(lane => lane.name === "identity").units.includes(name));
  }
});

test("each lane works under a root of its own that sorts after the core lane's fixtures", () => {
  const layout = plan({lanes: DEFAULT_LANES, durations, stamp: 1760000000000});
  const roots = layout.lanes.map(lane => lane.root);
  assert.equal(new Set(roots).size, roots.length);
  for (const root of roots) assert.ok(root.localeCompare("Angular journey template 1760000000000") > 0, root);
});

const unit = (name, seconds, identity = false, order = 0) => ({name, seconds, identity, order, kind: "journey", measured: true});

test("the queue hands out the longest unit a lane may run, and only the identity lane takes identity units", () => {
  const queue = createQueue([unit("short", 1, false, 0), unit("long", 9, false, 1), unit("who", 5, true, 2),
    unit("whom", 7, true, 3), unit("tie-a", 4, false, 4), unit("tie-b", 4, false, 5)]);
  const general = {name: "general-1", identity: false}, identity = {name: "identity", identity: true};
  assert.equal(queue.next(general).name, "long");
  const first = queue.next(identity);
  assert.equal(first.name, "whom", "the identity lane takes its own units first, longest first");
  assert.equal(queue.next(general).name, "tie-a", "units of the same length go in registry order");
  queue.finish(first);
  assert.equal(queue.next(identity).name, "who");
  assert.equal(queue.next(general).name, "tie-b");
  assert.equal(queue.next(identity).name, "short", "the identity lane takes general units once its own are gone");
  assert.equal(queue.next(general), undefined);
  assert.deepEqual(queue.pending(), []);
});

test("no two identity units are ever in flight, and a unit that could not start goes back in order", () => {
  const queue = createQueue([unit("a", 5, true, 0), unit("b", 4, true, 1), unit("g", 3, false, 2), unit("h", 2, false, 3)]);
  const one = {name: "identity", identity: true}, two = {name: "second", identity: true};
  const a = queue.next(one);
  assert.equal(a.name, "a");
  assert.equal(queue.next(two).name, "g", "while an identity unit is in flight, another identity lane gets a general one");
  queue.requeue(a);
  assert.deepEqual(queue.pending().map(entry => entry.name), ["a", "b", "h"]);
  assert.deepEqual(queue.inFlight().map(entry => entry.name), ["g"]);
});

test("lanes that finish their own work take a share of everyone else's", () => {
  const units = [
    ...["g1", "g2", "g3", "g4", "g5", "g6"].map((name, order) => unit(name, 10, false, order)),
    unit("i1", 5, true, 6),
  ];
  const lanes = [{name: "core", core: true}, {name: "identity", identity: true}, {name: "general-1"}];
  const projection = simulate({lanes, units, chainSeconds: 10});
  const of = name => projection.lanes.find(lane => lane.name === name);
  assert.deepEqual(of("identity").units.slice(0, 1), ["i1"]);
  assert.ok(of("core").units.length >= 1, "the core lane joins once its chain is done");
  assert.ok(of("identity").units.length >= 2, "the identity lane joins once its own units are done");
  assert.deepEqual(projection.lanes.map(lane => [lane.name, lane.units]),
    [["core", ["g3", "g6"]], ["identity", ["i1", "g2", "g5"]], ["general-1", ["g1", "g4"]]]);
  // A static split would leave the core and identity lanes idle while general-1 ran all six, for 60 s.
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
  assert.deepEqual(layout.lanes.map(lane => lane.name), ["core", "general-1", "general-2"],
    "with no identity unit there is no identity lane");
});

test("a lane setting outside 1 to 4 is refused", () => {
  for (const lanes of [0, 5, 1.5, "2"]) assert.throws(() => plan({lanes}), RangeError);
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
