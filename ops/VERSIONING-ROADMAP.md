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
- **[done] Schema validation (cedar-model-validation-library).** A template/element/field carrying
  the additive `iri`/`sourceSystem`/`version` fields on a value-constraint entry now **passes
  validation**, while `additionalProperties:false` still rejects genuinely unknown fields. Added the
  source fragment `valueConstraintsVersionFieldContent.json` (the string `"latest"` or a
  `{id, effectiveDate, declaredVersion}` triple, `id` required) + the three fields on the four entry
  fragments, registered the version fragment in the five manifests, and regenerated the meta-schemas
  via `scripts/generate-meta-schemas.sh` (**source of truth is `schema/`, not the generated
  `src/main/resources`**). Tests: pinned triple passes, `"latest"` passes, unknown field fails,
  version-without-id fails; suite 214 green.
- **[wip] B1** — Tolerant readers everywhere: `sourceSystem` absent ⇒ BioPortal, `version` absent
  ⇒ latest, `iri` absent ⇒ acronym fallback. Do **not** reuse the legacy `source` display string.
  (JSON reader + schema validation done; YAML reader + other consumers remain.)
- **[later] B2** — Terminology server routes on `sourceSystem` (natural extension of the existing
  per-ontology routing).
- **[later] B3** — Template editor emits the richer shape for new/edited fields, and shows the
  version picker (declaredVersion · effectiveDate · short hash; `latest` default).
- **[later] B4** — Migration/backfill: populate `iri` (from target URIs / headers) and `sourceSystem`
  on existing constraints where derivable; leave the rest to defaults.

## Phase C — Freeze-on-publish (cross-repo)

The reproducibility guarantee is earned here (DESIGN §7).

- **[done] Freeze transformation core (cedar-artifact-library).**
  `ControlledTermVersionFreezer.freeze(constraints, resolver)` returns a copy with every unpinned
  entry — **ontology, branch, class, and value set** — stamped with its current version triple. Pure
  and resolver-injected, so it is unit-testable without a live server (§7: freezing is not a
  terminology-server op; the server only resolves current→triple, a resolver adapts that call). The
  resolver takes the identifier natural to each kind: acronym (ontology/branch), class IRI (class),
  value-set collection (value set) — mapping an identifier to a version stays the resolver's job.
  Idempotent (already-pinned entries untouched); an entry the resolver cannot resolve is left
  unpinned rather than guessed. On the feature branch (not develop). 6 tests; full suite 697.
- **[done] Class-IRI version resolution (terminology server, feature branch).** A class-valued
  constraint names a term but not its ontology; `resolveCurrentVersionForClass(classIri)` maps the
  IRI's namespace to its ontology via A6's `raw_namespace` reverse lookup
  (`CatalogStore.acronymForNamespace`, **unambiguous-only** — a namespace shared by several ontologies
  declines rather than guessing), then returns that ontology's current triple. Wired provider → Sqlite
  → router → BioPortal(null); `GET /bioportal/classes/version-current?uri={classIri}` (404 when
  unresolvable). Verified live: `DOID_9351` → DOID's triple (matches ontology resolve-current), a MESH
  class → MESH's triple, unknown namespace → 404. So class entries are lockable end-to-end today; the
  freezer's `currentVersionByClassUri` is now backed by a real capability.
- **[done] Value-set-collection version resolution (terminology server, feature branch).** A value-set
  collection is a distinct BioPortal artifact type (its members are value sets, not ontology classes),
  but it is ingested and versioned through the **same content-hash mechanism** as an ontology —
  `IngestJob` downloads a submission, hashes the extracted model, and snapshots it, the collection
  reached with a `--valuesets` flag that marks the catalog row `kind=value_set_collection` (an additive,
  idempotent `ensureColumn` migration; every existing row reads the `ontology` default). The kind
  discriminator keeps the two resolution paths separate — a collection never answers an ontology lookup,
  nor an ontology a collection lookup. `resolveCurrentVersionForValueSetCollection(vsCollection)` mirrors
  `resolveCurrentVersion`, gated on the kind marker (not the search/browse allowlist, since a collection
  is not served for lookup), returning the collection's current triple. Wired provider
  (`currentVersionForValueSetCollection`) → Sqlite → router (delegates to local) → BioPortal(null);
  `GET /bioportal/vs-collections/version-current?collection={acronym}` (404 when not served locally). So
  the freezer's `currentVersionByValueSetCollection` is now backed end-to-end — value-set entries are
  lockable on publish. **Verified live**: the real BioPortal CEDARVS collection ingested through
  `IngestJob --all --valuesets` (4 content-hash versions, latest 0.2.2), then resolved through the real
  service stack to its latest triple; an unknown collection and CEDARVS-as-an-ontology both resolve to
  null/404. Store +3, provider +1, ingest +1, app HTTP integration +2. Prod off by default (dev catalog,
  untracked). On the feature branch.
- **[done] Publish-pipeline integration (cedar-resource-server, feature branch).** The freeze is
  wired into `CommandVersionResource.publishArtifact`: after an artifact is flipped to published,
  `TemplateVersionFreezer.freeze` (a surgical JSON walk in cedar-artifact-library — inject `version`
  where absent+resolvable, touch nothing else) pins every unpinned controlled-term constraint via
  `TerminologyVersionResolver`, a **fail-safe** client of the terminology server's resolve-current
  (`ontologies/{acr}/versions/current`) and class-IRI (`classes/version-current`) endpoints. Any
  resolver error, or an unreachable/off terminology store, leaves the artifact unchanged and never
  blocks publish. `TemplateVersionFreezer` 5 tests; `TerminologyVersionResolver` fail-safe.
  **Verified live**: publishing a real template resolved every constraint correctly (DATACITE-VOCAB,
  ISO639-1 → triples; unserved namespaces → 404) and the injected `version` fields passed validation.
  Full REST smoke **606/0** — normal publish (no served constraints) is a freeze no-op, unaffected.

  **Now on develop** (merged 2026-07-31), along with all the terminology-side and library work.

  **Follow-ups (2026-07-31 review):**
  1. **End-to-end freeze demo — DONE.** Published a DOID-constrained `SimpleTemplate`; the stored
     template's constraint came back frozen: `version: {id: 63ef56df…, effectiveDate: 2026-07-01,
     declaredVersion: 2026-06-30}` (DOID's current triple). **Root cause of the earlier failures: a
     SNAPSHOT version skew, not the freeze.** `.m2` held 12 versions of the validation-library and
     `artifact-server` was running a stale one *without* the `version` schema, so it rejected the
     injected `version` field on the publish PUT (500). Fixed by wiping the CEDAR `org.metadatacenter`
     artifacts from `.m2` and doing a full dependency-ordered `cedarcli build java` (everything at
     `2.9.2-SNAPSHOT`), then redeploying. Verified: **freeze end-to-end works, REST smoke 606/0, UI
     smoke PASS.** (The old test fixtures still fail current-meta-schema validation for unrelated
     model-drift reasons — that's a fixture-staleness issue, orthogonal to versioning.)
  2. **Value-set constraints freeze — DONE (2026-07-31).**
     `TerminologyVersionResolver.currentVersionByValueSetCollection` now calls
     `vs-collections/version-current` (was a stub returning empty), mirroring the class-IRI path, so
     all four constraint kinds freeze on publish. Deployed; REST smoke 606/0. (resource-server develop
     `8682ced`.)
  3. **Operational lesson:** the value-set endpoint appeared broken (404) until a *full* rebuild —
     the background session committed the code but the deployed app jar was stale (resource present,
     wired service method old). Always redeploy from a fresh `mvn install`, not just a source commit.
  4. **REST-level test coverage for the freeze path — DONE (2026-07-31).** The behavior was live and
     verified by hand, but nothing exercised it as a regression test. Two suites close that:
     - **Publish side (cedar-development `ops/e2e`, `rest/suites/freeze.mjs`, develop `ac22684`).**
       Publishing a template pins every served controlled-term constraint — ontology, branch, class,
       and value-set collection — each to its current triple, read back from the artifact server; plus
       a negative (an unserved collection is left unpinned). Probes resolve-current and skips when the
       local store is off, so it is honest wherever it runs. REST smoke **606 → 613/0**.
     - **Resolution side (cedar-terminology-server `LocalStoreResourceTest`, develop `bc1c60b`).** The
       three resolution modes on the critical path that had no HTTP coverage: `classes/version-current`
       (term IRI → owning ontology → triple, + 404 for an unserved namespace), a pin by declared-version
       label, and a pin by as-of date — all through the real stack. **8 → 12**, all green. (Needed a
       `raw_namespace` row on the fixture ontology; nothing else exercised the reverse lookup.)

**Backward-compatibility of the Phase B/C library changes — verified end-to-end (2026-07-30).** Built
`cedar-resource-server` (the `cedar-artifact-library` consumer) against the new libraries and
redeployed it, then ran the full smoke: unit 695 (incl. 269 roundtrip, byte-identical on existing
templates) · UI e2e (login → DOID-constrained template → populate → delete) · REST suite **606 passed,
0 failed**. Existing templates round-trip unchanged through the new model.

## Phase D — Multi-backend & open authorities

- **[next] D1** — Adapter interface a backend supplies: `{content → hash, effectiveDate, optional
  declaredVersion/labels, iri}`, plus promoting `iri` to the ontology key (decision 2). The ingest
  seam already exists: `SubmissionSource` (implemented by `BioPortalDownloader`, stubbed in tests)
  abstracts submission listing + raw-file download, and `Submission` already carries
  `version`/`released`/`format` — most of the adapter tuple. What D1 adds: a backend identity threaded
  through ingest (the `snapshot.backend` column exists but is the constant `'bioportal'`) and the key
  promotion. The interface is BioPortal-shaped today (int `submissionId`, license `accessInfo`) and
  needs generalizing for a non-BioPortal source. The key promotion (demoting `acronym` to a label) is
  the invasive part — it re-keys catalog lookups — and is gated on decision 2's *when*.
- **[done] D2 — Source-independence of identity, proven against OBO Foundry (2026-07-31).**
  `OboFoundrySubmissionSource` is a second `SubmissionSource` that fetches from OBO Foundry PURLs —
  the current release (`obo/<lc>.owl`) or an exact dated release (`obo/<lc>/releases/<date>/<lc>.owl`),
  so the *same* logical version BioPortal holds can be pulled from a different authority in a
  different serialization. `SubmissionSource.backendId()` (default `bioportal`, `obofoundry` here) is
  threaded through `IngestJob` and recorded on the snapshot via `CatalogStore.setSnapshotBackend`
  (audit only — identity does not depend on it). `CrossSourceIdentityCheck` ingests one ontology from
  both sources and compares the content-hash `version_id`, diffing to characterize any mismatch.
  **Result: 3/3 identical.** DOID 2026-06-30 → `63ef56df…` (19578 classes / 23775 edges), PATO
  2025-05-14 → `3f1a6fd9…` (8625 / 15815), and CL 2026-06-08 → `b7f8737b…` (19167 / 41955) each
  produced the *same* `version_id` from BioPortal and OBO Foundry — including CL, an import-heavy
  ontology that stresses the extractor's own-namespace logic. Identity is content-derived, not
  source-derived: the design's §4.3 claim is demonstrated against a real second authority, not merely
  asserted. (DOID's `63ef56df…` is the very id freeze-on-publish pins.) The interface stayed
  BioPortal-shaped (synthetic submission id, no license API) — generalizing it is D1. Tests:
  `OboFoundrySubmissionSourceTest` (6, no-network URL/shape), `IngestJobTest` +1 (backend recorded),
  store +0/ingest suites green; the live cross-source run is `CrossSourceIdentityCheck`.
- **[later] D3** — Open authorities (ORCID/DOI/RRID): `sourceSystem` set, `version` omitted, value
  captured in the instance. No snapshotting. Independent of D1/D2 (no ingest, no version model).

## Suggested next steps

Two tracks, both self-contained in this repo:

- **Replace BioPortal for lookup — DONE** (A8, A9, A7, + quality pass). Search 1,209 / browse 1,209;
  BioPortal out of the lookup path for everything we hold except the 4 quality-deferred. Remaining
  polish: **A6** (derive/store `ontology.iri`); the DDSS big-heap re-ingest and the EHDAA/BSAO/EO1
  0-edge extraction investigation (issue #12 follow-ups) to reclaim the last 4. Prod still off by
  default.
- **Versioning mechanics — Phases A, B, C COMPLETE.** A1 (date/declaredVersion resolver), A2
  (resolve-current → triple), A3 (`/versions` full triple), A6 (canonical `ontology.iri`,
  corpus-wide), A4 (provenance columns), and A5 (normalized content-hash identity, cut over) all
  **done**. The value-constraint spec (Phase B model + schema validation) is additive and
  backward-compatible; freeze-on-publish (Phase C) pins all four constraint kinds, is merged to
  develop, verified live, and now carries REST-level regression coverage on both the publish and
  resolution sides. Resolution, the publish-time triple, the version listing, cross-source identity,
  audit provenance, and content-addressed identity are all in place and verified.
- **Phase D — multi-backend & open authorities.** **D2 is done**: source-independence of identity is
  proven against OBO Foundry (3/3 ontologies produced identical content-hash ids from both
  authorities; DOID/PATO/CL). Remaining: **D1** (generalize the BioPortal-shaped `SubmissionSource`
  into a backend-neutral adapter and promote the derived `iri` to the ontology key — settling open
  decision 2, whose enabler A6 is done) and **D3** (open authorities ORCID/DOI/RRID: `sourceSystem`
  set, `version` omitted, value captured in the instance, no snapshotting; independent of D1/D2).
