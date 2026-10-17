import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { journeyBrowser } from "./journey-browser.mjs";

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
    await page.setContent("<h1>Unfinished draft</h1>");
    page.emit("pageerror", new Error("Broken render"));
    const evidence = await diagnostics.finish({ failure: "Expected stored value", scenarios: [{ id: "edit" }] });
    assert.ok(evidence.files.some(path => path.endsWith(".zip") && existsSync(path)));
    assert.ok(evidence.files.some(path => path.endsWith(".png") && existsSync(path)));
    const report = JSON.parse(readFileSync(join(directory, "failure.json")));
    assert.deepEqual(report.scenarios, [{ id: "edit" }]);
    assert.deepEqual(report.browserErrors, ["Broken render"]);
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});
