import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { collectPageErrors, journeyBrowser } from "./journey-browser.mjs";
import { dashboardAddress, openListing, listingIdle, focused, rendered, waitForState, tabKey } from "./journey-fixtures.mjs";
import { ready, listing, navigate } from "./workspace-journey-fixtures.mjs";

test("listing setup in independent contexts never writes another journey's saved preferences", async () => {
  let preferences = {viewMode: "grid", resourceTypes: ["folder"], sortDirection: "desc"};
  const original = structuredClone(preferences), writes = [];
  const server = createServer(async (request, response) => {
    if (request.method === "PUT") {
      let body = "";
      for await (const chunk of request) body += chunk;
      preferences = JSON.parse(body);
      writes.push(preferences);
      response.end("{}");
    } else if (request.url.startsWith("/folders/")) response.end("{}");
    else response.end(`<button>New</button><button id="list" aria-pressed="false">List view</button>
      <div class="table-scroll" aria-busy="true"></div><script>
      const list = document.querySelector('#list');
      const choose = () => list.setAttribute('aria-pressed', 'true');
      if (new URL(location.href).searchParams.get('view') === 'list') choose();
      list.onclick = async () => {
        await fetch('/users/u1', {method: 'PUT', body: JSON.stringify({viewMode: 'list', resourceTypes: [], sortDirection: 'asc'})});
        choose();
      };
      fetch('/folders/root/contents').then(() => document.querySelector('.table-scroll').setAttribute('aria-busy', 'false'));
      </script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  try {
    const first = await (await browser.newContext()).newPage(), second = await (await browser.newContext()).newPage();
    await Promise.all([openListing(first, base, "root"), listing(second, base, "root")]);
    await first.goto(base + "/dashboard?folderId=root&sort=-name&resource_types=folder");
    await ready(first); // Also exercise setup after a navigation that has no view parameter.
    assert.equal(new URL(first.url()).searchParams.get("sort"), "-name");
    assert.equal(new URL(first.url()).searchParams.get("resource_types"), "folder");
    await ready(first); // Already in list view: the old helper still clicked and wrote.
    assert.deepEqual(writes, []);
    assert.deepEqual(preferences, original);
    assert.equal(new URL(dashboardAddress(base)).searchParams.get("view"), "list");
    // Prove the stand-in detects the actual regression: a control click overwrites all preferences.
    await Promise.all([first.waitForResponse(answer => answer.request().method() === "PUT"),
      first.getByRole("button", {name: "List view", exact: true}).click()]);
    assert.equal(writes.length, 1);
    assert.notDeepEqual(preferences, original);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test("success closes all journey contexts and isolates routes, storage, cookies and pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-isolation-test-"));
  const server = createServer((request, response) => response.end("<h1>Real response</h1>"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const original = browser.newContext;
    const first = journeyBrowser(browser, { directory: join(directory, "first") });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(() => { localStorage.setItem("draft", "old"); sessionStorage.setItem("draft", "old"); document.cookie = "draft=old"; });
    await context.route("**/*", route => route.fulfill({ body: "Leaked route" }));
    await browser.newContext(); // A journey forgot to close its secondary context.
    await first.finish();
    assert.equal(browser.newContext, original);
    assert.equal(browser.contexts().length, 0);
    assert.equal(existsSync(join(directory, "first")), false);
    const second = journeyBrowser(browser, { directory: join(directory, "second") });
    const fresh = await browser.newContext();
    const clean = await fresh.newPage();
    await clean.goto(base);
    assert.match(await clean.locator("body").innerText(), /Real response/);
    assert.deepEqual(await clean.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ""]);
    await second.finish();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});

test("failure retains a trace, screenshot, page text, completed scenarios and browser errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-evidence-test-"));
  const browser = await chromium.launch();
  try {
    const diagnostics = journeyBrowser(browser, { directory });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<h1>Unfinished draft</h1><div id=editor></div>");
    await page.evaluate(() => {
      document.querySelector("#editor").attachShadow({ mode: "open" }).innerHTML =
        '<label>Notes<input value="Uncommitted answer"></label>';
    });
    page.emit("pageerror", new Error("Broken render"));
    const evidence = await diagnostics.finish({ failure: "Expected stored value", scenarios: [{ id: "edit" }] });
    assert.ok(evidence.files.some(path => path.endsWith(".zip") && existsSync(path)));
    assert.ok(evidence.files.some(path => path.endsWith(".png") && existsSync(path)));
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.deepEqual(report.scenarios, [{ id: "edit" }]);
    assert.deepEqual(report.browserErrors, ["Broken render"]);
    assert.match(readFileSync(join(directory, "context-1-page-1.aria.yml"), "utf8"), /Uncommitted answer/);
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Change the underlying context operations before journeyBrowser wraps them, as an actual transport
// failure would. The browser and its other contexts are real, so continued cleanup is observable.
async function withFaultyContext(work, fault, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "journey-teardown-test-"));
  const browser = await chromium.launch();
  const create = browser.newContext.bind(browser);
  let index = 0;
  browser.newContext = async (...args) => {
    const context = await create(...args);
    if (++index === 1) fault(context);
    return context;
  };
  const original = browser.newContext;
  const diagnostics = journeyBrowser(browser, { directory, ...options });
  try { await work({ browser, diagnostics, directory }); }
  finally {
    try { assert.equal(browser.newContext, original, "finish restores context creation even when cleanup fails"); }
    finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
  }
}

test("a close failure rejects an otherwise-passing finish, retains evidence and closes other contexts", async () => {
  await withFaultyContext(async ({ browser, diagnostics, directory }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<label>Draft<input value='Keep this answer'></label>");
    await browser.newContext();
    const error = await diagnostics.finish({ scenarios: [{ id: "save" }] }).catch(error => error);
    assert.match(error.message, /Browser teardown failed.*close refused/);
    assert.equal(browser.contexts().length, 1, "other contexts still close");
    assert.equal(browser.contexts()[0], context);
    assert.ok(error.evidence.files.some(path => path.endsWith(".zip") && existsSync(path)));
    assert.ok(error.evidence.files.some(path => path.endsWith(".png") && existsSync(path)));
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.deepEqual(report.scenarios, [{ id: "save" }]);
    assert.match(report.teardownErrors[0], /context-1 close-error: close refused/);
    assert.match(readFileSync(join(directory, "context-1-page-1.aria.yml"), "utf8"), /Keep this answer/);
  }, context => { context.close = async () => { throw new Error("close refused"); }; });
});

test("a caught close failure is retried but remains a failure and preserves the original assertion", async () => {
  let attempts = 0;
  await withFaultyContext(async ({ browser, diagnostics, directory }) => {
    const context = await browser.newContext();
    await (await context.newPage()).setContent("<h1>Draft at failed close</h1>");
    await assert.rejects(context.close(), /temporary close failure/);
    await assert.rejects(diagnostics.finish({ failure: "Original save assertion" }), /Browser teardown failed/);
    assert.equal(attempts, 2, "a failed close is not marked closed");
    assert.equal(browser.contexts().length, 0);
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.equal(report.failure, "Original save assertion");
    assert.match(report.teardownErrors[0], /temporary close failure/);
  }, context => {
    const close = context.close.bind(context);
    context.close = async () => {
      if (++attempts === 1) throw new Error("temporary close failure");
      await close();
    };
  });
});

test("trace finalization failure retains available evidence and does not prevent context cleanup", async () => {
  await withFaultyContext(async ({ browser, diagnostics, directory }) => {
    const context = await browser.newContext();
    await (await context.newPage()).setContent("<h1>Unfinished trace</h1>");
    await assert.rejects(diagnostics.finish(), /Browser teardown failed.*trace refused/);
    assert.equal(browser.contexts().length, 0);
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.match(report.teardownErrors[0], /context-1 trace-error: trace refused/);
    assert.ok(report.files.some(path => path.endsWith(".png") && existsSync(path)));
  }, context => { context.tracing.stop = async () => { throw new Error("trace refused"); }; });
});

test("a browser error arriving during close cannot turn into a passing journey", async () => {
  await withFaultyContext(async ({ browser, diagnostics, directory }) => {
    const context = await browser.newContext();
    await (await context.newPage()).setContent("<h1>Late browser error</h1>");
    await assert.rejects(diagnostics.finish(), /Uncaught browser errors: late render/);
    assert.equal(browser.contexts().length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "failure.json"))).browserErrors, ["late render"]);
  }, context => {
    const close = context.close.bind(context);
    context.close = async () => {
      context.pages()[0].emit("pageerror", new Error("late render"));
      await close();
    };
  });
});

test("a context whose initialization fails is still closed without masking the original failure", async () => {
  await withFaultyContext(async ({ browser, diagnostics, directory }) => {
    await assert.rejects(browser.newContext(), /capture setup failed/);
    const evidence = await diagnostics.finish({ failure: "capture setup failed" });
    assert.equal(browser.contexts().length, 0);
    assert.ok(evidence.files.includes(join(directory, "failure.json")));
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.equal(report.failure, "capture setup failed");
    assert.deepEqual(report.teardownErrors, []);
  }, () => {}, { capture: async () => { throw new Error("capture setup failed"); } });
});


for (const [engine, type] of Object.entries({chromium, firefox, webkit})) {
  test(`${engine}: state helpers await conditions and frames with a patched page Promise`, async () => {
    const browser = await type.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.setContent('<div class="table-scroll" aria-busy="true"></div><input aria-label="Name">');
      await page.evaluate(() => {
        const NativePromise = Promise;
        // A non-native thenable reproduces the relevant Zone.js contract without loading Angular.
        window.Promise = class PatchedPromise {
          constructor(executor) { this.inner = new NativePromise(executor); }
          then(resolve, reject) { return this.inner.then(resolve, reject); }
          catch(reject) { return this.inner.catch(reject); }
        };
        window.pendingFrames = [];
        window.requestAnimationFrame = callback => { window.pendingFrames.push(callback); return window.pendingFrames.length; };
      });
      let painted = false, idle = false, hasFocus = false, stateReady = false;
      const state = waitForState(page, () => window.recovered === true).then(() => { stateReady = true; });
      const painting = rendered(page).then(() => { painted = true; });
      const listing = listingIdle(page).then(() => { idle = true; });
      const focus = focused(page.getByRole('textbox'), 'input never received focus').then(() => { hasFocus = true; });
      // Give each waiter a chance to return incorrectly while every condition is held false.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual([painted, idle, hasFocus, stateReady], [false, false, false, false]);
      await page.evaluate(() => window.pendingFrames.shift()(performance.now()));
      assert.equal(painted, false, 'one animation frame is not a completed render');
      await page.evaluate(() => {
        window.pendingFrames.shift()(performance.now());
        document.querySelector('.table-scroll').setAttribute('aria-busy', 'false');
        document.querySelector('input').focus();
        window.recovered = true;
      });
      await Promise.all([painting, listing, focus, state]);
      assert.deepEqual([painted, idle, hasFocus, stateReady], [true, true, true, true]);
    } finally { await browser.close(); }
  });
}

for (const [engine, type] of Object.entries({chromium, firefox, webkit})) {
  test(`${engine}: platform Tab gestures reach native buttons in both directions`, async () => {
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<input aria-label="Before"><button>Save</button><input aria-label="After">');
      await page.getByRole('textbox', {name: 'Before'}).focus();
      await page.keyboard.press(tabKey(page));
      await focused(page.getByRole('button', {name: 'Save'}), 'forward keyboard navigation reaches Save');
      await page.keyboard.press(tabKey(page));
      await focused(page.getByRole('textbox', {name: 'After'}), 'forward keyboard navigation reaches the next field');
      await page.keyboard.press(tabKey(page, true));
      await focused(page.getByRole('button', {name: 'Save'}), 'reverse keyboard navigation reaches Save');
    } finally { await browser.close(); }
  });
}

test("an error raised in Keycloak's session-check frame is noted and not counted as the page's", () => {
  // Firefox reported this on tab-isolation@firefox after both of its scenarios had passed: a tab
  // closed while the frame's own fetch was in flight.
  const page = new EventEmitter(), errors = [], events = [];
  collectPageErrors(page, errors, event => events.push(event));
  const message = "NetworkError when attempting to fetch resource.";
  const raised = stack => Object.assign(new TypeError(message), { stack: `TypeError: ${message}\n    at ${stack}` });
  page.emit("pageerror", raised("onMessage (https://auth.metadatacenter.orgx/realms/CEDAR/protocol/openid-connect/login-status-iframe.html:24:37)"));
  assert.deepEqual(errors, []);
  page.emit("pageerror", raised("load (https://workspace.metadatacenter.orgx/workspace-build/main.js:1:1)"));
  assert.deepEqual(errors, [message]);
  assert.deepEqual(events, [
    { type: "identity-provider-frame-error", message },
    { type: "pageerror", message },
  ]);
});

test("a navigation that another navigation overtakes is requested again, and any other failure is not", async () => {
  // WebKit refused designer-navigation@webkit's listing this way while Workspace added the
  // selection to its own address.
  const interrupted = () => new Error(
    'page.goto: Navigation to "https://w/dashboard?folderId=f" is interrupted by another navigation to "https://w/dashboard?folderId=f&selected=t"');
  const page = failures => {
    const calls = [];
    return { calls, goto: async (...call) => { calls.push(call); if (failures.length) throw failures.shift(); return "answered"; } };
  };
  const once = page([interrupted()]);
  assert.equal(await navigate(once, "https://w/dashboard?folderId=f"), "answered");
  assert.deepEqual(once.calls, Array(2).fill(["https://w/dashboard?folderId=f", { waitUntil: "domcontentloaded" }]));
  const always = page([interrupted(), interrupted(), interrupted()]);
  await assert.rejects(navigate(always, "https://w/dashboard"), /interrupted by another navigation/);
  assert.equal(always.calls.length, 3);
  const refused = page([new Error("page.goto: net::ERR_CONNECTION_REFUSED")]);
  await assert.rejects(navigate(refused, "https://w/dashboard"), /ERR_CONNECTION_REFUSED/);
  assert.equal(refused.calls.length, 1);
});
