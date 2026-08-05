# CEDAR Model TypeScript Library — Roadmap

Outstanding work for `cedar-model-typescript-library`. CEE-side work belongs in
[CEE-ROADMAP.md](./CEE-ROADMAP.md); backend and cross-service work in
[DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md). Where this library and the
Java one disagree is recorded in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md),
and the case for CEE adopting the library at all in
[CEE-MODEL-LIBRARY-ADOPTION.md](./CEE-MODEL-LIBRARY-ADOPTION.md).

This roadmap tracks open work only. Item numbers are stable handles, not commit
labels.

> **Commit-message rule:** Never refer to roadmap items or item numbers in commit
> or check-in messages. Describe the concrete change and affected surface.

## Current position

- 61 suites and 606 tests. Every push to `develop` runs them and builds the
  distributable.
- The test data is in the repository: the artifact corpus at
  `cedar-test-artifacts/`, the 93 reference templates the integration tests read
  at `cedar-artifact-library/src/test/resources/templates/`. A plain clone runs
  the suite.
- Templates CEDAR served between 2018 and 2024 are readable. The corpus
  readability spec reads 122 templates and asserts that the two deliberately
  malformed ones — `cee-suite/086` and `templates/003` — still fail. Older forms
  are recorded as warnings rather than rejected, and `STRICT` stays strict.
- `InstanceValidator.validate` answers instance conformance, with 56 corpus
  template/instance pairs as its false-positive net.
- `package-dist.json` carries `0.9.2-dev.20260804.f1a3784`, the version before
  any of the validator work. Nothing has shipped.

## Critical Path

### 1. Release the library

Nothing downstream can move until this ships. CEE has a written conformance spec
it cannot run and no check at all on its own output in the meantime — see
[CEE-ROADMAP.md](./CEE-ROADMAP.md) item 7.

Three decisions, then a publish:

- Whether the new instance reports are errors or warnings.
- Whether this is `0.10.0` rather than `0.9.x`. The question is real rather than
  ceremonial: `wasSuccessful()` on an instance parse could only ever return true
  before, and now can return false. Any consumer branching on it sees new
  behavior.
- Which version field is authoritative. `package.json` says `0.9.0` and
  `package-dist.json` says the prerelease above; the dist one is what publishes.

## Validation Correctness

Three findings of the same kind: the reader has no template to compare against,
so it cannot always tell one shape from another, and the gap shows up as
something not checked rather than something checked wrongly.

### 2. The instance envelope is not validated

[Issue #2](https://github.com/metadatacenter/cedar-model-typescript-library/issues/2).
An instance with no `@id`, no `schema:isBasedOn`, no provenance and an empty
`@context` still reports `adheresToBlueprint() === true`. The reader's
`knownKeys` already lists the envelope; nothing consults it. Reporting a null
`@id` was the first write into that parsing result, and the rest of the envelope
is the remainder of the issue.

### 3. `[]` is read as an `InstanceDataAttributeValueField`

An empty list is not an empty array, but without a template the reader cannot
tell one from the other. Worked around in `InstanceValidator` with a comment
rather than fixed. Every unfilled multi child looked like a cardinality mismatch
until this was understood, which is why the workaround exists.

### 4. `wasSuccessful()` and `adheresToBlueprint()` are identical

Both return `blueprintComparisonErrors.length === 0`, in both
`JsonArtifactParsingResult` and `YamlArtifactParsingResult`. Warnings now carry
real signal, so one of the two should probably mean "clean, including warnings".
Decide which before item 1 fixes the meaning of both in a published version.

## Naming

### 5. `JsonTemplateInstancetReader.ts` — the transposed `t`

The exported class name is correct; only the filename is wrong. The package ships
as a bundle, so no consumer imports the path and the rename is internal to
`src/index.ts` and `CedarJsonReaders.ts`.

## Corpus

These need someone who knows CEDAR's version history. They are judgements about
what the corpus means, not code changes.

### 6. Temporal `required` is inconsistent across the corpus

28 templates require `@type` on a temporal value, 27 do not, and 12 require
nothing. The blueprint comparison does not check field-level `required`, so it
flags none of them. `InstanceValidator` requires `@type` always — stricter than
roughly half the corpus, on the grounds that the field declares a `temporalType`
and so the value is a typed literal. That was a judgement, and it should be an
explicit one.

### 7. `cee-suite/002` does not conform

Its template declares `minItems: 10` on `Multi Text Field`; its instance carries
two values. Recorded in `KNOWN_NONCONFORMANT` in `InstanceValidatorCorpus.spec.ts`
with a companion test that fails if it ever starts conforming, so the corpus stays
green without the discrepancy being forgotten.

## Deferred

### 8. Widen instance validation to per-field value-node `required`

A template states `required: ["@value"]` per field, so "this value node is
missing the key its own schema demands" is checkable without inferring anything
from `uiInputType` — which cannot be inferred from anyway, since a `textfield`
may hold a literal or an IRI depending on its value constraints. The model keeps
no per-field `required` array, so this means consulting the blueprint per field
kind.

### 9. The cross-validator agreement check has no home

Whether this library's reading of conformance matches the canonical Java
validator is worth knowing, cannot live in CEE, and needs both implementations
reachable. A `cedar-development` job, if it is worth having at all.

## Delivery Order

1. Settle the `wasSuccessful()` / `adheresToBlueprint()` meaning (item 4) and the
   error-versus-warning question, since both change what a published version
   promises.
2. Release (item 1). CEE unblocks here.
3. Close the envelope gap (item 2) and the empty-list workaround (item 3), which
   are the same defect class and are cheaper to test together.
4. Take the filename fix (item 5) with whichever release is convenient.
5. Resolve the corpus judgements (items 6 and 7) when someone with the version
   history is available.

## Out of Scope

- Reconciling this library with the Java one beyond what
  [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md) records as a defect on one
  side. Divergence that reflects a genuine CEDAR ambiguity is a corpus question,
  not a library one.
- Validating anything that requires the template at instance-read time. The
  reader's contract is that it reads an instance alone; `InstanceValidator` is
  where the template-aware checks live.
