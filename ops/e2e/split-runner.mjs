// Carries out a split-lanes.mjs plan: the processes, the queue the lanes share, the deadlines, the
// lock, the sweep after a kill and the report. split-tier.mjs is its command line, and the tests
// drive it with stand-in units.
//
// Each process leads a process group of its own, so an interrupt from the terminal reaches the
// runner alone, and the runner decides what each process is sent. A unit that overruns its deadline
// is killed with its browsers, and then swept: what it created is removed through REST, and what it
// changed of a test user's own account is put back. A lane that fails or overruns takes no further
// units, and the remaining units go to the other lanes.
//
// A first SIGINT, SIGTERM or SIGHUP stops every lane. A journey runner closes its browser, ends the
// journey in flight and removes its fixtures and root. Any other process dies at once, and what it
// created is swept once it has. A second signal kills every process and its browsers and forgoes
// both, so each lane's root folder may be left in the first user's home.
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createQueue } from "./split-lanes.mjs";
import { acquire, describeHolder, holderOf, release } from "./split-lock.mjs";
import { finishHistory, failureCategory } from "./journey-history.mjs";
import { summarize } from "./split-sweep.mjs";

export const SCHEMA_VERSION = 3;
/** The exit status of a run that found another run holding the lock. */
export const LOCK_REFUSED = 75;
/** The exit status a unit is given when it overran its deadline and was killed. */
export const TIMED_OUT = 124;

const seconds = (from, to = Date.now()) => Math.round((to - from) / 100) / 10;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

/** A process's descendants, deepest last. Playwright starts each browser in a process group of its own. */
function descendants(pid) {
  const children = (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "")
    .split("\n").filter(Boolean).map(Number);
  return children.flatMap(child => [child, ...descendants(child)]);
}

/** Kills a process, its group and every descendant, the browsers in groups of their own included. */
function killTree(child) {
  if (!child?.pid) return;
  const pids = [...descendants(child.pid), child.pid];
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** Copies a stream to the runner's own, a line at a time, each line prefixed with its process. */
function relay(stream, target, prefix) {
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", line => target.write(prefix + line + "\n"));
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * Runs a plan and writes its report. Returns `{exitCode, report}`, with no report when the lock was
 * refused. `sweep` removes what a killed process created, given `{root, fixtures}`; `lockFile` is
 * null to run without a lock.
 */
export async function runTier({
  layout,
  reportPath,
  cwd,
  lockFile = null,
  sweep = async () => null,
  workerScript = "focused-journey-smoke.mjs",
  command = process.argv,
  out = process.stdout,
  err = process.stderr,
  coreLeadStep = "create-template",
  coreLeadLimitMs = 30000,
  cleanupGraceMs = 120000,
  workerLimitSeconds = 120,
  sampleMs = 10000,
  sameSignalMs = 1000,
  history = null,
  environment = {},
}) {
  const log = line => out.write(line + "\n");
  const startedAt = new Date();
  const begun = startedAt.getTime();

  // One run at a time. The lock is released on every way out of this function, and by the exit
  // handler should the process end some other way.
  let lock = null;
  const releaseLock = () => {
    if (lock && release(lockFile, lock.holder)) lock.released = true;
  };
  if (lockFile) {
    const holder = holderOf(command, startedAt);
    const taken = acquire(lockFile, holder);
    if (!taken.acquired) {
      err.write(`--- split tier: another split run holds ${lockFile}: ${describeHolder(taken.holder)}. ` +
        "Refusing to start; wait for it to finish, or stop it.\n");
      return { exitCode: LOCK_REFUSED, report: null, holder: taken.holder };
    }
    lock = { path: lockFile, holder, replaced: taken.replaced, released: false };
    if (taken.replaced)
      log(`--- split tier: replaced a stale lock left by ${describeHolder(taken.replaced)}, which is no longer running`);
    process.on("exit", releaseLock);
  }

  const handlers = [];
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    const stepsPath = reportPath.replace(/\.json$/, "") + ".steps.jsonl";
    rmSync(stepsPath, { force: true });
    // Fixtures and evidence go to a directory of this run's own, so no other run can write over them.
    const runDirectory = mkdtempSync(join(tmpdir(), "cedar-split-tier-"));
    const ledgerPath = join(runDirectory, "fixtures.jsonl");
    const evidenceDirectory = mkdtempSync(join(dirname(reportPath), "evidence-"));
    const events = () => readLines(stepsPath);
    const ledger = () => readLines(ledgerPath);
    const sequential = layout.sequential;

    const atStart = machine();
    const peak = { load: atStart.load[0], swapUsedMB: atStart.swap?.usedMB ?? null };
    const sampler = setInterval(() => {
      const now = machine();
      peak.load = Math.max(peak.load, now.load[0]);
      if (now.swap) peak.swapUsedMB = Math.max(peak.swapUsedMB ?? 0, now.swap.usedMB);
    }, sampleMs);

    const running = new Set();
    let interrupted = null, firstSignalAt = 0, forced = false;
    const force = () => {
      if (forced) return;
      forced = true;
      for (const child of running) killTree(child);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        if (interrupted) {
          if (Date.now() - firstSignalAt < sameSignalMs) return;
          log(`--- split tier: ${signal} again; killing every lane's processes and browsers without cleanup`);
          force();
          return;
        }
        interrupted = signal;
        firstSignalAt = Date.now();
        log(`--- split tier: ${signal}; stopping every lane. Journey runners remove their own fixtures, ` +
          "and what any other process created is swept once it has stopped");
        for (const child of running) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
        setTimeout(() => {
          if (!running.size) return;
          log(`--- split tier: processes still running ${cleanupGraceMs / 1000} s after ${signal}; killing them`);
          force();
        }, cleanupGraceMs).unref();
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }

    const processes = [];
    const processEnds = {};
    const units = [];
    const sweeps = [];
    const timeouts = [];

    /** Starts a process in a group of its own. A journey runner gets an IPC channel. */
    function launch(name, args, { ipc = false } = {}) {
      const env = {
        ...process.env,
        ...environment,
        CEDAR_SPLIT_STEPS: stepsPath,
        CEDAR_SPLIT_SCRIPT: name,
        CEDAR_SPLIT_FIXTURES: ledgerPath,
        CEDAR_SPLIT_EVIDENCE: evidenceDirectory,
      };
      const io = sequential ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"];
      const child = ipc
        ? fork(join(cwd, args[0]), args.slice(1), { cwd, detached: true, env, stdio: [...io, "ipc"] })
        : spawn(process.execPath, args, { cwd, detached: true, env, stdio: io });
      running.add(child);
      if (!sequential) {
        relay(child.stdout, out, `[${name}] `);
        relay(child.stderr, err, `[${name}] `);
      }
      // The process has exited at "exit", and its output has all been relayed at "close".
      child.exited = new Promise(resolve => {
        let ended = null;
        child.on("error", error => {
          ended = { code: 127, signal: null, error: error.message };
          resolve(ended);
        });
        child.on("exit", (code, signal) => {
          ended = { code: code ?? 1, signal };
        });
        child.on("close", () => resolve(ended ?? { code: 1, signal: null }));
      });
      child.exited.then(() => running.delete(child));
      return child;
    }

    function noteProcess(name, laneName, args, began, ended, extra = {}) {
      processEnds[name] = Date.now();
      processes.push({
        name,
        lane: laneName,
        command: ["node", ...args],
        exitCode: ended.code,
        ...(ended.signal ? { signal: ended.signal } : {}),
        ...(ended.error ? { error: ended.error } : {}),
        startedAfterSeconds: seconds(begun, began),
        seconds: seconds(began),
        ...extra,
      });
    }

    /**
     * Sweeps what a killed process created and puts back what it changed of an account, unless a
     * second signal asked for no cleanup.
     */
    async function sweepAfter(record, { process: name, unit = null, root = null, step = null }) {
      if (forced) return null;
      const own = ledger().filter(entry => entry.script === name);
      const entries = own.filter(entry => !step || entry.step === step);
      const fixtures = entries.filter(entry => typeof entry.collection === "string");
      // A mark that the process put a change back counts in whichever step it was noted.
      const restores = [...entries.filter(entry => typeof entry.restore === "string"),
        ...own.filter(entry => typeof entry.restored === "string")];
      const rootFolder = root?.id ? root
        : root?.name ? { name: root.name, id: ledger().find(entry => entry.script === name && entry.collection === "folders" && entry.step === "login")?.id ?? null }
        : null;
      log(`--- split tier: ${record.name}: sweeping what ${unit ?? name} created`);
      let result;
      try {
        result = await sweep({ root: rootFolder?.id ? rootFolder : null, fixtures, restores });
      } catch (error) {
        result = { error: String(error?.message ?? error) };
      }
      const entry = { lane: record.name, process: name, unit, recorded: fixtures.length, ...(result ?? { skipped: true }) };
      sweeps.push(entry);
      record.sweeps.push(entry);
      record.sweep ??= entry;
      log(`--- split tier: ${record.name}: sweep of ${unit ?? name}: ${summarize(result)}`);
      return entry;
    }

    function noteTimeout(record, unitName, processName, elapsed, deadline) {
      const entry = { lane: record.name, unit: unitName, process: processName, elapsedSeconds: elapsed, deadlineSeconds: deadline };
      timeouts.push(entry);
      record.timeout = entry;
      log(`--- split tier: ${record.name}: ${unitName} timed out after ${elapsed} s, past its deadline of ${deadline} s; ` +
        "killed with its browsers");
      return entry;
    }

    function noteUnit(record, unit, began, outcome, extra = {}) {
      const entry = {
        name: unit.name,
        kind: unit.kind,
        lane: record.name,
        startedAfterSeconds: seconds(begun, began),
        seconds: seconds(began),
        outcome,
        estimateSeconds: unit.measured ? Math.round(unit.seconds * 10) / 10 : null,
        deadlineSeconds: unit.deadlineSeconds,
        ...extra,
      };
      units.push(entry);
      record.units.push(entry);
      record.busySeconds = Math.round((record.busySeconds + entry.seconds) * 10) / 10;
      if (unit.kind === "journey") record.keys.push(unit.name);
      else record.scripts.push(unit.name);
      return entry;
    }

    function fail(record, { script, step = null, exitCode, message = null, unit }) {
      if (record.exitCode) return;
      record.exitCode = exitCode || 1;
      record.failingScript = script;
      record.failingStep = step;
      record.failure = message;
      record.failingUnit = unit;
      record.failedAt = Date.now();
    }

    /** Runs a script, or the chain, as a process of its own with its deadline. */
    async function runProcess(record, unit) {
      const began = Date.now();
      log(`--- split tier: ${record.name}: ${unit.name} (node ${unit.args.join(" ")}), deadline ${unit.deadlineSeconds} s`);
      const child = launch(unit.name, unit.args);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, unit.deadlineSeconds * 1000);
      const ended = await child.exited;
      clearTimeout(timer);
      noteProcess(unit.name, record.name, unit.args, began, ended, timedOut ? { timedOut: true } : {});
      const elapsed = seconds(began);
      if (timedOut) {
        const timeout = noteTimeout(record, unit.name, unit.name, elapsed, unit.deadlineSeconds);
        noteUnit(record, unit, began, "timeout", { exitCode: TIMED_OUT });
        fail(record, { script: unit.name, step: lastStep(unit.name), exitCode: TIMED_OUT, unit: unit.name,
          message: `${unit.name} timed out after ${elapsed} s, past its deadline of ${unit.deadlineSeconds} s` });
        record.failureTimeout = timeout;
        await sweepAfter(record, { process: unit.name, unit: unit.name });
        return false;
      }
      const ok = ended.code === 0 && !ended.signal;
      noteUnit(record, unit, began, ok ? "pass" : interrupted ? "interrupted" : "fail", { exitCode: ended.code });
      log(`--- split tier: ${record.name}: ${unit.name} exited ${ended.code}${ended.signal ? ` (${ended.signal})` : ""} after ${elapsed} s`);
      if (!ok) {
        fail(record, { script: unit.name, step: lastFailStep(unit.name), exitCode: ended.code, unit: unit.name,
          message: lastFailMessage(unit.name) });
        // A process that died by a signal never reached its own cleanup.
        if (ended.signal) await sweepAfter(record, { process: unit.name, unit: unit.name });
      }
      return ok;
    }

    const lastFail = name => events().filter(event => event.script === name && event.event === "fail").at(-1);
    // The step a killed process was in when it was killed.
    const lastStep = name => events().filter(event => event.script === name && event.event === "step").at(-1)?.step ?? null;
    const lastFailStep = name => lastFail(name)?.step ?? null;
    const lastFailMessage = name => lastFail(name)?.message ?? null;

    /** A lane's journey runner: one process that takes journey keys over IPC. */
    function createWorker(record, root) {
      const worker = { child: null, began: 0, folderId: null, alive: false, listeners: new Set(), endedNoted: false };
      const args = [workerScript, "--worker", `--root=${root}`];
      const waitFor = (predicate, ms) => new Promise(resolve => {
        let settled = false, timer = null;
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.listeners.delete(listener);
          resolve(value);
        };
        const listener = message => {
          if (predicate(message)) done({ message });
        };
        worker.listeners.add(listener);
        worker.child.exited.then(exit => done({ exit }));
        if (ms !== null) timer = setTimeout(() => done({ timeout: true }), ms);
      });
      const finish = (ended, extra = {}) => {
        if (worker.endedNoted) return;
        worker.endedNoted = true;
        worker.alive = false;
        noteProcess(record.name, record.name, args, worker.began, ended, extra);
      };
      const limit = Math.min(workerLimitSeconds, layout.deadline.capSeconds);
      return {
        worker,
        async start() {
          const began = Date.now();
          worker.began = began;
          log(`--- split tier: ${record.name}: starting its journey runner under ${root}`);
          worker.child = launch(record.name, args, { ipc: true });
          worker.alive = true;
          worker.child.on("message", message => {
            for (const listener of [...worker.listeners]) listener(message);
          });
          record.root = root;
          record.worker = { process: record.name, root, startedAfterSeconds: seconds(begun, began) };
          const answer = await waitFor(message => message?.type === "ready", limit * 1000);
          record.overheadSeconds = Math.round((record.overheadSeconds + seconds(began)) * 10) / 10;
          if (answer.message) {
            worker.folderId = answer.message.folderId;
            record.worker.folderId = worker.folderId;
            return true;
          }
          if (answer.timeout) {
            killTree(worker.child);
            const ended = await worker.child.exited;
            finish(ended, { timedOut: true });
            noteTimeout(record, `${record.name} sign-in`, record.name, seconds(began), limit);
            fail(record, { script: record.name, step: "login", exitCode: TIMED_OUT, unit: null,
              message: `${record.name}'s journey runner did not sign in within ${limit} s` });
            await sweepAfter(record, { process: record.name, root: { name: root } });
          } else {
            finish(answer.exit);
            fail(record, { script: record.name, step: lastFailStep(record.name) ?? "login", exitCode: answer.exit.code,
              unit: null, message: lastFailMessage(record.name) ?? `${record.name}'s journey runner exited ${answer.exit.code} before it was ready` });
            if (answer.exit.signal) await sweepAfter(record, { process: record.name, root: { name: root } });
          }
          return false;
        },
        async run(unit) {
          const began = Date.now();
          log(`--- split tier: ${record.name}: ${unit.name}, deadline ${unit.deadlineSeconds} s`);
          // A runner whose channel has closed is about to exit, which the wait below then reports.
          // With a callback, a send on a closed channel reports there rather than as the process's error.
          try {
            worker.child.send({ type: "run", key: unit.name }, () => {});
          } catch {}
          const answer = await waitFor(message => message?.type === "result" && message.key === unit.name,
            unit.deadlineSeconds * 1000);
          const elapsed = seconds(began);
          if (answer.message) {
            const result = answer.message;
            noteUnit(record, unit, began, result.ok ? "pass" : interrupted ? "interrupted" : "fail", {
              checks: result.checks, cleanupSeconds: result.cleanupSeconds, scenarios: result.scenarios, evidence: result.evidence,
              failureCategory: result.failureCategory,
              ...(result.ok ? {} : { message: (result.message ?? "").slice(0, 2000) }),
            });
            record.workerChecks += result.checks ?? 0;
            if (!result.ok) fail(record, { script: record.name, step: unit.name, exitCode: 1, unit: unit.name, message: result.message ?? null });
            log(`--- split tier: ${record.name}: ${unit.name} ${result.ok ? "passed" : "failed"} after ${elapsed} s`);
            return result.ok;
          }
          if (answer.timeout) {
            killTree(worker.child);
            const ended = await worker.child.exited;
            finish(ended, { timedOut: true });
            const timeout = noteTimeout(record, unit.name, record.name, elapsed, unit.deadlineSeconds);
            noteUnit(record, unit, began, "timeout", { exitCode: TIMED_OUT });
            fail(record, { script: record.name, step: unit.name, exitCode: TIMED_OUT, unit: unit.name,
              message: `${unit.name} timed out on ${record.name} after ${elapsed} s, past its deadline of ${unit.deadlineSeconds} s` });
            record.failureTimeout = timeout;
            await sweepAfter(record, { process: record.name, unit: unit.name, step: unit.name,
              root: { id: worker.folderId, name: root } });
            return false;
          }
          // The runner exited while the journey was in flight, so its fixtures were never removed.
          finish(answer.exit);
          noteUnit(record, unit, began, interrupted ? "interrupted" : "fail", { exitCode: answer.exit.code });
          fail(record, { script: record.name, step: unit.name, exitCode: answer.exit.code || 1, unit: unit.name,
            message: lastFailMessage(record.name) ?? `${record.name}'s journey runner exited ${answer.exit.code} during ${unit.name}` });
          await sweepAfter(record, { process: record.name, unit: unit.name, step: unit.name,
            root: { id: worker.folderId, name: root } });
          return false;
        },
        async stop() {
          if (!worker.alive) return;
          const began = Date.now();
          if (worker.child.connected) {
            try {
              worker.child.send({ type: "stop" }, () => {});
            } catch {}
          }
          const answer = await waitFor(() => false, limit * 1000);
          record.overheadSeconds = Math.round((record.overheadSeconds + seconds(began)) * 10) / 10;
          if (answer.timeout) {
            killTree(worker.child);
            finish(await worker.child.exited, { timedOut: true });
            noteTimeout(record, `${record.name} cleanup`, record.name, seconds(began), limit);
            fail(record, { script: record.name, step: "cleanup", exitCode: TIMED_OUT, unit: null,
              message: `${record.name}'s journey runner did not remove its root within ${limit} s` });
            await sweepAfter(record, { process: record.name, root: { id: worker.folderId, name: root } });
            return;
          }
          finish(answer.exit);
          // A runner stopped by the interrupt exits 1 having removed its root, which is no failure of its lane.
          if (answer.exit.code !== 0 && !interrupted) {
            fail(record, { script: record.name, step: "cleanup", exitCode: answer.exit.code, unit: null,
              message: lastFailMessage(record.name) ?? `${record.name}'s journey runner exited ${answer.exit.code} at cleanup` });
          }
          if (answer.exit.signal) await sweepAfter(record, { process: record.name, root: { id: worker.folderId, name: root } });
        },
      };
    }

    const laneRecord = lane => ({
      name: lane.name,
      root: null,
      keys: [],
      scripts: [],
      plannedSeconds: null,
      startedAfterSeconds: null,
      seconds: null,
      exitCode: 0,
      failingScript: null,
      failingStep: null,
      failure: null,
      notRun: [],
      units: [],
      busySeconds: 0,
      overheadSeconds: 0,
      idleSeconds: null,
      timeout: null,
      sweep: null,
      sweeps: [],
      worker: null,
      workerChecks: 0,
    });

    let notRun = [];
    const records = sequential
      ? [laneRecord(layout.lanes[0])]
      : layout.lanes.map(lane => ({ ...laneRecord(lane),
        plannedSeconds: layout.projection.lanes.find(entry => entry.name === lane.name)?.busySeconds ?? null }));

    if (sequential) {
      const record = records[0];
      record.keys = [];
      record.startedAfterSeconds = 0;
      log("--- split tier: one script after another");
      for (const unit of layout.lanes[0].processes) {
        if (interrupted || record.exitCode) {
          record.notRun.push(unit.name);
          continue;
        }
        await runProcess(record, unit);
      }
      record.keys = layout.lanes[0].keys;
      record.seconds = seconds(begun);
      notRun = record.notRun;
    } else {
      const queue = createQueue(layout.units);
      log(`--- split tier: ${layout.lanes.length} lanes, ${layout.generalLanes} of them general, sharing one queue of ` +
        `${layout.units.length} units; projected to finish in ${layout.projection.finishSeconds} s`);
      let chainEnded = false;
      const laneRun = async (lane, record) => {
        record.startedAfterSeconds = seconds(begun);
        const began = Date.now();
        const worker = createWorker(record, lane.root);
        let ok = true;
        if (lane.core) {
          ok = await runProcess(record, layout.chain);
          chainEnded = true;
        } else {
          // The core lane's Designer search must find the element it made moments before, and the
          // search index takes writes in turn, so the other lanes start once the core lane has made
          // its fixtures, which it has when it enters its next step, or once its chain has ended.
          const leadBegan = Date.now();
          while (!chainEnded && !interrupted && Date.now() - leadBegan < coreLeadLimitMs &&
            !events().some(event => event.script === layout.chain.name && event.event === "step" && event.step === coreLeadStep))
            await sleep(250);
        }
        while (ok && !interrupted) {
          const unit = queue.next(lane);
          if (!unit) break;
          if (unit.kind === "journey" && !worker.worker.alive) {
            if (!(await worker.start())) {
              queue.requeue(unit);
              ok = false;
              break;
            }
          }
          ok = unit.kind === "journey" ? await worker.run(unit) : await runProcess(record, unit);
          queue.finish(unit);
        }
        await worker.stop();
        record.seconds = seconds(began);
      };
      const [core, ...others] = layout.lanes;
      const corePromise = laneRun(core, records[0]);
      // The others wait inside laneRun for the core lane's lead.
      const otherPromises = others.map((lane, index) => laneRun(lane, records[index + 1]));
      await Promise.all([corePromise, ...otherPromises]);
      // Only the identity lane may run an identity unit, so one left over is that lane's to have run.
      notRun = queue.pending().map(unit => unit.name);
      for (const record of records)
        if (layout.lanes.find(lane => lane.name === record.name)?.identity)
          record.notRun = queue.pending().filter(unit => unit.identity).map(unit => unit.name);
    }
    clearInterval(sampler);

    // One record per event, in the order they happened. A step lasts until the next event its process
    // writes, and the last one until the process exits.
    const all = events();
    const timeline = [];
    all.forEach((event, index) => {
      if (event.event !== "step") return;
      const next = all.slice(index + 1).find(other => other.script === event.script);
      const until = next ? Date.parse(next.at) : processEnds[event.script];
      timeline.push({
        script: event.script,
        step: event.step,
        seconds: until ? Math.round((until - Date.parse(event.at)) / 100) / 10 : null,
      });
    });
    const failures = [];
    for (const record of records) {
      if (!record.failingScript) continue;
      failures.push({
        lane: record.name,
        script: record.failingScript,
        step: record.failingStep,
        exitCode: record.exitCode,
        message: record.failure,
        finishedAt: new Date(record.failedAt ?? Date.now()).toISOString(),
        unit: record.failingUnit ?? null,
        ...(record.failureTimeout ? { timeout: record.failureTimeout } : {}),
      });
    }
    failures.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    const first = failures[0];
    const finishedAt = new Date();
    const durationSeconds = seconds(begun, finishedAt.getTime());
    const ends = all.filter(event => event.event === "end");
    const checks = ends.reduce((sum, end) => sum + (typeof end.checks === "number" ? end.checks : 0), 0) +
      records.filter(record => record.worker && !ends.some(end => end.script === record.name))
        .reduce((sum, record) => sum + record.workerChecks, 0);
    for (const record of records) {
      record.busySeconds = Math.round(record.busySeconds * 10) / 10;
      record.idleSeconds = Math.max(0, Math.round((durationSeconds - record.busySeconds - record.overheadSeconds) * 10) / 10);
      delete record.failedAt;
      delete record.failingUnit;
      delete record.failureTimeout;
      delete record.workerChecks;
    }
    const inventoryMode = environment.CEDAR_JOURNEY_RECORD_INVENTORY ? "candidate" : "verified";
    const journeyResults = all.filter(event => event.event === "done" && event.scenarios).map(event => ({
      name: event.step, kind: "journey", outcome: event.outcome ?? "pass", seconds: event.seconds,
      scenarios: event.scenarios, evidence: event.evidence, message: event.message,
    }));
    const verdict = interrupted ? "INTERRUPTED" : failures.length || notRun.length ? "FAIL" : inventoryMode === "candidate" ? "CANDIDATE" : "PASS";
    const report = {
      schemaVersion: SCHEMA_VERSION,
      seed: layout.seed ?? null,
      verdict,
      inventoryMode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      sequential,
      generalLanes: layout.generalLanes,
      ...(interrupted ? { interrupted, forced } : {}),
      machine: { start: atStart, peak, end: machine() },
      failingScript: first?.script ?? null,
      failingStep: first?.step ?? null,
      failure: first?.message ?? null,
      failures,
      checks,
      lanes: records,
      scripts: processes,
      notRun,
      steps: timeline,
      inventory: [...new Set(timeline.map(entry => entry.script + ":" + entry.step))],
      ends,
      lock: lock ? { path: lock.path, holder: lock.holder, replaced: lock.replaced } : null,
      unitTimeout: { ...layout.deadline, formula: "min(cap, max(floor, factor × measured + margin)); the cap when unmeasured",
        workerLimitSeconds: Math.min(workerLimitSeconds, layout.deadline.capSeconds) },
      queue: sequential ? null : {
        dynamic: true,
        order: layout.units.map(unit => unit.name),
        identity: layout.units.filter(unit => unit.identity).map(unit => unit.name),
        projectedSeconds: layout.projection.finishSeconds,
      },
      units,
      journeyResults,
      timeouts,
      sweeps,
      runDirectory,
      evidenceDirectory,
    };
    for (const unit of units) if (unit.outcome !== "pass") unit.failureCategory ??= failureCategory(unit.message, unit.outcome);
    if (history) report.history = finishHistory(history, { verdict, units: [...units, ...journeyResults.filter(journey => !units.some(unit => unit.name === journey.name))], reportPath, inventoryMode });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

    const slowest = [...timeline].filter(entry => entry.seconds !== null).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
    log(`--- split tier: ${report.verdict} in ${report.durationSeconds} s; report ${reportPath}`);
    for (const record of records)
      log(`    ${record.name}: ${record.units.length} units, busy ${record.busySeconds} s, ` +
        `overhead ${record.overheadSeconds} s, idle ${record.idleSeconds} s, exit ${record.exitCode}` +
        (record.failingScript ? `, failed in ${record.failingScript}${record.failingStep ? ", step " + record.failingStep : ""}` : "") +
        (record.timeout ? `, timed out` : "") +
        (record.notRun.length ? `; not run: ${record.notRun.join(", ")}` : ""));
    if (notRun.length) log(`    not run: ${notRun.join(", ")}`);
    for (const failure of failures)
      if (failure.message) log(`    ${failure.lane}: ${failure.message.split("\n")[0].slice(0, 300)}`);
    if (slowest.length) log("    slowest steps: " + slowest.map(entry => `${entry.step} ${entry.seconds} s`).join(", "));
    log(`    load ${atStart.load[0]} at start, ${peak.load} at peak, ${report.machine.end.load[0]} at end` +
      (peak.swapUsedMB !== null ? `; swap used ${atStart.swap?.usedMB} MB at start, ${peak.swapUsedMB} MB at peak` : ""));
    log(`    evidence: ${evidenceDirectory}`);
    const exitCode = interrupted ? 130 : first ? first.exitCode || 1 : notRun.length || inventoryMode === "candidate" ? 1 : 0;
    return { exitCode, report };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    releaseLock();
    if (lock) process.off("exit", releaseLock);
  }
}
