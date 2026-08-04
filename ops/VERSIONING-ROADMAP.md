# CEDAR Terminology Versioning — Roadmap

Forward-looking plan for the model in [VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). What is already
built — content-hash identity, per-submission snapshots, all resolution modes, the canonical-iri
identity re-key with de-confliction, source-independence against OBO Foundry, multi-source ingest
(BioPortal, OBO Foundry, any URL, any OntoPortal — serving a non-BioPortal snapshot verified live on the
running server), `sourceSystem` routing (serve locally or report unavailable, never proxy BioPortal for a
non-BioPortal source), the value-constraint spec (JSON + YAML) with schema validation,
freeze-on-publish pinning all four constraint kinds on every artifact type (no value-set collection allow-list), multilingual label +
synonym capture (every language preserved outside content identity, backfilled across the served
catalog) and served on the local read path (multilingual + synonym search recall, synonyms on class
detail, `lang=<code>` on the class and integrated-search endpoints), and `owl:Ontology`-header identity
recovery for acronym-only ontologies — lives in git and the design doc. This tracks only what remains, in three buckets: **Pending** (to build), **Testing** (built, needs
live verification), and **Future** (deferred / needs a decision / speculative). Items are numbered
continuously as stable handles.

## Goal

Replace BioPortal for lookup wherever we can, and make every published template and filled instance
reproducible against pinned vocabulary versions. The versioning **backend (freeze-on-publish, catalog,
resolution) and the compact-YAML dialect are code-complete** — the version-aware YAML is published as a
preview only, pending production. The remaining gaps: the frontend (CEE sending the pin, the Workbench
version picker) and instance-level capture (item 5).

## Pending

- **1. CEE sends the pinned version at populate (frontend, small).** CEE is the relevant fill/presentation
   surface (the Workbench instance-fill path is not in scope). CEE already forwards the constraint objects
   by reference into `POST /bioportal/integrated-search`, so the change is small: carry `version` on the
   two CEE model POJOs, preserve it through `template-representation.factory.ts`, and map the template's
   VersionSpec `{id,…}` to the request's plain `version` string (send `version.id`). One call site, no
   fan-out. The single highest-value piece — it closes the reproducibility loop.
   *Backend caveat (not CEE's job):* integrated-search honours the pin only for locally-served,
   single-source constraints. For a non-local source, a multi-source/mixed shape, or a missing snapshot,
   a pinned request **fails loud** (`PinnedVersionUnavailableException`; mapped to HTTP 422) rather than
   silently serving latest from BioPortal. Enumerated `classes` cannot be pinned (no snapshot, by design).
   A non-BioPortal source that is not served locally is reported unavailable, not proxied to BioPortal.
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

## Testing

- **3. End-to-end frozen read (after CEE sends the pin, item 1).** Verify the full loop on the live stack:
   publish a frozen template → fill an instance via CEE → confirm terms resolve against the pinned
   snapshot, not latest. The terminology and publish sides are tested; this cross-service e2e becomes
   runnable once item 1 lands. Use a locally-served single-source constraint (the path where the backend
   honours the pin).

## Future

### 4. Is the content-identity label choice correct?

`version_id` is `normalizedContentHash` with labels included, which folds in each concept's single
`pref_label` — the English-preferred pick (English > untagged > any other; `rdfs:label` over
`skos:prefLabel`), plus the IRI-fragment fallback for label-less classes. Now that every language variant
and synonym is captured, that choice looks narrow on two counts. *Blindness:* two releases that differ
only in a French label, or only in a synonym, hash identically and collapse to one snapshot — a real
content change invisible to identity. *Arbitrariness:* identity turns on an English-first tie-break and on
synthetic IRI-fragment fallbacks, not on the vocabulary's own naming. Three directions: keep the
single-label hash (stable, but label-blind beyond the English pick); hash the full captured label set
(identity reflects all names in all languages, but any translation or synonym edit mints a new version);
or go structure-only (`includeLabels=false`) and treat all labels as display (most stable, but a pure
relabeling is then not a new version). The question is what "same version" should mean for a multilingual,
synonym-rich vocabulary. Off the current reproducibility path — freeze pins by the content-hash id
whatever it folds in — but a foundational identity decision, and now newly relevant because the labels
exist.

### 5. Instance-level version capture (design decision documented)

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

- **6. Retire the ontology-constraint `sourceUri` from the model/JSON.** The YAML half is done — it is no
   longer authored and is reconstructed from the acronym (its "non-derivable" premise was overturned:
   every ontology URL is BioPortal with the acronym as its path). What remains: the model still marks
   `uri` required and the JSON Schema still carries it. Fully retiring it needs the model field made
   optional (or the JSON side to derive it too) and the editor to stop writing it.


- **7. Lookup-coverage tail (replace-BioPortal track, orthogonal to versioning).** Improve display for the
   ~200 IRI-fragment-only ontologies (measured 2026-08-03 against the served catalog: ~240 snapshots serve
   the IRI code as the label, less ~40 false positives whose local names are real words — PROVO, RDFS, …)
   where a real label is recoverable. Dominated by HOOM (135k, `HP:` codes), XREF-FUNDER-REG (45k, numeric),
   SCHEMA (SNOMED numeric), GALEN, ICD-O-3, MCCL, DERMLEX, HORD. *The 4 quality-deferred cases are resolved:*
   BSAO and EHDAA reclaimed (the extractor now treats obo2owl's `TEMP#is_a` — an OBO `relationship: is_a` —
   as subsumption, and EHDAA is configured as a `part_of` partonomy; re-ingested and re-allowlisted), DDSS
   was already healthy (807k labelled classes), and EO1 stays BioPortal-served (its SKOS source is broken —
   `skos:broader` values are string literals, not IRIs).
- **8. Where `actions` belongs in the YAML.** `actions` (delete/move refinements on the term set)
   currently render as a field-level key, a sibling of `values`, naming each affected term by `termIri` +
   `sourceAcronym`. Open question: is that the right home, or should each action nest inside the `values`
   entry it refines, so a refinement travels with its source? Field-level keeps all actions in one place
   and mirrors the CEDAR JSON `_valueConstraints.actions` array; per-entry ties each refinement to the
   source it applies to but scatters actions across entries. Decide before the version-aware YAML ships.
- **9. Ingest ontologies from more sources.** *Shipped:* `--source url` (`DirectUrlSubmissionSource` —
   any URL) and `--source bioportal --base-url` (any OntoPortal instance: AgroPortal, EcoPortal, …).
   Proven across five serializations (RDF/XML, OBO, Turtle, gzipped OWL, SKOS) and nine authorities, with
   source-, serialization-, and host-independent content-hash identity confirmed on real data (BFO
   identical from OBO PURL `.owl`/`.obo` and AgroPortal REST; UNESCO identical from `.ttl`/`.rdf`). Running
   tally in the **Ingestion tracker (ongoing)** below; survey and method in
   [ONTOLOGY-INGEST-SOURCES.md](ONTOLOGY-INGEST-SOURCES.md). A constraint that names one of these sources
   already resolves correctly (serve locally or report unavailable). *Version currency (2026-08-03):* the
   served prod catalog's OBO ontologies (mostly stale BioPortal submissions) were refreshed to their
   current OBO Foundry release straight from their canonical PURLs by `ops/harvest-obo-ingest.sh` —
   155/158 due ingested (49 genuinely newer content, the rest already content-identical), leaving OGG
   (upstream PURL 404) and the giants GAZ + NCBITaxon for follow-up. *GAZ (2026-08-03):* attempted twice
   in server-down windows and it fails reliably on the download — the large PURL→Zenodo fetch outruns
   `DirectUrlSubmissionSource`'s HTTP client (once "closed", once a response-timeout timer-cancel). This
   needs a fetch fix, not a retry: pre-fetch to disk then ingest from the file, or raise/disable the
   response timeout for large downloads. Until then GAZ stays at its 2014 BioPortal snapshot; NCBITaxon
   stays deferred (too RAM/time-heavy). *Remaining:* the GAZ fetch fix + NCBITaxon giant-run; bulk-harvest
   OLS `fileLocation`s; label the OntoPortal authority on the snapshot (backend records `bioportal`
   regardless of instance).
- **10. Backfill `iri`/`sourceSystem` onto existing stored constraints.** A data migration over published
   CEDAR templates, not a code change — and not required for function, since tolerant readers already
   default a constraint with no `sourceSystem`/`iri` to BioPortal + acronym-derived resolution. Two halves:
   `sourceSystem` is a no-op (absent already means BioPortal everywhere it is read, including the router);
   `iri` (the canonical `sourceIri`) is the substantive part — it needs a new tool that walks each stored
   template's controlled-term constraints, looks up the acronym's canonical IRI from the terminology
   catalog (`ontologyIri(acronym)` — the only place that mapping lives), and rewrites the constraint where
   derivable, leaving the rest to defaults. Value is robustness/self-description (constraints carry their
   canonical identity explicitly, immune to acronym ambiguity and future cross-source resolution), not a
   functional gap. Do a zero-mutation dry-run first (report coverage and non-derivable acronyms) before any
   run against the live template store.
- **11. Serve captured multilingual labels (`lang=`). *Mostly shipped.*** Capture was already done (every
   snapshot preserves every language variant of every name, outside content identity, backfilled across the
   served catalog — see [MULTILINGUAL-LABELS.md](MULTILINGUAL-LABELS.md)). The read side is now live on the
   local serving path: multilingual + synonym **search recall** (a query in any language or against a
   synonym finds the concept), **synonyms** returned on class detail, and **`lang=<code>`** on the class
   endpoint and on integrated-search (result labels in the requested language, falling back to the default;
   verified live — searching "occupational" with `lang=fr` returns "professionnel"/"ergothérapie"). *Still
   deferred:* `lang=all` (the `{lang:value}` hash), `lang=` on the public `search`/tree output, and honoring
   the submission's `naturalLanguage` for the default (the default stays English-preferred) — all by
   decision, not blockers. *Coverage gap (found 2026-08-03):* the backfill did not reach every served
   snapshot — 275 of 1215 latest snapshots have an empty label side-table, including major ontologies
   (HP, MESH, NCIT, NCBITAXON, DDSS, LOINC, EFO). Their primary English labels serve fine, but the
   multilingual/synonym features above silently no-op for them. *Fix (staged, 2026-08-03):* a
   `--backfill-labels` run over the 274 empty bioportal-backed snapshots (NCBITaxon excluded as too heavy)
   is prepared but not yet completed — it needs a server-down window (RAM), and since each snapshot is
   re-fetched from BioPortal and re-extracted, the 10 remaining giants (DDSS, MESH, LOINC, NCIT, BERO, …)
   make it the long leg. Idempotent/resumable (skips snapshots that already carry labels), so it can stop
   and continue across windows. Freshly-ingested snapshots (e.g. the 49 OBO refreshes) already carry labels
   captured at ingest, so this is pure gap-fill.
- **12. Extend the value-constraint YAML to express a term's language.** A controlled-term constraint
   currently says nothing about language; a field always renders (and searches) labels in the served
   default. Add a key naming the language the field should present its terms in — `termLanguage`, or
   `termDefaultLanguage` if a field may hold values in several languages and the key only sets the default
   (name to be decided). On the read side it maps to the `lang=` the editor/CEE already sends to the
   terminology server (item 11); mostly a spec + editor addition, orthogonal to the identity question
   (item 4).
- **15. Name the title-less ontologies in the picker (low priority, cosmetic).** The ingest now takes an
   ontology's display name from BioPortal's metadata, then from its own `owl:Ontology` header title, then
   the acronym — and never downgrades a set name back to the acronym on re-ingest. That leaves the
   ontologies whose source declares no header title at all still showing the bare acronym in the picker:
   13 as of 2026-08-03 — VODANANIGERIA, MCHVODANATERMS, DSIP_FL_7, ETHANC, M4M-CHAR, OCDARREUSE, OCDARV1,
   OCDARWN, OCDARWNE, OCDO, RDL, REGN_BRO, STY1 (mostly VODAN/OCDAR/test/project artifacts). No automatic
   source exists, so each needs a hand-assigned title written to `ontology_source.name`. Cosmetic — the
   picker also shows the acronym — and cheap once the correct names are supplied; low priority.

### Open questions (authorities that don't fit the version model)

- **13. ORCID / ROR / RRID (and DOI): not versionable per se.** A constraint names the *authority*; the
   value is a stable identifier captured in the instance — no snapshot, no current-version. The spec
   already covers the shape (`sourceSystem` set, `version` omitted). Open question: how the editor and
   instance model represent authority-typed, value-captured, unversioned fields distinctly from a
   versioned controlled term. (The instance is where these land — see item 5.)
- **14. CompTox / PFAS (release-based databases): possibly versionable.** Content with releases, so they
   could fit the content-hash snapshot model *if* they expose retrievable content and release identifiers,
   and *if* a content hash of a flat set (a chemical list, not a hierarchy) is meaningful across
   serializations. Worth a spike.
- **16. Serve CDEs (and their vocabularies) as versioned fields? (exploratory.)** A Common Data Element
   (ISO 11179) is a `publicId + version` identity plus a *value domain*, and
   [cedar-cadsr-tools](https://github.com/metadatacenter/cedar-cadsr-tools) already reads caDSR CDEs as
   CEDAR fields through a near-lossless mapping that splits on the value domain: an **enumerated** domain
   becomes a value set (packaged today as the CADSR-VS value-set ontology and served through BioPortal, so
   already terminology), a **non-enumerated** domain becomes a plain datatype field (numeric/temporal/
   string bounds, no vocabulary at all). So the question splits in two. *Value sets:* move CADSR-VS onto
   the versioned terminology core as first-class, content-hashed value sets with `latest`/frozen resolution
   and cross-version diff, replacing the hand-built OWL packaging; low-risk, high-value, mostly a re-ingest
   path. *CDE-fields:* the whole field is a *definition* (value domain + datatype + constraints +
   provenance), a CEDAR artifact rather than a term, so serving it means either a **new artifact kind** in
   the versioning store (content-hash the field definition) or a **sibling CDE service** that reuses the
   versioning core while the artifact stays in the CEDAR repo. The fit is real because caDSR CDEs are
   already versioned the way this server versions things: `publicId+version` plus a `sourceHash`
   change-detector that a true content hash would make precise. So pinning, `latest`, diff, and
   freeze-on-publish apply one level up, to a whole field, and a CDE library (caDSR/NCI) becomes a
   versioned, diffable catalog beside the ontologies. Open: what a CDE's content identity is (its value
   domain only, or the whole definition — the same question as item 4); how instance-level capture
   (item 5) rides along when a filled value comes from a CDE; and that non-enumerated CDEs never involve a
   vocabulary, so they belong only to a CDE/field service, never the terminology server.
   A concrete authoring feature this points at: caDSR CDEs are already categorized in CEDAR by (possibly
   several) categories — the caDSR contexts and classification schemes cedar-cadsr-tools turns into CEDAR
   categories, each CDE attached to one or more. That category graph is a browsable hierarchy, structurally
   the same as an ontology tree, so a **CDE field** could let an author navigate the categories down to an
   individual CDE, reusing the roots/children/branch browse the terminology server already serves for
   ontology classes, with the CDE as the selectable leaf (a versioned field reference). Picking a CDE by
   category navigation is then the field-level analog of picking a class by ontology-branch navigation, and
   it gives the CDE-serving idea a concrete first surface: serve the category hierarchy and its CDE leaves,
   browsable and resolvable, before tackling full field-definition versioning.

## Ingestion tracker (ongoing)

An **iterative** task: updated each time more ontologies are ingested from other repositories (item 9).
Identity is the content hash, so the same release from multiple sources/serializations collapses to one
snapshot — the distinct-hash count is the true store size. Method/findings in
[ONTOLOGY-INGEST-SOURCES.md](ONTOLOGY-INGEST-SOURCES.md).

**As of 2026-08-01: 63 ontologies · 65 snapshots · 62 distinct content identities · 10 source systems**
(plus AgroPortal via the REST path, ingested in a separate run; plus EMI live in the served dev catalog).

| Source system | Access | Ontologies | Snapshots |
|---|---|---|---|
| EBI OLS `fileLocation`s | `--source url` | 40 | 40 |
| OBO PURL / GO release server | `--source url` | 8 | 10 |
| W3C (`w3.org`) | `--source url` | 5 | 5 |
| w3id.org | `--source url` | 3 | 3 |
| UNESCO (SKOS) | `--source url` | 2 | 2 |
| schema.org · id.loc.gov (LCSH, SKOS) · GitHub raw · FOAF · vendor | `--source url` | 5 | 5 |
| AgroPortal | `--source bioportal --base-url` | 1 | 1 |

Serializations exercised: RDF/XML, OBO, Turtle, gzipped OWL, SKOS, N-Triples input. Version pairs (same
ontology, distinct content hashes): GO-basic (2024-01-17 vs 2025-06-01), PATO (2022-12-15 vs 2024-03-28).

**Iterations**
- 2026-08-01 — first batch: 18 ingested (format/host/version matrix + AgroPortal), source-independence
  proven (BFO ×3 authorities, UNESCO ×2 serializations → one hash each).
- 2026-08-01 — +46 (40 small OLS ontologies via their fileLocations; FOAF/SSN/SOSA/HP; GO-basic ×2 for a
  version pair). 3 external failures: GEMET (SSL cert-chain), FOAF-from-LOV (502), schema.org v20 (404) —
  source-side, not the ingester.
- 2026-08-01 — served-store proof: EMI (backend=url) ingested into the live dev catalog + allowlist; the
  running server serves it locally, unpinned and pinned (frozen read), verified over REST.
- 2026-08-03 — OBO **currency** pass over the **served prod catalog** (distinct from the expansion store
  above): `ops/harvest-obo-ingest.sh` pulled the current release of every active OBO Foundry ontology from
  its canonical PURL, mapping each id to the acronym prod already uses and skipping ones already current.
  190 active → 32 already current, 158 due → **155 ingested** (prod 1284→1333 snapshots, 1262→1310
  hashes = **49 genuinely-newer refreshes**: GO, UBERON, MP, OBI, ECO, PO, FOODON, RO, RXNO, EMAPA, …; the
  rest merged content-identical). 3 failed: OGG (PURL 404, upstream), GAZ + NCBITaxon (too RAM/time-heavy —
  deferred to a giant-run with the server stopped). New `latest` snapshots serve after a terminology restart.

**Next iterations** are one command — `ops/harvest-ols-ingest.sh` (source expansion) and
`ops/harvest-obo-ingest.sh` (OBO release currency), both `<catalog> <snapshotDir> [--max N]`, idempotent,
skipping already-current acronyms and logging/skipping failures. Remaining: the GAZ fetch fix (its
PURL→Zenodo download outruns the HTTP client) + NCBITaxon giant-run; the staged label backfill of the 274
empty-label snapshots (item 11);
bulk-harvest the rest of the OLS fileLocations; add more OntoPortal instances (EcoPortal, IndustryPortal,
each needs its own key); retry the transient failures; grow version pairs from dated OBO/GO releases.
