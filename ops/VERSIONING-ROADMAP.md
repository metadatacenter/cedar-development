# CEDAR Terminology Versioning — Roadmap

Forward-looking plan for the model in [VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). What is already
built — content-hash identity, per-submission snapshots, resolve-current / as-of-date /
declared-version resolution, the canonical-iri identity re-key with de-confliction,
source-independence proven against OBO Foundry, the additive value-constraint spec with schema
validation, and freeze-on-publish pinning all four constraint kinds on every artifact type — lives in
git history and the design doc. This tracks only what remains.

Status keys: **[next]** ready to start · **[blocked]** waiting on a decision or another repo ·
**[later]** deferred.

## Goal

Replace BioPortal for lookup wherever we can: serve every ontology we hold locally, for both search
and browse, deferring to BioPortal only for licensed or un-ingestable content. This is inseparable
from versioning — a version pin can only be honoured on the local path, so version-pinnable dynamic
lookup requires local serving.

## Current state

The versioning **backend is essentially complete**: identity, snapshots, all resolution modes, the
iri re-key + de-confliction, multi-source ingest, the value-constraint spec + validation, and
freeze-on-publish — with the terminology server honouring a pinned version at populate for all four
constraint kinds. The remaining gap is the **frontend**: the editor does not yet send a published
template's pinned version when populating (so it still requests latest), nor let authors see or choose
versions. Closing that last mile is the reproducibility payoff.

## Remaining Work

Priority order; the kind of work is tagged per item.

1. **[blocked: frontend] Editor/CEE sends the pinned version at populate.** Put a published template
   constraint's `version` into the integrated-search request so terms resolve at the pinned snapshot.
   The terminology server already honours a pin end to end; today the app sends latest, so freeze
   writes pins the app never reads back. This closes the reproducibility loop and is the single
   highest-value piece.

2. **[blocked: frontend] Author-facing version picker.** The editor emits the richer constraint shape
   and shows a version picker (declaredVersion · effectiveDate · short hash; `latest` default), plus
   tolerant readers in the remaining frontend consumers.

3. **[done 2026-08-01: backend] YAML serialization of the version spec + a value-constraint key
   overhaul** (cedar-artifact-library develop `9e057c2`). Renderer + reader reworked to the shape below;
   golden YAML fixtures regenerated via `GoldenYamlGenerator` (51 changed, a balanced key-rename diff);
   a new round-trip proves a frozen constraint's `sourceIri`/`sourceSystem`/`version` survive YAML;
   suite 705 → 706 green; resource-server compiles unchanged. **Two doc follow-ups remain:** the
   scattered javadoc example blocks in `YamlArtifactRenderer` still show old keys (cosmetic), and the
   external YAML spec doc (https://metadatacenter.readthedocs.io/en/latest/yaml-spec/) needs the new
   keys. The shape, per entry under `values:`:
   - **source group** — `sourceSystem` (backend; absent ⇒ bioportal), `sourceAcronym` (was `acronym`;
     the resolution handle), `sourceName` (was `ontologyName`/`valueSetName`; absent on class),
     `sourceIri` (was the additive `iri`; canonical cross-source identity = the *source vocabulary's*
     iri, incl. for class/branch), and — **ontology only** — `sourceUri` (was the mis-keyed `iri`; the
     ontology's backend URL).
   - **term group** — `termIri` (class; the specific term) / `termBaseIri` (branch, valueSet; the base
     of a term set), `termType` (class), `termLabel`, `termMaxDepth` (was `maxDepth`), `termCount` (was
     `numTerms`; ontology, valueSet).
   - **`version`** — the pinned triple `{id, effectiveDate, declaredVersion}`, or the string `latest`.

   Notes: legacy/unpinned entries omit `sourceSystem`/`sourceIri`/`version` (⇒ bioportal / acronym-
   derived / latest). The ontology `uri` is **kept** (as `sourceUri`), not dropped-and-reconstructed —
   it is a required, non-derivable field (MESH uses `bioportal.bioontology.org`, DOID uses
   `data.bioontology.org`), so reconstruction would corrupt round-trips. Implement: renderer + reader
   key renames, add `sourceSystem`/`sourceIri`/`version` on all four kinds, update YAML test fixtures,
   round-trip tests. Peripheral to reproducibility (JSON is the primary wire format) but the naming
   overhaul touches the shared dialect. **Also update the external YAML spec doc**
   (https://metadatacenter.readthedocs.io/en/latest/yaml-spec/) to match the new value-constraint keys.

4. **[next: backend] Terminology routing on `sourceSystem`.** Route a constraint to its named source
   rather than assuming BioPortal — a natural extension of the existing per-ontology routing.

5. **[next: backend] Backfill `iri`/`sourceSystem` on existing constraints** where derivable; leave
   the rest to defaults.

6. **[operator action] Serve a non-BioPortal snapshot.** Ingest into the *served* dev catalog with
   `IngestJob --source obofoundry` and add the acronym to `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES`, then
   restart, so the running server serves a non-BioPortal snapshot. The CLI and identity path are done;
   this mutates the running serving config.

7. **[blocked: design decision] Instance-level version capture.** Record which vocabulary version was
   in effect when a value was selected, in the instance itself — carries provenance for an
   unversioned-constraint authority, and pins the actual term even when the constraint said `latest`.
   Needs a decision on the instance representation before implementation.

8. **[later] Retire the ontology-constraint `uri` (`sourceUri`).** It is **functionally unused on the
   backend** and we'd like to remove it. Verified: the terminology server's integrated-search
   `OntologyValueConstraint` DTO has no `uri` at all (resolution is acronym-addressed — `GET
   /ontologies/{acronym}/classes/…` off a fixed API base — so the ontology URL is never a resolution
   key, not even for ontology constraints); in cedar-artifact-library `ontology.uri()` is read only by
   the YAML renderer (to serialize it) and the freezer at line 76 (which just copies it through when
   adding `version`). Nothing decides anything from it. It survives only because the model marks it
   **required** and it is **non-derivable** (MESH's host ≠ DOID's), so it must round-trip. Retiring it
   is a cross-cutting change: make the model field optional, stop the editor writing it (it's whatever
   BioPortal's picker returns as the ontology `@id` — check for a "view in BioPortal" display use
   first), then drop it from the serializers and backfill. Until then it stays as `sourceUri`, named
   honestly as the legacy locator rather than dignified as identity. `sourceIri` is the identity we
   build on; `sourceAcronym` does the addressing.

9. **[later: backend] `owl:Ontology`-header IRI derivation.** Parse the ontology header at ingest as
   an extra iri source, to restore a clean identity for import-leaked non-OBO ontologies (NCIT on
   `Thesaurus.owl`) that de-confliction currently leaves acronym-only.

10. **[later: backend] Relax the value-set collection cap.** Integrated-search restricts a value-set
   constraint to three collections (CEDARVS / NLMVS / CADSR-VS) via `BP_VS_COLLECTIONS_READ_REGEX`; a
   frozen value-set constraint on any other collection 422s at populate. Relax to any served
   collection if needed.

11. **[later: backend] Surface ambiguous-declared-version resolution.** Off the reproducibility path —
    freeze pins by content-hash `id`, not the declared-version label. Return the ambiguous-declared-
    version WARN in the response so a caller pinning a non-unique label learns it resolved to the
    newest match; optionally expose `/versions`, `/versions/diff`, and provenance.

12. **[later: backend, orthogonal] Lookup-coverage tail.** IRI-fragment label fallback for the 179
    zero-label ontologies; reclaim the 4 quality-deferred (DDSS big-heap re-ingest, EHDAA/BSAO/EO1
    0-edge extraction — issue #12). On the replace-BioPortal track, not the version model.

## Open Questions (to think about, not scheduled)

The "authorities" that do not fit the ontology version model cleanly. Each is a question to settle
before committing work, not a scheduled item.

- **Open-authority identifiers — ORCID, ROR, RRID (and DOI): not versionable per se.** A constraint
  here names the *authority*, and the **value is a stable identifier captured in the instance** (an
  ORCID iD, a ROR ID). There is no snapshot and no current-version to pin — "resolve-current" has no
  meaning for "an ORCID." The spec already covers this shape (`sourceSystem` set, `version` omitted).
  The open question is how the editor and instance model should represent *authority-typed,
  value-captured, unversioned* fields distinctly from a versioned controlled term — not whether to
  version them (they cannot be).

- **CompTox / PFAS (and similar release-based databases): possibly versionable.** Unlike identifier
  authorities, EPA CompTox and PFAS lists are **content with releases**, so in principle they could fit
  the content-hash snapshot model — ingest a release, hash the extracted model, snapshot, resolve/pin —
  if they expose retrievable content and release identifiers. Open questions: do they expose those, and
  is a content hash of a **flat set** (a chemical list is not a subsumption hierarchy) meaningful and
  stable across a release's serializations? Worth a spike before assuming either way.
