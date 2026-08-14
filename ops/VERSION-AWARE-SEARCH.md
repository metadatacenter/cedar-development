# Version-Aware Search — API Design

`POST /search` on the terminology server: search the vocabulary corpus at a named version or
the current one, across the kinds a controlled-term field can be constrained to, in one call.

It exists because `/bioportal/search` takes no version. An author who pins a constraint to an
older ontology and then searches is searching the current one, and can select a term the pinned
version does not contain — which manufactures the irreproducibility the versioning work removes.
`integrated-search` is version-aware and answers the other half of the question: given a
constraint, what may fill it. This answers the authoring half.

Why it is being built, what it replaces and how it is sequenced are in
[TERM-PICKER-ROADMAP.md](./TERM-PICKER-ROADMAP.md). Work is on the `version-aware-search` branch
of `cedar-terminology-server`.

## Naming

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

## The Request

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

## The Response

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

## Sources Are Described Once

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

## Searching Everything

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

## Hits

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
  "descendantCount": 42
}
```

`matchType` is `termLabel` or `synonym`, and `matchedLabels` carries what actually matched, in
the language it matched. Together they are what stops a synonym hit reading as a defect: a row
labelled *melanoma* found by a French search needs to say so. Today's `/bioportal/search`
supplies `matchType` and `matchedSynonyms` but no language, and ignores `lang` on its output
entirely — measured 2026-08-13, where GEMET returns identical labels with and without it.

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
  "matchedLabels": [{ "label": "melanoma", "language": "en" }],
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

## What Is Not Here, on Purpose

Collapsing identical labels across vocabularies, the match-reason chip, ordering the ontology
results, and everything about how a version is stepped through belong to a client. An endpoint
shaped around one UI is a liability the first time a second consumer wants it, and the picker is
one consumer of a general capability.

## Open

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
