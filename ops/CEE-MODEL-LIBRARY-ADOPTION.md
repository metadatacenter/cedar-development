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

### 1. The corpus gap — real templates ✅ closed

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

So CEE hard-failed on a real artifact the library tolerates. Fixed, and the
corpus is now a standing part of the suite.

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

**Mitigation — now in place.** `test/corpus.spec.ts` runs CEE over 37
`cedar-test-artifacts` fixtures and 57 HuBMAP production templates, none of
which the library produced. That keeps an independent oracle in the loop, and
the tree snapshots make any behavioural change across the refactor visible as a
diff rather than a judgement call.

## Scope, in phases

**Phase 0 — prerequisites. ✅ done** (`cedar-embeddable-editor` @ `25bf538`,
`a2c9e56`.)

The `_ui.order` crash is fixed: the orphan is skipped and reported rather than
taking the editor down. `test/corpus.spec.ts` covers **37 numbered fixtures and
57 HuBMAP production templates**, plus the 21 corpus instances, each with a
checked-in structural fingerprint — 94 snapshots, 1,794 lines. The harness went
from 671 tests to 1,016; the visual baselines are unchanged at 36.

The HuBMAP set is where the value is. Those are templates people authored and
used, with deep element nesting, controlled terms throughout and the long tail
of `_ui` metadata a generator never emits. All 57 parse cleanly.

Snapshots record names, types, cardinality, constraints and nesting rather than
the whole representation, which carries object identity and cursors and would
churn on changes that mean nothing. They exist to be diffed across Phase 1.

**Phase 1 — template reading. ⬅ next, and now safe to start.** Replace `TemplateRepresentationFactory`'s raw
JSON walk with `JsonTemplateReader`, mapping the library's parsed model onto
CEE's component tree. Delete the duplicated vocabulary constants. 475 LOC
touched, but the tree it produces is unchanged, so the whole harness plus the
visual baselines apply directly. *The tractable half.*

**Phase 2a — instance cardinality. ✅ done** (`cee-with-model-library` @
`b831166`.)

`MultiInstanceObjectHandler`'s walk sits behind `InstanceCardinalityReader`,
which emits `(path, count)` pairs in the `@#index[N]#@` encoding
`setSingleMultiInstance` already parses. Two implementations; the library-backed
one is the default. All four combinations of parser and reader pass all 1,051
tests. Three defects in the library came out of it — an element with no
`@context` read as a link atom, a crash on `null`, and the parsed-instance node
types not being exported.

**Phase 2b — the quality report. ✅ done, as the tenth that was worth doing**
(`cee-with-model-library` @ `d0b5b0e`.)

`extractPlainValue` and `DataObjectUtil.deleteContext` both go through
`InstanceValueNode`, backed by the library's `isValueNode` / `readValueNode`.
The cursor-free walks were left alone, as recommended. Scoping this turned up a
third divergent rule and a data-destroying bug in it — see below.

### Phase 2b in detail

`DataQualityReportBuilderHandler` walks the *component* tree and pulls values
out of the instance as it goes. It reads the instance three ways, and they are
not equally replaceable.

| What it does | Lines | Library fit |
|---|---|---|
| `extractPlainValue` — decide what a node's value *is* | 15 | **good** |
| `collectNodes` / `findAnyValue` — every node at a path, cursor-free | 42 | parity rewrite |
| `getDataObjectNodeByPath` — the node on the page being displayed | — | wrong layer |

**The one real win is `extractPlainValue`.** It sniffs keys — `@value`, else
`@id`, else `rdfs:label` — and to tell an IRI-valued field from a controlled
term it has to ask the *template*, through `isIriValued` and
`EXTERNAL_AUTHORITY_INPUT_TYPES`. The library has already made that call at
parse time and recorded it in the node's type: `InstanceDataLinkAtom` means the
IRI is the value, `InstanceDataControlledAtom` means the label is. Type dispatch
replaces a template lookup, and the report stops needing to know which input
types happen to be IRI-valued.

It carries one behaviour decision. A controlled term written as `@id` with no
`rdfs:label` reads as **empty** today — the report falls through to the label
and finds nothing — and would read as **filled**, valued by its IRI. Nine such
nodes exist across the 21 corpus instances against 45 with labels, so it is not
hypothetical. The new answer looks like the right one: a field holding an IRI is
not empty. It changes whether some instances report valid.

**The cursor-free walks are a parity rewrite, not a simplification.**
`InstanceDataContainer` has no by-path accessor — `JsonPath` is for error
reporting — so `collectNodes` and `findAnyValue` get rewritten against typed
nodes rather than deleted. Same shape, same length, no fewer branches. The only
gain is that the array-branching would walk containers instead of guessing at
untyped objects, and that guess is already fixed.

**`getDataObjectNodeByPath` is the wrong layer to touch from here.** It resolves
through each multi ancestor's live `currentIndex`, and eight widget and service
call sites use it besides the report. Replacing it for the report alone would
leave the report reading the instance two different ways, which is worse than
what it does now. It belongs with Phase 3 or not at all: cursor state is not in
the library's model and has no business being there.

**Performance is not the objection.** The instance is mutated in place and the
report is rebuilt on all eight mutation paths, so a parsed instance is stale
immediately and has to be re-derived every time. Measured on a 62 kB instance —
20 elements, 20 fields each, five occurrences — the report build costs 1.15 ms
and the library parse 0.42 ms. Both are well inside a frame. Worth stating
plainly because it is the first thing anyone assumes is the blocker; it is not.

**What actually happened.** Taking `extractPlainValue` meant introducing a
shared classifier, and the moment there was one it was obvious that
`DataObjectUtil.deleteContext` was asking the same question with a third rule —
exact key counts. That one destroyed data: it runs over the instance a host page
injects, and a controlled term or link carrying a `@type` has the wrong number
of keys, so its `@id` was deleted. `@type: xsd:anyURI` on an IRI is ordinary
JSON-LD. The field then showed empty and saving wrote the loss back.

So the win was larger than the scope predicted, and for a reason the scope did
not anticipate: not that `extractPlainValue` improves much on its own, but that
naming the question exposes everywhere else it was being answered.

`isIriValued` stays. The template settles one thing the instance cannot —
`{@id, rdfs:label}` is a term shown by its label on a controlled field and a
resource shown by its IRI on a link. The scope claimed that coupling would go;
it does not.

**Original recommendation.** Take `extractPlainValue`, leave the walks. That is a
half-day: swap 15 lines for type dispatch, delete the `isIriValued` coupling,
decide the labelless-controlled-term question, and let the 1,051 tests and the
corpus snapshots say whether anything else moved. Rewriting `collectNodes` and
`findAnyValue` buys consistency of style and nothing else, and every line of it
is a line that can be got wrong.

**Phase 3 — instance writing.** The hard one, and it may not be worth doing.
CEE's instance handling is not a serializer: it maintains two live trees that a
UI mutates in place, addressed through multi-instance cursors, with the
attribute-value special case threaded through. The library's writer serializes a
finished artifact. Reconciling those is a redesign of CEE's data layer, not a
substitution. **Recommend deferring** until 1 and 2 have settled.

## Verdict

Phase 0 is done, and it did what it was for — it found a crash on the first run.

**Phase 1 is safe to start.** 1,016 behavioural tests, 94 tree snapshots over
input the library did not generate, and 36 visual baselines. The oracle problem
is answered rather than merely noted.

Phase 2a is done. Phase 2b is mostly not worth doing: one 15-line win, the rest
parity work on code that a mutation test would struggle to distinguish from what
is already there.

Phase 3 is not a refactor and should not be scoped as one.

Phases 1 and beyond should go on a feature branch — Phase 0 was additive and
belonged on `develop`, but replacing the parser does not.
