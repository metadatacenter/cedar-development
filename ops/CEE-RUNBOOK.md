# CEDAR Embeddable Editor (CEE) — Development Runbook

Building, running and testing **CEE** (`cedar-embeddable-editor`) locally.
Everything here has been run on macOS (Apple silicon), against Angular 22. The latest
stable release documented here is CEE 2.0.1, and all seven embedding manifests pin it, including
the extracted Workspace. Consumer coherence is verified from manifests and lockfiles,
and deployed identity is verified by the bundle sha256 rather than only by the version
each host reports.

Sibling runbooks:
- [CEE-ROADMAP.md](./CEE-ROADMAP.md) — where CEE currently is, and the open
  work.
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the full CEDAR
  stack locally.

> CEE is a standalone Angular web component. It does **not** need the CEDAR
> stack running — none of the commands below depend on the microservices.

---

## Node versions — read this first

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
[Checking output against the CEDAR model](#checking-output-against-the-cedar-model).

---

## Running the app

CEE's standalone dev mode needs a second repo for the sample templates it loads.

```bash
git clone https://github.com/metadatacenter/cedar-component-distribution.git
```

Configuration for dev mode lives in `src/app/app.component.dev.ts` — it is
TypeScript, not JSON, and is compiled in. Point
`sampleTemplateLocationPrefix` at wherever the component-distribution server is
serving from.

Terminal 1 — the sample templates:

```bash
cd cedar-component-distribution && npm install && npx ng serve
```

Terminal 2 — CEE itself:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install && npx ng serve
```

Then open `http://localhost:4400/`.

## Building the web component

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

## Running the complete test gate

The canonical, non-interactive verification command is run from the CEE
repository root:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:ci
```

It runs these stages in order and stops at the first failure:

1. Lint and both TypeScript programs (`lint`, `typecheck`).
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
holds the installed 2.0.1 from npmjs.

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

### Getting a Local Build Into the Frontends

Two routes. A **symlink** covers a tight edit loop, where the point is to see a
change without publishing anything. A **dev release to Nexus** covers the other
case — putting one named, fetchable build in front of every frontend at once,
which is what to reach for when the build is worth referring to later or worth
someone else installing. That route is
[Releasing a dev snapshot locally](#releasing-a-dev-snapshot-locally) below; the
symlink is the rest of this section.

Point the consumer at `dist-npm/cedar-embeddable-editor` — `ln -s` over its
`node_modules/cedar-embeddable-editor` — and staging is then necessary but not
sufficient. The symlink means a consumer *resolves* the freshly staged bundle, but
every consumer **copies** it into its own served output, so each needs a second
step:

```bash
# Extracted Workspace — needs the CEDAR profile sourced, or the gulpfile refuses to start
cd $CEDAR_HOME/cedar-workspace && npx gulp copy:cee

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
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh restart ui-openview
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

### Releasing a Dev Snapshot Locally

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
"cedar-embeddable-editor": "npm:@org.metadatacenter/cedar-embeddable-editor@2.0.0-dev.20260818.6dca9bf"
```

All seven manifests already carry the `@org.metadatacenter:registry` line an alias
needs. Install, then get the bundle into what each host serves:

| Host | Install | Then |
|---|---|---|
| `cedar-workspace` | plain | `npx gulp copy:cee` (needs the profile sourced) |
| `cedar-template-editor` | plain | `npx gulp copy:cee` (needs the profile sourced) |
| `cedar-bridging` | plain | `cedarcli build this --wd "$PWD"` |
| `cedar-openview` | `--legacy-peer-deps` | `cedarcli build this --wd "$PWD"` — it copies `dist/cedar-openview` into `cedar-openview-dist` |
| `cedar-component-demo` (Angular) | `--legacy-peer-deps` | `cedarcli build this --wd "$PWD"` |
| `cedar-component-demo` (Ember, React) | plain | nothing — they run from source |

A build refreshes what is on disk. A **running `ng serve` still serves what it
started with**, because a `node_modules` swap is not a source change, so
`ui-openview` and `ui-bridging` need restarting; the same
`.angular/cache` caveat above applies to openview. Native Workspace and monolith
Gulp servers need no restart — each serves the file `copy:cee` wrote, so the copy is
the deploy. A Workspace preview image must instead be rebuilt and recreated because
its CEE bundle was copied into the image.

```bash
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh restart ui-openview ui-bridging
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
| bridging | bundled, not served as a file — it is imported in `app.module.ts`. **Which bundle depends on which build**: the running `ng serve` splits it into `vendor.js`, and the checked-in production dist emits no `vendor.js` at all, carrying it in `main.js`. |

For the first two, compare sha256 against the staged bundle. For the bundled case
there is no file to hash: grep the bundle for the load-trace stamp, which names
one build exactly. The version string alone is not enough — the bundle holds every
dependency's version, so a bare `2.0.1` in it may belong to something else
entirely.

Ask the dev server for `vendor.js` and the dist for `main.js`. Grepping the other
one of the pair returns zero, which reads exactly like the failed deploy this
check exists to rule out — and a zero from the wrong file has already been
mistaken for one.

```bash
curl -s http://127.0.0.1:4220/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://cedar.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://workspace.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://127.0.0.1:4340/vendor.js | grep -c '<the load-trace stamp>'
grep -c '<the load-trace stamp>' $CEDAR_HOME/cedar-bridging/cedar-bridging-dist/main.js
```

### First-time setup

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

The gate should report 0 lint problems and, on 17 August 2026, 152 unit tests, 2,117
domain tests and 416 Playwright tests.

Read those as floors rather than as targets. Their only use is catching a suite that
silently ran nothing — a filter matching no file, a project that failed to start —
so what matters is the order of magnitude, and a count well below one of these is
worth explaining before it is written down as the new figure. A count *above* it
needs no explanation and is not a reason to edit this line.

Three warnings about doing that anyway are already in this document's history. It
once carried a Karma figure years after the move to Vitest; the numbers above
replaced a set that had drifted in both directions at once, low on unit and
Playwright and high on domain, because removing four snapshot recordings that
compared minted identifiers took the domain count *down*; and the Playwright figure
disagreed with the one in
[The visual baseline suite](#the-visual-baseline-suite) by 42. Prefer citing a date
and a floor to maintaining an exact number in more than one place.

Use the complete gate before pushing or opening a pull request. The focused
commands below are faster feedback while working on one layer.

### Auditing what ships

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

A root `npm audit` reports **3**, all moderate: `@angular/cli` and the two
packages reached through it, `@hono/node-server` and `@modelcontextprotocol/sdk`.
It reported 11 until `@angular-devkit/build-angular` was dropped — the webpack
toolchain no build target had named since the move to `@angular/build` — which
took every `high` with it, along with 427 packages. `npm run audit:prod` reports
0, and that is the number that describes what ships.

**Never run `npm audit fix --force` here.** npm's idea of fixing the Angular
tooling is to walk it backwards: it proposed `@angular/cli@21.0.4` and
`@angular-devkit/build-angular@0.1002.1`, which is the *Angular 10* numbering —
adding 1,253 packages, removing 302, and undoing the upgrade march to silence
warnings about build tooling an embedder never downloads.

That is also why a failure here is not automatically a release blocker. Read the
advisory and ask whether CEE reaches the vulnerable path — when `lodash-es` 4.17.21
was flagged for `_.template`, `_.unset` and `_.omit`, CEE called only `cloneDeep`
and no advisory described anything it could reach. Upgrade anyway if a fix exists,
because a flagged package is one every embedder would otherwise have to reason about
alone; but the reasoning belongs in the commit message, not in a version bump made
on reflex.

### What CI runs

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
build: the pre-existing `any` debt is baselined per file in `eslint.config.mjs`.
The toolchain matches the framework — `angular-eslint` 22, `typescript-eslint` 8,
ESLint 9, flat config in `eslint.config.mjs`.

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
procedure — see [Release](#release) below.

## Running the domain test harness

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
[Checking output against the CEDAR model](#checking-output-against-the-cedar-model).

### Coverage

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
npx vitest run harness/test/controlled-terms.spec.ts
```

### Reading a template from YAML

CEE parses templates through the CEDAR Model TypeScript Library, which reads
YAML into the same model it reads JSON into — so a template written either way
produces the same form. `harness/test/format-independence.spec.ts` checks that
over all 37 corpus templates, and `harness/test/instance-output.spec.ts` checks
the same for the instance CEE emits.

If either starts failing after a change to the parser or the emitter, the
question to ask is which of the two formats the new code is quietly assuming.

### Opening a legacy production instance

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

### Running against the old template parser

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

## Checking output against the CEDAR model

Everything above checks CEE against itself. This checks it against the model.

The distinction is not academic. In August 2026 the harness had 1,488 passing
tests, including a pair that compare CEE's JSON output against its YAML output
and find them equivalent — and **zero** of the 37 instances CEE produced
validated against the template it built them from. The tests all agreed with
each other. None of them asked the model.

### Why a template can validate its own instances

A CEDAR template *is* a JSON Schema (draft-04) for its instances. Not a
description of one — the document itself, `properties` and `required` and all.
That is exactly how `cedar-model-validation-library` validates an instance:
`CedarValidator.validateTemplateInstance(instanceNode, schemaNode)` hands the
template to a JSON Schema validator as the schema.

So there is nothing to derive and no mapping to trust. Any draft-04 validator
can answer the question.

### The canonical check — cedar-model-validation-library

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

### Running the gate on one artifact

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

### The same check, in the harness

Running Maven is not something to do per-edit, so the domain harness runs the
equivalent check on every `npm run test:domain` and `npm run test:ci` with
`ajv-draft-04`:

```bash
npx vitest run harness/test/model-conformance.spec.ts
```

For each corpus template it builds CEE's instance and validates it against that
template. **34 of 37 pass.** The three that do not are listed by name in
`KNOWN_NON_CONFORMANT` at the top of the file with what is wrong with each, and
a separate test asserts the failing set *equals* that list — so a template that
starts conforming fails just as loudly as one that stops. The number is a
defect count. It has gone 0 → 31 → 34 and should only go up.

All three remaining failures are defects in the templates themselves — 001 has
no `@id`, 003 will not compile, and 029 contradicts itself by offering literal
choices under an IRI-only schema. [CEE-ROADMAP.md](./CEE-ROADMAP.md) carries what
is open on each.

That corpus check starts from empty instances. The complementary saveability
gate populates every value-bearing field through the real CEE handler, crosses
single/multiple field cardinality with all seven root and one-/two-level element
placements, and validates each emitted instance twice:

```bash
npx vitest run harness/test/instance-schema-population.spec.ts
```

`InstanceValidator` checks the parsed TypeScript model. `ajv-draft-04` checks
the exact template object before any model reader can normalize it. Both are
required. In August 2026 the model-only path hid stored multi-select fields whose
widget semantics emitted arrays while their raw JSON Schema still required an
object; the resource server rejected those instances on save. The exact captured
nested template and all five placements from that incident are permanent
regressions in the same file. `template-consistency.spec.ts` separately scans
the independent, HuBMAP, and visual corpora for any checkbox, attribute-value,
or `multipleChoice: true` list field not declared as an array.

### Why the harness check can be trusted

ajv is not the Java validator, so the agreement has to be demonstrated rather
than assumed:

```bash
npx vitest run harness/test/validator-agreement.spec.ts
```

This runs the canonical library's *own* instance fixtures through ajv — the
seven it requires to pass and the nine mutations it requires to fail — and
checks the verdicts match. All 17 do. It skips itself if
`cedar-model-validation-library` is not checked out beside CEE.

The failing half is the informative one: a validator that accepted everything
would pass the seven. If a future CEDAR release tightens a rule ajv does not
implement, this is where it surfaces, rather than in a quietly over-optimistic
conformance number.

### When to run which

Change the emitter, the envelope, or `data-object-builder.handler.ts` →
`model-conformance.spec.ts`, which the domain and unified gates run anyway.

Upgrade the model library, take a new CEDAR release, or find yourself arguing
with the harness about what the model requires → run Maven. The Java suite is
the tie-breaker, and `validator-agreement.spec.ts` is where its verdict gets
written back down into the harness.

About to put an artifact into production, or holding one artifact whose verdict you
actually need → `ops/cedar_validate.sh`. This is the gate itself rather than an
approximation of it, so when the question is "will this be accepted", it is the
only answer that counts. Reach for it in preference to reasoning from the schema:
a draft-04 validator agreeing with it is evidence, not proof, and the two have
diverged before.

## Running the visual baseline

Screenshot and browser-behaviour regression against the production bundle. The
focused root command builds a fresh `dist/`, prepares the visual fixtures and
runs Playwright:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:visual
```

For first-time installation, including the Chromium browser binary, use the
[complete gate setup](#first-time-setup). If running from `visual/` directly,
the equivalent commands after a production build are:

```bash
cd visual
npm run prepare:all && npm test
```

Expect **over 400 passing** in about four minutes — 416 on 17 August 2026. The count
grows as tests are added; treat a *fall* as something to explain. `prepare:all` re-concatenates the
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

### When a Baseline Passes and Is Still Wrong

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

## Running the Angular unit tests

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

---

## Troubleshooting

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
Those assert what CEE *does*, deliberately. [CEE-ROADMAP.md](./CEE-ROADMAP.md) carries what is open.

---

## Building the model library

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

Nothing is published from CI. CEE resolves the package from the BMIR Nexus npm
registry (`https://nexus.bmir.stanford.edu/repository/npm-cedar/`) through its
own `.npmrc`, pinned to an exact version whose suffix carries the build date
and commit.

### The two channels, and the name that selects them

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

### Publishing a model library dev build

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

## Release

`main` is owned by the release process. Work lands on `develop`.

There is one stable publish target: the unscoped `cedar-embeddable-editor` on public npmjs, under the
default `latest` tag. 2.0.1 is the latest stable release, published 2026-08-21, and all seven
embedding manifests pin it plain from npmjs. The registry goes from 1.5.2 straight to it: 1.6.0 was
published on 2026-08-12 and unpublished from npmjs afterwards, so a manifest still naming 1.6.0
cannot install, and the tarball it named cannot be fetched for comparison.
`scripts/npm-package.mjs` generates the published manifest, hardcoding the stable package name and
writing no `publishConfig`, so a stable package goes to `registry.npmjs.org`; the root manifest's
own `name` and `publishConfig` are not what publishes.

Dev snapshots are a second channel: the scoped `@org.metadatacenter/cedar-embeddable-editor` on
Stanford Nexus under a `dev` tag, versioned `<next>-dev.<date>.<sha>`. It was retired for a while and
is live again — `dev` currently names `2.0.0-dev.20260820.a8cc4cc`. Reach it from an embedding app
through an npm alias, since npm routes by scope and this is the only package taken from Nexus.

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

### Prerequisites — registry auth

Publishing needs rights on `cedar-embeddable-editor` at npmjs, and npm requires a second factor:
pass `--otp=<code>`, or hold a granular access token with "Bypass 2FA" in `~/.npmrc`. An `E404` on
publish means unauthenticated rather than missing — check `npm whoami` before believing the package
disappeared. Confirm the account without printing any credential:

```bash
npm whoami
```

A token is a credential — keep it in `~/.npmrc` only, never in a repo or these notes.

### 1 · Bump the version

A release version is plain semver — `2.0.1`. Only **two** files hold it by hand:

| File | Occurrences |
|---|---|
| `package.json` | 1 (`"version"`) |
| `package-lock.json` | 2 (top-level `"version"` + the root `""` package entry) |

Everything under `dist-npm/cedar-embeddable-editor/` is **generated** and git-ignored —
`scripts/npm-package.mjs` derives the manifests from the root `package.json`, `types:public` emits
the declarations, and the README and changelog are copied from the root. Do not hand-edit any of
them; staging overwrites them. (Older notes describing "six version spots", or the directory as a
committed artifact, predate that script and the ignore.)

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

### 2 · Build and browser-test

```bash
npm run test:visual
```

This builds production and runs the Playwright baseline, and it is not optional: staging publishes
`visual/public/cedar-embeddable-editor.js` and refuses to run unless that file's sha256 and byte
count match `visual/public/bundle-manifest.json`. The published artifact is therefore always the
exact bundle a browser exercised — that guarantee is the reason the step exists, so don't reach for
a bare `ng build` to save a minute.

### 3 · Stage the package

```bash
npm run package:npm:prebuilt
```

Checks the bundle is fresh and within its size budget, writes the five-file package into
`dist-npm/cedar-embeddable-editor/`, then re-verifies every staged byte against its source. It
prints the version, size and sha256 it staged — read them.

### 4 · Publish

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

### 5 · Tag the release, and draft its notes

Nothing in the publish records which commit was staged, and `npm publish` will happily ship a dirty
working tree. Tag as soon as the publish succeeds, on the commit that bumped the version rather
than the merge that later carried it to `main`. That is what every earlier `release-<version>` tag
names, and it is the tree the package was built from:

```bash
git tag -a release-2.0.1 <bump-commit> -m "CEE 2.0.1"
git push origin release-2.0.1
```

If the tag is added later and the commit is no longer obvious, the published package identifies it.
Three of its files are copied rather than generated — `README.md`, `CHANGELOG.md` and
`license.txt` — so `npm pack cedar-embeddable-editor@<version>` and a hash of those three against
each candidate commit settles which tree was staged. That is what distinguishes the bump commit on
`develop` from the merge on `main`, which can differ in nothing else.

Then draft the release notes against the tag:

```bash
gh release create release-2.0.1 --draft --title "CEE 2.0.1" --notes-file <notes.md>
```

CEE's notes follow the shape 2.0.1's carry, which is not the one
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

### 6 · Propagate

Seven manifests across five repos depend on CEE. Workspace is a required consumer alongside the
production monolith and the existing auxiliary/demo frontends. A stable release names one exact
version resolved from npmjs:

```json
"cedar-embeddable-editor": "2.0.1"
```

Its lockfiles record the npmjs tarball and integrity hash, so what installs is reproducible.
Installing needs no credential; only publishing does. A development snapshot instead uses the
scoped Nexus alias described above.

Each repo carries an `.npmrc` holding `@org.metadatacenter:registry` against Nexus, which is required
while a development snapshot is pinned and harmless for a stable npmjs release.

| Repo | Manifest | Install |
|---|---|---|
| `cedar-workspace` | `package.json` | plain |
| `cedar-template-editor` | `package.json` | plain |
| `cedar-bridging` | `cedar-bridging-src/package.json` | plain |
| `cedar-openview` | `cedar-openview-src/package.json` | `--legacy-peer-deps` |
| `cedar-component-demo` | `cedar-cee-demo-angular-src` | `--legacy-peer-deps` |
| `cedar-component-demo` | `cedar-cee-demo-ember-src`, `cedar-cee-demo-react` | plain |

Two repos fail a plain `npm install` on a peer conflict that has nothing to do with CEE:
`ngx-youtube-player-14` demands `@angular/common@^14.1.3` from projects on Angular 15 and 16. Both
predate this wiring and both need `--legacy-peer-deps`.

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

Propagating a release also means rebuilding each deployed consumer.
Confirm the bytes rather than the version string: the sha256 that `package:npm:prebuilt` prints should
appear in each consumer's `node_modules`, and again wherever that consumer stages the bundle —
`app/third_party_components/` for both Workspace and the monolith,
`dist/cedar-openview/node_modules/` for OpenView.

```bash
gobridging  && npm install && cd .. && cedarcli build this --wd "$PWD"
cd $CEDAR_HOME/cedar-workspace && npx gulp copy:cee
cd $CEDAR_HOME/cedar-template-editor && npx gulp copy:cee
```

A rebuild is what reaches a running frontend; the manifest edit and the install only change what
resolves. Both Workspace and `cedar-template-editor` copy the installed bundle during Gulp. The
production deployment procedure must build whichever of those two payloads the environment serves,
and during migration builds both ([PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) step 6).

### Gotchas

- **Publish only from `dist-npm/cedar-embeddable-editor/`.** From the repo root, `npm publish` uses
  the root manifest and packs the whole source tree.
- **Staging refuses a stale bundle** rather than shipping one. `browser bundle does not match its
  manifest` means run `npm run test:visual` again; it is the guard working, not a fault.
- **Reaching an environment is a separate step.** Publishing does nothing there until every served
  CEE host—including Workspace and the monolith during migration—is rebuilt against the new version,
  its served hash is verified, and the environment cache-buster/CDN entries are changed or purged
  (PROD-DEPLOY-RUNBOOK + frontend-caching).
