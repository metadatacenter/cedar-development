// Review a candidate only after a complete successful execution; acceptance runs never update the inventory.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { inventory, inventoryPath, scenarioKey } from "./journey-contract.mjs";
import { JOURNEYS } from "./journey-registry.mjs";

const args = process.argv.slice(2);
const reportPath = args.find(arg => arg.startsWith("--report="))?.slice(9);
assert.ok(reportPath, "Pass --report=<candidate split or focused report>; --apply writes the reviewed inventory");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert.equal(report.inventoryMode, "candidate", "The report must come from --record-inventory");
assert.equal(report.verdict, "CANDIDATE", "Only a clean candidate run may update coverage");
assert.equal(report.notRun?.length ?? 0, 0, "Candidate left journeys unexecuted");
assert.equal(report.cleanupErrors?.length ?? 0, 0, "Candidate cleanup failed");
const next = inventory(), changes = [];
for (const unit of [...report.units, ...(report.journeyResults ?? []).filter(journey => !report.units.some(unit => unit.name === journey.name))].filter(unit => unit.kind === "journey")) {
  assert.equal(unit.outcome, "pass", unit.name + " did not pass");
  assert.ok(unit.scenarios?.length, unit.name + " has no executed scenarios");
  assert.equal(new Set(unit.scenarios.map(s => s.id)).size, unit.scenarios.length, "Repeated scenario");
  assert.ok(unit.scenarios.every(s => s.id === scenarioKey(s.id) && typeof s.promise === "string"), "Invalid scenario");
  const previous = next[unit.name] ?? [];
  changes.push({ journey: unit.name, added: unit.scenarios.filter(s => !previous.some(p => p.id === s.id)).map(s => s.id),
    removed: previous.filter(p => !unit.scenarios.some(s => s.id === p.id)).map(s => s.id) });
  next[unit.name] = unit.scenarios;
}
assert.deepEqual(Object.keys(next).sort(), JOURNEYS.map(entry => entry.key).sort(), "Every registered journey needs coverage, and stale journeys must be removed deliberately");
console.log(JSON.stringify(changes.filter(change => change.added.length || change.removed.length), null, 2));
if (args.includes("--apply")) writeFileSync(inventoryPath,
  JSON.stringify(Object.fromEntries(JOURNEYS.map(entry => [entry.key, next[entry.key]])), null, 2) + "\n");
else console.log("Preview only. Review additions/removals before using --apply; then run again with inventory enforcement.");
