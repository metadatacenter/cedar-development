// A UI review capture shows part of each application. The catalog says which states a capture must
// hold, but not what those states leave out. Two measures, neither of which costs model tokens, say
// that: a census of the components each captured state renders, held against every component the
// source declares, and, under Chromium, the share of each served script the capture ran.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {createHash} from 'node:crypto';

// The reviewed applications render components from these repositories, each declared under its root.
// A package that registers custom elements renders its root components under those elements' tags,
// never under their Angular selectors, so each such tag is listed with the selector it stands for, or
// with null where the component's selector is a constant holding the tag itself.
export const COMPONENT_SOURCES = [
  {repository: 'cedar-workspace', root: 'cedar-workspace/src'},
  {repository: 'cedar-embeddable-editor', root: 'cedar-embeddable-editor/src', elements: {
    'cedar-embeddable-editor': 'app-cedar-embeddable-metadata-editor-wrapper',
    'cedar-embeddable-field': 'app-cedar-embeddable-field-wrapper'}},
  {repository: 'cedar-embeddable-designer', root: 'cedar-embeddable-designer/src', elements: {
    'cedar-embeddable-designer': 'app-cedar-embeddable-designer-element',
    'cedar-embeddable-field-designer': 'app-cedar-embeddable-field-designer-element'}},
  {repository: 'cedar-embeddable-term-picker', root: 'cedar-embeddable-term-picker/src', elements: {
    'cedar-embeddable-term-picker': null}},
  {repository: 'cedar-openview', root: 'cedar-openview/cedar-openview-src/src'},
];

// Declared components no capture can show, each with the reason. The census still reports them,
// apart from the components it counts, so an exemption that stops being true is visible.
export const UNCAPTURABLE = {
  'app-cedar-font-registrar': 'Registers the CEDAR fonts with the page and renders nothing of its own.',
  'ced-font-registrar': 'Registers the CEDAR fonts with the page and renders nothing of its own.',
  'cetp-font-registrar': 'Registers the CEDAR fonts with the page and renders nothing of its own.',
  'app-dashboard': 'OpenView\'s root page, which sends the browser to the CEDAR home page as soon as it loads.',
  'cedar-logout-page': 'Shows only while the browser navigates to the authentication server, and a page cannot be read during a navigation.',
};

// The census lists every custom element in the page, its shadow roots included, and says whether
// any instance is on screen. An element is on screen when it, or something inside it, has a size,
// is not hidden and lies at least partly in the viewport. A host laid out with display: contents, or
// one whose dialog sits in the top layer, has no box of its own, so what it holds decides.
export async function renderedComponents(page) {
  return page.evaluate(() => {
    const present = new Set(), visible = new Set();
    const onScreen = element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
        && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    };
    const shown = host => {
      const pending = [host];
      for (let looked = 0; pending.length && looked < 500; looked++) {
        const element = pending.pop();
        if (onScreen(element)) return true;
        pending.push(...element.children, ...(element.shadowRoot?.children ?? []));
      }
      return false;
    };
    const walk = root => {
      for (const node of root.querySelectorAll('*')) {
        if (node.localName.includes('-')) {
          present.add(node.localName);
          if (!visible.has(node.localName) && shown(node)) visible.add(node.localName);
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);
    return {present: [...present].sort(), visible: [...visible].sort()};
  });
}

// V8 reports each function's ranges nested, outermost first, and an inner function as an entry of
// its own. Applying every range from the widest to the narrowest therefore leaves each byte marked
// by the innermost range that holds it.
function executedMask(length, functions) {
  const ranges = functions.flatMap(fn => fn.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  const ran = new Uint8Array(length);
  for (const {startOffset, endOffset, count} of ranges) ran.fill(count > 0 ? 1 : 0, Math.max(0, startOffset), Math.min(length, endOffset));
  return ran;
}

export function executedBytes(length, functions) {
  return executedMask(length, functions).reduce((sum, byte) => sum + byte, 0);
}

// Periodically drain Chromium's profiler so it does not retain every navigated document. Keep
// only a byte mask per distinct source, unioning execution across samples without keeping sources
// or function histories. Different served versions remain separate even at the same URL.
export class ScriptCoverageAccumulator {
  scripts = new Map();
  add(entries) {
    for (const entry of entries) {
      if (!/^https?:/.test(entry.url) || typeof entry.source !== 'string') continue;
      const url = new URL(entry.url), address = url.origin + url.pathname;
      const sha256 = createHash('sha256').update(entry.source).digest('hex');
      const key = address + ':' + sha256;
      const ran = executedMask(entry.source.length, entry.functions);
      const row = this.scripts.get(key);
      if (row) for (let i = 0; i < ran.length; i++) row.ran[i] |= ran[i];
      else this.scripts.set(key, {url: address, sha256, ran});
    }
  }
  report() {
    const rows = [...this.scripts.values()].map(({url, sha256, ran}) => {
      const bytes = ran.length, executed = ran.reduce((sum, byte) => sum + byte, 0);
      return {url, sha256, bytes, executedBytes: executed, executedPercent: percent(executed, bytes)};
    }).sort((a, b) => b.bytes - a.bytes);
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0), executed = rows.reduce((sum, row) => sum + row.executedBytes, 0);
    return {scripts: rows, total: {bytes, executedBytes: executed, executedPercent: percent(executed, bytes)}};
  }
}

export function scriptCoverage(entries) {
  const accumulator = new ScriptCoverageAccumulator();
  accumulator.add(entries);
  return accumulator.report();
}

const percent = (part, whole) => whole ? Math.round(1000 * part / whole) / 10 : 0;

// The inventory reads element selectors from Angular component and directive declarations outside
// tests. An attribute selector names no element, so a census of elements cannot see it, and the
// inventory lists it apart.
export async function declaredComponents(home, sources = COMPONENT_SOURCES) {
  const components = [], attributes = [];
  for (const {repository, root, elements = {}} of sources) {
    const directory = join(home, root);
    let files;
    try {files = await readdir(directory, {recursive: true});} catch {continue;}
    const replaced = new Map(Object.entries(elements).filter(([, selector]) => selector).map(([tag, selector]) => [selector, tag]));
    const tags = new Set(), texts = [];
    for (const file of files.filter(name => /\.ts$/.test(name) && !/\.(spec|dev)\.ts$/.test(name)).sort()) {
      const text = await readFile(join(directory, file), 'utf8');
      texts.push(text);
      for (const [, selector] of text.matchAll(/selector:\s*['"]([^'"]+)['"]/g))
        for (const part of selector.split(',').map(s => s.trim())) {
          const row = {selector: part, repository, file: relative(home, join(directory, file))};
          if (!/^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(part)) {attributes.push(row); continue;}
          // A font build and a host-fonts build can declare the same selector; it is one component.
          const tag = replaced.get(part) ?? part;
          if (!tags.has(tag)) {tags.add(tag); components.push({...row, tag});}
        }
    }
    for (const [tag, selector] of Object.entries(elements)) {
      if (!texts.some(text => text.includes(`'${tag}'`) || text.includes(`"${tag}"`)))
        throw new Error(`${repository} no longer registers the custom element ${tag}`);
      if (selector && !replaced.has(selector)) continue;
      if (!tags.has(tag)) {tags.add(tag); components.push({selector: selector ?? tag, repository, file: root, tag});}
    }
  }
  return {components, attributes};
}

// The report says, for each declared component, which captures rendered it and which put it on
// screen. It also lists the custom elements the captures rendered that no listed source declares,
// such as a component library's.
export function componentReport(censuses, declared, uncapturable = UNCAPTURABLE) {
  const label = census => `${census.app} ${census.profile}`;
  const rows = declared.components.map(component => {
    const rendered = [], shown = [];
    for (const census of censuses) {
      const states = Object.values(census.states);
      if (states.some(state => state.present.includes(component.tag))) rendered.push(label(census));
      if (states.some(state => state.visible.includes(component.tag))) shown.push(label(census));
    }
    return {...component, rendered, shown, ...(uncapturable[component.tag] ? {uncapturable: uncapturable[component.tag]} : {})};
  });
  const known = new Set(declared.components.map(component => component.tag));
  const undeclared = [...new Set(censuses.flatMap(census => Object.values(census.states).flatMap(state => state.present)))]
    .filter(tag => !known.has(tag)).sort();
  const byRepository = {};
  for (const row of rows) {
    const entry = byRepository[row.repository] ??= {declared: 0, shown: 0, renderedOnly: [], neverRendered: [], uncapturable: []};
    if (row.uncapturable) {entry.uncapturable.push(row.tag); continue;}
    entry.declared++;
    if (row.shown.length) entry.shown++;
    else if (row.rendered.length) entry.renderedOnly.push(row.tag);
    else entry.neverRendered.push(row.tag);
  }
  return {captures: censuses.map(label), byRepository, components: rows, undeclared, attributeSelectors: declared.attributes.length};
}

async function readJson(path) {return JSON.parse(await readFile(path, 'utf8'));}

export async function main(args = process.argv.slice(2)) {
  const out = args.find(arg => arg.startsWith('--out='))?.slice(6);
  const directories = args.filter(arg => !arg.startsWith('--'));
  if (!directories.length) throw new Error('Usage: ui-coverage.mjs CAPTURE_DIRECTORY... [--out=PATH]');
  const censuses = [], code = [];
  for (const directory of directories) {
    censuses.push(await readJson(join(directory, 'component-census.json')));
    try {code.push(await readJson(join(directory, 'code-coverage.json')));} catch {}
  }
  const home = process.env.CEDAR_HOME;
  if (!home) throw new Error('CEDAR_HOME must name the CEDAR checkout root');
  const report = {...componentReport(censuses, await declaredComponents(home)),
    code: code.map(({app, profile, total, scripts}) => ({app, profile, total, scripts}))};
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Captures: ${report.captures.join(', ')}`);
  for (const [repository, entry] of Object.entries(report.byRepository)) {
    console.log(`${repository}: ${entry.shown} of ${entry.declared} components shown`
      + (entry.renderedOnly.length ? `; rendered but never on screen: ${entry.renderedOnly.join(', ')}` : '')
      + (entry.neverRendered.length ? `; never rendered: ${entry.neverRendered.join(', ')}` : '')
      + (entry.uncapturable.length ? `; not capturable, not counted: ${entry.uncapturable.join(', ')}` : ''));
  }
  console.log(`Attribute selectors not counted: ${report.attributeSelectors}. Undeclared elements rendered: ${report.undeclared.length}.`);
  for (const {app, profile, total} of report.code)
    console.log(`${app} ${profile}: ran ${total.executedPercent}% of ${total.bytes} bytes of served script`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
