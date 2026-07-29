# CEDAR Terminology Versioning — Roadmap

Implementation status and sequencing for the model in
[VERSIONING-DESIGN.md](VERSIONING-DESIGN.md). Living document; update as phases land.

Status keys: **[done]** shipped · **[wip]** in progress · **[next]** ready to start · **[blocked]**
waiting on a decision or another repo · **[later]** deferred.

## Where we are

The terminology server already implements the *foundation* of the model — content-hash identity,
per-submission snapshots, discover/diff/serve-at-version over real history — with the local store
off by default in production. Browse-served is 1,187 of 1,214 ingested. What remains is (a) a few
self-contained terminology-server extensions, (b) one design decision that could recompute ids, and
(c) the cross-repo spec + publish work that makes versioning visible to authors.

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

## Suggested next step

**A1 (date/declaredVersion resolver)** — highest-value, fully self-contained, no schema change, no
re-ingest, testable on real history. It makes date-pinning real and is the building block A2 and the
publish walk depend on. Settle decision 1 (hash basis) in parallel, since it is the only item that
touches identity bytes.
