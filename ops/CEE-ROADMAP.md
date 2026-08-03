# CEDAR Embeddable Editor (CEE) — Roadmap

Where **CEE** (`cedar-embeddable-editor`) is, what's blocking it, and the order
things need to happen in. Scoped to the framework-upgrade programme and the test
coverage it depends on.

Backend and cross-service items live in
[DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md); this one is CEE only.

Sibling runbooks:
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — building, running and testing CEE.
- [CEE-RELEASE-RUNBOOK.md](./CEE-RELEASE-RUNBOOK.md) — cutting and publishing a version.

Last reviewed against `cee-with-model-library` @ CEE 1.5.2 — an experimental
branch, where most of what is under *Closed* lives. It is not on `develop`.

---

## Status at a glance

Outstanding work only — finished items are under *Closed*, with their reasoning
and any wrong turns.

| # | Item | State |
|---|---|---|
| **1** | Zero-instance element satisfying a requirement | ❓ **needs a decision** — semantics |
| 2 | Full-page baselines can't see a widget-sized change | ⬜ do before Phase 3 — 9 fixtures, same 1% blind spot |
| — | **Phase 3** Angular 14 → 22 | ⬅ **next, and no longer blocked** |
| — | **Phase 4** delete the legacy test scaffolding | ⬜ after Phase 3 — 40 stub specs, Protractor |

Numbered 1–2; entries under *Closed* keep the numbers they carried at the time.

`cee-with-model-library` is an **experiment**, not work pending a merge. All the
closed work below lives on it.

Conformance: **34 of 37** corpus instances validate against their own template,
up from 0; the three that do not are defects in the templates. Coverage: 2,113
domain tests, 128 browser tests.

**Phase 2 is complete and Phase 3 is unblocked.** The time picker was the only
dependency with no upgrade path; `@ng-select/ng-select` and
`ngx-mat-select-search` both cap the *installed* versions rather than the
packages, so they are bumps during the migration rather than blockers.

Nothing on the list above blocks Phase 3, and only item 1 needs you.

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
| Test coverage now | 2,113 domain tests in `harness/`, 128 browser tests in `visual/` |

## The blocker, removed

`@angular-material-components/datetime-picker` **capped the upgrade at Angular
16** — its latest release is 16.0.1, and 16 is itself EOL, so that path bought a
second migration later.

**It is gone.** CEE used one element from it, and that element is now
`app-time-picker`, written in-house against CEDAR's granularity model. Removed
from `package.json` and the lockfile, pruned from `node_modules`, and the app
rebuilt with it physically absent. See *Closed*.

What follows is kept because it is the record of why the replacement is in-house
rather than another dependency.

The **usage** is small: three module imports in
`src/app/modules/input-types/input-types.module.ts` and exactly one element,
`<ngx-mat-timepicker>`, in
`src/app/modules/input-types/components/cedar-input-datetime/cedar-input-datetime.component.html`.

The **replacement** is not. See Phase 2 — `@ng-matero/extensions`, the obvious
candidate, cannot express what CEE needs.

### Dependency audit

| Package | Current | Latest | Peers | Verdict |
|---|---|---|---|---|
| ~~`@angular-material-components/datetime-picker`~~ | — | — | — | **Removed** — replaced by `app-time-picker` |
| `@ngx-translate/core` | 11.0.0 | 18.0.0 | Angular ≥18, rxjs ≥7 | API rewrite across 8 majors; 8 files touch it |
| `@ng-select/ng-select` | 9.1.0 | 23.5.1 | Angular 22 | Fine |
| `ngx-mat-select-search` | 4.2.1 | 9.0.0 | Material 17–22 | Fine |

---

## Phases

### Phase 0 — Domain test harness ✅ done

`harness/` — 2,113 headless tests across 33 files, over template parsing,
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

`visual/` — 124 Playwright tests against the **concatenated bundle** as an
embedder consumes it, not the dev server. Nine fixtures covering input types,
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

### Phase 2 — Dependency de-risking ✅ done

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
precision. Was written as "only viable if no CEDAR template in practice uses
those granularities — which should be measured, not assumed".

**Measured, across both corpora, de-duplicating the generated variants of each
case:**

| Granularity | Distinct templates |
|---|---|
| `day` | 9 |
| `second` | **4** — `template-010`, `template-035`, `SimpleTemplate`, `lib:template-010` |
| `decimalSecond` | **3** — `template-010`, `SimpleTemplate`, `lib:template-010` |
| `year` | 3 |
| `month` / `hour` / `minute` | 1 each |

Second-precision is the *second most used* granularity after `day`, ahead of
`year`. `SimpleTemplate` in the artifact library has four such fields and names
them `(hh:mm:ss)` and `(hh:mm:ss, seconds)`, so the precision is the point of the
field rather than an accident of authoring.

**Option C is therefore off the table**, not on a judgement call but on a count.

**This decision gates Phase 3.** Option B is the recommendation; it needs a
sign-off because it is new UI code rather than a dependency bump.

#### Also in this phase

Plan the ngx-translate v11 → v18 rewrite. `forRoot`/loader wiring changed shape
across eight majors; `FallbackTranslateLoader` and its factory will need rework.
Eight files import from `@ngx-translate/*`.

### Phase 3 — Angular upgrade, one major at a time ⬅ next

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

### The decision that blocks everything

**1. Sign off the time picker replacement.** *Blocks Phases 3 and 4, i.e. the
entire Angular upgrade.* `@angular-material-components/datetime-picker` caps CEE
at Angular 16, and the obvious replacement cannot express seconds or
decimal-seconds, which CEDAR's granularity model requires. Recommendation is
Option B, build `app-time-picker` in-house — see *Phase 2* above for the
comparison and the reasoning. This needs a human decision because it is new UI
code rather than a dependency bump; it has been the only thing standing between
here and Phase 3 for some time.

### The remaining question

**2. Should an element with zero instances satisfy a requirement?**
*A decision, not a defect.* It contributes no requirements today, so it reports
valid — vacuously. Characterised in `harness/test/cardinality.spec.ts` so the
behaviour is recorded whichever way it goes, but which way it *should* go is a
question about what CEDAR means by required, and that is not ours to settle
unilaterally.

Everything else that was on this list is under *Closed*, under the numbers it
had at the time. Conformance is 34 of 37, and all three remaining failures are defects in the
corpus templates rather than in CEE.

### 2. Full-page baselines cannot see a widget-sized change

Found by the footer rebrand, which passed `preset-chrome` with a new logo, a new
organisation name and a new link: 0.708% of the desktop page and 0.897% of the
narrow one, against a `maxDiffPixelRatio` of 1%. The footer is now covered by a
clipped screenshot plus text assertions, but **the nine full-page fixture
baselines have the same property** — any single widget is well under 1% of any of
them, so a widget-level regression in `01-input-types` or `04-controlled-terms`
would read as green.

Worth doing **before** Phase 3, because the migration is when those baselines get
leaned on hardest and a Material DOM rewrite is exactly the change that will move
some widgets and not others. Lowering the ratio globally is the wrong fix — it is
there to absorb cross-machine font rasterisation. The shape that works is the one
`pager.png` and `footer.png` already use: clip to the element, and assert in text
whatever is a string rather than a picture.

Not yet sized. The first question is which regions are worth their own clip,
which is a judgement about what each fixture exists to protect.

### Chores

Deleting the legacy test scaffolding is Phase 4's whole content — 40
`should create` specs and the Protractor setup — so it is tracked as the phase
rather than duplicated as a chore.

---

## Reference

Not action items. How the numbers above are arrived at, and what the current
state is measured against.

### Where the boundaries stand

Every point at which CEE touches a CEDAR document goes through the model library.

| Boundary | Where |
|---|---|
| Template in, JSON | `factory/model-library-template-parser.ts` |
| Template in, YAML | `factory/yaml-template-parser.ts` — four lines of logic, which is the proof the reader is not JSON-flavoured |
| Instance in | `util/instance-deserializer.ts` |
| Instance out, JSON and YAML | `util/instance-serializer.ts` — `currentMetadata` and `currentMetadataYaml` are two writers, not two code paths |

**CEE contains no code that reads or writes CEDAR JSON by hand**, and that is now
true without an asterisk. It took closing two small gaps that had been left as
"internal": the *empty* value slots were hand-built while the filled ones already
went through the library, and `SampleTemplatesService` reached for `schema:name`
in a fetched template to label a menu entry — the only place outside the four
rows above that opened a document itself.

CEE also no longer *defines* the vocabulary. Its own `JsonSchema` and
`CedarModel` are deleted; all eleven importers take the library's.

Raw vocabulary references: **156 on `develop` → 44**, and the residue is not what
the goal was aimed at:

| Count | Where | What |
|---|---|---|
| 36 | `handler/` | The internal working tree |
| 4 | `models/rest/` | ORCID and ROR *search responses* — not CEDAR artifacts |
| 4 | `service/` | Assembling `{@id, rdfs:label}` for a widget from a search hit |

`components/`, `validation/` and `factory/` are at zero. The `factory/` mention is
inside a comment.

**The 36 in `handler/` are a deliberate non-goal, not a loose end.** That tree is
plain objects because the widgets hold live references into it and edit in place,
so converting it means changing the contract between the widget layer and the
domain layer across roughly thirty components. Three reasons to leave it:

- Material 15's MDC migration rewrites the DOM and CSS class names of every one
  of those components. Rewriting the data contract in files about to be rewritten
  for unrelated reasons means reviewing both changes tangled together.
- The visual baseline is the safety net *for* that migration, and it is only
  trustworthy if behaviour is held still while rendering changes. Changing both
  at once removes the fixed point.
- The value is lower than it looks. That tree never leaves CEE — `currentMetadata`
  reads it with the library and writes it with the library — so what a host page
  receives is already model-produced. What is left to gain is internal
  consistency, not correctness of output.

It also gets cheaper by waiting: the widget layer is already smaller than it was
(two of the seven authority widgets collapsed into one component, the datetime
widget lost its read-only branch), and Phase 3 will consolidate more. Revisit
after the upgrade, if at all.

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

### ~~Two instance trees maintained in parallel~~ — done, and then done properly

CEE kept the instance twice: `instanceFullData`, the artifact with its envelope,
and `instanceExtractData`, the same content with the envelope left off. Every
mutation wrote to both by making the same call twice, eleven pairs across two
handlers, and the two diverged three times that were found — each invisible until
something was emitted, because that was the only moment they were compared.

**The first attempt made the dual write a single operation and stopped there**,
on the reasoning that neither tree could be derived from the other: the full copy
carries minted `@id`s and injected provenance the extract does not, and the
extract could not be recomputed on demand because the widgets hold live
references into it. That reasoning was recorded here as a conclusion. It was
wrong, and being told so was fair.

**The extract tree was not needed at all.** Everything that reads an instance
either navigates by *component path* — and no envelope key is a component name,
so the envelope is never visited — or goes through the model library's parsed
container, which excludes the envelope by construction. The one walk that
enumerates raw keys is the one re-minting element `@id`s on copy, and that wants
to see them. The second tree existed to spare consumers a problem none of them
had.

So there is one tree. `instanceExtractData` is a lazily derived, cached view,
produced by `InstanceDeserializer` — the same library code that projects one at
the read boundary, not a second definition of "without the envelope". It exists
because two things want that view and only read it: the quality report hands one
to the host page, and the source panel displays one.

`DataContext.mutate` replaces the paired write: one call, no building mode, and
it drops the cache so nothing has to remember to. `buildNewExtractDataObject` is
deleted. Cost measured before trusting it — 0.05ms per derivation on the largest
HuBMAP template, once per report build.

Collapsing it immediately found the third divergence, which the paired-write
approach had left in place: the builder omitted a numeric value's `@type` from
the extract while the reader included it. The fresh-versus-loaded test had missed
it because its fixture had no numeric field; it has one now.

The lesson worth keeping: "these two things must be kept in sync" is worth
one more question — *does the second one need to exist?* Twice here the answer
was no, and both times the sync machinery was built first.

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

### ~~Duplicated CEDAR vocabulary~~ — done

`JsonSchema` and `CedarModel` existed twice, once in CEE and once in
`cedar-model-typescript-library`, which exports both: 55 constants defined in two
places. No values had drifted — checked before deleting — and CEE's were strict
subsets, so the only reason they existed is that they predate CEE using the
library at all. CEE's are gone.

Three of the four CEE-only additions were dead code. The fourth is now
`CedarModel.propertyIriPrefix` upstream, where the library had the same string
hardcoded as a literal *and* commented out as a constant.

### Other copies looked at and left alone

- **`InputType` (CEE) vs the library's field types.** Not a duplicate. CEE's
  `controlled` is its own pseudo-type — the template says `textfield`, and the
  presence of ontologies is what makes it a controlled term — so this is a view
  the parser maps onto, not a second copy of the model.
- **`Xsd` (CEE).** Ten numeric and temporal type IRIs, which the library splits
  across `NumberType`, temporal types and `XsdDatatype`. A partial overlap rather
  than a duplicate; consolidating it means picking apart three library types for
  little gain.
- **`Numbers` (CEE).** Validation patterns and integer bounds. The library has no
  equivalent — this is CEE's own.
- **The component tree vs the parsed `Template`.** CEE builds its own tree from
  the library's model. That is a legitimate derived view, rebuilt on every parse,
  not a maintained copy.
- **The quality report's `valueTree`.** Also derived, rebuilt on every report.

### ~~The time picker capped the upgrade~~ — replaced, in-house

`@angular-material-components/datetime-picker` peered Angular 16 and nothing
later. CEE used one element from it, and that element held the whole framework
upgrade at a version already end-of-life.

`@ng-matero/extensions`, the obvious replacement, supports no seconds — a
functional regression against the CEDAR model rather than a UX difference.
Measuring both corpora settled how much of one: second-precision is the second
most used temporal granularity after `day`, ahead of `year`. `SimpleTemplate` in
the artifact library has four such fields and names them `(hh:mm:ss)` and
`(hh:mm:ss, seconds)`, so the precision is the field's purpose.

So `app-time-picker`, beside `app-date-picker` and `app-timezone-picker`, written
against CEDAR's granularity model rather than adapted to someone else's. It
implements `ControlValueAccessor`, so the widget above binds a `Date` through
`[(ngModel)]` exactly as before — swapping it in changed one element and no
logic. The read-only branch that used to live in the datetime template went with
it, so one place decides what a read-only time looks like.

The 12-hour conversion lives in `util/clock-time.ts`, apart from the component and
unit-tested, because CEDAR stores `HH:mm:ss` on a 24-hour clock whatever the field
displays — an off-by-twelve writes the wrong instant and both values look
well-formed. 33 tests, including a round trip through every hour.

New `09-temporal` fixture covers all eight granularities and both time formats.
Before it the only temporal field under test was minute-granularity, so the
seconds boxes and the 12-hour face were rendered by nothing.

Two things worth keeping:

- **Mutation testing caught a hole in the new tests themselves.** Breaking
  `12 PM → 12` failed the unit tests and passed all fifteen browser tests, because
  the cases were 2 PM and 12 AM and neither exercises noon. 2 PM survives most
  off-by-twelve bugs; noon survives none.
- **Aligning the colons took three attempts,** and the simplest won. A chrome-less
  `mat-form-field` holding one collapsed its input to zero width — positioned
  perfectly, invisible. A `matSuffix` aligned exactly but put the colon inside the
  preceding box. The plain version needs a number matched to Material's geometry,
  which the MDC migration will change, so it is tested rather than trusted.

Dependency removed from `package.json` and the lockfile, pruned from
`node_modules`, and the app rebuilt with it physically absent.

### ~~The occurrence count was cached, not derived~~ — done

`MultiInstanceObjectInfo.currentCount` is how many occurrences a multi component
has, which is also `instance[path].length`. It was stored and kept in step by
hand — incremented on add and copy, decremented on delete, beside the splice into
the instance itself. The same shape as the two instance trees, and the same
question: does the second copy need to exist?

It does not. `currentCount` is now a getter reading the live instance through a
resolver `HandlerContext` installs, so it cannot drift from the document it
describes, and add/copy/delete no longer maintain it. `currentIndex` next to it
*is* genuinely UI state — which page the user is on exists nowhere else — and
stays stored.

Two things made it safe rather than lucky:

- **The ordering was already right.** All three structural operations mutate the
  instance and *then* the info tree, so a derived count is correct by the time
  anything reads it. That was checked before the change, not after.
- **No cycle.** Resolving a path reads each multi ancestor's `currentIndex`,
  never its count.

It found a consistency bug on the way. An element that is *absent* and one whose
array is *empty* say the same thing, and were reported differently: `absent`
counted three unfilled required fields, because the count came from the template's
`minItems` rather than the document, while `empty` counted none. Both now report
what is actually true — a `minItems` violation — which is the more precise
complaint, since the problem is not an unfilled field but a missing element.

Verified by making `currentCount` ignore its supplier: 24 tests fail.

### ~~The visual-suite flake~~ — closed, on evidence

Two runs in roughly a dozen once failed a single screenshot immediately after a
fresh bundle and passed on re-run. A retry was added so an intermittent failure
read as flaky rather than as a regression while the cause was unknown.

The cause, very likely: the dev server sends no `Cache-Control`, and HTTP then
lets a browser reuse a cached response *heuristically*, without revalidating — so
a run straight after a re-bundle could render the previous build. `host.html` now
loads the bundle at a URL keyed to its mtime, and a test asserts the versioned URL
is what gets fetched.

**The evidence took two attempts, and the first was weak.** 40 consecutive clean
runs at `--retries=0` — all on the *same* bundle, which never reproduces a
condition that only arises immediately after re-bundling. A second hunt ran 15
more, each preceded by a fresh `npm run bundle`, which is the condition the
failures actually appeared under. Also clean.

55 runs, zero failures. At the observed rate of roughly two in twelve that is a
probability around 2e-5, so the local retry is gone and a flake now fails loudly.
CI keeps one, for shared-runner noise rather than for this. `npm run flake-hunt`
(RUNS=n) re-establishes the number if it is ever needed.

### ~~Rebrand: BMIR → Division of Computational Medicine~~ — done

The group renamed. The footer credited the old name and linked to the old site in
four places, all now changed: the inlined logo, its CSS class, the link and its
`aria-label`, and the `Maintained` string in **both** `en.json` and `hu.json`.
`Generic.BMIR` — the old brand's label, with no callers anywhere in the repo —
went with them, and so did `assets/images/bmir-logo.png`, which nothing
referenced; the stylesheet inlines the mark, and a second unreferenced copy of it
was the same duplication this branch spent its time removing.

**The name is Division, not Center.** This entry said Center for Computational
Medicine for as long as it was pending. The Division's own site
(`computationalmedicine.stanford.edu`) calls it the *Stanford Division of
Computational Medicine* in its title and throughout, and that is what the footer
now says. Worth flagging rather than quietly correcting, because the wrong name
was written down here first and could have been copied out of it.

The logo is the existing asset with the wordmark cropped off, not a new download:
the mark sat in rows 3–193 of a 572×318 image with "BMIR" in rows 217–311 and one
clean gap between, so the crop is measured rather than judged — 224×194, which
sets the box to 77×67 at the old height. That also matches how the Division
presents itself: the same tree, with the name set in text beside it rather than
baked into the image. Cropping it is what makes the `Maintained` string the single
source of the organisation's name; while the name was inside a PNG, no text
assertion could reach it. `margin-right: 24px` replaces the ~37px of visual gap
the old image carried as internal whitespace.

**The visual baseline did not catch any of this, and this entry used to claim it
would.** It said the change "will show up as a screenshot diff … that is the
mechanism working". It did not. `preset-chrome` was the only baseline covering the
footer, and it passed — a new logo, a new organisation name and a new link, all
green. Measured against the previous baselines the whole rebrand moved **0.708%**
of the desktop page and **0.897%** of the narrow one, against a
`maxDiffPixelRatio` of **1%**. Narrow cleared it by a tenth of a percentage point.

Mutation-tested afterwards, which is what settled it: reverting both the logo and
the name kills all four new footer assertions across both projects and leaves both
`preset-chrome` tests green.

The ratio is not the bug — it exists to absorb cross-machine font rasterisation,
and tightening it globally trades a silent failure for a noisy one. The gap is
that a **whole-page ratio cannot see a localised change to a small region of a
tall page**, which is a general property, not a fact about footers. Two things
close it here, and the config comment now says so instead of overclaiming:

- a screenshot clipped to the footer, where the same 1% is about a thousand pixels
  rather than sixteen thousand, and
- the organisation's name and URL asserted as **text**. A brand is a specific
  string, not a pixel region, and it should fail on the string.

Worth applying the same test to the other baselines before trusting them on
anything small: `pager.png` was already clipped for exactly this reason, but the
nine full-page fixtures are not, and a single widget is well under 1% of any of
them.

---

## Out of scope

- Rewriting CEE in a different framework. The domain layer is sound and
  framework-independent; the cost is in the widget layer either way.
- Fixing the two characterized defects as part of the upgrade. They are product
  decisions about validity semantics, not migration blockers — decide them
  separately.
- Adding the five missing field-type builders. That belongs in
  `cedar-model-typescript-library`.
