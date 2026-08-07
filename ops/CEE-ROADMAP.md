# CEDAR Embeddable Editor (CEE) — Roadmap

Outstanding work for `cedar-embeddable-editor` and for the TypeScript model
library it consumes. Backend and cross-service work belongs in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md); build and test instructions in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the TypeScript and Java libraries
disagree in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md).

This roadmap tracks open work only.

## Current position

- CEE is on Angular 14.3, TypeScript 4.8 and RxJS 6.6.
- The package is currently
  `1.6.0-dev.20260804.85b7ccf` on `cee-with-model-library`.
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

Known work:

- Migrate Angular Material to MDC and repair selectors that depend on Material
  internals.
- Upgrade RxJS, TypeScript, `@ngx-translate`, `@ng-select/ng-select` and
  `ngx-mat-select-search` at their compatible Angular versions.
- Replace obsolete `entryComponents` configuration.
- Adapt the production concatenated-bundle step and Playwright preparation when
  the Angular build pipeline changes.
- Migrate the two custom Material themes to the supported Material 3 APIs.
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

### 4. Repair and enforce Angular ESLint

`npm run lint` cannot currently start because the Angular ESLint builder is
missing. Adding the Angular 14-compatible builder exposes a baseline of 184
errors, including Angular templates parsed with the TypeScript parser.

Configure Angular ESLint at the Angular 22 target with separate TypeScript and
template overrides. Resolve the baseline without broad suppressions, then add
`npm run lint` to `test:ci`.

Done when lint succeeds from a clean checkout and new TypeScript or template
violations fail CI.

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

### 8. Reach the two config flags nothing exercises

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

### 6. Define and enforce the trust boundary for template-authored rich text

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

### 7. Settle the temporal `required` judgement

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
2. Start the Angular upgrade (item 3), landing the preparation branch on
   `develop` first so the safety net is in place before the version march.
3. Establish linting at the Angular 22 target before closing the upgrade
   (item 4).
4. Keep the production bundle and Playwright checks working throughout.
5. Complete the public host contract before the stable `1.6.0` release (item 1);
   the stable model-library release lands as an aside of that work.
6. Define and enforce the template-rich-text trust contract before allowing
   untrusted users to supply templates (item 6).

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
