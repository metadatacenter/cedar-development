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

3. **[next: backend] YAML serialization of the version spec.** The JSON reader + schema validation
   carry `iri`/`sourceSystem`/`version`; the YAML reader/renderer do not yet (legacy YAML round-trips
   unchanged). The one bounded backend task still open on the versioning path — peripheral, since JSON
   is the primary wire format.

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

8. **[later: backend] `owl:Ontology`-header IRI derivation.** Parse the ontology header at ingest as
   an extra iri source, to restore a clean identity for import-leaked non-OBO ontologies (NCIT on
   `Thesaurus.owl`) that de-confliction currently leaves acronym-only.

9. **[later: backend] Relax the value-set collection cap.** Integrated-search restricts a value-set
   constraint to three collections (CEDARVS / NLMVS / CADSR-VS) via `BP_VS_COLLECTIONS_READ_REGEX`; a
   frozen value-set constraint on any other collection 422s at populate. Relax to any served
   collection if needed.

10. **[later: backend] Surface ambiguous-declared-version resolution.** Off the reproducibility path —
    freeze pins by content-hash `id`, not the declared-version label. Return the ambiguous-declared-
    version WARN in the response so a caller pinning a non-unique label learns it resolved to the
    newest match; optionally expose `/versions`, `/versions/diff`, and provenance.

11. **[later: backend, orthogonal] Lookup-coverage tail.** IRI-fragment label fallback for the 179
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
