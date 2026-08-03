# CEDAR Embeddable Editor (CEE) — Roadmap

Where **CEE** (`cedar-embeddable-editor`) is, what's blocking it, and the order
things need to happen in. Scoped to the framework-upgrade programme and the test
coverage it depends on.

Backend and cross-service items live in
[DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md); this one is CEE only.

Sibling runbooks:
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — building, running and testing CEE.
- [CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md) — cutting and publishing a version.

Last reviewed against `cee-with-model-library` @ CEE 1.5.2. Note that most of
what is under *Closed* lives on that branch and **not yet on `develop`** — see
decision 2.

---

## Status at a glance

| # | Item | State |
|---|---|---|
| — | **Phase 0** domain test harness | ✅ done — 2,026 tests |
| — | **Phase 1** visual baseline | ✅ done — 88 tests |
| **1** | Sign off the time-picker replacement | ⛔ **needs you** — gates Phases 3 and 4 |
| **2** | Review and merge `cee-with-model-library` | ⛔ **needs you** — everything below is on it |
| 3 | Hidden field dropped from the instance | ✅ done |
| 4 | Required multi field below its `minItems` | ✅ done |
| 5 | Controlled field written as `@value` | ✅ done — template's defect, not CEE's |
| 6 | Label with no `@id` discarded silently | ✅ done — library + CEE |
| 7 | `getIRIMap` returned unparsed JSON | ✅ done — library |
| **8** | Zero-instance element satisfying a requirement | ❓ **needs a decision** — semantics |
| 9 | Attribute names auto-corrected silently | ✅ done |
| 10 | Visual-suite flake | ⚠️ likely cause addressed, unproven |
| 11 | Unify the seven authority fields | ✅ done — −2,025 lines |
| 12 | Domain → component import cycle | ✅ done |
| 13 | Two instance trees in parallel | ✅ done — not a single source of truth; see entry |
| 14 | Path resolution not pure | ✅ done — no behaviour change |
| 15 | Rebrand BMIR → CCM | ⬜ chore |
| 16 | Delete legacy test scaffolding | ⬜ chore — Phase 4, deliberately last |
| — | **Phase 2** dependency de-risking | ⬅ blocked on decision 1 |
| — | **Phase 3** Angular 14 → 22 | ⬜ blocked on decision 1 |

Conformance: **34 of 37** corpus instances validate against their own template,
up from 0. The three that do not are defects in the templates.

Two decisions are the whole critical path. Nothing in the list above is waiting
on anything else.

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
| Test coverage now | 2,026 domain tests in `harness/`, 88 browser tests in `visual/` |

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

`harness/` — 2,026 headless tests across 30 files, over template parsing,
instance reading and writing, path resolution, value writes, multi-instance
mechanics, controlled-term constraints, the quality report, and conformance to
the CEDAR model. Imports no Angular, so it survives the upgrade unchanged. See
[harness/README.md](../../cedar-embeddable-editor/harness/README.md).

Grew from 422 during the model-library adoption below, which is where most of
the defects listed under *Closed* were caught.

Deliberately **not** upgrade insurance: the pure-TypeScript domain layer is the
part least likely to break when the framework moves. This phase buys refactoring
confidence and a characterization baseline.

### Phase 1 — Visual regression baseline ✅ done

`visual/` — 88 Playwright tests against the **concatenated bundle** as an
embedder consumes it, not the dev server. Eight fixtures covering input types,
choice widgets, two-deep multi-instance nesting, controlled terms, static
content with page breaks, validation states, the timezone picker and all seven
external authority widgets; two viewports. Runs in ~35s. See
[visual/README.md](../../cedar-embeddable-editor/visual/README.md).

Not only screenshots any more. The authority-widget tests assert behaviour —
that a keystroke raises no error, that free text is discarded on blur — because
that is a class of defect the domain harness cannot see and a screenshot would
not describe.

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

## What needs doing

Numbered so they can be referred to in conversation and in commits. Roughly in
the order to take them: the two decisions gate everything else, and nothing
below them is blocked by anything above except where it says so.

Reference material — how conformance is measured, where each constraint is
enforced, what the boundaries look like — is under *Reference*. Everything
already closed is under *Closed*, kept because several entries record a wrong
turn worth not repeating.

### Decisions — these block other work

**1. Sign off the time picker replacement.** *Blocks Phases 3 and 4, i.e. the
entire Angular upgrade.* `@angular-material-components/datetime-picker` caps CEE
at Angular 16, and the obvious replacement cannot express seconds or
decimal-seconds, which CEDAR's granularity model requires. Recommendation is
Option B, build `app-time-picker` in-house — see *Phase 2* above for the
comparison and the reasoning. This needs a human decision because it is new UI
code rather than a dependency bump; it has been the only thing standing between
here and Phase 3 for some time.

**2. Review and merge `cee-with-model-library`.** *Blocks nothing technically;
blocks everything practically*, since the branch now carries the model-library
adoption, the conformance suite and ~24 defect fixes. Held for colleague
clearance. The longer it sits, the more the rebase costs.

### The remaining question

**8. Should an element with zero instances satisfy a requirement?**
*A decision, not a defect.* It contributes no requirements today, so it reports
valid — vacuously. Characterised in `harness/test/cardinality.spec.ts` so the
behaviour is recorded whichever way it goes, but which way it *should* go is a
question about what CEDAR means by required, and that is not ours to settle
unilaterally.

Everything else that was on this list is under *Closed*: items 3–7 and 9–14.
Conformance is 34 of 37, and all three remaining failures are defects in the
corpus templates rather than in CEE.

### Chores

**15. Rebrand BMIR → Center for Computational Medicine.** Four places in the
footer, listed under *Rebrand* below.

**16. Delete the legacy test scaffolding.** Phase 4 — 40 `should create` specs
and the Protractor setup. Deliberately last, so nothing is removed while it
might still be a signal.

---

## Reference

Not action items. How the numbers above are arrived at, and what the current
state is measured against.

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

### Model conformance — 34 of 37, and why the number exists at all

Everything else validates CEE against CEE. A template is also a JSON Schema for
its own instances, which makes "does CEE emit a valid CEDAR instance" a question
with a mechanical answer — and until August 2026 nobody had asked it. The answer
was **zero of 37**, with 1,488 tests green at the time. Two of those tests compare
CEE's JSON output against its YAML output and find them equivalent.
Self-consistency implies nothing about conformance.

`harness/test/model-conformance.spec.ts` now asks it on every run, and
`harness/test/validator-agreement.spec.ts` checks that our ajv-draft-04 answer
matches `cedar-model-validation-library`'s on its own fixtures — seven that must
pass, nine mutations that must fail, all 17 agreeing. How to run both, and the
canonical Java suite behind them, is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md) → Checking output against the CEDAR model.

0 → 31 came from the envelope: no instance carried `schema:isBasedOn` at all,
the rest of the envelope was absent and then present as nulls (`schema:name` is
`string` with `minLength: 1` and may not be null), and it was only added to
freshly-built instances, so every document loaded from a host page failed against
its own template.

31 → 34 came from two builder defects, both of which made a *fresh* instance
invalid on creation:

- A field marked `_ui.hidden` was dropped from the component tree, so the
  instance got no slot for it while the template still listed it as required.
  Templates 025 and 034, and half of 029.
- A multi choice field with no default selection threw away its own `minItems`
  skeleton, so a required checkbox group came out as `[]`. Template 028.

**The three that remain are defects in the templates, not in CEE**, which the
number should say plainly rather than leave to be assumed:

| Template | What is wrong |
|---|---|
| 001 | No `@id` — its readme says it was never saved — so no instance of it can name it. CEE reports the template on read. |
| 003 | `_ui.order` names a child `properties` does not define. Its schema will not compile. |
| 029 | Contradicts itself. Four fields declare `_ui.inputType: list` with plain `literals`, and declare their instance schema as `{@type, @id, rdfs:label}` with `additionalProperties: false` — so each offers only literals to choose from and permits only an IRI to be stored. No instance can satisfy them. |

That last one was recorded for a while as CEE writing the wrong thing.
`harness/test/template-consistency.spec.ts` establishes otherwise: every other
list, radio and checkbox field with literals across the 37 templates permits
`@value`, these four are the only ones that do not, the canonical
`literal-field-meta-schema.json` permits it, and the fields offer no IRI-valued
source for the `@id` their own schema demands.

A test asserts the failing set *equals* that list, so a template that starts
conforming fails as loudly as one that stops.

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

Nothing outstanding here. The three entries this section carried — the circular
import via `iriPrefix`, the two instance trees maintained in parallel, and
cursor-dependent path resolution — are all under *Closed*.

---

## Closed

Kept rather than deleted. Several record a wrong turn, and the wrong turns are
the part worth not repeating.

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

### ~~Defect: five external-authority fields have unreachable error messages~~ — fixed, after one wrong attempt

`cedar-input-pfas`, `-pmid`, `-rrid`, `-nih-grant` and `-doi` each rendered a
`mat-error` bound to a type-specific key that nothing ever set — copied from
the ORCID/ROR pair without the code that raises it, so those fields accepted
any string while carrying markup implying they validated it.

**The first fix was wrong and shipped.** Mapping `iriMalformed` onto each
type's key and wiring `CedarValidators.forComponent` into the widgets brought
the markup alive at the wrong moment: these controls hold *search text*, not
the value — after a selection, `"Label - https://iri"` — so no intermediate
state can be a well-formed IRI and the field said "not a valid RRID and has
been cleared" on the first keystroke, over a field that had not been cleared.
Reported from a deployment.

Verifying the removal found the larger defect the dead markup had been hiding:
**six of the seven widgets left free text in the box on blur**, over an
instance holding nothing, so the field looked filled and read back blank. Only
ORCID reconciled. ROR carried the same machinery but its template never bound
a blur event; the five simplest had no blur handler at all.

All six now reconcile through `util/authority-search-control.ts` — one rule
rather than six copies, because the drift between copies is what hid this. The
stored IRI is still validated, by the data quality report, which sees the value
rather than the search text.

Two testing gaps closed with it:

- **The visual suite served a stale bundle.** It serves `visual/public/`, a
  copy of `dist/` that `ng build` does not refresh, so it ran green against
  whatever was copied last — and this fix was briefly believed not to work on
  the strength of such a run. `visual/check-bundle-fresh.mjs` now fails the run
  when `dist/` is newer.
- **No fixture carried more than two authority types.** `04-controlled-terms`
  has ORCID and ROR; the other five are copies that had drifted. The new
  `08-authority` fixture carries all seven, parameterised so an eighth type
  costs one line.

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

### ~~Adopt the model library instead of hand-reading JSON~~ — done, on `cee-with-model-library`

CEE parsed template JSON and built instance JSON by hand — 475 LOC and 77 raw
key lookups for templates, 2,084 LOC and 112 lookups for instances — against its
own copy of the model vocabulary that the CEDAR Model TypeScript Library already
owned. That duplication is how CEE came to know four numeric types where the
model has seven.

All three boundaries now go through the library; see *Where the boundaries
stand* above for the accounting. Originally scoped in
[CEE-MODEL-LIBRARY-ADOPTION.md](./CEE-MODEL-LIBRARY-ADOPTION.md), which called
instance *writing* "not a refactor at all and should not be scoped as one" —
correct as a warning, wrong as a limit. It was done by replacing the emitter
rather than converting it: CEE builds a working tree and the library serialises
it, so `currentMetadataYaml` is a second writer rather than a second code path.

The method that made it safe, worth reusing: keep both implementations behind a
seam, run the *entire* suite against each, and delete the old one only once they
agree across the corpus. Most of the defects under *Closed* were found that
way rather than by reading code.

Both findings from the scoping are closed:

- ~~CEE **crashes on `template-003`**~~ — the `_ui.order` names a child with no
  entry in `properties`, which the hand-written factory dereferenced unguarded.
  The library-backed parser reads it, and `corpus.spec.ts` pins that. All 37
  corpus templates now parse.
- ~~The harness only ever fed CEE templates it generated itself~~ — the shared
  corpus is now part of the suite, which is what makes the conformance and
  format-independence numbers mean anything. It found the crash above within one
  throwaway test.

### ~~Overnight batch: items 3, 4, 5, 6, 7, 9, 10, 12~~ — done

Worked in one unattended stretch, each committed separately with its own tests.

- **3. A hidden field was dropped from the instance.** `_ui.hidden` removed the
  child from the component tree, so the instance got no slot for a property the
  template still required. The child is now kept and flagged. `hiddenInTemplate`
  is a second flag rather than a reuse of `hidden`, because `hidden` is also
  written by two empty-field passes and sharing one boolean would let the viewer
  reveal what the template concealed.
- **4. A choice field threw away its own `minItems`.** The builder filled the
  skeleton and then replaced it with the set of default selections, which for a
  field with no defaults is empty. Now pads instead of replacing.
- **5. Template 029 contradicts itself.** Reclassified, not fixed — see the
  conformance table above. CEE was right.
- **6. A label with no `@id` was discarded silently.** Correct to read as empty;
  wrong to do it without saying so. `InstanceDataEmptyAtom` now carries what the
  library dropped, and CEE reports the field and its content.
- **7. `getIRIMap` returned unparsed JSON.** `getChildIriMap` added upstream.
  CEE now has **no raw CEDAR key lookups in any read path**, and
  `shared/factory` references the vocabulary constants nowhere at all.
- **9. Attribute names were auto-corrected in silence.** A duplicate is now
  reported; a *blank* one deliberately is not, since the widget calls through on
  every keystroke and empty is the state of every attribute at birth.
- **10. The visual flake.** A likely mechanism found and addressed — the dev
  server sends no `Cache-Control`, so a browser may reuse a cached bundle
  heuristically and a run straight after a re-bundle can render the previous
  build. The bundle is now fetched at a URL keyed to its mtime. **Not proven to
  be the cause**: 20 runs with `--retries=0` did not reproduce the failure before
  or after. The retry stays; `npm run flake-hunt` makes the next occurrence
  chaseable.
- **12. The domain → editor component cycle.** `iriPrefix` moved to a module
  that imports nothing. `harness/stubs/editor-component.ts` deleted, and
  `import-boundaries.spec.ts` guards the direction — verified to fail when the
  import is put back.
- **The two trees disagreed about their own shape.** `addRandomAtId` ignored the
  building mode, so a freshly built extract carried element `@id`s and a loaded
  one did not. Every consumer saw a different shape depending on how the user
  arrived. Now minted only into the full tree. The rest of item 13 followed
  later; see *Two instance trees maintained in parallel*.

Two things went wrong along the way and are recorded because the pattern
repeats:

- I "fixed" the YAML writer to preserve `minItems` on an always-multiple field,
  then checked the Java artifact library and found it omits the bound too. The
  reference YAML is canonical, so the change would have made the two libraries
  disagree — reverted, and the harness now forgives that one format limitation at
  any depth instead. This is the third time a plausible library fix has turned
  out to be Java-sanctioned behaviour; **check the Java output first.**
- The first version of the cache-buster resolved a path with `__dirname`, which
  does not exist in that ESM package, and a `try/catch` turned the failure into a
  constant. It passed 86 tests while doing nothing. A test now asserts the
  versioned URL is what actually gets fetched.

### ~~Unify the seven external authority fields~~ — done

**Net 2,025 deletions against 204 insertions.** Seven lookup services, fourteen
response-model files, seven components and fourteen blocks of config wiring, all
saying one thing seven times — the later ones produced from the ROR pair by name
substitution.

- `AuthorityDescriptor`, one per authority: identifier pattern, error key,
  message keys, and the config keys and default paths for its two endpoints.
  `EXTERNAL_AUTHORITY_INPUT_TYPES` was already the canonical list, so it is the
  registry key, and a test asserts the descriptors cover exactly it.
- `ExternalAuthorityLookupService` replaces seven services. `resolve` is generic
  in the document returned, so ORCID and ROR name their own record types instead
  of casting.
- One `AbstractAuthorityInputComponent` and one shared template — Angular lets
  several components reuse a `templateUrl` — so five widgets are ~40 lines each
  and say only which authority they are.
- The editor component's fourteen config blocks became one loop.

**ORCID and ROR keep their own components and templates.** Each renders a panel
from a detail document with its own shape — a researcher record; an organisation
record with geonames and relationships — and that panel is the one thing about
them that is genuinely theirs. They take their identifier pattern and message
keys from the shared descriptor, because those are the parts that had drifted.

Two things worth keeping from how it went:

- **Patterns were transcribed verbatim first, including one that was wrong**, so
  the unification commit is provably behaviour-preserving and the fix is a commit
  of its own. Halfway through I had written five of the seven patterns from
  memory rather than reading them; the tests were written to catch exactly that
  and did.
- **The refactor found a defect.** PubMed carried PFAS's identifier pattern
  verbatim — the file was copied and the line never changed — so a PubMed field
  treated `DTXSID…` as something to resolve and a PubMed ID as a name to search
  for. Invisible unless you diff two files nobody had reason to diff. Putting the
  seven side by side made it obvious in seconds. That is the argument for having
  done this, found by doing it.

Safe to attempt only because of the 21 browser tests across all seven widgets
added the night before: 2,006 domain tests, 88 visual, and the `08-authority`
screenshots unchanged, so the five rewritten widgets render identically.

### ~~Two instance trees maintained in parallel~~ — done

Every mutation was applied to both trees by making the same call twice with a
different first argument, eleven pairs across two handlers. Forgetting the second
was a one-line mistake nothing would catch, and the *difference* between the
trees — the building mode, which is why the full copy carries an `@context` and
an `@id` — was passed separately at each site, from memory. It was got wrong at
one of them.

`DataContext.applyToBothTrees` takes one mutation and hands each tree its own
building mode, so the mode arrives with the tree it belongs to. No handler now
mentions either tree by name.

`tree-consistency.spec.ts` asserts two independent things after each of ten kinds
of mutation: that the trees agree with the envelope stripped, and that the extract
carries no envelope keys at all. Both are needed — mutation testing showed that
stripping before comparing catches a *missed* write but cannot catch a write that
put the envelope *into* the extract, because stripping hides that on both sides.

**Not a single source of truth, and worth being clear about why.** The full copy
carries information the extract does not — minted `@id`s, provenance from an
injected instance — so it cannot be derived from the extract. And the extract
cannot be derived on demand from the full copy either, because the widgets hold
live references into it and mutate in place. Both trees remain; what changed is
that they are maintained together rather than in parallel, and a divergence is
now something a test notices.

### ~~Path resolution is not pure~~ — done

`getDataPathNodeRecursively` chose which occurrence of each multi ancestor to
descend into by reading that ancestor's `currentIndex`. So a component path
identified a node *per cursor position* rather than a node, and every caller was
order-dependent on a mutation nothing documented.

The choice is now an `OccurrenceSelector`, with two:

- `fromCursor` — the historical behaviour, still what `getDataObjectNodeByPath`
  does, because acting on the visible form is what the widgets and the pager
  want. Named, so a caller depending on the cursor does so visibly.
- `at([...])` — specific occurrences, outermost multi ancestor first. Same walk,
  same node, whatever the user has since paged to.

Outermost-first rather than a single index because with nesting "which
occurrence" is not one number: an inner element's occurrences live inside the
outer element's chosen one. The characterisation tests written beforehand
established that, which is why the signature was right first time.

No behaviour changed — every existing caller keeps the cursor behaviour it had.
A hidden dependency became an explicit one, and callers wanting determinism can
now ask for it. Verified by making `at` ignore its indices: seven tests fail.

---

## Out of scope

- Rewriting CEE in a different framework. The domain layer is sound and
  framework-independent; the cost is in the widget layer either way.
- Fixing the two characterized defects as part of the upgrade. They are product
  decisions about validity semantics, not migration blockers — decide them
  separately.
- Adding the five missing field-type builders. That belongs in
  `cedar-model-typescript-library`.
