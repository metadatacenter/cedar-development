import {test} from "node:test";
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {BOUND, JOURNEYS, LISTING_PREFERENCES, journey} from "./journey-registry.mjs";

// The runners and the split tier's lanes know a journey only through the registry, so a journey it
// does not list is one that no run executes.
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(name => name.endsWith("-journey.mjs"));
const exported = file => [...readFileSync(join(here, file), "utf8")
  .matchAll(/^export\s+(?:async\s+function\s+|function\s+|const\s+)(\w+Journey)\b/gm)].map(match => match[1]);

test("every journey a journey file exports is registered under a key or bound to its runner", () => {
  const registered = new Set(JOURNEYS.map(entry => entry.run.name));
  const missing = files.flatMap(file => exported(file)
    .filter(name => !registered.has(name) && !BOUND.includes(name))
    .map(name => `${file}: ${name}`));
  assert.deepEqual(missing, [], "add these to journey-registry.mjs");
});

test("every journey file holds at least one journey", () => {
  assert.deepEqual(files.filter(file => !exported(file).length), []);
});

test("every key and every journey appears once", () => {
  const keys = JOURNEYS.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(JOURNEYS.map(entry => entry.run)).size, JOURNEYS.length);
  assert.ok(JOURNEYS.every(entry => typeof entry.run === "function" && /^[a-z]+(-[a-z]+)*$/.test(entry.key)));
  assert.ok(keys.every(key => journey(key)?.key === key));
  assert.equal(journey("no-such-journey"), undefined);
});

test("browser authentication is classified, including same-user recovery", () => {
  const signsIn = file => /withBrowserAuthentication\(|signInSecondUser\(/
    .test(readFileSync(join(here, file), "utf8"));
  const fileOf = new Map(files.flatMap(file => exported(file).map(name => [name, file])));
  for (const entry of JOURNEYS.filter(entry => entry.authentication)) {
    assert.equal(typeof entry.authentication, "string", entry.key);
    assert.ok(signsIn(fileOf.get(entry.run.name)), `${entry.key} declares authentication but has no browser sign-in helper`);
  }
  for (const file of files.filter(signsIn))
    assert.ok(JOURNEYS.some(entry => entry.authentication && fileOf.get(entry.run.name) === file),
      `${file} authenticates, but none of its journeys declares why`);
  for (const key of ["draft-recovery", "uncertain-create"])
    assert.equal(journey(key).authentication, "reauthenticates the first user");
  for (const key of ["metadata-reconciliation", "uncertain-workspace-create", "uncertain-version"])
    assert.equal(journey(key).authentication, null, "non-authenticating siblings remain parallel");
});

test("explicit browser login sites in the parallel tier use the shared authentication helper", () => {
  const scripts = ["focused-journey-smoke.mjs", "modern-workspace-smoke.mjs", "workspace-journey-fixtures.mjs",
    "ced-host-smoke.mjs", "account-pages-smoke.mjs", "workspace-lifecycle-smoke.mjs"];
  for (const file of [...files, ...scripts]) {
    const source = readFileSync(join(here, file), "utf8");
    if (source.includes("#kc-login"))
      assert.match(source, /withBrowserAuthentication\(/, `${file}: wrap explicit sign-in through authenticated readiness`);
  }
});

test("whatever a journey makes in the second user's home is named after the root it was given", () => {
  // When the split tier kills a lane's journey runner, its sweep finds the second user's fixtures by
  // that name, since only the first user's root holds the rest.
  const creates = files.flatMap(file => [...readFileSync(join(here, file), "utf8")
    .matchAll(/call\(\s*user2\.auth,\s*["']POST["'][\s\S]*?\}\)/g)].map(match => ({file, text: match[0]})));
  assert.ok(creates.length, "partial-version-draft creates a folder in the second user's home");
  for (const {file, text} of creates)
    assert.match(text, /\bname:\s*name\s*\+\s*["']/, `${file}: ${text.slice(0, 200)}`);
});

// The manifest is reviewed separately from execution, so removing a loop case does not update it.
test("every selectable journey has a complete, unique scenario inventory", async () => {
  const { inventory, scenarioKey } = await import("./journey-contract.mjs");
  const expected = inventory();
  assert.deepEqual(Object.keys(expected).sort(), JOURNEYS.map(entry => entry.key).sort());
  for (const [key, cases] of Object.entries(expected)) {
    assert.ok(cases.length, key);
    assert.equal(new Set(cases.map(item => item.id)).size, cases.length, key);
    assert.ok(cases.every(item => item.id === scenarioKey(item.id) && item.promise.length > 10), key);
  }
});

test("a journey that puts listing preferences back declares that it shares them", () => {
  // keepingListingPreferences restores the account's preferences when the journey ends, which would
  // undo what another journey changing them is in the middle of checking.
  const undeclared = JOURNEYS
    .filter(entry => entry.run.toString().includes("keepingListingPreferences"))
    .filter(entry => entry.shares !== LISTING_PREFERENCES)
    .map(entry => entry.key);
  assert.deepEqual(undeclared, []);
  assert.deepEqual(JOURNEYS.filter(entry => entry.shares === LISTING_PREFERENCES).map(entry => entry.key).sort(),
    ["metadata-return-context", "workspace-keyboard-folders", "workspace-listing-preferences", "workspace-type-filter"]);
});
