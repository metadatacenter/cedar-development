// Removes artifacts left behind by smoke runs that failed before their teardown step.
// Deletes in dependency order and reports each outcome; ids come in on the command line.
import { actors, call, enc } from './rest/lib.mjs';

const { user1 } = await actors();
const PATHS = {
  instance: '/template-instances',
  template: '/templates',
  element: '/template-elements',
  field: '/template-fields',
  folder: '/folders',
};

const items = JSON.parse(process.argv[2] ?? '[]'); // [[type, name, id], ...]
// Elements come after the templates that embed them and before the folders that
// hold them. Leaving them out did not skip three deletes quietly — a folder still
// holding an element cannot be removed, so every folder above one survived too.
const order = ['instance', 'template', 'element', 'field', 'folder'];

const unknown = items.filter(([t]) => !PATHS[t]).map(([t]) => t);
if (unknown.length) {
  console.log(`refusing to run: no path for type(s) ${[...new Set(unknown)].join(', ')}`);
  process.exit(1);
}

for (const type of order) {
  for (const [t, name, id] of items) {
    if (t !== type) continue;
    const res = await call(user1.auth, 'DELETE', `${PATHS[type]}/${enc(id)}`);
    console.log(`${res.status === 204 || res.status === 200 ? 'ok  ' : 'FAIL'} ${type} ${res.status} ${name}`);
    if (res.status >= 400) console.log(`      ${res.text.slice(0, 200)}`);
  }
}
