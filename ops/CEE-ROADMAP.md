# CEDAR Embeddable Editor (CEE) — Roadmap

Outstanding work for `cedar-embeddable-editor` and for the TypeScript model
library it consumes. Backend and cross-service work belongs in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md); build and test instructions in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the TypeScript and Java libraries
disagree in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md).

This roadmap tracks open work only.

## Current position

- The version march is **done**: `cee-with-model-library` is on Angular 22.1,
  TypeScript 6.0, RxJS 7.8 and Node 24.19.0, reached one branch per hop through
  `cee-angular-15` … `cee-angular-22` and fast-forwarded onto it. `develop` and
  `main` are still on Angular 14.3, TypeScript 4.8 and RxJS 6.6, so both readings
  of "where CEE is" remain true and it is worth saying which one is meant. Landing
  the branch is not tracked here: it happens as a matter of course.
- The package is staged as `1.6.0-ng22`, which is what the local Template Designer
  and OpenView both serve. It now ships TypeScript declarations for the host
  contract — item 1.
- The model dependency is the Nexus-only prerelease
  `@org.metadatacenter/cedar-model-typescript-library@0.9.2-dev.20260805.50ef2b3`.
  That build carries `InstanceValidator`, so item 5 is no longer blocked on the
  library having shipped — only on it having shipped *stably*.
- The safety net is 2,200 domain tests, 121 unit tests across eleven Angular
  unit-spec files, and 356 bundle-level Playwright checks across desktop, narrow
  and smoke projects on Chromium, Firefox and WebKit, with 108 committed
  snapshots.
- One visual check is flaky at roughly one run in four: `external authority
  endpoints › a returned authority term can be selected and reaches the host
  metadata`. Measured across four runs either side of an unrelated commit, so it
  is the test and not a regression — it was misread as one once already. Until it
  is fixed, a single red run of that name means re-run before investigating.
- Template-authored rich text is **sanitized by default**; verbatim rendering is
  available only to a host that sets `trustTemplateMarkup`. Instance-authored markup
  was always sanitized and still is. The README's *Embedding security* section is
  the first place this has been written down for embedders — item 7.
- Nothing checks CEE's own instance output against its template. The `ajv` check
  that used to is gone, and its replacement is blocked — item 5.
- The obsolete datetime-picker dependency has been replaced by CEE's in-house
  time picker.
- Lint is the first stage of `test:ci` and runs clean, on `angular-eslint` 22,
  `typescript-eslint` 8 and ESLint 9 with a flat config. `no-explicit-any` is an
  error rather than a baselined warning; the 42 remaining `any` sites across 10
  files each carry their own disable comment, so each is a decision on record
  rather than a number in a budget — item 3.
- **TypeScript `strict` is on**, whole, in `tsconfig.base.json`, and every project
  that extends it type-checks clean. `npm run typecheck` covers every source file
  plus the harness and runs in the gate between lint and the unit tests, with one
  compiler for both: the build only checks what the app reaches and vitest checks
  nothing, so without it a file that is neither reachable from `main.ts` nor
  executed by a test goes unchecked. The harness type-checks in the gate but
  **not under `strict`** — `harness/tsconfig.json` stands alone rather than
  extending the base, and sets `strict: false` — item 3.
  `skipLibCheck` is gone from both root projects, so library declarations are
  checked rather than trusted; the harness keeps it, because `paths` aims
  `@angular/core` at a local stub and every `.d.ts` importing Angular would
  otherwise be measured against that stub.
- Templates are type-checked on every build, not only the production one.
  `angular.json` had `aot: false` in the build target's base options, so `ng build`
  and `ng serve` compiled no template at all — a binding to a property that does
  not exist built clean.
- **CEE still builds on the deprecated webpack `browser` builder.** The move to
  `@angular/build:application` was done, measured and then reverted, because
  openview cannot consume the result — item 3.
- **Vitest is 4.1.10** in the root and the harness, up from 1.6.1, which clears
  the critical advisory against a listening Vitest UI server. The two must move
  together: the harness points its Vite root at the repository, so a split
  version loads the root's worker and every spec dies with `No handler function
  exported`. Vitest 4 brings Vite 8, which transforms with oxc and **silently
  ignores an `esbuild` config block** — both configs stated
  `experimentalDecorators` there, so every spec touching a decorated class failed
  until they were rewritten as `oxc`. Coverage changed twice over: spec files are
  no longer excluded by default, and the AST-aware remapping that replaced the
  old V8 mapping counts more branches, so the same source that cleared a 90%
  branch floor everywhere now measures 86.6 to 91.5. The floors are 85 for
  branches, 90 for statements, and the drop is a measurement change rather than a
  regression. A root audit is down from 19 findings to 12, both criticals gone;
  the twelve left are the Angular CLI and webpack-dev-server chain, five of which
  the application-builder migration would take with it.
- **Templates are on block control flow.** All 203 `*ngIf` and `*ngFor` sites
  across 33 templates — 184 and 19 — are `@if` and `@for`, rewritten by
  `ng generate @angular/core:control-flow`. The migration was declined once, at
  Angular 21, on the advice not to combine a framework hop with a control-flow
  rewrite; the reason recorded beside it, that the directives were not deprecated,
  was wrong even then. Angular marked `NgIf`, `NgFor` and the `NgSwitch` family
  `@deprecated 20.0`. `@angular-eslint/template/prefer-control-flow` is now an
  error, so the old syntax cannot return a template at a time. Nothing renders
  differently — all 108 snapshots match — and the bundle lost a further 17,912
  bytes. `CommonModule` stays: `ngClass` and the `async`, `json`, `keyvalue` and
  `titlecase` pipes are still used. The migration also reformatted the templates,
  which had never been prettier-clean because lint does not cover HTML formatting.
- **`BrowserAnimationsModule` is gone** from both application modules, and
  `@angular/animations` is no longer a dependency of any kind. Angular deprecated
  the module at 20.2 and intends to remove it at 23. CEE never used it: no
  `trigger`, no `[@…]` binding and no `animations:` metadata anywhere in the
  source. Material 22 does not need it either — it dropped `@angular/animations`
  from its peer dependencies and animates in CSS, consulting
  `ANIMATION_MODULE_TYPE` only to ask whether it is `'NoopAnimations'`, which
  `BrowserAnimationsModule` never provided. Removing it therefore changes no
  behaviour, and the visual suite agrees across all 356 checks, overlays, select
  panels and expansion panels included. The bundle drops 64,099 bytes to
  3,428,943 raw and 802,561 gzip.

## Features

### 1. Give the custom element a typed and validated host contract

CEE exposes Angular component inputs directly through `createCustomElement`. The
package now ships declarations describing that surface, so a TypeScript host has a
checked configuration object and a typed element, and a configuration is checked
again at runtime where it crosses the boundary — which is what covers a JavaScript
host and `loadConfigFromURL`, the two routes a compiler cannot see. The component's
own inputs remain `object`, since narrowing them is a change to the element rather
than to its description.

The behaviour underneath is the larger part, and none of it has moved.
Configuration reassignment mixes replacement and patch: omitted values can retain
old parser, endpoint, prefix or language state, while output serialization reads the
replacement object. Read-only mode and empty-field hiding can be enabled but not
cleanly disabled. Three inputs supply an artifact and none of them says what happens
when two are set.

Deliver:

- ~~Export `CeeConfig`, `CeeEventHandler`, `CeeTemplateAndInstance`, output and
  report types, and a `CedarEmbeddableEditorElement` interface.~~ Done, in
  `src/app/cee-public-api.ts`, with an `HTMLElementTagNameMap` entry so the element
  types itself.
- ~~Publish TypeScript declarations~~ — shipped, generated from that one file at
  staging time. **Types only**, and not by choice: the bundle is an IIFE that
  registers a custom element and exports nothing, so a published `const` would
  satisfy a host's compiler and be `undefined` at runtime. Publishing the key names
  as values, or a machine-readable runtime schema, waits on the package exporting
  anything at all — which is a packaging decision (app bundle versus library) that
  belongs with the rest of this item.
- ~~Report unknown keys, wrong types and invalid combinations to the host.~~ Done,
  in `shared/util/config-validation.ts`, called from the wrapper's `config` setter —
  the one point both a host assignment and `loadConfigFromURL` pass through.
  Normalizing values is not done and is not separable from the assignment-semantics
  decision below: what a missing key normalizes *to* depends on whether omitting one
  resets it.
- Define configuration assignment as either initialization-only or dynamic.
  If dynamic, use complete replacement semantics and apply changes atomically.
- Define the lifecycle, reversibility and reset behavior of every setting.
- Define precedence and clearing semantics for the three artifact-input paths.

Done when applying configuration B after A is externally equivalent to creating
a fresh editor with B. The browser harness must cover invalid configuration,
omitted defaults, reversible read-only and empty-field behavior, JSON/YAML
transitions, endpoint/prefix/language resets and artifact assignment order.

The three semantic decisions — replacement versus patch, whether the one-way flags
become reversible, which artifact input wins — are the part that changes behaviour,
and each breaks a host relying on today's answer. They are written down at the
members they affect in `cee-public-api.ts` and in the README, so nobody adopts them
by accident in the meantime.

Complete this before declaring `1.6.0` stable.

#### What describing the contract turned up

Kept because each was a decision that could reasonably have gone the other way, and
each would be re-decided the same wrong way without the reason written down.

- **The package cannot publish a value.** The bundle is an IIFE that registers a
  custom element and exports nothing, so the declarations are types only — not a
  style choice. The first draft exported the config keys as constants, which would
  have satisfied a host's compiler and been `undefined` at runtime. A test now
  asserts the public API declares no runtime values. This is the constraint that
  makes the packaging question (app bundle versus library) a prerequisite rather
  than a preference: key names as constants and a machine-readable schema both wait
  on it.
- **The key list lives in three places and only one exists at runtime** — the
  component's constants, the published `CeeConfig` interface, and the validator's
  `CONFIG_SCHEMA`. Two are compile-time only, which is why a test reads them from
  source and holds all three together. A key missing from the schema is not a silent
  gap: the boundary check reports it to the host as unknown, which is the loudest
  possible way for the three to disagree.
- **The authority endpoint keys are enumerated, not matched.** They come from
  `AUTHORITY_DESCRIPTORS`, so `orkidIntegratedExtAuthUrl` is rejected. A pattern like
  `/Integrated(ExtAuth|Details)Url$/` reads as the obvious implementation and would
  have accepted precisely the typo the check exists to catch.

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
seconds, and generate options at second intervals. Now that the Angular 14→22 upgrade has
landed, prototype replacing only the in-house `app-time-picker` with it. Do not replace the
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

### 3. Finish what the Angular march left behind

The march itself is done — 14 → 22, a branch per hop, `cee-angular-15` through
`cee-angular-22`, each landed against a green gate. What it deliberately did not
absorb is collected here, because a framework hop that also rewrites null handling
or restyles the form is a hop whose failures cannot be attributed.

- **Clear the 42 remaining `any` sites.** Down from 77 across 44 files, and now
  errors with individual disable comments rather than a baseline, so the count
  cannot drift upward unnoticed. The largest cluster by far is
  `model-library-template-parser` (14), where the library's `valueConstraints` is
  read as `any`; the two editor spec files hold 16 more between them. Typing them
  is not cosmetic: doing the same elsewhere surfaced a call reading `rawResponse`
  off a type with no such property, keywords typed `string[]` that are
  `string[][]`, and an ORCID resolve typed as the parsed researcher rather than
  the document parsed into one.
- **Put the harness under `strict`.** `harness/tsconfig.json` does not extend
  `tsconfig.base.json`; it declares its own options and sets `strict: false` and
  `noImplicitAny: false`. So the claim that the repository is strict throughout
  has a hole in the one project written to outlive framework upgrades. Turning it
  on reports 77 errors, 57 of them `TS18047` and `TS2531` — "possibly null" and
  "possibly undefined" on generated fixtures. That is the same shape of work the
  `strictNullChecks` pass did in `src/`, where it surfaced real defects rather
  than only noise, and it is too large to carry inside an unrelated change.
- **Move to the `@angular/build:application` builder.** Done once and reverted,
  so what follows is measured rather than estimated.
  `ng update @angular/cli --migrate-only --name=use-application-builder` makes
  the workspace edit; `esModuleInterop` has to be swapped into
  `tsconfig.base.json` by hand, because the schematic hard-codes the path
  `tsconfig.json` where CEE keeps no compilerOptions. The artifact then builds
  at **3,207,044 bytes, 190,309 smaller**, and passes all 356 bundle-level
  checks.

  It was reverted because **openview cannot load it**. openview is on Angular
  16.2 and takes CEE through its own build rather than serving the file; that
  build re-minifies it, 3,207,044 down to 3,183,588, and the result throws
  `ReferenceError: TO is not defined` before the custom element registers. The
  previous artifact survives the same treatment and reports version
  `1.6.0-ng22`. Confirmed by A/B with openview's `.angular/cache` cleared each
  time and the script loaded into a blank page, so neither a stale build nor
  openview's own page explains it.

  The mechanism is **not** syntax: both artifacts carry the same static class
  fields, named class expressions and modern operators. The failure is in
  openview's optimizer, on code CEE's bundle contains as
  `var WN = class t extends Error { static IDLE = new t("IDLE") … }`, which
  comes out as `new TO("IDLE")` with no `TO` in scope.

  So this is blocked on openview rather than on CEE, and the cheapest route is
  probably to stop openview re-minifying a bundle that is already minified, or
  to move it off Angular 16. Whichever is chosen, the check that matters is not
  CEE's gate — it passed throughout — but loading openview's own `scripts.js`
  and asking whether `customElements.get('cedar-embeddable-editor')` is defined.

  Packaging is ready either way. `resolve-build-output.mjs` selects `bundle` for
  this output and `concat` for webpack's, and the packaging suite covers both
  shapes.
- **The Metadata Editor scroll bug.** Scrolling past the end of the form and back
  makes the bottom disappear. Confirmed pre-existing on Angular 14, so the march
  neither caused nor fixed it. The suspects are the two nested
  `height: 100%; overflow-y: auto` containers in `create-instance.html`, in the
  Template Designer rather than in CEE.
- **`cedar-artifact-viewer`.** Used on two OpenView pages and installed as an npm
  package, but never wired into `angular.json`; its script tag is already
  commented out. Decide whether it is live or dead, and then make the repository
  say so.
Material 3 theming was also held out of the march. It belongs with the rest of the
styling questions rather than here — item 4.

Done when the `any` sites are gone, the scroll bug is diagnosed,
`cedar-artifact-viewer` is either wired in or deleted, and the build no longer
runs through a deprecated builder.

#### What the march cost, and what it taught

Kept because it is measured rather than remembered, and because the next framework
upgrade will meet the same shapes.

The gate went from 64 unit tests in 8 files, 2,125 domain and 335 visual with 98
snapshots, to 102 unit, 2,132 domain and 346 visual with 100 snapshots. Lint went
from 77 baselined warnings across 44 files to 32 across 22, and from running
beside the build to being the first stage of `test:ci`.

The bundle moved most: 3,131,159 → 3,515,983 raw and 743,467 → 807,197 gzip, up
385KB and 64KB, with its limits raised three times. MDC accounts for 190,966 raw
and 19,620 gzip of that, measured either side of the migration commit; 16 → 17
added 42,632; 18 gave 78,423 back; 20 and 21 together took 84,748. Gzip is the
binding figure now, not raw, and CI measures it larger than a developer machine
does. Letting the framework cost bytes was a decision taken three times on the
evidence each time; whether a 3.5MB single-file bundle is still the right artifact
is a question worth asking on its own.

Three shapes recurred, none of which the build or the unit tests could see:

- **Libraries assume they are styling a document, not a shadow root.** Four times:
  Material 16 emitting theme tokens under `html{}`, and at CDK 19 the
  visually-hidden class, the autosize measuring styles and the textarea
  line-height cache. Each showed up only as pixels.
- **Tests that pin an implementation rather than the guarantee fail on upgrades
  that broke nothing.** Two overlay tests asserted that `mat-select` options live
  inside `.cee-overlay-container`; Material 21 stopped delivering them that way
  while the guarantee — inside the shadow root, never in the host document — held
  throughout.
- **A framework that stops guessing exposes markup that was always wrong.** 15
  buttons carried both `mat-button` and `mat-icon-button`. Until Angular 22
  refused to choose, both applied and drew a 64x48 rounded rectangle that was
  neither. Nothing reported it, because nothing was failing.

### 4. CEE styling

Three separate questions that all live in the same few files, kept together
because answering one changes the answers to the others. `THEMING.md` in the CEE
repository is the standing record of what CEE's appearance is committed to, what
is incidental, and the five-step order for judging a failing baseline.

**CEE does not render CEDAR's brand.** `_cee-tokens.scss` specifies
`$cee-brand-primary` and `$cee-brand-accent` in full, and then applies them to
nothing but three custom properties. What ships is Angular's stock teal 600
(#00897b) and deep-orange, because that is what `$applied-theme` is built from.
Stock teal accounts for 35 of the colour values in the bundle; CEDAR's own
#0f7686 appears twice, both times outside the Material theme. This reads as an
accident rather than a decision, and it has been left alone through eight hops
precisely because correcting it is a visible change and an upgrade is not the
place to make one quietly. It is a decision for someone, and it is still waiting.

**Migrate the theme to Material 3.** One theme, not the two this roadmap used to
claim: a single `$applied-theme` built from a primary and an accent palette, all
of it in `_cee-material-theme.scss`, which exists so that exactly this kind of
change touches one file. The M2 helpers it builds on — `m2-define-palette`,
`m2-define-light-theme`, `m2-define-typography-config` — are the compatibility
path, already renamed once at Material 18, and M3's token-based API is the
supported model. They are not deprecated in Material 22 — nothing in the Sass
says so, and they are still forwarded from `core/m2` — so the pressure here is
drift rather than a removal date. That is a different model rather than a
renamed one: a rewrite of the `$applied-theme` construction, not a
search-and-replace, and it will change what CEE looks like.

What makes it a rewrite is the palette shape, and that is measured rather than
predicted. `mat.define-theme` rejects CEE's palettes outright:

> Expected `$config.color.primary` to be a valid M3 palette.

M2 palettes are 50–900 plus A100–A700 and a contrast map, which is what
`_cee-tokens.scss` holds. M3 palettes are tonal — 0 to 100 — and each carries
`secondary`, `neutral`, `neutral-variant` and `error` sub-maps. So the note in
`_cee-tokens.scss` that the 14-step shape is "a convention, not a dependency"
stops being true under M3: it becomes the wrong shape, and the adapter cannot
paper over it.

The supported way to produce the right shape is
`ng generate @angular/material:theme-color`, which derives a full M3 palette set
from source hex colours — `primaryColor`, and optionally secondary, tertiary,
neutral and error. Note there is no accent in M3; CEE's primary-and-accent pair
maps onto primary and tertiary.

That generator is also why this and the brand question above cannot be separated:
its input *is* the brand decision. Whoever runs it types a hex, and typing
CEDAR's `#0f7686` rather than Angular's stock teal is precisely the choice that
has been waiting. There is no version of this migration that leaves the palette
question open.

Material 22 offers no `mat.theme()` one-liner; the M3 route here is
`mat.define-theme` feeding the same `mat.all-component-themes` already in use, so
the emission points in `core()` and `component-themes()` survive the change.

The `TODO(v15)` block the `core()` mixin carried is answered and gone. It asked
whether `all-component-typographies()` was needed, and set out two conditions
for dropping it; both hold. CEE specifies typography in `$_typography`, which
`$applied-theme` carries and `all-component-themes` emits, so component
typography was written twice, and the hierarchy classes the call also brings are
used nowhere — the only mention of `.mat-headline-1` in the repository was inside
that note. Removing it takes 13,678 bytes out of the bundle with all 356
bundle-level checks passing, every pixel snapshot among them. Carried unanswered
from 15 to 22, it cost bytes on every build in the meantime.

**Reduce what CEE reaches into.** 18 distinct `.mat-*` and `.mdc-*` selectors
across 10 stylesheets — the 24 across 11 recorded here before counted six that
appear only inside comments, which is what `visual/tests/material-selectors.spec.ts`
strips before it checks anything. Plus 15 `!important` declarations in `styles-own.scss`
alone, several of them overriding MDC's own three-class selectors. Each is a bet
that Material's internal DOM will not move, and the march collected the receipts:
the form-field infix compression had to be rewritten for MDC because height moved
from padding to `min-height`, and the notched outline needed three selectors where
legacy needed one. `visual/tests/material-selectors.spec.ts` at least reports when
one of these stops matching anything, which is how two dead rules were found — but
reporting is not reducing.

The rule for deciding which of the 18 to keep: take Material for behaviour —
focus management, overlay positioning, keyboard interaction, the accessibility
work that is expensive to reproduce and easy to get wrong — and let
`_cee-tokens.scss` decide appearance. A selector reached into for a colour, a
font or a spacing is one CEE should be able to express as a token; one reached
into to correct a layout Material computes, like the form-field infix, is
harder to give up and worth keeping deliberately. Half of that split already
holds: `_cee-tokens.scss` names CEDAR's values and imports no Material, and
`_cee-material-theme.scss` is the only file that does. What is missing is the
tokens reaching the components without going through Material's internal class
names.

Done when the palette question has an answer that someone chose, the theme is
built on supported APIs, and the count of Material internals CEE depends on has
gone down rather than up.

## Testing

### 5. Land the instance-conformance spec

CEE used to check its own output against each template with `ajv`, which meant
carrying a second validator and restating rules CEDAR already defines. That was
removed. The model library now answers the question through
`InstanceValidator.validate` — so until the library ships, **nothing catches a
dropped `@type` or a missing property in CEE's output**.

The spec is written and proven: 117 tests, which would take the domain suite from
2,132 to 2,249. It is parked at `harness/test/instance-conformance.spec.ts.pending`
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

### 7. Finish the rich-text trust boundary

The boundary is drawn and enforced. Static rich text is sanitized unless the host
sets `trustTemplateMarkup`, the README's *Embedding security* section says who
should set it and who should not, and the browser suite asserts both that a
malicious template cannot execute and that the formatting survives — the second
being what stops a later "hardening" through Angular's sanitizer, which would pass
every security assertion and flatten every inline style.

The policy is DOMPurify with an allowlist taken from an inventory of the 271 static
content blocks in the CEDAR, HuBMAP and test-artifact corpora, not from CKEditor's
toolbar. Two findings from that inventory are worth keeping, because both corrected
a reasonable guess:

- All twenty `data:` URLs in the corpus are inline PNGs on an `<img>`. Refusing
  `data:` outright would have blanked every one. Raster types are allowed on images;
  `image/svg+xml` is not, because an SVG can carry script.
- Corpus template 009 already carries `ng-click` and `ng-class`, pasted from CEDAR's
  own interface. Inert in CEE, which is Angular; executable in the AngularJS Template
  Designer that embeds it.

What is left:

- **Say it where a template author will see it.** The Template Designer's rich-text
  editor has a `Source` button, so an author can type any markup at all and get no
  indication that some of it will not render for an embedder. The editor should say
  what survives, or refuse what will not.
- **Decide whether `trustTemplateMarkup` belongs in the host contract.** It is a
  plain boolean config key today, which is enough to be usable and not enough to be
  discoverable — it should be part of the typed contract and the runtime schema in
  item 1 rather than a key a host learns about from the README.
- **Sweep the other template-authored strings.** Rich text was the one path
  rendering as HTML, but section-break, image and YouTube content all come from the
  same author through the same route. They are treated as text or as URLs today, and
  that is a property worth a test rather than an observation.

Done when a template author is told what their markup will do, and the trust key is
part of the declared host contract rather than a README footnote.

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
2. Clear the remaining `any` sites (item 3). 42 across 10 files, and typing them
   has surfaced live bugs three times now.
3. Keep the production bundle and Playwright checks working throughout.
4. Complete the public host contract before the stable `1.6.0` release (item 1);
   the stable model-library release lands as an aside of that work.
5. Answer the palette question before that release too (item 4). Shipping 1.6.0 in
   stock Material teal decides it by default, which is the one way of deciding it
   nobody chose.
6. Fold `trustTemplateMarkup` into the typed host contract, and tell template
   authors what their markup will do (item 7). The boundary itself is enforced;
   what remains is making it discoverable from both sides.

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
