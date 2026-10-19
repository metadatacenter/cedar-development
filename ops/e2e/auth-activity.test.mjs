import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { withAuthentication, withBrowserAuthentication, withJourneyAuthentication } from "./auth-activity.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "cedar-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path: join(directory, "authentication.lock"), retryMs: 5, timeoutMs: 5000 };
}

function child(t, options, body) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
    import { withAuthentication } from ${JSON.stringify(new URL("./auth-activity.mjs", import.meta.url).href)};
    import { writeFileSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const options = ${JSON.stringify(options)};
    ${body}
  `], { stdio: ["ignore", "pipe", "pipe"], env: { ...globalThis.process.env, CEDAR_SPLIT_STEPS: "" } });
  t.after(() => { if (process.exitCode === null) process.kill("SIGKILL"); });
  let stderr = "";
  process.stderr.on("data", data => { stderr += data; });
  const done = once(process, "close").then(([code]) => ({ code, stderr }));
  return { process, done };
}

test("independent processes cannot enter authentication together", async t => {
  const options = fixture(t);
  const children = Array.from({ length: 4 }, () => child(t, options, `
    for (let i = 0; i < 4; i++) await withAuthentication("contender", async () => {
      writeFileSync(options.path + ".critical", "occupied", { flag: "wx" });
      await delay(10);
      unlinkSync(options.path + ".critical");
    }, options);
  `));
  for (const result of await Promise.all(children.map(c => c.done))) assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(options.path), false);
});

test("concurrent calls in one process serialize, nested helpers do not deadlock", async t => {
  const options = fixture(t);
  let active = 0;
  await Promise.all(Array.from({ length: 5 }, () => withAuthentication("outer", async () => {
    assert.equal(++active, 1);
    assert.equal(await withAuthentication("nested", async () => 42, options), 42);
    await delay(5);
    active--;
  }, options)));
  assert.equal(active, 0);
});

test("a failed authentication releases its lock", async t => {
  const options = fixture(t);
  await assert.rejects(withAuthentication("failed login", async () => { throw new Error("refused"); }, options), /refused/);
  assert.equal(await withAuthentication("next login", async () => 42, options), 42);
  assert.equal(existsSync(options.path), false);
});

test("a live holder gives a bounded diagnostic failure; a killed holder is recovered", async t => {
  const options = fixture(t);
  const holder = child(t, options, `
    await withAuthentication("crashed login", async () => {
      process.stdout.write("held");
      await delay(30000);
    }, options);
  `);
  await once(holder.process.stdout, "data");
  await assert.rejects(withAuthentication("waiting login", async () => assert.fail("must not enter"),
    { ...options, timeoutMs: 30 }), /Authentication wait timed out for waiting login: PID/);
  holder.process.kill("SIGKILL");
  await holder.done;
  assert.equal(await withAuthentication("recovered login", async () => 42, options), 42);
  assert.equal(existsSync(options.path), false);
});

test("an unclassified journey cannot authenticate through a shared browser helper", async () => {
  await assert.rejects(async () => withJourneyAuthentication({ key: "undeclared", authentication: null }, async () => {
    await delay(1);
    await withBrowserAuthentication("shared helper", () => assert.fail("must be rejected before signing in"));
  }), /Journey undeclared authenticates.*no authentication reason/);
});
