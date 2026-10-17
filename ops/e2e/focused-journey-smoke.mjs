// Runs self-contained journeys against the live stack, one after another on one page, without the
// inline chain of the full Workspace smoke and the fixtures it provisions.
//
//   node focused-journey-smoke.mjs [--root=NAME] <key>...
//
// The keys are those of journey-registry.mjs, and each runs once. The journeys work under a root
// folder in the first test user's home, named "Focused journey <stamp>" unless --root names it. The
// split tier runs one of these processes per lane and gives each lane a root of its own. Under the
// split tier's runner the process records each journey as a step through split-steps.mjs.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { actors, call, mutate, enc } from "./rest/lib.mjs";
import { captureCreates, recordCreate } from "./journey-fixtures.mjs";
import { JOURNEYS, journey } from "./journey-registry.mjs";
import { enter, record } from "./split-steps.mjs";

const args = process.argv.slice(2);
const rootArgument = args.find((argument) => argument.startsWith("--root="));
const selected = args.filter((argument) => !argument.startsWith("--"));
assert.ok(
  selected.length && selected.every((key) => journey(key)),
  "Choose: " + JOURNEYS.map((entry) => entry.key).join(", "),
);
assert.equal(new Set(selected).size, selected.length, "Each journey runs once");
const name = rootArgument ? rootArgument.slice("--root=".length) : "Focused journey " + Date.now();
assert.ok(name, "--root names the root folder");
const base = process.env.CEDAR_BASE || "https://workspace.metadatacenter.orgx";
const designer =
  process.env.CEDAR_DESIGNER_BASE || "https://designer.metadatacenter.orgx";
const { user1 } = await actors();
const browser = await chromium.launch({ headless: !process.env.HEADED });
const created = [],
  errors = [],
  bodies = new Map();
let page,
  step = "login",
  checks = 0;
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
try {
  step = enter("login");
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
  created.push({ collection: "folders", id: folder.body["@id"] });
  for (const key of selected) {
    step = enter(key);
    await journey(key).run({
      page,
      base,
      designer,
      user: user1,
      folderId: folder.body["@id"],
      name,
      created,
      write,
      pass: (message) => {
        checks++;
        console.log("PASS: " + message);
      },
    });
    // An error on the runner's page belongs to the journey that was running when it was thrown.
    assert.deepEqual(errors, [], "uncaught browser errors");
  }
  step = enter("complete");
} catch (error) {
  record({ event: "fail", step, message: String(error?.message ?? error).slice(0, 2000) });
  console.error("FAILED JOURNEY:", step);
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "Page unavailable"),
  );
  throw error;
} finally {
  await browser.close();
  // A timeline entry of its own, so cleanup's time is not charged to the last journey.
  record({ event: "step", step: "cleanup" });
  const failures = [];
  // An identity recorded from a create attempt may never have committed, so 404 is a clean end state.
  for (const item of created.reverse()) {
    const removed = await mutate(
      user1.auth,
      "DELETE",
      "/" + item.collection + "/" + enc(item.id),
    );
    if (![200, 204, 404].includes(removed.status))
      failures.push(`${item.collection}/${item.id}: ${removed.status}`);
  }
  record({ event: "end", step, checks, errors, cleanupErrors: failures });
  assert.deepEqual(failures, [], "fixture cleanup");
  console.log("Focused journey fixtures removed");
}
