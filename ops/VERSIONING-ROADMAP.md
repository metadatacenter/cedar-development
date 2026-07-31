# CEDAR Terminology Versioning — Roadmap

Implementation status and sequencing for the model in
[VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). Living document; update as phases land.

Status keys: **[done]** shipped · **[wip]** in progress · **[next]** ready to start · **[blocked]**
waiting on a decision or another repo · **[later]** deferred.

## Goal (2026-07-29)

**Replace BioPortal for lookup wherever we conceivably can.** Serve locally — for both search and
browse — every ontology we hold; defer to BioPortal *only* where we genuinely cannot: **licensed**
content (never ingested, by policy) and **un-ingestable** ontologies (missing / fetch-or-parse
errors / unparsable). Proxy-to-BioPortal is the gap to close, not the baseline. This is inseparable
from versioning: a version pin can only be honored on the local path, so version-pinnable dynamic
lookup *requires* local serving.

Consequence for the differential gate: it becomes a **quality/confidence signal** (flag divergences,
prioritize fixes), **not** a serve/no-serve gate that defers to BioPortal. We are replacing BioPortal,
which the reconciliation work showed is frequently the wrong reference — so BioPortal-equivalence is
no longer the admission test. In particular, the 23 "un-gatable" ontologies (BioPortal's own roots
404/500) must be served locally: deferring there returns the user an error.

**Coverage target — REACHED.** Ceiling ≈ 1,213 local (the 1,214 ingested minus 1 empty), for both
endpoints. Now: **search 1,209 / browse 1,209** — BioPortal is out of the lookup path for every
ontology we hold, on both endpoints, except the 4 the quality pass deferred (below). Deferring only
where we must: the 77 not held (12 licensed + 65 un-ingestable), the 1 empty (LC-CARRIERS), and the
4 quality-deferred. Got here via A8 (search 186→1,034), A9 (IRI-fragment labels → +179), A7 (browse
1,187→1,213, incl. the 23 un-gatable that BioPortal itself 404s), then the quality pass (−4).

**Quality pass (2026-07-30) — done.** Ran the differential as a quality flag over the served set.
It confirmed ~6 ontologies where local was genuinely worse than BioPortal (stale 0-edge snapshots or
code-only labels). Re-ingesting the 6 with current code **fixed PECO and FAST-GENREFORM** (kept
local — real own-class labels + edges). Four stayed worse and were **deferred to BioPortal**: EHDAA,
BSAO, EO1 (still 0 edges after a fresh re-ingest) and DDSS (807k — re-ingest timed out at the 600s
cap). Search/browse 1,213 → **1,209**. Detail + follow-ups in
[BP-RECONCILIATION-ISSUES.md](BP-RECONCILIATION-ISSUES.md) issue #12.

**Multi-version test beds (2026-07-30).** Most ingested ontologies hold a single snapshot; the
resolver (A1) and diff need real history to exercise. Backfilled a per-year historical spread from
BioPortal (via `IngestJob --submission`, latest tag untouched, then latest refreshed with current
extraction) for the flagship ontologies. Dev catalog now carries **7 multi-version ontologies**:
OBI ×19 (2008–2026), HP ×18 (2009–2026), DOID ×15 (2008–2026), MONDO ×8, GO ×7, INCENTIVE ×6,
MODSCI ×3 — 1,283 snapshots total. These are live-BioPortal ingests into the untracked dev catalog
(not reproducible from the repo). Real drift is dramatic and pinnable: DOID 2008→2026 +11,823/−7,145
concepts; OBI near-total IRI turnover; MONDO −34k as early import-bloat was trimmed. New ingests also
capture `submission_id` + `source_date` (A4).

## Where we are

The terminology server already implements the *foundation* of the model — content-hash identity,
per-submission snapshots, discover/diff/serve-at-version over real history — with the local store
off by default in production. Browse-served is 1,187 of 1,214 ingested; search-served 186. What
remains is (a) widening local serving toward the ceiling (below), (b) a few self-contained
terminology-server extensions, (c) one design decision that could recompute ids, and (d) the
cross-repo spec + publish work that makes versioning visible to authors.

## Open decisions (settle before the phases they gate)

1. **Hash basis — raw bytes vs normalized extracted model** (DESIGN §4.3). **SETTLED and SHIPPED
   (2026-07-30): normalized, including labels.** Measurement over the 7 multi-version ontologies (76
   snapshots) decided it — raw hashing over-split 2 (INCENTIVE, MODSCI), structure-only vs +labels
   never diverged. The cutover recomputed every `version_id` from on-disk snapshots (no re-download),
   kept the raw hash as `file_hash`, and merged the 2 duplicates (1,283→1,281 snapshots). Serving,
   resolution, and diff verified live. No longer an open decision.
2. **Ontology key — when to promote `iri` to the cross-source key** (demoting `acronym` to a label).
   Independent of the version model; gates true multi-source (Phase D). The `iri` itself is now
   **derived and stored** for the whole corpus (A6); what remains open is *when* to make it the key.

## Phase A — Terminology server (self-contained, in our control)

The pieces that need no other repo and no shared-spec change. Prototype the model end-to-end here.

- **[done]** Content-hash `version_id`; `(version_id, acronym)`-keyed snapshots.
- **[done]** `IngestJob --all` multi-submission ingest; `SnapshotDiff`.
- **[done]** `GET /ontologies/{id}/versions`, `GET /ontologies/{id}/versions/diff`.
- **[done]** Serve-at-version: optional `version` on a value constraint (string) resolves the pinned
  snapshot for integrated-search.
- **[done]** Resolver for `version_id` / tag / `latest`; `released_at` + `declared_version` persisted
  and indexed `(acronym, released_at)`.
- **[done] A1 — Resolver: date and declaredVersion.** `CatalogStore.resolveAsOfDate` (newest
  snapshot with release date ≤ D — day-granular, offset-independent via `substr(released_at,1,10)`,
  so BioPortal's varying UTC offsets don't skew it; deterministic same-day tie-break) and
  `resolveByDeclaredVersion` (every match, newest first — the label is not unique). The provider's
  `resolveInfo` now applies the full precedence `hash → tag → date → declaredVersion`, with
  null/blank/`latest` → current; a date-shaped request with nothing on/before it falls through to a
  same-string declared-version label. An unmatched request resolves to empty (→ remote fallback),
  never silently to latest. Ambiguous declared version serves the newest and logs a WARN advising a
  hash pin (surfacing the warning in the HTTP response is deferred — needs a response-shape change).
  No schema change. Tested on INCENTIVE's real history (three `0.1.1`s, same-day `0.1.2`/`0.1.3`,
  a 17-month-later `0.1.3` re-release): store suite 20 tests, provider suite 15 tests, all green.
- **[done] A2 — Resolve-current → triple.** `VersionTriple {id, effectiveDate, declaredVersion}`
  domain record; `ITerminologyService.resolveCurrentVersion(ontology)` returns the triple of the
  ontology's `latest` snapshot, or `null` when not served locally (the "cannot freeze here" signal —
  BioPortal has no content-hash triple). `effectiveDate` is `released_at`'s calendar day, falling
  back to the ingest date when the source records no release. Wired through the provider
  (`currentVersion`), `SqliteTerminologyService`, the router (dispatch, mirroring `getVersions`), and
  the BioPortal backend (null). Exposed as `GET ontologies/{id}/versions/current` (404 when not
  local). A branch/class/value-set entry passes its ontology's acronym — the triple pins the ontology
  snapshot. Provider suite +4 (19 total). **Verified live** on the redeployed stack: INCENTIVE →
  `{e1dc041e…, 2023-11-23, 0.1.3}` (its newest of 6 submissions), MODSCI → `{29460bcd…, 2019-12-01,
  1.0}`, EHDAA (BioPortal-deferred) → 404, and `versions/diff` still routes (no path collision).
- **[done] A3 — `/versions` returns the full triple.** `OntologyVersion` gains `effectiveDate` (the
  release day, or ingest day when the source records no release), derived by the same shared helper
  as A2's triple so a listing and a resolve-current never disagree. `released` (full timestamp) and
  `version` (declared label) are retained as compatibility aliases — purely additive, no reader
  breaks. Endpoint doc + swagger regenerated. Tested: provider suite +1 (20), app
  `LocalStoreResourceTest` +1 (6, real JAX-RS serialization). **Verified live**: INCENTIVE's six
  submissions each carry `effectiveDate`, including the offset case `…T18:07:50-07:00` → `2022-06-26`.
- **[done] A4 — Additive provenance columns.** `snapshot` gains `backend` (constant `DEFAULT
  'bioportal'`, so every existing row reads it with no backfill), `submission_id`, and `source_date`
  (idempotent `ensureColumn` migration). `SnapshotProvenance` record + `setSnapshotProvenance` /
  `snapshotProvenance` (acronym-scoped, like the snapshot itself). Ingest now captures BioPortal's
  reliable per-upload `submissionId` (in hand at ingest, unreconstructable offline) and the version
  string's self-claimed `source_date`. `ProvenanceBackfill` fills `source_date` for existing snapshots
  from their declared-version string — offline, no BioPortal calls. **Ran on the prod catalog: 1,221
  snapshots, backend `bioportal` 100%, source_date on 203 (~17%, matching §2's ~18% date-like).** The
  divergence is the audit payoff — e.g. UBERON `source_date 2023-07-25` (the design's cited
  forever-stale self-date) vs `released_at 2026-06-23`. `submission_id` stays null for
  pre-capture snapshots (recoverable only from live BP metadata; A4 declines that dependency).
  Display/audit only — not yet surfaced on any API (Phase B). Store suites +5.
- **[done] A5 — Hash basis.** Normalized content hash, **including labels**. Canonical form
  (`SnapshotStore.normalizedContentHash`): every concept `C\t<iri>\t<obsolete>` (+
  `<prefLabel>\t<replacedBy>`), every edge `E\t<child>\t<parent>\t<pred>`, every typed relation
  `R\t<subj>\t<pred>\t<obj>`, sorted over IRIs (never row ids) and sha256'd. `IngestJob` now computes
  `version_id` from the extracted model post-extraction (raw hash → `file_hash`), so identical content
  merges at ingest. `CatalogStore.cutoverToContentHash` + `ContentHashCutover` (dry-run default,
  `--apply`) recomputed identity for the on-disk corpus in one transaction — tags repointed, 2
  duplicates merged, files kept their raw-hash names (`file_path` authoritative), 2 orphaned files
  deleted. **Applied to the prod catalog: 1,283→1,281 snapshots, all `version_id`s now 64-hex content
  hashes distinct from `file_hash`, 0 dangling tags.** Verified live: DOID resolve-current returns a
  content-hash id, /versions (15) and diff unchanged, INCENTIVE serves 5. Store suites +2, ingest +1,
  IngestJobTest updated. Catalog backed up to `catalog.sqlite.bak-precutover` before apply.
- **[done] A6 — Derive & store `ontology.iri` (mandatory).** `OntologyIri.canonical` normalizes a raw
  term-ID namespace to the canonical form (DESIGN §6.4: OBO `obo/DOID_` → `obo/doid`; others strip
  the trailing separator, case preserved). `SnapshotStore.dominantOwnIdspace` picks the acronym-keyed
  own namespace (reusing the roots-prune logic, so import-heavy ontologies resolve their own space,
  not a bulk import). `CatalogStore` gains additive `iri` + `raw_namespace` columns (idempotent
  `ensureColumn` migration on the existing catalog), a `setOntologyIri` writer, and an `ontologyIri`
  reader; the raw namespace is kept as provenance. `DeriveOntologyIriBackfill` derives from concepts
  already on disk — no re-ingest. **Ran on the prod catalog: 1,213 derived, 1 empty (LC-CARRIERS) —
  the design's predicted 100%.** Spot-checks match §6.4 exactly (DOID/OBI/MESH/EFO/NIFDYS) and every
  import-heavy case resolves correctly (CL→`obo/cl`, OBI→`obo/obi`, not their dominant import).
  Store suites +10 (OntologyIri 4, dominantOwnIdspace 3, catalog iri 3). The declared `owl:Ontology`
  IRI as an extra provenance source (header parse; not captured at ingest today) is a follow-up — it
  does not change the canonical value, which the own-namespace already yields for the whole corpus.
  This is the multi-source ontology key: decision 2's enabler.
- **[done] A7 — Widen browse-serving (1,187 → 1,213).** Serve every ingested ontology with roots;
  the 23 un-gatable (BioPortal 404s their roots — local is the only working answer) and the 3
  genuine-gap ontologies (BTO-EMMO, NDDO, OCRE — near-complete tree) now serve locally. Only the
  empty LC-CARRIERS defers. Validated: all serve roots locally with zero BioPortal calls.
- **[done] A8 — Widen search-serving (186 → 1,034).** Allowlisted every ingested ontology that has
  extracted labels; validated newly-served ontologies (MESH, HP, PR, GO, NCIT, EFO) serve search
  locally with zero BioPortal calls. BioPortal is now out of the lookup path for 1,034 ontologies.
  Held back: 179 zero-label ontologies (see A9) + 1 empty; those still proxy.
- **[next] A9 — IRI-fragment label fallback (unlocks the remaining 179 → ceiling ~1,213).** 179
  ingested ontologies carry no `rdfs:label`/`skos:prefLabel`; their human name is the IRI fragment
  (`#3DRadiotherapyPlanning`, `#AIDS_(Attitudes_Toward)`). BioPortal falls back to displaying the
  fragment; we store null and return empty search — so they currently (correctly) defer. Fix: when no
  label exists, derive one from the fragment (URL-decode, `_`→space, split CamelCase) and store it in
  `pref_label`, so search matches and browse displays. Backfill by UPDATE over existing concept IRIs
  (no re-download); add to the extractor for new ingests. Improves browse (unlabeled trees) too, then
  widen search + browse to include the 179.

## Phase B — Value-constraint spec (cross-repo, backward-compatible)

The source-explicit, additive shape (DESIGN §6). Touches the template model, editor, and
artifact/resource servers; must stay default-compatible so existing templates and instances are
valid untouched. Cross-repo work runs on a shared `versioned-terminology-server` branch across
cedar-artifact-library, cedar-model-library, cedar-model-validation-library,
cedar-model-typescript-library, cedar-template-editor, cedar-resource-server, cedar-artifact-server.

- **[done] Model foundation (cedar-artifact-library + cedar-model-library).** The additive
  `iri` / `sourceSystem` / `version` fields on all four value-constraint entries
  (ontology/branch/class/valueSet) + a `VersionSpec` triple record
  (`id`/`effectiveDate`/`declaredVersion`), all optional. Backward-compatible by construction: each
  record keeps a delegating old-signature constructor (existing callers untouched, new fields default
  absent), and the `Jdk8Module`/`NON_ABSENT` mapper omits empty Optionals, so a legacy constraint
  renders byte-identically. `ModelNodeNames` gains the constants. The JSON reader reads the fields
  tolerantly (absent, or `version:"latest"`, → latest); the renderer needs no change. Tests: legacy →
  empty, pinned → triple, `"latest"` → latest, render→read roundtrip; full artifact-library suite
  green (691). **Follow-up: YAML serialization of the version spec** — the YAML reader/renderer do not
  yet carry the new fields (JSON is the primary wire format); legacy YAML roundtrips unchanged.
- **[wip] B1** — Tolerant readers everywhere: `sourceSystem` absent ⇒ BioPortal, `version` absent
  ⇒ latest, `iri` absent ⇒ acronym fallback. Do **not** reuse the legacy `source` display string.
  (JSON reader done in the model foundation; YAML reader + other consumers remain.)
- **[later] B2** — Terminology server routes on `sourceSystem` (natural extension of the existing
  per-ontology routing).
- **[later] B3** — Template editor emits the richer shape for new/edited fields, and shows the
  version picker (declaredVersion · effectiveDate · short hash; `latest` default).
- **[later] B4** — Migration/backfill: populate `iri` (from target URIs / headers) and `sourceSystem`
  on existing constraints where derivable; leave the rest to defaults.

## Phase C — Freeze-on-publish (cross-repo)

The reproducibility guarantee is earned here (DESIGN §7).

- **[blocked on A2, B]** The publish pipeline (template editor + artifact/resource servers) walks a
  template's value constraints, calls the terminology server's resolve-current → triple for each
  unpinned entry, rewrites it with the frozen triple, and marks published. Coordinate with the active
  sessions on `cedar-resource-server` / `cedar-artifact-library`.

## Phase D — Multi-backend & open authorities

- **[later] D1** — Promote `iri` to the ontology key (decision 2); adapter interface a backend
  supplies: `{content → hash, effectiveDate, optional declaredVersion/labels, iri}`.
- **[later] D2** — A second backend beyond BioPortal (OLS or a direct OBO-PURL fetch) to prove
  source-independence of identity.
- **[later] D3** — Open authorities (ORCID/DOI/RRID): `sourceSystem` set, `version` omitted, value
  captured in the instance. No snapshotting.

## Suggested next steps

Two tracks, both self-contained in this repo:

- **Replace BioPortal for lookup — DONE** (A8, A9, A7, + quality pass). Search 1,209 / browse 1,209;
  BioPortal out of the lookup path for everything we hold except the 4 quality-deferred. Remaining
  polish: **A6** (derive/store `ontology.iri`); the DDSS big-heap re-ingest and the EHDAA/BSAO/EO1
  0-edge extraction investigation (issue #12 follow-ups) to reclaim the last 4. Prod still off by
  default.
- **Versioning mechanics — Phase A COMPLETE.** A1 (date/declaredVersion resolver), A2
  (resolve-current → triple), A3 (`/versions` full triple), A6 (canonical `ontology.iri`,
  corpus-wide), A4 (provenance columns), and A5 (normalized content-hash identity, cut over) all
  **done**. Resolution, the publish-time triple, the version listing, cross-source identity, audit
  provenance, and content-addressed identity are all in place and verified live. The next real move
  is cross-repo: surfacing `iri`/`sourceSystem`/`version` on the value-constraint spec (Phase B) and
  the freeze-on-publish walk (Phase C), which now has everything it needs from the terminology server.
