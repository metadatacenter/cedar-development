// The term picker's own answer validation, loaded from the sibling checkout of
// cedar-embeddable-term-picker, so that the term-search suite's copy of its rule can be compared
// with the rule itself. Null, with the reason, where the checkout or its dependencies are absent.
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CEDAR_HOME = env.CEDAR_HOME ?? resolve(HERE, '..', '..', '..', '..');
export const PICKER = resolve(CEDAR_HOME, 'cedar-embeddable-term-picker');
const SOURCE = resolve(PICKER, 'src', 'app', 'search', 'response-validation.ts');

let registered = false;

export async function pickerValidation() {
  if (!existsSync(SOURCE)) return { absent: `${SOURCE} is not checked out` };
  if (!existsSync(resolve(PICKER, 'node_modules', 'typescript'))) {
    return { absent: `${PICKER} has no installed dependencies; run npm ci there` };
  }
  if (!registered) {
    register('./picker-hooks.mjs', { parentURL: import.meta.url, data: { picker: PICKER } });
    registered = true;
  }
  return import(pathToFileURL(SOURCE).href);
}
