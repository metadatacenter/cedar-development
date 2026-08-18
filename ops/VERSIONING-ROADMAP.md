# CEDAR Terminology Versioning — Roadmap

Forward-looking plan for the model described under [The Model](#the-model); running any of
it — the store, the ingest, the server, the picker — is in
[VERSIONING-RUNBOOK.md](VERSIONING-RUNBOOK.md).

This covers the whole of versioning, the authoring surface included. `cedar-term-picker`, the Web
Component an author picks a versioned constraint with, is tracked here rather than in a roadmap of
its own: it exists to author versioned constraints, and splitting the two put the version UI in one
document and the version model in another. What is already
built — content-hash identity, per-submission snapshots, all resolution modes, the canonical-iri
identity re-key with de-confliction, source-independence against OBO Foundry, multi-source ingest
(BioPortal, OBO Foundry, any URL, any OntoPortal — serving a non-BioPortal snapshot verified live on the
running server), `sourceSystem` routing (serve locally or report unavailable, never proxy BioPortal for a
non-BioPortal source), the value-constraint spec (JSON + YAML) with schema validation,
freeze-on-publish pinning all four constraint kinds on every artifact type (no value-set collection allow-list),
author-facing version selection in the term picker (a release list a constraint is pinned from, the
hierarchy drawn at the release chosen, and "latest" recorded as no version at all), multilingual label +
synonym capture (every language preserved outside content identity, backfilled across the served
catalog) and served on the local read path (multilingual + synonym search recall, synonyms on class
detail, `lang=<code>` on the class and integrated-search endpoints), `owl:Ontology`-header identity
recovery for acronym-only ontologies, and a release list that offers releases rather than
re-extractions of them (grouped on the raw-bytes hash the catalog already recorded, so a fix to an
extractor no longer reads as a new release, while a pin naming a superseded reading still resolves
and says that it does) — lives in git and the design doc. The numbered items track only
what remains, in three buckets: **Pending** (to build), **Testing** (built, needs live verification),
and **Future** (deferred / needs a decision / speculative). Items are numbered continuously.

The sections after the numbered items are findings rather than plans, and stay put: what
[the term picker](#the-term-picker) replaces and has built, the running
[ingestion tracker](#ingestion-tracker-ongoing), the
[BioPortal reconciliation issues](#bioportal-reconciliation-issues) log that motivated the model, and
the [survey of ingesting from other repositories](#ingesting-from-other-repositories). What the store
captures and serves for multilingual labels is part of the model rather than a plan, and lives in
[Multilingual labels](#10-multilingual-labels); item 4 below is the open
question about it.

## Where the code is, and how it is switched on

All of the above **merged to `develop` on 2026-08-09** — twenty-seven commits, previously on
`versioned-terminology-server`. CI published the snapshot, and the containerized terminology server
was rebuilt and redeployed on it, with the REST estate green afterwards. The feature branch is no
longer the place to read this work.

**The store is off unless something turns it on, and BioPortal is the shipped default.**
`cedar-main.yml` carries an empty `catalogPath`, so the local store serves nothing until the
`terminologyStore.*` system properties supply one, and the server logs which mode it is in at
startup. The catalog path is the switch, and as of 2026-08-12 it is set only by a profile: the
generic environment used to declare it, which turned the store on in every environment that
inherited it, including ones carrying no catalog at all. Two levers govern it — whether the store is used at all, and whether a locally-served
ontology may fall back to BioPortal when it cannot answer. Both are described in
[BACKEND-RUNBOOK.md](BACKEND-RUNBOOK.md), under the local terminology store; they are operational
rather than plan, so they are not restated here.

One consequence belongs with the plan rather than the runbook. Fallback is on in normal operation,
so a gap in the local store is quietly covered by BioPortal. That is the right default for serving
and the wrong one for measuring: it means a green suite says nothing about how complete the store
is, and the reconciliation and equivalence work below is what does.

**Currently the containerized server runs on BioPortal**, with the catalog mounted read-only and the
path left blank, so switching back is one profile line.

## Goal

Replace BioPortal for lookup wherever we can, and make every published template and filled instance
reproducible against pinned vocabulary versions. The versioning **backend (freeze-on-publish, catalog,
resolution) and the compact-YAML dialect are code-complete** — the version-aware YAML is published as a
preview only, pending production. The remaining gaps: the frontend (CEE sending the pin, and version
selection in the new term picker) and instance-level capture (item 4).

## The Model

What versioning *is* here, and why it is that rather than something else. The numbered items
above and below are the plan; this is what they rest on.

A source-explicit, content-addressed version model for value constraints, grounded in a survey of
the 1,214 ingested BioPortal ontologies (2026-07-29). The divergences that motivated it are in
[BioPortal reconciliation issues](#bioportal-reconciliation-issues).

Its numbered sections are cited from the code as `VERSIONING-ROADMAP "The Model" §N`, so a number
here is a handle something else holds. Renumbering one means fixing what cites it.

### Decision ledger

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

### 1. The problem

A CEDAR template is published as *immutable*, but the vocabulary its fields point at is not. Terms
are fetched live from BioPortal, which serves whatever submission is current. When an ontology is
revised, the same field silently resolves to a different set of terms — no record, no way to
reproduce the original. Removing that drift, letting a template pin the exact vocabulary state it was
authored against, is the grant's core thesis.

Two obstacles: the current value-constraint spec **assumes BioPortal** (the ontology reference is a
BioPortal URL; source unnamed; no version), and — more fundamental — **there is no dependable version
to attach**.

### 2. What BioPortal actually gives us

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

### 3. Prior art

Every community that solved this separates the identity of a frozen state from the labels describing
it. **FHIR** splits a `ValueSet` *definition* (may float) from its **expansion** (immutable,
timestamped, own identity) — our per-submission snapshot. **Content-addressing** (Git, Nix, OCI
digests, lockfiles): identity = content hash, the human name rides alongside. **Dated releases**
(SNOMED `effectiveTime`, UMLS `2023AA`, LOINC `2.74`, OBO `versionIRI`) work when maintained — most
don't. **BioPortal/OntoPortal** version by `submissionId` and retain history, so they *are* pinnable,
just not via the version string. Nobody uses the self-declared version as identity.

### 4. The definition

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

#### 4.1 The triple

| Field | Source | Job |
|---|---|---|
| `id` (content hash) | hash of the ingested snapshot | **identity** — resolution uses only this |
| `effectiveDate` | source publication date (BioPortal `released`); fallback ingest timestamp | **ordering** — anchors `latest` and date-pins |
| `declaredVersion` | the source's self-declared string | **label** — display only; may be empty/ambiguous; never resolves alone |

#### 4.2 Why `effectiveDate` = the source upload date (the "arbitrary" one)

It is complete (100% of submissions, vs 11–22% for the self-date) and **orders states correctly even
for backfilled history**: ingesting INCENTIVE's six historical submissions today gives one ingest
date and `0.1.3` on three of them — only the source publication date (2022/2023/2024) recovers the
true order. The self-claimed date is sparse and provably stale; kept as a display label only.

#### 4.3 Identity: raw bytes vs normalized content — SETTLED (normalized, incl. labels; shipped)

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

#### 4.4 Both date-ish members must stay quoted in YAML

`id` is safe to write bare and the other two are not, and the reason is the same one that makes `id`
authoritative: CEDAR mints it, so its form is fixed, while a publisher writes `declaredVersion` and a
source's upload clock writes `effectiveDate`. Measured against all 114 snapshots in the store on
2026-08-17:

| Field | Store column | Distinct | Unsafe as a plain YAML scalar |
|---|---|---:|---:|
| `id` | `version_id` | — | 0 — a 64-character hex content hash, never all digits |
| `effectiveDate` | `released_at` | 113 | **113, all of them** — every value reads back as a datetime |
| `declaredVersion` | `declared_version` | 48 | **36 (75%)** — three separate ways |

`declaredVersion` is the one that matters, because it fails silently rather than loudly. **18 values
read as numbers** — CL and ENVO version themselves `1.30`, `1.40`, `1.41`, and ELD declares plain
`4` — so `1.40` comes back `1.4`, a different version string with no error and no warning. **17 read
as dates**, the OBO convention (`2011-06-03`, `2026-06-30`). One is the empty string, which reads as
null. Only 12 survive, and by accident of form rather than by rule: `releases/2016-02-12` is a path,
`5.0.16` has three components, `20AA_250902F` and `unknown` are neither number nor date.

So a pin exists to preserve a version string exactly, and writing these two bare would silently
rewrite the thing being preserved. Whatever the YAML writer does elsewhere, these two are quoted.
The estate-wide quoting question is on [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md), under the YAML
quoting item; the corpus does not yet exercise either key, so nothing there measures them.

### 5. Source taxonomy

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
CompTox (PFAS) → the DTXSID namespace. For sources with content these are derived (§6.4); for open
authorities the backend adapter declares them as a constant.

### 6. The value-constraint shape

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

#### 6.4 Deriving `ontology.iri` — mandatory, always populatable

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

### 7. Lifecycle — latest and freeze-on-publish

| State | `version` | Resolution |
|---|---|---|
| Draft (default / legacy) | absent | newest at serve time |
| Draft (explicit float) | `"latest"` | newest at serve time |
| **Published** | the triple | fixed `id` (hash), forever |

Freezing is **not** a terminology-server operation. The terminology server exposes one capability —
*resolve current → triple* for an entry. The publish pipeline (template editor + artifact/resource
servers) walks the constraints and stamps the frozen triple. That walk is cross-repo.

### 8. Persistence & API — no re-ingest

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

### 9. Backward compatibility

- `sourceSystem` absent → **BioPortal**.
- `version` absent → **latest** (every legacy template is already "latest").
- `iri` absent → fall back to `acronym`; derive from the target `uri` for branch/class, backfill for
  bare ontologies.
- Readers tolerate both shapes; the editor emits the richer shape only for new/edited fields.
- The legacy `source` display string is left untouched.

### 10. Multilingual labels

A concept in a source ontology can be named in several languages, and with several synonyms. The
terminology store historically kept only one name per concept — the single label it serves — and
discarded the rest at ingest. For a multilingual ontology that threw away real content: a French or
Japanese label, an exact synonym, a hidden search term. This records how BioPortal handles language,
what the store now captures, and how the existing snapshots were backfilled.

#### How BioPortal Serves Language

BioPortal (through the OntoPortal layer) stores every language variant of a name and chooses per
request. The same class answers four ways:

| Request | `prefLabel` |
|---|---|
| default | `"water"` |
| `?lang=en` | `"water"` |
| `?lang=fr` | `"eau"` |
| `?lang=all` | `{"en": "water", "fr": "eau"}` |

- One label by default: a single string, the submission's declared `naturalLanguage`, English
  otherwise.
- `lang=<code>` (alias `language=`) narrows every label-valued property to that BCP-47 language.
- `lang=all` turns each into a `{lang: value}` hash; untagged literals bucket under `"none"`.
- Search indexes all languages: a query in any language matches, presentation is language-scoped.

#### What the Store Captures

Identity is the point of leverage. A snapshot's `version_id` is the normalized content hash, and that
hash reads only the concept's single served `pref_label`, its obsolete flag and replacement, the
subsumption edges, and the typed relations. So a second table that the hash never reads sits outside
identity by construction.

The `label` table holds every name literal with its language tag:

```
label(concept_id, property, lang, value)   -- lang '' = untagged (BioPortal's "none")
```

captured for the label proper (`rdfs:label`, `skos:prefLabel`) and the synonym properties BioPortal
serves (`skos:altLabel`, `skos:hiddenLabel`, and the OBO-in-OWL synonym scopes
`hasExactSynonym`/`hasRelatedSynonym`/`hasBroadSynonym`/`hasNarrowSynonym`/`hasSynonym`). Both
extraction paths capture — the OWL/OBO extractor and the relation (SKOS) extractor.

The change is strictly additive: the single `pref_label` is chosen exactly as before (English, then
untagged, then any other language; `rdfs:label` over `skos:prefLabel`), so `version_id` is unchanged.
A store test asserts that adding labels moves neither the structure-only nor the label-sensitive
content hash.

#### Backfilling the Existing Snapshots

The discarded labels live only in the source files, which are not cached — so backfill re-fetches and
re-parses from source. `IngestJob --backfill-labels` walks the catalog and, for each snapshot:
re-fetches its submission (by recorded submission id, else the source's current latest), re-extracts
into a throwaway store, and **only if the recomputed `version_id` equals the snapshot's** copies the
captured labels into the existing snapshot file. The version-id gate makes it fail-safe: a snapshot is
enriched in place with identity-preserving labels, or left untouched, never rewritten with different
content. A durable `meta` marker records completion, so the run is resumable and idempotent (a
label-less ontology is marked done rather than reprocessed). The catalog is never mutated, and a
SQLite busy timeout lets the write land while the live server is reading the same snapshot.

**Content drift is the coverage limit.** Most snapshots recorded no submission id, so backfill re-fetches
the source's current latest. Where the ontology has changed since it was ingested, the re-extraction
hashes differently and the snapshot is skipped — its exact original bytes are no longer retrievable.
Those snapshots keep their single served label; capturing their languages needs a fresh ingest of the
current release (a new `version_id`), which is a catalog update, not a label backfill.

#### Coverage

Run against the served catalog on 2026-08-01 (`ops/label-coverage`-style aggregate over every
snapshot):

Of 1,281 served BioPortal snapshots, **1,142 were backfilled** (967 with at least one real label;
the rest are genuinely label-less, named only by IRI fragment, and marked done). **127 are
multilingual** (more than one language). **134 were skipped as content-drift** (BioPortal has a newer
release than the one ingested), and **5 failed** on a BioPortal-side HTTP 422 (retired `OCDAR*`/`OCDO`
acronyms). Structure and identity were untouched throughout, and the live server kept serving.

**14,058,647 label literals** captured, across more than 30 languages:

| Language | Rows | | Property | Rows |
|---|--:|---|---|--:|
| (untagged) | 12,491,357 | | `rdfs:label` | 5,906,158 |
| en | 1,224,055 | | `oboInOwl:hasExactSynonym` | 3,173,105 |
| fr | 197,422 | | `skos:altLabel` | 1,748,748 |
| de | 66,216 | | `oboInOwl:hasRelatedSynonym` | 1,663,113 |
| es | 21,279 | | `skos:prefLabel` | 1,201,926 |
| it | 19,903 | | `oboInOwl:hasNarrowSynonym` | 254,944 |
| pt | 15,481 | | `oboInOwl:hasBroadSynonym` | 75,727 |
| ja | 10,416 | | `skos:hiddenLabel` | 21,431 |
| + ~25 more (zh, nl, ar, el, da, …) | | | `oboInOwl:hasSynonym` | 13,495 |

Synonyms — never stored before this work — account for ~5.2 M of the rows. Method: aggregate every
snapshot's `label`/`meta` tables ([label-coverage.py](label-coverage.py)).

#### Serving the Languages

The local read path now serves the captured names:

- **Search recall** — a non-empty query matches any captured name, in any language or a synonym, not
  only the served `pref_label`. Searching "réseau" returns a concept whose default label is the English
  "Health Network"; an empty-query browse is unchanged.
- **Synonyms** — class detail returns the captured altLabels and OBO synonym scopes.
- **`lang=<code>`** — the class endpoint (`GET .../classes/{id}?lang=fr`) and integrated-search
  (`POST /bioportal/integrated-search?lang=fr`) return labels in the requested language, falling back to
  the default when a concept has none. Only the returned page slice is re-labelled. Verified live:
  searching "occupational" with `lang=fr` returns "professionnel" / "ergothérapie".

`lang=` is honored on the local path; a BioPortal-proxied ontology returns BioPortal's own default label.

**Still deferred (by decision):** `lang=all` (the `{lang:value}` hash), `lang=` on the public
`search`/tree output, and honoring the submission's `naturalLanguage` for the default (it stays
English-preferred).

Whether the served `pref_label` is the right thing to fold into content identity is
an open question, not a settled one — see item 3 above.

## Pending

- **1. Label the OntoPortal authority on the snapshot.** The store reaches AgroPortal, EcoPortal and
   any other OntoPortal through `--source bioportal --base-url`, and records `bioportal` for all of
   them: `snapshot.backend` exists and takes a `--backend <name>` label, but nothing derives it from
   the instance that answered, so the authority is lost unless an operator remembers the flag. The
   consequence used to be provenance, which is why this sat as a clause under ingest. It is now
   structural. `sourceSystem` and `sourceAcronym` are the pair that addresses a source in
   [The Search API](#the-search-api) — an acronym means nothing outside a system —
   and while every OntoPortal reads as `bioportal`, that pair cannot tell AgroPortal's AGROVOC from a
   BioPortal ontology of the same acronym, and routing cannot honour the rule that a non-BioPortal
   source is never proxied to BioPortal. Derive the label from the base URL, and backfill the
   snapshots already ingested this way.

- **2. CEE sends the pinned version at populate (frontend, small).** CEE is the relevant fill/presentation
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
## Testing

- **3. End-to-end frozen read (after CEE sends the pin, item 2).** Verify the full loop on the live stack:
   publish a frozen template → fill an instance via CEE → confirm terms resolve against the pinned
   snapshot, not latest. The terminology and publish sides are tested; this cross-service e2e becomes
   runnable once item 2 lands. Use a locally-served single-source constraint (the path where the backend
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

- **6. Finish the ontology constraint's identity: retire `sourceUri`, and backfill `iri` and
   `sourceSystem` onto what is already stored.** One item because they are one change seen from two
   ends — what a constraint should carry, and what the constraints already written carry.

   *The code half.* The YAML no longer authors `sourceUri` and reconstructs it from the acronym; its
   "non-derivable" premise was overturned, since every ontology URL is BioPortal with the acronym as
   its path. What remains is the model marking `uri` required and the JSON Schema still carrying it.
   Retiring it needs the model field made optional — or the JSON side deriving it too — and the
   editor to stop writing it.

   *The data half.* A migration over published templates rather than a code change, and not required
   for function: tolerant readers already default a constraint with no `sourceSystem` or `iri` to
   BioPortal with acronym-derived resolution. `sourceSystem` is a no-op, since absent already means
   BioPortal everywhere it is read, the router included. `iri` — the canonical `sourceIri` — is the
   substantive part, and needs a tool that walks each stored template's controlled-term constraints,
   looks up the acronym's canonical IRI from the terminology catalog (`ontologyIri(acronym)`, the
   only place that mapping lives) and rewrites where derivable, leaving the rest to defaults. The
   value is self-description: a constraint carrying its canonical identity is immune to acronym
   ambiguity and to future cross-source resolution. Dry-run with zero mutations first, reporting
   coverage and the non-derivable acronyms, before any run against the live template store.

   The data half is a defect in stored artifacts rather than in code, so it is also a production
   patch item, under Production Artifact Patch on
   [BACKEND-ROADMAP.md](BACKEND-ROADMAP.md#production-artifact-patch) — patch what is stored before
   requiring the new shape of anything that reads it.

- **7. Lookup-coverage tail (replace-BioPortal track, orthogonal to versioning).** Improve display for the
   ~200 IRI-fragment-only ontologies (measured 2026-08-03 against the served catalog: ~240 snapshots serve
   the IRI code as the label, less ~40 false positives whose local names are real words — PROVO, RDFS, …)
   where a real label is recoverable. Dominated by HOOM (135k, `HP:` codes), XREF-FUNDER-REG (45k, numeric),
   SCHEMA (SNOMED numeric), GALEN, ICD-O-3, MCCL, DERMLEX, HORD. *The 4 quality-deferred cases are resolved:*
   BSAO and EHDAA reclaimed (the extractor now treats obo2owl's `TEMP#is_a` — an OBO `relationship: is_a` —
   as subsumption, and EHDAA is configured as a `part_of` partonomy; re-ingested and re-allowlisted), DDSS
   was already healthy (807k labelled classes), and EO1 stays BioPortal-served (its SKOS source is broken —
   `skos:broader` values are string literals, not IRIs).

   **Part of the tail was ours, found 2026-08-14.** An ontology can assert `rdfs:label ""` beside the
   real one, and both extractors ranked the blank literal like any other and kept whichever came
   first. A concept that lost the toss counted as unlabeled, so it drew the IRI-fragment fallback
   meant for genuinely unlabeled classes: ABD's "White pine blister rust" is stored, served and
   indexed as `?id=118`. The extractors now skip blank literals. A snapshot already written keeps
   the wrong label — a version id is a hash over `pref_label`, so correcting one in place would
   change the release's identity rather than repair it — so the repair is a re-ingest, which mints
   a new version id.

   *Repaired 2026-08-14* by re-ingesting the 161 candidate ontologies (`ops/reingest-blank-label.sh`;
   160 succeeded, EMI skipped for want of a recorded source URL) and rebuilding their slice of the
   search index in 65 seconds. **The repair recovered 157 concepts across 23 ontologies**, measured
   by diffing each ontology's previous snapshot against its new one: ABD 32, ACGT-MO 24, NEMO 21,
   G-PROV 16, AERO 14, and a tail of one to seven apiece.

   The candidate list came from a proxy that overstated the problem by two orders of magnitude, and
   the proxy is worth naming so it is not reused: terms whose `pref_label` is a suffix of their own
   IRI, of which the index holds 795,379, with 45,230 also carrying another name. That catches every
   ontology that mints IRIs from labels — OCHV's 27,758, MEPO's 5,672 and GNO's 3,761 are all of
   that kind, and none of them was ever mislabeled. A defect of this shape can only be counted by
   comparing snapshots before and after, which is what the 157 is.

   **The signature that does count it, arrived at 2026-08-15 after three that do not:** a concept
   whose stored `pref_label` is none of the non-blank `rdfs:label` or `skos:prefLabel` values its
   source gave it. Not "the label equals its IRI fragment", which is every ontology that mints IRIs
   from labels — HOOM's 122,733 and MIDO's 41,558 are that, and correct. Not "a blank label sits
   beside a real one", which also catches a concept carrying two real labels. Not "the fallback
   fired while some non-blank label exists", which catches a concept whose only names are synonyms,
   for which the fallback is right. Swept over every current snapshot, the store holds **1,450 such
   concepts in 10 ontologies**, led by FAST-EVENT-SKOS (865), FAST-FORMGENRE (250) and
   FAST-GENREFORM (245).

   **Those are a second defect, not a remnant of this one.** FAST-EVENT-SKOS was re-ingested with
   the blank-literal fix and still stores `1055909` for a concept whose `rdfs:label` is
   "Peacekeeping forces". The SKOS extractor names a concept from `skos:prefLabel` alone
   (`RelationHierarchyExtractor.recordLabel`) while storing `rdfs:label` rows in the label table, so
   a SKOS vocabulary that names its concepts with `rdfs:label` gets no name at all and draws the
   IRI-fragment fallback. Fixing it is an extractor change and a re-ingest of those ten.

   **A fifth, fixed 2026-08-16, was not a label defect at all but read as one.** A hierarchy read
   from a snapshot took the first fifty children by IRI and sorted those fifty by label, so a large
   node's list was an arbitrary subset presented as the alphabetical head of its children. ABD's
   "Disease" has 280, and the fifty that came back skipped "African horse sickness" while showing
   "African swine fever" two rows below it — so pinning a release appeared to lose a term the
   release does hold. The current release is served by the search index, which orders by label and
   limits afterwards, so the two disagreed and only the pinned path was wrong. Ordering and limiting
   now happen in one query on both paths. The picker also states what a node is not showing; a
   capped list that looks complete is what turned this into a report of a lost selection.

   **A third, fixed in the extractors 2026-08-16 and awaiting a re-ingest.** 465 concepts in 36
   ontologies store a label running over several lines, led by BIBFRAME (214) and ABD (86). ABD
   packs a list into one `rdfs:label` literal beside the real name, and the extractor kept whichever
   came first, so a class asserting the plain label "Meningitis" was served, indexed and offered by
   the picker as "Bacterial meningitis Meningococcal meningitis Viral meningitis Fungal meningitis
   Parasitic meningitis Non infectious meningitis" — the entries run together, because a display
   collapses the line breaks.

   A fourth travels with it and is far more widespread: **9,044 labels carry leading or trailing
   whitespace**, led by METABUS (4,876), ONTOPSYCARE (1,296), FGNHNS (489) and JFO (486), with a
   long tail reaching NCIT's 12. Padding is invisible where it is served and significant where the
   label is compared, so it is a defect that only ever shows up as a false difference.

   Both are now one rule, in `Names`: a name is a single line of text, so a literal is reduced to
   its first non-blank line, trimmed, and the lines below it become names in their own right. Where
   a concept asserts both a plain label and a list, language decides first — BioPortal's choice of
   language must not shift — and the plain literal wins among equals. Nothing is invented and
   nothing is lost: each entry becomes findable on its own, where the run-on could only be matched
   by a query spanning two of them. Only the pick and the label table changed; the hierarchy did not.

   The repair is a re-ingest, for the same reason the blank-literal one was: a version id is a hash
   over `pref_label`, so correcting a label in place would change the release's identity rather than
   repair it.

   *Both repaired.* The 36 line-break ontologies on 2026-08-16, and the 69 holding a padded label on
   2026-08-17 — all 69 succeeded, 595,873 terms and 934,329 names reindexed in 55 seconds. Swept
   over the whole index afterwards, labels carrying a line break and labels carrying stray
   whitespace both stand at **zero**.
- **8. Term ordering in search: what BioPortal does, and what the local store can do instead
   (replace-BioPortal track).** Ordering is the one part of lookup the local store does not model.
   Inside a snapshot, `SnapshotStore.labelSearch` orders by `length(pref_label), pref_label, iri`;
   across sources, `Util.sortByClosestMatch` puts preferred labels containing the query first and then
   sorts by Levenshtein distance to it (`SearchResultComparator`). Both are label-only: a hit found
   through a synonym or a non-English label is ordered by its *preferred* label's length or edit
   distance, and nothing considers which ontology a hit came from.

   BioPortal's model, documented only in its source, has two halves. Solr edismax field boosts — ids
   at `^100`, `prefLabelExact^90`, `prefLabel^70`, `synonymExact^50`, `synonym^10`, plus an additive
   `bq=idAcronymMatch:true^80` — and a multiplicative ontology-level prior, `boost=sum(ontologyRank,1)`,
   where `ontologyRank` is `0.5 × log10-normalised BioPortal page visits over a trailing 12 months
   + 0.5 × (1 if the ontology is in the UMLS group)`, recomputed by cron into Redis and pushed into the
   term index (`ontologies_api/helpers/search_helper.rb`, `ontologies_linked_data` `Ontology.rank`,
   `ncbo_cron/lib/ncbo_cron/ontology_rank.rb`). Neither the `/search` API documentation nor the 2025
   NAR BioPortal paper mentions any of it.

   **Measured 2026-08-08** — `ops/bp_search_ordering.py` over 8 common terms ("melanoma", "diabetes
   mellitus", "kidney", "blood pressure", "aspirin", "water", "temperature", "cell membrane"). Each term
   is scored against BioPortal's *own* 200-hit result set, so recall is fixed and only the ordering
   function varies: 1,600 hits, 221 ontologies, 209 of them in the served catalog. The script also
   reconstructs the real `ontologyRank` from `/analytics` plus UMLS group membership, which makes
   BioPortal's own prior a measurable reference rather than a guess. Re-run with:

   ```bash
   source $CEDAR_HOME/set-env-external.sh
   python3 $CEDAR_HOME/cedar-development/ops/bp_search_ordering.py
   ```

   Agreement with BioPortal's ordering, mean over the 8 terms. Ties break on the concept IRI, never on
   BioPortal's own position, or a tie-preserving sort would silently score the input order as skill:

   | ordering | rho over the pool | of BP's top 10 | order within BP's top 10 |
   |---|---|---|---|
   | field boosts only | 0.616 | 3.8 | all tied |
   | × real `ontologyRank` (BioPortal's own) | **0.727** | **9.1** | **0.877** |
   | × size (classes) | 0.462 | 5.4 | 0.251 |
   | × depth (median ancestors) | 0.499 | 2.6 | -0.312 |
   | × uploads (submissions) | 0.512 | 4.1 | 0.436 |
   | × recency of upload | 0.484 | 4.2 | 0.217 |
   | × all four, equal weights | 0.487 | 4.2 | -0.001 |
   | today's contains + Levenshtein | 0.549 | 3.9 | all tied |

   *The field half decides the shape of the list, not its head.* Replicating the boosts from
   `prefLabel`/`synonym`/`matchType` reaches rho 0.616 over the whole pool but recovers only 3.8 of
   BioPortal's top ten, because a common term has far more exact preferred-label matches than a page can
   hold — 56 for "melanoma", 100 for "kidney", 115 for "water", within the 200-hit pool alone — and the
   field score cannot tell them apart. *The prior is what picks and orders the visible ten, and it is
   pure usage.* The cleanest cut is a single query's exact-preferred-label group: same string, different
   ontologies, so the field boosts are equal by construction and only the prior can be ordering them.
   Correlation of BioPortal's rank against each signal over those groups (-1.000 would predict the order
   exactly; the UMLS flag is constant, so undefined, where every member is a UMLS ontology):

   | signal | mean | melanoma | diabetes mellitus | kidney | blood pressure |
   |---|---|---|---|---|---|
   | real `ontologyRank` | **-0.680** | -0.756 | -0.998 | -0.671 | -0.988 |
   | 12-month visits alone | -0.651 | -0.666 | -0.998 | -0.668 | -0.988 |
   | UMLS-group flag alone | -0.608 | -0.606 | — | -0.496 | — |
   | size | -0.255 | -0.409 | -0.405 | -0.497 | -0.180 |
   | uploads | -0.175 | -0.048 | -0.789 | -0.099 | -0.517 |
   | recency | -0.155 | 0.098 | -0.774 | -0.052 | -0.276 |
   | depth | **+0.212** | 0.223 | -0.066 | 0.111 | 0.190 |

   *Structural metadata does not substitute for it.* Depth is inverted, and a grid search over all four
   weights peaks at rho 0.520 recovering 4.2 of the top ten, with *zero* weight on size and depth (best:
   uploads 0.75, recency 0.25). Today's contains-plus-Levenshtein ordering leaves BioPortal's entire top
   ten tied — every one of those hits is distance 0 — so which ten CEDAR shows, and in what order, is
   effectively arbitrary.

   **Why the proxies fail, concretely.** Size looks strong corpus-wide (rho 0.809 against real
   `ontologyRank` across the 1,204 catalog acronyms BioPortal also knows) but that is a range artifact
   of the many small, unvisited ontologies; among the ontologies that actually compete for a common
   term it carries almost nothing. Depth is inverted because the most-used ontologies are the flattest:
   MESH (9.6M visits, rank 1.000) holds 355,402 classes with 42,643 edges — 0.12 per class, median
   ancestor count 0 — while low-traffic OBO ontologies are deep (UPHENO 1.66 edges per class, UBERON
   1.83). Uploads misfire the same way: NCIT has 150 submissions and sits between 5th and 9th, RCD has
   one and sits 7th. And the ontologies BioPortal ranks highest are disproportionately the UMLS-licensed
   ones the local store cannot hold at all — SNOMEDCT, MEDDRA, RCD and ICPC2P are absent from the
   catalog — so a local ranking cannot mirror BioPortal's head of list even with a perfect prior.

   **What to do.** Implement the field half properly and make it synonym-aware: exact preferred label,
   then preferred label, then exact synonym, then synonym, each with a length norm, so a hit's *match
   reason* orders it rather than its preferred label's edit distance. Give the result a deterministic
   total order. Do not invent a structural prior — it is worse than none on the head of the list. If a
   prior is wanted it has to be a *demand* signal, the local analogue of page visits: per-ontology usage
   counts harvested from production templates with `ops/cedar_ontology_usage.py`, or per-term pick counts
   recorded at fill time. Two facts BioPortal's own prior uses are cheap to capture at ingest and worth
   storing either way: UMLS-group membership and the source's submission count.
- **9. Backfill releases for the ontologies templates actually constrain to.** *2026-08-15, three
   runs, 2,486 submissions ingested:* four recent releases apiece for the twelve mainstays
   (`ops/backfill-releases.sh`), then the next tier and the value-set collections, then every
   ontology under 50k classes (`ops/backfill-tail.sh`, 1,048 of them, 2,369 ok, 131 failed, 55 with
   no history to fetch). The store went from 1,343 snapshots to 2,460, and from 1,149 ontologies
   holding one release to **573**.

   *2026-08-16, the 50k–200k band:* those 30 ontologies, **77 submissions ingested**, 3 failed and 3
   with no history to fetch.

   *2026-08-16, depth rather than breadth:* four releases apiece exercises the release list and
   freeze, but not a term moving parents or being deprecated across years, and BioPortal holds 150
   submissions of NCIT alone. The store held four, all from 2026, so the release list had nothing
   interesting to show. Ingesting **19 NCIT releases, one per year from 2007 to 2026** (submissions
   146, 142, 140, 124, 112, 100, 86, 71, 58, 46, 42, 37, 23, 11, 9, 7, 5, 3, 1) gives the first
   history long enough for a term to visibly move between two pins. Run behind the band above by
   `ops/run-after.sh`, which waits on the first driver by process id: each ingest is a full parse
   holding the ontology in memory, and BioPortal is one API, so two at once halves neither's time.

   **The first four of those releases were ingested before the whitespace fix and the rest after**,
   because the ingest classpath was rebuilt under a running driver. NCIT holds 12 padded labels, so
   a diff across that boundary shows 12 label changes that never happened. The re-ingest the label
   fix already requires resolves it; until then, do not read a release diff spanning submission 124.
   The lesson generalises: **do not build into the ingest classpath while an ingest is running.**

   *2026-08-17, the 260k–400k band:* four releases apiece attempted for BERO, PR, RH-MESH and CCO —
   **9 ingested, 5 failed**, and the failures are the sources rather than the ingest: BERO's
   submission 1 is HTTP 404, PR's 93 dropped the connection mid-download, and CCO's 3, 4 and 5 are
   served as HTML rather than RDF (`Content is not allowed in prolog`). CCO's own count is unchanged
   at one release, its newest submission hashing to the snapshot already held — the same content
   under a second submission id, which is content identity working.

   What remains is the top of the range: DDSS 807k, GAZ 669k and NCBITAXON at 2.85M. Each needed its
   own heap and download timeout when first ingested — GAZ a 90-minute window, NCBITAXON 40g and 82
   minutes — so they want attention rather than an overnight queue.

   The 131 failures are informative rather than alarming: 31 produced 0 classes and the guard
   refused to overwrite a good snapshot, 17 were HTTP 404 on a submission BioPortal lists but will
   not serve, and the rest are old submissions that no longer parse.

- **10. Ingest ontologies from more sources.** *Shipped:* `--source url` (`DirectUrlSubmissionSource` —
   any URL) and `--source bioportal --base-url` (any OntoPortal instance: AgroPortal, EcoPortal, …).
   Proven across five serializations (RDF/XML, OBO, Turtle, gzipped OWL, SKOS) and nine authorities, with
   source-, serialization-, and host-independent content-hash identity confirmed on real data (BFO
   identical from OBO PURL `.owl`/`.obo` and AgroPortal REST; UNESCO identical from `.ttl`/`.rdf`). Running
   tally in the **Ingestion tracker (ongoing)** below; survey and method under
   [Ingesting from other repositories](#ingesting-from-other-repositories). A constraint that names one of these sources
   already resolves correctly (serve locally or report unavailable). *Version currency (done):* the served
   prod catalog's OBO ontologies were refreshed to their current OBO Foundry release via
   `ops/harvest-obo-ingest.sh` (155/158, 49 genuinely-newer refreshes — logged in the tracker), and GAZ
   ingested once its download timeout was raised to 90 min (commit `f66b1bb`), with NCBITaxon following on
   2026-08-06 (82 min at 40g, server stopped — a 3.7× expansion, see the tracker). *Remaining:*
   bulk-harvest OLS `fileLocation`s, and OGG, whose PURL still 404s upstream (the 2026-07-29 snapshot
   stands). Labelling the OntoPortal authority moved out of this item to item 1, where being a dependency
   of the version-aware search puts it.
- **11. Remaining multilingual read-side options (deferred by decision).** Done and in the "Built" list:
   capture, serving (search recall, synonyms, `lang=<code>` on the class and integrated-search endpoints),
   and the label backfill — `--backfill-labels-from-raw` (re-extract from the retained local raw matched by
   `file_hash`, no version-id gate since labels key by IRI) added +5.6M labels across the served catalog.
   Residual data gap is item 14 (9 raw-less ontologies). Still open here, *by decision not blockers:*
   `lang=all` (the `{lang:value}` hash), `lang=` on the public `search`/tree output, and honoring the
   submission's `naturalLanguage` for the default (stays English-preferred).
- **12. Extend the value-constraint YAML to express a term's language.** A controlled-term constraint
   currently says nothing about language; a field always renders (and searches) labels in the served
   default. Add a key naming the language the field should present its terms in — `termLanguage`, or
   `termDefaultLanguage` if a field may hold values in several languages and the key only sets the default
   (name to be decided). On the read side it maps to the `lang=` the editor/CEE already sends to the
   terminology server (item 11); mostly a spec + editor addition, orthogonal to the identity question
   (item 4).
- **13. Name the title-less ontologies in the picker (low priority, cosmetic).** The ingest now takes an
   ontology's display name from BioPortal's metadata, then from its own `owl:Ontology` header title, then
   the acronym — and never downgrades a set name back to the acronym on re-ingest. That leaves the
   ontologies whose source declares no header title at all still showing the bare acronym in the picker:
   13 as of 2026-08-03 — VODANANIGERIA, MCHVODANATERMS, DSIP_FL_7, ETHANC, M4M-CHAR, OCDARREUSE, OCDARV1,
   OCDARWN, OCDARWNE, OCDO, RDL, REGN_BRO, STY1 (mostly VODAN/OCDAR/test/project artifacts). No automatic
   source exists, so each needs a hand-assigned title written to `ontology_source.name`. Cosmetic — the
   picker also shows the acronym — and cheap once the correct names are supplied; low priority.
- **14. Give FLOPO its labels without costing it its hierarchy (the last of ten).** Nine served ontologies
   had real labels but could not be multilingual-backfilled (item 11): no retained local raw matched their
   snapshot `file_hash`, and BioPortal had drifted, so neither `--backfill-labels` (source refetch) nor
   `--backfill-labels-from-raw` could fill them — NCIT, MS, DOVES, FLOPO, MIXS, MOLSIM, NAMO, RS, SSTIM
   (plus NCBITaxon, deferred for size). Their primary English `pref_label` serves fine; only the
   multilingual/synonym side-table was missing, so search recall on a synonym or another language missed
   them. The fix is a re-ingest of the current release, which captures labels at ingest and doubles as a
   currency refresh (it mints a labelled snapshot and moves `latest`, rather than adding labels in place).
   *Done 2026-08-06, all ten:* **MS** (+4,619 labels), **RS** (+14,611) and **NCBITaxon** (+3,354,524, and
   far more than a label fix — see the tracker) from the OBO PURL; **NCIT** (+206,860), **DOVES**
   (+138,835), **MOLSIM** (+3,491), **MIXS** (+1,516), **NAMO** (+259) and **SSTIM** (+206) from BioPortal.
   Structure held in every one of those nine — root counts identical before and after, class and edge
   counts identical or marginally better. **FLOPO** is the exception: the re-ingest gained labels but lost
   the hierarchy, and was reverted (below), so it still has no label side-table.
   **BioPortal drift is what makes the BioPortal route work, not what blocks it.** The original note here
   assumed drift ruled BioPortal out. It does rule out `--backfill-labels`, which needs a source still
   serving the *same* content as the stored snapshot. A plain re-ingest wants the opposite: because
   BioPortal has moved on, it mints a fresh snapshot and captures labels on the way in. That is the whole
   fix for the six non-OBO ones, and it is cheap — all five stragglers finished in 81 seconds together.
   **The PURL route only works for ontologies whose hierarchy survives without their imports.** A bare
   `purl.obolibrary.org/obo/<id>.owl` is the asserted file, not the import closure BioPortal's submission
   resolves. For MS and RS that changes nothing (no unresolved imports; structure identical or slightly
   better). For FLOPO it was a regression — 22,717 of 35,351 classes arrived parentless against 23 roots
   before, an unbrowsable tree on an ontology allowlisted for both search and browse — so its `latest` was
   moved back to the dated BioPortal snapshot and the new one is retained but unserved. Check roots and
   edges, not just class count, before letting a PURL refresh stand on an import-heavy ontology.

- **15. Investigate storing caDSR CDE value sets.** The enumerated caDSR CDEs — those whose value domain
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

- **16. ORCID / ROR / RRID (and DOI): not versionable per se.** A constraint names the *authority*; the
   value is a stable identifier captured in the instance — no snapshot, no current-version. The spec
   already covers the shape (`sourceSystem` set, `version` omitted). Open question: how the editor and
   instance model represent authority-typed, value-captured, unversioned fields distinctly from a
   versioned controlled term. (The instance is where these land — see item 5.)
- **17. CompTox / PFAS (release-based databases): possibly versionable.** Content with releases, so they
   could fit the content-hash snapshot model *if* they expose retrievable content and release identifiers,
   and *if* a content hash of a flat set (a chemical list, not a hierarchy) is meaningful across
   serializations. Worth a spike.
- **18. Cache the CompTox substance registry locally (bridge server, infra).** On every start the bridge
   server rebuilds its registry by fetching roughly 14,700 substances from the external CompTox API in
   batches of a thousand, holding the result in a `ConcurrentHashMap` that dies with the process
   (`SubstanceRegistry`, driven by the `Managed` `SubstanceRegistryLoader`). Three costs follow: the load
   takes around ninety seconds, during which `/healthcheck` returns 500 and every redeploy shows the
   service as UNHEALTHY; startup depends on a third party being reachable and on the API key being valid
   at that moment; and each restart re-fetches a slowly-changing reference dataset. Persist it instead,
   refreshing on a schedule or when the local copy is stale rather than on every boot, so the server
   serves from the cache immediately. SQLite fits and is already in the stack (`org.xerial:sqlite-jdbc`,
   pinned in `cedar-parent` for the terminology local store). Split readiness from liveness in the health
   check alongside, so a warming server reports as such rather than as failed. Related to item 17: both
   concern how CompTox content enters and is held by the stack.

- **19. Make a missing catalog say so, instead of reporting a store that serves nothing.** The server
   does not check that the catalog file is there. `CatalogStore.openFile` hands the path straight to
   the SQLite driver, so a path into a directory that exists but holds no catalog creates the file,
   `initSchema` builds the tables, and startup logs the store *enabled* for its full allowlist while
   holding nothing. Every lookup then finds the ontology unavailable and proxies, so with fallback on
   it looks like a working store and behaves like BioPortal; under `localOnly` it would refuse
   everything while claiming to be ready. A path into a *missing* directory is the well-behaved case:
   opening fails, the failure is caught, and the server logs an error and serves via BioPortal.
   Measured on 2026-08-12 across all three shapes. Check the file exists and carries the schema before
   opening it, and log the store as enabled only once it can name what it serves.

## The Picker, the Designer and Cutover

The numbered items continue here: the work that
remains on the surface an author authors a versioned constraint through, on the server behind it,
and on retiring what it replaces.
### The Template Designer

Later work, and deliberately after the component stands on its own. Embedding turns every open
question about the picker into a question about the Workbench as well, and none of the three items
here can be finished without the component being finished first. The component itself has nothing
left that does not need a host.

- **20. Make the overlay behave, once there is one to behave.** The picker is an inline panel today
   and the Workbench presents its picker as a modal, so this is the half of the theming item that
   could not be finished without a host: a modal inside a shadow root has to stack above the host's
   own layers and trap focus without reaching into them. Escape already leaves. Sequenced with the
   embedding rather than before it, because what the overlay has to sit above is a property of the
   page it sits in.

- **21. Show the pinned version in the field's configuration panel.** The panel already lists
   everything constraining a field, one repeat per kind over `_valueConstraints`, and it keeps
   that job — the picker adds one constraint and closes, as it does today. What the panel does not
   show is the version, which becomes visible state the moment constraints can be pinned: a field
   constrained to two branches of DOID at different versions looks identical there to one pinned
   at neither.
- **22. Order across ontologies.** Ranking on the match reason is in place, which is the field half
   of what the term-ordering item in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md) measures.
   The ontology half is not: BioPortal multiplies its field score by a per-ontology prior built
   from its own page visits and UMLS membership, and that measurement puts the prior at most of
   the agreement. Nothing local reproduces it. Counting how many CEDAR templates reference an
   ontology was considered and declined, so the head of a common query is ordered within an
   ontology and arbitrary between them — three ontologies calling a class "melanoma" tie, and the
   IRI breaks it. Deciding what, if anything, plays the prior's part is the open question.
- **23. Proxy the ontologies the store cannot hold.** `proxied` is a designed state the server never
    produces: a source not served locally is reported unavailable, including the UMLS-licensed
    ones — SNOMEDCT, MEDDRA, RCD, ICPC2P — that BioPortal could answer for at latest. Reporting
    them as proxied while returning none of their terms would be the silent wrong answer this
    endpoint exists to prevent, so the state waits until something fills it.
- **24. Fill in the definitions the backfill could not reach.** *Built 2026-08-17:* definitions are
    captured at ingest under four standard properties and the two NCIT mints for itself, held in a
    table beside the labels and **outside content identity** — a test asserts that a snapshot with
    definitions and one without hash identically, which is what keeps 2,635 pins meaning what they
    meant. The index carries the one definition a row shows (English first, a definition proper
    ahead of an alternative reading) and migrates itself rather than needing a full rebuild. The
    picker leads the panel with it. `--backfill-definitions-from-raw` fills snapshots already
    written from the raw each was built from, so nothing is re-downloaded.

    *What remains is the reach of that backfill.* Run over DOID, GENEPIO and BAO it added **36,581
    definitions across 9 snapshots**, and left **11 with no matching raw**. That matters more than
    the count suggests: the raw retained is the raw of *some* snapshot, not necessarily the current
    one. GENEPIO's definitions landed on `5f2f174ffcf7` while the index serves `ea798c755474`, so
    its three "disease" rows — the case that motivated this — still show none. The fallback is the
    source-refetch path `--backfill-labels` already uses; without it, an ontology whose current
    snapshot has no retained raw stays undefined until its next ingest.

- **25. Keep the index fresh.** A re-ingest moves an ontology's current version and the index does
    not follow until `SearchIndexJob` runs again. It is incremental and takes seconds for a few
    ontologies, but nothing runs it, and an index behind the catalog reports the version it holds
    rather than the one that exists — correctly, and confusingly. Decide what triggers a rebuild.

### Cutover

- **26. Ship behind a flag for one release, then delete what it replaces.** The new component is the
    default from the day it lands, with the old picker reachable behind a flag so a blocking gap
    found in real use has a way back. The AngularJS directives, controllers and templates under
    `cedar-template-editor/app/scripts/controlled-term/` come out the release after, together with
    the flag — carrying both indefinitely means two pickers writing constraints in two ways, which
    is worse than either. Set the date the old one goes when the flag goes in, rather than leaving
    it to be noticed.

## The Search API

The request and response shapes of `POST /search` and `GET /search/hierarchy`, the endpoints the
picker is built against, keyed to the versioned value-constraint naming.

`POST /search` on the terminology server: search the vocabulary corpus at a named version or
the current one, across the kinds a controlled-term field can be constrained to, in one call.

It exists because `/bioportal/search` takes no version. An author who pins a constraint to an
older ontology and then searches is searching the current one, and can select a term the pinned
version does not contain — which manufactures the irreproducibility the versioning work removes.
`integrated-search` is version-aware and answers the other half of the question: given a
constraint, what may fill it. This answers the authoring half.

Why it is being built and how it is sequenced are the numbered items above. Work is on the
`version-aware-search` branch of `cedar-terminology-server`.

### Naming

Every key naming a source, a term or a version is the key the versioned value-constraint
specification uses — `type`, `sourceSystem`, `sourceAcronym`, `sourceName`, `sourceIri`,
`termIri`, `termLabel`, `termType`, `termBaseIri`, `termBaseLabel`, `termCount`, and the
`version` object with `id`, `effectiveDate` and `declaredVersion`.

This is not tidiness. **A hit is a constraint entry plus the evidence for choosing it.** Take a
class hit, drop the evidence, add the version from the envelope, and the result is the entry
that goes into the template. Any renaming between the two would be a translation layer with
nothing to translate, and translation layers are where a `label` quietly becomes a `prefLabel`.

The specification is at
[Versioned value constraints](https://metadatacenter.readthedocs.io/en/latest/yaml-spec/appendices/versioned-value-constraints/).
Note the four constraint types are `ontology`, `branch`, `class` and `valueSet` — so the picker's
"terms" tab searches for `class` entries, and its tabs are the constraint types rather than a
vocabulary of their own.

### The Request

```json
POST /search
{
  "query": "melanoma",
  "types": ["ontology", "branch", "class", "valueSet"],
  "sources": [
    { "sourceSystem": "bioportal", "sourceAcronym": "DOID", "version": { "id": "63ef56df1a…" } },
    { "sourceAcronym": "NCIT" },
    { "sourceSystem": "agroportal", "sourceAcronym": "AGROVOC" }
  ],
  "lang": "fr",
  "page": 1,
  "pageSize": 20
}
```

A source may be named once. A hit carries the addressing pair and no version of its own, so the
same acronym at two versions would leave every hit from it unable to say which one answered; the
request is refused rather than collapsed.

`sources` does two jobs at once, which is why it is one list rather than a scope and a pin. It
narrows the search to the named sources, and it says which version each is searched at. Omit it
and the whole served corpus is searched at latest, through the index described below. Omit
`version` on an entry, or write
`"version": "latest"`, and that source is searched at latest — the same spelling the constraint
spec uses for an unpinned entry.

**An acronym only means something inside a system.** `sourceSystem` and `sourceAcronym` are the
pair that addresses a source, and BioPortal is one system among several: the store ingests from
any OntoPortal instance, from OBO PURLs and from any URL. An absent or blank `sourceSystem`
means BioPortal, which is both the constraint spec's default and what
`RoutingTerminologyService` already implements.

`types` omitted means all four. `lang` is the preferred display language and does not narrow the
search: recall already spans every language and synonym the store holds, and `lang` chooses which
label comes back.

Paging applies to every type in the request, which is what makes one call answer four tabs. To
page inside one tab, ask for that type alone.

### The Response

```json
{
  "query": "melanoma",
  "sources": [ … ],
  "results": {
    "ontology": { "totalCount": 0,    "countCapped": false, "page": 1, "pageSize": 20, "collection": [] },
    "branch":   { "totalCount": 412,  "countCapped": false, "page": 1, "pageSize": 20, "collection": [ … ] },
    "class":    { "totalCount": 9572, "countCapped": false, "page": 1, "pageSize": 20, "collection": [ … ] },
    "valueSet": { "totalCount": 13,   "countCapped": false, "page": 1, "pageSize": 20, "collection": [ … ] }
  }
}
```

`countCapped` distinguishes a count from a ceiling. When it is true, `totalCount` is the cap
rather than the number of matches, and a client that renders it as an exact figure is lying on
the server's behalf.

### `GET /search/hierarchy` — Where a Term Sits

A search names a term. Whether it is the right term is a question about its neighbourhood, and a
label cannot answer it: ACESO labels a class "Disease" three times over, once per vocabulary it
merges, and the three are told apart by what is above them and nothing else.

```
GET /search/hierarchy?sourceAcronym=DOID&termIri=http://purl.obolibrary.org/obo/DOID_1909
```

```json
{
  "sourceSystem": "bioportal",
  "sourceAcronym": "DOID",
  "source": { "…": "the same source block a search returns" },
  "path": [
    { "termIri": "http://purl.obolibrary.org/obo/DOID_4", "termLabel": "disease" },
    { "termIri": "http://purl.obolibrary.org/obo/DOID_14566", "termLabel": "disease of cellular proliferation" },
    { "termIri": "http://purl.obolibrary.org/obo/DOID_162", "termLabel": "cancer" },
    { "termIri": "http://purl.obolibrary.org/obo/DOID_0050687", "termLabel": "cell type cancer" }
  ],
  "termIri": "http://purl.obolibrary.org/obo/DOID_1909",
  "termLabel": "melanoma",
  "children": [
    { "termIri": "…", "termLabel": "amelanotic melanoma", "hasChildren": true, "descendantCount": 3 }
  ],
  "childCount": 15,
  "descendantCount": 42
}
```

`versionId` is optional and changes where the answer comes from. Given one, the hierarchy is read
from that release's snapshot; without one, from the cross-snapshot index, which holds each
ontology's current version and no other. That distinction is not cosmetic: NCIT's Melanoma has 20
children at 26.06e and 14 at 26.07d, so answering a pinned request from the index would draw an
author the shape of a release they did not choose.

`sourceAcronym` and `termIri` are required: an IRI addresses a term only within a source, and OBO
terms are imported across ontologies. `path` runs root first and is absent where the term is a root of its
ontology — 1.8 million of the index's 13.9 million terms are. `children` is alphabetical and capped
at fifty, with `childCount` saying how many there are in all.

The unpinned answer comes from the index, which holds one parent a term: the ancestors walk in one
recursive query, bounded at thirty-two steps because a broader/narrower cycle would otherwise
recurse without end. A pinned one opens the snapshot and walks the same chain the branch results
walk. Either way a term the store does not hold — a proxied source, an unheld one, a release that
never contained it — is a 404 rather than an empty hierarchy.

### Sources Are Described Once

The envelope describes sources; hits describe matches and name their source with the
`sourceSystem` and `sourceAcronym` pair. Whether a term can be pinned is a property of its
ontology within a request — every SNOMEDCT hit is unpinnable for one reason — so saying it on
each hit would state one fact a hundred times and let the copies disagree.

```json
{
  "sourceSystem": "bioportal",
  "sourceAcronym": "DOID",
  "sourceName": "Human Disease Ontology",
  "sourceIri": "http://purl.obolibrary.org/obo/doid.owl",
  "served": "local",
  "pinnable": true,
  "version": { "id": "63ef56df1a…", "effectiveDate": "2026-07-01", "declaredVersion": "2026-06-30" }
}
```

`served` is `local`, `proxied` or `unavailable`, and `pinnable` follows from it. A locally served
source reports the exact snapshot it was searched at, which is the answer an author who pinned a
version needs confirmed rather than assumed, and which no client can derive from the hits.

**Which of the three a source can be depends on its system.** Proxying means falling back to
BioPortal, so only a BioPortal source has it available: anything else is served from the local
store or reported unavailable, never answered with another system's content. That rule is not
new here — `RoutingTerminologyService` already refuses to proxy a non-BioPortal source. What is
new is saying so. Today that path returns an empty result set, which a caller cannot tell apart
from an honest absence of matches, and ending exactly that confusion is what the source block is
for.

| `sourceSystem` | `served` can be |
|---|---|
| `bioportal`, or absent | `local`, `proxied`, `unavailable` |
| anything else | `local`, `unavailable` |

A proxied source is one the store cannot hold — the UMLS-licensed ontologies, SNOMEDCT, MEDDRA,
RCD and ICPC2P among them. It is served from BioPortal at whatever BioPortal currently holds, so
it carries no content hash and can never be pinned:

```json
{
  "sourceSystem": "bioportal",
  "sourceAcronym": "SNOMEDCT",
  "sourceName": "SNOMED CT",
  "served": "proxied",
  "pinnable": false,
  "version": { "declaredVersion": "2026-03-01" }
}
```

An unavailable source is reported in its own block and the rest of the results are returned:

```json
{
  "sourceSystem": "agroportal",
  "sourceAcronym": "AGROVOC",
  "served": "unavailable",
  "pinnable": false,
  "reason": "versionNotHeld",
  "requestedVersion": { "id": "aa11bb22…" }
}
```

`reason` is `versionNotHeld`, `sourceNotServed` or `sourceUnknown`. `integrated-search` fails the
whole request in this situation and should keep doing so: it resolves a single constraint so a
field can be filled, there is no partial answer worth having, and serving latest in place of a
pin would corrupt an instance. A search across sources does have a partial answer. Both obey one
rule — latest is never served as though it were pinned.

**A client has to render an unavailable source**, or its absence from the results reads as "this
ontology has no matches" when it means "this ontology was not searched".

**The endpoint requires the local store.** With no catalog configured it reports unavailable
rather than falling back to BioPortal for everything, so a caller is never handed unpinnable
results in the belief that pinning was available.

### Searching Everything

A snapshot is a self-contained file, which is what makes a version reproducible and what makes a
corpus-wide query impossible to serve by iteration: 1,215 current snapshots, 13.9 million concepts,
24.3 million captured names, 8.2 GB, measured 2026-08-13. A query naming no source is answered from
a cross-snapshot index instead — one SQLite file, 5.4 GB, built in 196 seconds by `SearchIndexJob`
and rebuilt per ontology as each is re-ingested.

**It holds the current version of each ontology and no other**, which is a property of the question
rather than a limitation of the answer. A corpus-wide search cannot be pinned: there is no one
version to pin it to, only a version per ontology. So searching everything is searching what is
current, and a search that pins names its sources and reads their snapshots directly.

The source blocks then report **the version the index holds**, which is not always the catalog's
current one. An ontology re-ingested since the index was last built was searched at the older
snapshot, and saying otherwise would credit results to a version that did not produce them.

Three things differ from a source-scoped search, and a client can tell which it got:

- **Matching is by token prefix, not substring.** The index is FTS5, so "melano" reaches melanoma
  while it is still being typed, and "elanoma" reaches nothing. A snapshot's `LIKE` does the
  opposite. Reconciling the two belongs with the search-ordering work.
- **Diacritics are folded**, so `aquifere` finds `aquifère` — which the snapshot cannot do, since
  SQLite folds ASCII case only.
- **A branch row carries its descendant count but no path or examples**, and `lang` does not choose
  the label. Both need the snapshot. Absent rather than wrong, and narrowing to the source returns
  them.

Value sets are reached through the collection that holds them, which the index does not record, so
a corpus-wide request searches every collection the catalog knows instead. That is one, CEDARVS,
across the whole served catalog — a bounded set, and not something an author should have to name to
be shown what is in it.

**A corpus-wide query needs at least two characters.** A single character matches a large fraction
of 24 million names, and the cost is in reaching the cap rather than in the cap itself: "a" took
18.6 seconds where "melanoma" takes 0.16. Naming a source lifts the limit, because that path reads
one snapshot.

### Counts Come From Facets, Not From the Page

A page is capped before it is counted, so counting it reports the cap. The counts are separate
aggregate queries over the same match, exact below ten thousand and "more than" above it:

| query | terms | distinct labels | branches | whole response |
|---|---|---|---|---|
| melanoma | 5,439 | 2,552 | 1,313 | 0.16s |
| blood pressure | 3,019 | 1,601 | 912 | 0.09s |
| cell | 10000+ | 10000+ | 10000+ | 1.03s |

`distinctLabelCount` is the second count, and it exists because the first is not a usable badge: a
query anyone types saturates any cap on terms, while the collapsed count varies — 2,552 against
1,601 — and is the number of rows a client that collapses identical labels will actually render. It
is computed for the terms results only, since each facet is another pass over the match.

### Hits

One shape per constraint type. In each, the keys the constraint spec defines for that type come
first; everything after them is evidence, which a client uses to choose and drops when it writes
the constraint.

A hit carries the pair that addresses its source, `sourceSystem` and `sourceAcronym`, and joins
the rest from the source block. The split is between a key and an attribute rather than between
short values and long ones: `sourceSystem` and `sourceAcronym` are how a hit says which source
it came from, while `sourceName`, `sourceIri` and `version` are things that source has, stated
once and copied by a client when it writes the constraint.

### `class` — a specific term

```json
{
  "type": "class",
  "sourceSystem": "bioportal",
  "sourceAcronym": "DOID",
  "termIri": "http://purl.obolibrary.org/obo/DOID_1909",
  "termType": "class",
  "termLabel": "melanoma",

  "definition": "A cell type cancer that has_material_basis_in abnormally proliferating cells …",
  "matchType": "synonym",
  "matchedLabels": [{ "label": "mélanome malin", "language": "fr" }],
  "obsolete": false,
  "replacedBy": null,
  "hasChildren": true,
  "descendantCount": 42,
  "path": [
    { "termIri": "http://purl.obolibrary.org/obo/DOID_4", "termLabel": "disease" },
    { "termIri": "http://purl.obolibrary.org/obo/DOID_14566", "termLabel": "disease of cellular proliferation" }
  ]
}
```

`path` is what tells two classes of one label apart, and a label repeats within an ontology as
often as across them: ACESO merges three vocabularies and labels a class "Disease" in each, under
"Clinical finding", "disposition" and "Disease, Disorder or Finding". A hit from the index carries
the one step above it, which is what the index holds; a hit resolved against a snapshot carries the
chain from a root.

`matchType` is `termLabel` or `synonym`, and `matchedLabels` carries what actually matched, in
the language it matched. Together they are what stops a synonym hit reading as a defect: a row
labelled *melanoma* found by a French search needs to say so. Today's `/bioportal/search`
supplies `matchType` and `matchedSynonyms` but no language, and ignores `lang` on its output
entirely — measured 2026-08-13, where GEMET returns identical labels with and without it.

`matchedLabels` is present only when the served label does not already carry the query, which is
what makes it readable as an explanation. A search reaches a concept through every name captured
for it, so a term whose preferred label answers a query answers it through the synonyms too:
reporting one of those against a row that reads *melanoma* explains a row needing no explanation,
and picks an arbitrary synonym to do it with. Matching folds diacritics, so a label can answer a
query it does not contain — `aquifere` reaches `aquifère`, which is reported.

`obsolete` and `replacedBy` are recorded by the ingest and served by nothing today.
`replacedBy` is `{ "termIri": …, "termLabel": … }` when the source names a replacement.

`hasChildren` and `descendantCount` are what make the branch results computable without a call
per row.

### `branch` — everything at or below a term

```json
{
  "type": "branch",
  "sourceSystem": "bioportal",
  "sourceAcronym": "DOID",
  "termBaseIri": "http://purl.obolibrary.org/obo/DOID_1909",
  "termBaseLabel": "melanoma",

  "descendantCount": 42,
  "matchType": "termLabel",
  "obsolete": false,
  "path": [
    { "termIri": "http://purl.obolibrary.org/obo/DOID_4", "termLabel": "disease" },
    { "termIri": "http://purl.obolibrary.org/obo/DOID_14566", "termLabel": "disease of cellular proliferation" }
  ],
  "examples": [
    { "termIri": "http://purl.obolibrary.org/obo/DOID_6689", "termLabel": "amelanotic melanoma" }
  ]
}
```

The branch results are the class results that have descendants, expressed as branch entries.
`path` runs root-first and is what separates *disease* in DOID from *disease* in an upper
ontology; `examples` are what tell an author whether the subtree is the one they pictured.

`termMaxDepth` is absent deliberately. The constraint carries it, and the author chooses it when
writing the constraint; a search has no view on how deep the field should reach.

### `ontology` — a whole vocabulary

```json
{
  "type": "ontology",
  "sourceSystem": "bioportal",
  "sourceAcronym": "DOID",
  "termCount": 14203,

  "matchType": "sourceName"
}
```

Thin, because everything else about an ontology is in its source block — which the response
carries for every ontology hit, or the acronym would arrive with no way to learn its name.
`matchType` says why it surfaced, and the tab answers two questions in one list. A name match comes
first — `sourceAcronym` or `sourceName` — and then, for a corpus-wide query, the vocabularies the
query actually landed in, `matchType: terms`, each carrying `matchCount`: how many of its terms
matched. `termCount` remains the vocabulary's size as the constraint spec defines it; `matchCount`
is evidence about this query and never becomes part of a constraint.

Both halves are needed because most queries answer only one. Measured 2026-08-13: "melanoma" finds
MELO by name and then NCIT (950 terms), BERO (782), PR (238); "blood pressure" and "aspirin" name no
vocabulary at all, and answer with LOINC (790) and with DDSS (861), DRON (858), RXNORM (663). A tab
that only matched names would be empty for the second kind, which is most of what a picker sees.

The vocabulary half is a group-by over the match rather than a tally of the page, and the difference
is not small: "melanoma" is in 113 vocabularies where its first thousand hits come from 88.

### `valueSet` — a curated list

```json
{
  "type": "valueSet",
  "sourceSystem": "bioportal",
  "sourceAcronym": "HRAVS",
  "termBaseIri": "https://…/analyte-class",
  "termBaseLabel": "Analyte class",
  "termCount": 37,

  "matchType": "member",
  "matchedTerms": [{ "termIri": "https://…/protein", "termLabel": "protein" }]
}
```

`matchType` is `termBaseLabel` or `member`, and `matchedTerms` names the values that matched. A
value set is small and enumerable, so this is the one type where a row can carry enough for an
author to decide without opening anything.

### What Is Not Here, on Purpose

Collapsing identical labels across vocabularies, the match-reason chip, ordering the ontology
results, and everything about how a version is stepped through belong to a client. An endpoint
shaped around one UI is a liability the first time a second consumer wants it, and the picker is
one consumer of a general capability.

### Open

**`sourceSystem` is not yet truthful for OntoPortal instances.** The ingest reaches any
OntoPortal — AgroPortal, EcoPortal — through `--source bioportal --base-url`, and the backend
records `bioportal` for all of them regardless of which instance answered. So the pair that
addresses a source cannot currently distinguish AgroPortal's AGROVOC from a BioPortal ontology
of the same acronym, and this endpoint can only report what the store recorded. Labelling the
authority on the snapshot is already an open item on
[VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md), and it is a dependency of this design rather
than an improvement to it: until it lands, `sourceSystem` distinguishes BioPortal from a direct
URL ingest and no finer.

`sourceIri` remains the canonical, source-independent identity and stays in the source block.
The addressing pair is what a hit carries because it is short and stable; if two systems ever
collide within one response despite the above, the block is where an explicit key would go.

**Ordering.** The results are only as good as the order they arrive in, and today's ordering
leaves the head of the list arbitrary. That work lands here rather than in `/bioportal/search`,
which is what makes it safe to do — see the term-ordering item in
[VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md).

## The Term Picker

What the picker is, what it replaces and what it has built. Findings rather than plans,
like the sections that follow: the work still open is in the numbered items above.

### What It Replaces, and Why

The Workbench picker (`cedar-template-editor/app/scripts/controlled-term/`, about 3,600
lines of JavaScript and a 32 KB template) asks an author to choose a search mode before
searching: a term, an ontology to explore, or a value set. The author finds out whether
that mode had anything to offer only afterwards, and switching modes restarts the search.

The new component inverts that. One query runs against every kind at once, and the author
picks the kind from what the query actually found. An author filling a field usually knows
which kind they want before they open the picker, and the ones who do not are better served
by seeing all four answers than by guessing.

### Decisions Taken

**The picker searches four kinds: ontologies, branches, terms and value sets.** Searching for
an existing CEDAR field to reuse was considered and dropped. Every kind the picker returns is
therefore a value constraint on the field, which keeps the result contract to one shape, keeps
the component to one server, and leaves field reuse to whatever surface in the Template
Designer owns it.

**The Template Designer is the only host.** The picker belongs to template authoring, where
constraints are written; CEE is the metadata viewing and entry surface and does its own
value lookup at fill time. The two never load on one page, so the picker ships as a custom
element rather than a library some other component imports, and the Angular runtime it
carries is paid once by the page that uses it. CEE's fill-time term lookup stays where it
is and is not a consumer of this component.

The host being the AngularJS Template Designer has a consequence worth stating: the
integration is DOM-level, setting properties and listening for events on the element, with
no framework interop between AngularJS and Angular 22 in either direction.

**The picker emits one selection and closes.** A field can carry several constraints of
mixed kinds, and they accumulate outside the picker: an author adding a second constraint
opens it again. This keeps the component to one job — turn a query into a choice — and it
matches what the old picker already does. That picker shows a confirmation row for the one
selection in flight and never displays the field's constraint set; the set is rendered by
the field's configuration panel
(`cedar-template-editor/app/scripts/form/partials/configuration-options.partial.html`, four
repeats over `_valueConstraints`), and the picker touches it only to merge its addition back
on save.

**Latest is the default, and choosing it writes nothing.** Freeze-on-publish resolves an
unpinned constraint at publish time, so latest keeps meaning latest until the template is
published. A `version` appears on a constraint only when the author steps off latest.

**Version selection is per constraint.** Each constraint carries its own version, which is
how the backend already stores and freezes them, so nothing has to be reconciled across the
constraints on one field.

**The bar is half search, half what has been found.** The search takes the left half and a phrase
for the selection takes the right: the kind of constraint, the thing it names, its ontology, and the
release — "Every term in Mondo Disease Ontology · MONDO · latest". A row is dense with the evidence
for choosing it and says nothing about the choice itself; this is the other half.

An unpinned selection says "latest", not the release latest currently resolves to. The constraint
records no version at all and freeze-on-publish resolves it at publish time, so naming today's
release there would describe something the template will not say. A pinned one states all three
things it does record — declared version, effective date and content hash — because that triple is
the constraint: "Disease or Disorder · NCIT · 26.06e · 2026-07-02 · ac54fb1c612a".

A class says no kind. "The term" before a label named the tab it was found on; an ontology and a
branch keep theirs, because "Every term in" and "Everything under" say what the constraint covers
rather than what it is.

Nothing is shown until something is selected, rather than an empty frame reading as a selection of
nothing. Both halves keep their width either way, so selecting does not move the input. The dismiss
sits in the panel's corner rather than in the bar's flow, where it was centred against a bar as tall
as the search field and left floating in the middle of the panel.

**Marking a row opens what it is offering.** The rows under a folded label are a shortlist; the
marked one is the row an author is deciding about, and the decision is a term IRI written into a
template. So the panel is that IRI, the chain above the term, the other names the source records
for it, what matched where the label did not, and what replaces it where it is deprecated. Which
IRI depends on the kind: a class or branch constraint records the term's, an ontology constraint
the ontology's, and the panel shows whichever the row would write. Every kind opens it, the
ontologies tab included. It is the same two acts as choosing: a click opens it, a second confirms.

Nothing else is on it. The ontology's name, its acronym, its release and the size of the subtree
are all on the row already, and repeating them under the row spent the panel on what the author
had just read.

**The panel draws a tree the author can walk.** The chain above the term, the term, and what hangs
below it, every node opening where it stands. ACESO's three classes called "Disease" become three
different answers: one under "Clinical finding", opening onto Developmental disorder, Drug-related
disorder, Mental disorder and Substance abuse, and each of those opening in turn. A click on any
node selects it and the bar says so; a double click takes it, so a term found by browsing is chosen
the same way as a term found by searching.

That needs two pieces of state rather than one: the row whose panel is open, and the thing selected.
Selecting inside a tree leaves the panel where it is — the tree is where the term was found, and
closing it would take the context away at the moment an author is using it.

**A selected term is carried across a change of release.** An author reading a term deep in one
release and stepping to another means to see that term there, not to be returned to the row they
started from, so the same IRI is looked for in the new release and the tree opened down to it. A
release that does not contain it — a term added since, or removed — falls back to the row's own
term, which every release of the ontology has.

**The tree is of the release the row is reading.** It sits under the release list rather than above
it, because that is the order of the two decisions: a release, and then a shape within it. Stepping
an ontology back re-asks rather than redrawing what the current release happens to look like — the
picker keys a held hierarchy by release as well as by term, and passes `versionId`. The difference
is real: NCIT's Melanoma has 20 children at 26.06e and 14 at 26.07d.

Nodes read their children as they open, from `GET /search/hierarchy`, one node at a time: a
hierarchy is a tree, SNOMED's clinical findings run to hundreds of thousands of concepts, and an
author opens the handful on their way down. What a node needs before it opens — whether it has
children at all, and how much is beneath it — comes from its parent's answer, so a closed tree
fetches nothing.

The chain itself never collapses. Closing an ancestor hides what stands beside the path, not the
path: a tree that collapsed to its root would lose the term the panel is about. This is what the
Workbench picker does by re-rooting a flat list of children on every click, which loses where you
have been.

Many chains are one step or none: AD-CDO labels a class Disease and declares it a root, with no
parent edge in its snapshot, and 1.8 million of the index's 13.9 million terms are roots of their
ontology. The index records one parent a term, so a term with several parents is drawn under the
one the ingest kept — a real limit, and the reason a chain is "a" path rather than "the" path.

**The other names come from the index, in one query for the page.** They are what says whether a
concept is the one an author meant, and they are worth nothing at a round trip a row. Shown eight
at a time and then a count, because a source decides what a synonym is and some decide oddly: BPT
records "Description: Melanoma is the most aggressive form of skin cancer…" and a URL as exact
synonyms of Melanoma, twenty-one names in all.

What is still missing is a definition. The ingest captures labels and synonyms and no definition at
all — the index holds ten name properties, `prefLabel` and `rdfs:label` through the four
`oboInOwl:has*Synonym` — so a definition is an ingest change and a re-run across 1,215 ontologies,
not a display one.

**A term row carries nothing about the subtree beneath the term.** It showed a descendant count,
which answers the branches tab's question: a class constraint is that term, and what sits under it
changes nothing about the constraint. The same label appearing on the branches tab is where the
subtree becomes the decision.

**A term row names the step above it only where that is what distinguishes it.** A label repeats
within one ontology as readily as across several — ACESO merges three vocabularies and labels a
class "Disease" in each, so two of its rows carry the same acronym, the same name and the same
release. Saying the parent on every row was noise; saying it on none left two rows an author cannot
tell apart, which is what a fold of 245 ontologies makes of ACESO, BAO and BBO. So it is said where
a fold holds more than one row from an ontology, and nowhere else.

**The narrowing strip is chips and nothing else.** Adding an ontology and removing one are the same
kind of act on the same strip, so the way in wears the shape of what it adds — a dashed chip reading
"+ ontology", outlined rather than filled so the row reads as the ontologies chosen plus one empty
slot. "Search everything" is gone: removing the last chip already does it. What is left of it is a
bulk reset in plain text beside the chips, shown only while something is narrowed, because it is
worth having once several ontologies are on and worth nothing before that.

**A term's other names are tags, not chips.** The tint marks a selection everywhere in the picker,
and a row of tinted synonyms read as eight things an author had chosen. They are outlined and muted.

**Narrowed to one ontology, the terms tab draws that ontology's tree.** Folding by label answers a
corpus-wide question — two hundred vocabularies offering one label — and inside a single ontology it
says nothing while a flat list hides what an ontology is for. So the matches are drawn where they
sit, rooted, with the ones the query found in the heading colour and their ancestors muted as
context.

It costs no extra call. A search naming one source returns each hit's whole ancestry rather than the
one step the index holds, so the union of those chains is a tree rooted by construction: no request
for the roots, and no walk down from them to find where the matches are. The chains cost a recursive
query a hit, which is affordable at a page of them and is not at a corpus-wide page touching a
hundred ontologies — which is why the whole chain is what a scoped search gets and the one step is
what everything else gets.

**Branches order by what they hold, within how well they matched.** A branch constraint is
"everything under this", so size is the thing being chosen between — but size alone is only right
for a generic query. Measured 2026-08-15 over the live store: ordering branches by descendant count
alone puts "disease, disorder or finding" (50,839 beneath) at the head of a search for *disease*,
which is the branch an author means, and "melanoma ontology" (526) and "malignant skin neoplasm"
(421) at the head of a search for *melanoma*, above "melanoma" itself (321), which is not. Ranking
by match first and by size within a rank leads with the exact branch in every case and still orders
the rest by weight, so that is what ships.

**A branch row counts branches, not positions.** A folded row says "179 branches in 149
ontologies", the extra thirty being ontologies that place one concept at several points in their
own tree. It carried the range of descendant counts across the fold too, and that came off: it
could not be a total — the branches in a fold are the same idea drawn by different ontologies, and
summing them would count the same concepts many times over — and as a range it was a figure with
no decision attached, since the decision is made against the per-ontology counts inside the fold.

**A branch hit is a class hit that has descendants.** The Branches tab answers the same
query as the Terms tab, filtered to hits with something beneath them and framed as
"constrain to everything under this". The tab strip therefore keeps its promise that one
query answers every tab.

**Every settled keystroke queries all four kinds**, debounced and with superseded requests
cancelled, so a badge never describes a query the author has moved on from.

**A tab badge shows an exact count when it is small and a capped one when it is not**, and for the
terms tab the count is of distinct labels rather than of hits. Measured 2026-08-13, a hit count is
not a badge: every query anyone types saturates any cap on terms, so it would read the same for
"melanoma" as for "aspirin". The collapsed count is what the author will actually see once identical
labels are folded into one row, and it varies — melanoma 2,552, blood pressure 1,601, diabetes
3,107, aspirin 1,720, against hit counts of 5,439, 3,019, 5,824 and 3,122. Counting stops at ten
thousand and says "more than" above it, which is where a broad query lands and where no number is
actionable anyway.

**A query matches preferred labels, synonyms and labels in any language.** The local store
already serves that recall, and taking it is the difference between an author finding a
term by the name they know and not finding it at all.

**An author can narrow a search to named ontologies, and the narrowing applies to every
tab.** One filter constrains terms, branches and value sets together, which is also the
cheapest way to make a query with hundreds of thousands of hits usable.

**Provisional term and value-set creation is retired.** The old picker offers it from its
first screen; the new one does not, and the capability leaves the authoring surface with it.
Retiring creation does not retire the data — provisional terms already referenced by
templates have to keep resolving — so the retirement is a decision about the picker, not
about the terminology server's provisional endpoints.

**The repository publishes itself**, as CEE and the TypeScript model library do. Its version
moves when the component changes rather than with the platform release run. `cedar-cli` has
no entry for it and needs none: `skip_from_release` filters repos that are already
registered, so a repository the CLI does not know is excluded already. Registering it later
would buy the estate-wide checkout, pull and status commands, which run over the unfiltered
list, and the entry would carry `skip_from_release` to stay out of the release run.

**The component renders in shadow DOM** and exposes a small set of CSS custom properties for
the host to theme it through, which is the contract CEE arrived at.

**It takes CEE's design values, by copying them.** `_cee-tokens.scss` and the three embedded
Roboto weights are copied into the picker verbatim, under CEE's filenames and with its `$cee-`
prefixes, so a `diff` against the original is one command. CEE publishes only a built bundle to
npm, so consuming the values from the package is not available, and a shared package is the
thing to consider the first time a value has to change in both rather than work to do now. The
controls themselves stay ours: Angular Material would make the two genuinely match, at the cost
of a large dependency, and CEE's own M2-to-M3 migration is still open.

**The neutrals are gathered rather than copied.** CEE has no neutral palette: its greys are
literals written where each is used. So `_cedar-neutrals.scss` collects the recurring ones from
what CEE renders — `#777` for a control border, `#555` for secondary text, `#f5f5f5` for a panel,
`#d7e0df` for the tinted rule under its header — with each value's source noted. Body text is
`rgba(0, 0, 0, 0.87)`, which CEE renders by inheriting Material's default rather than by stating
it. That file is picker-owned and has nothing upstream to diff against. Consolidating these back
into CEE would improve both and is not this repository's to do.

Still open is spacing, which neither repository has as a scale. Embedding all three font weights
also costs about 184 kB, most of the bundle; what that does to the budget is in
[VERSIONING-RUNBOOK.md](./VERSIONING-RUNBOOK.md).

**Terms is the tab the picker opens on**, every time, so the landing place never moves under
an author who is typing.

**Search ordering is a prerequisite, not a parallel track.** The picker rests on an author
reading the first handful of hits and recognizing one, so it does not ship on ordering that
leaves the head of the list arbitrary.

**The picker requires the local store, and says so when it is missing.** An earlier decision
had it degrade instead — searching through BioPortal with the version controls simply absent —
and the endpoint below supersedes that: it reports unavailable when no catalog is configured,
and the picker tells the author the search service is unavailable rather than quietly serving
unpinnable results. This forces the open production question rather than working around it:
either production carries a catalog or it has no term picker.

**The terminology server gains a version-aware authoring search**, and the picker is built
against it rather than against `/bioportal/search`. Being able to search *at a version* is the
reason, and it is a correctness matter rather than a feature: `/bioportal/search` takes no
version, so an author who steps back to an older DOID would be searching the current one and
could pin a constraint to a term that does not exist in the version they pinned — manufacturing
the irreproducibility this whole effort exists to remove. `integrated-search` is version-aware
and shaped for the wrong moment, since it takes a constraint and asks what may fill it.

Four things settled about it:
- **A new root path, `POST /search`**, the first resource in the service outside `/bioportal`.
  That namespace exists because CEDAR proxied BioPortal, and this is not a BioPortal client.
  POST rather than GET because the request carries a version per source alongside the kinds and
  the scoping, which is the same reason `integrated-search` is a POST.
- **It replaces `/bioportal/search` once its consumers move.** The old route stays while CEE and
  the Template Designer still use it, and then goes. Ordering, obsolete and language work land
  once, in the new endpoint, rather than being maintained in two places that quietly diverge.
- **The local store is assumed.** No catalog, no answer — the endpoint reports unavailable
  instead of falling back to BioPortal for everything.
- **Per-ontology proxying survives, at latest only.** An ontology the store cannot hold — the
  UMLS-licensed ones, SNOMEDCT, MEDDRA, RCD, ICPC2P — is still served from BioPortal, and can
  never be pinned. Without somewhere for that to be said, an author pins a SNOMEDCT constraint
  and finds out at publish time, when freeze raises `PinnedVersionUnavailableException` as a 422
  — the failure landing a long way from the mistake.
- **That is said once per source, in the response envelope, not on every hit.** The fact is a
  property of an ontology within a request, not of an individual term: every SNOMEDCT hit is
  unpinnable for the same reason, and repeating it a hundred times would state it a hundred
  times and let the copies disagree. Hits already carry `source`, so the client joins.

  The block earns its place beyond pinnability, because it is the natural home for what a
  version-aware search has to report and today's has no way to say: **which version each source
  was actually searched at.** Served locally at a named version, or proxied at whatever
  BioPortal currently holds — an author who pinned a version needs the answer confirmed rather
  than assumed, and a client cannot derive it from the hits.

Work on it is on the `version-aware-search` branch of `cedar-terminology-server`.

**The picker holds the author's own credentials and uses them everywhere.** One credential
for terminology search and for the ontology list, which means the terminology server has to
accept a user credential where it expects an API key today.

**Property search and relation-type selection are retired**, on the same terms as
provisional creation: the picker keeps to the four kinds it advertises.

**Ontologies are found by name first, then by the vocabularies the query landed in.** Name and
acronym matches lead, ordered by match quality and then alphabetically. After them come the
vocabularies whose terms the query actually matched, each with how many — which is a group-by over
the same search, not a tally of the page.

This revises an earlier decision to match on names alone, and the evidence is what revised it.
Measured against the built index on 2026-08-13: "melanoma" finds MELO by name and then NCIT (950
terms), BERO (782), PR (238); "blood pressure" and "aspirin" name no vocabulary at all while
matching terms in 164 and 97 of them. A name-only tab is empty for most of what a picker sees, and
"which vocabulary should this field draw from" is the authoring question that the same query already
answers.

Ranking by CEDAR's own use of an ontology — how many templates already reference it, which
`ops/cedar_ontology_usage.py` can harvest — remains dropped, and the count is not shown. It would
have entrenched what authors already chose, and it would have made the tab depend on a number
somebody has to keep current.

**Identical labels collapse into one row.** A corpus-wide query for "melanoma" leads with the exact
string from VALUESETS, IRAEO, MDM, NCIT, CSEO and RH-MESH, measured against the index on 2026-08-13; the author's question at that point is which vocabulary,
not which of thirty near-identical rows. One row per distinct label, expanding to the
vocabularies offering it.

**Obsolete terms are shown, marked and demoted**, never hidden and never excluded. An author
sometimes needs a deprecated term deliberately, to match data that already uses it.

**Constraints written by the old picker are not migrated.** An absent `sourceSystem` already
means BioPortal, and the acronym derives the rest, which is how the backend reads them
today. The canonical-IRI backfill on the versioning roadmap stays a robustness improvement
rather than something this work depends on.

### What Each Tab Shows

The four kinds are one question at three scales plus a fourth thing. How much of a vocabulary
may this field draw from — all of it, a subtree, a single concept? A value set answers
something else: whether somebody has already written the list by hand.

Two of the tabs are views over one search. Terms and branches come from a single class query,
branches being the hits that have descendants, so their counts are related rather than
independent. Ontologies filter a list cached once per session, and value sets are their own
corpus.

**Terms — which concept, and whose.** One row per distinct preferred label, expanding to the
vocabularies that offer it. A row carries the label, the ontology, a definition snippet, and a
match-reason chip wherever the reason is not the label on screen: *matched synonym "cutaneous
melanoma"*, *matched French label*. The search response carries `matchType` and `matchedLabels`,
so the chip needs no new backend work. Without it a synonym hit reads as a defect rather than as
recall — and on a row whose own label answers the query, the chip is the noise it exists to
prevent, which is why the server withholds it there.

**An ontology row shows what matched rather than labelling it.** A vocabulary is on the tab because
its name matched, its acronym matched, or its terms did, and the first two mark the part that
matched in the name and in the acronym. A row with nothing marked is there for its terms, and its
count is the whole of the reason. The row said "named ·" before the count, which named the reason a
second time and named it for the rows that needed it least.

**Ontologies — which vocabulary this field draws from.** Name and acronym matching over the
cached list, ordered by how well the name matches, with the ontology's size and its current
version on the row. The tab answers a different question from the others and returns far less:
"melanoma" finds one ontology, MELO, against 90 DOID terms (measured 2026-08-13), and a query
naming no vocabulary finds none. Its empty state therefore has to do real work — say that nothing is named this, and point at
where the query did find something — or the tab reads as broken on exactly the queries the
picker is best at.

**Branches — which part of a vocabulary.** Only hits with descendants, and the row has to
answer what an author would be capturing: the class label, its ontology, its path from the
root as a breadcrumb, the descendant count, and two or three example descendants inline. The
breadcrumb is what separates *disease* in DOID from *disease* in an upper ontology, and the
examples are what tell an author whether the subtree is the one they pictured.

**Value sets — whether the list already exists.** The tab stays, though CEDARVS is the only
value-set collection in the served catalog: a value set is a distinct constraint kind with its own
shape, and more collections are expected — storing caDSR's is already on the versioning roadmap. A
search naming no source looks in every collection the catalog knows, so an author is shown what is
there without having to name it.

It is the one tab where showing contents is cheap,
because value sets are small and enumerable. The row gives the name, its collection, how many
values it holds, which of its values matched the query, and the first few values inline. An
author can usually decide without opening anything, which is not true of the other three.

### What Is Built

The component runs against the live corpus and the four tabs answer. `POST /search` on the
terminology server backs it, on the `version-aware-search` branch, and a cross-snapshot index
backs corpus-wide queries.

**The endpoint.** A query at a named version or the current one, across the four constraint
types, in one call. Per-source blocks say which snapshot answered, whether it can be pinned, and
— for a source that could not be searched — why, rather than letting its absence read as an
absence of matches. A source may be named once per request, because a hit carries the addressing
pair and no version of its own.

**The index.** 1,215 ontologies, 13,939,470 terms, 24,278,806 names, built in 226 seconds into
5.4 GB, answering a corpus-wide query in about a quarter of a second. It holds each ontology's
current version and no other, which is a property of the question: a corpus-wide search cannot be
pinned, since there is no one version to pin it to. Matching is FTS5 — token prefixes, folded
diacritics, so `aquifere` finds `aquifère`. Ranking happens in SQL because the cap truncates
before a caller can reorder; ordering by label length alone filled it with coded vocabularies'
numeric ids and dropped the terms named after the query.

**Hits rank on what matched.** An exact preferred label first, then an exact synonym, then any
other exact name, then a prefix, with hidden labels last, and length only as a tie-break within a
tier. Obsolete terms rank second, so a retired term is shown and marked but sits below the live
terms that answer as well — not below every live term that answers worse, which would bury an
exact hit on a retired label. A query for melanoma now leads with the three ontologies that call a
class exactly that; before, it led with "Malignant Melanoma".

**A version reads as its ontology declares it.** No synthesised `v`, which was wrong about the
string as often as not: the catalog holds `V2`, `v1.0.0`, `2026-07-06` and `latest`, rendered as
`vV2`, `vv1.0.0` and `vlatest`. Declared means arbitrary — `owl:versionInfo` is free text, and of
the 998 snapshots that fill it, 915 are 20 characters or fewer while the longest is 782 characters
of prose, newlines and a table of HTML. The row elides from the middle at 20 and carries the whole
string in its title, so a version that is prose costs a hover rather than the layout. A row with
more than one release says how many, and that count opens the whole history beneath the row.

The count carries a caret and the primary colour, because the mechanism was there and unreachable
without them: muted grey beside a muted version, it read as another figure rather than the one
thing on the row that opens. The panel keeps a sticky heading that names the hash column and says
how many releases there are, and shows a thin track rather than one appearing only once an author
is already scrolling.

**The history is the release list, and it replaced the step arrows.** A `‹` and a `›` moved an
ontology one release without saying which release it reached, and asked an author to recognise the
glyphs first; the panel says both in one click, so the arrows are gone and the row is two cells
narrower. Every release gets its own line: the declared version, the effective date, and the
content hash that makes a pin reproducible. It scrolls rather than growing — DOID has fifteen
releases and nothing bounds what an ontology accumulates — and it marks the one the row is reading.
Choosing the newest unpins rather than writing today's version, so a constraint records a version
only where the author chose one. A release declaring no version says so; of the 1,215 ontologies
the store holds, some declare a file path where a version belongs, so the panel shows the string as
it is and lets the date and the hash identify the release.

**The rows of a tab share one set of columns.** Counts, versions and the release count sit in
tracks the whole list declares, through CSS subgrid, so a row keeps its own box — it tints when
marked and rules off from its neighbours — while its trailing cells line up with every other row's.
A row with one release emits an empty cell rather than nothing, since a row emitting fewer cells
than its neighbours shifts every cell after it. Counts run right against their column, so the
repeated words align rather than starting wherever a number ends.

**Dismissal is a glyph.** The bar's ✕ emits `cancelled` and nothing else, so a host that closes on
it closes with the field's constraints as they were. Spelling it "Close" gave the one control that
answers nothing the weight of a choice, beside the field where the choices are made.

**A row is chosen in two acts.** A click marks it and a double click, or Enter on a focused row,
emits it. The per-row buttons are gone with that: a "Use" on every line spent the width the names
need, and the narrowing button duplicated the filter panel above the tabs, which is where narrowing
belongs. One click no longer decides anything, which matters when the rows are a line tall and
adjacent. Enter carries the decision for the keyboard, since a double click has no equivalent
there.

**Both list tabs page by distinct label**, not by hit, and carry every hit of the labels on the
page. Paging by hit made folding impossible to do honestly — a page of twenty-five hits for a
common word is one label — so a row could only ever claim a count "on this page". Terms fold
across ontologies; branches fold across and within, because a thesaurus can place one concept
several times in its own tree.

**A theming contract of ten custom properties**, and a discipline about what is missing from it.
A host sets the brand, the text and surface colours, the border, the warning colour, and the font
family and base size; row geometry, control padding and the meaning of a colour stay with the
component, because a host able to re-point those could make an obsolete term look ordinary. The
type scale moves with the base and the tint is mixed from the brand, so neither is left behind by
a host that changes one. Escape leaves the picker.

**Thirteen browser tests drive the built bundle**, with the terminology server stubbed, so the
suite is hermetic and says what the component does with an answer rather than whether the answer
was good. They hold the faults this work found by hand, which is every fault it found: a fold that
swallowed a group, a panel that cleared the list an author was choosing from, rows reading "BERO
BERO", a row three times the height of its neighbours. They drive the production bundle over a
static server rather than `ng serve`, because a build that breaks the bundle while leaving the dev
server working is the failure worth catching.

**Narrowing.** One filter serves every tab, chosen from a panel ranked by how much of the query
each ontology holds — a different order from the ontologies tab, which leads with a vocabulary
named after the query. For melanoma that is the difference between MELO, aptly named and holding
38 terms, and NCIT with 950. Narrowing keeps the index rather than dropping to the snapshots, so
the same search runs over less rather than a different search running.

**One list per tab, extended by scrolling.** The results box scrolls, and reaching within a
screenful of the end fetches the next page of that type alone and appends it. Page numbers were
the wrong shape for the data: a count that stops at its cap reads "page 1 of 400+", which asks an
author to navigate a list whose length nobody knows. A page that comes back short is the end, and
the only signal there is — so the list says "no more matches" rather than counting to it. A first
page too short to scroll fetches on by itself, since scrolling is what asks and there would be
nothing to scroll. Source blocks accumulate as later pages name ontologies the first did not.

**The rows.** One line each, folding what an author cannot choose between and opening onto what
they can. A long label folds from the middle, keeping both ends, because LOINC puts a whole
question in the label and its axis codes after it. A row leads with the name that matched when the ontology's label is a bare code. A
branch shows its parent, since a label does not always identify a class. An ontology row ranks
name matches and term matches together, because segregating them spent the first page
alphabetically and never reached the vocabularies that hold the terms.

**Choosing a release.** Rows for the pinnable kinds carry `of 8 ⌄` where the store holds more than
one release, opening the history described above. Choosing the newest unpins rather than pinning to
today's version, so a constraint records a version only when the author chose one.

Three things the work measured that the plan below rests on:

- A corpus-wide query needs at least two characters. One matched a large fraction of 24 million
  names and took 18.6 seconds where "melanoma" takes 0.11.
- Counting stops at ten thousand. Counting every match of a broad query is a deduplication of much
  of the corpus — "cell" takes 3.2 seconds unbounded and 40 milliseconds capped — and nobody acts
  on the difference between ten thousand rows and three hundred thousand.
- These figures came from a server carrying the catalog and the index. That was a second instance
  when they were taken, because 9004 ran storeless; 9004 serves the store itself since
  `CEDAR_TERMINOLOGY_STORE_CATALOG` and `CEDAR_TERMINOLOGY_STORE_INDEX` went into the profile, so
  a figure read from it now is the store's. A server without them reports the version-aware
  endpoints unavailable rather than answering from BioPortal, which is what makes the difference
  visible instead of silent.


## Ingestion tracker (ongoing)

An **iterative** task: updated each time more ontologies are ingested from other repositories (item 10).
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
  across 77 snapshots incl. giants MESH/BERO/DDSS/LOINC/EFO — item 11). Residual re-fetch tracked as item 15.
- 2026-08-06 — targeted pass over the served prod catalog: item 14's label re-fetch (all ten, closing it)
  plus the ingests deferred from the 2026-08-03 OBO pass (prod 1332→1343 snapshots, 1309→1320 hashes,
  1214→1215 acronyms).
  **NCBITaxon is the headline** — the refresh that was deferred as too RAM/time-heavy ran in 82 min at
  40g with the terminology server stopped, and BioPortal's submission turns out to have been badly
  truncated: **761,814 → 2,854,537 classes** (2,854,485 edges), roots *down* 63 → 3 (`NCBITaxon_1` plus the
  two TAXRANK meta-classes), and +3,354,524 labels. 2.1 GB snapshot; verified serving live. Also **NCIT**
  from BioPortal (206,628 → 206,860 classes, roots unchanged at 18, +206,860 labels), **MS** and **RS**
  (structure unchanged or marginally better, +4,619 and +14,611 labels), and **GEMET** newly ingested
  (5,609 concepts via `skos:broader`, +202,276 labels — its 2026-08-01 failure is resolved, see below), and
  item 14's five non-OBO stragglers from BioPortal (DOVES, MIXS, MOLSIM, NAMO, SSTIM — 81 s for all five).
  **FLOPO refreshed and reverted** — see item 14; the store keeps both snapshots.
  *GEMET's failure was never the remote end.* It fails under Java with `SSLHandshakeException: PKIX path
  building failed` because `eionet.europa.eu` serves a chain JDK 17's truststore will not build a path to.
  `curl` succeeds against the same URL using the system trust store, so a curl reachability check does not
  predict whether the ingester can fetch it. Ingested instead by downloading with curl and serving the dump
  over loopback http, which needs no truststore edit and costs nothing in provenance: the catalog records
  the ontology's canonical IRI read from its own content plus the `--backend` label, never the download URL.
  **GEMET is now served** (both allowlists, 2026-08-07): 5,609 concepts, 148 roots, 37 languages, every
  concept carrying an English label and 5,461 of 5,609 a parent. Verified live on all four paths — search
  (249 hits for "water"), `lang=fr` on the same query (chaudière / ruissellement / eau usée / aquifère),
  `/classes/roots` returning exactly the snapshot's 148, and class detail under `lang=de`
  (`concept/518` → Grundwasserträger). Store load went 1212/1211 → 1213/1212 ontologies.
  *An ontology BioPortal does not carry cannot be gated, and this is structural, not a gap.* The gate is a
  differential against recorded BioPortal goldens; BioPortal has no GEMET (`/ontologies/GEMET` → 404), so
  there is nothing to record and `cedar_term_gate.sh` has no opinion to offer. The same holds for EMI and
  for every future `--source url` / non-BioPortal-OntoPortal ingest. Two consequences worth keeping in
  mind: such an ontology is admitted on local verification alone (structure, language coverage, and a live
  REST check of all four paths — the checklist GEMET just ran), and because `sourceSystem` routing never
  proxies it, the allowlist is not an optimisation but the only thing making it reachable at all — before
  allowlisting, a GEMET search returned HTTP 404 rather than falling back to anything.

**Next iterations** are one command — `ops/harvest-ols-ingest.sh` (source expansion) and
`ops/harvest-obo-ingest.sh` (OBO release currency), both `<catalog> <snapshotDir> [--max N]`, idempotent,
skipping already-current acronyms and logging/skipping failures.

Ordered for the next unattended run, cheapest and most certain first. The catalog is
`$CEDAR_HOME/cedar-term/prod/catalog.sqlite`; back it up before any write, and re-check roots and edges
after every refresh rather than class count alone (this is what caught FLOPO).

1. **Give FLOPO its labels back.** The only item-14 ontology still without a label side-table. It needs a
   source carrying its import closure, which the bare OBO PURL is not — try BioPortal, the route that
   worked for the other six, and keep the reverted `latest` if the tree does not come back at ~23 roots.
2. **Settle DDSS.** The catalog shows 807,061 classes and 800,850 edges as of 2026-07-29, contradicting
   the "re-ingest timed out; unresolved" note in reconciliation issue 12 — it is in neither allowlist. If
   the snapshot really is healthy this is a free promotion; the work is a browse/search check, not an
   ingest.
3. **Bulk-harvest the remaining OLS `fileLocation`s** (`ops/harvest-ols-ingest.sh --max N`). Open-ended, so
   bound it. Note these arrive unserved: a BioPortal-carried ontology still needs the differential gate,
   and one BioPortal lacks cannot be gated at all and is admitted on local verification (GEMET above).
4. **Add another OntoPortal instance** (EcoPortal, IndustryPortal — each needs its own API key).
5. **Grow version pairs** from dated OBO/GO release URLs, for diff coverage.

Not worth retrying: **OGG**, whose PURL still 404s upstream (checked 2026-08-06; the 2026-07-29 snapshot
stands), and **EO1**, deferred by decision (item 7 — its SKOS source declares `skos:broader` as string
literals).

## BioPortal reconciliation issues

A living log of every way the local terminology replica diverges from BioPortal, why, and what
we did about it. Compiled from the corpus-wide differential gate over the 1,214 ingested
ontologies (goldens + snapshots under `$CEDAR_HOME/cedar-term/gate-all/`). Kept for later review; append
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

### 2. Zero-label ontologies emptied by the root prune  — FOLLOW-UP

Twenty ontologies carry no `rdfs:label`/`skos:prefLabel` at all (e.g. ACGT-MO: 1,754 concepts, 1,732
edges, **0 labeled**). Because every root is then unlabeled with no labeled descendant, the dead-end
prune (issue #1) removes *all* of them, leaving 0 roots — unbrowsable — so they are excluded from
the browse allowlist and proxy to BioPortal (which shows their unlabeled roots). Refinement worth
doing: `pruneDeadEndImportRoots` should never prune an ontology to zero roots (keep the originals
when the prune would empty it), so a label-less-but-structured ontology still browses locally.

### 3. Source data contains OWLAPI parse-error artifacts  — EXTERNAL

Some ontologies' source files fail to parse cleanly, and OWLAPI emits placeholder classes in the
{@code http://org.semanticweb.owlapi/error#ErrorN} namespace. BioPortal ingests and displays these
(labeled "ErrorN"); our extractor also captures them, where they surface as unlabeled foreign roots.
Example: ABD has 54 such error roots (BioPortal shows all 392 roots including them; our prune drops
them, serving 338). Issue #1's prune removes them from the tree; the underlying source-file parse
failure is upstream and not fixable at ingest.

### 4. Root over-reporting on BioPortal's side: foreign / meta vocabulary  — BP-ARTIFACT

BioPortal roots external vocabulary that we correctly exclude: RDF/RDFS (`Datatype`, `Resource`,
`List`), FOAF (`Organization`), Dublin Core (`Agent`), SKOS (`Collection`), OWL-Time
(`TemporalEntity`), Protégé (`PAL-CONSTRAINT`), BIBO (`ThesisDegree`), and imported upper-ontology
IDs (`BFO_0000001`, `GO_0008150`, `NCBITaxon_1`, `OMIM_000000`).

- **Evidence.** Across the 25 pure-subset ontologies, 126 of 176 missing roots are these foreign
  classes; e.g. PO's only "gap" is `obo/NCBITaxon_1` ("root"), NIFSTD's is `obo/OMIM_000000`.
- **Verdict.** BioPortal artifact; local is cleaner. No fix.

### 5. BioPortal misses real subClassOf edges we captured  — LOCAL-BETTER

BioPortal reports a class as a root that in fact has a genuine `rdfs:subClassOf`/genus parent our
OWLAPI extraction captured.

- **Evidence.** One disease branch: BioPortal returns 197 direct children where 8 is correct (it
  dropped a `subClassOf` edge and dumped the orphans under the root). 50 such cases across the
  subset/mixed ontologies (e.g. BCIO `CHEBI_50906` → "realizable entity", JFO allergen → food
  allergy).
- **Verdict.** Local is more correct. The gate's directional invariant ("every BioPortal root is
  also a local root") holds for 1,099/1,191 (92%).

### 6. BioPortal root set is not rule-reproducible  — BP-ARTIFACT / OPEN

No clean local rule reproduces BioPortal's roots, because BioPortal resolves some imports and not
others, inconsistently. "Roots must be labeled" wrongly drops 433 ontologies to subset (BioPortal
roots legitimate unlabeled classes in ABA-AMB, ABD, …); "unlabeled AND foreign" still mismatches
because BioPortal roots unlabeled-foreign classes where it *didn't* resolve the import.

- **Verdict.** Matching BioPortal exactly would require downloading each import closure (heavy,
  offline-fragile, snapshot-ballooning). Rejected in favor of issue #1's cleaner-tree approach.

### 7. Genuine own-content root gaps  — EXTERNAL (only 2 across the corpus)

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

### 8. Un-gatable ontologies: BioPortal roots 404/500  — BP-ARTIFACT

23 ingested ontologies could not be gated because BioPortal's own `/classes/roots` returned 404 or
500 for them (e.g. ADALAB-META, BFLC, BIBFRAME, BMT, CST). BioPortal-side gaps.

### 9. Label disagreements below the 98% bar  — OPEN (minor)

16 ontologies are root-set-equal to BioPortal but labels agree < 98% (e.g. AIDENTIFYAGE 75%, HECON
75%, NLN 80%). Cause is language / label-form differences (which of several labels is "the" label).
Not structural; revisit if it blocks specific ontologies.

### 10. Search gate not feasible corpus-wide  — OPEN

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
  instances, which additionally give real submission history. These map onto roadmap item 9.
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
