// Reproduce an order, then optionally prove every selected journey runs in a process of its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNEYS } from "./journey-registry.mjs";

const here = dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2);
const selected = args.filter(arg => !arg.startsWith("--"));
const keys = selected.length ? selected : JOURNEYS.map(entry => entry.key);
assert.ok(keys.every(key => JOURNEYS.some(entry => entry.key === key)), "Unknown journey key");
const seed = args.find(arg => arg.startsWith("--seed=")) ?? "--seed=cedar-isolation";
const runs = [[seed, ...keys], ...(args.includes("--independent") ? keys.map(key => [key]) : [])];
for (const selection of runs) {
  console.log("Journey independence run: " + selection.join(" "));
  const child = spawn(process.execPath, [join(here, "focused-journey-smoke.mjs"), ...selection], { cwd: here, stdio: "inherit" });
  const stop = signal => child.kill(signal);
  let interrupted = false;
  const interrupt = () => { interrupted = true; stop("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const exit = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", code => resolve(code ?? 1)); });
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  if (exit || interrupted) { process.exitCode = interrupted ? 130 : exit; break; }
}
