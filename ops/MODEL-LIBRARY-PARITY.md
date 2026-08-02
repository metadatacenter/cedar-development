# CEDAR model libraries — parity between Java and TypeScript

`cedar-artifact-library` (Java) and `cedar-model-typescript-library` (TypeScript)
implement the same model, v1.6.0, and are meant to produce the same JSON and
YAML for the same artifact. This records where they do not.

Measured, not inferred: every finding below comes from running both libraries'
generated output over the shared `cedar-test-artifacts` corpus and diffing the
key structure of all 77 artifacts they have both processed.

## How to reproduce

The corpus lives on the **`develop`** branch of `cedar-test-artifacts` — `main`
carries only a README, so a default clone looks empty.

```bash
cd $CEDAR_HOME && git clone https://github.com/metadatacenter/cedar-test-artifacts
cd cedar-test-artifacts && git checkout develop
```

The TypeScript library resolves the corpus by two different conventions:
`pretest.js` looks for `../cedar-test-artifacts`, while `itest/TestResource.ts`
builds `cedar-test-artifacts/...` relative to the working directory. A symlink
satisfies both:

```bash
cd $CEDAR_HOME/cedar-model-typescript-library && ln -sfn ../cedar-test-artifacts cedar-test-artifacts
```

With that in place `npm test` runs clean — **47 suites, 308 tests**. Without it,
15 suites and 172 tests fail on missing files, which is what an unprepared
checkout looks like and is easily mistaken for breakage.

```bash
npx ts-node ./itest/scripts/compare-verbatim-ts-java-yaml-files.ts
```

## Corpus coverage

| | cases | both libraries | TS only |
|---|---|---|---|
| fields | 16 | 13 | 3 |
| elements | 6 | 6 | — |
| templates | 37 | 37 | — |
| instances | 21 | 21 | — |

**Four input types are exercised nowhere in the corpus**: `ext-pubmed`,
`ext-rrid`, `ext-nih-grant-id`, `ext-doi`. Both libraries claim to support them
and neither has ever been checked against the other for them. Adding one corpus
case per type would close that.

---

## The `boolean` field type

Java's `FieldInputType` has 23 values. TypeScript's `UiInputType` has 24 — the
extra one is `boolean`.

This is not merely a naming difference. Corpus field cases **005, 006 and 007**
are `boolean` fields, and each carries only `*-generated-ts-model-lib.*` output:
there is no Java-generated counterpart because the Java library cannot represent
the type. Those three cases are the entire TS-only column above.

Two things follow, and they point in opposite directions, so the model owner has
to decide which:

- If `boolean` is part of v1.6.0, **Java has a missing field type** and three
  corpus artifacts it cannot read.
- If it is not, **TypeScript has a type it should not**, and the three corpus
  cases are inventions.

TypeScript's own position is ambiguous: `CedarFieldType.BOOLEAN`,
`UiInputType.BOOLEAN`, `ValueConstraintsBooleanField` and a `BooleanFieldBuilder`
all exist, but `CedarBuilders` exposes no `booleanFieldBuilder`, so the type can
be read and written but not authored through the public facade — the same shape
of gap that `ext-pfas` had until recently.

---

## Divergences on the 77 shared artifacts

One diff is reported by the library's own comparator
(`DIFF FOUND: template-9`). Structural comparison of the JSON finds six classes.

### Java loses data that TypeScript preserves

**1. Static field `_ui._size` — width and height** (`templates/009`)

The source declares `_ui._size: {width: 192, height: 108}` on a YouTube field.
TypeScript emits it; Java emits `_ui` with only `_content` and `inputType`.

Java is not missing the concept — `StaticFieldUi` declares `Optional<Integer>
width()` and `height()`, and `ImageField` and `YouTubeField` reference them. The
model has the fields and the serialization drops them, which makes this a
reader or renderer defect rather than a modelling gap.

**2. `skos:prefLabel` on child artifacts** (`templates/029`, 28 occurrences)

The source carries `skos:prefLabel: "Data File Language"` on a child. Java emits
`skos:prefLabel: null`. TypeScript preserves the value.

**3. A spurious `_content: null` on page and section breaks** (5 occurrences
across `templates/004`, `009`, `037`)

The source `_ui` for a page break is `{"inputType": "page-break"}`. Java emits
`{"inputType": "page-break", "_content": null}`, inventing a key. TypeScript
matches the source. The opposite of a hole — Java adds rather than drops — but
still a serialization difference.

**4. Empty literal values are normalised away** (44 occurrences across instances)

See the table below.

### ~~TypeScript loses data that Java preserves~~ — both fixed

Fixed in `cedar-model-typescript-library` @ `09fb69a`. Verified across all 21
corpus instances: zero source keys dropped, zero keys Java emits that TypeScript
does not. Regenerating the corpus would change two files, +25/-1, entirely
restored entries. Regression tests in
`test/.../template-instance/InstanceRoundTripFidelity.spec.ts`.

**5. ~~Empty controlled-term objects are dropped from instances~~** (was 18
occurrences)

The reader classified `{}` correctly as an empty atom; the writer's
`serializeCommonType` had no branch for that type, fell through to `return
null`, and the caller then skipped the key. The field vanished. A branch
returning `{}` fixes it.

**6. ~~`@context` entries for children with no data~~** (`instances/005`)

The source `@context` maps both `Element` and `Element1` to property IRIs.
Neither appears in the instance body. Java preserves both entries; TypeScript
drops them, keeping only the entries whose child carries data.

The reader built its mapping by walking the keys present in the body, so
entries for unpopulated children were dropped. It now also walks the source
`@context` and keeps anything not covered by the standard prefixes, since that
is by definition a child property IRI. The new pass runs after the
attribute-value pass so existing key order is untouched and the change is purely
additive.

### Empty values in instances — the systematic one

This is the largest single class, and it is perfectly regular: 62 occurrences,
no exceptions.

| Source | Java emits | TypeScript emits |
|---|---|---|
| `{}` (18×) | `{}` — faithful | `{}` — faithful *(was: key absent)* |
| `{"@value": null}` (44×) | `{}` — **normalised** | `{"@value": null}` — faithful |

TypeScript is now faithful to both shapes. Java still collapses every empty
field to `{}`, losing the distinction between an empty literal and an empty
controlled term.

That leaves the model question live rather than settled: TypeScript now
*preserves* a distinction Java erases, so the two still disagree on 44
occurrences. If `{}` and `{"@value": null}` are meant to be the same thing,
TypeScript is over-faithful and Java is right; if they are not, Java is losing
data. Someone has to say which.

### Both diverge from the source

**7. `propertyLabels` and `propertyDescriptions` with orphan keys**
(`templates/003`)

The source declares entries keyed `TextfieldLabel` and `TextfieldChildExtra`,
neither of which names an actual child. Java emits `{}`; TypeScript emits
`{"TextfieldChild": "Textfield"}` and `{"TextfieldChild": ""}`, regenerating the
map from the children that exist.

Neither reproduces the input. TypeScript's behaviour is more useful — a label map
keyed by real children — but a template with orphan entries survives neither
round trip, and TypeScript inventing a `""` description is its own small wart.

---

## Suggested order

1. **Decide on `boolean`.** It gates whether three corpus artifacts are valid,
   and it is the only whole-type divergence.
2. **Decide whether `{}` and `{"@value": null}` are distinguishable.** The
   largest class by occurrence, 44 cases. TypeScript now preserves the
   distinction and Java erases it, so this decides whether Java changes or
   TypeScript should start normalising too.
3. **Fix Java's `_ui._size` drop.** Unambiguous data loss with the model already
   in place, so no design decision is needed.
4. **Fix Java's `skos:prefLabel: null`.** Same character.
5. **Regenerate the corpus** with the fixed TypeScript library — two instance
   files are now stale.
6. **Add corpus cases for the four uncovered field types**, so parity for them is
   measured rather than assumed.
7. **Expose `booleanFieldBuilder`** in the TypeScript facade, if item 1 resolves
   in favour of keeping the type.

Items 3 and 4 are one-directional bugs. Items 1 and 2 are model decisions that
need an owner before either library can be called correct.

> Comparison run against `cedar-artifact-library` **`main`** @ `3d2afb1e`
> (release 2.9.1). That repo's `develop` carries 18 further commits including a
> YAML value-constraint key overhaul, which this comparison does not cover.
