# CEDAR Embeddable Editor (CEE) — Roadmap

Outstanding work for `cedar-embeddable-editor` and for the TypeScript model
library it consumes. Backend and cross-service work belongs in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md); build and test instructions in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the TypeScript and Java libraries
disagree in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md).

This roadmap tracks open work only.

## Current position

- The version march is in progress and has reached **Angular 19.2**, TypeScript
  5.6 and RxJS 7.8, one branch per hop: `cee-angular-15` through
  `cee-angular-19`. Only 19 is unpushed. `develop` is still on Angular 14.3,
  TypeScript 4.8 and RxJS 6.6, so both readings of "where CEE is" are true and
  the distinction matters — item 3.
- The package is `1.6.0-dev.20260804.85b7ccf` on `cee-with-model-library`, and
  staged as `1.6.0-ng18` on the hop branches.
- The model dependency is the Nexus-only prerelease
  `@org.metadatacenter/cedar-model-typescript-library@0.9.2-dev.20260805.4105f7c`.
  That build carries `InstanceValidator`, so item 5 is no longer blocked on the
  library having shipped — only on it having shipped *stably*.
- The safety net consists of 2,125 domain tests, 51 tests across seven focused
  Angular unit-spec files, and 325 bundle-level Playwright checks: 304 full
  Chromium checks plus seven smoke checks on each of Chromium, Firefox and WebKit.
- Nothing checks CEE's own instance output against its template. The `ajv` check
  that used to is gone, and its replacement is blocked — item 5.
- The obsolete datetime-picker dependency has been replaced by CEE's in-house
  time picker, so no dependency currently caps the Angular upgrade.
- Linting is built and running, and is not in the test gate — item 4. `ng lint`
  covers `src/**/*.ts` and `src/**/*.html` through `@angular-eslint/builder:lint`,
  with separate TypeScript and template overrides in `.eslintrc.json`. On
  `cee-angular-19` it reports 264 errors, every one `prettier/prettier` and
  auto-fixable, plus the 77 baselined `no-explicit-any` warnings.

## Features

### 1. Give the custom element a typed and validated host contract

CEE currently exposes Angular component inputs directly through
`createCustomElement`. Public inputs are mostly `object` or `any`; configuration
uses private string keys; the npm package ships no declarations or runtime
schema.

Configuration reassignment also mixes replacement and patch behavior. Omitted
values can retain old parser, endpoint, prefix or language state, while output
serialization reads the replacement object. Read-only mode and empty-field
hiding can be enabled but not cleanly disabled.

Deliver:

- Export `CeeConfig`, `CeeEventHandler`, `CeeTemplateAndInstance`, output and
  report types, and a `CedarEmbeddableEditorElement` interface.
- Publish TypeScript declarations and the machine-readable runtime schema with
  the npm package.
- Validate and normalize values crossing the custom-element boundary; report
  unknown keys, wrong types and invalid combinations to the host.
- Define configuration assignment as either initialization-only or dynamic.
  If dynamic, use complete replacement semantics and apply changes atomically.
- Define the lifecycle, reversibility and reset behavior of every setting.
- Define precedence and clearing semantics for the three artifact-input paths.

Done when applying configuration B after A is externally equivalent to creating
a fresh editor with B. The browser harness must cover invalid configuration,
omitted defaults, reversible read-only and empty-field behavior, JSON/YAML
transitions, endpoint/prefix/language resets and artifact assignment order.

Complete this before declaring `1.6.0` stable.

### 2. Fix and modernize the datetime field

The date/time/timezone control needs work on three fronts, from the cheap near-term fix
to the deeper rework the Angular upgrade unlocks.

The immediate one is layout. The widget renders with spacing or alignment that looks wrong
next to the other input types. Not a data defect — the value is read and written correctly
(`cedar-input-datetime`, and the temporal value now carries its `@type`) — but a visual one.
Reproduce against the running editor, identify whether it is the component's own
template/styles or how the surrounding field row wraps the three sub-controls, and bring it
into line with the other fields.

The deeper rework waits on the framework. Angular Material 19 added an official `MatTimepicker`
that can share a value with `MatDatepicker`, use locale-driven 12/24-hour display, parse
seconds, and generate options at second intervals. Once the Angular 14→22 upgrade (item 3)
lands, prototype replacing only the in-house `app-time-picker` with it. Do not replace the
CEDAR-level temporal wrapper: Material still does not provide year/month-only values, decimal
seconds, a timezone selector, or CEDAR's XSD serialization and granularity rules (the "Out of
scope" note below). Keep the custom control if matching those rules through Material formats
and options is more complex or less usable than the small component already owned here.

Treat the timezone selector as a separate design correction. It currently offers city-labelled
"timezones" but stores only fixed offsets such as `-08:00`; it also guesses an IANA browser zone
and immediately reduces it to the offset *now*, which can be wrong for the selected date across a
DST boundary. Decide which value the field means. If it means an XSD offset, label choices
neutrally as `UTC−08:00` rather than Pacific Time and derive any default for the selected instant.
If it means a civil timezone, preserve an IANA identifier such as `America/Los_Angeles` separately
and derive the applicable offset from the selected date and time, including ambiguous and
nonexistent DST times. While touching the component, remove the duplicate `valueChanges`
subscriptions in `ngOnInit` and `ngAfterViewInit`, which currently propagate each selection twice.

## Infrastructure

### 3. Upgrade Angular 14 to Angular 22

Run the official migrations one major version at a time and keep the build and
test gates green after every migration. Do not combine this with a standalone
component, signals or control-flow rewrite.

**14 → 22 is done**, a branch per hop (`cee-angular-15` … `cee-angular-22`). What
remains is landing the march on `develop`, which has not moved, and the two pieces
of work the march deliberately kept out of itself: TypeScript strict mode and
Material 3 theming.

Node moved to 24.19.0 at the last hop, on this machine and in CI. Angular 22
requires `^22.22.3 || ^24.15.0 || >=26`; 24 is the active LTS where 22 is in
maintenance, and 26 does not exist yet. TypeScript went to 6.0 with it.

Known work:

Done during the march: the MDC migration and the Material-internal selectors it
broke, the RxJS, TypeScript, `@ngx-translate`, `@ng-select/ng-select` and
`ngx-mat-select-search` upgrades, `entryComponents`, and the packaging and
Playwright preparation for the esbuild pipeline.

Still open:

- Migrate the two custom Material themes to the supported Material 3 APIs.
- Turn TypeScript `strict` on. TypeScript 6.0 made it the default and CEE does not
  compile under it — 685 errors against 26, overwhelmingly `strictNullChecks`,
  `noImplicitAny` and `strictPropertyInitialization`. `tsconfig.base.json` now sets
  it to false explicitly, with the reasoning at the setting, so the position is a
  decision rather than an inherited default. Doing it properly means rewriting null
  handling across the codebase, which is why it was not folded into a framework
  hop.
- Retire the obsolete `e2e/` Protractor project: delete it and its configuration
  and npm command. Done on `cee-with-model-library`; `develop` and `main` still
  carry the four `e2e/` files and the karma references.

Done when a clean checkout builds the production custom-element bundle, all unit,
domain and browser tests pass on Angular 22, and no Protractor dependency,
configuration or script remains.

#### Preparation already landed

On `cee-with-model-library`, not yet on `develop`. The goal was not to start the
upgrade but to make its safety net survive it, and to take the independent
dependency jumps out of the version march so a failure there means one thing
instead of two. Every commit was verified against the full gate, and nothing was
re-baselined.

- **Packaging no longer assumes webpack.** The visual suite used to build its
  bundle with `cat runtime.js polyfills.js main.js` — filenames and an operation
  that belong to the webpack `browser` builder. The esbuild `application`
  builder emits a `browser/` subdirectory, hashed filenames and an entry
  importing sibling chunks, which concatenation turns into a file with dangling
  `import` statements: broken while still looking like a bundle. Packaging now
  goes through `visual/resolve-build-output.mjs`, which decides by reading the
  entry rather than by consulting a version number. The freshness guard also
  records a manifest with strategy, inputs and a sha256, because timestamps stop
  being enough once the builder can change underneath the harness.
- **Brand values sit behind an adapter.** `_cee-tokens.scss` holds CEDAR's
  values and may not reference Material; `_cee-material-theme.scss` is the only
  file touching Material's API and carries the list of renames ahead. The
  adapter emits nothing at the top level on purpose — `@use` would hoist
  Material's CSS above the rules that override it and silently reorder the
  cascade.
- **The visual contract is written down.** `THEMING.md` in the CEE repository
  records what CEE's appearance is committed to, what is incidental, the 16
  `.mat-*` selectors across 10 files reaching into Material internals, and a
  five-step order for judging a failing snapshot. The Material 15 hop will turn
  the baselines red for legitimate reasons; this is what makes that moment a
  decision rather than an improvisation.
- **Independent jumps are out of the march.** `@ngx-translate` core 11 → 14 and
  http-loader 4 → 7 landed alone against a green suite. The `@angular/youtube-
  player` wrapper is gone, replaced by a validated native iframe. Legacy Web
  Components polyfills are gone, CEE now stating its requirement for native
  Custom Elements v1 and Shadow DOM. Unit tests moved from the deprecated karma
  builder to Vitest, which also removes the second runner.
- **`ngx-mat-select-search` has an explicit ladder**, corrected against what the
  packages actually do rather than what they claim. Stay on 4.2.1 while on Angular
  14. The version is driven by which Material components CEE uses, not by the
  Angular version: **6.0.0** imports the legacy entry points and is right while CEE
  is still on legacy components, **7.0.10** imports the MDC ones and is right from
  the MDC migration onward. 7.0.10 holds through Angular 16.

  **8.0.6 does not work on Angular 16, whatever its peer range says.** It declares
  `@angular/material ^16.0.0 || …`, but the package is compiled against Angular
  19.2.21 and the build refuses it outright: "requires Angular version 17.0.0 or
  newer to work correctly". Take it at Angular 17 or later. This entry previously
  said to pin it at 16, which would have cost the next person the same hour.

Two failure modes found while preparing, both worth knowing during the march
because neither looks like a failure. A translation loader that silently stops
fetching looks like the built-in text, which is also what CEE shows when
everything is fine; both directions are now asserted. And under Vitest an
unlinked Angular partial declaration makes a spec file fail to *import*, so its
tests are never registered and the run reports fewer passing tests rather than a
failure — seven of 51 vanished that way before `src/test-setup.ts` existed.

Current gate baseline on that branch:

| Gate | Baseline |
| --- | --- |
| Unit | 64 tests in 8 files (Vitest, Node) |
| Domain | 2,125 tests in 39 files |
| Visual | 335 tests in 3 files, across the configured Playwright projects |
| Visual snapshots | 98 baselines |
| Packaging | 8 tests |
| Lint | 0 errors; 77 baselined `no-explicit-any` warnings |
| Bundle | 3,131,159 raw / 743,467 gzip-9 bytes, within the enforced budgets |

#### What the march has cost so far

At Angular 22 the same gate reads 102 unit, 2,132 domain, 346 visual and 100
snapshots, lint 0 errors against 32 baselined warnings, and 3,515,983 raw /
807,197 gzip bytes.

The bundle is the number that moved most: up 385KB raw and 64KB gzip, and its
limits have been raised three times. MDC accounts for 190,966 raw and 19,620 gzip
of that, measured either side of the migration commit; Angular 16 → 17 added
42,632; Angular 18 gave 78,423 back; 20 and 21 together took 84,748. Gzip is now
the binding figure rather than raw, and CI measures it larger than a developer
machine does — at 21 the margin was 1,747 bytes while raw still had 43KB spare.
Letting the framework cost bytes has been a decision taken three times on the
evidence each time; whether a 3.4MB single-file bundle is still the right artifact
is worth asking separately from the march.

Two recurring shapes are worth carrying into 22. **Libraries assume they are
styling a document, not a shadow root** — four separate times: Material 16 tokens
emitted under `html{}`, and at CDK 19 the visually-hidden class, the autosize
measuring styles and the textarea line-height cache. Each was invisible to the
build and to every unit test, and showed up only as pixels. And **tests that pin an
implementation rather than the guarantee fail on upgrades that broke nothing** —
the two overlay tests at Angular 21 asserted that `mat-select` options live inside
`.cee-overlay-container`, which stopped being how Material delivers them while the
guarantee itself held.

A third is worth adding from the last hop. **A framework that stops guessing
exposes markup that was always wrong**: 15 buttons carried both `mat-button` and
`mat-icon-button`, and until Angular 22 refused to choose, both applied and drew a
64x48 rounded rectangle that was neither. Nothing reported it, because nothing was
failing — the mongrel had been the baseline since the MDC migration.

Deliberately left alone. **Nothing was upgraded toward 22** — no Angular package
moved. **The stock-teal question stays open**: the component theme uses
Angular's stock teal and deep-orange palettes rather than CEDAR's, and stock
teal 600 accounts for 35 color values in the shipped bundle while CEDAR's
`#0f7686` appears twice. It looks like an accident, but correcting it changes
what users see, so deciding it *during* the upgrade is the one option with
nothing to recommend it. **Material's own palettes were not inlined** into the
tokens: the M2 palettes are frozen constants, so pinning them buys little while
transcribing them risks a silent mismatch. **No `TestBed` route under Vitest**,
since nothing under `src/**` needs one and adding it means an Angular-aware Vite
plugin.

What this changes about the estimate: reaching a compiling, unit-green branch is
still roughly 65% of the work — nothing here makes Angular's breaking changes
easier. The remaining 10–15% to reach honestly satisfied visual and bundle gates
was low because the safety net was coupled to the builder being replaced, the
baselines had no standing definition of a regression, and two dependency jumps
were tangled into the same diff. The risk is now concentrated where it belongs,
at the Material 15 MDC restyle and the form-field overrides that force padding
against a DOM MDC replaces. The march still wants a human at that hop; what it
no longer wants is a human reconstructing, at that moment, what CEE was supposed
to look like.

## Testing

### 4. Enforce the lint gate that already runs

Repairing lint is done; enforcing it is not, and the gap between those two is
what this item now is. `ng lint` starts and completes, covering `src/**/*.ts` and
`src/**/*.html` through `@angular-eslint/builder:lint`. `.eslintrc.json` carries
separate TypeScript and template overrides, so templates are parsed by
`@angular-eslint/template` rather than by the TypeScript parser. The
`no-explicit-any` debt is a curated baseline rather than a blanket suppression:
44 named files hold the rule at `warn` while it stays an error everywhere else,
with the three clusters recorded in a comment, so new code cannot add to it.

Three things remain, and only one of them waits for anything:

- **Clear the formatting drift.** `cee-angular-19` reports 264 errors, every one
  `prettier/prettier` and auto-fixable. Mechanical, and best landed as its own
  formatting-only commit so it does not hide inside a version hop.
- **Add `npm run lint` to `test:ci`.** Today the gate is unit, domain and visual
  only, which is why the drift above accumulated unnoticed across the hops. This
  is the item's substance and it does not depend on reaching 22.
- **Move `@angular-eslint/*` off `~14.4.0`.** This is the part that tracks the
  march: the packages follow the Angular major, so they land on 19 now and again
  at 22. Not a bare version bump — 18 through 20 need `@typescript-eslint/utils`
  `>=7.11`, and the repo is on `@typescript-eslint` 6.10, so typescript-eslint
  moves to 7 or 8 with it. ESLint itself can stay on 8: those majors accept
  `^8.57.0 || ^9.0.0`, so `.eslintrc.json` need not become flat config yet, and
  the current pin is 8.53.

Done when lint runs clean from a clean checkout, `test:ci` fails on a new
TypeScript or template violation, and the plugins match the Angular version in
use.

### 5. Land the instance-conformance spec

CEE used to check its own output against each template with `ajv`, which meant
carrying a second validator and restating rules CEDAR already defines. That was
removed. The model library now answers the question through
`InstanceValidator.validate` — so until the library ships, **nothing catches a
dropped `@type` or a missing property in CEE's output**.

The spec is written and proven: 117 tests, taking the domain suite from 2,125 to
2,242. It is parked at `harness/test/instance-conformance.spec.ts.pending`
because it cannot run against the published library. Rename it to `.ts` once the
dependency in `package.json` and `harness/package.json` moves off the prerelease.

Blocked until the model library publishes a stable version.

Done when the spec runs in `test:ci` against a published library version and CEE
output that drops a required key fails the suite.

### 6. Reach the two config flags nothing exercises

The browser suite asserts that every config key changes what renders, because a
key that is silently ignored looks exactly like one that works. Two keys cannot
be answered that way today: each gates on a second condition as well as itself,
and no fixture in the corpus produces that condition. Both are `test.fixme` in
`visual/tests/render.spec.ts` with the condition named, so a run reports them
rather than passing over them.

**`showAllMultiInstanceValues`** draws the "All values" summary above a paged
field — each occurrence's value, numbered, with the current one marked.
`getMultiInstanceDataValueInfo()` returns `""` unless the paged component is a
*field*, since a paged element has no single value to summarise. Every generated
fixture pages elements and never a field; the two real Template Designer fixtures
are the opposite, `17-real-flat` paging two fields and `18-real-nested` sixty-
eight. So the template side already exists. What is missing is an **instance** —
all three companion instances belong to element-paged templates, and with no
values the summary is empty whatever the flag says. One instance file for
`17-real-flat` reaches it.

**`showStaticText`** is the harder one, and it needs a decision before a fixture.
The name promises more than it delivers: free-standing static content renders
regardless of it, and its only use in the application is one `*ngIf` in
`cedar-component-renderer.component.html`. What it actually governs is static
content that `collapseStaticFieldsIntoNextFieldOrElement` has folded *into* a
field, so it draws inside that field's card. Folding happens only when
`collapseStaticComponents` is on, the static is **odd** — consecutive statics are
paired off and left where they are — and it sits immediately before a field. Every
static run in the corpus is a pair, so nothing is ever folded.

Before building a fixture, establish whether the Template Designer can author a
lone static immediately before a field at all. If it cannot, this is not untested
configuration but **dead** configuration, reachable only by hand-written JSON, and
the answer is to remove the key rather than to test it. Either way the name is
worth revisiting — a host reading the config list would reasonably expect turning
`showStaticText` off to hide all static content, and it does nothing of the sort.
That belongs with the host-contract work in item 1.

Done when each flag either has a fixture that reaches it and a passing assertion,
or is removed with the reason recorded.

## Security

### 7. Define and enforce the trust boundary for template-authored rich text

Instance-authored HTML is sanitized, but template-authored static rich text is
rendered through `bypassSecurityTrustHtml` in `keep-html.pipe.ts`. This is safe
only when the embedding application treats template authors as trusted to run
content in the host application's origin. An embedder that lets arbitrary users
supply templates turns static rich text into an XSS path. The source documents
this boundary, but the public README does not.

Deliver:

- Add an embedding-security section to the README that identifies templates as
  trusted input, explains that Shadow DOM is not a security boundary, and tells
  hosts not to load arbitrary templates under the current behavior.
- Inventory the rich-text markup emitted by the CEDAR Template Editor and define
  the minimum supported allowlist for elements, attributes, URL schemes, inline
  styles and embedded media.
- Decide and document the product contract: either require trusted templates
  explicitly, or sanitize template rich text with a policy that preserves the
  supported formatting while removing executable content.
- If trusted rendering remains available, make it an explicit host policy rather
  than an undocumented consequence of loading a template.
- Add browser tests using malicious template rich text, including event-handler
  attributes and executable URLs, alongside regression fixtures for supported
  formatting.

Done when the README states the trust requirement, the runtime behavior matches
the documented policy, executable template content cannot cross that policy
silently, and tests prove both the security boundary and formatting compatibility.

## Model library

Work on `cedar-model-typescript-library` itself. CEE consumes the published
package and does not carry fixes for it.

The stable release is not tracked here — it lands as a matter of course. One
judgement rides along with it whenever it goes out: whether the version is
`0.10.0` rather than `0.9.x`. `wasSuccessful()` on an instance parse could only
ever return true before and can now return false, and `adheresToBlueprint()` has
stopped being a second name for it, so a consumer branching on either sees new
behaviour.

### 8. Settle the temporal `required` judgement

A judgement about what the corpus means, rather than a code change; it needs
someone who knows CEDAR's version history. 28 templates require `@type` on a
temporal value, 27 do not, and 12 require nothing. The blueprint comparison does
not check field-level `required`, so it flags none of them. `InstanceValidator`
requires `@type` always — stricter than roughly half the corpus, on the grounds
that the field declares a `temporalType` and so the value is a typed literal.
That was a judgement, and it should be an explicit one. It does not block the
release.

### Adoption status

CEE historically parsed template JSON and built instance JSON by hand, key by
key, against its own copy of the model vocabulary. Replacing that with the
library was scoped in phases, and where they stand is worth keeping even though
the analysis behind them is not:

- **Phase 0** (additive, on `develop`) is done, and earned its place by finding
  a crash on the first run.
- **Phase 1** is safe to start: 1,016 behavioural tests, 94 tree snapshots over
  input the library did not generate, and 36 visual baselines answer the oracle
  problem rather than merely noting it.
- **Phase 2a** is done. **Phase 2b** is mostly not worth doing — one 15-line
  win, the rest parity work on code a mutation test would struggle to
  distinguish from what is already there.
- **Phase 3** is not a refactor and should not be scoped as one.

Phase 1 and beyond belong on a feature branch; replacing the parser is not an
additive change.

One caution, because it is easy to overclaim. `format-independence.spec.ts` and
`instance-output.spec.ts` show CEE no longer depends on a *serialisation* — they
do not show that what CEE emits is right. `schema:isBasedOn` was missing from
every instance CEE had ever produced while both passed throughout, because an
instance missing a field in both formats is consistent with itself. Format
independence and correctness are different properties, and only one of them has
a test that can fail.

## Delivery order

1. Land the conformance spec as soon as the library publishes (item 5). It is
   written and waiting, and until it runs CEE has no check on its own output.
2. Carry the Angular march from 19 to 22 (item 3), then land it on `develop`,
   which is still on 14.3 and has none of the preparation.
3. Put lint in `test:ci` now rather than at the 22 target (item 4). The 264
   formatting errors that accumulated between the preparation branch and Angular
   19 are what an unenforced gate costs over three hops, and three hops remain.
4. Keep the production bundle and Playwright checks working throughout.
5. Complete the public host contract before the stable `1.6.0` release (item 1);
   the stable model-library release lands as an aside of that work.
6. Define and enforce the template-rich-text trust contract before allowing
   untrusted users to supply templates (item 7).

## Out of scope

- Rewriting CEE around standalone components, signals or new template control
  flow solely because the upgraded Angular version supports them.
- Replacing CEE's temporal wrapper with Angular Material's time picker; Material
  still does not cover CEDAR's granularity, decimal-second and timezone rules.
- Backend or cross-service work tracked by the backend roadmap.
- Reconciling the TypeScript library with the Java one beyond what
  [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md) records as a defect on one
  side. Divergence that reflects a genuine CEDAR ambiguity is a corpus question,
  not a library one.
- Validating anything that needs the template at instance-read time. The reader's
  contract is that it reads an instance alone; `InstanceValidator` is where the
  template-aware checks live.
- Widening instance validation to each field's own value-node `required` array.
  What it would add is nearly all covered already: the `["@value", "@type"]` that
  temporal and numeric fields declare is what `validateTypedValue` enforces, and
  the `@id`-valued kinds declare no `required` at all. The residue is a literal
  node omitting `@value` — which is `{}`, one of the spellings of an unfilled
  slot, and emptiness is valid by policy. Revisit only if a consumer asks.
