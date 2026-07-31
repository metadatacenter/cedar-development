# CEDAR Terminology Versioning — Roadmap

Forward-looking plan for the model in [VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). What is already
built — content-hash identity, per-submission snapshots, all resolution modes, the canonical-iri
identity re-key with de-confliction, source-independence against OBO Foundry, multi-source ingest, the
value-constraint spec (JSON + YAML) with schema validation, and freeze-on-publish pinning all four
constraint kinds on every artifact type — lives in git and the design doc. This tracks only what
remains, in three buckets: **Pending** (to build), **Testing** (built, needs live verification), and
**Future** (deferred / needs a decision / speculative).

## Goal

Replace BioPortal for lookup wherever we can, and make every published template and filled instance
reproducible against pinned vocabulary versions. The versioning **backend is complete**; the remaining
reproducibility gap is in the frontend (the editor sending and choosing versions) and in instance-level
capture.

## Pending

- **Editor/CEE sends the pinned version at populate (frontend).** Put a published template constraint's
  `version` into the integrated-search request so terms resolve at the pinned snapshot. The terminology
  server already honours the pin end to end; today the app sends latest, so freeze writes pins the app
  never reads back. The single highest-value piece — it closes the reproducibility loop.
- **Author-facing version picker (frontend).** The editor emits the richer constraint shape (the
  `source*`/`term*`/`version` keys) and shows a version picker (declaredVersion · effectiveDate · short
  hash; `latest` default).
- **Terminology routing on `sourceSystem` (backend, ready now).** Route a constraint to its named source
  rather than assuming BioPortal — a natural extension of the existing per-ontology routing.
- **Backfill `iri`/`sourceSystem` on existing constraints (backend, ready now)** where derivable; leave
  the rest to defaults.

## Testing

- **Serve a non-BioPortal snapshot end to end.** The CLI (`IngestJob --source obofoundry`) and
  content-hash identity are done and unit-verified; the live step remains — ingest into the *served* dev
  catalog, add the acronym to `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES`, restart, and confirm the running
  server serves/resolves an OBO-Foundry-sourced snapshot. Mutates the running serving config.
- **End-to-end frozen read (after the editor sends the pin).** Verify the full loop on the live stack:
  publish a frozen template → populate an instance → confirm terms resolve against the pinned snapshot,
  not latest. The terminology and publish sides are tested; this cross-service e2e becomes runnable once
  the Pending frontend work lands.

## Future

### Instance-level version capture (design decision documented)

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

**What actually pins the value:** `@id` (the term) + `version.id` (the content hash of the exact ontology
snapshot; within it `@id` resolves to one concept state — label, parents, obsolete flag). The rest is
provenance/display: `rdfs:label` is a display cache and consistency check, `effectiveDate` /
`declaredVersion` are human labels, `sourceSystem` says where to fetch it.

**Why `sourceIri` is needed, not just `@id` + `version.id`:** the catalog keys snapshots on
`(version_id, acronym)`, not `version_id` alone — two ontologies can share a content hash (byte-identical
downloads). So `version.id` is not globally unique; today you would infer the owning ontology from
`@id`'s namespace, which breaks for generic-base ontologies (the de-confliction case). Carrying
`sourceIri` (the canonical, source-independent ontology identity) ties `version.id` to its ontology
unambiguously, using the same `source*` vocabulary as the constraint side.

**The hard limit — uniqueness ≠ resolvability:** `version.id` uniquely *names* the snapshot, but the
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

- **Retire the ontology-constraint `sourceUri`.** Functionally unused on the backend (the terminology
  DTO omits it; artifact-library only serializes/passes it through), kept only because the model marks it
  required and it is non-derivable. Retiring needs the model field made optional and the editor to stop
  writing it.
- **`owl:Ontology`-header IRI derivation.** Parse the ontology header at ingest as an extra iri source,
  to restore a clean identity for import-leaked non-OBO ontologies (NCIT on `Thesaurus.owl`) that
  de-confliction leaves acronym-only.
- **Relax the value-set collection cap.** Integrated-search restricts a value-set constraint to three
  collections (CEDARVS/NLMVS/CADSR-VS) via `BP_VS_COLLECTIONS_READ_REGEX`; a frozen value-set constraint
  on any other collection 422s at populate.
- **Surface ambiguous-declared-version resolution.** Off the reproducibility path (freeze pins by
  content-hash `id`, not the declared-version label). Return the ambiguous-declared-version WARN in the
  response; optionally expose `/versions`, `/versions/diff`, and provenance.
- **Lookup-coverage tail (replace-BioPortal track, orthogonal to versioning).** IRI-fragment label
  fallback for the 179 zero-label ontologies; reclaim the 4 quality-deferred (DDSS re-ingest,
  EHDAA/BSAO/EO1 0-edge extraction — issue #12).

### Open questions (authorities that don't fit the version model)

- **ORCID / ROR / RRID (and DOI): not versionable per se.** A constraint names the *authority*; the value
  is a stable identifier captured in the instance — no snapshot, no current-version. The spec already
  covers the shape (`sourceSystem` set, `version` omitted). Open question: how the editor and instance
  model represent authority-typed, value-captured, unversioned fields distinctly from a versioned
  controlled term. (The instance is where these land — see Instance-level version capture.)
- **CompTox / PFAS (release-based databases): possibly versionable.** Content with releases, so they
  could fit the content-hash snapshot model *if* they expose retrievable content and release identifiers,
  and *if* a content hash of a flat set (a chemical list, not a hierarchy) is meaningful across
  serializations. Worth a spike.
