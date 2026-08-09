# CEDAR model libraries — parity between Java and TypeScript

`cedar-artifact-library` (Java) and `cedar-model-typescript-library` (TypeScript)
implement the same model, v1.6.0, and are meant to produce the same JSON and
YAML for the same artifact. This records where they do not.

Measured, not inferred: every finding below comes from running both libraries'
generated output over the shared `cedar-test-artifacts` corpus and diffing the
key structure of all 77 artifacts they have both processed.

## How to reproduce

The TypeScript library carries the corpus in-repo at `cedar-test-artifacts/`, so
`npm test` runs clean on a plain clone — **61 suites, 606 tests**. Nothing needs
cloning or symlinking first. The copy came from the **`develop`** branch of
`cedar-test-artifacts`; `main` there carries only a README.

```bash
npx ts-node ./itest/scripts/compare-verbatim-ts-java-yaml-files.ts
```

A case with output on only one side is skipped and counted rather than throwing,
so the run reads as a summary:

```
templateField: 13 compared, 0 differing, 7 skipped — no output on one side: 5, 6, 7, 17, 18, 19, 20
templateElement: 6 compared, 0 differing
DIFF FOUND:  - template-9
template: 37 compared, 1 differing
```

## Corpus coverage

| | cases | both libraries | TS only |
|---|---|---|---|
| fields | 20 | 13 | 7 |
| elements | 6 | 6 | — |
| templates | 37 | 37 | — |
| instances | 21 | 21 | — |

`ext-pubmed`, `ext-rrid`, `ext-nih-grant-id` and `ext-doi` were exercised
nowhere in the corpus — not as field cases, not inside any template or element.
Cases **017-020** now cover them (`cedar-test-artifacts` @ `043d497`), modelled
on 016 (PFAS). All four round-trip through the TypeScript library with zero keys
dropped and zero added.

They carry TypeScript output only, so they join the boolean cases in the TS-only
column. The Java artifact library has moved on considerably from the version the
rest of the corpus was generated against, and generating its side for four cases
alone would mix two Java versions into one corpus. Cross-library parity for
these four therefore remains unmeasured until the Java side is regenerated
wholesale.

---

## The `boolean` field type — resolved

**Resolved.** `boolean` is a valid v1.6.0 field type; it is now supported end to end (TypeScript
facade builder, Java `BooleanField` + `BooleanValueConstraints`, and the meta-schema). The account
below is kept for context.

Java's `FieldInputType` had 23 values. TypeScript's `UiInputType` has 24 — the
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

**1. ~~Static field `_ui._size` — width and height~~** (`templates/009`) — **fixed**

The source declares `_ui._size: {width: 192, height: 108}` on a YouTube field.
TypeScript emits it; Java once emitted `_ui` with only `_content` and `inputType`.
Current Java already emits `_ui._size`; a corpus regeneration confirmed template-009 now carries it.

**2. ~~`skos:prefLabel` on child artifacts~~** (`templates/029`) — **fixed**

The source carries `skos:prefLabel: "Data File Language"` on child *elements*. The loss was that
`ElementSchemaArtifact` did not model a preferred label at all (only fields did), so the reader
dropped it and the renderer never emitted it. Java now carries `skos:prefLabel`/`skos:altLabel` on
elements; template-029's JSON output went from 117 to 145 string-valued prefLabels, matching
TypeScript's 145.

**3. A spurious `_content: null` on page and section breaks** (5 occurrences
across `templates/004`, `009`, `037`)

The source `_ui` for a page break is `{"inputType": "page-break"}`. Java emits
`{"inputType": "page-break", "_content": null}`, inventing a key. TypeScript
matches the source. The opposite of a hole — Java adds rather than drops — but
still a serialization difference.

**4. Empty literal values are normalised away** (44 occurrences across instances)

See the table below.

### TypeScript loses data that Java preserves

**7. Static *image* `_ui._size` — width and height** — **open**

The mirror of item 1, and found the other way round: there, Java dropped
`_ui._size` from a YouTube field and TypeScript kept it. Here TypeScript drops it
from an **image** field.

`StaticImageField` in `cedar-model-typescript-library` exposes `content` and
nothing else, while `StaticYoutubeField` exposes `content`, `width` and `height`.
So the size is not merely hidden from readers — it does not survive a round trip.
Reading a template that declares
`_ui._size: {"width": 300, "height": 200}` on an image and writing it back with
`CedarWriters.json().getFebruary2024()` yields `_ui` with no `_size` at all, while
the YouTube field beside it keeps its `{"width": 400, "height": 300}`. Measured on
`templates/ce8a4f66` from the local stack; the same shape appears six times across
the 579 corpus templates.

That makes it data loss rather than a modelling preference: anything that reads
and rewrites a template through this library silently deletes an author's image
sizing. It also blocks CEE from honouring the setting — CEE now renders a
YouTube field at the size its template asks for and cannot do the same for an
image, because the number never arrives.
`harness/test/static-content-size.spec.ts` asserts the gap, so it fails when the
library grows the property.

### ~~TypeScript's instance round-trip losses~~ — both fixed

Fixed in `cedar-model-typescript-library` @ `09fb69a`, corpus regenerated in
`cedar-test-artifacts` @ `235c60c`. Verified across all 21 corpus instances:
zero source keys dropped, zero keys Java emits that TypeScript does not.
Regression tests in
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

Resolved this pass:

1. ~~**Decide on `boolean`.**~~ **Resolved: `boolean` is a valid v1.6.0 field type** — the
   meta-schema lists it in the field `inputType` enum and the corpus carries boolean cases. It is
   now supported end to end: `booleanFieldBuilder` is exposed on the TypeScript facade
   (`cedar-model-typescript-library`); the Java library (`cedar-artifact-library`) gained a
   `BooleanField` type plus a `BooleanValueConstraints` type (`nullEnabled`, a three-state boolean
   default, the true/false/null label map) with JSON and YAML read/render; and the meta-schema
   (`cedar-model-validation-library`) now accepts the boolean value-constraints shape. Corpus fields
   005–007 read, render, round-trip (JSON), and validate. Deployed and smoke-verified (REST + UI).
3. ~~**Fix Java's `_ui._size` drop.**~~ **Resolved** — current Java already emits `_ui._size`; a
   corpus regeneration confirmed template-009 now carries the width/height.
4. ~~**Fix Java's `skos:prefLabel: null`.**~~ **Resolved** — the loss was on *elements*, which did
   not model a preferred label at all. Java now carries `skos:prefLabel`/`skos:altLabel` on elements;
   on template-029 the JSON output went from 117 to 145 string-valued prefLabels, matching TypeScript.
6. ~~**Expose `booleanFieldBuilder`.**~~ **Resolved** (folded into item 1).

Remaining:

2. **Decide whether `{}` and `{"@value": null}` are distinguishable.** Unchanged — the largest class
   (44 cases). TypeScript preserves the distinction, Java erases it; this decides whether Java changes
   or TypeScript should start normalising too. A model-owner decision.
5. **Regenerate *both* sides of the corpus.** Bigger than first framed: the committed corpus is stale
   on both the Java and the TypeScript side, so regenerating only Java makes the comparison worse
   (current-Java vs stale-TS: template diffs went 1 → 10 in a trial). A both-sides regeneration to the
   current libraries surfaces the divergences below, so this is a triage-then-regenerate batch, not a
   one-shot.
7. **`propertyLabels`/`propertyDescriptions` orphan keys** (`templates/003`) — unchanged; both
   libraries diverge from the source.

### Newly surfaced (both sides regenerated to current)

Regenerating both libraries to current output — then reverted, as it is out of scope for a single fix —
exposed divergences the uniformly-stale corpus hid, across ~10 templates (7, 9, 22, 23, 24, 28, 29, 30,
35, 36) and element-6:

- **`id:` in compact YAML** — Java emits it, TypeScript omits it.
- **Value-constraint key naming** — Java `sourceAcronym`/`sourceName` vs TypeScript
  `acronym`/`ontologyName`/`termLabel`/`iri`/`maxDepth` for the same concept.
- **Element `prefLabel` in compact YAML** — TypeScript's compact writer drops it; Java (now fixed)
  keeps it, so they diverge there in the opposite direction. JSON is faithful on both sides.

> Original comparison run against `cedar-artifact-library` **`main`** @ `3d2afb1e`. The boolean,
> `_ui._size`, and `skos:prefLabel` resolutions above landed on **`develop`** and are deployed.
> (release 2.9.1). That repo's `develop` carries 18 further commits including a
> YAML value-constraint key overhaul, which this comparison does not cover.
