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

### Defect: five external-authority fields have unreachable error messages

`cedar-input-pfas`, `-pmid`, `-rrid`, `-nih-grant` and `-doi` each render a
`mat-error` bound to a type-specific error key:

```html
<mat-error *ngIf="inputValueControl.getError('invalidPmid') && !readOnlyMode">
```

Nothing ever sets those keys. Comparing what each template expects against what
its component sets:

| Component | Template expects | Ever set |
|---|---|---|
| orcid | `invalidOrcid`, `required` | `invalidOrcid` ✅ |
| ror | `invalidRor`, `required` | `invalidRor` ✅ |
| pfas | `invalidPfas`, `required` | — |
| pmid | `invalidPmid`, `required` | — |
| rrid | `invalidRrid`, `required` | — |
| nih-grant | `invalidNihGrant`, `required` | — |
| doi | `invalidDoi`, `required` | — |

ORCID and ROR call `setErrors({ invalidOrcid: true })`; the five newer types
never call `setErrors` at all. So those fields accept any string silently while
carrying markup that looks like they validate it — worse than having no
validation, because the code reads as though the check exists.

This is a direct consequence of the duplication recorded in *Unify the external
authority fields*: the five were copied from the ORCID/ROR pair, the error
markup came along, and the code that raises the error did not. It is the
concrete cost of that item rather than a hypothetical one, and fixing the
duplication would prevent the next instance of it.

### Defect: the add button ignores maxItems when minItems is absent

`CedarMultiPagerComponent.isEnabledAdd()` guards on the wrong property:

```ts
isEnabledAdd(): boolean {
  if (this.component.multiInfo.minItems != null) {      // <- minItems
    if (this.currentMultiInfo.currentCount >= this.component.multiInfo.maxItems) {
      return false;
    }
  }
  return true;
}
```

The guard tests `minItems` and the comparison uses `maxItems`. A field
declaring `maxItems` without `minItems` therefore never disables the add
button, and the upper bound is unenforced. Where `minItems` *is* present the
outcome is right by accident. `isEnabledDelete` two methods above is correct,
so this is a copy-paste slip rather than a design.

One-word fix — `maxItems != null`. Not done here because it changes which
buttons are clickable, and UI changes are being held.

Worth knowing alongside it: cardinality is enforced *only* by these two
methods disabling buttons. Neither the handlers nor the quality report check
bounds, so `addMultiInstance` called directly will happily exceed `maxItems`
— demonstrated at 7 instances against `maxItems: 3`. Same shape as read-only:
a constraint enforced by the widget layer alone.

The domain harness cannot reach this one, since `isEnabledAdd` is component
logic rather than domain logic. The visual suite could cover the disabled
state.

### Finish the data quality report

The README says of the report's three fields: *"At the moment these three fields
are available, with more to come."* The more never came. What exists is a
required-fields-present check named "data quality report", and the name is
writing a cheque the implementation does not honour.

**It validates presence and nothing else.** Every case below reports
`isValid: true`, with the constraint declared in the template and already
parsed by CEE:

| Area | Constraint | Value given |
|---|---|---|
| numeric | `xsd:int` | `abc` |
| numeric | `xsd:int` | `3.7` |
| numeric | `xsd:int` | `2147483648` (over `INT_MAX`) |
| numeric | `minValue: 0, maxValue: 10` | `999` |
| numeric | `decimalPlaces: 2` | `1.23456` |
| temporal | `granularity: year` | `2026-08-02T10:30:00` |
| temporal | `xsd:date` | `10:30:00` (time only) |
| temporal | `xsd:time` | `2026-08-02` (date only) |
| temporal | any | `not a date at all` |
| temporal | `timezoneEnabled: false` | `2026-08-02T10:30:00-08:00` |
| temporal | `granularity: second` | `2026-08-02T10:30` (no seconds) |
| temporal | `xsd:date` | `2026-13-40` (month 13, day 40) |
| choice | literals `Alpha`, `Beta` | `Zeta` |
| cardinality | `minItems: 2` | 0 instances |
| cardinality | `maxItems: 3` | 7 instances |
| cardinality | multi field `minItems: 3` | 1 entry |
| text | `minLength`, `maxLength`, `regex` | violating values |
| email / link / phone | format | `not-an-email`, `totally not a uri`, `!!!` |

### Where each constraint is actually enforced

Every cell below was checked against the source or measured against a running
editor, not inferred. ✅ enforced, ⚠️ enforced but wrong or partial, ✗ not
enforced.

| Constraint | Widget | Report | Handlers |
|---|---|---|---|
| **Presence** | | | |
| `requiredValue` | ⚠️ all value widgets **except** checkbox, attribute-value and datetime, which install no validators at all | ✅ | ✗ |
| **Text** | | | |
| `minLength` / `maxLength` | ✅ | ✗ | ✗ |
| `regex` | ✗ — **never applied anywhere**, despite 150 occurrences in the HuBMAP corpus. `cedar-input-text` installs no `Validators.pattern`, and `ValueInfo` has no slot for it | ✗ | ✗ |
| **Format** | | | |
| email | ✅ `Validators.email` | ✗ | ✗ |
| link | ✅ hardcoded pattern (not from the template) | ✗ | ✗ |
| phone | ✅ hardcoded pattern | ✗ | ✗ |
| ORCID, ROR | ⚠️ `setErrors({invalidOrcid/invalidRor})`, a prefix check only — no identifier or checksum validation | ✗ | ✗ |
| PFAS, PubMed, RRID, NIH Grant, DOI | ✗ — **dead markup**, see the defect below | ✗ | ✗ |
| **Numeric** | | | |
| `xsd:int`, `xsd:long` pattern + implicit bounds | ✅ | ✗ | ✗ |
| `xsd:float`, `xsd:double` pattern | ✅ | ✗ | ✗ |
| `decimalPlace` | ⚠️ float and double only — woven into the pattern, so it does not apply to int or long | ✗ | ✗ |
| `minValue` / `maxValue` | ✅ | ✗ | ✗ |
| `xsd:decimal`, `xsd:byte`, `xsd:short` | ✗ — no `Xsd` constants, so they fall through every branch | ✗ | ✗ |
| `unitOfMeasure` | ✗ display only | ✗ | ✗ |
| **Temporal** | | | |
| value shape vs `temporalType` | ✗ | ✗ | ✗ |
| value shape vs `granularity` | ✗ | ✗ | ✗ |
| timezone present vs `timezoneEnabled` | ✗ | ✗ | ✗ |
| calendar validity (month 13, day 40) | ✗ | ✗ | ✗ |
| **Choice** | | | |
| value is one of the declared literals | ⚠️ the widget constrains selection, so a user cannot violate it — an injected instance can | ✗ | ✗ |
| **Controlled term** | | | |
| membership in ontologies / valueSets / classes / branches | ✗ — needs the terminology server; out of scope for a local synchronous report, and worth stating as a decision | ✗ | ✗ |
| `@id` is a well-formed IRI | ✗ | ✗ | ✗ |
| `@id` and `rdfs:label` present as a pair | ✗ | ⚠️ fails *incidentally* — the presence check reads `rdfs:label`, so a missing label reads as empty rather than as malformed | ✗ |
| **Cardinality** | | | |
| `minItems` | ✅ delete button disabled at the floor | ✗ | ✗ |
| `maxItems` | ⚠️ **buggy** — see the defect below | ✗ | ✗ |
| **Attribute-value** | | | |
| duplicate or blank attribute name | ✗ | ✗ | ⚠️ **auto-corrected, not validated** — `changeAttributeValue` silently substitutes `Attribute Value Field<n>`. The user's chosen name is discarded without a message |

Three things the table makes plain. The **Handlers** column is empty but for one
cell, so nothing is enforced below the widget layer — an embedder driving
`HandlerContext` directly has no guardrails. The **Report** column is empty but
for presence, which is the substance of this item. And **temporal is the only
area with no ✅ anywhere**, while being the type with the most declared
structure to check against.

**The report and the widgets disagree.** Sixteen input components render
`mat-error` — email, link, phone, numeric, text length, ORCID, ROR, DOI, PubMed,
RRID, NIH Grant, controlled, select, multiple-choice, and the date picker. So
for a malformed email the form shows a red error *and* the report says the
instance is valid, at the same instant. A host page polling
`cee.dataQualityReport.isValid` to gate submission will accept metadata the user
can see is wrong.

That is the same shape as two of the three defects closed above: a second place
forming its own opinion instead of consulting the first. Here the two opinions
are visible side by side on screen.

**There are no diagnostics.** The contract is two integers and a boolean.
`requiredFieldValueCount: 3, nonNullRequiredFieldValueCount: 2` says something is
missing but not what, so an embedder cannot tell the user which field to fix.
The `valueTree` is a data dump, not a problem list.

**Nothing new needs parsing.** CEE already reads every constraint required —
`minLength`, `maxLength`, `regex`, `numberType`, `minValue`, `maxValue`,
`decimalPlace`, `temporalType`, `granularity`, choice literals, and
`minItems`/`maxItems` — and the widgets already implement most of the checks as
Angular validators. The work is not writing validation; it is putting the
existing validation somewhere both consumers can reach.

Suggested shape:

- Extract the widgets' validators into pure functions keyed by input type, and
  have both the `FormControl` setup and the report call them. One definition of
  "valid email", not two.
- Add `problems: Array<{ path, code, message }>` to `DataQualityReport`, so the
  host can point at a field. Keep the counters for backwards compatibility.
- Cover the constraints nothing checks today: numeric range and type, choice
  membership, and `minItems`/`maxItems` cardinality.
- Controlled-term membership needs the terminology server and should stay out
  of a local, synchronous report — worth stating explicitly so its absence is a
  decision rather than an oversight.

Also unresolved, and now characterized in `harness/test/cardinality.spec.ts`
rather than assumed: an element with **zero** instances contributes zero
requirements, so a template whose only required field sits inside one reports
vacuously valid.

The harness makes this safe to take on — the report is already its most heavily
covered surface, and `expectNoErrors` plus the round-trip oracle will catch
collateral.

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
