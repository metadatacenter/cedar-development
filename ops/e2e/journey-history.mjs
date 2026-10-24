import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const historyDirectory = join(dirname(fileURLToPath(import.meta.url)), "reports", "journey-history");
export function failureCategory(message, outcome = "fail") {
  if (outcome === "interrupted") return "interrupted";
  if (/Browser teardown failed|Browser cleanup/i.test(message ?? "")) return "cleanup";
  if (outcome === "timeout" || /Timeout|timed out|deadline/i.test(message ?? "")) return "timeout";
  if (/inventory|scenario ID|scenarios executed/i.test(message ?? "")) return "inventory";
  if (/cleanup|fixture removal/i.test(message ?? "")) return "cleanup";
  if (/uncaught browser|pageerror/i.test(message ?? "")) return "browser-error";
  if (/sign.in|login|authenticate/i.test(message ?? "")) return "authentication";
  return "assertion-or-operation";
}

export function sourceIdentity(cwd) {
  const git = args => { try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim(); } catch { return "unavailable"; } };
  const hash = createHash("sha256");
  // Imported REST helpers and nested fixtures are inputs too. Generated evidence, dependencies and
  // saved credentials are not: a run must not invalidate its own fingerprint by recording a report.
  const excluded = new Set(["node_modules", "reports", "failures", ".auth", ".git"]);
  const inputs = directory => readdirSync(join(cwd, directory), {withFileTypes: true}).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? inputs(path) : /\.(mjs|cjs|js|json|html|ya?ml)$/.test(entry.name) ? [path] : [];
  });
  for (const name of inputs("").sort())
    hash.update(name).update("\0").update(readFileSync(join(cwd, name))).update("\0");
  const runtime = join(process.env.CEDAR_HOME ?? join(cwd, "..", "..", ".."), ".reactor", "runtime.json");
  const runtimeDigest = existsSync(runtime) ? createHash("sha256").update(readFileSync(runtime)).digest("hex") : null;
  return { head: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])), testDigest: hash.digest("hex"), runtimeDigest };
}

export function readHistory(directory = historyDirectory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json")).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(directory, name), "utf8"))]; } catch { return []; }
  }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Explicit retry linkage preserves the original failed attempt. Changed sources start a new attempt series. */
export function beginHistory({ cwd, kind, selection, seed = null, retryOf = null, directory = historyDirectory }) {
  const run = { id: randomUUID(), startedAt: new Date().toISOString(), kind, selection: [...selection].sort(),
    seed, retryOf, source: sourceIdentity(cwd) };
  if (retryOf) {
    const previous = readHistory(directory).find(item => item.id === retryOf);
    if (!previous) throw new Error(`Unknown --retry-of run ${retryOf}`);
    if (previous.verdict === "PASS") throw new Error("A passing run is a new observation, not a retry");
    if (JSON.stringify(previous.selection) !== JSON.stringify(run.selection) ||
        previous.source.testDigest !== run.source.testDigest || previous.source.runtimeDigest !== run.source.runtimeDigest || previous.source.head !== run.source.head || previous.kind !== kind)
      throw new Error("A retry requires the same sources, run kind and selection; omit --retry-of for changed work");
    run.firstAttempt = previous.firstAttempt ?? previous.id;
  } else run.firstAttempt = run.id;
  return run;
}

export function finishHistory(run, { verdict, units, reportPath, runtime, inventoryMode = "verified" }, directory = historyDirectory) {
  const result = { ...run, finishedAt: new Date().toISOString(), verdict, reportPath, runtime, inventoryMode,
    units: units.map(unit => ({ ...unit, failureCategory: unit.outcome === "pass" ? null :
      unit.failureCategory ?? failureCategory(unit.message, unit.outcome) })) };
  mkdirSync(directory, { recursive: true });
  const path = join(directory, run.id + ".json");
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return { id: run.id, path, firstAttempt: run.firstAttempt, retryOf: run.retryOf };
}

const quantile = (values, percentile) => values.length ? values[Math.max(0, Math.ceil(values.length * percentile) - 1)] : null;
export function summarizeHistory(runs) {
  runs = runs.filter(run => run.inventoryMode !== "candidate");
  const names = [...new Set(runs.flatMap(run => run.units.map(unit => unit.name)))].sort();
  return names.map(name => {
    const observations = runs.flatMap(run => run.units.filter(unit => unit.name === name).map(unit => ({ run, unit })));
    const first = observations.filter(({ run }) => !run.retryOf);
    const durations = first.filter(({ unit }) => unit.outcome === "pass").map(({ unit }) => unit.seconds).filter(Number.isFinite).sort((a, b) => a - b);
    const recovered = new Set(observations.filter(({ run, unit }) => run.retryOf && unit.outcome === "pass" &&
      observations.some(other => other.run.id === run.firstAttempt && other.unit.outcome !== "pass")).map(({ run }) => run.firstAttempt));
    const failures = {};
    for (const { unit } of first.filter(({ unit }) => unit.outcome !== "pass")) {
      const cause = unit.failureCategory ?? failureCategory(unit.message, unit.outcome);
      failures[cause] = (failures[cause] ?? 0) + 1;
    }
    const passes = first.filter(({ unit }) => unit.outcome === "pass").length;
    return { name, firstAttempts: first.length, passes, firstAttemptPassRate: first.length ? passes / first.length : null,
      recoveredOnRetry: recovered.size, retries: observations.length - first.length, failures,
      successfulSeconds: { samples: durations.length, median: quantile(durations, .5), p95: quantile(durations, .95), max: durations.at(-1) ?? null } };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const source = args.find(arg => arg.startsWith("--source="))?.slice(9);
  const runs = readHistory().filter(run => !source || run.source.testDigest === source || run.source.head === source);
  if (args.includes("--json")) console.log(JSON.stringify({ runs: runs.length, units: summarizeHistory(runs) }, null, 2));
  else {
    console.log(`${runs.length} retained runs. Rates use first attempts only; categories describe symptoms, not proven root causes.`);
    for (const row of summarizeHistory(runs)) console.log(`${row.name}: ${row.passes}/${row.firstAttempts} first passes; ` +
      `${row.recoveredOnRetry} recovered on retry; median/p95 ${row.successfulSeconds.median ?? "—"}/${row.successfulSeconds.p95 ?? "—"} s; ` + JSON.stringify(row.failures));
  }
}
