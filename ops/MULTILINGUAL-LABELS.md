# Multilingual Labels in the Terminology Store

A concept in a source ontology can be named in several languages, and with several synonyms. The
terminology store historically kept only one name per concept — the single label it serves — and
discarded the rest at ingest. For a multilingual ontology that threw away real content: a French or
Japanese label, an exact synonym, a hidden search term. This records how BioPortal handles language,
what the store now captures, and how the existing snapshots were backfilled.

## How BioPortal Serves Language

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

## What the Store Captures

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

## Backfilling the Existing Snapshots

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

## Coverage

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

## Serving the Languages

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
