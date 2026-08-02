# CEE: adopting the model library instead of hand-reading JSON

CEE parses CEDAR template JSON and builds instance JSON by hand, key by key,
against its own copy of the model vocabulary. The CEDAR Model TypeScript Library
already does both. This scopes replacing one with the other, and answers whether
the tests are good enough to try.

**Short answer: yes for the template side, not yet for the instance side.** The
gap is not the number of tests but one property of them, described under
*The oracle problem*.

## What is hand-rolled today

| | Files | LOC | Raw key lookups |
|---|---|---|---|
| Template reading | `factory/template-representation.factory.ts`, `util/template-object-util.ts` | 475 | 77 |
| Instance building, reading, writing | the five `handler/*.ts`, `util/data-object-util.ts`, `service/active-component-registry.service.ts` | 2,084 | 112 |

A further ~24 lookups live in the external-authority lookup services and their
REST response models. Those read `@id` and `rdfs:label` off BioPortal-style
search responses, not off CEDAR artifacts, and are out of scope.

CEE also maintains its own vocabulary — `models/cedar-model.model.ts`,
`json-schema.model.ts`, `xsd.model.ts`, `temporal.model.ts`, `numbers.model.ts` —
duplicating constants the library owns. That duplication is how CEE came to know
four numeric types where the model has seven.

## Does the library expose what CEE needs?

For the template side, yes — checked key by key. Everything the factory reads
has a counterpart:

| CEE reads | Library surface |
|---|---|
| `_ui.order` | `ContainerArtifactChildrenInfo.getChildrenNames()` |
| `_ui.propertyLabels` / `propertyDescriptions` | `getPropertyLabelMap()` / `getPropertyDescriptionMap()` |
| `_ui.inputType`, `@type` discriminators | `TemplateField.cedarFieldType`, `ChildDeploymentInfo.uiInputType` |
| `_ui.hidden`, `minItems`, `maxItems`, `requiredValue` | `ChildDeploymentInfo` |
| `_valueConstraints.*` per type | `ValueConstraints<Type>Field` — numeric carries `numberType`, `minValue`, `maxValue`, `decimalPlaces`, `unitOfMeasure`; temporal carries `temporalType`, `temporalGranularity`, `timezoneEnabled`, `inputTimeFormat` |
| choice `literals` with `selectedByDefault` | `ValueConstraintsListField.literals: ListOption[]` |
| controlled `ontologies` / `classes` / `branches` / `valueSets` | `ValueConstraintsControlledTermField` |
| static `_ui._content` | `content` on each static field type |
| `skos:prefLabel`, `schema:name`, `schema:description` | on the artifact |

What the library does **not** model, and CEE would keep computing itself, is the
rendering layer: `hidden` under `hideEmptyFields`, `pageBreakChildren`,
`linkedStaticFieldComponent`, and the multi-instance cursors. Those are display
concerns and belong in CEE. The refactor changes where the *data* comes from,
not what CEE derives from it.

## Do we have enough tests?

671 harness tests and 36 visual baselines. They test behaviour — the component
tree, instance values, the quality report, the rendered form — not
implementation, which is exactly the shape a refactor needs. Every harness test
builds a template and parses it, so the factory is on every path.

Two gaps matter, and only one is serious.

### 1. The corpus gap — real templates, cheaply closed

The harness generates every template it uses. That is deliberate and it buys
enumerable coverage, but it means CEE has never been tested against a template a
human or the Template Editor produced.

Closing it took one throwaway test and immediately found a crash:

```
parsed ok: 36 / 37
  FAIL 003: Cannot read properties of undefined (reading 'type')
```

`template-003`'s `_ui.order` lists `TextfieldOrder`, which has no entry in
`properties`. `TemplateRepresentationFactory.wrap()` does
`templateJsonObj.properties[name]` and passes the result straight to
`isFragmentMulti`, which reads `.type` and throws. The model library reads the
same template without complaint — that case has both TS and Java generated
output in the corpus.

So CEE hard-fails on a real artifact the library tolerates. Small fix, and it
should land **before** any refactor, so the corpus can be used as a safety net
rather than being blocked by one crash.

### 2. The oracle problem — the real risk

Today:

```
library generates template JSON  →  CEE parses it by hand  →  assert
```

Two independent implementations of the same spec agreeing. That is what makes
the harness a real check rather than a tautology.

After adopting the library:

```
library generates template JSON  →  library parses it  →  CEE maps  →  assert
```

The JSON contract is no longer tested by CEE's tests at all. A library bug that
is symmetric between its writer and reader becomes invisible — and both of the
fidelity bugs fixed in the library recently were exactly that shape.

**Mitigation, and it is not optional:** add corpus-driven tests whose input is
hand-authored JSON the library did not produce. `cedar-test-artifacts` has 37
templates and 21 instances; `cedar-artifact-library` ships the HuBMAP YAML
corpus. Those keep an independent oracle in the loop. This is the one piece of
new testing the refactor genuinely requires.

## Scope, in phases

**Phase 0 — prerequisites.** Fix the `_ui.order` crash. Add corpus-driven tests
over all 37 templates and 21 instances, asserting CEE parses them and produces a
stable component tree. Snapshot the resulting trees so the refactor has a
before/after to diff. *Small; a day.*

**Phase 1 — template reading.** Replace `TemplateRepresentationFactory`'s raw
JSON walk with `JsonTemplateReader`, mapping the library's parsed model onto
CEE's component tree. Delete the duplicated vocabulary constants. 475 LOC
touched, but the tree it produces is unchanged, so the whole harness plus the
visual baselines apply directly. *The tractable half.*

**Phase 2 — instance reading.** Replace instance parsing in
`MultiInstanceObjectHandler.updateFromInstanceExtractData` and the quality
report with `JsonTemplateInstanceReader`. *Medium. Interacts with the
`@#index[N]#@` path encoding.*

**Phase 3 — instance writing.** The hard one, and it may not be worth doing.
CEE's instance handling is not a serializer: it maintains two live trees that a
UI mutates in place, addressed through multi-instance cursors, with the
attribute-value special case threaded through. The library's writer serializes a
finished artifact. Reconciling those is a redesign of CEE's data layer, not a
substitution. **Recommend deferring** until 1 and 2 have settled.

## Verdict

Phases 0 and 1 are safe to attempt now — the behavioural tests are strong, and
Phase 0 closes the one input-coverage gap while the corpus snapshots give an
exact before/after.

Phase 2 is safe once Phase 1 has shaken out.

Phase 3 is not a refactor and should not be scoped as one.

The condition on all of it is the oracle problem: without corpus-driven tests,
adopting the library for both generation and parsing would leave CEE's JSON
handling effectively untested, however green the suite looks.
