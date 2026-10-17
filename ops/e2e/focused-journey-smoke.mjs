// Runs self-contained journeys against the live stack, one after another on one page, without the
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
import { chromium } from "playwright";
import { actors, call, mutate, enc } from "./rest/lib.mjs";
import { captureCreates, recordCreate } from "./journey-fixtures.mjs";
import { JOURNEYS, journey } from "./journey-registry.mjs";
import { enter, noteFixture, record } from "./split-steps.mjs";

const args = process.argv.slice(2);
const worker = args.includes("--worker");
const rootArgument = args.find((argument) => argument.startsWith("--root="));
const selected = args.filter((argument) => !argument.startsWith("--"));
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

/** Signs in through the form and makes the root folder. */
async function setUp(user1) {
  step = enter("login");
  browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1500, height: 1000 },
  });
  context.setDefaultTimeout(25000);
  await captureCreates(context, created, bodies);
  page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/dashboard");
  await page
    .locator("#username")
    .fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || "test1@test.com");
  await page
    .locator("#password")
    .fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || "test1");
  await page.locator("#kc-login").click();
  await page.getByRole("button", { name: "New", exact: true }).waitFor();
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
  let journeyChecks = 0,
    failure = null;
  step = enter(key);
  errors.length = 0;
  running = true;
  try {
    await journey(key).run({
      page,
      base,
      designer,
      user: user1,
      folderId: rootId,
      name,
      created,
      write,
      pass: (message) => {
        journeyChecks++;
        checks++;
        console.log("PASS: " + message);
      },
    });
    // An error on the runner's page belongs to the journey that was running when it was thrown.
    assert.deepEqual(errors, [], "uncaught browser errors");
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 2000);
    record({ event: "fail", step: key, message: failure });
    console.error("FAILED JOURNEY:", key);
    console.error(error?.stack ?? failure);
    console.error(
      await page
        ?.locator("body")
        .innerText()
        .catch(() => "Page unavailable"),
    );
  } finally {
    running = false;
  }
  const cleanupBegan = Date.now();
  const cleanupErrors = await removeFixtures(user1);
  if (cleanupErrors.length && !failure) {
    failure = "fixture cleanup: " + cleanupErrors.join("; ");
    record({ event: "fail", step: key, message: failure });
  }
  // The journey's step ends here, so time spent waiting for the next key is not charged to it.
  record({ event: "done", step: key, checks: journeyChecks, cleanupErrors });
  const end = Date.now();
  return {
    key,
    ok: !failure,
    checks: journeyChecks,
    seconds: Math.round((end - began) / 100) / 10,
    cleanupSeconds: Math.round((end - cleanupBegan) / 100) / 10,
    ...(failure ? { message: failure } : {}),
    cleanupErrors,
  };
}

const { user1 } = await actors();
let failed = false;
const teardownErrors = [];
try {
  try {
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
  await browser?.close().catch(() => {});
  // A timeline entry of its own, so the root's removal is not charged to the last journey.
  record({ event: "step", step: "cleanup" });
  teardownErrors.push(...(await removeFixtures(user1)));
  if (rootId) {
    const removed = await mutate(user1.auth, "DELETE", "/folders/" + enc(rootId));
    if (![200, 204, 404].includes(removed.status)) teardownErrors.push(`folders/${rootId}: ${removed.status}`);
  }
  record({ event: "end", step, checks, errors, cleanupErrors: teardownErrors });
  if (teardownErrors.length) console.error("Fixture cleanup failed: " + teardownErrors.join("; "));
  else console.log("Focused journey fixtures removed");
  if (process.connected) process.disconnect();
}
process.exitCode = failed || stopping || teardownErrors.length ? 1 : 0;
