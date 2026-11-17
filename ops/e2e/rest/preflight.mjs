import {writeFile, rename} from 'node:fs/promises';

// The gate may overlap the REST suites with browser journeys, but its initial
// inventory must finish before those journeys create their stamped fixtures.
export async function signalPreflight(path, runId, {
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!path) return;
  // Fixture names have one-second precision. The next lane must receive a stamp
  // strictly later than this run, including when authentication was cached.
  const nextSecond = Math.floor(now() / 1000) * 1000 + 1000;
  while (now() < nextSecond) await sleep(nextSecond - now());
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify({schemaVersion: 1, runId, preflightComplete: true}) + '\n');
  await rename(temporary, path);
}
