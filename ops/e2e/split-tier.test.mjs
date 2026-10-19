import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {plan} from "./split-lanes.mjs";
import {acquire, holderOf, lockPath, release, running} from "./split-lock.mjs";
import {LOCK_REFUSED, SCHEMA_VERSION, TIMED_OUT, runTier} from "./split-runner.mjs";
import {USER_SERVER} from "./rest/lib.mjs";

// The runner is driven here with stand-ins for the journey runner and the scripts, in a scratch
// directory, so that the queue, the deadlines, the sweep and the lock are exercised without a stack.
// A stand-in journey's key says what it does: `<label>-pass-<ms>`, `<label>-fail-<ms>` or
// `<label>-hang`. A hanging one starts a "browser" in a process group of its own, as Playwright does,
// so the test can see that the kill reaches it.
const here = dirname(fileURLToPath(import.meta.url));
const steps = pathToFileURL(join(here, "split-steps.mjs")).href;
const userState = pathToFileURL(join(here, "user-state.mjs")).href;
let scratch;

const WORKER = `
import {appendFileSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {enter, noteFixture, record} from ${JSON.stringify(steps)};
const lane = process.env.CEDAR_SPLIT_SCRIPT, log = process.env.STANDIN_LOG;
const note = fields => appendFileSync(log, JSON.stringify({lane, at: Date.now(), ...fields}) + "\\n");
const root = process.argv.find(a => a.startsWith("--root=")).slice(7);
let stopping = false, current = null, checks = 0;
process.on("SIGTERM", () => {
  stopping = true;
  note({event: "sigterm", current});
  if (current) process.send({type: "result", key: current, ok: false, checks: 0, message: "browser closed", cleanupErrors: []}, () => finish(1));
  else finish(1);
});
function finish(code) {
  record({event: "step", step: "cleanup"});
  record({event: "end", step: "complete", checks});
  note({event: "teardown", root});
  process.disconnect?.();
  process.exit(code);
}
enter("login");
noteFixture({collection: "folders", id: "folder:" + root});
process.on("message", async message => {
  if (message.type === "stop") return finish(0);
  if (message.type !== "run") return;
  const [, mode, ms] = message.key.split("-");
  current = message.key;
  enter(message.key);
  note({event: "start", key: message.key});
  noteFixture({collection: "templates", id: "template:" + message.key});
  if (mode === "hang") {
    const browser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached: true, stdio: "ignore"});
    writeFileSync(process.env.STANDIN_DIR + "/browser-" + message.key + ".pid", String(browser.pid));
    return;
  }
  await new Promise(resolve => setTimeout(resolve, Number(ms)));
  if (stopping) return;
  current = null;
  note({event: "end", key: message.key});
  if (mode === "pass") checks++;
  record({event: "done", step: message.key, checks: mode === "pass" ? 1 : 0});
  if (mode === "fail") record({event: "fail", step: message.key, message: "stand-in failure"});
  process.send({type: "result", key: message.key, ok: mode === "pass", checks: 1, seconds: Number(ms) / 1000,
    cleanupSeconds: 0, ...(mode === "pass" ? {} : {message: "stand-in failure"}), cleanupErrors: []});
});
process.send({type: "ready", root, folderId: "folder:" + root});
`;

// A stand-in script: `script.mjs <mode> <ms>`, where the mode is pass, fail, hang, chain,
// restore-pass or restore-hang. A restore- script stands for the profile smoke: it notes a restore
// entry for an API key named after itself on the first user's account, which the test's stand-in
// account holds. restore-pass then notes that it put the key back and exits, and restore-hang hangs.
const SCRIPT = `
import {appendFileSync} from "node:fs";
import {enter, noteFixture, noteRestore, noteRestored, record} from ${JSON.stringify(steps)};
const [mode, ms] = process.argv.slice(2), name = process.env.CEDAR_SPLIT_SCRIPT;
enter(mode === "chain" ? "login" : "run");
noteFixture({collection: "folders", id: "folder:" + name});
if (mode.startsWith("restore-")) {
  const {apiKeyRestore} = await import(${JSON.stringify(userState)});
  const entry = apiKeyRestore({as: "user1", userPath: "/users/u1", description: name});
  noteRestore(entry);
  if (mode === "restore-pass") noteRestored(entry);
}
// Announced only once everything above is recorded, so a test that signals the run as soon as the
// script appears finds its fixture already noted, however slowly the machine is running.
appendFileSync(process.env.STANDIN_LOG, JSON.stringify({lane: name, event: "script", mode, at: Date.now()}) + "\\n");
if (mode === "chain") setTimeout(() => enter("create-template"), 50);
if (mode === "timeout-error") record({event: "fail", step: "run", message: "Timeout 25000ms waiting for live search"});
if (mode.endsWith("hang")) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(mode === "fail" || mode === "timeout-error" ? 1 : 0), Number(ms));
`;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "split-tier-test-"));
  writeFileSync(join(scratch, "worker.mjs"), WORKER);
  writeFileSync(join(scratch, "script.mjs"), SCRIPT);
});
after(() => rmSync(scratch, {recursive: true, force: true}));

let runs = 0;
/** A fresh directory with its own log, report and lock for one run. */
function workspace() {
  const directory = join(scratch, "run-" + ++runs);
  mkdirSync(directory);
  process.env.STANDIN_LOG = join(directory, "log.jsonl");
  process.env.STANDIN_DIR = directory;
  writeFileSync(process.env.STANDIN_LOG, "");
  return {
    directory,
    report: join(directory, "split-smoke.json"),
    lock: join(directory, "locks", "split-tier.lock"),
    log: () => readFileSync(process.env.STANDIN_LOG, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

/** A plan over stand-in journeys and scripts, whose chain and scripts run script.mjs. */
function standInPlan({journeys, scripts = [], durations = {}, lanes = 2, deadline, chainMs = 100}) {
  const layout = plan({
    lanes,
    journeys: journeys.map(([key, identity]) => ({key, authentication: Boolean(identity)})),
    scripts: scripts.map(([name, mode, ms, identity]) => ({name, args: ["script.mjs", mode, String(ms)], ...(identity ? {identity: "stand-in"} : {})})),
    durations: new Map(Object.entries(durations)),
    deadline: deadline ?? {factor: 3, marginSeconds: 2, floorSeconds: 2, capSeconds: 20},
    stamp: 1,
  });
  if (layout.sequential) layout.lanes[0].processes[0].args = ["script.mjs", "pass", String(chainMs)];
  else layout.chain.args = ["script.mjs", "chain", String(chainMs)];
  return layout;
}

const quiet = {write() {}};
function sweeper() {
  const calls = [];
  const sweep = async ({root, fixtures}) => {
    calls.push({root, fixtures: fixtures.map(entry => entry.id)});
    return {root: root ? {id: root.id, how: "recursive", deleted: {folder: 1}} : null,
      removed: fixtures.map(entry => ({collection: entry.collection, id: entry.id, as: "user1"})),
      alreadyGone: [], failed: [], secondUser: [], seconds: 0};
  };
  return {calls, sweep};
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the lanes share the queue: every unit runs once, identity units only on the identity lane and never two at once", async () => {
  const run = workspace();
  const journeys = [["a-pass-300"], ["b-pass-250"], ["c-pass-200"], ["d-pass-150"], ["e-pass-100"], ["f-pass-100"],
    ["g-pass-80"], ["h-pass-60"], ["i-pass-120", true], ["j-pass-90", true]];
  const durations = Object.fromEntries(journeys.map(([key]) => [key, Number(key.split("-")[2]) / 1000]));
  const layout = standInPlan({journeys, scripts: [["s1", "pass", 50], ["s2", "pass", 40, true]], durations,
    chainMs: 400});
  const {exitCode, report} = await runTier({layout, reportPath: run.report, cwd: scratch, workerScript: "worker.mjs",
    lockFile: run.lock, out: quiet, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50});
  assert.equal(exitCode, 0, JSON.stringify(report.failures));
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.verdict, "PASS");
  const ran = report.units.map(unit => unit.name);
  assert.deepEqual([...ran].sort(), ["modern-workspace-chain", "s1", "s2", ...journeys.map(([key]) => key)].sort());
  for (const unit of report.units.filter(entry => ["i-pass-120", "j-pass-90", "s2"].includes(entry.name)))
    assert.equal(unit.lane, "identity", unit.name);
  const identityRuns = run.log().filter(entry => entry.event === "start" && /^[ij]-/.test(entry.key));
  const identityEnds = run.log().filter(entry => entry.event === "end" && /^[ij]-/.test(entry.key));
  assert.ok(identityEnds[0].at <= identityRuns[1].at, "the second identity journey starts after the first ends");
  // The core lane joins the queue once its chain is done.
  const core = report.lanes.find(lane => lane.name === "core");
  assert.equal(core.units[0].name, "modern-workspace-chain");
  assert.ok(core.units.length > 1, "the core lane ran queued units after its chain");
  for (const lane of report.lanes) {
    assert.equal(typeof lane.busySeconds, "number");
    assert.equal(typeof lane.idleSeconds, "number");
    assert.equal(lane.timeout, null);
    assert.deepEqual(lane.notRun, []);
  }
  assert.equal(report.checks, journeys.length);
  assert.equal(report.queue.dynamic, true);
  assert.deepEqual(report.lock.holder.pid, process.pid);
  assert.equal(existsSync(run.lock), false, "the lock is released at the end");
  // Schema 2's fields are all still there.
  for (const field of ["verdict", "startedAt", "finishedAt", "durationSeconds", "sequential", "generalLanes", "machine",
    "failingScript", "failingStep", "failure", "failures", "checks", "lanes", "scripts", "notRun", "steps", "inventory", "ends"])
    assert.ok(field in report, field);
  for (const field of ["name", "root", "keys", "scripts", "plannedSeconds", "startedAfterSeconds", "seconds", "exitCode",
    "failingScript", "failingStep", "failure", "notRun"])
    assert.ok(field in report.lanes[0], field);
});

test("a journey past its deadline is killed with its browser and swept, and the other lanes run the rest", async () => {
  const run = workspace();
  const journeys = [["a-hang"], ["b-pass-300"], ["c-pass-200"], ["d-pass-150"], ["e-pass-100"], ["f-pass-50"]];
  const durations = {"a-hang": 0.4, "b-pass-300": 0.3, "c-pass-200": 0.2, "d-pass-150": 0.15, "e-pass-100": 0.1, "f-pass-50": 0.05};
  const {calls, sweep} = sweeper();
  const layout = standInPlan({journeys, durations, deadline: {factor: 1, marginSeconds: 0, floorSeconds: 1, capSeconds: 10}});
  const began = Date.now();
  const {exitCode, report} = await runTier({layout, reportPath: run.report, cwd: scratch, workerScript: "worker.mjs",
    lockFile: run.lock, sweep, out: quiet, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50});
  assert.ok(Date.now() - began < 8000, "the hung journey did not hang the run");
  assert.equal(exitCode, TIMED_OUT);
  assert.equal(report.verdict, "FAIL");
  const [timeout] = report.timeouts;
  assert.equal(timeout.unit, "a-hang");
  assert.ok(timeout.elapsedSeconds >= 1 && timeout.elapsedSeconds < 3, String(timeout.elapsedSeconds));
  assert.equal(timeout.deadlineSeconds, 1);
  const lane = report.lanes.find(entry => entry.name === timeout.lane);
  assert.deepEqual(lane.timeout, timeout);
  assert.equal(lane.exitCode, TIMED_OUT);
  assert.equal(lane.units.at(-1).name, "a-hang", "a lane that timed out takes no further units");
  assert.equal(lane.units.at(-1).outcome, "timeout");
  const failure = report.failures.find(entry => entry.unit === "a-hang");
  assert.match(failure.message, /a-hang timed out on .* after \d+(\.\d)? s, past its deadline of 1 s/);
  assert.deepEqual(failure.timeout, timeout);
  // The root and what the journey recorded are swept, and nothing it did not create.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].root, {id: "folder:" + lane.root, name: lane.root});
  assert.deepEqual(calls[0].fixtures, ["template:a-hang"]);
  assert.equal(lane.sweep.removed.length, 1);
  assert.equal(report.sweeps.length, 1);
  // Every other unit still ran, on the other lanes.
  assert.deepEqual(report.units.filter(unit => unit.outcome === "pass").map(unit => unit.name).sort(),
    ["b-pass-300", "c-pass-200", "d-pass-150", "e-pass-100", "f-pass-50", "modern-workspace-chain"]);
  assert.deepEqual(report.notRun, []);
  const browser = Number(readFileSync(join(run.directory, "browser-a-hang.pid"), "utf8"));
  assert.equal(alive(browser), false, "the hung journey's browser was killed with it");
  assert.equal(report.unitTimeout.capSeconds, 10);
});

test("a script past its deadline is killed and its recorded fixtures swept; sequential runs stop there", async () => {
  const run = workspace();
  const {calls, sweep} = sweeper();
  const layout = standInPlan({journeys: [["a-pass-10"]], scripts: [["slow", "hang", 0], ["after", "pass", 10]], lanes: 1,
    durations: {slow: 0.1, after: 0.01, "modern-workspace": 0.05},
    deadline: {factor: 1, marginSeconds: 0, floorSeconds: 1, capSeconds: 10}});
  const {exitCode, report} = await runTier({layout, reportPath: run.report, cwd: scratch, lockFile: run.lock, sweep,
    out: quiet, err: quiet, sampleMs: 50});
  assert.equal(exitCode, TIMED_OUT);
  assert.equal(report.sequential, true);
  assert.deepEqual(report.units.map(unit => [unit.name, unit.outcome]), [["modern-workspace", "pass"], ["slow", "timeout"]]);
  assert.deepEqual(report.notRun, ["after"]);
  assert.deepEqual(calls, [{root: null, fixtures: ["folder:slow"]}]);
  assert.equal(report.failingScript, "slow");
  assert.equal(report.lanes[0].timeout.unit, "slow");
});

test("a failing unit stops its lane, and the units it would have taken go to the others", async () => {
  const run = workspace();
  const journeys = [["a-fail-50"], ["b-pass-100"], ["c-pass-100"], ["d-pass-100"], ["e-pass-100"]];
  const durations = {"a-fail-50": 0.5, "b-pass-100": 0.1, "c-pass-100": 0.1, "d-pass-100": 0.1, "e-pass-100": 0.1};
  const {exitCode, report} = await runTier({layout: standInPlan({journeys, durations}), reportPath: run.report,
    cwd: scratch, workerScript: "worker.mjs", lockFile: run.lock, out: quiet, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50});
  assert.equal(exitCode, 1);
  const failed = report.lanes.find(lane => lane.failingStep === "a-fail-50");
  assert.deepEqual(failed.units.filter(unit => unit.kind === "journey").map(unit => unit.name), ["a-fail-50"],
    "the lane took the longest journey, failed it and took no other");
  assert.equal(report.failures.length, 1);
  assert.deepEqual(report.notRun, []);
  assert.equal(report.units.filter(unit => unit.outcome === "pass").length, 5, "four journeys and the chain");
});

test("a script failure retains its reported cause on the unit used for reliability history", async () => {
  const run = workspace();
  const {exitCode, report} = await runTier({
    layout: standInPlan({journeys: [], scripts: [["live-search", "timeout-error", 10]]}),
    reportPath: run.report, cwd: scratch, workerScript: "worker.mjs", lockFile: run.lock,
    out: quiet, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50,
  });
  assert.equal(exitCode, 1);
  const unit = report.units.find(unit => unit.name === "live-search");
  assert.equal(unit.message, "Timeout 25000ms waiting for live search");
  assert.equal(unit.failureCategory, "timeout");
});

test("a run refuses at once while another holds the lock, and replaces a lock whose holder is gone", async () => {
  const run = workspace();
  // Held: this process is alive and started before the lock was written.
  const holder = {...holderOf(["node", "split-tier.mjs", "--report=elsewhere"]), startedAt: new Date().toISOString()};
  assert.equal(acquire(run.lock, holder).acquired, true);
  const layout = standInPlan({journeys: [["a-pass-10"]]});
  const lines = [];
  const began = Date.now();
  const refused = await runTier({layout, reportPath: run.report, cwd: scratch, workerScript: "worker.mjs",
    lockFile: run.lock, out: quiet, err: {write: line => lines.push(line)}});
  assert.ok(Date.now() - began < 1000, "the refusal is immediate");
  assert.equal(refused.exitCode, LOCK_REFUSED);
  assert.equal(refused.report, null);
  assert.equal(existsSync(run.report), false, "a refused run writes no report");
  assert.match(lines.join(""), new RegExp(`PID ${process.pid}, started ${holder.startedAt}.*command: node split-tier.mjs --report=elsewhere`));
  assert.equal(release(run.lock, holder), true);

  // Stale: the holder's PID no longer answers.
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise(resolve => gone.on("exit", resolve));
  writeFileSync(run.lock, JSON.stringify({pid: gone.pid, startedAt: new Date(Date.now() - 60000).toISOString(),
    command: "node split-tier.mjs", cwd: "/", host: "here"}));
  const out = [];
  const replaced = await runTier({layout, reportPath: run.report, cwd: scratch, workerScript: "worker.mjs",
    lockFile: run.lock, out: {write: line => out.push(line)}, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50});
  assert.equal(replaced.exitCode, 0);
  assert.equal(replaced.report.lock.replaced.pid, gone.pid);
  assert.match(out.join(""), new RegExp(`replaced a stale lock left by PID ${gone.pid}`));
  assert.equal(existsSync(run.lock), false);
});

test("a PID that now belongs to a process younger than the lock is a stale holder", () => {
  assert.equal(running({pid: process.pid, startedAt: new Date(Date.now() - 86400000 * 365).toISOString()}), false);
  assert.equal(running({pid: process.pid, startedAt: new Date().toISOString()}), true);
  assert.equal(running({pid: 0}), false);
});

test("the lock lives in $CEDAR_HOME/.cedar/locks, or beside the checkout without CEDAR_HOME", () => {
  assert.equal(lockPath(here, {CEDAR_HOME: "/x/home"}), "/x/home/.cedar/locks/split-tier.lock");
  const checkout = join(scratch, "home", "cedar-development", "ops", "e2e");
  mkdirSync(checkout, {recursive: true});
  assert.equal(lockPath(join(checkout), {}), join(scratch, "home", ".cedar", "locks", "split-tier.lock"));
});

/**
 * Runs the runner in a process of its own, as split-tier.mjs does, so that a real signal can reach
 * it. `layoutSource` is JavaScript that sets `layout` from `plan`, and `ready` says when to signal.
 */
async function interrupt(run, layoutSource, ready) {
  const driver = join(run.directory, "driver.mjs");
  writeFileSync(driver, `
import {appendFileSync} from "node:fs";
import {plan} from ${JSON.stringify(pathToFileURL(join(here, "split-lanes.mjs")).href)};
import {runTier} from ${JSON.stringify(pathToFileURL(join(here, "split-runner.mjs")).href)};
let layout;
${layoutSource}
const sweep = async ({root, fixtures}) => {
  appendFileSync(${JSON.stringify(join(run.directory, "sweeps.jsonl"))}, JSON.stringify({root, fixtures: fixtures.map(f => f.id)}) + "\\n");
  return {removed: [], alreadyGone: [], failed: [], secondUser: []};
};
const outcome = await runTier({layout, reportPath: ${JSON.stringify(run.report)}, cwd: ${JSON.stringify(scratch)},
  workerScript: "worker.mjs", lockFile: ${JSON.stringify(run.lock)}, sweep, out: {write() {}}, err: {write() {}},
  coreLeadLimitMs: 2000, sampleMs: 50});
process.exitCode = outcome.exitCode;
`);
  const child = spawn(process.execPath, [driver], {cwd: scratch, env: process.env, stdio: "ignore"});
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
  for (let waited = 0; !ready(run.log()); waited += 50) {
    assert.ok(waited < 5000, "the stand-in never started");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(existsSync(run.lock), true, "the run holds the lock while it runs");
  child.kill("SIGTERM");
  const code = await exited;
  const sweeps = existsSync(join(run.directory, "sweeps.jsonl"))
    ? readFileSync(join(run.directory, "sweeps.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  return {code, report: JSON.parse(readFileSync(run.report, "utf8")), sweeps};
}

test("a signal stops a sequential run, a killed script is swept, and the lock is released", async () => {
  const run = workspace();
  const {code, report, sweeps} = await interrupt(run, `
layout = plan({lanes: 1, journeys: [{key: "x-pass-1", authentication: false}], stamp: 1,
  scripts: [{name: "long", args: ["script.mjs", "hang", "0"]}], durations: new Map([["long", 5], ["modern-workspace", 0.1]]),
  deadline: {factor: 3, marginSeconds: 2, floorSeconds: 2, capSeconds: 60}});
layout.lanes[0].processes[0].args = ["script.mjs", "pass", "10"];`,
  log => log.some(entry => entry.mode === "hang"));
  assert.equal(code, 130);
  assert.equal(report.verdict, "INTERRUPTED");
  assert.equal(report.interrupted, "SIGTERM");
  assert.deepEqual(report.units.map(unit => [unit.name, unit.outcome]), [["modern-workspace", "pass"], ["long", "interrupted"]]);
  assert.deepEqual(sweeps, [{root: null, fixtures: ["folder:long"]}], "the script died before its own cleanup");
  assert.equal(existsSync(run.lock), false, "the lock is released after a signal");
});

test("a signal reaches a journey runner, which ends its journey and removes its root itself", async () => {
  const run = workspace();
  const {code, report, sweeps} = await interrupt(run, `
layout = plan({lanes: 2, journeys: [{key: "a-pass-4000", authentication: false}], scripts: [], stamp: 1,
  durations: new Map([["a-pass-4000", 4]]), deadline: {factor: 3, marginSeconds: 2, floorSeconds: 2, capSeconds: 60}});
layout.chain.args = ["script.mjs", "chain", "10"];`,
  log => log.some(entry => entry.event === "start"));
  assert.equal(code, 130);
  assert.equal(report.verdict, "INTERRUPTED");
  assert.ok(run.log().some(entry => entry.event === "sigterm" && entry.current === "a-pass-4000"));
  assert.ok(run.log().some(entry => entry.event === "teardown"), "the runner removed its root");
  const unit = report.units.find(entry => entry.name === "a-pass-4000");
  assert.equal(unit.outcome, "interrupted");
  assert.deepEqual(sweeps, [], "a runner that cleaned up after itself needs no sweep");
  assert.equal(existsSync(run.lock), false);
});

/**
 * A stand-in for the resource server: items with an owner and a parent folder. The owner of a tree
 * may delete it recursively unless it holds something another user owns. A non-owner is refused, and
 * a folder that still holds something cannot be deleted.
 *
 * `accounts` stand in for the user server, by account path: each has an owner and its API keys, or a
 * status it answers every request with. Only an account's owner may read it or delete its keys.
 */
function restStandIn(items, {accounts = {}} = {}) {
  const store = new Map(items.map(item => [item.id, {...item}]));
  const userOf = {u1: "user1", u2: "user2"};
  const under = id => [...store.values()].filter(item => item.parent === id);
  const treeOf = id => under(id).flatMap(item => item.collection === "folders" ? [item, ...treeOf(item.id)] : [item]);
  const kinds = {folders: "folder", templates: "template", "template-instances": "instance", "template-fields": "field"};
  const calls = [];
  const accountStore = new Map(Object.entries(accounts).map(([path, account]) =>
    [path, {...account, apiKeys: [...(account.apiKeys ?? [])]}]));
  const account = (auth, method, path, opts) => {
    assert.equal(opts?.base, USER_SERVER, `${method} ${path} goes to the user server`);
    const [, userPath, keyId] = /^(\/users\/[^/]+)(?:\/api-keys\/([^/]+))?$/.exec(path);
    const stored = accountStore.get(userPath);
    if (!stored) return {status: 404};
    if (stored.status) return {status: stored.status, text: "unavailable"};
    if (stored.owner !== userOf[auth]) return {status: 403};
    if (method === "GET" && !keyId) return {status: 200, body: {apiKeys: stored.apiKeys}};
    const index = stored.apiKeys.findIndex(key => key.id === decodeURIComponent(keyId ?? ""));
    if (method !== "DELETE" || index < 0) return {status: 404};
    stored.apiKeys.splice(index, 1);
    return {status: 200, body: {apiKeys: stored.apiKeys}};
  };
  const rest = {
    users: async () => ({user1: {auth: "u1", profile: {homeFolderId: "home1"}}, user2: {auth: "u2", profile: {homeFolderId: "home2"}}}),
    call: async (auth, method, path, body, opts) => {
      calls.push(`${userOf[auth]} ${method} ${path}`);
      if (path.startsWith("/users/")) return account(auth, method, path, opts);
      const [, collection, encoded, tail] = /^\/([^/]+)\/([^/?]+)(\/[^?]*)?/.exec(path);
      const id = decodeURIComponent(encoded);
      if (tail === "/contents")
        return {status: 200, body: {totalCount: under(id).length,
          resources: under(id).map(item => ({"@id": item.id, resourceType: kinds[item.collection], "schema:name": item.name}))}};
      const item = store.get(id);
      if (!item && !id.startsWith("home")) return {status: 404};
      if (tail === "/deletion" && method === "GET")
        return item.owner !== userOf[auth] ? {status: 403}
          : {status: 200, body: {allowed: treeOf(id).every(child => child.owner === item.owner), token: "t"}};
      if (tail === "/deletion" && method === "POST") {
        const removed = [...treeOf(id), item];
        for (const child of removed) store.delete(child.id);
        return {status: 200, body: {status: "completed", deleted: {folder: removed.filter(child => child.collection === "folders").length}}};
      }
      return {status: item ? 200 : 404};
    },
    remove: async (auth, item) => {
      calls.push(`${userOf[auth]} DELETE ${item.id}`);
      const stored = store.get(item.id);
      if (!stored) return {status: 404};
      if (stored.owner !== userOf[auth]) return {status: 403};
      if (under(item.id).length) return {status: 400, text: "nonEmptyFolder"};
      store.delete(item.id);
      return {status: 204};
    },
  };
  return {rest, store, accounts: accountStore, calls};
}

test("a sweep removes the root, the second user's fixtures named after it, and what the ledger recorded", async () => {
  const {sweep} = await import("./split-sweep.mjs");
  const {rest, store, calls} = restStandIn([
    {id: "root", collection: "folders", owner: "user1", parent: "home1", name: "Focused journey 1 general-1"},
    {id: "journey", collection: "folders", owner: "user1", parent: "root", name: "Focused journey 1 general-1 x"},
    {id: "t1", collection: "templates", owner: "user1", parent: "journey"},
    {id: "transferred", collection: "templates", owner: "user2", parent: "journey"},
    {id: "theirs", collection: "folders", owner: "user2", parent: "home2", name: "Focused journey 1 general-1 partial version owner folder"},
    {id: "t2", collection: "templates", owner: "user2", parent: "theirs"},
    {id: "unrelated", collection: "folders", owner: "user2", parent: "home2", name: "Focused journey 1 general-10 other"},
    {id: "elsewhere", collection: "folders", owner: "user1", parent: "home1", name: "Elsewhere"},
    {id: "field", collection: "template-fields", owner: "user1", parent: "elsewhere"},
  ]);
  const result = await sweep({rest, root: {id: "root", name: "Focused journey 1 general-1"}, fixtures: [
    {collection: "folders", id: "root"}, {collection: "folders", id: "journey"}, {collection: "templates", id: "t1"},
    {collection: "folders", id: "theirs"}, {collection: "folders", id: "elsewhere"}, {collection: "groups", id: "g", base: "group"},
  ]});
  assert.equal(result.root.how, "item by item", "a tree holding another user's template is not deleted recursively");
  assert.deepEqual(result.removed.find(entry => entry.id === "transferred"), {collection: "templates", id: "transferred", as: "user2"});
  assert.deepEqual(result.secondUser.map(entry => [entry.id, entry.how]), [["theirs", "recursive"]]);
  assert.ok(store.has("unrelated"), "another lane's root shares only a prefix of the name and is left alone");
  assert.equal(store.has("elsewhere") || store.has("field"), false, "a recorded folder that still held something goes as a tree");
  assert.deepEqual([...store.keys()], ["unrelated"]);
  assert.deepEqual(result.failed, []);
  assert.ok(result.alreadyGone.some(entry => entry.id === "g" && entry.base === "group"), "a group goes to the group server");
  assert.ok(calls.indexOf("user1 GET /folders/root/deletion") < calls.indexOf("user2 GET /folders/theirs/deletion"));
});

test("a killed script's API key is removed by its sweep, and a script that removed its own is not swept", async () => {
  const run = workspace();
  const {sweep} = await import("./split-sweep.mjs");
  const {rest, accounts, calls} = restStandIn([], {accounts: {"/users/u1": {owner: "user1", apiKeys: [
    {id: "k-killed", description: "account-killed"}, {id: "k-other", description: "another session's key"}]}}});
  const swept = [];
  const layout = standInPlan({journeys: [["a-pass-10"]], lanes: 1,
    scripts: [["account-finished", "restore-pass", 10], ["account-killed", "restore-hang", 0]],
    durations: {"modern-workspace": 0.05, "account-finished": 0.01, "account-killed": 0.1},
    deadline: {factor: 1, marginSeconds: 0, floorSeconds: 1, capSeconds: 10}});
  const lines = [];
  const {exitCode, report} = await runTier({layout, reportPath: run.report, cwd: scratch, lockFile: run.lock,
    sweep: args => {
      swept.push(args);
      return sweep({...args, rest});
    },
    out: {write: line => lines.push(line)}, err: quiet, sampleMs: 50});
  assert.equal(exitCode, TIMED_OUT);
  assert.deepEqual(report.units.map(unit => [unit.name, unit.outcome]),
    [["modern-workspace", "pass"], ["account-finished", "pass"], ["account-killed", "timeout"]]);
  // The finished script is never swept. The killed one is, with its restore entry and its fixture.
  assert.deepEqual(swept.map(args => [args.fixtures.map(entry => entry.id), args.restores.map(entry => entry.key)]),
    [[["folder:account-killed"], ["api-key /users/u1 account-killed"]]]);
  assert.deepEqual(calls.filter(call => call.includes("/users/")),
    ["user1 GET /users/u1", "user1 DELETE /users/u1/api-keys/k-killed"]);
  assert.deepEqual(accounts.get("/users/u1").apiKeys.map(key => key.id), ["k-other"], "another session's key stays");
  assert.equal(report.sweeps.length, 1);
  const [entry] = report.sweeps;
  assert.equal(entry.unit, "account-killed");
  assert.equal(entry.recorded, 1, "the restore entry is not counted as a fixture");
  assert.deepEqual(entry.restored, [{restore: "api-key", key: "api-key /users/u1 account-killed",
    label: 'API key "account-killed" on user1\'s account', as: "user1", changed: 1}]);
  assert.deepEqual([entry.alreadyRestored, entry.notRestored], [[], []]);
  assert.match(lines.join(""), /sweep of account-killed: .*restored API key "account-killed" on user1's account/);
});

test("a sweep applies only the restore entries a process left unmarked, and reports each outcome", async () => {
  const {sweep, summarize} = await import("./split-sweep.mjs");
  const {apiKeyRestore} = await import("./user-state.mjs");
  const {rest, accounts, calls} = restStandIn([], {accounts: {
    "/users/u1": {owner: "user1", apiKeys: [{id: "k-left", description: "killed"}, {id: "k-other", description: "kept"}]},
    "/users/u2": {owner: "user2", apiKeys: []},
    "/users/u3": {owner: "user1", status: 503},
  }});
  // One process ran these in turn, as the sequential tier's full smoke runs its journeys. The first
  // put its key back itself; the process was killed during the second, after it had added its key;
  // the third never added one; and the fourth's account cannot be read.
  const finished = apiKeyRestore({as: "user1", userPath: "/users/u1", description: "finished"});
  const killed = apiKeyRestore({as: "user1", userPath: "/users/u1", description: "killed"});
  const neverMade = apiKeyRestore({as: "user2", userPath: "/users/u2", description: "never made"});
  const unreadable = apiKeyRestore({as: "user1", userPath: "/users/u3", description: "unreadable"});
  const result = await sweep({rest, restores: [finished, {restored: finished.key}, killed, neverMade, unreadable]});
  // Nothing is read or written for the entry the process marked as put back.
  assert.deepEqual(calls, ["user1 GET /users/u1", "user1 DELETE /users/u1/api-keys/k-left", "user2 GET /users/u2",
    "user1 GET /users/u3"]);
  assert.deepEqual(accounts.get("/users/u1").apiKeys.map(key => key.id), ["k-other"]);
  assert.deepEqual(result.restored.map(entry => [entry.key, entry.changed]), [[killed.key, 1]]);
  assert.deepEqual(result.alreadyRestored.map(entry => [entry.key, entry.as]), [[neverMade.key, "user2"]]);
  assert.deepEqual(result.notRestored.map(entry => [entry.key, entry.status]), [[unreadable.key, 503]]);
  assert.deepEqual([result.removed, result.failed], [[], []]);
  const line = summarize(result);
  assert.match(line, /restored API key "killed" on user1's account/);
  assert.match(line, /already as it was: API key "never made" on user2's account/);
  assert.match(line, /not restored: API key "unreadable" on user1's account \(503\)/);
  assert.doesNotMatch(line, /finished/);
});

test("recording inventory cannot satisfy acceptance even when every unit passes", async () => {
  const run = workspace();
  const layout = standInPlan({journeys: [["a-pass-20"]]});
  const {exitCode, report} = await runTier({layout, reportPath: run.report, cwd: scratch, workerScript: "worker.mjs",
    lockFile: run.lock, environment: {CEDAR_JOURNEY_RECORD_INVENTORY: run.directory},
    out: quiet, err: quiet, coreLeadLimitMs: 2000, sampleMs: 50});
  assert.equal(report.inventoryMode, "candidate");
  assert.equal(report.verdict, "CANDIDATE");
  assert.equal(exitCode, 1);
  assert.ok(report.units.every(unit => unit.outcome === "pass"));
});
