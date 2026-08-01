# Ingesting Ontologies from Other Repositories

An investigation into ingesting ontologies from repositories beyond BioPortal and OBO Foundry, with a
new ingestion primitive and real, verified ingests across formats, serializations, versions, and
authorities. Everything below was run against live sources on 2026-08-01; the terminology server's
content-hash identity makes the *source* of an ontology irrelevant to its identity, and that is what the
results confirm on real data.

## What was added

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

## What was proven (real ingests)

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

### Content-hash identity is source-, serialization-, and host-independent

The headline result. The *same ontology content* produces the *same* `version_id` no matter where or how
it was fetched:

- **BFO across three authorities and two serializations → one hash (`5ddbbc94…`):** OBO PURL `bfo.owl`
  (RDF/XML), OBO PURL `bfo.obo` (OBO), and AgroPortal's REST download all extracted to the identical
  35-class model and merged to a single snapshot.
- **UNESCO thesaurus, two serializations → one hash (`14d6cd54…`):** the 4,595-concept SKOS thesaurus
  from `unesco-thesaurus.ttl` and from `unesco-thesaurus.rdf` produced the same `version_id`.

### Versions merge and diff correctly on real releases

Three dated PATO `.obo` releases were ingested as one ontology:

- 2022-12-15 and 2023-05-18 → the *same* `version_id` (`3ef9a582…`): byte-different files, identical
  extracted content, merged to one snapshot.
- 2024-03-28 → a *different* `version_id` (`d4aa8644…`).
- The `SnapshotDiff` of 2022 → 2024 reported `~3 changed concepts` and `+2 added edges` (with the
  `-[rdfs:subClassOf]->` predicate) — exercising the content-complete diff (changed concepts + edge
  predicates) on real version drift. A label-only change like this is exactly what an IRI/edge-only diff
  would have missed.

## The repository landscape

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

## Recommendations / next steps

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
