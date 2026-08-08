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
  and OpenView both serve.
- The model dependency is the Nexus-only prerelease
  `@org.metadatacenter/cedar-model-typescript-library@0.9.2-dev.20260805.50ef2b3`.
  That build carries `InstanceValidator`, so item 5 is no longer blocked on the
  library having shipped — only on it having shipped *stably*.
- The safety net is 2,164 domain tests, 102 unit tests across nine Angular
  unit-spec files, and 348 bundle-level Playwright checks across desktop, narrow
  and smoke projects on Chromium, Firefox and WebKit, with 102 committed
  snapshots.
- One visual check is flaky at roughly one run in four: `external authority
  endpoints › a returned authority term can be selected and reaches the host
  metadata`. Measured across four runs either side of an unrelated commit, so it
  is the test and not a regression — it was misread as one once already. Until it
  is fixed, a single red run of that name means re-run before investigating.
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
  type-checks clean under it — including the harness, which never had until now.
  `npm run typecheck` covers every source file plus the harness and runs in the
  gate between lint and the unit tests, with one compiler for both: the build only
  checks what the app reaches and vitest checks nothing, so without it a file that
  is neither reachable from `main.ts` nor executed by a test goes unchecked.
- Templates are type-checked on every build, not only the production one.
  `angular.json` had `aot: false` in the build target's base options, so `ng build`
  and `ng serve` compiled no template at all — a binding to a property that does
  not exist built clean.

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

Done when the `any` sites are gone, the scroll bug is diagnosed, and
`cedar-artifact-viewer` is either wired in or deleted.

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
path, already renamed once at Material 18 and slated to go in favour of M3's
token-based API. That is a different model rather than a renamed one: a rewrite of
the `$applied-theme` construction, not a search-and-replace, and it will change
what CEE looks like. Doing it at the same time as the brand question above is
probably right, since both rewrite the same construction.

While in there, the `core()` mixin still carries a `TODO(v15)` block advising what
to do about typography "as of v15". CEE is on 22. Either act on it or delete it —
a stale instruction in the one file the next person will open to make this change
is worse than none.

**Reduce what CEE reaches into.** 24 distinct `.mat-*` and `.mdc-*` selectors
across 11 stylesheets, plus 15 `!important` declarations in `styles-own.scss`
alone, several of them overriding MDC's own three-class selectors. Each is a bet
that Material's internal DOM will not move, and the march collected the receipts:
the form-field infix compression had to be rewritten for MDC because height moved
from padding to `min-height`, and the notched outline needed three selectors where
legacy needed one. `visual/tests/material-selectors.spec.ts` at least reports when
one of these stops matching anything, which is how two dead rules were found — but
reporting is not reducing.

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
2. Clear the remaining `any` sites (item 3). 42 across 10 files, and typing them
   has surfaced live bugs three times now.
3. Keep the production bundle and Playwright checks working throughout.
4. Complete the public host contract before the stable `1.6.0` release (item 1);
   the stable model-library release lands as an aside of that work.
5. Answer the palette question before that release too (item 4). Shipping 1.6.0 in
   stock Material teal decides it by default, which is the one way of deciding it
   nobody chose.
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
