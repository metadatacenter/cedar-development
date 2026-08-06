# CEDAR Model TypeScript Library — Roadmap

Outstanding work for `cedar-model-typescript-library`. CEE-side work belongs in
[CEE-ROADMAP.md](./CEE-ROADMAP.md); backend and cross-service work in
[DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md). Where this library and the
Java one disagree is recorded in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md),
and the case for CEE adopting the library at all in
[CEE-MODEL-LIBRARY-ADOPTION.md](./CEE-MODEL-LIBRARY-ADOPTION.md).

This roadmap tracks open work only. Closed items are removed and the rest
renumbered, so a number identifies an item today and nothing beyond today.

> **Commit-message rule:** Never refer to roadmap items or item numbers in commit
> or check-in messages — renumbering makes any such reference wrong. Describe the
> concrete change and affected surface.

## Current position

- 63 suites and 639 tests. Every push to `develop` runs them and builds the
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
  template/instance pairs as its false-positive net. One pair, `cee-suite/002`,
  does not conform — its template declares `minItems: 10` and its instance holds
  two values — and is pinned in `KNOWN_NONCONFORMANT` with a test that fails if it
  ever starts conforming. Recorded rather than tracked: no one is waiting on it.
- The two verdicts on a parse differ. `wasSuccessful()` counts errors, so it
  answers whether the artifact is usable; `adheresToBlueprint()` counts warnings
  too, so it answers whether the document is in the canonical form. A pre-2024
  template is successful and does not adhere.
- An instance is read against the envelope it should carry — `@context`, `@id`,
  `schema:isBasedOn` and the four provenance keys. Gaps are warnings, so the 35
  of 120 corpus instances that are merely incomplete still read successfully
  while no longer claiming to adhere.
- `0.9.2-dev.20260805.4105f7c` is published to Nexus under the `dev` dist-tag,
  built from develop with all of the above in it, and CEE consumes it. Nothing is
  tagged `latest`, so asking for the package without a version still resolves to
  nothing — a stable release is item 1.

## Critical Path

### 1. Release the library

Nothing downstream can move until this ships. CEE has a written conformance spec
it cannot run and no check at all on its own output in the meantime — see
[CEE-ROADMAP.md](./CEE-ROADMAP.md) item 7.

Two decisions, then a publish:

- Whether this is `0.10.0` rather than `0.9.x`. The question is real rather than
  ceremonial, and there are now two reasons: `wasSuccessful()` on an instance
  parse could only ever return true before and can now return false, and
  `adheresToBlueprint()` has stopped being a second name for it. Any consumer
  branching on either sees new behavior.
- Which version field is authoritative. `package.json` says `0.9.0` and
  `package-dist.json` says the prerelease above; the dist one is what publishes.

The errors-versus-warnings question is settled and needs no further decision. A
document that cannot be right is an error — a null `@id`, a value carrying the
wrong `@type`. A document that is merely incomplete or written in a superseded
form is a warning, because the corpus proves such documents exist and a reader
that rejects them is useless. `adheresToBlueprint()` is where a caller wanting
the strict reading goes.

## Corpus

A judgement about what the corpus means, rather than a code change. It needs
someone who knows CEDAR's version history.

### 2. Temporal `required` is inconsistent across the corpus

28 templates require `@type` on a temporal value, 27 do not, and 12 require
nothing. The blueprint comparison does not check field-level `required`, so it
flags none of them. `InstanceValidator` requires `@type` always — stricter than
roughly half the corpus, on the grounds that the field declares a `temporalType`
and so the value is a typed literal. That was a judgement, and it should be an
explicit one.

## Deferred

### 3. Widen instance validation to per-field value-node `required`

A template states `required: ["@value"]` per field, so "this value node is
missing the key its own schema demands" is checkable without inferring anything
from `uiInputType` — which cannot be inferred from anyway, since a `textfield`
may hold a literal or an IRI depending on its value constraints. The model keeps
no per-field `required` array, so this means consulting the blueprint per field
kind.

## Delivery Order

1. Release (item 1). Everything that changes what a published version promises
   has landed, so this is now the only thing between the library and CEE.
2. Settle the temporal `required` judgement (item 2) when someone with the version
   history is available. It does not block a release.
3. Revisit the deferred item (item 3) only if a consumer asks for it.

## Out of Scope

- Reconciling this library with the Java one beyond what
  [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md) records as a defect on one
  side. Divergence that reflects a genuine CEDAR ambiguity is a corpus question,
  not a library one.
- Validating anything that requires the template at instance-read time. The
  reader's contract is that it reads an instance alone; `InstanceValidator` is
  where the template-aware checks live.
