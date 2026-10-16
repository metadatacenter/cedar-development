// The split tier: the Angular Workspace, the Designer host and the account pages, one script after
// another, stopping at the first failure as the `&&` chain it replaces did. It adds a report, so a
// failed run says which script and which step failed and how long each took, and records the
// machine's load and swap at start and end, since a burst of uniform timeouts is usually load.
//
//   node split-tier.mjs [--report=PATH]
//
// The report defaults to reports/split-smoke.json. `cedarcli test e2e` passes a path of its own.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = [
  ["modern-workspace", ["modern-workspace-smoke.mjs"]],
  ["ced-host", ["ced-host-smoke.mjs"]],
  ["account-profile", ["account-pages-smoke.mjs", "profile"]],
  ["account-settings", ["account-pages-smoke.mjs", "settings"]],
  ["account-groups", ["account-pages-smoke.mjs", "groups"]],
  ["account-privacy", ["account-pages-smoke.mjs", "privacy"]],
  ["workspace-lifecycle", ["workspace-lifecycle-smoke.mjs", "all"]],
  ["folder-delete", ["recursive-folder-delete-smoke.mjs"]],
];

const reportArgument = process.argv.slice(2).find(argument => argument.startsWith("--report="));
const reportPath = reportArgument ? reportArgument.slice("--report=".length) : join(here, "reports", "split-smoke.json");
const stepsPath = reportPath.replace(/\.json$/, "") + ".steps.jsonl";

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

function run(name, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: here,
      stdio: "inherit",
      env: { ...process.env, CEDAR_SPLIT_STEPS: stepsPath, CEDAR_SPLIT_SCRIPT: name },
    });
    child.on("error", error => resolve({ code: 127, error: error.message }));
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

// One record per event, in the order they happened. A step lasts until the next event its script
// writes, and the last one until the script exits.
function steps(scriptEnds) {
  if (!existsSync(stepsPath)) return { timeline: [], events: [] };
  const events = readFileSync(stepsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const timeline = [];
  events.forEach((event, index) => {
    if (event.event !== "step") return;
    const next = events.slice(index + 1).find(other => other.script === event.script);
    const until = next ? Date.parse(next.at) : scriptEnds[event.script];
    timeline.push({
      script: event.script,
      step: event.step,
      seconds: until ? Math.round((until - Date.parse(event.at)) / 100) / 10 : null,
    });
  });
  return { timeline, events };
}

mkdirSync(dirname(reportPath), { recursive: true });
rmSync(stepsPath, { force: true });
const startedAt = new Date();
const atStart = machine();
const scripts = [];
const scriptEnds = {};
for (const [name, args] of SCRIPTS) {
  const began = Date.now();
  console.log(`--- split tier: ${name} (node ${args.join(" ")})`);
  const outcome = await run(name, args);
  scriptEnds[name] = Date.now();
  scripts.push({
    name,
    command: ["node", ...args],
    exitCode: outcome.code,
    ...(outcome.signal ? { signal: outcome.signal } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    seconds: Math.round((Date.now() - began) / 100) / 10,
  });
  if (outcome.code !== 0) break;
}
const finishedAt = new Date();
const failed = scripts.find(script => script.exitCode !== 0);
const { timeline, events } = steps(scriptEnds);
const failure = failed ? events.filter(event => event.script === failed.name && event.event === "fail").at(-1) : undefined;
const report = {
  schemaVersion: 1,
  verdict: failed ? "FAIL" : "PASS",
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: Math.round((finishedAt - startedAt) / 100) / 10,
  machine: { start: atStart, end: machine() },
  failingScript: failed?.name ?? null,
  failingStep: failure?.step ?? null,
  failure: failure?.message ?? null,
  scripts,
  notRun: SCRIPTS.slice(scripts.length).map(([name]) => name),
  steps: timeline,
  inventory: [...new Set(timeline.map(entry => entry.script + ":" + entry.step))],
  ends: events.filter(event => event.event === "end"),
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const slowest = [...timeline].filter(entry => entry.seconds !== null).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log(`--- split tier: ${report.verdict} in ${report.durationSeconds} s; report ${reportPath}`);
for (const script of scripts) console.log(`    ${script.name}: ${script.seconds} s, exit ${script.exitCode}`);
if (failed) console.log(`    failed in ${failed.name}${report.failingStep ? ", step " + report.failingStep : ""}`);
if (slowest.length) console.log("    slowest steps: " + slowest.map(entry => `${entry.step} ${entry.seconds} s`).join(", "));
process.exitCode = failed ? failed.exitCode || 1 : 0;
