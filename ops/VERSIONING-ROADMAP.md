# CEDAR Terminology Versioning — Roadmap

Forward-looking plan for the model in [VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). What is already
built — content-hash identity, per-submission snapshots, all resolution modes, the canonical-iri
identity re-key with de-confliction, source-independence against OBO Foundry, multi-source ingest, the
value-constraint spec (JSON + YAML) with schema validation, and freeze-on-publish pinning all four
constraint kinds on every artifact type — lives in git and the design doc. This tracks only what
remains, in three buckets: **Pending** (to build), **Testing** (built, needs live verification), and
**Future** (deferred / needs a decision / speculative). Items are numbered continuously as stable
handles.

## Goal

Replace BioPortal for lookup wherever we can, and make every published template and filled instance
reproducible against pinned vocabulary versions. The versioning **backend (freeze-on-publish, catalog,
resolution) and the compact-YAML dialect are code-complete** — the version-aware YAML is published as a
preview only, pending production. The remaining gaps: the frontend (CEE sending the pin, the Workbench
version picker), integrated-search honouring the pin beyond locally-served single-source constraints
(item 3), and instance-level capture (item 7).

## Pending

- **1. CEE sends the pinned version at populate (frontend, small).** CEE is the relevant fill/presentation
   surface (the Workbench instance-fill path is not in scope). CEE already forwards the constraint objects
   by reference into `POST /bioportal/integrated-search`, so the change is small: carry `version` on the
   two CEE model POJOs, preserve it through `template-representation.factory.ts`, and map the template's
   VersionSpec `{id,…}` to the request's plain `version` string (send `version.id`). One call site, no
   fan-out. The single highest-value piece — it closes the reproducibility loop.
   *Backend caveat (not CEE's job):* integrated-search honours the pin only for locally-served,
   single-source constraints. For a non-local source, a multi-source/mixed shape, or a missing snapshot,
   a pinned request now **fails loud** (`PinnedVersionUnavailableException`; mapped to HTTP 422) rather
   than silently serving latest from BioPortal. Enumerated `classes` cannot be pinned (no snapshot, by
   design). Actually *serving* those pinned cases (rather than failing) folds into item 3.
- **2. Author-facing version picker in the Workbench (frontend-only).** The picker lives in the old
   AngularJS Workbench (`cedar-template-editor/app/scripts/controlled-term/`), where constraints are
   authored. **No backend work:** `GET /ontologies/{acronym}/versions` (and `/versions/current`, `/diff`)
   already exist and hit the version-aware store. Frontend work: add a `controlledTermDataService` method
   to fetch the version list, drop a version `<select>` into the picker across the four parallel staging
   builders (ontology/branch/class/valueSet) plus the staging and summary tables, plumb the selected
   ontology's version list across the search/controller directive boundary, and persist `version` on each
   constraint object (the write path is permissive, so the key sticks). Offer version for
   ontology/branch/valueSet only — not individual classes. Moderate-to-nasty by breadth (four parallel
   paths, ~5 duplicated modal hosts), not depth.
- **3. Terminology routing on `sourceSystem` (backend, ready now).** Route a constraint to its named source
   rather than assuming BioPortal — a natural extension of the existing per-ontology routing.
- **4. Backfill `iri`/`sourceSystem` on existing constraints (backend, ready now)** where derivable; leave
   the rest to defaults.

## Testing

- **5. Serve a non-BioPortal snapshot end to end.** The CLI (`IngestJob --source obofoundry`) and
   content-hash identity are done and unit-verified; the live step remains — ingest into the *served* dev
   catalog, add the acronym to `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES`, restart, and confirm the running
   server serves/resolves an OBO-Foundry-sourced snapshot. Mutates the running serving config.
- **6. End-to-end frozen read (after CEE sends the pin, item 1).** Verify the full loop on the live stack:
   publish a frozen template → fill an instance via CEE → confirm terms resolve against the pinned
   snapshot, not latest. The terminology and publish sides are tested; this cross-service e2e becomes
   runnable once item 1 lands. Use a locally-served single-source constraint (the path where the backend
   honours the pin).

## Future

### 7. Instance-level version capture (design decision documented)

Freeze pins the *constraint* to a vocabulary version; this pins the *filled value*. When a user picks a
term, the instance should record which term **and which version it came from**, so a filled instance is
reproducible even when the constraint said `latest`, and so unversioned-authority values carry provenance.

**Why it matters — three cases:** (1) an unfrozen (`latest`) constraint — capture records the version
current at fill time, else "latest" drifts and the value's label/hierarchy can't be reproduced;
(2) open authorities (ORCID/ROR/RRID) have no version to freeze, so the instance is where `sourceSystem`
plus the captured identifier live; (3) audit — verify a value was resolved against the pinned snapshot.

**Proposed value shape (self-identifying):**

```json
{
  "@id": "http://purl.obolibrary.org/obo/DOID_9351",
  "rdfs:label": "diabetes mellitus",
  "sourceSystem": "bioportal",
  "sourceIri": "http://purl.obolibrary.org/obo/doid",
  "version": { "id": "63ef56df…", "effectiveDate": "2026-07-01", "declaredVersion": "2026-06-30" }
}
```

**What actually pins the value:** `@id` (the term) + `sourceIri` (its ontology's canonical identity) +
`version.id` (the content hash of that ontology's exact snapshot; within it `@id` resolves to one concept
state — label, parents, obsolete flag). The rest is provenance/display: `rdfs:label` is a display cache
and consistency check, `effectiveDate` / `declaredVersion` are human labels, `sourceSystem` says where to
fetch it.

**Why `sourceIri` is needed, not just `@id` + `version.id`:** `version.id` is unique only *within* an
ontology — snapshots are partitioned by ontology identity, and two ontologies can share a content hash
(byte-identical downloads). So `version.id` is not globally unique; today you would infer the owning
ontology from `@id`'s namespace, which breaks for generic-base ontologies (the de-confliction case).
`sourceIri` (the canonical, source-independent ontology identity) *is* that partition: `sourceIri` +
`version.id` names one exact snapshot, using the same `source*` vocabulary as the constraint side. (The
physical catalog keys snapshots on `(version_id, acronym)` because BioPortal is acronym-addressed;
`acronym` is the addressing handle that stands in for the `sourceIri` identity.)

**The hard limit — uniqueness ≠ resolvability:** `sourceIri` + `version.id` *names* one snapshot, but the
term's actual state is retrievable only while that snapshot is *archived* (the local store, or a
reproducible re-ingest). The pin is reproducible for as long as the snapshot is retained.

**Open decisions:** (a) shape — inline additive fields on the value object (recommended; additive,
tolerant-reader-compatible) vs a sidecar provenance structure; (b) granularity — per-value (a field can
hold values from different versions) vs per-field vs one per-instance; (c) when — always (best for audit)
vs only when the constraint was `latest`; (d) whether versioned vocabularies and unversioned authorities
share one shape (`sourceSystem` always, `version` when versioned). **Recommendation:** inline additive
`sourceSystem`/`sourceIri`/`version`, per-value, captured whenever the value comes from a source, one
shape for both.

**Cross-cutting:** the model representation (instance schema + tolerant readers) is backend; the capture
happens at fill time in the editor/CEE, reading the version from the terminology server's resolve-current
response.

### Other deferred backend work

- **8. Retire the ontology-constraint `sourceUri` from the model/JSON.** The YAML half is done — it is no
   longer authored and is reconstructed from the acronym (see [Revisit](#revisit); its "non-derivable"
   premise was overturned). What remains: the model still marks `uri` required and the JSON Schema still
   carries it. Fully retiring it needs the model field made optional (or the JSON side to derive it too)
   and the editor to stop writing it.
- **9. `owl:Ontology`-header IRI derivation.** Parse the ontology header at ingest as an extra iri source,
   to restore a clean identity for import-leaked non-OBO ontologies (NCIT on `Thesaurus.owl`) that
   de-confliction leaves acronym-only.
- **10. Relax the value-set collection cap.** Integrated-search restricts a value-set constraint to three
    collections (CEDARVS/NLMVS/CADSR-VS) via `BP_VS_COLLECTIONS_READ_REGEX`; a frozen value-set constraint
    on any other collection 422s at populate.
- **11. Surface ambiguous-declared-version resolution.** Off the reproducibility path (freeze pins by
    content-hash `id`, not the declared-version label). Return the ambiguous-declared-version WARN in the
    response; optionally expose `/versions`, `/versions/diff`, and provenance.
- **12. Lookup-coverage tail (replace-BioPortal track, orthogonal to versioning).** IRI-fragment label
    fallback for the 179 zero-label ontologies; reclaim the 4 quality-deferred (DDSS re-ingest,
    EHDAA/BSAO/EO1 0-edge extraction — issue #12).
- **13. Where `actions` belongs in the YAML.** `actions` (delete/move refinements on the term set)
    currently render as a field-level key, a sibling of `values`, naming each affected term by `termIri`
    + `sourceAcronym`. Open question: is that the right home, or should each action nest inside the
    `values` entry it refines, so a refinement travels with its source? Field-level keeps all actions in
    one place and mirrors the CEDAR JSON `_valueConstraints.actions` array; per-entry ties each
    refinement to the source it applies to but scatters actions across entries. Decide before the
    version-aware YAML ships.

### Open questions (authorities that don't fit the version model)

- **14. ORCID / ROR / RRID (and DOI): not versionable per se.** A constraint names the *authority*; the
    value is a stable identifier captured in the instance — no snapshot, no current-version. The spec
    already covers the shape (`sourceSystem` set, `version` omitted). Open question: how the editor and
    instance model represent authority-typed, value-captured, unversioned fields distinctly from a
    versioned controlled term. (The instance is where these land — see item 7.)
- **15. CompTox / PFAS (release-based databases): possibly versionable.** Content with releases, so they
    could fit the content-hash snapshot model *if* they expose retrievable content and release
    identifiers, and *if* a content hash of a flat set (a chemical list, not a hierarchy) is meaningful
    across serializations. Worth a spike.
