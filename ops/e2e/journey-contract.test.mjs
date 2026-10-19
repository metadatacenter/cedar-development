import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarioTracker, shuffled } from "./journey-contract.mjs";
import { plan, createQueue } from "./split-lanes.mjs";
import { failureCategory, summarizeHistory } from "./journey-history.mjs";

const expected = [{ id: "save", promise: "Saving preserves input" }, { id: "reopen", promise: "Reopening preserves input" }];
test("browser teardown failures remain cleanup failures in reliability history, including close timeouts", () => {
  assert.equal(failureCategory("Error: Browser teardown failed: context-1 close-error: Timeout"), "cleanup");
  assert.equal(failureCategory("Browser cleanup: transport disconnected"), "cleanup");
  assert.equal(failureCategory("Uncaught browser errors: late render"), "browser-error");
});

test("omitting, repeating or substituting a scenario cannot produce a passing inventory", () => {
  const omitted = scenarioTracker("editing", { expected });
  omitted.pass("save", "Saving preserves input");
  assert.throws(() => omitted.finish(), /inventory differs/);
  assert.throws(() => omitted.pass("save", "Repeated"), /duplicate/);
  assert.throws(() => omitted.pass("other", "Substituted"), /unexpected/);
  assert.throws(() => omitted.pass("prose only"), /explicit scenario ID/);
  omitted.pass("reopen", "A clearer description of the same promise");
  omitted.finish();
});

test("seeded ordering is repeatable, changes with the seed, and still serializes identities", () => {
  const journeys = Array.from({ length: 15 }, (_, i) => ({ key: `journey-${i}`, authentication: i % 3 === 0 }));
  const build = seed => plan({ journeys, scripts: [], seed });
  assert.deepEqual(build("one").units, build("one").units);
  assert.notDeepEqual(build("one").units.map(u => u.name), build("two").units.map(u => u.name));
  assert.deepEqual(new Set(shuffled(journeys, "one")), new Set(journeys));
  const queue = createQueue(build("one").units);
  const identity = queue.next({ identity: true });
  assert.equal(identity.identity, true);
  assert.equal(queue.next({ identity: true }).identity, false);
  assert.equal(queue.next({ identity: false }).identity, false);
  queue.requeue(identity);
  assert.equal(queue.next({ identity: true }), identity);
});

test("a passing retry never erases a failed first attempt or inflates its rate", () => {
  const runs = [
    { id: "first", firstAttempt: "first", units: [{ name: "editing", outcome: "fail", seconds: 30, message: "Timeout" }] },
    { id: "retry", firstAttempt: "first", retryOf: "first", units: [{ name: "editing", outcome: "pass", seconds: 2 }] },
    { id: "next", firstAttempt: "next", units: [{ name: "editing", outcome: "pass", seconds: 4 }] },
  ];
  const [summary] = summarizeHistory(runs);
  assert.equal(summary.firstAttempts, 2);
  assert.equal(summary.firstAttemptPassRate, .5);
  assert.equal(summary.recoveredOnRetry, 1);
  assert.deepEqual(summary.failures, { timeout: 1 });
  assert.deepEqual(summary.successfulSeconds, { samples: 1, median: 4, p95: 4, max: 4 });
});
