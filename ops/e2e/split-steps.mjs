import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The split tier's runner names a file in CEDAR_SPLIT_STEPS, and a script it runs appends one JSON
// line per event there: the step it enters, the step it fails in, and how it ends. Run on its own,
// with no runner, a script records nothing.
//
// The runner also names a fixture ledger in CEDAR_SPLIT_FIXTURES. A script notes each fixture there as
// soon as the server has confirmed it, through the REST helper or a browser context's capture route,
// so that when the runner kills a process that has stopped answering, it can remove what that process
// made but never had the chance to remove itself. A change to a test user's own account goes with no
// fixture, so a script that makes one notes in the same ledger how to put it back, before it makes
// the change, and notes again once its own cleanup has put it back (user-state.mjs).
//
// Evidence, the screenshots and result files a script leaves for whoever reads a failure, goes to a
// directory of its own for each run: the one the runner names in CEDAR_SPLIT_EVIDENCE, or one the
// script makes the first time it writes. Two runs never write to the same path.
const file = process.env.CEDAR_SPLIT_STEPS;
const ledger = process.env.CEDAR_SPLIT_FIXTURES;
let current = null;
let ownEvidence = null;

export function record(fields) {
  if (!file) return;
  appendFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    script: process.env.CEDAR_SPLIT_SCRIPT ?? null,
    ...fields,
  }) + "\n");
}

/** Records the start of a step and returns its name, so a script keeps `step = enter("name")`. */
export function enter(step) {
  current = step;
  record({ event: "step", step });
  return step;
}

/**
 * Notes a fixture in the runner's ledger, under the step the script is in. `base` names the service
 * that holds it when that is not the resource server, as for a group.
 */
export function noteFixture({ collection, id, base } = {}) {
  if (typeof collection !== "string" || typeof id !== "string") return;
  note({ collection, id, ...(base ? { base } : {}) });
}

/**
 * Notes how to put back a change to a test user's own account, before the script makes it. The entry
 * names its restorer in `restore` and identifies itself by `key`; user-state.mjs builds it.
 */
export function noteRestore(entry) {
  if (typeof entry?.restore !== "string" || typeof entry.key !== "string") return;
  note(entry);
}

/** Notes that the script's own cleanup has put back the change a restore entry describes. */
export function noteRestored({ key } = {}) {
  if (typeof key !== "string") return;
  note({ restored: key });
}

/** Appends one entry to the runner's ledger, under the step the script is in. */
function note(fields) {
  if (!ledger) return;
  appendFileSync(ledger, JSON.stringify({
    at: new Date().toISOString(),
    script: process.env.CEDAR_SPLIT_SCRIPT ?? null,
    step: current,
    ...fields,
  }) + "\n");
}

/** The directory this process writes its evidence to, made when first asked for. */
export function evidenceDirectory() {
  const run = process.env.CEDAR_SPLIT_EVIDENCE;
  if (!run) {
    if (!ownEvidence) {
      ownEvidence = mkdtempSync(join(tmpdir(), "cedar-e2e-evidence-"));
      console.log("Evidence: " + ownEvidence);
    }
    return ownEvidence;
  }
  const directory = join(run, process.env.CEDAR_SPLIT_SCRIPT ?? "unnamed");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** A path for one piece of evidence, such as `failure.png`. */
export const evidencePath = name => join(evidenceDirectory(), name);
