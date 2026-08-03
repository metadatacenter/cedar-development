# CEDAR Embeddable Editor (CEE) — Roadmap

Where **CEE** (`cedar-embeddable-editor`) is, what's blocking it, and the order
things need to happen in. Scoped to the framework-upgrade programme and the test
coverage it depends on.

Backend and cross-service items live in
[DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md); this one is CEE only.

Sibling runbooks:
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — building, running and testing CEE.
- [CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md) — cutting and publishing a version.

Last reviewed against `develop` @ CEE 1.5.2.

---

## Where we are

CEE is on **Angular 14**, which left long-term support in late 2023. The
application code is healthy; the framework and three of its dependencies are
not. Nothing here is urgent in the sense of broken today — it is urgent in the
sense that the cost of the jump grows every release.

| | |
|---|---|
| Angular | 14.3 (EOL) |
| TypeScript | 4.8 |
| rxjs | 6.6.7 |
| Test coverage before this work | 40 spec files, 45 `it()` blocks, all `expect(component).toBeTruthy()` |
| Test coverage now | + 422 domain tests in `harness/` |

## The blocker, stated plainly

`@angular-material-components/datetime-picker` **caps the upgrade at Angular
16**. Its latest release is 16.0.1; Angular is at 22. Upgrading to 16 and
stopping is not a resting place — 16 is itself EOL, so that path buys a second
migration later.

The **usage** is small: three module imports in
`src/app/modules/input-types/input-types.module.ts` and exactly one element,
`<ngx-mat-timepicker>`, in
`src/app/modules/input-types/components/cedar-input-datetime/cedar-input-datetime.component.html`.

The **replacement** is not. See Phase 2 — `@ng-matero/extensions`, the obvious
candidate, cannot express what CEE needs.

### Dependency audit

| Package | Current | Latest | Peers | Verdict |
|---|---|---|---|---|
| `@angular-material-components/datetime-picker` | 8.0.0 | 16.0.1 | Angular 16 only | **Blocker — replace** |
| `@ngx-translate/core` | 11.0.0 | 18.0.0 | Angular ≥18, rxjs ≥7 | API rewrite across 8 majors; 8 files touch it |
| `@ng-select/ng-select` | 9.1.0 | 23.5.1 | Angular 22 | Fine |
| `ngx-mat-select-search` | 4.2.1 | 9.0.0 | Material 17–22 | Fine |

---

## Phases

### Phase 0 — Domain test harness ✅ done

`harness/` — 422 headless tests over template parsing, instance construction,
path resolution, value writes, multi-instance mechanics, controlled-term
constraints and the quality report. Imports no Angular, so it survives the
upgrade unchanged. See [harness/README.md](../../cedar-embeddable-editor/harness/README.md).

Deliberately **not** upgrade insurance: the pure-TypeScript domain layer is the
part least likely to break when the framework moves. This phase buys refactoring
confidence and a characterization baseline.

### Phase 1 — Visual regression baseline ✅ done

`visual/` — 16 Playwright screenshot tests against the **concatenated bundle**
as an embedder consumes it, not the dev server. Five fixtures covering input
types, choice widgets, two-deep multi-instance nesting, controlled terms, and
static content with page breaks; two viewports. Stable across repeated runs
(~5s). See [visual/README.md](../../cedar-embeddable-editor/visual/README.md).

Baselines were captured on Angular 14 **before** any upgrade work, which is the
only moment they are worth capturing.

### Phase 2 — Dependency de-risking ⬅ next, blocked on a decision

#### The time picker: `@ng-matero/extensions` is not a drop-in

An earlier draft of this roadmap called the swap "contained". That was wrong —
it confused *usage count* with *replacement effort*. Investigated against
`@ng-matero/extensions@14.8.5` (which does exist for Angular 14, tagged
`v14-lts`, peering `>=14.0.0`):

| | `ngx-mat-timepicker` (current) | `@ng-matero/extensions` |
|---|---|---|
| Form factor | inline, always-visible spinners | popup attached to an input, plus a toggle |
| Time UI | hh:mm:ss spinner column | clock face |
| 12/24 hour | `enableMeridian` | `twelvehour` ✅ |
| Hour-only precision | `disableMinute` | no equivalent |
| **Seconds** | `showSeconds` | **not supported at all** |

The seconds gap is disqualifying, not cosmetic. Grepping the whole
`mtxDatetimepicker` bundle and its `.d.ts` files for `second` returns only
`secondary` (colour and overlay positioning). CEDAR's temporal granularity runs
`year → month → day → hour → minute → second → decimalSecond`, and CEE supports
the bottom two today —
`cedar-input-datetime.component.ts:114` (`showSeconds`) and `:118`
(`showDecimalSeconds`). Adopting mtx would be a **functional regression against
the CEDAR model**, not a UX change.

Note also that CEE does not use a *datetime* picker at all. The date half is
CEE's own `app-date-picker`; only the time half comes from the dependency.

#### Options

**A. Ride `ngx-mat-timepicker` to Angular 16, then swap.** It supports 14, 15
and 16, so it does not block the first two hops. Defers the problem — and
defers it into the middle of a migration, which is the worst time to be making
a UI decision.

**B. Build an in-house `app-time-picker`. ← recommended.** CEE already owns
`app-date-picker` and `app-timezone-picker`; a time picker would follow the same
pattern and sit beside them. It is the only option that both removes the
dependency permanently and expresses CEDAR's granularity model exactly, because
we would be writing it against that model rather than adapting to someone
else's. Scope is bounded: hour/minute/second number inputs plus a meridian
toggle, driven by the four predicates already in
`cedar-input-datetime.component.ts`. The parsing and storage representation
(`datetimeParsed`) already exist and do not change. Both test suites are now in
place to verify it — `harness/` for the value semantics, `visual/` for the
rendering.

**C. Adopt mtx and accept the regression.** Loses second and decimal-second
precision. Only viable if no CEDAR template in practice uses those
granularities — which should be measured, not assumed, before anyone considers
it.

**This decision gates Phase 3.** Option B is the recommendation; it needs a
sign-off because it is new UI code rather than a dependency bump.

#### Also in this phase

Plan the ngx-translate v11 → v18 rewrite. `forRoot`/loader wiring changed shape
across eight majors; `FallbackTranslateLoader` and its factory will need rework.
Eight files import from `@ngx-translate/*`.

### Phase 3 — Angular upgrade, one major at a time

`ng update` migration schematics chain, so skipping hops means hand-applying
migrations.

| Hop | The work |
|---|---|
| 14 → 15 | **The hard one.** Material MDC migration; run `ng generate @angular/material:mdc-migration`. Expect broad SCSS churn. |
| 15 → 16 | `entryComponents` removed (used in `app.module.prod.ts`), rxjs 6 → 7, TypeScript 5.0 |
| 16 → 17 | New esbuild/vite build pipeline — the web-component concat step in the README changes shape |
| 17 → 22 | Comparatively smooth |

Note `origin/upgrade/angular-15` exists but is a dead stub: 3 commits, last
touched November 2023, branched from an old `main`. Its "Legacy references
removed" commit may be worth skimming for an MDC hit list; it is not a
foundation.

### Phase 4 — Retire the legacy test scaffolding

Delete the 40 `should create` specs and the Protractor e2e setup (Protractor was
deprecated in 2021). They cost maintenance and assert nothing. Do this *after*
Phases 1–3, so nothing is removed while it might still be a signal.

---

## Open findings

### Defects found and fixed

All three were found by the test harness, characterized first so the behaviour
was pinned before anyone changed it, then fixed with the characterization
converted to a regression test. Each was mutation-tested.

1. ~~**A filled required ORCID/ROR field never satisfies its requirement.**~~
   **Fixed.** `extractPlainValue` recognised a bare `@id` only for
   `InputType.link`, so the other seven IRI-valued types read an absent
   `rdfs:label` and counted as empty — a form with a required ORCID could never
   report valid. It now consults `EXTERNAL_AUTHORITY_INPUT_TYPES`, the set
   `DataObjectUtil.getEmptyValueWrapper` already used for the same distinction,
   so the quality report and the instance builder agree. Covered by per-type
   regression tests in `harness/test/cardinality.spec.ts`.

2. ~~**Filling one page of a multi element marks every page satisfied.**~~
   **Fixed**, once the semantic was settled as *at least one instance must
   carry a value*. The real defect turned out to be narrower than first
   described: validity was answered against whichever page `currentIndex`
   pointed at, so the same instance reported valid or invalid depending on
   where the user had paged to. Under at-least-one no per-instance evaluation
   is needed, so the fix did not require touching the shared mutable cursor —
   `DataQualityReportBuilderHandler.findAnyValue` walks the extract instance
   directly instead. The value tree still shows the displayed page; only the
   counters are page-independent.

   Left open deliberately: whether an element with **zero** instances should
   satisfy or violate a requirement. It contributes no requirements today and
   so reports vacuously valid. Characterized in
   `harness/test/cardinality.spec.ts`.

3. ~~**Element visibility depends on the order of its element children.**~~
   **Fixed.** Under `hideEmptyFields`, `hasNonEmptyChild` assigned its
   recursive result for element children without stopping, so the last element
   child decided the outcome and overwrote any earlier `true`. An element
   holding data was reported empty whenever a later sibling element happened to
   be empty, and the section silently vanished from a read-only viewer. Both
   branches now return on the first non-empty child — an inconsistency inside
   one function, since the field branch already did. The change only adds an
   early exit on `true`, so it is monotonic toward visible and cannot hide
   anything that previously rendered. Regression tests in
   `harness/test/read-only.spec.ts` cover both orderings and guard the opposite
   direction.

### Coverage — closed

All 24 of CEE's input types can now be generated by the test harness, up from
19. The five that could not — `ext-pfas`, `ext-pubmed`, `ext-rrid`,
`ext-nih-grant-id`, `ext-doi` — were types CEE rendered but the CEDAR Model
TypeScript Library could not build, so the generative sweep silently skipped
them. All five were added upstream.

`harness/test/coverage.spec.ts` pins the ratio at 1 and keeps its assertions,
so a 25th input type without a matching builder fails the suite — which is how
the original five surfaced.

### ~~Defect: five external-authority fields have unreachable error messages~~ — fixed

`cedar-input-pfas`, `-pmid`, `-rrid`, `-nih-grant` and `-doi` each rendered a
`mat-error` bound to a type-specific key that nothing ever set — copied from
the ORCID/ROR pair without the code that raises it, so those fields accepted
any string while carrying markup implying they validated it.

`CedarValidators` maps `iriMalformed` onto each type's expected key, so the
existing markup came alive rather than being deleted. Regression tests cover
all seven.

### ~~Defect: the add button ignores maxItems when minItems is absent~~ — fixed

`CedarMultiPagerComponent.isEnabledAdd()` guarded on `minItems` while comparing
against `maxItems`, so a field declaring an upper bound without a lower one
never disabled the add button. Now guards on `maxItems`. Cardinality is also
checked by the report, so the bound no longer depends on the button alone.

### ~~Finish the data quality report~~ — done, with two known exclusions

The README described the report's three fields as *"available, with more to
come"*. The more has now come.

The report validated presence and nothing else. Eighteen measured constraint
violations all reported `isValid: true` while sixteen widget components rendered
`mat-error` for the same data — the form said red and the report said fine, at
the same instant, and a host page gating submission on `isValid` accepted
metadata the user could see was wrong.

`FieldValueValidator` now checks every constraint the template declares, the
report carries a `problems` list naming the field and what is wrong with it, and
the widgets call the same function through an Angular adapter. `isValid` means
"nothing required is missing and nothing present is invalid". The two legacy
counters keep their meaning for existing embedders.

Four model gaps had to be closed first: `xsd.model.ts` knew four numeric types
where the model has seven, `numbers.model.ts` had no byte or short bounds,
`ValueInfo` had no slot for `regex` — so the 150 occurrences in the HuBMAP
corpus were read by nothing — and the factory did not extract it.

**Behavioural change worth naming:** `isValid` is stricter, so instances that
previously reported valid may not.

### Where each constraint is enforced

One validator now. `FieldValueValidator` is pure and framework-free;
`CedarValidators.forComponent` adapts it as an Angular `ValidatorFn` for the
widgets, and `DataQualityReportBuilderHandler` calls it directly. The widgets
and the report can no longer disagree, because they ask the same function.

✅ enforced, ✗ not enforced, n/a not applicable.

| Constraint | Widget | Report | Handlers |
|---|---|---|---|
| `requiredValue` | ✅ | ✅ | ✗ |
| `minLength` / `maxLength` | ✅ | ✅ | ✗ |
| `regex` | ✅ | ✅ | ✗ |
| email / link / phone format | ✅ | ✅ | ✗ |
| external-authority IRI well-formedness | ✅ | ✅ | ✗ |
| numeric type pattern, all seven XSD types | ✅ | ✅ | ✗ |
| numeric implicit type bounds (int, long, byte, short) | ✅ | ✅ | ✗ |
| `minValue` / `maxValue` / `decimalPlace` | ✅ | ✅ | ✗ |
| temporal shape vs `temporalType` | ✅ | ✅ | ✗ |
| temporal shape vs `granularity` | ✅ | ✅ | ✗ |
| timezone vs `timezoneEnabled` | ✅ | ✅ | ✗ |
| calendar validity | ✅ | ✅ | ✗ |
| choice membership | ✅ | ✅ | ✗ |
| `minItems` / `maxItems` | ✅ | ✅ | ✅ |
| controlled-term structure (`@id`/`rdfs:label` pair, IRI form) | ✅ | ✅ | ✗ |
| controlled-term **membership** | ✗ | ✗ | ✗ |
| attribute-value name uniqueness | n/a | n/a | auto-corrected |

One cell is not green, deliberately.

**Controlled-term membership** cannot be checked locally. Deciding whether a
term belongs to the declared ontologies, value sets, classes or branches needs
the terminology server, and a local synchronous report that quietly made a
network call — or quietly skipped one — would be worse than one that never
claimed to. A test pins the boundary so it reads as a decision rather than an
oversight. Closing it means an asynchronous validation pass, which is a
different feature.

**The Handlers column** is now green where it should be and empty where it
should be, which took separating two cases that look alike:

- *Value writes stay permissive.* Reaching `10` in a field with `minValue: 10`
  means passing through `1`. Intermediate states are legitimately invalid, and
  a handler that refused them would make the field untypeable. Storing freely
  and judging separately is the right design, not a gap.
- *Structural operations are enforced.* There is no transient state in which an
  element holds more instances than `maxItems` allows, so `addMultiInstance`,
  `copyMultiInstance` and `deleteMultiInstance` refuse to cross a bound and
  return whether the operation happened. Refusal is a no-op plus a trace rather
  than an exception: the pager already disables the control at the bound, so a
  call arriving there is a caller bug, and throwing would take the editor down
  over something recoverable.

**Attribute-value** names are auto-corrected rather than validated: a duplicate
or blank name is silently replaced with `Attribute Value Field<n>`, discarding
what the user typed. Not a validation gap so much as a missing message.

The viewer used to be the weakest path in the system. `DataContext
.setInputTemplate` skipped the quality report in read-only mode, on the
reasoning that nothing can be edited so validity is uninteresting — but
read-only plus `hideEmptyFields` is the viewer configuration, and read-only
also suppresses the widgets' own errors. An injected instance therefore reached
the screen with no validation at any layer. The report is now always built.

### Model conformance — 31 of 37, and why the number exists at all

Everything above validates CEE against CEE. A template is also a JSON Schema
for its own instances, which makes "does CEE emit a valid CEDAR instance" a
question with a mechanical answer — and until August 2026 nobody had asked it.
The answer was **zero of 37**, with 1,488 tests green at the time. Two of those
tests compare CEE's JSON output against its YAML output and find them
equivalent. Self-consistency implies nothing about conformance.

`harness/test/model-conformance.spec.ts` now asks it on every run, and
`harness/test/validator-agreement.spec.ts` checks that our ajv-draft-04 answer
matches `cedar-model-validation-library`'s on its own fixtures — seven that must
pass, nine mutations that must fail, all 17 agreeing. How to run both, and the
canonical Java suite behind them, is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md) → Checking output against the CEDAR model.

Fixed to get from 0 to 31:

- **No CEE instance carried `schema:isBasedOn`** — the one key that says which
  template an instance came from. CEE cannot render a form without the template,
  so it always had the value; it simply never wrote it. Nothing downstream could
  identify a CEE-produced instance.
- **The rest of the envelope was absent, then present as nulls.** `@id` and the
  provenance fields are `["string", "null"]` and may be null; `schema:name` is
  `string` with `minLength: 1` and `schema:description` is `string`, and neither
  may be. Emitting nulls uniformly failed 35 of 37 on those two keys alone.
- **The envelope was only added to freshly-built instances.** An injected one
  skips the builder, so every document loaded from a host page failed against
  its own template. `DataContext.setInputTemplate` now adds it on both paths.

Still failing, four of them real defects:

| Template | What is wrong |
|---|---|
| 001 | Template has no `@id` — its readme says it was never saved — so no instance of it can name it. Not CEE's defect; CEE reports the template on read. |
| 003 | Template is malformed; its schema will not compile. Same template as the crash noted below. |
| 025, 034 | A field marked `_ui.hidden` is dropped from the component tree, so the instance gets no slot for it — while the template still lists it as required. Hiding is a display decision and must not change what the document contains. |
| 028 | A required multi field starts with fewer items than its own `minItems`. |
| 029 | The hidden-field defect, plus a controlled field written as `{"@value": …}` where the schema allows only `@id` and `rdfs:label` — CEE is not recognising it as IRI-valued. |

The hidden-field defect is the one to take first: it accounts for three of the
six, and the fix turns on a single question — whether `_ui.hidden` suppresses
rendering only, or membership in the document. The model says rendering only.

A test asserts the failing set *equals* that list, so a template that starts
conforming fails as loudly as one that stops. The number is a defect count and
should only go down.

### Where the boundaries stand

CEE's three boundaries with the outside world all go through the model library
now. What is left inside is plain objects, deliberately.

| Boundary | Through the library? | Where |
|---|---|---|
| Template in | Yes | `factory/model-library-template-parser.ts`, and `yaml-template-parser.ts` reading the same templates as YAML into the same form |
| Instance in | Yes | `util/instance-deserializer.ts` |
| Instance out | Yes | `util/instance-serializer.ts` — `currentMetadata` and `currentMetadataYaml` are two writers, not two code paths |

**CEE contains no code that writes CEDAR JSON, and none that reads it.** Raw
vocabulary references are down from 156 on `develop` to 80, and the residue is
not what the goal was aimed at: 14 are ORCID/ROR/PubMed *search responses*,
which are not CEDAR artifacts; 11 are the vocabulary definition itself; 16 are
services assembling `{@id, rdfs:label}` pairs from search hits. The remaining
~39 are the internal working tree, which stays plain objects because the
widgets hold references into it and edit in place.

One raw lookup survives in the template read path —
`iriMap[name][JsonSchema.enum][0]` in `model-library-template-parser.ts` —
because the library's `getIRIMap()` returns unparsed JSON rather than a typed
IRI. That is a library gap, not a CEE one.

### Defect: a label with no @id is discarded silently

`{"rdfs:label": "Some Term"}` with no `@id` is not a value node — there is no
term, only text where one should be — and the model library drops it while
parsing, reporting nothing.

This is not new: `currentMetadata` has always serialised through the library,
so the label never reached the instance CEE emitted. What changed when the read
path moved to `CedarReaders` is that CEE no longer *sees* it either, so the
`controlledStructure` diagnostic that used to name the problem is gone. The
field now reads as unfilled, which for a required field is at least an
actionable message and for an optional one is silence.

Worth fixing in the library rather than in CEE: a reader that discards input
should say so. Until then a host page can inject a half-written controlled term
and get it back empty with no explanation. Pinned in
`harness/test/validation.spec.ts` so the behaviour is recorded rather than
assumed.

### Adopt the model library instead of hand-reading JSON

CEE parses template JSON and builds instance JSON by hand — 475 LOC and 77 raw
key lookups for templates, 2,084 LOC and 112 lookups for instances — against its
own copy of the model vocabulary, which the CEDAR Model TypeScript Library
already owns. That duplication is how CEE came to know four numeric types where
the model has seven.

Scoped in [CEE-MODEL-LIBRARY-ADOPTION.md](./CEE-MODEL-LIBRARY-ADOPTION.md).
Template reading is tractable and the library covers every key CEE reads;
instance *writing* is not a refactor at all and should not be scoped as one.

Two findings from the scoping worth acting on independently:

- CEE **crashes on `template-003`** in the shared corpus. Its `_ui.order` names a
  child with no entry in `properties`, and the factory dereferences it unguarded.
  The model library reads the same template without complaint. 36 of the 37
  corpus templates parse; this one hard-fails.
- The harness generates every template it tests with, so CEE has never been run
  against a human-authored one. Closing that gap took a single throwaway test
  and found the crash above.

### Unify the external authority fields

Seven field types — ORCID, ROR, PFAS, PubMed, RRID, NIH Grant, DOI — are
implemented seven times over. They differ in a lookup URL, a label, a logo and
an IRI prefix; the behaviour is the same search-select-resolve flow throughout.

Measured on `develop`:

| | Count | Size |
|---|---|---|
| Input components (ts + html + scss) | 7 | ~1,860 lines |
| Lookup services | 7 | 347 lines |
| REST response model folders | 16 | — |

How close the copies are: `doi-field-data.service.ts` and
`rrid-field-data.service.ts` differ on 33 of ~50 lines, and most of those
differences are a URL and a type name. `cedar-input-pmid` and
`cedar-input-rrid` share 79% of their template verbatim.

The same duplication exists downstream in `cedar-model-typescript-library`,
where each type needs eight near-identical files plus registration in nine
places. Those 56 files were produced by name substitution from the ROR set,
which is about as direct a demonstration as one could ask for that they are a
template rather than seven designs.

A plausible shape:

- One `ExternalAuthorityLookupService` configured by a descriptor
  (`searchUrl`, `detailsUrl`, response mapper) rather than seven services.
- One abstract input component holding the search/select/resolve flow, with
  per-type descriptors supplying label, placeholder, logo and IRI prefix — and
  one shared template, since Angular allows several components to reuse a
  `templateUrl`.
- A generic response model in place of the per-type `*SearchResponse` /
  `*DetailResponse` pairs.

`EXTERNAL_AUTHORITY_INPUT_TYPES` (`models/ext-auth-categories.model.ts`) is
already the canonical list of the seven and would be the natural registry key.

The argument for doing it is stronger than tidiness. The quality-report defect
fixed in Open findings existed precisely because a second place had its own
idea of which fields are IRI-valued instead of consulting that set; seven
parallel implementations are seven opportunities for the same class of drift.
An eighth authority type currently costs eight files here plus eight more in
the model library.

The argument against: the current per-type classes give each field a distinct
TypeScript type. Today those types carry no information beyond an input-type
string, since none of them adds behaviour — but a unified base would give that
up, and it is worth being deliberate about rather than assuming it does not
matter. Do this before adding an eighth type, not after.

### Rebrand: BMIR → Center for Computational Medicine

The group has been renamed. CEE's footer still credits the old name and links
to the old site, in four places:

| What | Where |
|---|---|
| Logo image | `src/assets/images/bmir-logo.png` |
| Logo CSS class | `.bmir-logo`, `static-footer.component.scss` |
| Link and aria-label | `static-footer.component.html:5` — `https://bmir.stanford.edu` |
| Strings | `assets/i18n-cee/en.json` and `hu.json` — `Maintained` ("…Stanford Center for Biomedical Informatics Research.") and the `BMIR` label |

Needs the new logo asset and the new URL before it can be done; the string and
markup changes are trivial once those exist. Both language files must be
updated together, or the Hungarian map silently keeps the old name.

The footer is covered by the visual baseline's `chrome` preset
(`preset-chrome.png`), so this change will show up as a screenshot diff and the
baseline will need re-recording as part of the work — that is the mechanism
working, not a problem.

### Design debt worth paying independently

- **Circular import.** `data-object-util.ts:157` reads one static (`iriPrefix`)
  off the top-level Angular component, dragging the whole component subtree —
  HttpClient services, a `package.json` import, and an edge back into
  `DataObjectUtil` — into anything using the data-object builder. It survives
  only because webpack tolerates it. Moving `iriPrefix` to a constant would
  delete both this and `harness/stubs/editor-component.ts`.
- **Two instance trees, no single source of truth.** Every mutation is written
  separately to `instanceExtractData` and `instanceFullData`;
  `multiInstanceItemAdd` even needs a `deleteContext` between the two passes.
  Divergence is invisible from the UI, because widgets read one tree and the
  host page reads the other. The harness now asserts they agree.
- **Path resolution is not pure.** `getDataObjectNodeByPath` resolves through
  each multi ancestor's `currentIndex`, so it returns different nodes depending
  on which pages the user has flipped to. `HandlerContext` depends on mutating
  data *before* the cursor; nothing in the code says so.

---

## Out of scope

- Rewriting CEE in a different framework. The domain layer is sound and
  framework-independent; the cost is in the widget layer either way.
- Fixing the two characterized defects as part of the upgrade. They are product
  decisions about validity semantics, not migration blockers — decide them
  separately.
- Adding the five missing field-type builders. That belongs in
  `cedar-model-typescript-library`.
