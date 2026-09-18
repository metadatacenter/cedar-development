# CEDAR Frontend — Runbook

Running, building, testing and releasing the embeddable editor (CEE/CEF), designer
(CED), and the TypeScript model library used by them. Commands in each component
section run from that repository unless stated otherwise.

Use [FRONTEND-ROADMAP.md](FRONTEND-ROADMAP.md) for open work across these components
and the main browser applications. Shared design values belong in
[`cedar-design-tokens`](../../cedar-design-tokens/README.md).

## Find the Procedure

| Area | Start here |
| --- | --- |
| CEE/CEF setup and development | [Node](#cee-node-versions--read-this-first), [running](#cee-running-the-app), [build](#cee-building-the-web-component) |
| CEE/CEF tests | [Complete gate](#cee-running-the-complete-test-gate), [domain harness](#cee-running-the-domain-test-harness), [visual baselines](#cee-running-the-visual-baseline) |
| Model library | [Build and package](#cee-building-the-model-library), [validate output](#cee-checking-output-against-the-cedar-model) |
| CEE release and host adoption | [Release](#cee-release), [local frontend bundles](#cee-getting-a-local-build-into-the-frontends) |
| CED development | [Requirements](#ced-requirements), [running](#ced-running), [building](#ced-building) |
| CED tests and distribution | [Tests](#ced-testing), [packaging](#ced-packaging-and-release) |
| CED with CEE/CEF and the term picker | [Embedding](#ced-embedding-it), [sibling integration](#ced-running-it-with-its-siblings) |
| Main browser applications and local stack | [Backend runbook](BACKEND-RUNBOOK.md), [production deployment](PROD-DEPLOY-RUNBOOK.md), [Docker operation](DOCKER-RUNBOOK.md) |
| Public npmjs releases | [Npmjs release runbook](NPMJS-RELEASE-RUNBOOK.md) |
| Term-picker operation | [Versioning runbook](VERSIONING-RUNBOOK.md) |
| What a host serves against its components | [Component staleness](#component-staleness) |

<a id="cee"></a>

## Browser Metadata Editing

Workspace and the combined Template Editor use CEE exclusively for creating and editing
metadata. Settings has no editor-selection toggle; older stored editor-selection preferences
are ignored. The split Template Designer hosts CED/CEFD for template, element and field
authoring, while metadata population is handled by CEE in Workspace. The legacy metadata widgets, pagination, spreadsheet
view and their supporting modules are no longer part of any of these applications.

## Modern Split Workspace

`cedar-workspace` serves a standalone Angular 22 application on `/`, `/dashboard`,
`/instances/create/:templateId`, `/instances/edit/:id`, `/profile`, `/settings`, `/groups`
and `/privacy`. These routes load no AngularJS; logout also runs in Angular without requiring a profile API response. Messaging has been removed;
its retired URL returns to the dashboard.

The Workspace uses shared design tokens, a table-only resource list, search, folder
navigation, collapsible side panels and Info/Version tabs. Category, latest-version and
type filters are intentionally absent. Artifact/folder menus use existing REST operations
and server capabilities; lifecycle actions come from resource reports, not listing summaries.

The artifact and folder menu's **Permissions…** dialog follows the legacy access layout.
It shows the owner and direct user/group grants to any reader, with searchable principals
and immediately saved Viewer/Editor/Manager roles for callers with `manageGrants`.
Everyone is Viewer-only. Ownership transfer is a separate, confirmed user-only action,
gated by `transferOwnership`. Each write uses the permissions ETag; a stale write displays
the failed change and requires an explicit reload. Capabilities refresh after each successful
write, including self-demotion; a successful ownership transfer closes the dialog and refreshes
the workspace, since the former owner may lose access. The modern Workspace smoke covers
read-only viewing, role changes, Everyone, stale permissions, and two-user revocation.

Profile provides account details and masked API-key create/regenerate/delete operations.
Settings saves the account date preference used by Workspace. Groups has a standalone
legacy-style Manage/Create layout with searchable group and member selectors, using shared
design tokens instead of the account-page navigation. It uses independent
group and membership ETags, restricts administration to group administrators and protects
the last administrator. Privacy retains the existing policy wording in the Angular account
shell. In `ops/e2e`, run `npm run smoke:account:all` for all four pages, or
`npm run smoke:account -- profile` (also `settings`, `groups`, `privacy`) for one page.
The journeys remove their temporary keys/groups and restore the original date preference.
Groups includes a second user's restricted view and a real stale-write conflict.

Start it with `cedarcli native start frontend workspace`. With the native profile sourced,
run `npm run build` in `cedar-workspace` after changing `src/`. `npm run build:deployment` configures and assembles the native server payload.
`npm start` performs that preparation and serves the app with a dependency-free Node server
in develop mode; server mode exits after assembly. Workspace no longer uses Gulp or live reload.
`cedarcli build frontends` runs its Angular build in an isolated checkout;
`cedarcli build split-frontends` retains the explicit native deployment path. Angular builds outside the served tree;
assets are copied before the entry document is atomically replaced. The root index loads
`app/workspace-build/index.html` for every route. Unknown routes return to the dashboard.
The AngularJS shell, controllers, services, templates, styles and Karma harness are removed.
Bower vendors, legacy icon fonts, RequireJS and obsolete npm build/test dependencies are
also removed. The Keycloak adapter and bundle are plain JavaScript used by Angular.

The metadata routes use a modern Angular CEE host. It loads the staged CEE bundle
on demand, settles read-only permissions before configuration, saves with content
ETags and preserves the editor across saves. Its dirty guard covers field/name edits,
exact reverts, browser unload and edits made during a pending save. Quality reports
are advisory. First save replaces the create URL through Angular routing; it does
not remount the editor. The combined Template Editor and its AngularJS smoke remain unchanged.

`npm test` runs Angular/Vitest tests and the Node tests for the retained plain-JavaScript
Keycloak adapter, deployment configuration, atomic staging and npm package contents.
`groups.spec.ts`, `permissions-dialog.spec.ts`, `access-views.spec.ts` and the Workspace
action tests carry forward the legacy group/share controller, directive, permission-model
and conditional-request contracts. They exercise rendered controls as well as request
shapes, independent revisions, pending-write guards, failed/cancelled changes, late reads,
last-administrator protection, direct-user ownership transfer and read-only access.
Bootstrap visibility and asynchronous confirmation mechanics are replaced by native-dialog
and confirmation-event tests. Failed writes retain the last saved state and the failed
intent; stale revisions block further writes until an explicit recovery read completes.
Configuration and CEE assets finish writing before the development server starts.
Use `npm run copy:cee` to refresh only the staged editor.
Workspace participates in `cedarcli check design-tokens` and the shared CI adoption gate;
its initial baseline records existing typography and layout debt.
In `cedar-development/ops/e2e`, run
`npm run smoke:workspace:modern:full` against the running native stack. It exercises the
modern Workspace and split CED/CEFD hosts with real login, folder operations, authoring,
sharing between two users, CEE metadata entry, downloads, versioning, OpenView and
conditional writes. Its fixtures are removed after each run; the Workspace result and
failure screenshot are written under `/tmp/cedar-modern-workspace-smoke/`.
`npm run smoke:workspace:modern` runs just the Workspace journey; the full command also
runs the CED host's stale-save and breaking-template-change scenarios, all account journeys,
and logout/retired-route checks (`npm run smoke:workspace:lifecycle`).
The existing `npm run smoke` remains the AngularJS journey for `cedar.metadatacenter.*`.
Its script and legacy variants are retained unchanged; they are not the modern route's gate.
See the Workspace README for the boundary, request contracts and direct build procedure.

<a id="component-staleness"></a>

## Component Staleness

A component's source and the bundle a host serves are separated by a publication and
a pin, so a committed change reaches a host only once both have moved. Nothing in a
host's own signals reports the gap: its CI, its suite and its browser tests all
exercise whatever bundle sits on the disk they run on.

```shell
cedarcli check components            # report the gap
cedarcli check components --strict   # also fail on a host behind a published component
cedarcli check components --all      # every comparison, not only the findings
```

Three comparisons, none of which needs a judgement about versions. A pin names a
source commit, so measuring it against the component's develop head gives the commits
the host cannot see, by subject. A staged bundle carries bytes, so hashing them against
the locked package says whether a clean install would serve the same thing. A host names
the elements it creates, so looking for each one in the locked bundles says whether it
exists at all.

Serving bytes the lock does not name, creating an element no locked bundle defines, and
pinning a build the component's history cannot account for each fail the check outright.
A host sitting behind a published component, a local bundle staged over a locked one, and
a version carrying no recoverable source commit are reported and fail only under
`--strict`: each is true of an estate mid-cycle, and failing on them by default would
train people past the three that matter.

The release plan and the train dispatch preflights ask this check themselves, at its own
severity rather than under `--strict`. A host sits on the last published component for as
long as it takes to publish the next one, so refusing a release on that would refuse
nearly every release, and a gate that always refuses earns an override flag. Both build
frontends in an isolated workspace from the lock, so a locally staged bundle never reaches
them and is not asked about; an element the locked bundle does not define still refuses,
which is the case no clean install repairs. `--strict` belongs to a server payload, which
serves whatever the lock resolves.

### Advancing a Pin

The Java estate never asks this question. `cedar-parent` names `cedar.version` once, child poms
name dependencies without a version, and the coordinate is a `-SNAPSHOT` that Maven re-resolves
from Nexus on every build, so a merge to `develop` reaches every downstream build with no source
edit anywhere.

npm has neither half of that. Each consumer declares an exact immutable version in its own
`package.json` and again in its lock, and nothing stands in for a snapshot: `npm ci` reads the lock
rather than a dist-tag, and a semver range over these prereleases snaps back to release-time builds.
The lock is what makes a build reproducible, so the pin stays exact, and advancing it is a source
change across several repositories.

Development does not pay that cost, because `cedarcli build frontends` is a reactor. What
remains is advancing the pins that a release records, and that is what the command below is for.

### The Reactor

`cedarcli build java` never consults a pin: it builds the repositories in dependency order,
installing each into `~/.m2`, so every consumer compiles against the sibling that came out of the
working tree a moment earlier. `cedarcli build frontends` now does the same, with no flag to ask
for it, because the pinned build belongs to the train rather than to a developer command.

npm has no moving coordinate to borrow, so each CEDAR dependency is rewritten to a local path in
the copy being built. That path is the sibling's published package, which is not its checkout: the
model library builds a `dist/` whose package.json is `package-dist.json`, CEE and the two Web
Components stage under `dist-npm/`, and the design tokens publish their root. Each repository
declares which it is. After it builds, `npm pack --ignore-scripts` packages that output using
npm's published file selection. The tarball is stored under its SHA-256 in
`$CEDAR_HOME/.reactor/artifacts`, with an atomically updated reference under `refs/`.
Consumers install the immutable tarball; they do not link to a shared directory or rerun a
producer's `prepare` script. Missing or invalid package output and packing or storage failures
fail the producer task.

`npm ci` becomes `npm install` for the same build, since a rewritten manifest no longer matches the
lock, and the copy's lock is discarded with the copy. A development build is therefore not
lockfile-reproducible, which is why the pinned build stays the release path.

Each build snapshots the available references once, then advances its own selection as its
producers finish. A consumer cannot use an old artifact or a registry pin for a producer scheduled
in that build that has not succeeded. A dependency outside that build's producers retains its pin
when the store has no artifact for it. Concurrent builds can publish without changing another
build's selection or installed bytes. Old directory entries from the earlier store format are
ignored; rebuilding the producers populates the tarball store. Keep immutable artifacts while
builds are active; removing the whole `.reactor` cache is safe when no build is using it.

Nothing is published to a registry, committed, or deployed, and no tracked file changes: the
rewrite happens in the throwaway copy. A server payload builds in place
and still installs its locks, and the train resolves exact Nexus aliases in its own checkouts, so
neither sees the reactor.

Because development no longer exercises the locks, the pinned composition is checked elsewhere:
each repository's CI runs `npm ci` on every push, and `cedarcli check components` with the release
and train preflights judge the composition. A reactor build proves the sources compose, not that
what ships does.

### Recording a Pin

```shell
cedarcli publish components                # report what would move
cedarcli publish components --apply        # stamp, publish, repoint, re-stage
cedarcli publish components --component ced
```

Each component is declared in `cedar-development/ops/frontend-train.json` under `components`. A
declaration names the repository, the published package, the package it stages, the command that
builds it, and every consumer whose pin follows it. The design tokens publish from their checkout
root and declare `"."`; the term picker and the designer stage under `dist-npm/`.

A component something else publishes is declared to be followed instead, with `publishedBy` and a
`reference`. The TypeScript model library is the one: the build train publishes its development
snapshots and advances CEE's pin, and nothing advanced the other consumers. Its target is the
version the reference consumer already carries rather than a new stamp, because the library's own
manifest names its last stamp and not always the newest snapshot the train published. A followed
component is never stamped, built or published here; only the pins move.

Applying it stamps the component's next development version from its `develop` head, runs its dist
command, publishes the staged package under the `dev` tag, then repoints each consumer's manifest,
moves its lock, and re-stages its served bundles. Reporting is the default because an npm version
once taken cannot be republished. Every repository it would write to must be clean in its tracked
files first, so the diffs left behind are its own, and nothing is committed.

The train captures the term picker and the designer, so a train's recorded source names their
`develop` heads and its preflight asks the same questions of them as of every other source
repository.

`cedarcli build frontends` builds both components with `npm ci && npm run dist`, which is what
makes it produce a bundle and a staged package rather than only installed dependencies. Measured on
a development workstation with the stack running, the dist runs cost 4s for the term picker and 6s
for the designer, against 5s each for the `npm ci` that precedes them either way. A cold
`.angular/cache` made no appreciable difference: these are web components of 435 kB and 1.37 MB, and
Angular's own build reports 1.6s and 3.2s.

The check reads the workspace rather than the repository registry, so a component counts
as one as soon as a sibling installs it.

## Embeddable Editor (CEE/CEF)

Building, running and testing **CEE** (`cedar-embeddable-editor`) locally.
Everything here has been run on macOS (Apple silicon), against Angular 22. The latest
stable release documented here is CEE 2.0.3; all seven embedding manifests, including
the extracted Workspace, pin that public npmjs release. Consumer coherence is verified
from manifests and lockfiles, and deployed identity is verified by the bundle sha256
rather than only by the version each host reports.

Sibling runbooks:
- [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee) — where CEE currently is, and the open
  work.
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the full CEDAR
  stack locally.

> CEE is a standalone Angular web component. It does **not** need the CEDAR
> stack running — none of the commands below depend on the microservices.

---

<a id="cee-node-versions--read-this-first"></a>

### Node Versions — Read This First

CEE builds, runs and tests on one Node version, and `.github/workflows/test.yml`
is the source of truth for which.

| What | Node | Why |
|---|---|---|
| Everything in CEE — `ng serve`, `npm run test:ci`, `harness/` and `visual/` alone | **24.19.0** | Angular 22 requires `^22.22.3 \|\| ^24.15.0 \|\| >=26`. 24 is the active LTS where 22 is in maintenance. Pinned by CI. |
| `cedar-model-typescript-library` | 24.19.0 | Webpack 5 / TS 5.3. Its own build, and now on CEE's Node rather than the Node 20 it outlived. |

The split this table used to describe — 18 for interactive development, 20.20.2
for the gate — is gone. It existed because Angular 14's toolchain and the current
Playwright did not accept the same Node, and the Angular march removed the reason
for it. The model library was the last thing left on a Node of its own, and joined
these on 2026-08-16. One version now builds every artifact that ships and runs the
tests that judge it.

Install it with Homebrew, keg-only so it does not displace the Node the other
CEDAR frontends use:

```bash
brew install node@24
```

Then put it in front for CEE work:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

Verify with `node -v` before blaming anything else: a version outside Angular's
range fails in ways that read as unrelated breakage.

Nothing here needs Java. The one exception is the canonical validator, which
needs **JDK 17** specifically — see
[Checking output against the CEDAR model](#cee-checking-output-against-the-cedar-model).

---

<a id="cee-running-the-app"></a>

### Running the App

CEE's standalone dev mode serves everything it needs from this repository, so
one command runs it.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install && npx ng serve
```

Then open `http://localhost:4400/`.

The developer app fetches its demo template and instance from CEE's own assets,
`src/assets/cee-demo/demo/template.json` and `metadata.json`, and hands both to
the component together so the form is built with the instance already read. The
template is the nested fixture the visual suite renders as `18-real-nested`: 23
field types over two pages, every temporal granularity, both choice and both
list cardinalities, the static widgets, the authority fields, and single and
multi-instance elements inside two wrappers.

Until 2026-08-15 it instead pulled samples over the network from a second
repository, `cedar-component-distribution`, cloned and served in a terminal of
its own and located by a `sampleTemplateLocationPrefix` key. That was the only
path on which CEE reached the network for an artifact. A host fetches its own
artifacts, and the developer app is a host like any other, so the key, the
second repository and the second terminal are all gone.

Below the form the same page renders the `cedar-embeddable-field` element on its
own, with a picker for the field it shows and a readout of what it reports. The
fields are `src/assets/cee-demo/demo/fields.json`, one artifact per input type,
extracted from the demo template beside it. It is the only place a widget can be
looked at without a form around it, and it exercises reassigning `fieldObject`,
which is what a designer does as an author changes a field's type.

The rest of dev-mode configuration remains in `src/app/app.component.dev.ts` —
the terminology and bridge base URLs, the offered languages, the read-only flag.
It is TypeScript, not JSON, and is compiled in.

<a id="cee-the-two-elements"></a>

### The Two Elements

The bundle registers two custom elements from one bootstrap.
`cedar-embeddable-editor` renders a template as a form, and `cedar-embeddable-field`
renders one field's control with nothing around it — no label, no description, no
card — for a host that holds a field artifact rather than a template. The CEDAR
Embeddable Designer is the host that wants the second: an author giving a field a
default value needs the control the field will actually have, and that control is
the editor's.

Both draw the same component. `CedarFieldWidgetComponent` owns the routing from an
input type to one of the eighteen widgets, the four static blocks, and the
read-only choice between a control and a statement of what the field will accept;
the component renderer draws one per field of a form, and the element draws one.
Neither has a widget switch of its own, so a widget added or rerouted reaches both.

Registering them together is deliberate. `defineCustomElementOnce` takes a name and
`bootstrap-once.ts` still claims one page-wide slot, so two copies of the bundle
cannot both start Angular and a page cannot take the editor from one version and
the field element from another — they describe values in the same model classes.

A field artifact is not a template, so the element wraps it in a synthetic one-field
template before CEE builds anything from it (`util/single-field-template.ts`). The
wrapping deliberately states no requiredness and no cardinality: both belong to a
field's deployment, so the value the element acquires is single and is allowed to be
absent, which is what a default value has to be. The wrapper template carries the
URN `urn:cedar:cee:single-field-template` as its `@id` — a template with none is
reported, and no repository holds this one.

The value crosses the boundary as a discriminated union rather than as text
(`CedarEmbeddableFieldValue` in `cee-public-api.ts`): a literal, a number, an ISO
temporal literal, an IRI with a label, a list of literals, or an attribute-value
field's named slots. An attribute-value field is read but not written — its slots are named
by the control that creates them — and a page break is refused outright, since it
divides a form and this element has none.

<a id="cee-where-the-design-values-come-from"></a>

### Where the Design Values Come From

CEDAR's font stack, type scale, brand palettes and neutrals are published from
`cedar-design-tokens` as `@org.metadatacenter/cedar-design-tokens`, and its README is the reference
for them. CEE held the original the other two copied, and gave it up on 2026-09-15: the values come from the
package, reached as `@use '@org.metadatacenter/cedar-design-tokens/tokens' as tokens` with
`node_modules` on the Sass load path, which `stylePreprocessorOptions.includePaths` declares beside
`src`. What stays in `src/_cee-layout.scss` is CEE's own — the trailing slot in a title row, the
card's inline gutter, and the size and gap of a toolbar control — because those measure a card no
other component draws.

The package must stay a `devDependency` that the published manifest never names. The reason is in
[NPMJS-RELEASE-RUNBOOK.md](NPMJS-RELEASE-RUNBOOK.md), under the release contract: the scope resolves
only from Nexus, which an embedding application installing public CEE from npmjs cannot reach.

The Material adapter uses M3 `mat.theme()` with explicit light color roles from
the package: primary 500, secondary primary 700, tertiary rust 500, pale brand
containers and shared neutrals. All typography roles use the shared px scale and
namespaced font stack. Supported component override mixins preserve 36px compact
controls, 48px comfortable fields and 28px editable choice rows with hit areas
contained within each row. Attribute name/value inputs have 16px of padding above
their form so floating labels clear the occurrence pager.
The system is emitted at each CEE/CEF shadow host so overlays inherit it too.
`THEMING.md` records the visual contract and `STYLING.md` the public compact-control
properties; Material's `--mat-*` variables remain private. The M3 browser suite
checks sentinel host overrides and overlays under a host root-font reset.

<a id="cee-building-the-web-component"></a>

### Building the Web Component

This is the real deliverable — a single JS file embeddable in any page.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run build:production
npm --prefix visual run bundle
```

The second step writes `visual/public/cedar-embeddable-editor.js` and a sidecar
manifest recording its sha256 and byte count, which the freshness guard and the
size gate both read rather than re-deriving.

Do not join the build's output by hand. This used to read
`cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js`, and those are
Angular 14's filenames: the esbuild builder that arrived at Angular 17 stopped
emitting that set, so the command silently produced a truncated or empty bundle
rather than failing. `visual/resolve-build-output.mjs` decides what the build
actually emitted, and whether joining is even the right operation for it.

`cedarcli build this --wd "$PWD"` and `cedarcli build frontends` run this same pipeline, plus
the two installs and the staging step, from `build_command_list` on CEE's entry in
`cedar-cli/org/metadatacenter/config/ReposFactory.py`. Until August 2026 the CLI
instead reassembled the output itself with that hardcoded `cat`, which by then
truncated `dist-npm/cedar-embeddable-editor/cedar-embeddable-editor.js` to zero
bytes on every run — the redirection emptied the staged file before `cat` failed
on the missing inputs. The CLI has no separate copy of the packaging rules now,
so that class of drift cannot recur.

Note that `cedarcli` builds CEE on whatever Node the login shell offers, which is
not necessarily the 24.19.0 this repo declares.

`resolve-build-output.mjs` decides between two operations, and the difference is
scope rather than filenames. Webpack wraps each chunk in an IIFE, so joining them
shares nothing — note that `polyfills.js` alone carries a `"use strict"` prologue
ahead of its wrapper, which a self-containment test has to skip. The
`application` builder emits ES modules whose top-level names are only kept apart
by module scope; concatenating those into one classic script makes them global,
where they collide, and the file loads, runs, and fails inside Angular with
`Cannot read properties of undefined (reading 'lFrame')`. So `concat` requires
proof that every input wraps itself, and everything else is flattened through
esbuild instead.

<a id="cee-running-the-complete-test-gate"></a>

### Running the Complete Test Gate

The canonical, non-interactive verification command is run from the CEE
repository root:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:ci
```

It runs these stages in order and stops at the first failure:

1. Lint and all three TypeScript programs — source, domain harness and visual suite
   (`lint`, `typecheck`).
2. Fast Vitest unit specs under `src/`, in jsdom (`test:unit:ci`).
3. Angular's native Vitest/TestBed coordinator tier, compiling the real wrapper,
   editor and renderer templates with coverage thresholds (`test:coordinator`).
4. The Vitest domain harness with V8 coverage (`test:domain:coverage`).
5. A production build of the web component, fixture preparation and the Playwright
   browser suite at desktop and narrow viewport sizes (`test:visual`).
6. The npm package, staged from the bundle stage 5 just built and then verified
   byte-for-byte against the source each file came from
   (`package:npm:prebuilt`).

Stage 6 leaves `dist-npm/` present and current. That directory is what a consumer
can be pointed at to try an unpublished build, by symlinking its
`node_modules/cedar-embeddable-editor` at it — described under "Getting a Local
Build Into the Frontends". A fresh clone has no `dist-npm/` until something stages
it, so **run the gate, or `npm run package:npm:prebuilt` alone, before expecting a
symlinked consumer to serve CEE.** Nothing is symlinked at present: every consumer
holds the installed public npmjs release 2.0.3.

`dist-npm/` used to be committed, and the stage used to be a drift check
(`check:staged`) rather than a staging step. That arrangement cost more than it
paid: the committed copy went stale the moment source changed and only caught up
when somebody deployed — three commits behind before one deploy, two before the
next — and once the label was bumped without a rebuild, one version named two
different bundles. Since the files are generated and the build is reproducible,
the copy in git was a second source of truth that could disagree with the first.
It is now ignored, and staging is what the gate runs.

Verification is still a byte comparison, which needs the build to be
reproducible: two clean builds of the same source were verified byte-identical
before this was wired in. It also needed the manifest to stop carrying a build
timestamp — that field made every rebuild differ even when the bundle did not,
which is precisely what let the old drift hide.

The domain fixtures are vendored under `harness/fixtures/`. Neither
`cedar-artifact-library` nor `cedar-test-artifacts` needs to be cloned or
checked out.

<a id="cee-getting-a-local-build-into-the-frontends"></a>

#### Getting a Local Build into the Frontends

Two routes. A **symlink** covers a tight edit loop, where the point is to see a
change without publishing anything. A **dev release to Nexus** covers the other
case — putting one named, fetchable build in front of every frontend at once,
which is what to reach for when the build is worth referring to later or worth
someone else installing. That route is
[Releasing a dev snapshot locally](#cee-releasing-a-dev-snapshot-locally) below; the
symlink is the rest of this section.

Point the consumer at `dist-npm/cedar-embeddable-editor` — `ln -s` over its
`node_modules/cedar-embeddable-editor` — and staging is then necessary but not
sufficient. The symlink means a consumer *resolves* the freshly staged bundle, but
every consumer **copies** it into its own served output, so each needs a second
step:

```bash
# Angular Workspace — copy the installed CEE bundle
cd $CEDAR_HOME/cedar-workspace && npm run copy:cee

# Production monolith while migration is in progress
cd $CEDAR_HOME/cedar-template-editor && npx gulp copy:cee

# OpenView and Bridging — the copy happens during the Angular build
cd $CEDAR_HOME/cedar-openview/cedar-openview-src && npx ng build
```

**A running `ng serve` will not pick a new bundle up, and restarting it is not
always enough.** It copies assets when it starts, and it does not notice the file
changing underneath it — still less the symlink being created after it started.
Worse, openview is on Angular 16 and its webpack build cache snapshots the
*symlink* rather than what the symlink points at, so a restart alone can replay a
cached copy of a bundle that is no longer there. Observed: a restart served a
bundle matching neither the symlink target nor any file in `dist/`, and went on
doing so for two minutes of polling. Clear the cache and restart:

```bash
cd $CEDAR_HOME/cedar-openview/cedar-openview-src && rm -rf .angular/cache
cedarcli native restart ui-openview
```

The cache is gitignored and rebuilds itself, so deleting it costs a slower first
compile and nothing else. Do not trust the restart on its own: check the hash.

This is worth knowing because of how it presents. A dev server started before the
symlink existed went on serving the **1.5.2** it had installed from npmjs, for a
day, while the CEDAR workspace served `1.6.0-dev` from the same symlink. The
symptoms were smaller type, a different typeface and no field-type icons in
openview alone — which reads as a CEE styling bug in one host, and sends you
looking at stylesheets and the shadow boundary rather than at which file is being
served. 1.5.2 predates the private font names, the unified type scale and the icon
slot, so all three symptoms came from the version and none from CSS.

Ask what each host actually serves before believing anything about appearance:

```bash
curl -s http://localhost:4220/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://localhost:4200/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://localhost:4201/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
shasum -a 256 $CEDAR_HOME/cedar-embeddable-editor/dist-npm/cedar-embeddable-editor/cedar-embeddable-editor.js
```

Four matching hashes mean the hosts agree and any remaining difference is theirs
rather than CEE's — configuration, or something the host page sets. openview sets
`readOnlyMode: true`, for instance, so it legitimately shows no bound hints and no
clear buttons. `window.cedarEmbeddableEditorVersion` names the build in a page
that is already open, but it reports the label rather than the contents: a staged
bundle keeps the version from its last release until one is cut, so two different
builds can both call themselves the same dev version. The hash is what
distinguishes them.

<a id="cee-releasing-a-dev-snapshot-locally"></a>

#### Releasing a Dev Snapshot Locally

A snapshot is a real published version, so every frontend can name it and install
it, and anyone can fetch it later. Reads from Nexus are anonymous; only publishing
needs the credential already in `~/.npmrc`.

Version it `<next>-dev.<date>.<sha>`, where the commit is the one whose content
ships and the date is *that commit's*. Bump `package.json` and the two root
entries in `package-lock.json` — take care, since a dependency may legitimately
also be at the version being replaced — and set the load-trace stamp to
`'<YYYY-MM-DD HH:MM> <sha>'` naming the same commit. `check:npm-package` compares
the two and fails if they disagree. Then run the gate, stage, and publish with the
tag stated explicitly:

```bash
npm run test:visual && npm run package:npm:prebuilt
cd dist-npm/cedar-embeddable-editor && npm publish --tag dev
```

Each frontend then names the snapshot through an npm alias, because npm routes by
scope and this is the only package taken from Nexus:

```json
"cedar-embeddable-editor": "npm:@org.metadatacenter/cedar-embeddable-editor@<next>-dev.<date>.<sha>"
```

All seven manifests already carry the `@org.metadatacenter:registry` line an alias
needs. Install, then get the bundle into what each host serves:

| Host | Install | Then |
|---|---|---|
| `cedar-workspace` | plain | `npm run copy:cee` |
| `cedar-template-editor` | plain | `npx gulp copy:cee` (needs the profile sourced) |
| `cedar-bridging` | plain | restart the server |
| `cedar-openview` | plain | restart the server; publication alone materializes `cedar-openview-dist` |
| `cedar-component-demo` (Angular) | plain | nothing to deploy — it is not served here |
| `cedar-component-demo` (Ember, React) | plain | nothing — they run from source |

The install is what places the new bytes for openview and bridging. Neither imports
CEE: each declares an asset glob that copies `cedar-embeddable-editor.js` out of
`node_modules`, and loads it through a script tag in `index.html`. A **running `ng
serve` still serves what it started with**, because a `node_modules` swap is not a
source change, so `ui-openview` and `ui-bridging` need restarting and the restart is
the deploy; the same `.angular/cache` caveat above applies to openview. Native
Workspace and monolith Gulp servers need no restart — each serves the file
`copy:cee` wrote, so there the copy is the deploy. A Workspace preview image must
instead be rebuilt and recreated because its CEE bundle was copied into the image.

`cedarcli build this` deploys nothing to any of them. It builds in an isolated
workspace and leaves the repository's own `dist/` untouched, so reach for it to prove
a host still compiles against the new bundle, not to put one in front of a server.

```bash
cedarcli native restart ui-openview ui-bridging
```

Compilation is seconds, not minutes: `ng serve` reports `Compiled successfully` in
the frontend log — `$CEDAR_HOME/log/frontend-<name>.log` — and 400ms is typical for
an incremental rebuild. If a check still shows the old bundle after that, the
build is not what is behind; look at what is being fetched.

Then confirm, and **ask each host at the path it actually serves** — they differ,
and checking the wrong file reads exactly like a failed deploy:

| Host | Where the bundle is |
|---|---|
| Extracted Workspace (`cedar-workspace`) | `/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| Production monolith (`cedar-template-editor`) | `/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| openview | `/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| bridging | `/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js` |

Every host serves the bundle as a file, so compare sha256 against the staged one in
each case. That holds for the distributions too: a build copies the same file to the
same path rather than folding it into `main.<hash>.js`.

Compare the hash rather than the version, because a dev snapshot's two versions
differ by design. CEE stamps the bundle with the commit it was last versioned at, so
the snapshot published as `2.0.12-dev.20260913.96b2097` carries the stamp
`2.0.12-dev.20260911.448b9d2e`, and a check reading the stamp against the version
npm resolved fails a correct deploy. A bare semver is weaker still: the bundle holds
every dependency's version, so a `2.0.3` in it may belong to something else entirely.

```bash
# The four running servers. All four answer with the staged bundle's hash.
curl -s http://127.0.0.1:4220/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://127.0.0.1:4340/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://cedar.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://workspace.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
```

The committed distribution directories are a separate question, and asking them this
after a local deploy invites the false alarm this section exists to prevent. A train
or a publication writes `cedar-bridging-dist` and `cedar-openview-dist`; nothing done
locally does, so each keeps the CEE of the last one until then and answers with an
older hash while every running server is correct.

```bash
shasum -a 256 $CEDAR_HOME/cedar-bridging/cedar-bridging-dist/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js
```

<a id="cee-first-time-setup"></a>

#### First-Time Setup

CEE resolves the model library from
`@org.metadatacenter/cedar-model-typescript-library` on the BMIR Nexus, so no
sibling checkout is needed. Only that one package comes from Nexus; everything
else resolves from npmjs.org, and reads need no credentials.

```bash
cd ../cedar-embeddable-editor
npm ci
npm --prefix harness ci
```

The visual suite needs no install of its own: it runs in Playwright's container,
which carries the browsers, and installs its dependencies there against a named
volume. It does need Docker running.

The gate should report 0 lint problems and, on 26 August 2026, at least 223 unit tests,
2,897 domain tests and 473 Playwright tests.

Read those as floors rather than as targets. Their only use is catching a suite that
silently ran nothing — a filter matching no file, a project that failed to start —
so what matters is the order of magnitude, and a count well below one of these is
worth explaining before it is written down as the new figure. A count *above* it
needs no explanation and is not a reason to edit this line.

The Git history already carries three warnings about doing that anyway. It
once carried a Karma figure years after the move to Vitest; the numbers above
replaced a set that had drifted in both directions at once, low on unit and
Playwright and high on domain, because removing four snapshot recordings that
compared minted identifiers took the domain count *down*; and the Playwright figure
disagreed with the one in
[Running the visual baseline](#cee-running-the-visual-baseline) by 42. Prefer citing a date
and a floor to maintaining an exact number in more than one place.

Use the complete gate before pushing or opening a pull request. The focused
commands below are faster feedback while working on one layer.

<a id="cee-auditing-what-ships"></a>

#### Auditing What Ships

```bash
npm run audit:prod
```

`npm audit --omit=dev --audit-level=high`, and CI runs it as its own step after the
gate. `--omit=dev` because only runtime dependencies reach the bundle an embedder
downloads — the Angular CLI's tree is a hazard to a developer's machine, not to a
consumer. `--audit-level=high` because a moderate advisory against build tooling is
not worth stopping a release for, and the value of the step is that a failure means
something.

Deliberately **not** part of `test:ci`. It is the one check that can start failing
without anyone having changed anything, because it fails on a disclosure rather than
on a commit. Inside the gate it would break an unrelated pull request with an error
its author cannot fix there, and would teach people to expect a red gate for reasons
that are not theirs.

A root `npm audit` reports **0**, and so does `npm run audit:prod`. It reported 11
until `@angular-devkit/build-angular` was dropped — the webpack toolchain no build
target had named since the move to `@angular/build` — which took every `high` with
it, along with 427 packages. The three moderates that survived that, against
`@angular/cli` and the two packages reached through it, `@hono/node-server` and
`@modelcontextprotocol/sdk`, closed when the Angular toolchain moved to 22.1.8.
Expect the root number to move again on the next disclosure; `npm run audit:prod`
is the one that describes what ships.

**Never run `npm audit fix --force` here.** npm's idea of fixing the Angular
tooling is to walk it backwards: it proposed `@angular/cli@21.0.4` and
`@angular-devkit/build-angular@0.1002.1`, which is the *Angular 10* numbering —
adding 1,253 packages, removing 302, and undoing the upgrade march to silence
warnings about build tooling an embedder never downloads.

**Time a dependency bump against the release calendar, not against the advisory.**
Angular embeds the root `package.json` in the browser bundle, so changing a
dependency range changes the shipped bytes even when the dependency is a test-time
one that never runs in a host page. A CEDAR platform release proves the CEE its
train built byte-equivalent to the public npmjs package, and that proof reads a
changed range as an undeclared difference. Patching vitest between a CEE release
and the train that would consume it cost a second public release, 2.0.9, carrying
no code change at all. Land such a patch after a release rather than before one, or
expect to cut the package again.

`npm audit fix` also declines a patch it could take. The advisory against vitest was
fixed in 4.1.11, inside the declared `^4.1.10`, and `npm audit fix` reported "fix
available" while changing nothing, because the newest candidate it saw was the 5.0.0
major and `--force` is forbidden here. Install the patched version by name when that
happens.

That is also why a failure here is not automatically a release blocker. Read the
advisory and ask whether CEE reaches the vulnerable path — when `lodash-es` 4.17.21
was flagged for `_.template`, `_.unset` and `_.omit`, CEE called only `cloneDeep`
and no advisory described anything it could reach. Upgrade anyway if a fix exists,
because a flagged package is one every embedder would otherwise have to reason about
alone; but the reasoning belongs in the commit message, not in a version bump made
on reflex.

<a id="cee-what-ci-runs"></a>

#### What CI Runs

`.github/workflows/test.yml` runs the same release gate on every pull request and
on pushes to `main`, `develop` and the `cee-angular-**` branches. It is split for
latency, not semantics: the `prepare` job builds once, runs lint, type checking,
unit, coordinator and domain coverage, verifies the staged npm package, audits the
runtime tree and uploads `dist`; four `visual` jobs restore that exact build and run
Playwright with `--shard=1/4` through `--shard=4/4`. A shard failure fails the gate,
and `fail-fast` is off so one failure does not hide results from the other three.
The local `npm run test:ci` remains the one-command serial equivalent. Two of CI's
choices are deliberate and expensive to rediscover.

**The runner is `ubuntu-24.04-arm`, and the visual suite runs in a container.**
Screenshot baselines record a machine's text rasterisation as much as the
application's rendering, so recording on a laptop and checking on a runner
compares two things that were never going to agree. Measured on 2026-08-16, that
boundary moved 7 of 106 baselines by 124 to 393 pixels, and a `maxDiffPixels`
budget of 120 had been papering over it. `visual/run-in-container.sh` puts both
sides in Playwright's own image, so the baselines are `-linux`, the budget is
zero, and a diff can only mean CEE draws something different.

Two consequences worth knowing before changing either. The runner must be arm64,
because the script asks for `linux/arm64` and an x86_64 runner would rasterise
differently and put the problem back without saying so. And the image tag in that
script is the thing that moves every baseline at once — treat a bump the way an
OS upgrade used to be treated, by re-recording deliberately.

This was `macos-15`, pinned so a runner bump would not move the macOS baselines,
and specifically not `macos-14`, where Playwright served a WebKit frozen at v2251
against a driver expecting v2336 — `Page.overrideSetting: PushAPIEnabled` is
unimplemented there and every `newPage()` in the webkit-smoke project failed.
Linux builds are current, so that constraint left with the runner. macOS runners
cannot host a Linux container either way.

**One Node version, 24.19.0, for the whole job.** It used to change midway —
build on 16.20.2, switch to 20.20.2, reinstall, then test the already-built
`dist` — because Angular 14's toolchain and the Playwright the suite needs did
not accept the same version. Angular 15 onwards do, so the split went at that
hop, and the dist that ships is now produced on the same Node that exercised it.

Lint runs first, as the opening stage of `test:ci` rather than as a separate CI
step, so the gate has one definition locally and in CI. Warnings do not fail the
build. Lint covers source and visual TypeScript; `typecheck` runs strict, no-emit
programs for source, the domain harness and the visual suite. Playwright transpilation
is not the visual suite's type checker.
The toolchain matches the framework — `angular-eslint` 22, `typescript-eslint` 8,
ESLint 10, flat config in `eslint.config.mjs`.

**Four Angular rules are off, and three of them are decisions rather than debt.**
Angular 22's rule set reported 413 errors, of which 411 were `prefer-control-flow`
(203), `prefer-inject` (118), `prefer-standalone` (47) and
`prefer-on-push-component-change-detection` (43). Each asks for an architectural
rewrite that is tracked elsewhere or placed out of scope, and a gate nobody can
pass gets ignored rather than fixed. The OnPush one is not deferred but wrong for
CEE: the coordinator mutates model objects in place and the component tree reads
them under eager change detection, so OnPush would stop parts of the view updating.
Obeying it would undo by hand the Angular 22 migration that stamped `Eager` onto all
46 components. Moving to OnPush means moving to immutable updates or signals first.

**A lint upgrade proves nothing until the gate is shown to still fail.** Before the
toolchain moved, deliberate violations of `eqeqeq`, `banana-in-box`,
`no-unused-vars` and `prettier/prettier` were each confirmed caught under the old
`@angular-eslint` 14 — which was enforcing Angular 14's rules correctly on a
TypeScript three majors past what its parser declared support for. The same four
probes pass now. Re-run them after any future toolchain move.

Nothing is published from CI. Releasing the npm package is a separate, manual
procedure — see [Release](#cee-release) below.

<a id="cee-running-the-domain-test-harness"></a>

### Running the Domain Test Harness

The harness depends on the published model library, resolved from Nexus like
CEE's own dependency, so no local build of it is needed.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:domain
```

Expect **over 2,500 passing** on `develop` — 2,560 on 18 August 2026. For watch
mode, run `npm --prefix harness run test:watch`.

A green run here means CEE agrees with itself. For whether its output is
actually a valid CEDAR instance, see
[Checking output against the CEDAR model](#cee-checking-output-against-the-cedar-model).

<a id="cee-coverage"></a>

#### Coverage

```bash
npm run test:domain:coverage
```

Over `shared/factory`, `shared/handler`, `shared/util` and `shared/validation` —
the domain layer the harness actually targets — expect roughly **95%
statements**. The rest of `shared/` is Angular services, REST response models
and pipes, which the harness does not load and should not, so the headline
number for all of `shared/` is meaningless.

Coverage is enforced by directory rather than against that misleading
aggregate. All four carry a 90% statement and 85% branch floor. These grouped
thresholds are part of `npm run test:ci`, so a domain regression fails CI even
when every test assertion still passes.

The broad floors are backed by focused tripwires where churn is most dangerous.
The domain harness holds `ActiveComponentRegistryService` at 75% statements / 65%
branches and `TemplateRepresentationFactory` at 95% / 95%. The root unit suite
holds the artifact-input coordinator at 90% statements / 85% branches, the config
coordinator at 95% / 95%, and the wrapper at 70% / 60%. Do not replace those with
one global percentage: a heavily covered serializer can otherwise conceal an
untested artifact transition or widget-sync branch.

Branches sit below statements because Vitest 4 counts them differently, not
because the suite is weaker: it replaced the old V8 mapping with AST-aware
remapping and offers no way back, and source that cleared 90% everywhere under
Vitest 1 measures 86.6 to 91.5 under 4. No test was removed and no branch
stopped being exercised — branches the old mapping never counted are now in the
denominator.

Read the *never-called-function* list rather than the percentage. That is what
found the attribute-value hole in August 2026 — three functions no test had ever
entered, one of them the widget's delete button — and, right after it, a bug
that had been losing everything inside an element on reload.

To run one file (note: paths are relative to the repo root, not `harness/`,
because `vitest.config.ts` sets `root` to the repo):

```bash
npm --prefix harness run test -- harness/test/controlled-terms.spec.ts
```

<a id="cee-reading-a-template-from-yaml"></a>

#### Reading a Template from YAML

CEE parses templates through the CEDAR Model TypeScript Library, which reads
YAML into the same model it reads JSON into — so a template written either way
produces the same form. `harness/test/format-independence.spec.ts` checks that
over all 37 corpus templates, and `harness/test/instance-output.spec.ts` checks
the same for the instance CEE emits.

If either starts failing after a change to the parser or the emitter, the
question to ask is which of the two formats the new code is quietly assuming.

<a id="cee-opening-a-legacy-production-instance"></a>

#### Opening a Legacy Production Instance

Some stored instances predate repository minting for element occurrences and
carry `"@id": ""` on an occurrence. CEE deliberately gives only that legacy
shape a compatibility path. At its input boundary it clones the host's object,
uses the model reader's node classification to distinguish occurrence
containers from link and controlled-term values, and changes a blank occurrence
identifier to `null`. It never mutates the object supplied by the host. The
ordinary server PUT then recognizes the defect in the stored instance and mints
the repository identifier; the same blank introduced against a clean stored
instance is rejected.

Do not widen this exception. A blank root artifact identifier, a blank link or
term identifier, and a blank value in a new instance remain errors. Strict model
readers also continue to reject a blank occurrence identifier. The February
2024 TypeScript compatibility reader is the matching library path: it opens the
legacy occurrence with a warning and writes `null`. The regression contract is
in `harness/test/occurrence-identity.spec.ts`.

Deserialization failure at the custom-element boundary is fail-closed. CEE sends
an actionable error through `eventHandler`, renders no replacement empty form,
and does not spend the instance's set-once claim; the host may correct the value
through the same input. This applies to both `instanceObject` and the instance
inside `templateAndInstanceObject`. The browser regression is in
`visual/tests/render.spec.ts`, beside the other set-once input tests.

A successful first form render calls `eventHandler.ready()` exactly once for the
element. A rejected artifact calls no readiness callback, and attaching a handler
after rendering does not replay one; hosts that use it register the handler before
the artifact. The visual host still waits for fonts and layout after that signal,
because screenshot stability is a stronger condition than editor readiness.

Artifact intake has one owner: `ArtifactInputCoordinator` in the wrapper. It parses
an instance and builds a candidate `DataContext` / `HandlerContext` before publishing
anything, then advances one artifact revision. A rejected candidate changes neither
the live state nor the set-once claims. The inner editor receives those completed
contexts plus the revision and must not deserialize the raw host inputs again.
`WrapperConfigCoordinator` owns the independent configuration lifecycle and reapplies
the one accepted config whenever artifact intake publishes a replacement context.
Keep those responsibilities separate: artifact arrival order must not become config
state, and the renderer must not become a second parser.

Model-to-widget synchronization has one owner: the wrapper-scoped
`RenderSchedulerService`. Artifact input, multi-instance paging and mutation, and
page-break navigation update model state synchronously and schedule their registry
push with Angular's `afterNextRender`. Each schedule advances a generation and
cancels the previous one, so rapid inputs cannot apply stale state to a newer
component tree. Destroying the editor scope cancels pending work. Do not introduce a
local `setTimeout` to wait for a widget; schedule the whole post-render transition
through this service instead.

Model-to-host mutation reporting also has one owner: `HandlerContext` reports a
successful field or multi-instance operation to the wrapper, and the wrapper compares
the serialized instance with the last serialization it published before emitting a
composed, bubbling `change`. This is a model contract, not forwarded browser traffic:
focus, blur, paging, read-only controls and a no-op write emit nothing. The detail is
`CeeChangeDetail` and carries the operation, component path, value, validity, full
data-quality report, title and description. Field mutations also invoke the optional
`eventHandler.valueChanged(path, value)` callback. Keep the serialization comparison
at the wrapper boundary; reporting directly from widgets will miss non-native controls
and will duplicate events when control implementations change.

CEE deliberately does not own a dirty flag. The CEDAR workspace knows when persistence
succeeded, so `CeeDirtyTrackerService` in `cedar-template-editor` snapshots
`cee.currentMetadata` after load and after a successful create/update, then structurally
compares that baseline after every CEE model-change event. An edit therefore marks the
workspace dirty, an exact revert clears it, and a successful save establishes the new
baseline. The service's unit spec pins those three transitions and defensive copying;
the CEE browser suite's `host change notifications` group pins text, Material choice,
controlled-term, temporal, multi-instance, paging and read-only behavior in both viewport
projects. It lives in `visual/tests/host-change.spec.ts`, separate from the broad rendering
matrix, and uses the typed driver in `visual/tests/support/host.ts`; extend it whenever a
new mutation path is added rather than putting host API assertions back into
`render.spec.ts`.

Initialization is part of that contract. A canonical loaded instance emits no change.
If rendering has to normalize an existing temporal value to the field's declared storage
granularity, the serialized instance really did change, so CEE emits the corresponding
`valueChanged` event during initialization. A host that wants to observe that must install
its listener before assigning the artifact. The runtime assertion covers every required
`CeeChangeDetail` member, while the shipped custom-element declaration gives
`addEventListener('change', ...)` a `CustomEvent<CeeChangeDetail>` parameter. The legacy
`eventHandler.message` member has never been emitted and is deprecated until the next
major version removes it.

Shared Angular subscriptions use `takeUntilDestroyed` with the component's
`DestroyRef`; do not add component-local `Subscription.EMPTY` or `destroy$`
variants. The coordinator tier creates and destroys the real editor repeatedly and
requires its scoped widget registry to return to zero on every cycle. Add equivalent
teardown assertions when a new scoped registry, overlay owner or scheduler is added.
This rule includes delayed widget work: external-authority and controlled-term lookup
debounces, autocomplete panel-closing subscriptions, deferred panel opens and transient
revert/clear hints all terminate with the field. Their direct unit specs destroy the
injection scope while each kind of work is pending.

`harness/test/view-sync.spec.ts` is the model-to-widget contract. Its table covers
editable and read-only rendering for text, numeric, temporal, link, external
authority, controlled-term and checkbox values across a multi-element occurrence
whose next child is missing. `harness/test/pagination-invariants.spec.ts` enumerates
every content/page-break sequence through six children, including leading, trailing
and consecutive breaks. Extend those matrices when adding a new value shape or
navigation state; a one-off happy-path spec is not a replacement.

Multi-instance navigation state also has one owner:
`HandlerContext.multiInstanceObjectService`. `DataContext` owns the template and the
instance document; it does not keep a second reference to the navigation tree. The
tree alternates deliberately between two typed shapes: a `MultiInstanceInfo`
container maps child component names to their state, and each
`MultiInstanceObjectInfo` holds that component's cursor plus one child container per
element occurrence. Containers use an internal `Map`; component names are not
dynamic properties on a class. Occurrence counts remain derived from the live
instance, while cursors remain UI state. Rebuilding records the exact
template/instance pair so the inner editor does not reconstruct the same tree after
`DataContext.setInputTemplate` has already done so.

Keep the data-quality report's distinction intact when changing this model. Its
validity checks inspect the whole instance, but its `valueTree` is a snapshot of the
occurrence currently displayed. Its recursion now receives a component-state node
and moves into an occurrence container explicitly; do not restore the old casts that
treated containers and nodes as interchangeable.

<a id="cee-running-against-the-old-template-parser"></a>

#### Running Against the Old Template Parser

**Historical.** The hand-written JSON walk was kept alongside the
library-backed parser during the migration so the whole suite could be run
against either, which is what caught most of the defects. Both walks were
deleted once the swap had settled, and `CEE_TEMPLATE_PARSER` /
`CEE_INSTANCE_READER` no longer exist. On `develop` — before the migration —
the walk is the only implementation:

```bash
CEE_TEMPLATE_PARSER=json-walk npm test
```

Expect the same count either way. Four rendered list fields across the corpus
genuinely differ — `multipleChoice` normalised against the property's
cardinality rather than copied verbatim — and `harness/test/corpus.spec.ts`
names them one by one, so a difference that stops happening fails as loudly as a
new one. Run this before and after anything that touches
`factory/model-library-template-parser.ts`.

<a id="cee-checking-output-against-the-cedar-model"></a>

### Checking Output Against the CEDAR Model

Everything above checks CEE against itself. This checks it against the model.

The distinction is not academic. In August 2026 the harness had 1,488 passing
tests, including a pair that compare CEE's JSON output against its YAML output
and find them equivalent — and **zero** of the 37 instances CEE produced
validated against the template it built them from. The tests all agreed with
each other. None of them asked the model.

<a id="cee-why-a-template-can-validate-its-own-instances"></a>

#### Why a Template Can Validate Its Own Instances

A CEDAR template *is* a JSON Schema (draft-04) for its instances. Not a
description of one — the document itself, `properties` and `required` and all.
That is exactly how `cedar-model-validation-library` validates an instance:
`CedarValidator.validateTemplateInstance(instanceNode, schemaNode)` hands the
template to a JSON Schema validator as the schema.

So there is nothing to derive and no mapping to trust. Any draft-04 validator
can answer the question.

<a id="cee-the-canonical-check--cedar-model-validation-library"></a>

#### The Canonical Check — cedar-model-validation-library

`cedar-model-validation-library` is the arbiter. When it and anything else
disagree, it wins.

It needs **JDK 17** — the POM enforces `[17,18)` and will refuse 21 or 23 with
`RequireJavaVersion` — and its parent POM `org.metadatacenter:cedar-parent`,
which resolves only against the CEDAR nexus. Clone and `./mvnw install`
`cedar-parent` first if you have not; the public repos return 402 for it.

```bash
cd ../cedar-model-validation-library && export JAVA_HOME=$(/usr/libexec/java_home -v 17) && ./mvnw test
```

Expect **220 passing, 7 skipped**.

Its own fixtures are the thing to read: `src/test/resources/instances/*.jsonld`
paired with `src/test/resources/templates/*.json`, and
`TemplateInstanceValidationTest`, which is nine `shouldFail` cases each deleting
one required key. That list is the definition of the instance envelope.

The `scripts/validate-*.sh` wrappers do not currently run — they call `python`
rather than `python3`, want a `jsonschema` module that is not installed, and
point at a `template-schema.json` that is generated rather than committed.

<a id="cee-running-the-gate-on-one-artifact"></a>

#### Running the Gate on One Artifact

**This is the gate production artifacts have to pass**, so being able to point it
at an arbitrary file matters more than the test suite passing. You do not need to
add a fixture to the Java suite to do that: the library already ships runnable
entry points under `org.metadatacenter.model.validation.exec`, and
`ops/cedar_validate.sh` wraps them.

```bash
ops/cedar_validate.sh instance path/to/template.json path/to/instance.jsonld
```

```bash
ops/cedar_validate.sh template path/to/template.json
```

`element` and `field` take one file the same way. The first run resolves and caches
the dependency classpath under `target/`; after that a check is about 0.3s, fast
enough to loop over a directory of artifacts.

**Exit status is the point:** `0` valid, `1` invalid, `2` could not run. The
library's own mains print `Instance is invalid` and still exit `0`, which is
useless in a pipeline, so the script re-derives the verdict from the output. Check
the status rather than grepping the text.

It locates `cedar-model-validation-library` via `$CEDAR_HOME`, then
`CEDAR_VALIDATION_LIB`, then the sibling checkout, and needs the same JDK 17 as
above — which it will find itself if `JAVA_HOME` is unset.

What a real rejection looks like. The location is a JSON pointer into the
instance, which is what makes it actionable:

```
Instance is invalid. Found 1 error(s)
[ERROR]: object has missing required properties (['@id']), location: /
```

<a id="cee-the-same-check-in-the-harness"></a>

#### The Same Check, in the Harness

Running Maven is not something to do per-edit, so the domain harness runs the
corresponding checks on every `npm run test:domain` and `npm run test:ci`.
`harness/src/instance-conformance.ts` keeps the two validators explicit and
independent:

- `validateWithModel` parses the template and instance through the TypeScript
  model library and runs `InstanceValidator` over the result.
- `validateWithRawSchema` runs the exact emitted JSON-LD against the untouched
  Draft-04 template with `ajv-draft-04`, before a model reader can normalize a
  legacy shape or repair a contradiction.

The two specs that exercise those adapters are:

```bash
npm --prefix harness run test -- \
  harness/test/instance-conformance.spec.ts \
  harness/test/instance-schema-population.spec.ts
```

`instance-conformance.spec.ts` builds fresh and populated instances across the
field/cardinality matrix and builds an empty instance for each of the **37 corpus
templates**. Every corpus template must report **zero model errors**. There is no
exception list and no partial-pass corpus contract; the populated matrix separately
pins the expected incomplete-state errors for part-filled choice fields.

`instance-schema-population.spec.ts` is the complementary saveability gate. It
populates every value-bearing field through the real CEE handler, crosses
single/multiple field cardinality with all seven root and one-/two-level element
placements, and requires **zero errors from both validators**. Both verdicts are
needed: in August 2026 the model-only path hid stored multi-select fields whose
widget semantics emitted arrays while their raw JSON Schema still required an
object; the resource server rejected those instances on save. The exact captured
nested template and all five placements from that incident are permanent
regressions in the same file. `template-consistency.spec.ts` separately scans
the independent, HuBMAP, and visual corpora for any checkbox, attribute-value,
or `multipleChoice: true` list field not declared as an array.

<a id="cee-where-the-java-tie-break-is-recorded"></a>

#### Where the Java Tie-Break Is Recorded

The harness does not mirror the Java library's fixtures or maintain an ajv/Java
agreement suite. When the two TypeScript-side checks leave a model question in
doubt, run the canonical library through `ops/cedar_validate.sh` and record the
measured verdict in the focused regression whose behavior depends on it. The
comments and paired cases in `harness/test/cardinality.spec.ts` are the current
examples: they name the artifact mutation, the Java command and the distinct
verdicts for an omitted element and an empty array.

That keeps the Java decision beside the CEE behavior it settles without vendoring
another repository's conformance fixtures into this one. `ajv-draft-04` remains
an independent server-facing check, not a substitute for the canonical validator.

<a id="cee-when-to-run-which"></a>

#### When to Run Which

Change the emitter, the envelope, or `data-object-builder.handler.ts` →
run both conformance specs above, which the domain and unified gates run anyway.

Upgrade the model library, take a new CEDAR release, or find yourself arguing
with the harness about what the model requires → run Maven. Use
`ops/cedar_validate.sh` for the disputed artifact and write the Java verdict into
the focused regression it settles.

About to put an artifact into production, or holding one artifact whose verdict you
actually need → `ops/cedar_validate.sh`. This is the gate itself rather than an
approximation of it, so when the question is "will this be accepted", it is the
only answer that counts. Reach for it in preference to reasoning from the schema:
a draft-04 validator agreeing with it is evidence, not proof, and the two have
diverged before.

<a id="cee-running-the-visual-baseline"></a>

### Running the Visual Baseline

Screenshot and browser-behaviour regression against the production bundle. The
focused root command builds a fresh `dist/`, prepares the visual fixtures and
runs Playwright:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:visual
```

For first-time installation, including the Chromium browser binary, use the
[complete gate setup](#cee-first-time-setup). If running from `visual/` directly,
the equivalent commands after a production build are:

```bash
cd visual
npm run prepare:all && npm test
```

Expect **over 490 passing** in about a minute and a half — 497 on 3 September 2026,
416 on 17 August. The count grows as tests are added; treat a *fall* as something to
explain. `prepare:all` re-concatenates the
bundle from `../dist` and regenerates the template fixtures; run it after any
rebuild.

The browser files are divided by contract. `render.spec.ts` owns the broad visual,
layout and remaining integration matrix; `temporal.spec.ts` owns the time-picker and
temporal-normalization behavior; `host-change.spec.ts` owns the public mutation event.
Shared host operations belong in the typed `tests/support/host.ts` driver. Keep new tests
with the contract they extend instead of growing `render.spec.ts` back into the only suite.

It no longer *silently* tests a stale bundle if you forget — `npm test` refuses
to run when `../dist` is newer than the copy in `public/`. That guard exists
because the suite did exactly that, reporting green against the previous build,
and a real fix was briefly believed not to work on the strength of such a run.

Not all screenshots any more: the external-authority and BioPortal tests assert
behaviour — that a keystroke raises no error, that free text is discarded on
blur, that clicking a suggestion actually keeps the term it selects — because
that is a class of defect the domain harness cannot see and a baseline image
would not describe. Each of those iterates every widget rather than sampling
one; the last of them is there because sampling one hid a defect in five for
months.

To accept an intentional visual change:

```bash
npm run update:visual
```

That re-records inside the container, which is the only place a baseline means
anything. `npm --prefix visual run update` still exists and writes baselines for
whatever machine you are sitting at — on a laptop that is a `-darwin` file no CI
run will ever read.

Review every changed PNG before committing — a baseline update asserts the new
rendering is correct.

<a id="cee-when-a-baseline-passes-and-is-still-wrong"></a>

#### When a Baseline Passes and Is Still Wrong

Every screenshot is judged against an absolute budget, and that budget is now
**zero**: the suite runs in a container, so a laptop and a runner rasterise text
identically and a single differing pixel means CEE draws something different. The
history of how it got there is worth understanding before trusting a green run.

A proportional budget forgives in step with image size, so a localised change to a
tall page cannot move enough pixels to fail it: 1% of a 1280x4418 corpus page is
some 56,000 pixels. Six intended changes went green against stale baselines in a
single day that way — a decimal separator's colour and size, a placeholder from
`000` to `sss`, `AM` losing 100 of font weight, an occurrence chip going 32px to
26px, the UTC offset's alignment, and the type scale. Adopting the absolute budget
failed fourteen baselines at once, between 557 and 8,837 differing pixels each, none
of it rasterisation noise.

So a passing screenshot proved only that the difference was under budget, and that
was never the same claim as the baseline matching what CEE renders. At zero they
are the same claim, which is the point of the container: the tolerance existed for
cross-machine rasterisation, and there is no longer a machine boundary to cross.

**`npm --prefix visual run update` cannot fix such a baseline.** Playwright rewrites a snapshot only
when its comparison failed, so one that passes while depicting the previous
rendering stays as it is, however many times you run the update. Delete it and let
the suite write it fresh:

```bash
rm visual/tests/render.spec.ts-snapshots/07-timezone-*.png
npm --prefix visual test   # writes what is missing, and fails while doing so
npm run test:visual:prebuilt   # confirm it passes against what it just wrote
```

Then find out what actually moved, rather than accepting the new image because it is
new. Extract the committed version and compare scanlines:

```bash
git show HEAD:visual/tests/render.spec.ts-snapshots/07-timezone-desktop-linux.png > /tmp/old.png
```

Decode both and list the rows that differ, then group them into bands and look at
each one. A band the change in hand does not explain is a change some earlier commit
left behind — which is how the offset alignment was found still sitting in
`07-timezone` two commits after it shipped. Reading the bands takes a minute and is
the difference between re-recording a baseline and laundering an unexplained diff
into it.

<a id="cee-running-the-angular-unit-tests"></a>

### Running the Angular Unit Tests

```bash
npm run test:unit:ci
```

This is the headless, single-run form included in `npm run test:ci`. The root
`npm test` runs the same specs through Vitest, and `test:watch` is the
interactive form. It enforces the focused artifact/config/wrapper thresholds named
under domain coverage above. The unit layer is small; do not treat it as a substitute
for the domain and browser stages.

The coordination layer has a separate Angular-aware tier:

```bash
npm run test:coordinator
```

This is Angular's native Vitest builder, not the root hand-written Vitest config.
It initializes `TestBed`, compiles component templates and styles, and renders the
real wrapper → editor → renderer tree. It also tests scheduler supersession,
pending-work cancellation, and repeated wrapper teardown with an empty scoped
registry after every cycle. Coverage is deliberately limited to those coordinator
files and fails below 45% statements, 35% branches, 55% functions, or 45% lines. The
root runner excludes `*.coordinator.spec.ts`; adding a TestBed spec anywhere else is therefore
a configuration error rather than an accidentally half-working test.

<a id="cee-which-stage-sees-a-widget-defect"></a>

#### Which Stage Sees a Widget Defect

The stages divide by what they can observe, and a defect is only caught by a
stage that can see the layer it lives in. A read-write audit in September 2026
found thirteen defects in the widgets, every one of them in a layer no stage was
watching, so the division is worth stating.

The domain harness sees pure functions and model shapes, and sees them
thoroughly — `ClockTime`, `CedarTemporalValue`, `narrowByQuery`, what an
unanswered field records. What it cannot see is the widget that calls them.
`clock-time.spec.ts` proved the arithmetic of a 12-hour face while the picker
above it recorded midnight for a field nobody had entered a time into.

The root unit suite sees a widget's own decisions, constructing it directly with
stub collaborators. This is where a widget belongs, and where most of the
thirteen were caught once asked. It sees nothing of the template.

The coordinator tier sees rendered Angular markup and bindings. It can answer
whether a widget projects its feedback — a required checkbox group had a validator
deciding its fate and no `mat-error` to state the verdict, which every other
stage reports as working. A widget check that is genuinely about markup goes
here, as `checkbox-required-notice.coordinator.spec.ts` does.

The browser tier exercises the production bundle, including read-only specification
boxes, declared defaults versus supplied values, repeated-field paging, authority links,
accessible temporal names, read-only event suppression, and runtime configuration.
`harness/test/field-spec.spec.ts` and `harness/test/read-only.spec.ts` cover the pure
specification and read-only decisions; `component-render-decision.spec.ts` covers the
render choice. Use browser or coordinator checks for template behavior and the
harness for pure decisions.

The source panels have been replaced by downloads. `harness/test/download-content.spec.ts`
checks serialization; the browser suite checks menu contents, template-only read-only
exports, actual downloaded JSON/YAML bodies and filenames. Extend these contracts
when adding an export.

Three rules follow, each of them written after a defect that ignored it.

**Drive the widget the way the browser does.** Angular and Material semantics are
where these hid: `FormGroup.get` splits a name on `.`, so a `Dr.` option
registered a control that could never be looked up again; `addControl` keeps the
control already registered rather than replacing it; a form control bound to a
text input coerces an array through `String`; Material's checkbox writes its own
value during `click`, before the `input` handler overwrites it. None of that is
reachable by calling a method and asserting on a field. Send the event.

**A stub has to be a stub of what production builds.** The clearest failure in
the set was a green test: `widget-validators.spec.ts` handed `atLeastOneChecked`
a `{ Alpha: false, Beta: true }` that no widget produces, and passed for years
over a required field that could never be satisfied. Coverage does not help
here — the validator was covered.

**State an invariant once, across the family.** The widgets are copies of each
other, and a fix reaching one of them is the recurring shape: `performItemAdd`
was hardened and its two siblings kept the assertion it was hardened against;
`narrowByQuery` was written for seven authority fields and the eighth kept the
rule it replaced; seven widgets built a form group around a control they then
replaced. Five specs under `input-types/components/` are table-driven for that
reason, one invariant each: the group a widget binds holds the control it
validates (`input-control-binding.spec.ts`); emptying a field records nothing,
never an empty string (`emptying-a-field.spec.ts`); a required field emptied by
the user reports the requirement (`required-field-emptied.spec.ts`); an event a
read-only widget can still receive writes nothing (`read-only-events.spec.ts`);
and a widget shown two occurrences in turn shows only the second
(`paging-between-occurrences.spec.ts`). A new widget joins each table rather
than copying a spec. A second audit the next day found seven more defects in the
same layer. The three newer tables pin three of them — the authority clear
action wiping the requirement it had just raised, the attribute-value field
writing on a read-only blur, and the text field carrying one occurrence's ORCID
link onto the next — and the specs of the widgets they sat in pin the rest, with
two coordinator specs for the two that were claims about markup: the numeric
field's verdict reaching a `mat-error`, and the text field's link giving way to
an input.

---

<a id="cee-troubleshooting"></a>

### Troubleshooting

**`ng` refuses to run, or `npm install` fails with engine errors**
Check your Node version first — CEE is on 24.19.0 throughout, and a version
outside Angular 22's range fails in ways that look like something else.

**Harness: `SyntaxError: Invalid or unexpected token` pointing at line 1 of a
CEE source file**
The transform left `@Injectable()` in place, or the file was externalized and
never transformed at all. Both are handled in `harness/vitest.config.ts` — the
`oxc` block and the `TRANSFORM` patterns respectively. CEE sets
`experimentalDecorators` in `tsconfig.base.json`, but the transform reads the
nearest `tsconfig.json`, where it is absent.

Since Vitest 4 the settings live under `oxc`, not `esbuild`: Vite 8 transforms
with oxc and ignores an `esbuild` block, announcing that it has done so and then
failing every spec that imports a decorated class. `decorator.legacy` is
`experimentalDecorators`; `useDefineForClassFields: false` needs both
`assumptions.setPublicClassFields` and
`typescript.removeClassFieldsWithoutInitializer`.

**Harness: `No handler function exported from …/vitest/dist/worker.js`**
The root and the harness are on different Vitest versions. `harness/vitest.config.ts`
sets `root` to the repository, so the harness resolves the root's worker. Upgrade
both together.

The root `vitest.config.mts` intentionally has no `server.deps.inline` compatibility
list. That block existed for RxJS 6's package shape and named dependencies removed from
CEE years ago; RxJS 7 and the current Angular packages resolve without it. Do not restore
the block unless a current package demonstrates a concrete resolver failure.

**Harness: a suite reports "no tests" but exits green**
`deps.inline` is matching too broadly and has inlined `vitest` itself, giving
the spec files a second copy of `describe`/`it` that the runner never sees. Keep
the `TRANSFORM` patterns narrow. This failure mode looks exactly like success —
check the test count, not the exit code.

**Harness: `Failed to load url lodash-es`**
Resolution from `../src` walks up to a repo root with no `node_modules`. The
`ceeStubs` plugin in `vitest.config.ts` maps bare deps to the harness's copy;
add any new one there.

**A model library change reaches the harness but not the built app**
The harness consumes `dist/` through node's CommonJS entry; the Angular build
takes the ES module one. Both come out of `npm run build` in the library, but
only the ESM bundle exports named symbols, and it does so only because
`webpack.config.js` sets `output.library.type: 'module'` on that config. Without
it the file exports nothing but `default`, every import resolves to `undefined`,
and nothing fails until the widget runs in a browser — the domain harness stays
green throughout. The visual baseline is what catches it.

**Model library changes aren't visible to the harness**
The harness consumes the published package through CEE's root install, not a
local checkout, so a local build of the library changes nothing. To pick up
model-library work, publish a new dev version and bump the alias in the root and
visual CEE manifests:

```bash
cd ../cedar-model-typescript-library && npm run build && npm publish ./dist --tag dev
```

Publish with the explicit `./dist` path — a bare `dist` is read as a package name
and resolves an unrelated public package. Set the new version in `package.json`;
`npm run build` synchronizes it into `package-dist.json` and then copies that
manifest to `dist/package.json`. Each publish needs a new version, because npm
rejects a republish rather than overwriting. For a tight local edit loop, prefer
`npm link` over publishing a version per iteration.

**A test asserts something that looks wrong**
Check whether it sits in a "known defects (characterized, not endorsed)" block.
Those assert what CEE *does*, deliberately. [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee) carries what is open.

---

<a id="cee-building-the-model-library"></a>

### Building the Model Library

CEE consumes `@org.metadatacenter/cedar-model-typescript-library` as a published
package, so this is only needed when working on the library itself.

The library builds on **Node 24.19.0**, the same version CEE uses: `.nvmrc` names
it, `engines` declares `^24.15.0`, and CI pins it. It sat on Node 20 until
2026-08-16 — declared `>=20.19.0`, CI pinned 20.20.2, and the runbook called the
split deliberate on the grounds that the library is a separate build with its own
toolchain. That reasoning outlived its subject: Node 20 left maintenance in April
2026, so snapshots were being published from a runtime no longer receiving
security patches, and the whole gate turned out to pass on 24 unchanged — 86
suites, 932 tests, and the packed-consumer smoke test that imports the real
tarball. Nothing needs a sibling checkout: the test corpus is vendored under
`cedar-test-artifacts/`, along with the reference templates it compares against.

```bash
npm ci
npm run lint          # eslint over src, the eslint config and the smoke test
npm run typecheck     # tsc --noEmit
npm run test:coverage # jest with coverage thresholds enforced
npm run test:package  # build the tarball and install it as a consumer would
```

`test:package` is the one worth knowing about. It builds the real tarball,
installs it into a throwaway project outside the repository, and imports it
through CommonJS, through ESM, and against the shipped declarations. Unit tests
import from `src/` and so cannot catch a broken `dist/` — a missing export map
entry, a declaration that does not resolve, a dependency that was only ever a
devDependency.

`npm run build` synchronizes the version into `package-dist.json` before webpack
runs. That file is also where the published *name* comes from, and the name
selects the channel — scoped for a dev snapshot on Nexus, unscoped for a release
on npmjs. The repository itself is always `cedar-model-typescript-library`; see
the channel table below.

`.github/workflows/test.yml` runs exactly that sequence on `ubuntu-latest` with
a fifteen-minute ceiling, on every push and pull request to `develop`. Nothing
renders or screenshots, so it needs no macOS runner and no browser install,
unlike the CEE gate.

The model repository's ordinary test workflow publishes nothing. An immutable CEDAR build train is
the deliberate exception: it reruns this complete gate against the captured commit, stamps a
train-owned version and publishes the scoped package before building CEE. CEE resolves that exact
artifact from the BMIR Nexus npm registry
(`https://nexus.bmir.stanford.edu/repository/npm-cedar/`) through its own `.npmrc`.

<a id="cee-the-two-channels-and-the-name-that-selects-them"></a>

#### The Two Channels, and the Name That Selects Them

The library publishes to two places, and **the package name is what decides
which**. npm routes by scope, so this is not a flag or a registry setting on the
command line:

| Channel | Name in `package-dist.json` | Goes to |
|---|---|---|
| Release | `cedar-model-typescript-library` | public npmjs, where `latest` is currently 0.8.0 |
| Dev snapshot | `@org.metadatacenter/cedar-model-typescript-library` | Stanford Nexus, `@org.metadatacenter:registry` in `~/.npmrc` |

**A dev release to Nexus is scoped; a release to npmjs is not.** The name is held
by hand in `package-dist.json`, which `npm run build` copies to
`dist/package.json` — the manifest that publishes. Nothing derives the channel
from the version, so cutting a release leaves the manifest unscoped and the next
dev publish will aim at npmjs unless the name is put back. That has happened:
"Prepare release 1.0.0" dropped the scope, and the dev publish after it was
caught only by reading the dry run.

So read the **last line** of `npm publish --dry-run --tag dev` every time. It
names the registry, and it is the only check between a snapshot and public npmjs:

```
npm notice Publishing to https://nexus.bmir.stanford.edu/repository/npm-cedar/ with tag dev
```

`npm run test:package` takes the expected name from `package-dist.json` for the
same reason, so it exercises whichever tarball the build is set to ship.

<a id="cee-publishing-a-model-library-dev-build"></a>

#### Publishing a Model Library Dev Build

For a complete CEDAR build, prefer `cedarcli publish train`; the train publishes and records the
model itself, then wires that exact artifact into CEE. The manual procedure below remains useful for
standalone CEE development.

Version is `<next>-dev.<YYYYMMDD>.<sha>`, naming the commit whose content is
published and *that commit's* date — so the bump commit carries a version naming
its parent, as CEE's own dev versions do. Three files hold it by hand:
`package.json`, `package-lock.json` (two spots) and `package-dist.json`.
`package-dist.json` is also synchronised from `package.json` by
`sync-package-version.js`, which `npm run build` runs first, so editing it is
belt and braces rather than required.

From the library repository, on the Node its `.nvmrc` names:

```bash
npm run lint && npm run typecheck && npm run test:coverage
npm run test:package   # builds dist/ and installs the real tarball as a consumer
cd dist && npm publish --tag dev
```

Check the name before the version: a dev publish needs the scoped one, per the
channel table above.

`npm publish` is run **from `dist/`**, not the repository root: `npm run build`
writes `package-dist.json` to `dist/package.json`, and that is the manifest
carrying the published name — the scoped one for a dev snapshot. The root
manifest is always named `cedar-model-typescript-library` and is not what
publishes, so its name says nothing about where a build is going.

Neither manifest declares a registry. The target comes from the **scope**:
`@org.metadatacenter:registry` in `~/.npmrc` points at Nexus, so npm routes the
scoped name there. Confirm it before publishing, and check the dry run names the
registry you expect:

```bash
npm config get @org.metadatacenter:registry
cd dist && npm publish --dry-run --tag dev
```

`--tag dev` matters. Without it npm would move `latest`, and the dev tag is what
identifies the current dev build; consumers pin exact versions regardless, so a
tag move reaches nobody by itself. What is on Nexus can be read without
authentication, which is the quickest way to confirm a publish landed —
`npm view` against this registry returns nothing useful, so query it directly:

```bash
curl -s "https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter%2Fcedar-model-typescript-library" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d['versions'])); print(d['dist-tags'])"
```

A published version cannot be replaced, so the dry run is the check that matters.
Then bump the dependency in **both** CEE manifests that declare it — `package.json`
and `visual/package.json` — and run the full gate. A skew between them means the
domain tests and the bundle disagree about what the model is. The harness declares
none of its own: it imports `cedar-model-typescript-library` and resolves it from
the root install, so the root manifest is what it reads.

Both spell the dependency as an alias, `cedar-model-typescript-library:
npm:@org.metadatacenter/cedar-model-typescript-library@<version>`, which is how the
imports keep the unscoped name while the install comes from Nexus. A bare
`"cedar-model-typescript-library": "<version>"` resolves against public npmjs
instead, where the dev versions do not exist.

<a id="cee-release"></a>

### Release

`main` is owned by the release process. Work lands on `develop`.

There is one stable publish target: the unscoped `cedar-embeddable-editor` on public npmjs, under the
default `latest` tag, which `npm view cedar-embeddable-editor version` names. All seven embedding
manifests pin one exact stable version from npmjs; the propagation check confirms the matching
manifest and lockfile resolution in every consumer.
The stable registry goes from 1.5.2 straight to 2.0.1: 1.6.0 was
published on 2026-08-12 and unpublished from npmjs afterwards, so a manifest still naming 1.6.0
cannot install, and the tarball it named cannot be fetched for comparison.
`scripts/npm-package.mjs` generates the published manifest, hardcoding the stable package name and
writing no `publishConfig`, so a stable package goes to `registry.npmjs.org`; the root manifest's
own `name` and `publishConfig` are not what publishes.

Dev snapshots are a second channel: the scoped `@org.metadatacenter/cedar-embeddable-editor` on
Stanford Nexus under a `dev` tag, versioned `<next>-dev.<date>.<sha>`. It was retired for a while and
is live again. Query the registry before relying on the mutable `dev` tag; pin an exact version in
an embedding app through an npm alias, since npm routes by scope and this is the only package taken
from Nexus.
Train-owned snapshots use the more specific
`<next>-dev.<train-date><train-minute>.g<sha12>` identity, tying the package to both the train and
the captured CEE commit without rewriting CEE source history.

`scripts/npm-package.mjs` derives the channel from the version rather than taking it as a flag: a
version containing `-dev.` is published scoped, with a `publishConfig` naming the Nexus registry;
anything else is published unscoped to npmjs. So a snapshot cannot reach npmjs by a forgotten flag.

The **tag** is not covered by that. npm 11 ignores `publishConfig.tag` — a dry run of the snapshot
manifest reports `tag latest` — so `--tag dev` has to be passed on the command line. Without it the
scoped package gains a `latest` pointing at a prerelease, a tag it does not otherwise have.

Do not publish CEE unscoped to Nexus. That name exists there already, carrying a 2023 lineage:
`2.6.20`–`2.6.24` from early 2023 and `1.0.3` as `latest`. Any 2.x published now sorts below
`2.6.24`, so a range like `^2.0.0` would resolve to a three-year-old build. `npm-cedar` is a hosted
repository and proxies nothing, so an unscoped package cannot be reached selectively anyway: npm
routes by scope, and pointing a whole app at Nexus would break every dependency it does not hold.

Version is surfaced at runtime as `window.cedarEmbeddableEditorVersion`.

> `gocee`, `gocedar` and `gobridging` are CEDAR profile aliases (cd to the respective
> repo). **Never commit npm tokens, passwords, or OTPs.**

<a id="cee-prerequisites--registry-auth"></a>

#### Prerequisites — Registry Auth

Publishing needs rights on `cedar-embeddable-editor` at npmjs, and npm requires a second factor:
pass `--otp=<code>`, or hold a granular access token with "Bypass 2FA" in `~/.npmrc`. An `E404` on
publish means unauthenticated rather than missing — check `npm whoami` before believing the package
disappeared. Confirm the account without printing any credential:

```bash
npm whoami
```

A token is a credential — keep it in `~/.npmrc` only, never in a repo or these notes.

<a id="cee-1--bump-the-version"></a>

#### 1 · Bump the Version

A release version is plain semver — for example, `2.0.3`. Only **two** files hold it by hand:

| File | Occurrences |
|---|---|
| `package.json` | 1 (`"version"`) |
| `package-lock.json` | 2 (top-level `"version"` + the root `""` package entry) |

Everything under `dist-npm/cedar-embeddable-editor/` is **generated** and git-ignored —
`scripts/npm-package.mjs` derives the manifests from the root `package.json`, `types:public` emits
the declarations, and the README and changelog are copied from the root. Do not hand-edit any of
them; staging overwrites them. (Older notes describing "six version spots", or the directory as a
committed artifact, predate that script and the ignore.)

CEE deliberately has no `package-dist.json`. The model library needs that second source manifest
because its root and published packages have different names. CEE's staging script already performs
the same translation: a plain version produces `cedar-embeddable-editor` for npmjs, while a version
containing `-dev.` produces `@org.metadatacenter/cedar-embeddable-editor` for Nexus. Copying the
model library's manifest into CEE would create a second manual version and channel switch that could
disagree with the tested package; `.gitignore` rejects that accidental file.

Then add a `## [X.Y.Z] - <date>` section to `CHANGELOG.md`, and bump the load-trace stamp in
`src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts`
→ `private static INNER_VERSION = '<YYYY-MM-DD HH:MM>';`, the time the bump was written. 2.0.1 stamps
`'2026-08-21 15:09'`.

> `ceeVersion` derives from `package.json` and is exposed as `window.cedarEmbeddableEditorVersion`,
> so bumping `package.json` is what drives the visible version. `INNER_VERSION` is only the stamp
> logged at load. `README.md` and `CHANGELOG.md` are copied into the package by staging — no manual
> `cp` step.

The stamp is the only version spot nothing derives — every other copy is generated from
`package.json`, so a forgotten stamp used to ship a bundle that passed everything and then reported
the previous release to anyone reading the console. `check:npm-package` guards that only for a dev
version, where the version's trailing sha and the stamp's must name the same commit; a stable version
carries no commit, so the check reports `(stable, no load-trace commit to check)` and passes whatever
the stamp says. Read it yourself before publishing a release.

If the root already reports the requested release version, do not rerun `npm version`: npm rejects
an idempotent version request as `Version not changed`. Check first, then bump only when needed:

```bash
node -p "require('./package.json').version"
npm version X.Y.Z --no-git-tag-version
```

<a id="cee-2--test-and-stage-the-package"></a>

#### 2 · Test and Stage the Package

The operator command now has the same shape as the model library's:

```bash
npm run test:package
node -p "require('./dist-npm/cedar-embeddable-editor/package.json').name + '@' + require('./dist-npm/cedar-embeddable-editor/package.json').version"
```

For a stable `X.Y.Z`, the second command must print
`cedar-embeddable-editor@X.Y.Z`. For a dev version it must print the scoped
`@org.metadatacenter/cedar-embeddable-editor@<DEV_VERSION>` identity.

`test:package` builds production, runs the Playwright baseline, checks the bundle size, emits the
public declarations and compiles the README examples against them, then writes and verifies
`dist-npm/cedar-embeddable-editor/`. Staging publishes
`visual/public/cedar-embeddable-editor.js` and refuses to run unless that file's SHA-256 and byte
count match `visual/public/bundle-manifest.json`. The published artifact is therefore the exact
bundle a browser exercised.

<a id="cee-3--publish"></a>

#### 3 · Publish

A release goes to npmjs, unscoped, under `latest`:

```bash
cd dist-npm/cedar-embeddable-editor && npm publish
```

A dev snapshot goes to Nexus, scoped. The registry comes from the staged manifest; the tag does not,
so pass it:

```bash
cd dist-npm/cedar-embeddable-editor && npm publish --tag dev
```

> Dry-run it first. A published version cannot be replaced, and the dry run names the registry and
> the tag it would use — the cheapest way to catch a wrong target while it is still reversible:
>
> ```bash
> npm publish --dry-run
> ```

Then confirm what moved. For a release:

```bash
npm dist-tag ls cedar-embeddable-editor
```

`latest` should point at the version just published, and it should be the only tag. For a snapshot,
read the tags off Nexus, where `dev` should be the only one:

```bash
curl -s "https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter%2fcedar-embeddable-editor" | python3 -c "import json,sys; print(json.load(sys.stdin)['dist-tags'])"
```

<a id="cee-4--commit-tag-the-release-and-draft-its-notes"></a>

#### 4 · Commit, Tag the Release, and Draft Its Notes

Nothing in the publish records which commit was staged, and `npm publish` will happily ship a dirty
working tree. Commit the release preparation immediately after the publish, then tag that commit
rather than a later merge:

```bash
git add package.json package-lock.json CHANGELOG.md \
  src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts
git commit -m "Prepare CEE release X.Y.Z"
git push
RELEASE_COMMIT=$(git rev-parse HEAD)
git checkout main
git pull
git tag -a release-X.Y.Z "$RELEASE_COMMIT" -m "CEE X.Y.Z"
git push origin release-X.Y.Z
git checkout develop
```

If the tag is added later and the commit is no longer obvious, the published package identifies it.
Three of its files are copied rather than generated — `README.md`, `CHANGELOG.md` and
`license.txt` — so `npm pack cedar-embeddable-editor@<version>` and a hash of those three against
each candidate commit settles which tree was staged. That is what distinguishes the bump commit on
`develop` from the merge on `main`, which can differ in nothing else.

Then draft the release notes against the tag:

```bash
gh release create "release-${CEE_VERSION}" --draft --title "CEE ${CEE_VERSION}" --notes-file <notes.md>
```

<a id="cee-5--advance-development"></a>

#### 5 · Advance Development

Back on `develop`, advance to the next development base. The version itself selects the scoped
Nexus channel, so there is no package name to restore:

```bash
DEV_SHA=$(git rev-parse --short HEAD)
DEV_DATE=$(git show -s --format=%cd --date=format:%Y%m%d HEAD)
npm version "<NEXT>-dev.${DEV_DATE}.${DEV_SHA}" --no-git-tag-version
```

Update `INNER_VERSION` to name the same date and SHA, then verify the generated identity without
publishing it:

```bash
npm run test:package
node -p "require('./dist-npm/cedar-embeddable-editor/package.json').name + '@' + require('./dist-npm/cedar-embeddable-editor/package.json').version"
# Must print @org.metadatacenter/cedar-embeddable-editor@<DEV_VERSION>
git add package.json package-lock.json \
  src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts
git commit -m "Advance CEE to next development version"
git push
```

CEE's notes follow the shape 2.0.3's carry, which is not the one
[cedar-project's releases](https://github.com/metadatacenter/cedar-project/releases) use — those
announce a platform deployment to the people who use the Workbench, and CEE ships a package to the
people who embed it. One opening line names the release and links the npm package. One paragraph
says what most of the release is, in specifics. Then the changelog's own headings — Added, Changed,
Removed, Fixed, Security — each bullet led by a bold clause naming the thing that changed, with
`Fixed` grouped under bold labels once it runs long. The pre-release-builds note and the link to
the full changelog close it.

A bullet is one or two sentences — 20 to 30 words, 45 at the outside. It says what changed and, if
it is not obvious, what was wrong before; the reasoning behind it stays in `CHANGELOG.md`, which is
where a reader who wants it will look. Lead with the concrete subject: "A `change` event naming the
field that changed" is a bullet, while "a host is told what changed rather than that something did"
is a riddle whose answer is the bullet.

`CHANGELOG.md` is the source for the notes and not their shape. It records every change; the notes
select the ones an embedder has to act on or would want to know about, and say what each is for.
Publish the draft once someone has read it.

Releases before 2.0.1 carry tags but no GitHub release; 1.6.0's tag was added retroactively, at
`8a9e3693`.

<a id="cee-6--propagate"></a>

#### 6 · Propagate

Seven manifests across five repos depend on CEE. Workspace is a required consumer alongside the
production monolith and the existing auxiliary/demo frontends. A stable release names one exact
version resolved from npmjs:

```json
"cedar-embeddable-editor": "2.0.3"
```

Its lockfiles record the npmjs tarball and integrity hash, so what installs is reproducible.
Installing needs no credential; only publishing does. A development snapshot instead uses the
scoped `@org.metadatacenter` Nexus alias.

Each repo carries an `.npmrc` holding `@org.metadatacenter:registry` against Nexus, which is required
while a development snapshot is pinned and harmless for a stable npmjs release.

| Repo | Manifest | Install |
|---|---|---|
| `cedar-workspace` | `package.json` | plain |
| `cedar-template-editor` | `package.json` | plain |
| `cedar-bridging` | `cedar-bridging-src/package.json` | plain |
| `cedar-openview` | `cedar-openview-src/package.json` | plain |
| `cedar-component-demo` | `cedar-cee-demo-angular-src` | plain |
| `cedar-component-demo` | `cedar-cee-demo-ember-src`, `cedar-cee-demo-react` | plain |

Every consumer installs in plain mode. OpenView needed `--legacy-peer-deps` while it carried
`ngx-youtube-player-14`, which demanded `@angular/common@^14.1.3` from a project on Angular 16; that
package left with the unreachable dependencies, and a plain install now resolves. The Angular demo
needed the flag until it moved to Angular 22, for a different reason: it declared
`@angular/material`, which wants `@angular/forms`, and used neither.

The mode reaches further than the install. The train and the release regenerate each consumer's
lock when they pin a CEE version, and a lock written under `--legacy-peer-deps` omits the peer
packages a plain install records, which that repository's plain `npm ci` then refuses as out of
sync with its manifest. The mode a consumer's own CI uses is therefore the mode
`frontend-train.json` and `propagate-cee-release.mjs` must name for it.

Propagate all seven pins with the checked cross-repository helper. It updates each manifest and
lockfile using the appropriate npm peer-dependency mode, then fails unless Workspace and every
existing consumer resolve the exact version from the correct registry:

```bash
export CEDAR_HOME=/path/to/CEDAR
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --apply <CEE_VERSION>
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check <CEE_VERSION>
```

Never replace the helper with a remembered consumer list: its tested inventory is the guard that
keeps Workspace wired into every CEE release. Review and commit the resulting manifest and lockfile
changes in each owning repository separately.

There are two deliberately different propagation paths. A stable CEE release still uses this helper
to make reviewable changes in the owning source repositories. An immutable development build train
does not modify those repositories: in disposable exact-commit checkouts it publishes the captured
model after its full gate, wires it into CEE, runs CEE's full ARM gate, publishes that CEE, and then
wires the verified CEE into all seven consumers. The train records hashes of those transformed
manifests, locks and rebuilt payloads before publishing the frontend artifacts. See
[BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md) for `npm/model/completed`, `npm/cee/completed`, and the final
`npm/completed` record.

The train-backed CEDAR release then requires an explicit public CEE version. It verifies both
tarballs and accepts the npmjs package only when its executable bundle is byte-identical after
normalizing the single embedded CEE version, model-package identity and load trace. It also permits
only the package channel metadata, the manifest derived from those bundle bytes, and one dated
current-release changelog entry; every other packaged byte must match. This proves the public model
substitution did not change the model code compiled into CEE and prevents an independently changed
CEE from being substituted into the CEDAR release. The closed normalization list and its failure
rules are in [NPMJS-RELEASE-RUNBOOK.md](./NPMJS-RELEASE-RUNBOOK.md#use-the-public-cee-in-a-train-backed-cedar-release).

Propagating a release also means rebuilding each deployed consumer.
Confirm the bytes rather than the version string: the sha256 that `package:npm:prebuilt` prints should
appear in each consumer's `node_modules`, and again wherever that consumer stages the bundle —
`app/third_party_components/` for both Workspace and the monolith,
`dist/cedar-openview/node_modules/` for OpenView.

```bash
gobridging  && npm install && cd .. && cedarcli build this --wd "$PWD"
cd $CEDAR_HOME/cedar-workspace && npm run copy:cee
cd $CEDAR_HOME/cedar-template-editor && npx gulp copy:cee
```

A rebuild is what reaches a running frontend; the manifest edit and the install only change what
resolves. Both Workspace and `cedar-template-editor` copy the installed bundle during Gulp. The
production deployment procedure must build whichever of those two payloads the environment serves,
and during migration builds both ([PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) step 6).

<a id="cee-gotchas"></a>

#### Gotchas

- **Publish only from `dist-npm/cedar-embeddable-editor/`.** From the repo root, `npm publish` uses
  the root manifest and packs the whole source tree.
- **Staging refuses a stale bundle** rather than shipping one. `browser bundle does not match its
  manifest` means run `npm run test:visual` again; it is the guard working, not a fault.
- **Reaching an environment is a separate step.** Publishing does nothing there until every served
  CEE host—including Workspace and the monolith during migration—is rebuilt against the new version,
  its served hash is verified, and the environment cache-buster/CDN entries are changed or purged
  (PROD-DEPLOY-RUNBOOK + frontend-caching).

<a id="ced"></a>

## Embeddable Designer (CED)

CED is a UI component. The embedding host owns artifact persistence, authentication,
permissions, server validation requests, publishing, version allocation and provenance.
CED edits supplied documents, reports changes and local validation, and renders the
editing state supplied by its host. Reusable-field and preference storage also belongs
to the host. Keep future integrations within that boundary.

Running, building, testing and packaging `cedar-embeddable-designer` (CED), the
Web Component for authoring CEDAR templates and elements.

CED is the authoring half of a pair. The [CEDAR Embeddable Editor](FRONTEND-RUNBOOK.md#cee)
renders a template as a form and produces instances; CED produces the templates
CEE renders. It is a different component from the AngularJS Template Designer
that serves `/templates/edit/...` in production, which it is meant to replace.
What CED still needs before it can stand in for that designer is in
[FRONTEND-ROADMAP.md](FRONTEND-ROADMAP.md#ced).

<a id="ced-where-the-design-values-come-from"></a>

### Where the Design Values Come From

The designer's type scale and palette are CEDAR's, published from `cedar-design-tokens` as
`@org.metadatacenter/cedar-design-tokens`. `src/styles.css` imported them on 2026-09-15 —
`@import '@org.metadatacenter/cedar-design-tokens/custom-properties.css'` — in place of the hand
translation it had been holding, which had been faithful in all nineteen shared properties except
the advisory colour it had let drift. Tailwind's `@theme` reads custom properties rather than Sass
variables, which is why this consumer takes the emitted file and not the partial. The five steps of the scale are 12, 14, 15, 18 and 20px, and a size between two
of them is not on it: the designer ran 11px controls under 10px labels until 2026-09-15, and every
seam where that met a component at CEE's 14px showed.

<a id="ced-requirements"></a>

### Requirements

Node 24.19.0, which `.nvmrc` pins and CI runs — the same version CEE and
`cedar-embeddable-term-picker` use. Nothing here needs Java or a running CEDAR stack, except
controlled-term search, which needs a terminology server.

```shell
nvm use
npm install
```

`npm install` reaches the CEDAR Nexus for one dependency,
`@org.metadatacenter/cedar-model-typescript-library`. Nexus being down is
therefore a broken install and a red CI run, with everything after the install
step unaffected.

<a id="ced-running"></a>

### Running

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

For the standalone bundle demo, run `npm run demo:prepare`, then serve
`dist-bundle/` with a static HTTP server. This stages the versioned
`demo/index.html` and the current CETP and CEE bundles together; rerun it after
rebuilding either sibling.

<a id="ced-building"></a>

### Building

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

<a id="ced-internal-boundaries"></a>

### Internal Boundaries

`EditorSession` owns the authoring document and active container. `TemplateService`
coordinates commands and UI navigation; `core/model/document-validation.ts`
validates a document snapshot and pending settings drafts without Angular state.
`core/model/cedar-template.ts` remains the only model-library adapter. Presentation
colors come from CSS tokens, never from the document service.

The shared package README describes design ownership and host styling. CED's
native compact controls retain the API in CEE's `STYLING.md`.

<a id="ced-testing"></a>

### Testing

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
server, and the one covering `<cedar-embeddable-term-picker>` registers a stub element in
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

<a id="ced-what-the-machine-decides"></a>

#### What the Machine Decides

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

<a id="ced-packaging-and-release"></a>

### Packaging and Release

Which registry a package belongs to is derived from its version rather than
passed at publish time. A version carrying `-dev.` is a snapshot and names the
CEDAR Nexus under `@org.metadatacenter`; anything else is a release for public
npmjs, unscoped. A snapshot therefore cannot reach npmjs by forgetting a flag,
and the rule has tests of its own because publishing to npmjs is not an action
anyone can take back.

The first Nexus snapshot is
`@org.metadatacenter/cedar-embeddable-designer@0.1.0-dev.20260916.2593d382`.
CED is not released on npmjs. The component is outside `cedarcli`'s current
publication plan: version the snapshot against its source commit, run
`npm run test:ci` (set `CEF_BUNDLE` to a pinned CEE bundle), then verify the staged
package with `npm publish ./dist-npm/cedar-embeddable-designer --tag dev --dry-run`
and publish the same directory with `--tag dev`. Its `publishConfig` fixes Nexus
as the destination. Never rebuild between the browser gate and publication.
The general credential and tarball procedures are in
[NPMJS-RELEASE-RUNBOOK.md](NPMJS-RELEASE-RUNBOOK.md).

The published declaration is emitted from `src/app/ced-public-api.ts` alone,
which is written without imports so its declarations stand alone. Adding an
import to that file breaks the declaration build rather than shipping a `.d.ts`
that names paths only the repository has.

<a id="ced-embedding-it"></a>

### Embedding It

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

### CED in the Split Designer Host

Workspace's template and element links open `cedar-template-designer` on the
Designer hostname. That repository is a thin authenticated CED host; the combined
`cedar-template-editor` retains its separate authoring implementation.

Run `npm ci` in `cedar-template-designer`, then
`cedarcli native restart frontend designer`. Its lock pins CED and CETP from
Nexus and CEE/CEF 2.0.15 from npmjs. No sibling checkout is required. The first
component snapshots are CED `0.1.0-dev.20260916.2593d382` and CETP
`0.1.0-dev.20260915.0ec47d9c` under `@org.metadatacenter`.

The host verifies each installed bundle against its published SHA-256, and
`app/components/manifest.json` records each package's name, version and digest.
`npm run prepare:components` refreshes the served copies; `npm pack` includes
them through its prepack hook. Explicit local bundle-path overrides remain
available for development, but server payloads reject them. See the host README
for the override names. [`cedarcli check components`](#component-staleness) measures
what is served against what is pinned. The frontend train updates Designer's CEE pin alongside
its other CEE consumers; CED and CETP remain explicit immutable package pins.

The host owns SSO, repository child search, permission checks, dirty navigation,
ETag saves and the instance-aware template version confirmation. Standalone
field-document routes use CEFD from the same CED bundle; fields inside templates
and elements use the same field controls. During development, explicitly stage
the local CED bundle with `CEDAR_CED_BUNDLE` until a CEFD-containing Nexus snapshot
is pinned. The host fails clearly if the pinned bundle lacks CEFD, and
[`cedarcli check components`](#component-staleness) reports the same condition before a build.

Version creation requires the original ETag in `If-Match`; the resource
server conditionally publishes that exact source snapshot before creating the draft.
Missing validators return 428 and concurrent changes return 412 with no draft created.

Run `npm test` in the host repository for the host contract suite, and
`npm run smoke:ced-host` in `ops/e2e` for real browser create/update, stale-save
rejection, instance-aware versioning and Workspace return. The older `login-smoke-test.mjs` still targets
the combined editor's authoring UI; its legacy selectors do not exercise CED.

<a id="ced-running-it-with-its-siblings"></a>

### Running It with Its Siblings

The designer uses sibling web components the host loads, and none is bundled.
A field's constraint set is assembled with
[`<cedar-embeddable-term-picker>`](VERSIONING-RUNBOOK.md), and Preview renders the template
with [`<cedar-embeddable-editor>`](FRONTEND-RUNBOOK.md#cee), the same renderer that will
show the form to whoever fills it in.

```shell
npm --prefix ../cedar-embeddable-term-picker run dist
npm --prefix ../cedar-embeddable-editor run build:production
npm --prefix ../cedar-embeddable-editor/visual run bundle
npm run dist
cp ../cedar-embeddable-term-picker/dist-bundle/cedar-embeddable-term-picker.js dist-bundle/
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

CED starts with the **Modular** profile. To test reusable artifact search as local
`test1@test.com`, run `npm run demo:prepare` followed by `npm run demo:serve` in CED,
then open `http://localhost:4599/`. This loopback-only host reads Keycloak on 8080
and the resource server on 9007; credentials and renewable access tokens stay in
the demo server. Its API exposes reads only. The published component has no default
repository or account. The opt-in browser check is
`CED_LOCAL_REPOSITORY=1 npm --prefix browser test -- --grep 'local test1'`.

**Add Child** keeps the standard field palette and adds **Select existing fields and elements**.
Its dialog stages multiple first-class artifacts above a searchable, paginated results table,
with name, type, creation/modification dates, version and status. Bins remove staged rows;
Done inserts the complete batch at the selected position and Cancel discards it.
The embedding host supplies `childSource.search` and `childSource.load`; see CED's README
and `CedChildSource` public type for the callback contract. The host owns authentication
and permission filtering. Without that input, repository search reports unavailable.
Imported definitions retain their identifiers, provenance and descendants; conflicting
child names are resolved in their parent placements.

Field settings start collapsed behind the grey chevron centered at the bottom
of each card. Expanding it reveals underline tabs for the applicable values,
display, constraints, details, occurrences and metadata controls. Switching tabs
or collapsing the panel retains incomplete input; valid settings update immediately
without Apply buttons. Identity and provenance appear under Field metadata. Imported labels, identifiers, annotations and property IRIs remain
preserved in the model. Published fields allow tab
navigation and inspection while their editing controls remain disabled.
**Display** includes a Language selector for templates, standalone and nested elements,
and all fields (including static fields). Its default, **Not specified**, leaves language
unset; clearing a choice removes the explicit language. The bundled fixed list uses
ISO 639-1 codes and English names from the [Library of Congress](https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt),
retrieved 2026-09-15. Imported tags outside the list remain available as the current
value, without rewriting them. Published field controls remain disabled.

The bottom of **Display** on non-static fields contains **Alternate questions**.
Enter a question and select **Add question** to save it as an alternate label.
Blank or whitespace-only questions and duplicates (ignoring surrounding whitespace)
are rejected only on Add. The table is read-only;
its bin actions remove questions. Published field controls are disabled, and questions
are preserved in JSON/YAML round trips.

The **Annotations** tab is available on templates, standalone and nested elements,
and fields. An entry row above the shared table accepts an annotation name, value
type and value; **Add annotation** validates and inserts the entry, then clears the
form. Partial entry shows no error until Add is selected. The table displays saved annotations as read-only text with a bin action to
remove an entry; replace a value by removing it and adding the replacement.
Names must be nonempty and unique, values must contain non-whitespace text,
and IRI values must be absolute identifiers.
Invalid additions remain in the entry form without changing the artifact;
valid additions and removals update the artifact immediately. Published field annotation controls
are disabled. Annotation value types and other metadata survive unrelated edits
and artifact round trips.

The card-level Save field to library action has been removed; import and reuse
remain available through Field Designer.

The root template header has a settings chevron. **Display** offers full-width
Header and Footer controls; **Template Metadata** lists identity and provenance,
ending with **Types**. Element metadata also offers Types, including a standalone
element. Types uses CEF's read-only controlled-term summary and CETP with
`termTypes = ['class']`, without `maximumTerms`. Done writes the allowed instance
class IRIs into both `properties.@type.oneOf` enum branches; cancellation retains
the saved set. These are allowed alternatives, not a requirement to assign all
selected types. The serialized model retains the IRIs; picker labels and pins are
session selection details.

CED pins the published model development package `1.0.12-dev.20260915.076d468`
for multi-type and paragraph length constraints. New child placements explicitly
carry their effective display labels and descriptions so JSON and the model's YAML
reconstruction agree; absent imported overrides remain absent. Java's artifact
library also preserves the full set of instance types through JSON and YAML; its
`instanceJsonLdTypes()` API returns the list, while `instanceJsonLdType()` retains
the single-type compatibility view.

Paragraph Values settings expose minimum and maximum character lengths, including
zero; clearing either control removes that bound. Invalid limits or defaults remain
unsaved drafts with local validation feedback. JSON and YAML preserve the limits
through nested and repeated fields. Regular expressions are available only for text
fields.

The Overview shows each field's type icon and a right-aligned reorder handle.
Dragging reorders siblings within the Overview; the document and main editor update
only when the field is dropped. Focused handles also support Arrow Up/Down.
Element chevrons and the Overview's Expand all/Collapse all icon buttons share
collapse state with the central designer. Selecting an element scrolls its header
below the toolbar with clearance. Field type icons are labels only: changing an
existing field to another type or replacing it with a library field is not offered.

All default-capable fields use `<cedar-embeddable-field>` from the same CEE bundle.
Choose **semantic** in Preferences to expose Default Value. CED and CEE use the
model snapshot `1.0.8-dev.20260909.f1fbbbc` for typed defaults and JSON/YAML
serialization. Imported numeric constraints and temporal settings are retained;
temporal values are converted between the default's declared precision and CEF's
complete instance literal without shifting timezones. Choices are stored with
`selectedByDefault` on options, including multiple checkbox/list selections.

Numeric authoring validates minimum, maximum and defaults against the datatype,
finite-number limits, bound ordering and decimal precision. Integer datatypes accept
only whole numbers and zero or unspecified decimal places. Byte, short and int use
their datatype ranges; long is limited to JavaScript's exact integer range
(-9007199254740991 to 9007199254740991), because the model stores numbers rather than
arbitrary-precision integers. Float checks overflow and nonzero underflow. Invalid
and incomplete numeric input stays in the panel until corrected and does not replace
the saved settings. Occurrences appears immediately before Field metadata.

Rebuild CEE and refresh the sibling copy when testing defaults: an older CEE
bundle may omit email, phone, link and authority defaults from its preview even
when CED's output contains them. `npm start` refreshes the development host's
copies; a manually served `dist-bundle/` needs the copy commands above again.

Display label and Display description apply to the field's deployment in this
template. CEE gives those overrides precedence over the field's own labels and
description, and falls back to the artifact when an override is absent. Preferred
label remains part of the reusable field's metadata. Annotation authoring is tracked in the designer roadmap.

Field metadata (for dynamic fields) and Element metadata end with a compact Property IRI box and **Edit**.
They invoke CETP with `termTypes = ['property']` and `maximumTerms = 1`. Done
applies the selected property IRI to the child placement in its parent JSON-LD
context; cancellation preserves the existing IRI. The picker starts an empty
replacement selection because an imported property IRI has no ontology/version
provenance. The placement stores the IRI only; the ontology release chosen while
browsing is not a versioned value constraint. Published field controls are disabled.

Controlled defaults use the current `<cedar-embeddable-term-picker>` bundle's term-only mode,
then verify membership through the configured terminology server's
`bioportal/integrated-search`. A vocabulary constraint is required first. Several sources or version pins appear
in a vocabulary/release selector; membership checks still receive the entire field
constraint set and its actions. Constraint edits retain a permitted default and
require explicit clearing before an invalid default's replacement set is applied.

CED uses the picker's `selectionMode = 'constraints'`, `termTypes = ['ontology', 'class', 'branch', 'valueSet']`, `constraintSet` input and
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

The embedding host supplies standalone elements through the public artifact input.
CED offers no file import/export controls or separate Add Element/Import Element buttons.
Existing nested content remains visible under every profile. Elements start expanded;
the chevron in their template-style header collapses or expands their children without
discarding input or changing the artifact. **Element settings** edits the placement's
property name, display labels, property IRI, requirement, cardinality and layout, and
contains duplicate, remove and move actions. The reusable-child selector within each element
targets that container. The Element settings move selector transfers whole element subtrees;
cycles, duplicate property names and page breaks inside elements are refused. On
narrow screens the outline is hidden; nested sections remain editable inline.

Selecting a reusable element creates an independent local copy retaining source artifact
identity. Its destination is captured when the selector opens, so later navigation
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
PICKER_BUNDLE="$PWD/../cedar-embeddable-term-picker/dist-bundle/cedar-embeddable-term-picker.js" \
npm --prefix browser test
```

The preview mode selector offers Read-only (the default) and Editable, one at a
time. Read-only shows what each field accepts; Editable lets an author try filling
in the form. Preview answers do not change the template and reset when the template
or preview mode changes. CEE applies configuration once, so a mode change replaces
the preview element; ordinary template updates reuse it. It also asks CEE to drop
its Expand All and Collapse All buttons, through
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

<a id="ced-ports"></a>

### Ports

| Port | What |
|---|---|
| 4200 | `npm start`, the development host page |
| 4598 | the browser suite's static server, over `dist-bundle/` |
| 9004 | the terminology server the picker reads, when run locally |

<a id="ced-the-things-that-bite"></a>

### The Things That Bite

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

### Shared Component Defaults and Configuration

CEE/CEF and CED/CEFD consume `cedar-design-tokens` at build time. The package owns
the font stack and embedded Roboto sources, type scale, palettes, semantic error,
advisory and authoring roles, compact/authoring control defaults, and the optional
4/8/12/16/24px spacing scale. Material remains inside CEE's adapter; CED uses CSS
properties and its native-control adapter. Geometry unique to one component stays
local.

CEE/CEF default to 36px compact controls. `density="authoring"` selects 32px height,
12px text, 18px line height and 2px corners. CED/CEFD native settings and embedded
CEF use that authoring profile. Both profiles consult public `--cedar-control-*`
host overrides first. Components must not assign those public properties internally;
token defaults use separate names such as `--cedar-control-height-authoring`.
The tokens package tests that its generated CSS cannot shadow the override names.

Error text and borders use `color-error` (#b42318), advisory text uses
`color-warning`, and advisory backgrounds use `surface-advisory`. The old Material
`color-warn` remains exported for compatibility. The shared `fonts` Sass export
contains 21 embedded font faces and no selectors or external font requests.
Font registrars import it outside shadow DOM. Sharing the source preserves
self-contained bundles rather than introducing a runtime font download.

Modern Workspace, CEE/CEF, CED/CEFD and CETP use the tokens package's `icons`
export: curated Lucide SVGs behind CEDAR semantic names, shared 16/20/24px sizes
and a 2-unit stroke. Thin Angular adapters render that registry; CEE uses a
`cedarIcon` directive on Material hosts and no longer ships an icon font.
Icon-only controls retain accessible names while SVGs are decorative.
Brand assets and authored content are separate. The legacy AngularJS shells
are excluded. `cedarcli check design-tokens --strict` also rejects local icon
geometry, icon-font markup and unknown static names; icon findings cannot be
waived with baseline allowances. Consumer unit tests exercise the registry
adapters, browser tests check meanings and dimensions, and CEE/CED screenshot
baselines use their pinned Linux ARM containers with zero pixel tolerance.

Interface typography uses regular 400 and medium 500, with a 12px minimum for
small labels and count badges. OpenView retains a distinct 34px artifact title.
The token source defines regular/medium weights, the display role and a shared
system monospace stack. New CSS roles use fallback values so older pinned token
packages remain buildable; advance pins after publishing a new immutable snapshot.

CEE's production build also emits `cedar-embeddable-editor.host-fonts.js` and
`bundle-manifest.host-fonts.json`. This entry point uses the shared Lucide registry and
expects the host to register `CEE Roboto` 400/500 globally. The default bundle
continues to embed its fonts for standalone CEE/CEF use. Workspace copies and
selects the host-font variant when its installed CEE package includes it, falling
back to the default entry point for older package pins. The shared token source
exports `fonts/regular` and `fonts/medium`; Workspace's existing snapshot uses the
same partials via Sass's configured include path. Verify both bundle variants and
publish CEE before advancing Workspace's pin; source changes alone do not change
what an older installed CEE package contains.

CED and CEFD use one set-once configuration coordinator per component. It diagnoses
unknown keys and wrong types, normalizes both service bases, and hands the same
accepted configuration to terminology and embedded CEF. Malformed non-object
configurations do not consume the first assignment. CEE/CEF's existing direct-host
contract still requires trailing slashes; the designer coordinator supplies them.
Read-only and document lifecycle contracts remain component-specific.

#### Shared interaction and layout roles

The tokens package also owns keyboard focus geometry, enabled hover/pressed and
disabled states, paired semantic status colors, dialog/menu surfaces, form rhythm,
table density, motion durations and overlay layers. Use its opt-in Sass recipes
through thin adapters; keep component behavior, host override contracts and unique
layout local. Semantic status text/surface pairs have automated contrast checks.
Default table rows accommodate 36px controls with 8px vertical gutters; authoring
rows accommodate 32px controls with 4px gutters. Row heights can grow for content.

Include the shared reduced-motion recipe once per document or shadow root.
JavaScript-driven animation must honor the preference separately. Layer roles
are ordered within the host stacking context; they do not supersede native dialog
top layers. CED browser checks exercise menu/modal layers and both motion modes.
The read-only live `ops/e2e` command `npm run smoke:ui-unification` checks Groups
keyboard focus and disabled, hover and pressed states, plus the CEE-derived white
surfaces and title roles across Workspace, account pages and resource dialogs at
desktop and phone widths. `CEDAR_UI_SCREENSHOTS=/tmp/cedar-ui` saves review captures.
The full `npm run smoke:workspace:modern` journey also checks editable and read-only
Permissions dialogs, including visible role/ownership controls on phones; it accepts
the same screenshot directory. These live checks need the authenticated local stack.
CETP's `npm run test:visual` compares two zero-tolerance desktop/phone baselines in
Playwright 1.63.0's ARM Linux container, matching its CI runner. Build first; update
with `npm run test:visual -- --update-snapshots` only after reviewing the render.
CEE's existing read-only and editable visual baselines remain the design reference.

#### Local Verification of Unpublished Token Changes

CEE and CED install the shared control, spacing and font exports from their
exact Nexus snapshot pins. For future unpublished token changes, use packed
local sources for development verification. Before pushing consumers that need
new exports, publish a new immutable token snapshot, update their package and
lockfile pins, and prove a clean `npm ci` build. Never overwrite a published
version. With the native profile sourced, the local development loop is:

```sh
cd "$CEDAR_HOME/cedar-design-tokens"
npm test
npm pack --pack-destination /tmp
# Use the exact tarball name npm pack printed, in each consumer:
cd "$CEDAR_HOME/cedar-embeddable-editor"
npm install --no-save --package-lock=false /tmp/<token-tarball>.tgz
cd "$CEDAR_HOME/cedar-embeddable-designer"
npm install --no-save --package-lock=false /tmp/<token-tarball>.tgz
```

Build CEE/CEF first, then use its built bundle as `CEF_BUNDLE` for the CED browser
gate. Tests cover both profiles, inherited host overrides in all four elements,
CEF nested in CED/CEFD, invalid/focused controls, narrow hosts, configuration
normalization and malformed inputs. CEE screenshot checks use the pinned Linux
container; macOS screenshots must not replace those baselines. Reinstalling with
`npm ci` restores the published token pin. Local-tarball success is not a clean
CI result: verify again after publishing and pinning the snapshot. CED's real-CEF
integration workflow must pin a CEE source revision that implements the profiles
its tests exercise.

#### Monitoring token adoption

Run `cedarcli check design-tokens` for Workspace, CEE/CEF, CED/CEFD, CETP,
OpenView, Monitoring, Bridging and the Template Designer host,
`--strict` to gate new color/typography drift, `--json` for an archived report,
and `--repo <name> --prune-baseline` after removing existing findings. Spacing and
geometry are advisory. The version comparison is against the local token package,
not the latest Nexus publication. This complements `cedarcli check components`;
it does not prove which bundle a host serves. The token repository's README owns
the scanner scope, exact-declaration exceptions, CI base-revision comparison and
rollout order. Review baseline changes as code; do not regenerate debt to pass CI.

For a side-by-side manual comparison, build CEE and CED using the procedures above,
stage the current CEE bundle beside CED's bundle, then start CED's fixture server
with the native profile sourced:

```sh
cd "$CEDAR_HOME/cedar-embeddable-designer"
cp ../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js dist-bundle/
node browser/serve.mjs
```

Open `http://localhost:4598/style-comparison.html`. It renders all four real
components, displays the shared semantic status pairs, and supports
compact/authoring entry density, narrow hosts, inherited
overrides and the supported read-only modes. Use keyboard focus and invalid
field values to inspect those states. The page shows a missing-bundle message
instead of substituting mock components. Its browser test joins the existing
real-CEE/CEF gate when `CEF_BUNDLE` is supplied.
