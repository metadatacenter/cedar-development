import {test} from "node:test";
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {BOUND, JOURNEYS, journey} from "./journey-registry.mjs";

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

test("a file that signs the second user in has a flagged journey, and a flagged journey's file signs them in", () => {
  // A journey that signs the second user in fills the login form with the second user's login, named
  // outright or by its number, or calls signInSecondUser.
  const signsIn = file => /CEDAR_FRONTEND_local_USER(?:2|\$\{\w+\})_LOGIN|signInSecondUser\(/
    .test(readFileSync(join(here, file), "utf8"));
  const fileOf = new Map(files.flatMap(file => exported(file).map(name => [name, file])));
  for (const entry of JOURNEYS.filter(entry => entry.signsInAsAnotherUser))
    assert.ok(signsIn(fileOf.get(entry.run.name)), `${entry.key} is flagged, but its file never signs the second user in`);
  for (const file of files.filter(signsIn))
    assert.ok(JOURNEYS.some(entry => entry.signsInAsAnotherUser && fileOf.get(entry.run.name) === file),
      `${file} signs the second user in, but none of its journeys is flagged`);
  assert.equal(typeof JOURNEYS[0].signsInAsAnotherUser, "boolean");
});
