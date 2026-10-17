import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {JOURNEYS} from "./journey-registry.mjs";
import {CORE, DEFAULT_LANES, MAX_LANES, SCRIPTS, durationsFrom, latestReports, plan} from "./split-lanes.mjs";

// The split tier runs whatever the plan says. A journey the plan drops is never run, one it schedules
// twice collides with itself on the names it creates, and an identity journey outside the identity
// lane signs in alongside the others.
const keys = JOURNEYS.map(entry => entry.key);
const identityKeys = JOURNEYS.filter(entry => entry.signsInAsAnotherUser).map(entry => entry.key);
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
});

for (const lanes of [2, 3, MAX_LANES]) {
  test(`${lanes} general lanes run every journey and script exactly once, in its own lane`, () => {
    const layout = plan({lanes, durations, stamp: 1760000000000});
    assert.equal(layout.sequential, false);
    assert.deepEqual(layout.lanes.map(lane => lane.name),
      ["core", "identity", ...Array.from({length: lanes}, (_, index) => `general-${index + 1}`)]);
    const [core, identity, ...general] = layout.lanes;
    assert.deepEqual(core.processes, [{name: CORE.name, args: [...CORE.args, "--chain-only"]}]);
    assert.deepEqual([...identity.keys].sort(), [...identityKeys].sort());
    assert.deepEqual(identity.scripts, identityScripts);
    const ran = layout.lanes.flatMap(lane => lane.processes.flatMap(process =>
      process.args[0] === "focused-journey-smoke.mjs" ? process.args.slice(2) : []));
    assert.deepEqual([...ran].sort(), [...keys].sort());
    const scripts = layout.lanes.flatMap(lane => lane.scripts);
    assert.deepEqual([...scripts].sort(), [CORE.name, ...SCRIPTS.map(script => script.name)].sort());
    for (const lane of general)
      assert.ok(lane.keys.every(key => !identityKeys.includes(key)) && lane.scripts.every(name => !identityScripts.includes(name)));
    const names = layout.lanes.flatMap(lane => lane.processes.map(process => process.name));
    assert.equal(new Set(names).size, names.length, "every process has a name of its own in the report");
  });
}

test("each lane works under a root of its own that sorts after the core lane's fixtures", () => {
  const layout = plan({lanes: DEFAULT_LANES, durations, stamp: 1760000000000});
  const roots = layout.lanes.filter(lane => lane.keys.length).map(lane => lane.root);
  assert.equal(new Set(roots).size, roots.length);
  for (const lane of layout.lanes.filter(lane => lane.keys.length)) {
    assert.ok(lane.root.localeCompare("Angular journey template 1760000000000") > 0, lane.root);
    assert.deepEqual(lane.processes[0].args.slice(0, 2), ["focused-journey-smoke.mjs", "--root=" + lane.root]);
  }
});

test("general lanes take the longest unit first, each to the lane with the least work", () => {
  const journeys = ["a", "b", "c", "d", "e"].map(key => ({key, signsInAsAnotherUser: false}));
  const seconds = new Map([["a", 10], ["b", 9], ["c", 6], ["d", 5], ["e", 4], ["s", 8]]);
  const scripts = [{name: "s", args: ["s.mjs"]}];
  const layout = plan({lanes: 2, durations: seconds, journeys, scripts, stamp: 1});
  assert.deepEqual(layout.lanes.map(lane => lane.name), ["core", "general-1", "general-2"],
    "a lane with nothing to run is left out");
  const [, first, second] = layout.lanes;
  assert.deepEqual([first.keys, first.scripts], [["a", "c", "d"], []]);
  assert.deepEqual([second.keys, second.scripts], [["b", "e"], ["s"]]);
  assert.deepEqual([first.plannedSeconds, second.plannedSeconds], [21, 21]);
  assert.deepEqual(second.processes.map(process => process.name), ["general-2", "s"],
    "the lane's journeys run in one process, before its scripts");
});

test("a unit no report measured counts as the median of its kind", () => {
  const journeys = ["a", "b", "c", "new"].map(key => ({key, signsInAsAnotherUser: false}));
  const layout = plan({lanes: 2, durations: new Map([["a", 2], ["b", 4], ["c", 30]]), journeys, scripts: []});
  assert.deepEqual(layout.estimates.new, {seconds: 4, measured: false});
  assert.deepEqual(layout.estimates.c, {seconds: 30, measured: true});
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
    scripts: [{name: "ced-host", exitCode: 0, seconds: 16}],
  };
  const measured = durationsFrom([lanes, sequential]);
  assert.equal(measured.get("duplication"), 12);
  assert.equal(measured.get("ced-host"), 16);
  assert.equal(measured.has("older-artifacts"), false);
  assert.equal(measured.has("save-status"), false);
  assert.equal(measured.has("publication"), false);
  assert.equal(measured.has("modern-workspace"), false);
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
