# CEDAR Embeddable Designer — Runbook

Running, building, testing and packaging `cedar-embeddable-designer` (CED), the
Web Component for authoring CEDAR templates.

CED is the authoring half of a pair. The [CEDAR Embeddable Editor](CEE-RUNBOOK.md)
renders a template as a form and produces instances; CED produces the templates
CEE renders. It is a different component from the AngularJS Template Designer
that serves `/templates/edit/...` in production, which it is meant to replace.
What CED still needs before it can stand in for that designer is in
[DESIGNER-ROADMAP.md](DESIGNER-ROADMAP.md).

## Requirements

Node 24.19.0, which `.nvmrc` pins and CI runs — the same version CEE and
`cedar-term-picker` use. Nothing here needs Java or a running CEDAR stack, except
controlled-term search, which needs a terminology server.

```shell
nvm use
npm install
```

`npm install` reaches the CEDAR Nexus for one dependency,
`@org.metadatacenter/cedar-model-typescript-library`. Nexus being down is
therefore a broken install and a red CI run, with everything after the install
step unaffected.

## Running

```shell
npm start
```

Serves a development host on port 4200. That page is a host page: it embeds
`<cedar-embeddable-designer>` and configures it, rather than rendering the editor
directly, so `ng serve` exercises the same contract an embedder uses. A
regression in the element shows up during development rather than in someone
else's page.

## Building

There are two builds, because there are two things to produce.

| Command | What it produces |
|---|---|
| `npm run build` | the element: `main.js` and `polyfills.js`, no `index.html`, no global stylesheet |
| `npm run build:app` | the standalone host page `npm start` serves |
| `npm run dist` | the distribution: one script, its declaration, and a staged npm package |

`npm run build` compiles `src/main.ts`, which registers the custom element and
bootstraps nothing. The element carries its own styles into its shadow root,
which is why they are listed on the element component rather than in
`angular.json` — a stylesheet in the document head does not cross into a shadow
root.

`npm run dist` flattens Angular's module output into one classic script with
esbuild, holds it to a size ceiling, and stages the package from those exact
bytes. Concatenating the module output instead would produce a file that loads
and then fails inside Angular, because two modules that never shared a scope
would suddenly be sharing one.

## Testing

| Command | What it covers |
|---|---|
| `npm test` | unit tests, through the Angular CLI's Vitest builder |
| `npm run test:packaging` | the publish-channel rule, under `node --test` |
| `npm run test:browser` | builds the distribution, then drives it in a real browser |
| `npm run test:browser:prebuilt` | the browser suite against whatever is already built |
| `npm run test:ci` | the gate, cheapest check first |
| `npm run audit:prod` | advisories against what an embedder downloads |

The browser suite is the one that matters most, and it is the only one that can
see the failures this component has actually had: an element that never
registered on a page without `<app-root>`, a lookup that searched the document
instead of the shadow tree, menus that closed on their own opening click, a view
that silently stopped updating under OnPush, an image the package does not carry.

It drives the built single-file bundle in a host page whose own CSS is chosen to
be as intrusive as possible, and it is hermetic: no test reaches a terminology
server, and the one covering `<cedar-term-picker>` registers a stub element in
the page.

**Rebuild before running it prebuilt.** `test:browser:prebuilt` serves
`dist-bundle/`, so a source change that has not been through `npm run dist` is
not the thing under test. `npm run test:browser` does both.

## Packaging and Release

Which registry a package belongs to is derived from its version rather than
passed at publish time. A version carrying `-dev.` is a snapshot and names the
CEDAR Nexus under `@org.metadatacenter`; anything else is a release for public
npmjs, unscoped. A snapshot therefore cannot reach npmjs by forgetting a flag,
and the rule has tests of its own because publishing to npmjs is not an action
anyone can take back.

Nothing has been published on either channel. When it is, the procedure is CEE's,
in [NPMJS-RELEASE-RUNBOOK.md](NPMJS-RELEASE-RUNBOOK.md).

The published declaration is emitted from `src/app/ced-public-api.ts` alone,
which is written without imports so its declarations stand alone. Adding an
import to that file breaks the declaration build rather than shipping a `.d.ts`
that names paths only the repository has.

## Embedding It

A host loads one script and then has the element. Two properties and one event
are the whole contract today.

```html
<cedar-embeddable-designer id="designer"></cedar-embeddable-designer>
<script src="cedar-embeddable-designer.js"></script>
<script>
  const designer = document.getElementById('designer');
  designer.config = { terminologyBaseUrl: 'http://localhost:9004/' };
  designer.addEventListener('templateChange', (event) => console.log(event.detail));
</script>
```

`templateChange` carries the template as CEDAR JSON-LD — the same document the
artifact server accepts, written by the CEDAR model library rather than by CED.
`currentTemplate` offers the same value as a property, for a host that would
rather read than listen. Assigning `template` opens one, as JSON or YAML.

There is no default terminology endpoint. Unset, controlled-term search is off
and the panel says which key is missing, because an embedder should reach a CEDAR
service because it asked to rather than because a component it loaded had an
address compiled into it.

## Running It With Its Siblings

Two of the designer's surfaces are other web components the host loads, and
neither is bundled: a field's constraint is chosen with
[`<cedar-term-picker>`](VERSIONING-RUNBOOK.md), and Preview renders the template
with [`<cedar-embeddable-editor>`](CEE-RUNBOOK.md), the same renderer that will
show the form to whoever fills it in.

```shell
npm --prefix ../cedar-term-picker run dist
npm --prefix ../cedar-embeddable-editor run build:production
npm --prefix ../cedar-embeddable-editor/visual run bundle
npm run dist
cp ../cedar-term-picker/dist-bundle/cedar-term-picker.js dist-bundle/
cp ../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js dist-bundle/
```

CEE's single-file bundle is built in two steps and lands under `visual/`, which is
where its own visual suite serves it from; `dist-npm/` holds a staged copy that
only a package build refreshes.

Serve `dist-bundle/` and load a page that pulls in all three scripts. Each
absence is reported where it would have been used: without the picker the
constraint panel says so and its fields are filled by hand, and without CEE the
preview panel says so.

`npm start` stages both siblings into `public/` and the development host loads
them, so the served designer offers the same two surfaces an embedder gets. A
sibling that has not been built is named and skipped rather than failing the
start, and the copies are the neighbouring repositories' build output rather than
this one's, so they are not committed. The host names a terminology server on
`localhost:9004` for the reason below.

The preview asks CEE for a read-only form with no instance behind it, which CEE
renders as a statement of what each field will accept rather than as an empty
form. It also asks CEE to drop its Expand All and Collapse All buttons, through
`showExpandCollapseAll`, because the designer has its own controls over the same
template beside the preview; each section still opens and closes on its own
header. That key arrived in CEE 2.0.4-dev. An older bundle reports it as one it
does not know and drops that key alone, so the preview still renders read-only and
still shows the two buttons.

CEE takes one assignment to its template and reports and ignores a second, so the
designer replaces the element when the template settles rather than reassigning
it; a burst of typing therefore costs one rebuild, not one per keystroke.

**The picker needs a local terminology server.** It reads the version-aware
`/search`, which production does not serve — `POST
https://terminology.metadatacenter.org/search` answers 404. Point
`terminologyBaseUrl` at a local store, which answers on port 9004 and already
sends the right CORS headers. Bringing that store up is in
[VERSIONING-RUNBOOK.md](VERSIONING-RUNBOOK.md).

## Ports

| Port | What |
|---|---|
| 4200 | `npm start`, the development host page |
| 4598 | the browser suite's static server, over `dist-bundle/` |
| 9004 | the terminology server the picker reads, when run locally |

## The Things That Bite

**Nexus is a hard dependency of `npm install`.** One package comes from it. An
outage is a broken install and a red CI run at the install step; nothing after it
is implicated.

**A stale bundle looks like a passing test.** The browser suite serves
`dist-bundle/`, not `dist/`. `npm run bundle` after `npm run build`, or use the
commands that chain them.

**jsdom cannot parse the stylesheet the element ships.** Tailwind 4 uses
`@layer`, `oklch()` and `@property`, none of which jsdom's parser knows.
`src/test-setup.ts` filters that one message so it cannot bury a real failure;
anything else jsdom says still reaches the console.

**A template's top-level `required` is JSON Schema's**, naming every property an
instance must carry, including the provenance keys. The author's required flag is
`_valueConstraints.requiredValue` on the field. Reading the first as the second is
a mistake worth remembering.
