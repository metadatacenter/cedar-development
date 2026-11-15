// The steps a browser smoke script ran, for the gate that records the run.
//
// The smoke gate cannot tell from an exit code which checks a script made: a script that stops
// checking halfway and exits 0 looks like a pass. So each script names its steps here as it
// enters them, and when CEDAR_BROWSER_SMOKE_REPORTS names a directory it writes
// <script>.json there: its verdict, the steps it completed and the step it failed in. The gate
// compares the completed steps with browser-steps.json, the committed inventory.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function smokeSteps(script, environment = process.env) {
  const completed = [];
  let current = null;
  const write = (verdict) => {
    const directory = environment.CEDAR_BROWSER_SMOKE_REPORTS;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${script}.json`), JSON.stringify({
      schemaVersion: 1, script, verdict, steps: completed, failedStep: verdict === 'PASS' ? null : current,
    }, null, 2) + '\n');
  };
  return {
    /** Enter a step, completing the one before it, and return its name. */
    enter(step) {
      if (current !== null) completed.push(current);
      current = step;
      return step;
    },
    pass() {
      if (current !== null) completed.push(current);
      current = null;
      write('PASS');
    },
    fail() {
      write('FAIL');
    },
  };
}
