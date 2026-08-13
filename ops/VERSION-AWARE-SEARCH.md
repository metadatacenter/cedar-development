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
    { "sourceAcronym": "DOID", "version": { "id": "63ef56df1a…" } },
    { "sourceAcronym": "NCIT" }
  ],
  "lang": "fr",
  "page": 1,
  "pageSize": 20
}
```

`sources` does two jobs at once, which is why it is one list rather than a scope and a pin. It
narrows the search to the named sources, and it says which version each is searched at. Omit it
and the whole served corpus is searched at latest. Omit `version` on an entry, or write
`"version": "latest"`, and that source is searched at latest — the same spelling the constraint
spec uses for an unpinned entry.

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

The envelope describes sources; hits describe matches and name their source with
`sourceAcronym`. Whether a term can be pinned is a property of its ontology within a request —
every SNOMEDCT hit is unpinnable for one reason — so saying it on each hit would state one fact
a hundred times and let the copies disagree.

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
  "sourceAcronym": "DOID",
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

## Hits

One shape per constraint type. In each, the keys the constraint spec defines for that type come
first; everything after them is evidence, which a client uses to choose and drops when it writes
the constraint. `sourceSystem`, `sourceName`, `sourceIri` and `version` are not repeated on hits
— they are joined from the source block.

### `class` — a specific term

```json
{
  "type": "class",
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
  "sourceAcronym": "DOID",
  "termCount": 14203,

  "matchType": "sourceName"
}
```

Thin, because everything else about an ontology is already in its source block. `matchType` is
`sourceAcronym` or `sourceName`: the ontology results are name matching over the served
catalogue rather than a facet over the class results, so this tab is empty for a query like
"melanoma", where no vocabulary is named that.

### `valueSet` — a curated list

```json
{
  "type": "valueSet",
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

**The join key.** Hits name their source by `sourceAcronym`, which the server guarantees unique
within a response. Acronyms are not globally unique — the whole reason `sourceIri` is the
canonical identity — so a request that could span two portals serving the same acronym needs an
explicit key. Not a problem to solve before it exists, and worth knowing it is there.

**Ordering.** The results are only as good as the order they arrive in, and today's ordering
leaves the head of the list arbitrary. That work lands here rather than in `/bioportal/search`,
which is what makes it safe to do — see the term-ordering item in
[VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md).
