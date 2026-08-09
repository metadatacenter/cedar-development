# CEDAR Embeddable Editor (CEE) — Development Runbook

Building, running and testing **CEE** (`cedar-embeddable-editor`) locally.
Everything here has been run on macOS (Apple silicon) against `develop` @ CEE
1.5.2.

Sibling runbooks:
- [CEE-ROADMAP.md](./CEE-ROADMAP.md) — the framework-upgrade programme, open
  findings and known defects.
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
| `cedar-model-typescript-library` | 18 or 20 | Webpack 5 / TS 5.3; both work. It is a separate build with its own toolchain. |

The split this table used to describe — 18 for interactive development, 20.20.2
for the gate — is gone. It existed because Angular 14's toolchain and the current
Playwright did not accept the same Node, and the Angular march removed the reason
for it. One version now builds the artifact that ships and runs the tests that
judge it.

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

1. Vitest unit specs under `src/`, in jsdom (`test:unit:ci`).
2. The Vitest domain harness with V8 coverage (`test:domain:coverage`).
3. A production build of the web component.
4. Fixture preparation and the Playwright browser suite at desktop and narrow
   viewport sizes (`test:visual`).

The domain fixtures are vendored under `harness/fixtures/`. Neither
`cedar-artifact-library` nor `cedar-test-artifacts` needs to be cloned or
checked out.

### First-time setup

CEE resolves the model library from
`@org.metadatacenter/cedar-model-typescript-library` on the BMIR Nexus, so no
sibling checkout is needed. Only that one package comes from Nexus; everything
else resolves from npmjs.org, and reads need no credentials.

```bash
cd ../cedar-embeddable-editor
npm ci
npm --prefix harness ci
npm --prefix visual ci
./visual/node_modules/.bin/playwright install chromium
```

The current gate should report 0 lint problems, 125 unit tests, 2,202 domain tests
and 370 Playwright tests. Treat these as useful smoke checks, not permanent
constants: new tests should make the counts rise. (This line once carried a Karma
figure, years after the move to Vitest — which is the hazard of writing counts
down at all.)

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

**Never run `npm audit fix --force` here.** Every advisory a root `npm audit`
reports comes from one place — `@angular-devkit/build-angular` and `@angular/cli`,
both direct devDependencies — and npm's idea of fixing that is to walk the
toolchain backwards. It proposes `@angular/cli@21.0.4` and
`@angular-devkit/build-angular@0.1002.1`, which is the *Angular 10* numbering:
adding 1,253 packages, removing 302, and undoing the 14 → 22 march to silence
warnings about build tooling an embedder never downloads. `npm run audit:prod`
reports 0, and that is the number that describes what ships.

That is also why a failure here is not automatically a release blocker. Read the
advisory and ask whether CEE reaches the vulnerable path — when `lodash-es` 4.17.21
was flagged for `_.template`, `_.unset` and `_.omit`, CEE called only `cloneDeep`
and no advisory described anything it could reach. Upgrade anyway if a fix exists,
because a flagged package is one every embedder would otherwise have to reason about
alone; but the reasoning belongs in the commit message, not in a version bump made
on reflex.

### What CI runs

`.github/workflows/test.yml` runs the same gate on every pull request and on
pushes to `main`, `develop` and `cee-with-model-library`, with a thirty-minute
ceiling. Two of its choices are deliberate and expensive to rediscover.

**The runner is pinned to `macos-15`, not `macos-latest`.** The committed
Playwright snapshots are macOS baselines, so a runner bump would move them
underneath the suite and fail it for no reason anyone had changed. It is also
specifically not `macos-14`: Playwright no longer builds WebKit for
`mac14-arm64` and serves a frozen v2251 there, while the pinned Playwright
drives v2336. The driver sends `Page.overrideSetting: PushAPIEnabled`, v2251
does not implement it, and every `newPage()` in the webkit-smoke project fails.

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
CEE: it renders from `DoCheck` and mutates model objects in place, so OnPush would
stop the view updating, and obeying it would undo by hand the Angular 22 migration
that stamped `Eager` onto all 46 components. Moving to OnPush means moving to
immutable updates or signals first.

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

Expect **2,260 passing** on `cee-with-model-library`. For watch mode, run
`npm --prefix harness run test:watch`.

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
aggregate. `factory` has 90% statement and branch floors; `handler`, `util` and
`validation` have 90% statement and 85% branch floors. These grouped thresholds
are part of `npm run test:ci`, so a domain regression fails CI even when every
test assertion still passes.

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
which resolves only against the CEDAR nexus. Clone and `mvn install`
`cedar-parent` first if you have not; the public repos return 402 for it.

```bash
cd ../cedar-model-validation-library && export JAVA_HOME=$(/usr/libexec/java_home -v 17) && mvn test
```

Expect **210 passing, 7 skipped**.

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
choices under an IRI-only schema. See [CEE-ROADMAP.md](./CEE-ROADMAP.md) →
Model conformance for the evidence on each.

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

Expect **294 passing** in about 40 seconds. `prepare:all` re-concatenates the
bundle from `../dist` and regenerates the template fixtures; run it after any
rebuild.

It no longer *silently* tests a stale bundle if you forget — `npm test` refuses
to run when `../dist` is newer than the copy in `public/`. That guard exists
because the suite did exactly that, reporting green against the previous build,
and a real fix was briefly believed not to work on the strength of such a run.

Not all screenshots any more: the external-authority tests assert behaviour —
that a keystroke raises no error, that free text is discarded on blur — because
that is a class of defect the domain harness cannot see and a baseline image
would not describe.

To accept an intentional visual change:

```bash
npm run update
```

Review every changed PNG before committing — a baseline update asserts the new
rendering is correct.

## Running the Angular unit tests

```bash
npm run test:unit:ci
```

This is the headless, single-run form included in `npm run test:ci`. The root
`npm test` runs the same specs through Vitest, and `test:watch` is the
interactive form. The unit layer is small; do not treat it as a substitute for
the domain and browser stages.

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
The harness consumes the published package, not a local checkout, so a local
build of the library changes nothing. To pick up model-library work, publish a
new dev version and bump the alias in all three CEE manifests:

```bash
cd ../cedar-model-typescript-library && npm run build && npm publish ./dist --tag dev
```

Publish with the explicit `./dist` path — a bare `dist` is read as a package name
and resolves an unrelated public package. Set the version in
`package-dist.json`, not `package.json`; the build copies it to
`dist/package.json`. Each publish needs a new version, because npm rejects a
republish rather than overwriting. For a tight local edit loop, prefer
`npm link` over publishing a version per iteration.

**A test asserts something that looks wrong**
Check whether it sits in a "known defects (characterized, not endorsed)" block.
Those assert what CEE *does*, deliberately. See [CEE-ROADMAP.md](./CEE-ROADMAP.md) → What needs doing.

---

## Building the model library

CEE consumes `@org.metadatacenter/cedar-model-typescript-library` as a published
package, so this is only needed when working on the library itself.

The library needs **Node 20**; `package.json` declares `>=20.19.0` and CI pins
20.20.2. That is deliberately not the 24.19.0 CEE now uses — the library is a
separate build with its own toolchain, and CEE consumes it as a published npm
package rather than from a checkout. Nothing needs a sibling
checkout: the test corpus is vendored under `cedar-test-artifacts/`, along with
the reference templates it compares against.

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

`npm run build` synchronizes the version into `package-dist.json` before
webpack runs, which is where the published name comes from: the repository is
`cedar-model-typescript-library`, the package is
`@org.metadatacenter/cedar-model-typescript-library`.

`.github/workflows/test.yml` runs exactly that sequence on `ubuntu-latest` with
a fifteen-minute ceiling, on every push and pull request to `develop`. Nothing
renders or screenshots, so it needs no macOS runner and no browser install,
unlike the CEE gate.

Nothing is published from CI. CEE resolves the package from the BMIR Nexus npm
registry (`https://nexus.bmir.stanford.edu/repository/npm-cedar/`) through its
own `.npmrc`, pinned to an exact version whose suffix carries the build date
and commit. The publish step itself is written down nowhere — not in
[RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md), not in
[Release](#release) below, and the repository records
no target registry of its own. Whoever publishes next should capture it here.

## Release

`main` is owned by the release process. Work lands on `develop`.

There are two publish targets, and they are not two ways of doing one thing:

- **Dev builds → Stanford Nexus**, as the scoped `@org.metadatacenter/cedar-embeddable-editor`
  under the `dev` tag. This is what the repo's tooling produces today, and what the steps below
  describe. Nothing picks a dev build up implicitly.
- **Stable releases → public npmjs**, as the unscoped `cedar-embeddable-editor`. All eight
  embedding manifests still depend on this (`^1.5.2`), and 1.5.1 was the last one published this
  way. **The current tooling does not produce it** — read "Stable releases" below before
  attempting one.

They are two different package names, so a dev build reaches no consumer by itself.
`scripts/npm-package.mjs` generates the published manifest: it hardcodes the scoped name and takes
the registry from the root `package.json`'s `publishConfig`, so the root manifest's own `name` is
not what publishes.

Version is surfaced at runtime as `window.cedarEmbeddableEditorVersion`.

> `gocee`, `gocedar`, `goartifacts`, `gobridging` are CEDAR profile aliases (cd to the respective
> repo). **Never commit npm tokens, passwords, or OTPs.**

### Prerequisites — registry auth

A dev publish needs a Nexus credential, already present on a configured machine as
`//nexus.bmir.stanford.edu/repository/npm-cedar/:_authToken` in `~/.npmrc`, together with
`@org.metadatacenter:registry` pointing at the same Nexus repository. Confirm both without printing
the token:

```bash
npm config get @org.metadatacenter:registry
```

That should print the Nexus URL. A token is a credential — keep it in `~/.npmrc` only, never in a
repo or these notes.

### 1 · Bump the version

The dev version names the commit whose content is being published:
`1.6.0-dev.<YYYYMMDD>.<sha>`, where the date is that commit's date. So the bump commit itself
carries a version naming its *parent*, which is expected.

Only **two** files hold the version by hand:

| File | Occurrences |
|---|---|
| `package.json` | 1 (`"version"`) |
| `package-lock.json` | 2 (top-level `"version"` + the root `""` package entry) |

The `dist-npm/cedar-embeddable-editor/` manifests are **generated** — `scripts/npm-package.mjs`
derives them from the root `package.json`. Do not hand-edit them; staging overwrites them. (Older
notes describing "six version spots" predate that script.)

Then add a `## [X.Y.Z] - <date>` section to `CHANGELOG.md`, and bump the load-trace stamp in
`src/app/modules/shared/components/cedar-embeddable-metadata-editor/cedar-embeddable-metadata-editor.component.ts`
→ `private static INNER_VERSION = '<YYYY-MM-DD HH:MM>';`.

> `ceeVersion` derives from `package.json` and is exposed as `window.cedarEmbeddableEditorVersion`,
> so bumping `package.json` is what drives the visible version. `INNER_VERSION` is only the stamp
> logged at load. `README.md` and `CHANGELOG.md` are copied into the package by staging — no manual
> `cp` step.

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

### 4 · Publish to Nexus

```bash
cd dist-npm/cedar-embeddable-editor && npm publish --tag dev
```

> **Pass `--tag dev` explicitly.** The staged manifest carries `publishConfig.tag: "dev"`, and on
> npm 10.8.2 that is *not* enough: a dry run reports "Publishing to … **with tag latest**" and only
> honours `dev` when the flag is on the command line. Without it a dev build becomes the default
> install for the scoped package. Verify with a dry run first — it names both the registry and the
> tag, which is the cheapest way to catch a wrong target before it is permanent:
>
> ```bash
> npm publish --dry-run --tag dev
> ```

Then confirm what moved:

```bash
npm dist-tag ls @org.metadatacenter/cedar-embeddable-editor
```

Only `dev` should point at the new version. If a `latest` appears, a dev build was published
without the flag.

### 5 · Propagate

Eight manifests across six repos depend on CEE, all on the unscoped `cedar-embeddable-editor`:

| Repo | Manifest |
|---|---|
| `cedar-template-editor` | `package.json` |
| `cedar-artifacts` | `cedar-artifacts-src/package.json` |
| `cedar-bridging` | `cedar-bridging-src/package.json` |
| `cedar-openview` | `cedar-openview-src/package.json` |
| `cedar-component-demo` | `cedar-cee-demo-angular-src`, `cedar-cee-demo-ember-src`, `cedar-cee-demo-react`, `cedar-cee-docs-angular-src` |

**A Nexus dev build reaches none of them**, because it is a different package name. To try one in a
consumer, install the scoped package there deliberately; don't expect a reinstall to find it.

For a stable npmjs release, each repo takes the new version in its `package.json`, then reinstall,
rebuild, commit, push. `cedar-template-editor` uses a caret and picks it up on the next
`npm install` + `gulp`, which happens during a prod deploy
([PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) step 6).

```bash
goartifacts && npm install && cd .. && cedarcli build this
gobridging  && npm install && cd .. && cedarcli build this
```

> `cedar-cee-demo-angular-src` needs `npm install --legacy-peer-deps`; the others do not.

### Stable releases to public npmjs

Read this before cutting one. The tooling in `scripts/npm-package.mjs` hardcodes the scoped name and
takes its registry from the root `package.json`'s `publishConfig`, which points at Nexus. So there
is currently **no supported path that produces the unscoped npmjs package** the embedding repos
depend on — publishing one means either changing that script or hand-assembling a package, and it is
a decision about where CEE is distributed rather than a command to run. Raise it before improvising.

What the older notes said about npmjs auth still applies if that decision is taken: publishing needs
rights on `cedar-embeddable-editor`, npm requires 2FA (`npm publish --otp=<code>`, or a granular
access token with "Bypass 2FA" in `~/.npmrc`), and an `E404` on publish means unauthenticated rather
than missing — check `npm whoami`.

### Gotchas

- **`publishConfig.tag` is not honoured on npm 10.8.2.** Pass `--tag dev`. A dry run tells you which
  tag will actually be used.
- **Publish only from `dist-npm/cedar-embeddable-editor/`.** From the repo root, `npm publish` uses
  the root manifest and packs the whole source tree.
- **Staging refuses a stale bundle** rather than shipping one. `browser bundle does not match its
  manifest` means run `npm run test:visual` again; it is the guard working, not a fault.
- **Reaching prod is a separate step.** Publishing does nothing for prod until the template editor is
  rebuilt against the new version *and* `CEDAR_VERSION_MODIFIER` is bumped so clients drop the cached
  bundle (PROD-DEPLOY-RUNBOOK + frontend-caching).

