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
recovery for acronym-only ontologies — lives in git and the design doc. The numbered items track only
what remains, in three buckets: **Pending** (to build), **Testing** (built, needs live verification),
and **Future** (deferred / needs a decision / speculative). Items are numbered continuously as stable
handles.

The sections after the numbered items are findings rather than plans, and stay put: the running
[ingestion tracker](#ingestion-tracker-ongoing), the
[BioPortal reconciliation issues](#bioportal-reconciliation-issues) log that motivated the model, and
the [survey of ingesting from other repositories](#ingesting-from-other-repositories). What the store
captures and serves for multilingual labels is part of the model rather than a plan, and lives in
[VERSIONING-DESIGN.md](VERSIONING-DESIGN.md#10-multilingual-labels); item 4 below is the open
question about it.

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
- **8. Ingest ontologies from more sources.** *Shipped:* `--source url` (`DirectUrlSubmissionSource` —
   any URL) and `--source bioportal --base-url` (any OntoPortal instance: AgroPortal, EcoPortal, …).
   Proven across five serializations (RDF/XML, OBO, Turtle, gzipped OWL, SKOS) and nine authorities, with
   source-, serialization-, and host-independent content-hash identity confirmed on real data (BFO
   identical from OBO PURL `.owl`/`.obo` and AgroPortal REST; UNESCO identical from `.ttl`/`.rdf`). Running
   tally in the **Ingestion tracker (ongoing)** below; survey and method under
   [Ingesting from other repositories](#ingesting-from-other-repositories). A constraint that names one of these sources
   already resolves correctly (serve locally or report unavailable). *Version currency (done):* the served
   prod catalog's OBO ontologies were refreshed to their current OBO Foundry release via
   `ops/harvest-obo-ingest.sh` (155/158, 49 genuinely-newer refreshes — logged in the tracker), and GAZ
   ingested once its download timeout was raised to 90 min (commit `f66b1bb`). *Remaining:* NCBITaxon
   (deferred, too RAM/time-heavy); bulk-harvest OLS `fileLocation`s; label the OntoPortal authority on the
   snapshot (backend records `bioportal` regardless of instance).
- **9. Backfill `iri`/`sourceSystem` onto existing stored constraints.** A data migration over published
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
- **10. Remaining multilingual read-side options (deferred by decision).** Done and in the "Built" list:
   capture, serving (search recall, synonyms, `lang=<code>` on the class and integrated-search endpoints),
   and the label backfill — `--backfill-labels-from-raw` (re-extract from the retained local raw matched by
   `file_hash`, no version-id gate since labels key by IRI) added +5.6M labels across the served catalog.
   Residual data gap is item 13 (9 raw-less ontologies). Still open here, *by decision not blockers:*
   `lang=all` (the `{lang:value}` hash), `lang=` on the public `search`/tree output, and honoring the
   submission's `naturalLanguage` for the default (stays English-preferred).
- **11. Extend the value-constraint YAML to express a term's language.** A controlled-term constraint
   currently says nothing about language; a field always renders (and searches) labels in the served
   default. Add a key naming the language the field should present its terms in — `termLanguage`, or
   `termDefaultLanguage` if a field may hold values in several languages and the key only sets the default
   (name to be decided). On the read side it maps to the `lang=` the editor/CEE already sends to the
   terminology server (item 10); mostly a spec + editor addition, orthogonal to the identity question
   (item 4).
- **12. Name the title-less ontologies in the picker (low priority, cosmetic).** The ingest now takes an
   ontology's display name from BioPortal's metadata, then from its own `owl:Ontology` header title, then
   the acronym — and never downgrades a set name back to the acronym on re-ingest. That leaves the
   ontologies whose source declares no header title at all still showing the bare acronym in the picker:
   13 as of 2026-08-03 — VODANANIGERIA, MCHVODANATERMS, DSIP_FL_7, ETHANC, M4M-CHAR, OCDARREUSE, OCDARV1,
   OCDARWN, OCDARWNE, OCDO, RDL, REGN_BRO, STY1 (mostly VODAN/OCDAR/test/project artifacts). No automatic
   source exists, so each needs a hand-assigned title written to `ontology_source.name`. Cosmetic — the
   picker also shows the acronym — and cheap once the correct names are supplied; low priority.
- **13. Re-fetch labels for the 9 drifted, raw-less ontologies (low priority).** Nine served ontologies
   have real labels but could not be multilingual-backfilled (item 10): no retained local raw matches their
   snapshot `file_hash`, and BioPortal has drifted, so neither `--backfill-labels` (source refetch) nor
   `--backfill-labels-from-raw` can fill them — **NCIT, MS, DOVES, FLOPO, MIXS, MOLSIM, NAMO, RS, SSTIM**
   (plus NCBITaxon, deferred for size). Their primary English `pref_label` serves fine; only the
   multilingual/synonym side-table is missing, so search recall on a synonym or another language misses
   them. Fix: re-ingest the current release from a source that still serves them — an OBO PURL for the OBO
   ones (MS, FLOPO, RS, …), the way GAZ was refreshed; BioPortal for NCIT — which captures labels at ingest.
   That mints a new labeled snapshot and moves `latest` (a currency refresh, not an in-place label add), so
   it doubles as bringing these up to date. Low priority.

- **14. Investigate storing caDSR CDE value sets.** The enumerated caDSR CDEs — those whose value domain
   is a permissible-value list — already resolve to value sets, packaged today as the hand-built CADSR-VS
   value-set ontology and served through BioPortal; [cedar-cadsr-tools](https://github.com/metadatacenter/cedar-cadsr-tools)
   builds them (`ValueSetsOntologyManager`) as part of its CDE→CEDAR-field mapping. Investigate storing
   those value sets on the versioned terminology core instead — first-class, content-hashed value sets with
   `latest`/frozen resolution and cross-version diff, replacing the OWL packaging — so caDSR's enumerated
   fields get the same version pinning as ontology terms. Mostly a re-ingest path. Open: how a CDE value
   set's identity and version map onto the content-hash model (a CDE carries `publicId + version` plus a
   `sourceHash` change-detector a true content hash would make precise), and how these relate to the
   value-set collections already served. This scopes the broader "serve whole CDE-fields" idea down to just
   the value-set slice — the lowest-risk, highest-value part.

### Open questions (authorities that don't fit the version model)

- **15. ORCID / ROR / RRID (and DOI): not versionable per se.** A constraint names the *authority*; the
   value is a stable identifier captured in the instance — no snapshot, no current-version. The spec
   already covers the shape (`sourceSystem` set, `version` omitted). Open question: how the editor and
   instance model represent authority-typed, value-captured, unversioned fields distinctly from a
   versioned controlled term. (The instance is where these land — see item 5.)
- **16. CompTox / PFAS (release-based databases): possibly versionable.** Content with releases, so they
   could fit the content-hash snapshot model *if* they expose retrievable content and release identifiers,
   and *if* a content hash of a flat set (a chemical list, not a hierarchy) is meaningful across
   serializations. Worth a spike.
- **17. Cache the CompTox substance registry locally (bridge server, infra).** On every start the bridge
   server rebuilds its registry by fetching roughly 14,700 substances from the external CompTox API in
   batches of a thousand, holding the result in a `ConcurrentHashMap` that dies with the process
   (`SubstanceRegistry`, driven by the `Managed` `SubstanceRegistryLoader`). Three costs follow: the load
   takes around ninety seconds, during which `/healthcheck` returns 500 and every redeploy shows the
   service as UNHEALTHY; startup depends on a third party being reachable and on the API key being valid
   at that moment; and each restart re-fetches a slowly-changing reference dataset. Persist it instead,
   refreshing on a schedule or when the local copy is stale rather than on every boot, so the server
   serves from the cache immediately. SQLite fits and is already in the stack (`org.xerial:sqlite-jdbc`,
   pinned in `cedar-parent` for the terminology local store). Split readiness from liveness in the health
   check alongside, so a warming server reports as such rather than as failed. Related to item 16: both
   concern how CompTox content enters and is held by the stack.

## Ingestion tracker (ongoing)

An **iterative** task: updated each time more ontologies are ingested from other repositories (item 8).
Identity is the content hash, so the same release from multiple sources/serializations collapses to one
snapshot — the distinct-hash count is the true store size. Method/findings under
[Ingesting from other repositories](#ingesting-from-other-repositories).

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
- 2026-08-04 — GAZ ingested (download timeout raised to 90 min, commit `f66b1bb`), and the served catalog's
  multilingual labels were backfilled from retained local raws (`--backfill-labels-from-raw`, +5.6M labels
  across 77 snapshots incl. giants MESH/BERO/DDSS/LOINC/EFO — item 10). Residual re-fetch tracked as item 13.

**Next iterations** are one command — `ops/harvest-ols-ingest.sh` (source expansion) and
`ops/harvest-obo-ingest.sh` (OBO release currency), both `<catalog> <snapshotDir> [--max N]`, idempotent,
skipping already-current acronyms and logging/skipping failures. Remaining: the NCBITaxon giant-run;
bulk-harvest the rest of the OLS fileLocations; add more OntoPortal instances (EcoPortal, IndustryPortal,
each needs its own key); retry the transient failures; grow version pairs from dated OBO/GO releases.

## BioPortal reconciliation issues

A living log of every way the local terminology replica diverges from BioPortal, why, and what
we did about it. Compiled from the corpus-wide differential gate over the 1,214 ingested
ontologies (goldens + snapshots under `~/tmp/cedar-term/gate-all/`). Kept for later review; append
new findings as they surface.

**Overarching finding.** Where the local replica and BioPortal disagree, the cause is far more
often a BioPortal artifact (or a place where our extraction is *more* correct) than a local defect.
BioPortal's `/classes/roots` in particular is not reproducible by any clean local rule, because it
reflects which `owl:imports` BioPortal happened to resolve at its own ingest time — inconsistent
across ontologies.

### Status Legend

- **BP-ARTIFACT** — BioPortal is wrong or inconsistent; local is equal-or-better. No local fix.
- **LOCAL-BETTER** — local is more complete/correct than BioPortal.
- **FIXING** — a local change is in progress.
- **OPEN** — needs a decision or further work.
- **EXTERNAL** — source-data / provenance issue, not something the extractor can fix.

---

### 1. Root over-reporting: unresolved-import dangling references  — FIXED (data), SERVING-BLOCKED

Import-heavy ontologies list far more roots than BioPortal (CL 250 vs 66; UBERON 53 vs 9). The
extras are classes an ontology *mentions* in an axiom (e.g. a restriction filler) but whose
defining ontology was not loaded, so they arrive **unlabeled and parentless** and look like roots.

- **Evidence.** CL's 184 extra roots are CHEBI (169), BFO (10), COB (2), PCL (1), all unlabeled;
  its agreed roots (ncbigene 38, CLM 25) are all labeled. `250 − 184 = 66` = BioPortal exactly.
- **Fix.** Suppress a root iff it is **unlabeled AND foreign-namespace AND has no labeled
  descendant** — a pure dead-end dangling reference that can hide nothing useful. Validated safe:
  CL 250→77, UBERON 53→7; **zero** roots removed from DOID/OBI/GO/CHEBI/MONDO/NCIT/ABA-AMB; CL keeps
  the 11 unlabeled entry points that lead to real content (no orphaning).
- **Note.** This makes us *cleaner than* BioPortal, not a match — a deliberate philosophy choice
  (2026-07-29): serve a clean tree rather than reproduce BioPortal's inconsistent root set.
- **Implemented (2026-07-29).** `SnapshotStore.pruneDeadEndImportRoots(acronym)` (+ unit test),
  called by `IngestJob` for new ingests; `PruneRootsBackfill` backfilled all 1,214 existing snapshots
  (14,532 roots pruned across 318 ontologies; root table is derived data, so version ids unchanged).
  Verified end-to-end in a `localOnly` instance: CL 250→77, UBERON 53→7, ABD 392→338, DOID 15
  unchanged; no locally-labeled or content-bearing root removed.
- **Serving live (2026-07-29).** Two follow-ons landed. (1) A wiring bug in
  `TerminologyServerApplication.buildTerminologyService` gated browse on the *search* provider's
  allowlist, silently requiring roots ⊆ search; fixed by resolving the provider over the union of
  the search and browse sets and gating each endpoint on its own allowlist. (2) The browse allowlist
  was **re-derived from the pruned snapshots** (`ops/rederive_browse.py`): browse-ready = misses no
  genuine own-namespace labeled BioPortal root and has a non-empty tree; label form/language
  differences (issue #7) do NOT exclude. Result: **1,145 browse-served** (from 806), including the
  import-heavy set. Verified live: CL 77, UBERON 7, GO 3, MONDO 4, ABD 338 all served local with
  zero outbound BioPortal calls; the 26 real-gap ontologies (BTO-EMMO, NDDO, …) correctly proxy.

### 10. Zero-label ontologies emptied by the root prune  — FOLLOW-UP

Twenty ontologies carry no `rdfs:label`/`skos:prefLabel` at all (e.g. ACGT-MO: 1,754 concepts, 1,732
edges, **0 labeled**). Because every root is then unlabeled with no labeled descendant, the dead-end
prune (issue #1) removes *all* of them, leaving 0 roots — unbrowsable — so they are excluded from
the browse allowlist and proxy to BioPortal (which shows their unlabeled roots). Refinement worth
doing: `pruneDeadEndImportRoots` should never prune an ontology to zero roots (keep the originals
when the prune would empty it), so a label-less-but-structured ontology still browses locally.

### 9. Source data contains OWLAPI parse-error artifacts  — EXTERNAL

Some ontologies' source files fail to parse cleanly, and OWLAPI emits placeholder classes in the
{@code http://org.semanticweb.owlapi/error#ErrorN} namespace. BioPortal ingests and displays these
(labeled "ErrorN"); our extractor also captures them, where they surface as unlabeled foreign roots.
Example: ABD has 54 such error roots (BioPortal shows all 392 roots including them; our prune drops
them, serving 338). Issue #1's prune removes them from the tree; the underlying source-file parse
failure is upstream and not fixable at ingest.

### 2. Root over-reporting on BioPortal's side: foreign / meta vocabulary  — BP-ARTIFACT

BioPortal roots external vocabulary that we correctly exclude: RDF/RDFS (`Datatype`, `Resource`,
`List`), FOAF (`Organization`), Dublin Core (`Agent`), SKOS (`Collection`), OWL-Time
(`TemporalEntity`), Protégé (`PAL-CONSTRAINT`), BIBO (`ThesisDegree`), and imported upper-ontology
IDs (`BFO_0000001`, `GO_0008150`, `NCBITaxon_1`, `OMIM_000000`).

- **Evidence.** Across the 25 pure-subset ontologies, 126 of 176 missing roots are these foreign
  classes; e.g. PO's only "gap" is `obo/NCBITaxon_1` ("root"), NIFSTD's is `obo/OMIM_000000`.
- **Verdict.** BioPortal artifact; local is cleaner. No fix.

### 3. BioPortal misses real subClassOf edges we captured  — LOCAL-BETTER

BioPortal reports a class as a root that in fact has a genuine `rdfs:subClassOf`/genus parent our
OWLAPI extraction captured.

- **Evidence.** One disease branch: BioPortal returns 197 direct children where 8 is correct (it
  dropped a `subClassOf` edge and dumped the orphans under the root). 50 such cases across the
  subset/mixed ontologies (e.g. BCIO `CHEBI_50906` → "realizable entity", JFO allergen → food
  allergy).
- **Verdict.** Local is more correct. The gate's directional invariant ("every BioPortal root is
  also a local root") holds for 1,099/1,191 (92%).

### 4. BioPortal root set is not rule-reproducible  — BP-ARTIFACT / OPEN

No clean local rule reproduces BioPortal's roots, because BioPortal resolves some imports and not
others, inconsistently. "Roots must be labeled" wrongly drops 433 ontologies to subset (BioPortal
roots legitimate unlabeled classes in ABA-AMB, ABD, …); "unlabeled AND foreign" still mismatches
because BioPortal roots unlabeled-foreign classes where it *didn't* resolve the import.

- **Verdict.** Matching BioPortal exactly would require downloading each import closure (heavy,
  offline-fragile, snapshot-ballooning). Rejected in favor of issue #1's cleaner-tree approach.

### 5. Genuine own-content root gaps  — EXTERNAL (only 2 across the corpus)

Triage (2026-07-29) of the 26 ontologies the re-derivation excluded for "missing a genuine
own-namespace labeled BioPortal root". Their 490 missing roots break down as **480 "we captured a
`subClassOf`/genus parent BioPortal missed"** (BP over-roots; we correctly file the class under its
parent — the class is present and reachable, just not a root, so our tree is *more* correct),
7 foreign/artifact IRIs the own-namespace heuristic misread as own, 1 obsolete locally, and
**3 genuinely-absent own-content classes** across 3 ontologies: BTO-EMMO, NDDO (`NDDO_20000841`
"unclassified"), and OCRE (`.../OCRe/statistics.owl#OCRE200072` "Statistical concept"; OCRe is
multi-module and the statistics.owl module classes are not all ingested). Each looks like a
source-module/provenance quirk; all three are now in `task_9ea65cb1` (OCRE folded in 2026-07-29).

NIFDYS was flagged a fourth time but was a **false positive** of the own-namespace heuristic, now
fixed. NIF-Dysfunction is 34% imported GO / 31% PATO / 18% UBERON, its own `uri.neuinfo.org/nif/nifstd/`
only 4%, so the old dominant-namespace fallback wrongly called `obo/GO_` "own" and its 3 "absent" GO
roots looked like own-content gaps — and it wrongly *excluded* NIFDYS from browse (and mis-pruned its
snapshot). **Fixed (2026-07-29):** `own_spaces` (in `rederive_browse.py`) and `SnapshotStore.ownIdspaces`
(Java) now fall back to the dominant namespace **among non-imports** (a curated upper/reference-ontology
denylist), so imported content is never mistaken for own. The 22 ontologies whose own-namespace changed
were re-backfilled (re-materialize + re-prune) to correct their snapshots. NIFDYS now serves its own
nifstd tree locally (10 roots). Genuine gaps stand at **3** (BTO-EMMO, NDDO, OCRE); **browse-served
1,187**.

The "we're more correct" classification was spot-verified against the raw source for
JFO (`allergen subClassOf food_allergy`), BCO, ICF, COSTART, and O3 — in every case the source
asserts the edge BioPortal dropped.

**Consequence for the browse allowlist (applied).** The gap test was refined to count only
own-content roots **absent** locally, not ones present-with-a-parent. That returned the 22
"more-correct" ontologies (HL7, MESH, JFO, GDMT, …) to browse-ready: **browse-served 1,164 → 1,186**,
verified serving trees more correct than BioPortal. Only BTO-EMMO, NDDO, NIFDYS, OCRE stay excluded
as genuine gaps.

#### Earlier note (superseded by the triage above): BTO-EMMO, NDDO  — EXTERNAL

Two ontologies genuinely miss a few of their *own* top classes: BTO-EMMO (4 EMMO classes:
Temporally/Spatially Fundamental/Redundant) and NDDO (1: "unclassified"). Only real own-content
gaps across all 1,191 gated (5 classes).

- **Status.** A separate session investigated (see memory `roots-gate-genuine-gaps-are-artifacts`):
  concluded these are source-data / provenance artifacts, not extractor bugs — the extractor
  already handles axiom-only class declarations. Spawned task `task_9ea65cb1`.

### 6. Un-gatable ontologies: BioPortal roots 404/500  — BP-ARTIFACT

23 ingested ontologies could not be gated because BioPortal's own `/classes/roots` returned 404 or
500 for them (e.g. ADALAB-META, BFLC, BIBFRAME, BMT, CST). BioPortal-side gaps.

### 7. Label disagreements below the 98% bar  — OPEN (minor)

16 ontologies are root-set-equal to BioPortal but labels agree < 98% (e.g. AIDENTIFYAGE 75%, HECON
75%, NLN 80%). Cause is language / label-form differences (which of several labels is "the" label).
Not structural; revisit if it blocks specific ontologies.

### 8. Search gate not feasible corpus-wide  — OPEN

The differential search gate replays specific usage targets; the broad corpus has none, and the
only generic probe (enumerate a whole ontology from BioPortal) is infeasible for giants
(NCBITaxon 762k classes). Corpus-wide gating is roots-only; search remains gated over the ~260
CEDAR-used ontologies with real usage atoms.

---

### 11. Label-less ontologies: name is the IRI fragment  — FIXABLE (A9)

179 of the 1,214 ingested ontologies carry no `rdfs:label`/`skos:prefLabel`; the human-readable name
is the IRI fragment (ACGT-MO `#3DRadiotherapyPlanning`, APADISORDERS `#AIDS_(Attitudes_Toward)`,
BIOPAX `#BindingFeature`). BioPortal falls back to displaying the fragment, so its search/browse work;
we store `null` and return empty local search — so these correctly defer to BioPortal for now (found
while widening search-serving, roadmap A8: search local 186 → 1,034, these 179 excluded).

**Fix (A9):** when no label exists, derive one from the fragment (URL-decode, `_`→space, split
CamelCase) and store it in `pref_label`. Backfillable by UPDATE over existing concept IRIs (no
re-download); add to the extractor for new ingests. Unlocks the 179 for both search and browse
(→ ceiling ~1,213) and fixes their unlabeled browse trees.

### 12. QA pass of the locally-served corpus  — MOSTLY CLEAN; ~6 genuinely broken

After widening search+browse to ~1,213 (issues #1, #11), a quality pass checked whether the
newly-served ontologies serve *worse* than BioPortal. Method: local structural flags (opaque/code
labels; 0-edge "flat" hierarchies) then classification against the recorded BioPortal **goldens**
(roots + labels) to separate genuine extraction failures from legitimately flat/code ontologies —
no new BioPortal calls.

**Result: the corpus is mostly clean.** ~1,005 ontologies clearly good; ~34 flagged for opaque
labels and ~31 for 0 edges, but the golden comparison shows **most of those are fine**:
- Many 0-edge ontologies are *legitimately flat* — SKOS code lists (ISO639-1, MARC-LANGUAGES, …)
  where BioPortal also returns 0 roots. Keep serving.
- Many opaque-label ontologies are genuinely code-based; BioPortal is no better. Keep serving.

**Genuinely worse than BioPortal (golden-confirmed): ~6**, mixed causes/formats —
- no hierarchy where BioPortal has one: **EHDAA** (OBO, 2314/0 vs BP 1 root), **BSAO** (OBO, 104/0
  vs BP 8), **EO1** (SKOS, 25/0 vs BP 3);
- code labels where BioPortal has words: **FAST-GENREFORM** (SKOS), **DDSS** (OWL, 807k), **PECO**
  (OBO — hierarchy is fine, labels opaque).

**Root-cause probe (OBO `import:`):** a raw OBO with `import:` stanzas makes OWLAPI's obo2owl
converter fetch each import with a hardcoded loader config, so `MissingImportHandlingStrategy.SILENT`
is ignored and a server-error response (PECO's envo import → HTTP 520) throws
`UnloadableImportException`, aborting the parse. `IngestJob.stripOboImports` fixes this — verified:
stripped `peco.obo` → 3,163 classes, 3,356 subClassOf, 9,921 label annotations (vs 0/opaque stored).
But only **2 of 105 OBO** are 0-edge, so this is not widespread in the current corpus; the broken
snapshots are **stale** (ingested before the strip was effective), not a current-code bug.

**Caveat surfaced:** the A9 IRI-fragment fallback (#11) can *mask* a real label-extraction failure by
filling codes — so "has labels" ≠ "good labels." The golden comparison is the check.

**Action taken (re-ingest of the 6 with current code):**
- **Fixed → kept local:** PECO (own-class labels recovered — "plant exposure" etc. — + 3,356 edges)
  and FAST-GENREFORM (edges + real labels; some leaf LCSH `sh…` codes remain).
- **Still worse than BioPortal → deferred to BioPortal** (dropped from both allowlists, now
  **1,209 / 1,209**): EHDAA, BSAO, EO1 (still 0 edges after a fresh re-ingest — BioPortal has real
  labels + a tree we don't extract, likely a different/flattened source submission), and DDSS
  (807k — re-ingest **timed out** at the 600s cap; unresolved).

**Follow-ups:**
- DDSS: re-ingest with the big-heap/long-timeout retry harness (32g / 45min).
- EHDAA / BSAO / EO1: extractor investigation — why 0 edges from their OBO/SKOS source when
  BioPortal has a hierarchy (submission/serialization mismatch or an is_a/broader extraction gap).

The differential-as-quality-flag approach (serve local by default; goldens flag the few genuine
offenders; re-ingest or defer them) is validated: of ~1,214 held, only ~4 end up deferred for
quality, and BioPortal stays the fallback exactly where it is genuinely better.

### Gate outcome snapshot (2026-07-29, roots)

- Gated: 1,191 (23 un-gatable, issue #6).
- Raw exact-match ready: 791 → 806 → **browse-served live: 1,145** (re-derived from pruned snapshots).
- Excluded from browse: 26 real own-content gaps (issue #5), 20 zero-label empties (issue #10),
  23 un-gatable (issue #6).
- Import-heavy ontologies (CL, UBERON, GO, …) now serve clean pruned trees locally.

## Ingesting from other repositories

An investigation into ingesting ontologies from repositories beyond BioPortal and OBO Foundry, with a
new ingestion primitive and real, verified ingests across formats, serializations, versions, and
authorities. Everything below was run against live sources on 2026-08-01; the terminology server's
content-hash identity makes the *source* of an ontology irrelevant to its identity, and that is what the
results confirm on real data.

### What was added

Two small, tested additions to `IngestJob` generalize ingestion beyond the two hardcoded sources:

- **`DirectUrlSubmissionSource`** — downloads an ontology from *any* URL. `--source url --url <URL>
  [--format OWL|SKOS] [--backend <name>]`. It reports one synthetic submission and treats the content as
  public; identity stays the normalized content hash, so the same release from a different host or
  serialization merges rather than duplicating. This is the right primitive because the major registries
  (OLS, OntoPortal) are *discovery* layers that point at a file elsewhere — see below.
- **`--base-url`** — points `--source bioportal` at any OntoPortal instance (AgroPortal, EcoPortal,
  IndustryPortal, EarthPortal) instead of BioPortal. They run the same OntoPortal REST codebase, so the
  existing `BioPortalDownloader` works unchanged; each instance needs its own `BIOPORTAL_API_KEY`.

Both are covered by unit tests; the ingest module suite stays green (53 tests).

### What was proven (real ingests)

**19 snapshots of 18 ontologies from 9 distinct authorities**, spanning five serializations and both
extractors, with zero code changes per source after the two additions above.

| Serialization | Extractor | Examples (host) |
|---|---|---|
| RDF/XML OWL | OWLAPI | DUO, BFO, RO (OBO PURL); PROV-O (W3C); MAMO (GitHub); VARIO (vendor) |
| OBO | OWLAPI | BFO, PATO (OBO PURL) |
| Turtle | OWLAPI | EMI, BIOLINK (w3id); DCAT, W3C-Time (W3C); schema.org |
| gzipped OWL | OWLAPI | ROR (w3id) — `.owl.gz`, decompressed transparently |
| SKOS (Turtle + RDF/XML) | SKOS | UNESCO thesaurus; LCSH (id.loc.gov) |

Hosts exercised: OBO PURL, GitHub raw, W3C, w3id.org, schema.org, id.loc.gov, UNESCO, a vendor site, and
the AgroPortal REST API. The OWLAPI extractor auto-detects the serialization from content, so the
`--format` hint only chooses between the OWL and SKOS extractors.

#### Content-hash identity is source-, serialization-, and host-independent

The headline result. The *same ontology content* produces the *same* `version_id` no matter where or how
it was fetched:

- **BFO across three authorities and two serializations → one hash (`5ddbbc94…`):** OBO PURL `bfo.owl`
  (RDF/XML), OBO PURL `bfo.obo` (OBO), and AgroPortal's REST download all extracted to the identical
  35-class model and merged to a single snapshot.
- **UNESCO thesaurus, two serializations → one hash (`14d6cd54…`):** the 4,595-concept SKOS thesaurus
  from `unesco-thesaurus.ttl` and from `unesco-thesaurus.rdf` produced the same `version_id`.

#### Versions merge and diff correctly on real releases

Three dated PATO `.obo` releases were ingested as one ontology:

- 2022-12-15 and 2023-05-18 → the *same* `version_id` (`3ef9a582…`): byte-different files, identical
  extracted content, merged to one snapshot.
- 2024-03-28 → a *different* `version_id` (`d4aa8644…`).
- The `SnapshotDiff` of 2022 → 2024 reported `~3 changed concepts` and `+2 added edges` (with the
  `-[rdfs:subClassOf]->` predicate) — exercising the content-complete diff (changed concepts + edge
  predicates) on real version drift. A label-only change like this is exactly what an IRI/edge-only diff
  would have missed.

### The repository landscape

The registries that *look* like ontology hosts are mostly discovery layers; the real files live upstream.

**EBI OLS4** (`https://www.ebi.ac.uk/ols4/api`) — 282 ontologies, but **does not host downloadable
files**: `allowDownload` is `false` for every one, and the `/download` route serves the web app shell.
The real download is each ontology's `config.fileLocation`, which points at an OBO PURL, a GitHub raw
URL, or a w3id/vendor URL. OLS exposes only the currently loaded version (no history). So OLS is a
*catalogue* — harvest its `fileLocation`s and fetch them with `DirectUrlSubmissionSource`.

**OntoPortal instances** — AgroPortal, EcoPortal, IndustryPortal, EarthPortal, MatPortal run the same
REST API as BioPortal (`/ontologies`, `/ontologies/{ACR}/submissions`, `/download`), with real dated
submissions (proper version history). Each needs its own API key; a BioPortal key does not authenticate
elsewhere. AgroPortal has moved to `data.agroportal.eu` (260 ontologies) — reachable now via
`--base-url`. This is the one source type with first-class version history beyond BioPortal.

**Ontobee** — its `?format=owl|rdf|turtle` parameter is a dead end: it returned the ontology's HTML home
page, not the file (the extractor correctly rejected the non-ontology HTML). A different download route
is needed; not usable as-is.

**Linked Open Vocabularies (LOV)** — archives dated versions as files, e.g.
`lov.linkeddata.es/dataset/lov/vocabs/foaf/versions/2014-01-14.n3`. A clean small multi-version source.

**SKOS thesauri** (all direct-download, all ingest via `--format SKOS`):

| Thesaurus | URL | Serialization |
|---|---|---|
| UNESCO | `vocabularies.unesco.org/exports/thesaurus/latest/unesco-thesaurus.{ttl,rdf}` | Turtle / RDF-XML (small) |
| LCSH (LoC) | `id.loc.gov/authorities/subjects.rdf.gz` (full); single-concept `…/{id}.skos.rdf` (tiny) | RDF-XML |
| GEMET (EEA) | `www.eionet.europa.eu/gemet/latest/gemet.rdf.gz` | RDF-XML, gzipped |
| AGROVOC (FAO) | `agrovoc.fao.org/latestAgrovoc/agrovoc_core.nt.zip` | N-Triples, ~95 MB |
| Getty AAT | `aatdownloads.getty.edu/VocabData/full.zip` | N-Triples, large |
| EuroVoc | EU Vocabularies "Downloads" tab (versions 4.7–4.24) | handler-generated, not a static URL |

**W3C / community OWL** (small, direct): schema.org (`/version/latest/schemaorg-current-https.{ttl,rdf}`,
dated at `/version/N/`), PROV-O (`www.w3.org/ns/prov-o.owl`, `prov.ttl`), Time (`www.w3.org/2006/time.ttl`),
SKOS (`www.w3.org/2009/08/skos-reference/skos.rdf`), FOAF, Dublin Core Terms.

**GO release server / GitHub / Zenodo** — dated OBO releases at
`release.geneontology.org/{date}/ontology/go-basic.obo`; OBO PURLs (`purl.obolibrary.org/obo/{x}/releases/{date}/{x}.owl`)
are the reliable versioned front door. Zenodo blocks headless downloads (403); prefer the PURL for the
same artifact.

### Recommendations / next steps

- **Two ingestion modes cover the field.** `--source url` for anything with a stable file URL (OLS
  `fileLocation`s, W3C, SKOS dumps, LOV dated versions); `--source bioportal --base-url` for OntoPortal
  instances, which additionally give real submission history. These map onto roadmap item 14.
- **Harvest OLS as a catalogue**: read `fileLocation` from `/api/ontologies?size=300` and feed each to
  `--source url`. (Skip the two `file:///nfs/...` entries; they are not downloadable.)
- **SKOS is fully supported** end to end, including serialization-independent identity — the thesaurus
  world (AGROVOC, UNESCO, GEMET, LCSH, EuroVoc) is ingestable today.
- **Small gaps worth a follow-up:** the `--backend` provenance label applies only to `--source url`; a
  `--source bioportal --base-url agroportal` snapshot still records backend `bioportal` (the
  `declared_version` and base-url distinguish it, but the authority is not labelled). And Ontobee needs a
  working download route if it is ever wanted.
- **Version history** beyond BioPortal comes from OntoPortal submissions and from dated OBO/GO release
  URLs; OLS and most direct-download vocabularies expose only the current release.
