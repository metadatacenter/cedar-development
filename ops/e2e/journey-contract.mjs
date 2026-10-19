import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const scenarioKey = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const inventoryPath = new URL("./journey-scenarios.json", import.meta.url);
export const inventory = () => JSON.parse(readFileSync(inventoryPath, "utf8"));
export const inventoryDigest = () => createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");

/** Stable scenario IDs are independent of their explanatory prose. A successful early return is a failure. */
export function scenarioTracker(key, { expected = inventory()[key], recordDirectory, emit = () => {} } = {}) {
  if (!recordDirectory) assert.ok(expected?.length, `No scenario inventory for ${key}`);
  const completed = [], seen = new Set();
  return {
    completed,
    pass(id, promise) {
      assert.equal(typeof promise, "string", `${key}: pass needs an explicit scenario ID and user promise`);
      id = scenarioKey(id);
      assert.ok(id && !seen.has(id), `${key}: duplicate or empty scenario ID ${id}`);
      if (!recordDirectory) assert.ok(expected.some(item => item.id === id), `${key}: unexpected scenario ${id}`);
      seen.add(id);
      const scenario = { id, promise };
      completed.push(scenario);
      emit(scenario);
    },
    finish() {
      assert.ok(completed.length, `${key}: no scenarios executed`);
      if (recordDirectory) {
        mkdirSync(recordDirectory, { recursive: true });
        writeFileSync(join(recordDirectory, key + ".json"), JSON.stringify(completed, null, 2) + "\n");
      } else {
        assert.deepEqual(completed.map(item => item.id), expected.map(item => item.id),
          `${key}: scenario inventory differs (missing, reordered or repeated cases)`);
      }
    },
  };
}

/** Reproducible Fisher–Yates order; does not depend on timings or the host's random source. */
export function shuffled(items, seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  let state = digest.readUInt32LE(0) || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
