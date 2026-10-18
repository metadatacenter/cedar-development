import { withBrowserAuthentication, withJourneyAuthentication } from "./auth-activity.mjs";
// Runs self-contained journeys against the live stack, one after another in fresh contexts, without the
// inline chain of the full Workspace smoke and the fixtures it provisions.
//
//   node focused-journey-smoke.mjs [--root=NAME] <key>...
//   node focused-journey-smoke.mjs --worker --root=NAME
//
// The keys are those of journey-registry.mjs, and each runs once. The journeys work under a root
// folder in the first test user's home, named "Focused journey <stamp>" unless --root names it. Each
// journey's fixtures are removed as soon as it ends, and the root once the last journey has.
//
// With --worker the process takes its keys from the split tier's runner instead, one at a time over
// the IPC channel the runner opened when it forked the process. Once signed in it sends
// `{type: "ready"}`. For each `{type: "run", key}` it runs that journey, removes its fixtures and
// sends `{type: "result", key, ok, ...}`. It stops after `{type: "stop"}`, after a journey fails,
// or when the channel closes. Under the runner the process records each journey as a step through
// split-steps.mjs, and a journey's end as a `done` event.
//
// A first SIGINT or SIGTERM closes the browser, which ends the journey in flight. Its fixtures and
// the root are then removed, and the process exits with status 1.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { scenarioTracker, shuffled } from "./journey-contract.mjs";
import { journeyBrowser } from "./journey-browser.mjs";
import { beginHistory, finishHistory, failureCategory } from "./journey-history.mjs";
import { acquire, release, lockPath, holderOf, describeHolder } from "./split-lock.mjs";
import { chromium } from "playwright";
import { actors, call, mutate, enc } from "./rest/lib.mjs";
import { captureCreates, recordCreate } from "./journey-fixtures.mjs";
import { JOURNEYS, journey } from "./journey-registry.mjs";
import { enter, noteFixture, record, evidenceDirectory } from "./split-steps.mjs";

const args = process.argv.slice(2);
const worker = args.includes("--worker");
const rootArgument = args.find((argument) => argument.startsWith("--root="));
const option = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const seed = option("seed");
let selected = args.includes("--all") ? JOURNEYS.map(entry => entry.key) : args.filter(argument => !argument.startsWith("--"));
if (seed !== undefined) selected = shuffled(selected, seed);
const recordDirectory = option("record-inventory") ?? process.env.CEDAR_JOURNEY_RECORD_INVENTORY;
const here = dirname(fileURLToPath(import.meta.url));
const reportPath = option("report") ?? join(evidenceDirectory(), "journeys.json");
const results = [];
let history, lock;
if (!worker) {
  const path = lockPath(here), holder = holderOf();
  const taken = acquire(path, holder);
  if (!taken.acquired) { console.error(`Another split run holds ${path}: ${describeHolder(taken.holder)}`); process.exit(75); }
  lock = { path, holder };
  process.on("exit", () => release(path, holder));
  history = beginHistory({ cwd: here, kind: "focused", selection: selected, seed, retryOf: option("retry-of") });
}
if (worker) {
  assert.ok(process.send, "--worker runs under the split tier's runner, which forks it with an IPC channel");
  assert.equal(selected.length, 0, "A worker takes its keys from the runner, not from its arguments");
  assert.ok(rootArgument, "A worker's root is named by the runner");
} else {
  assert.ok(
    selected.length && selected.every((key) => journey(key)),
    "Choose: " + JOURNEYS.map((entry) => entry.key).join(", "),
  );
  assert.equal(new Set(selected).size, selected.length, "Each journey runs once");
}
const name = rootArgument ? rootArgument.slice("--root=".length) : "Focused journey " + Date.now();
assert.ok(name, "--root names the root folder");
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer =
  process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";

// What the journey in flight has created. Every addition is also noted in the split tier's fixture
// ledger, so that the runner can remove it if it has to kill this process.
const created = [];
created.push = (...items) => {
  for (const item of items) noteFixture(item);
  return Array.prototype.push.apply(created, items);
};
const errors = [],
  bodies = new Map();
let browser,
  authState,
  page,
  rootId = null,
  step = "login",
  checks = 0,
  running = false,
  stopping = null;

// Messages from the runner, taken one at a time. A closed channel or a signal reads as a stop.
const inbox = [];
let wake = null;
function deliver(message) {
  inbox.push(message);
  wake?.();
}
async function nextMessage() {
  while (!inbox.length) await new Promise((resolve) => (wake = resolve));
  wake = null;
  return inbox.shift();
}
const tell = (message) =>
  new Promise((resolve) => (process.connected ? process.send(message, () => resolve()) : resolve()));
if (worker) {
  process.on("message", deliver);
  process.on("disconnect", () => deliver({ type: "stop", reason: "the runner's channel closed" }));
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = signal;
    console.error(`${signal}: stopping; the journey in flight ends, and its fixtures and the root are removed`);
    deliver({ type: "stop", reason: signal });
    if (running) browser?.close().catch(() => {});
  });
}

async function write(
  p,
  method,
  path,
  gesture,
  status = 200,
  conditional = false,
) {
  const [response] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname.startsWith(path),
    ),
    gesture(),
  ]);
  // Any status in a list passes, as in the full smoke's write().
  const body = await response.json().catch(() => undefined);
  const reply = () => JSON.stringify(bodies.get(method + " " + response.url()) ?? body)?.slice(0, 1200);
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(response.status()),
    `${method} ${path} returned ${response.status()}, expected ${status}: ${reply()}`,
  );
  if (conditional) assert.ok(await response.request().headerValue("if-match"), "Missing If-Match");
  // A POST names what it created in its reply, a create-by-PUT in its address. Either way the
  // collection comes from the identity, so a command's reply is not recorded under "command".
  // Journeys may open contexts of their own, outside the capture route, so the reply is recorded here.
  recordCreate(created, method, response.url(), response.status(), body);
  return body;
}

/** Fresh contexts reuse only the initial login cookies, never a previous journey's application storage. */
async function authenticate(p) {
  return withBrowserAuthentication("journey worker sign-in", async () => {
    p.setDefaultTimeout(25000);
    await p.goto(base + "/dashboard");
    const ready = p.getByRole("button", { name: "New", exact: true });
    const username = p.locator("#username");
    await username.or(ready).first().waitFor();
    if (await username.isVisible()) {
      await username.fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com");
      await p.locator("#password").fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1");
      await p.locator("#kc-login").click();
    }
    await ready.waitFor();
  });
}

/** Signs in through the form and makes the root folder. */
async function setUp(user1) {
  step = enter("login");
  browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  await authenticate(page);
  authState = await context.storageState();
  await context.close();
  const folder = await call(user1.auth, "POST", "/folders", {
    folderId: user1.profile.homeFolderId,
    name,
    description: "Temporary journey",
  });
  assert.equal(folder.status, 201, folder.text);
  rootId = folder.body["@id"];
}

/** Removes what the journey in flight created, newest first. A fixture already gone is a clean end. */
async function removeFixtures(user1) {
  const failures = [];
  for (const item of [...created].reverse()) {
    const removed = await mutate(user1.auth, "DELETE", "/" + item.collection + "/" + enc(item.id));
    if (![200, 204, 404].includes(removed.status))
      failures.push(`${item.collection}/${item.id}: ${removed.status}`);
  }
  created.length = 0;
  return failures;
}

/** Runs one journey under the root and removes its fixtures. A failure is recorded, not thrown. */
async function runJourney(user1, key) {
  const began = Date.now();
  let failure = null;
  step = enter(key);
  bodies.clear();
  running = true;
  const tracked = scenarioTracker(key, { recordDirectory, emit: scenario => {
    checks++;
    record({ event: "scenario", step: key, ...scenario });
    console.log(`PASS: ${key}/${scenario.id}: ${scenario.promise}`);
  } });
  const diagnostics = journeyBrowser(browser, {
    directory: join(evidenceDirectory(), key), capture: context => captureCreates(context, created, bodies),
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 }, storageState: authState });
    page = await context.newPage();
    page.on("dialog", dialog => dialog.accept());
    await authenticate(page);
    // A previous identity journey may have ended its SSO session. Refresh only this clean baseline.
    authState = await context.storageState();
    await withJourneyAuthentication(journey(key), () => journey(key).run({ page, base, designer, user: user1, folderId: rootId, name, created, write, pass: tracked.pass }));
    assert.deepEqual(diagnostics.errors, [], "uncaught browser errors");
  } catch (error) {
    failure = String(error?.stack ?? error).slice(0, 6000);
    record({ event: "fail", step: key, message: failure });
    console.error("FAILED JOURNEY:", key, failure);
  }
  const cleanupBegan = Date.now();
  let cleanupErrors;
  try { cleanupErrors = await removeFixtures(user1); }
  catch (error) { cleanupErrors = [String(error)]; }
  if (cleanupErrors.length) {
    failure ??= "fixture cleanup: " + cleanupErrors.join("; ");
    record({ event: "fail", step: key, message: failure });
  }
  if (!failure) {
    try { tracked.finish(); }
    catch (error) { failure = String(error.stack ?? error); record({ event: "fail", step: key, message: failure }); }
  }
  let evidence;
  try { evidence = await diagnostics.finish({ failure, scenarios: tracked.completed, cleanupErrors }); }
  catch (error) {
    failure ??= String(error.stack ?? error);
    evidence = error.evidence;
    cleanupErrors.push(...(error.teardownErrors ?? [String(error)]));
    record({ event: "fail", step: key, message: failure });
    console.error("FAILED JOURNEY:", key, error.message);
  }
  const cleanupSeconds = Math.round((Date.now() - cleanupBegan) / 100) / 10;
  if (evidence) console.error("Journey evidence: " + evidence.directory);
  running = false;
  record({ event: "done", step: key, checks: tracked.completed.length, scenarios: tracked.completed, cleanupErrors, evidence });
  const result = { key, name: key, kind: "journey", ok: !failure, outcome: stopping ? "interrupted" : failure ? "fail" : "pass",
    checks: tracked.completed.length, scenarios: tracked.completed, seconds: Math.round((Date.now() - began) / 100) / 10,
    cleanupSeconds, ...(failure ? { message: failure, failureCategory: failureCategory(failure, stopping ? "interrupted" : "fail") } : {}), cleanupErrors, evidence };
  results.push(result);
  return result;
}

let user1;
let failed = false;
const teardownErrors = [];
try {
  try {
    ({ user1 } = await actors());
    await setUp(user1);
  } catch (error) {
    failed = true;
    record({ event: "fail", step, message: String(error?.message ?? error).slice(0, 2000) });
    console.error("FAILED JOURNEY:", step);
    console.error(error?.stack ?? error);
    throw error;
  }
  if (worker) {
    await tell({ type: "ready", root: name, folderId: rootId });
    for (;;) {
      const message = await nextMessage();
      if (message?.type === "stop") break;
      if (message?.type !== "run") continue;
      assert.ok(journey(message.key), "No journey has the key " + message.key);
      const result = await runJourney(user1, message.key);
      await tell({ type: "result", ...result });
      if (!result.ok) {
        failed = true;
        break;
      }
      if (stopping) break;
    }
  } else {
    for (const key of selected) {
      const result = await runJourney(user1, key);
      if (!result.ok) {
        failed = true;
        break;
      }
      if (stopping) {
        failed = true;
        break;
      }
    }
  }
  if (!failed) step = enter("complete");
} catch {
  failed = true;
} finally {
  await browser?.close().catch(error => teardownErrors.push("Browser cleanup: " + error.message));
  // A timeline entry of its own, so the root's removal is not charged to the last journey.
  record({ event: "step", step: "cleanup" });
  if (user1) {
    try { teardownErrors.push(...(await removeFixtures(user1))); }
    catch (error) { teardownErrors.push(String(error)); }
  }
  if (rootId) {
    try {
      const removed = await mutate(user1.auth, "DELETE", "/folders/" + enc(rootId));
      if (![200, 204, 404].includes(removed.status)) teardownErrors.push(`folders/${rootId}: ${removed.status}`);
    } catch (error) { teardownErrors.push(`root fixture cleanup: ${error}`); }
  }
  record({ event: "end", step, checks, errors, cleanupErrors: teardownErrors });
  if (teardownErrors.length) console.error("Runner cleanup failed: " + teardownErrors.join("; "));
  else console.log("Focused journey fixtures removed");
  if (!worker) {
    const report = { inventoryMode: recordDirectory ? "candidate" : "verified", verdict: stopping ? "INTERRUPTED" : failed || teardownErrors.length ? "FAIL" : recordDirectory ? "CANDIDATE" : "PASS", seed: seed ?? null,
      selection: selected, units: results, cleanupErrors: teardownErrors, runtime: { browser: browser?.version() },
      notRun: selected.filter(key => !results.some(result => result.key === key)) };
    report.history = finishHistory(history, { ...report, reportPath });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`Journey report: ${reportPath}; history ${report.history.id}`);
    if (lock) release(lock.path, lock.holder);
  }
  if (process.connected) process.disconnect();
}
process.exitCode = failed || stopping || teardownErrors.length ? 1 : 0;
