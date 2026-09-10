# CEDAR Embeddable Designer — Runbook

Running, building, testing and packaging `cedar-embeddable-designer` (CED), the
Web Component for authoring CEDAR templates and elements.

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

For the full debugging fixture, open `http://localhost:4200/?example=all-fields`
(or the port selected with `npm start -- --port <port>`). The development host
loads `public/examples/all-fields-nested.json`, a snapshot of the local template
`https://repo.metadatacenter.orgx/templates/5e68d921-fd5d-4d05-9a6d-a81714cbd2c5`.
It includes every palette type, numeric and temporal variants, and NIH Grant ID
and DOI in the single and repeated nested collections. The host does not save
edits back to that server template. Its status bar links to the fixture.

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
| `npm run test:boundaries` | two properties of the source no type can express |
| `npm run test:packaging` | the publish-channel rule, under `node --test` |
| `npm run test:browser` | builds the distribution, then drives it in a real browser |
| `npm run test:browser:prebuilt` | the browser suite, refusing a bundle that is not the code |
| `npm run test:browser:flake-hunt` | that suite twenty times over, or `RUNS=n` |
| `npm run test:visual` | the screenshot baselines, in the container they are taken in |
| `npm run check:readme` | the README's examples, against the package that ships |
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

`test:browser:prebuilt` serves `dist-bundle/`, so a source change that has not
been through `npm run dist` is not the thing under test. That used to be a
sentence here and nothing more; `check:fresh` now refuses the run, comparing the
bundle against the build beside it by timestamp, by the files it was made from,
and by hash. A checkout that never built is not what it refuses — testing a
distribution someone handed you is legitimate — only a bundle a build contradicts.

The two source properties are the ones a compiler cannot state: `ced-public-api.ts`
must stay import-free, or the declaration the package ships names paths that are
not in it, and the CEDAR model library must be reached through
`core/model/cedar-template.ts` alone, which is what keeps its vocabulary out of the
components. Neither breaks a build when it goes.

`check:readme` compiles the README's TypeScript examples against the staged
declaration, and checks that every `npm run` a reader is told to type is a script
this project has. The second half exists because documentation here has named a
command that did not exist.

### What the Machine Decides

Two kinds of check measure the rendered page rather than the model, and both
depend on the machine that rendered it. `browser/run-in-container.sh` runs them
inside the Playwright image matching the version this repository resolves —
`visual` for the baselines, `behaviour` for everything else — and CI runs the same
image on an arm64 Linux runner so that neither side emulates the other.

The screenshot baselines are the obvious case: a baseline records a machine's
glyph rasterisation as much as the application's rendering, and CEE measured 7 of
its 106 differing by antialiasing alone across the laptop-to-CI boundary. Because
the container removes that boundary, the budget for a difference here is zero
pixels rather than a tolerance wide enough to hide a real change.

The layout invariants are the case that is easy to miss. They measure real boxes,
and a box's width depends on the fonts available — so a row with no slack fits on
a developer's Mac and overflows on the runner. An option row's delete button sat
31 pixels outside its card on CI and nowhere else, and the suite was red for three
commits before anyone ran it where CI runs it.

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

The designer uses sibling web components the host loads, and none is bundled.
A field's constraint set is assembled with
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
constraint panel reports editing unavailable and retains the saved set, and without CEE the
preview panel says so.

`npm start` stages both siblings into `public/` and the development host loads
them, so the served designer offers the same two surfaces an embedder gets. A
sibling that has not been built is named and skipped rather than failing the
start, and the copies are the neighbouring repositories' build output rather than
this one's, so they are not committed. The host names a terminology server on
`localhost:9004` for the reason below.

Reuse `<cedar-embeddable-field>` (CEF) for field rendering and value acquisition
whenever its public API supports the workflow. This applies to editable values,
defaults, and read-only field specifications. Prefer extending a missing CEF
capability in CEE over duplicating its rendering or input controls in CED. Keep
authoring commands such as Edit alongside the component, and keep serialization
in the TypeScript model library.

CEF's `readOnlyMode: true` renders a supplied value, or the field's accepted-value
specification when `value` is `{ kind: 'none' }`. CED uses this for the compact
controlled-term summary; the term picker remains the constraint authoring surface.

Field settings start collapsed behind the grey chevron centered at the bottom
of each card. Expanding it reveals underline tabs for the applicable values,
display, placement, constraints, metadata and identity controls. Switching tabs
or collapsing the panel retains incomplete input; valid settings update immediately
without Apply buttons. Identity and provenance appear under Field metadata, while
labels, identifiers and annotations appear under Field details. Published fields allow tab
navigation and inspection while their editing controls remain disabled.
The card-level Save field to library action has been removed; import and reuse
remain available through Field Designer.

The Overview shows each field's type icon and a right-aligned reorder handle.
Dragging reorders siblings within the Overview; the document and main editor update
only when the field is dropped. Focused handles also support Arrow Up/Down.

All default-capable fields use `<cedar-embeddable-field>` from the same CEE bundle.
Choose **semantic** in Preferences to expose Default Value. CED and CEE use the
model snapshot `1.0.8-dev.20260909.f1fbbbc` for typed defaults and JSON/YAML
serialization. Imported numeric constraints and temporal settings are retained;
temporal values are converted between the default's declared precision and CEF's
complete instance literal without shifting timezones. Choices are stored with
`selectedByDefault` on options, including multiple checkbox/list selections.

Rebuild CEE and refresh the sibling copy when testing defaults: an older CEE
bundle may omit email, phone, link and authority defaults from its preview even
when CED's output contains them. `npm start` refreshes the development host's
copies; a manually served `dist-bundle/` needs the copy commands above again.

Display label and Display description apply to the field's deployment in this
template. CEE gives those overrides precedence over the field's own labels and
description, and falls back to the artifact when an override is absent. Preferred
label remains part of the reusable field's metadata. Property IRI is available
only for dynamic fields, because static content has no instance property to name.

Controlled defaults use the current `<cedar-term-picker>` bundle's term-only mode,
then verify membership through the configured terminology server's
`bioportal/integrated-search`. A vocabulary constraint is required first. Several sources or version pins appear
in a vocabulary/release selector; membership checks still receive the entire field
constraint set and its actions. Constraint edits retain a permitted default and
require explicit clearing before an invalid default's replacement set is applied.

CED uses the picker's `selectionMode = 'constraints'`, `constraintSet` input and
`constraintsSelected` event. The picker owns draft assembly, individual entry
removal and branch depth. To change a selection, remove it and add the desired one. Exclusion and reordering authoring controls
are deferred; imported term actions remain intact. Done returns the entire set; cancellation leaves the original intact.
Constraint arrays and actions retain their order within each model array. A
constraint's service URI, canonical IRI, source system and version pin remain
separate identities.

The host supplies `bridgeBaseUrl` for the seven external authority lookups; the development
host names the local bridge. Missing sibling controls are reported as unavailable,
and saved defaults remain intact.

CI also runs the `CED with real CEE and CEF` job on every push and pull request.
It builds both distributions and supplies `CEF_BUNDLE` to the complete browser
suite, including default editing, CEE preview, style parity and delayed CEF
registration. The CEE checkout is pinned to a full commit in CED's
`.github/workflows/test.yml`; update that pin when adopting a new CEE/CEF revision.
The job prints both source revisions and bundle hashes and retains failure traces.
The combined real term-picker test still needs `PICKER_BUNDLE` separately.

Each designer element owns one `EditorSession`, preferences and endpoint
configuration; the field library remains shared. The session contains one immutable
`ContainerDraft` tree and a selected container ID. Fields and elements are child
nodes with separate reusable definitions and parent placements. Editor IDs are
session identities, independent of artifact IRIs. Navigation changes no artifact and
does not mark it dirty. The root document drives serialization and host events.

`ContainerEditorComponent` renders the root and recursively renders each nested
container inline, using the same header and field layout. Field mutations resolve
the owning container from the node ID, so simultaneous root and nested editors do
not depend on the last selected container. The selected container still determines
the target of the shared field sidebar. `ContainerOutlineComponent` scrolls to a
field or element and expands its ancestors. All CEDAR model reads, builds and writes
remain in `core/model/cedar-template.ts`.

Choose **File → New Element** for a standalone element. The **Modular** profile
(or **Enable Elements** preference) offers **Add Element** and **Import Element**.
Existing nested content remains visible under every profile. Elements start expanded;
the chevron in their template-style header collapses or expands their children without
discarding input or changing the artifact. **Element settings** edits the placement's
property name, display labels, property IRI, requirement, cardinality and layout, and
contains duplicate, remove and move actions. Add/import controls within each element
target that container. Move selectors transfer fields or whole element subtrees;
cycles, duplicate property names and page breaks inside elements are refused. On
narrow screens the outline is hidden; nested sections remain editable inline.

**Import Element** creates an independent local copy retaining source artifact
identity. Its destination is captured when the file chooser opens, so later navigation
cannot redirect it. **Duplicate Element** creates new draft identities throughout
the subtree, records each source with `pav:derivedFrom`, and clears publication and
creation/update provenance. Neither operation creates a live server reference.

The `artifact` input accepts JSON objects, JSON strings and full YAML for templates
or elements. `currentArtifact` and `artifactChange` expose the complete root artifact.
`template`, `currentTemplate` and `templateChange` remain compatible aliases.
Imports preserve lifecycle, annotations, container metadata, ordering and descendants;
failed imports leave the current document intact. JSON and YAML share the model
codec. YAML export is refused when the model's round trip cannot retain every property.

CEE preview receives the root template, or a temporary template wrapping a root
element. The wrapper never reaches exports or host events. Leaf default controls
continue to use CEF. Field views retain identity while their nodes are unchanged,
so asynchronous terminology checks survive unrelated rendering and reject replies
for fields that were actually replaced.

The default browser suite uses a CEF contract stub. To include the real widgets
and the combined controlled-term picker test, after building all siblings:

```shell
CEF_BUNDLE="$PWD/../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js" \
PICKER_BUNDLE="$PWD/../cedar-term-picker/dist-bundle/cedar-term-picker.js" \
npm --prefix browser test
```

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
