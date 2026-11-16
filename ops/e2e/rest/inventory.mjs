// The committed check inventory and the checks retired from it.
//
// expected-checks.json lists every check identity a passing run executes, in order, and the runner
// regenerates it from a passing run with --update-inventory. Because identities are names, a commit
// can delete a failing check together with its inventory entry and still pass every later run.
// retired-checks.json closes that: each identity an update drops must be named there with the reason
// it went, and the gate refuses an inventory that has lost an identity its last passing run executed
// unless the same list names it.
import { readFileSync } from 'node:fs';

export const SEPARATOR = '\u001f';

/** How many times each identity occurs, since one identity may be recorded more than once. */
export function counts(identities) {
  const result = new Map();
  for (const identity of identities) result.set(identity, (result.get(identity) ?? 0) + 1);
  return result;
}

/** The identities `from` holds more often than `to`, each as often as it is short. */
export function lost(from, to) {
  const remaining = counts(to);
  const result = [];
  for (const identity of from) {
    const left = remaining.get(identity) ?? 0;
    if (left > 0) remaining.set(identity, left - 1);
    else result.push(identity);
  }
  return result;
}

/** The retired identities, each mapped to its reason. Refuses a list in any other shape. */
export function readRetired(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const entries = payload?.version === 1 ? payload.checks : undefined;
  if (!Array.isArray(entries)) throw new Error(`${path} is not a version 1 list of retired checks`);
  const retired = new Map();
  for (const entry of entries) {
    const values = ['suite', 'section', 'name', 'reason'].map(key => entry?.[key]);
    if (!values.every(value => typeof value === 'string' && value.trim())) {
      throw new Error(`${path} has an entry without a suite, section, name and reason: ${JSON.stringify(entry)}`);
    }
    retired.set(values.slice(0, 3).join(SEPARATOR), values[3]);
  }
  return retired;
}

/** The identities `previous` holds that `next` has lost and the retired list does not name. */
export function unretiredDrops(previous, next, retired) {
  return lost(previous, next).filter(identity => !retired.has(identity));
}
