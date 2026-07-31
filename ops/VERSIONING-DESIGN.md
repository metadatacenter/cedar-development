# CEDAR Terminology Versioning — Design

A source-explicit, content-addressed version model for value constraints. Living document; the
canonical statement of *what* the model is and *why*. Implementation status and sequencing live in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md); the divergence findings that motivated it live in
[BP-RECONCILIATION-ISSUES.md](BP-RECONCILIATION-ISSUES.md).

Grounded in a survey of the 1,214 ingested BioPortal ontologies (2026-07-29).

## Decision ledger

| Decision | Status |
|---|---|
| Identity = content hash | **settled** |
| `effectiveDate` = source publication (upload) date; fallback ingest timestamp | **settled** |
| Stored pin = the triple `{id, effectiveDate, declaredVersion}`, `id` authoritative | **settled** |
| Open authorities (ORCID/DOI/RRID) are not versioned; value captured in the instance | **settled** |
| Constraint shape is source-explicit and additive; `sourceSystem`, not `source` | **settled** |
| `ontology.iri` = identity (mandatory, precedence-derived), `acronym` = presentation label | **settled** |
| Published templates freeze `latest` → the triple | **settled** |
| Canonical `iri` form — normalized namespace (OBO → `obo/doid`; others → namespace, trailing separator stripped) | **settled** (§6.4) |
| Hash over raw bytes vs normalized extracted model | **settled** — normalized, incl. labels (§4.3); shipped |
| When to promote `iri` to the ontology key across sources | OPEN (roadmap) |

## 1. The problem

A CEDAR template is published as *immutable*, but the vocabulary its fields point at is not. Terms
are fetched live from BioPortal, which serves whatever submission is current. When an ontology is
revised, the same field silently resolves to a different set of terms — no record, no way to
reproduce the original. Removing that drift, letting a template pin the exact vocabulary state it was
authored against, is the grant's core thesis.

Two obstacles: the current value-constraint spec **assumes BioPortal** (the ontology reference is a
BioPortal URL; source unnamed; no version), and — more fundamental — **there is no dependable version
to attach**.

## 2. What BioPortal actually gives us

The self-declared `version` string is present but unreliable, and does not identify a distinct upload.

| Self-declared `version` | Share | Examples |
|---|--:|---|
| semver-like | 40% | `2.8.19`, `3.92.0` |
| date-like | 18% | `2026-06-08` |
| free-text | 17% | `2026_2025_08_15`, `releases/2021-10-26` |
| empty | 17% | — |
| bare integer | 7% | `281` (LOINC) |

**Decisive finding — the declared version does not identify a state.** BioPortal keeps every upload
as a numbered `submissionId`, but the version string is frequently stale and repeated across
genuinely different uploads. UBERON submissions #352–#355 (uploaded 2025-10-17, 2025-12-05,
2026-04-01, 2026-06-23) are **all** labeled `version = "2023-07-25"`; INCENTIVE #5/#6/#7 all say
`0.1.3`. A label missing 17% of the time and ambiguous much of the rest cannot be a reproducible pin.

**Which date?** Three diverge: the version-string's self-claimed date (UBERON: `2023-07-25` forever),
and `released`/`creationDate` — the BioPortal upload date, present on 100% of submissions and the
honest "when this state entered circulation." The only fully reliable BioPortal primitives are the
monotonic `submissionId` and the bytes.

**Is the ontology's own date better?** No. Across 250 sampled raw files: `owl:versionInfo` 42% (often
a string, not a date), `owl:versionIRI` 22%, a clean dated `/releases/YYYY-MM-DD/` IRI only **11%**,
Dublin Core dates 12%. **There is no canonical source date.**

## 3. Prior art

Every community that solved this separates the identity of a frozen state from the labels describing
it. **FHIR** splits a `ValueSet` *definition* (may float) from its **expansion** (immutable,
timestamped, own identity) — our per-submission snapshot. **Content-addressing** (Git, Nix, OCI
digests, lockfiles): identity = content hash, the human name rides alongside. **Dated releases**
(SNOMED `effectiveTime`, UMLS `2023AA`, LOINC `2.74`, OBO `versionIRI`) work when maintained — most
don't. **BioPortal/OntoPortal** version by `submissionId` and retain history, so they *are* pinnable,
just not via the version string. Nobody uses the self-declared version as identity.

## 4. The definition

> A **version** is the identity of an immutable, reproducible snapshot of a value space, denoted by a
> **content hash** of its ingested contents. Human-facing labels (declared version, release/upload
> date, source submission id) are descriptive metadata that a request may resolve *to* a content
> hash; none is the identity, because each is variously missing, malformed, or repeated across
> genuinely distinct states.

Three separated concerns:

| Concern | What it is | Role |
|---|---|---|
| **Identity** | content hash (`version_id`) | backend-agnostic, exact; what a published template pins |
| **Metadata** | declared version, dates, submission id, backend | version picker + ordering; never load-bearing alone |
| **Resolution** | how `version` maps to an identity | hash (exact), or a label/date resolving to a hash at serve time |

### 4.1 The triple

| Field | Source | Job |
|---|---|---|
| `id` (content hash) | hash of the ingested snapshot | **identity** — resolution uses only this |
| `effectiveDate` | source publication date (BioPortal `released`); fallback ingest timestamp | **ordering** — anchors `latest` and date-pins |
| `declaredVersion` | the source's self-declared string | **label** — display only; may be empty/ambiguous; never resolves alone |

### 4.2 Why `effectiveDate` = the source upload date (the "arbitrary" one)

It is complete (100% of submissions, vs 11–22% for the self-date) and **orders states correctly even
for backfilled history**: ingesting INCENTIVE's six historical submissions today gives one ingest
date and `0.1.3` on three of them — only the source publication date (2022/2023/2024) recovers the
true order. The self-claimed date is sparse and provably stale; kept as a display label only.

### 4.3 Identity: raw bytes vs normalized content — SETTLED (normalized, incl. labels; shipped)

Today `version_id` is `sha256` of the raw downloaded file, tying identity to the *serialization*: the
same release from BioPortal vs an OBO PURL, or OWL vs OBO form, gives different bytes and different
ids for content served identically — source and format leak into identity.

The alternative hashes the **normalized extracted model** (sorted concept IRIs, edges, labels,
obsolete flags). Same served hierarchy → same id regardless of source or serialization; genuinely
different content (e.g. an `obo2owl` transform changing the tree) → different id, which is correct.
For a hierarchy service this matches what "version" means to a consumer. **Settled and shipped:
normalized-content hash, including labels.** The canonical form is over IRIs (never row ids): every
concept (`iri`, `obsolete`, `prefLabel`, `replacedBy`), every subsumption edge, every typed relation,
sorted and sha256'd. Measurement over the 7 multi-version ontologies (76 snapshots) decided the
labels knob: raw hashing over-split 2 snapshots (byte-different re-uploads of identical content), and
structure-only vs +labels never diverged, so labels are in at zero observed cost. The cutover
recomputed every `version_id` from the on-disk snapshots (no re-download), kept the raw hash as
`file_hash` provenance, and merged the 2 duplicates (INCENTIVE 6→5, MODSCI 3→2). Existing snapshot
files keep their raw-hash names (`file_path` is authoritative); new ingests name files by the content
hash and compute identity from the extracted model.

## 5. Source taxonomy

Naming the source explicitly unifies every case; the source discriminates what a constraint means.

| Field kind | `sourceSystem` | `ontology.iri` | `version` |
|---|---|---|---|
| BioPortal ontology | BioPortal | `obo/doid` | triple |
| Same ontology, other backend | OLS / OBO-PURL | `obo/doid` (same) | triple (own hash) |
| Dynamic dataset with releases | e.g. EPA CompTox (PFAS) | collection IRI | triple (release) |
| **Open authority / live resolver** | ORCID, DOI, RRID | the authority | **absent** |

**ORCID falls out naturally:** an open authority is not a versioned value space (infinite, validated
live). Nothing to snapshot; reproducibility comes from recording the chosen value (iD + label) in the
instance, which CEDAR already does. PFAS lands in row 3 (enumerable release) or row 4 (live lookup).

Every row has a base `iri`, including the open authorities: ORCID → `https://orcid.org/`, EPA
CompTox (PFAS) → the DTXSID namespace. For sources with content these are derived (§6.1); for open
authorities the backend adapter declares them as a constant.

## 6. The value-constraint shape

Purely additive: the outer `_valueConstraints` object is unchanged; each entry gains optional fields.
An entry answers three questions — *which* value space (`iri` identity, `acronym`/`name` labels),
*where* it lives (`sourceSystem`), *which* state (`version`).

**Current (verbatim):**
```json
"_valueConstraints": {
  "ontologies": [
    { "uri": "https://data.bioontology.org/ontologies/DOID",
      "acronym": "DOID", "name": "Human Disease Ontology", "numTerms": 18055 }
  ],
  "valueSets": [], "classes": [], "branches": [], "requiredValue": false
}
```

**Evolved — pinned** (same wrapper; new fields marked):
```jsonc
"ontologies": [
  { "uri": "https://data.bioontology.org/ontologies/DOID",  // kept — legacy routing url
    "acronym": "DOID",                                      // kept — PRESENTATION label
    "name": "Human Disease Ontology", "numTerms": 18055,    // kept
    "iri": "http://purl.obolibrary.org/obo/doid.owl",       // NEW — canonical IDENTITY
    "sourceSystem": "BioPortal",                            // NEW — absent ⇒ BioPortal
    "version": {                                            // NEW — the triple
      "id": "e1dc041e…",                                    //   content hash = identity
      "effectiveDate": "2023-11-23", "declaredVersion": "0.1.3" } }
]
```

**Evolved — latest** (the default; no `version` key):
```jsonc
"ontologies": [
  { "uri": "https://data.bioontology.org/ontologies/DOID",
    "acronym": "DOID", "name": "Human Disease Ontology", "numTerms": 18055,
    "iri": "http://purl.obolibrary.org/obo/doid.owl",
    "sourceSystem": "BioPortal" }
    // no "version" key ⇒ latest: resolve the newest snapshot at serve time
]
```

`version` is polymorphic: **absent** → latest · **`"latest"`** → latest (explicit intent) ·
**`{id, effectiveDate, declaredVersion}`** → pinned. Branch/class entries evolve identically, and
there `iri` is derivable for free from the target `uri` (`DOID_4` → `obo/DOID_`).

**Naming landmine:** `branches`/`classes` already carry a `source` field — a free-text display string
(`"Human Disease Ontology (DOID)"`, `"undefined (ADO)"`), not a backend. Do **not** reuse `source`;
the backend field is `sourceSystem`.

### 6.4 Deriving `ontology.iri` — mandatory, always populatable

`iri` is not optional. Survey of the corpus: a declared `owl:Ontology` IRI is extractable for only
~57–64% of ontologies, but a base IRI is **derivable for 100%** (1,213 of 1,214; the sole exception
is the empty LC-CARRIERS). So `iri` is a mandatory identity field, filled by precedence:

1. **Declared `owl:Ontology` IRI** from the header, where present and clean (~57–64%).
2. **Acronym-keyed own-namespace** — reuse `SnapshotStore.ownIdspaces` (the roots-prune logic).
   This is the 100% workhorse. The naive "dominant concept namespace" is **wrong** for import-heavy
   ontologies (OBI and DOID both resolve to `obo/CHEBI_`, CL to `ensembl/`); the acronym-keyed
   own-namespace correctly yields `obo/OBI_`, `obo/DOID_`, `obo/CL_`, `nif/nifstd/`, etc.
3. **Adapter-declared de facto base** for open authorities with no concepts to sample: ORCID →
   `https://orcid.org/`, EPA CompTox → the DTXSID namespace. A constant the backend supplies.

**Canonical form.** The derived value is a term-ID namespace (`http://purl.obolibrary.org/obo/DOID_`,
trailing `_`), not a polished ontology IRI. Normalize `iri` to a clean namespace base, uniformly:

- **OBO** term-prefix → drop the trailing `_` and lowercase the id:
  `http://purl.obolibrary.org/obo/DOID_` → `http://purl.obolibrary.org/obo/doid` (the OBO Foundry
  ontology IRI).
- **Other** namespace → strip the trailing separator (`/` or `#`), preserve case:
  `http://purl.bioontology.org/ontology/MESH/` → `…/MESH`; `http://www.ebi.ac.uk/efo/` → `…/efo`.

The declared `owl:Ontology` IRI (where present) and the raw term-namespace are kept as recorded
provenance — useful, but not the identity.

| acronym | canonical `iri` | provenance (declared) |
|---|---|---|
| DOID | `http://purl.obolibrary.org/obo/doid` | `…/obo/doid.owl` |
| OBI | `http://purl.obolibrary.org/obo/obi` | `…/obo/obi.owl` |
| MESH | `http://purl.bioontology.org/ontology/MESH` | (same) |
| EFO | `http://www.ebi.ac.uk/efo` | `…/efo/efo.owl` |
| NIFDYS | `http://uri.neuinfo.org/nif/nifstd` | `…/NIF-Dysfunction.ttl` (file URL) |

## 7. Lifecycle — latest and freeze-on-publish

| State | `version` | Resolution |
|---|---|---|
| Draft (default / legacy) | absent | newest at serve time |
| Draft (explicit float) | `"latest"` | newest at serve time |
| **Published** | the triple | fixed `id` (hash), forever |

Freezing is **not** a terminology-server operation. The terminology server exposes one capability —
*resolve current → triple* for an entry. The publish pipeline (template editor + artifact/resource
servers) walks the constraints and stamps the frozen triple. That walk is cross-repo.

## 8. Persistence & API — no re-ingest

The core is already persisted and served. The `snapshot` table holds identity + ordering, populated
for all 1,221 snapshots, with a `(acronym, released_at)` index for date resolution; `/versions`
already returns `{versionId, version, released, latest}`.

| Model concept | Column | Status |
|---|---|---|
| identity (content hash) | `version_id` | present, 100% |
| effectiveDate | `released_at` | present, 100% (indexed) |
| declaredVersion | `declared_version` | present, 83% |
| source / submission id / self-date | — | additive `ALTER TABLE`; backfill from metadata, not content |

The only new *behavior* is resolution: accept, beyond a hash and `latest`, a **date** (`released_at ≤
D`, newest — uses the existing index) and a **declaredVersion** (newest match; ambiguity → newest +
warn). Precedence: `hash → tag → date → declaredVersion → latest`. Pure logic over existing columns —
no schema change for the core, no re-ingest. The exception is §4.3 (normalized hash), which recomputes
ids from on-disk snapshots.

## 9. Backward compatibility

- `sourceSystem` absent → **BioPortal**.
- `version` absent → **latest** (every legacy template is already "latest").
- `iri` absent → fall back to `acronym`; derive from the target `uri` for branch/class, backfill for
  bare ontologies.
- Readers tolerate both shapes; the editor emits the richer shape only for new/edited fields.
- The legacy `source` display string is left untouched.
