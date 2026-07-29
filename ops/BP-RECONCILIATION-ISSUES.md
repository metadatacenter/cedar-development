# BioPortal Reconciliation Issues

A living log of every way the local terminology replica diverges from BioPortal, why, and what
we did about it. Compiled from the corpus-wide differential gate over the 1,214 ingested
ontologies (goldens + snapshots under `~/tmp/cedar-term/gate-all/`). Kept for later review; append
new findings as they surface.

**Overarching finding.** Where the local replica and BioPortal disagree, the cause is far more
often a BioPortal artifact (or a place where our extraction is *more* correct) than a local defect.
BioPortal's `/classes/roots` in particular is not reproducible by any clean local rule, because it
reflects which `owl:imports` BioPortal happened to resolve at its own ingest time — inconsistent
across ontologies.

## Status Legend

- **BP-ARTIFACT** — BioPortal is wrong or inconsistent; local is equal-or-better. No local fix.
- **LOCAL-BETTER** — local is more complete/correct than BioPortal.
- **FIXING** — a local change is in progress.
- **OPEN** — needs a decision or further work.
- **EXTERNAL** — source-data / provenance issue, not something the extractor can fix.

---

## 1. Root over-reporting: unresolved-import dangling references  — FIXED (data), SERVING-BLOCKED

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

## 10. Zero-label ontologies emptied by the root prune  — FOLLOW-UP

Twenty ontologies carry no `rdfs:label`/`skos:prefLabel` at all (e.g. ACGT-MO: 1,754 concepts, 1,732
edges, **0 labeled**). Because every root is then unlabeled with no labeled descendant, the dead-end
prune (issue #1) removes *all* of them, leaving 0 roots — unbrowsable — so they are excluded from
the browse allowlist and proxy to BioPortal (which shows their unlabeled roots). Refinement worth
doing: `pruneDeadEndImportRoots` should never prune an ontology to zero roots (keep the originals
when the prune would empty it), so a label-less-but-structured ontology still browses locally.

## 9. Source data contains OWLAPI parse-error artifacts  — EXTERNAL

Some ontologies' source files fail to parse cleanly, and OWLAPI emits placeholder classes in the
{@code http://org.semanticweb.owlapi/error#ErrorN} namespace. BioPortal ingests and displays these
(labeled "ErrorN"); our extractor also captures them, where they surface as unlabeled foreign roots.
Example: ABD has 54 such error roots (BioPortal shows all 392 roots including them; our prune drops
them, serving 338). Issue #1's prune removes them from the tree; the underlying source-file parse
failure is upstream and not fixable at ingest.

## 2. Root over-reporting on BioPortal's side: foreign / meta vocabulary  — BP-ARTIFACT

BioPortal roots external vocabulary that we correctly exclude: RDF/RDFS (`Datatype`, `Resource`,
`List`), FOAF (`Organization`), Dublin Core (`Agent`), SKOS (`Collection`), OWL-Time
(`TemporalEntity`), Protégé (`PAL-CONSTRAINT`), BIBO (`ThesisDegree`), and imported upper-ontology
IDs (`BFO_0000001`, `GO_0008150`, `NCBITaxon_1`, `OMIM_000000`).

- **Evidence.** Across the 25 pure-subset ontologies, 126 of 176 missing roots are these foreign
  classes; e.g. PO's only "gap" is `obo/NCBITaxon_1` ("root"), NIFSTD's is `obo/OMIM_000000`.
- **Verdict.** BioPortal artifact; local is cleaner. No fix.

## 3. BioPortal misses real subClassOf edges we captured  — LOCAL-BETTER

BioPortal reports a class as a root that in fact has a genuine `rdfs:subClassOf`/genus parent our
OWLAPI extraction captured.

- **Evidence.** One disease branch: BioPortal returns 197 direct children where 8 is correct (it
  dropped a `subClassOf` edge and dumped the orphans under the root). 50 such cases across the
  subset/mixed ontologies (e.g. BCIO `CHEBI_50906` → "realizable entity", JFO allergen → food
  allergy).
- **Verdict.** Local is more correct. The gate's directional invariant ("every BioPortal root is
  also a local root") holds for 1,099/1,191 (92%).

## 4. BioPortal root set is not rule-reproducible  — BP-ARTIFACT / OPEN

No clean local rule reproduces BioPortal's roots, because BioPortal resolves some imports and not
others, inconsistently. "Roots must be labeled" wrongly drops 433 ontologies to subset (BioPortal
roots legitimate unlabeled classes in ABA-AMB, ABD, …); "unlabeled AND foreign" still mismatches
because BioPortal roots unlabeled-foreign classes where it *didn't* resolve the import.

- **Verdict.** Matching BioPortal exactly would require downloading each import closure (heavy,
  offline-fragile, snapshot-ballooning). Rejected in favor of issue #1's cleaner-tree approach.

## 5. Genuine own-content root gaps: BTO-EMMO, NDDO  — EXTERNAL

Two ontologies genuinely miss a few of their *own* top classes: BTO-EMMO (4 EMMO classes:
Temporally/Spatially Fundamental/Redundant) and NDDO (1: "unclassified"). Only real own-content
gaps across all 1,191 gated (5 classes).

- **Status.** A separate session investigated (see memory `roots-gate-genuine-gaps-are-artifacts`):
  concluded these are source-data / provenance artifacts, not extractor bugs — the extractor
  already handles axiom-only class declarations. Spawned task `task_9ea65cb1`.

## 6. Un-gatable ontologies: BioPortal roots 404/500  — BP-ARTIFACT

23 ingested ontologies could not be gated because BioPortal's own `/classes/roots` returned 404 or
500 for them (e.g. ADALAB-META, BFLC, BIBFRAME, BMT, CST). BioPortal-side gaps.

## 7. Label disagreements below the 98% bar  — OPEN (minor)

16 ontologies are root-set-equal to BioPortal but labels agree < 98% (e.g. AIDENTIFYAGE 75%, HECON
75%, NLN 80%). Cause is language / label-form differences (which of several labels is "the" label).
Not structural; revisit if it blocks specific ontologies.

## 8. Search gate not feasible corpus-wide  — OPEN

The differential search gate replays specific usage targets; the broad corpus has none, and the
only generic probe (enumerate a whole ontology from BioPortal) is infeasible for giants
(NCBITaxon 762k classes). Corpus-wide gating is roots-only; search remains gated over the ~260
CEDAR-used ontologies with real usage atoms.

---

## Gate outcome snapshot (2026-07-29, roots)

- Gated: 1,191 (23 un-gatable, issue #6).
- Raw exact-match ready: 791 → 806 → **browse-served live: 1,145** (re-derived from pruned snapshots).
- Excluded from browse: 26 real own-content gaps (issue #5), 20 zero-label empties (issue #10),
  23 un-gatable (issue #6).
- Import-heavy ontologies (CL, UBERON, GO, …) now serve clean pruned trees locally.
