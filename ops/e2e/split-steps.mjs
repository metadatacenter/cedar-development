import { appendFileSync } from "node:fs";

// The split tier's runner names a file in CEDAR_SPLIT_STEPS, and a script it runs appends one JSON
// line per event there: the step it enters, the step it fails in, and how it ends. Run on its own,
// with no runner, a script records nothing.
const file = process.env.CEDAR_SPLIT_STEPS;

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
  record({ event: "step", step });
  return step;
}
