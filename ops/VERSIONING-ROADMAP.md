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

**Coverage target.** Ceiling ≈ 1,213 local (the 1,214 ingested minus 1 empty), for both endpoints.
Mandatory-defer set: the 77 not held (12 licensed + 65 un-ingestable). Now: **search 1,034 / browse
1,187** (A8 widened search from 186). The remaining search gap to the ceiling is the 179 zero-label
ontologies, closed by A9 (IRI-fragment label fallback).

## Where we are

The terminology server already implements the *foundation* of the model — content-hash identity,
per-submission snapshots, discover/diff/serve-at-version over real history — with the local store
off by default in production. Browse-served is 1,187 of 1,214 ingested; search-served 186. What
remains is (a) widening local serving toward the ceiling (below), (b) a few self-contained
terminology-server extensions, (c) one design decision that could recompute ids, and (d) the
cross-repo spec + publish work that makes versioning visible to authors.

## Open decisions (settle before the phases they gate)

1. **Hash basis — raw bytes vs normalized extracted model** (DESIGN §4.3). Recommendation:
   normalized. Gates Phase A5. The *only* item that recomputes `version_id`s (from on-disk
   snapshots; no re-download).
2. **Ontology key — when to promote `iri` to the cross-source key** (demoting `acronym` to a label).
   Independent of the version model; gates true multi-source (Phase D). Can be backfilled early
   (`iri` is derivable from branch/class target URIs and from ontology headers).

## Phase A — Terminology server (self-contained, in our control)

The pieces that need no other repo and no shared-spec change. Prototype the model end-to-end here.

- **[done]** Content-hash `version_id`; `(version_id, acronym)`-keyed snapshots.
- **[done]** `IngestJob --all` multi-submission ingest; `SnapshotDiff`.
- **[done]** `GET /ontologies/{id}/versions`, `GET /ontologies/{id}/versions/diff`.
- **[done]** Serve-at-version: optional `version` on a value constraint (string) resolves the pinned
  snapshot for integrated-search.
- **[done]** Resolver for `version_id` / tag / `latest`; `released_at` + `declared_version` persisted
  and indexed `(acronym, released_at)`.
- **[next] A1 — Resolver: date and declaredVersion.** Extend resolution to a date
  (`released_at ≤ D`, newest — uses the existing index) and a declaredVersion string (newest match;
  ambiguity → newest + surfaced warning). Precedence `hash → tag → date → declaredVersion → latest`.
  Tests on real INCENTIVE/MODSCI history. No schema change.
- **[next] A2 — Resolve-current → triple.** One endpoint/service call returning
  `{id, effectiveDate, declaredVersion}` for the newest snapshot of an (ontology/branch/valueSet)
  entry. This is what the publish pipeline (Phase C) will call.
- **[next] A3 — `/versions` returns the full triple** (add `effectiveDate`; keep `released`/`version`
  as aliases for compatibility). Additive to `OntologyVersion`.
- **[next] A4 — Additive provenance columns.** `ALTER TABLE snapshot ADD COLUMN` for
  `source`/`backend` (default `bioportal`), `submission_id`, `source_date`. Backfill from BP
  submission metadata (no content fetch) and raw-header greps. Display/audit only.
- **[blocked on decision 1] A5 — Hash basis.** If normalized: define the canonical form (IRIs +
  edges + obsolete; decide whether labels/language are in-scope), compute a `content_hash` alongside
  the existing raw hash, and cut identity over to it. Recompute from on-disk snapshots.
- **[next] A6 — Derive & store `ontology.iri` (mandatory).** Precedence declared `owl:Ontology` IRI
  → acronym-keyed own-namespace (reuse `SnapshotStore.ownIdspaces`) → adapter de facto (open
  authorities), then normalize to the canonical form (DESIGN §6.4: OBO `obo/DOID_` → `obo/doid`;
  others strip trailing separator). Store as a column on `ontology`; keep declared IRI + raw
  namespace as provenance. Backfill from headers + concepts already on disk — no re-ingest. This is
  the multi-source ontology key (decision 2's enabler) and is derivable for 100% of ontologies.
- **[next] A7 — Widen browse-serving to the ceiling (1,187 → ~1,213).** Add the 23 un-gatable
  (BioPortal's roots fail them, so local is strictly better) and the 3 genuine-gap ontologies
  (BTO-EMMO, NDDO, OCRE — still serve a near-complete tree). Only the empty LC-CARRIERS defers.
  Allowlist change; no build.
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
valid untouched.

- **[blocked on Phase A]** Define the additive fields: `iri`, `sourceSystem`, `version` (triple).
- **[later] B1** — Tolerant readers everywhere: `sourceSystem` absent ⇒ BioPortal, `version` absent
  ⇒ latest, `iri` absent ⇒ acronym fallback. Do **not** reuse the legacy `source` display string.
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

- **Replace BioPortal for lookup** — A8 done (search 186 → 1,034). Next lever is **A9 (IRI-fragment
  label fallback)** to unlock the remaining 179 zero-label ontologies for both endpoints (→ ceiling
  ~1,213), then **A7** (browse stragglers) and **A6** (derive `iri`). Run the differential as a
  quality flag, not a gate.
- **Versioning mechanics** — **A1 (date/declaredVersion resolver)**: self-contained, no schema
  change, testable on real history; the building block A2 and the publish walk depend on. Settle
  decision 1 (hash basis) in parallel — the only item that touches identity bytes.
