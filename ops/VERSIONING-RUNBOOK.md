# Terminology Versioning — Runbook

Running the versioned terminology work: the local store, the terminology server that serves it, and
`cedar-term-picker`, the Web Component an author picks a versioned constraint with. Open work and
the decisions behind it are in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md); what the model is and why, and the
shapes of the endpoints the picker reads, are sections of that same roadmap —
[The Model](./VERSIONING-ROADMAP.md#the-model) and
[The Search API](./VERSIONING-ROADMAP.md#the-search-api).

Sibling runbooks:
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the CEDAR stack the terminology server sits
  in, and the port map.
- [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) — the CEDAR Embeddable Editor, the other Angular Web Component
  in the estate and the setup the picker follows.

---

## The Store

`$CEDAR_HOME/cedar-term/prod`, about 44 GB. Three things live there:

- `catalog.sqlite` — every ontology the store knows, every snapshot of each, and the `latest` tag.
- `search-index.sqlite` — the cross-snapshot full-text index, one current version an ontology,
  rebuilt from the catalog rather than authored.
- `snapshots/<ACRONYM>/<version-id>.sqlite` — one file a release, holding its concepts, labels,
  edges and closure.

The index file carries three SQL indexes, `term_by_acronym`, `term_by_iri` and `name_by_term`, and
`SearchIndexJob` creates all three. A file built before `term_by_iri` existed does not have it, and
nothing reports the absence. A corpus-wide search fetches the names of a page of hits by IRI alone,
because hits drawn from the whole corpus carry no acronym to narrow by, and without `term_by_iri`
that lookup scans all 15.3 million terms. It runs twice a request, once for classes and once for
branches. Measured 2026-08-25, adding the index took a corpus-wide search for "disease" from 32
seconds to 1.8 seconds. Confirm a store has it, and add it to one that predates it with the
terminology server stopped. Building it takes a few seconds and about 0.8 GB.

```bash
sqlite3 $CEDAR_HOME/cedar-term/prod/search-index.sqlite \
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='term';"
sqlite3 $CEDAR_HOME/cedar-term/prod/search-index.sqlite \
  "CREATE INDEX IF NOT EXISTS term_by_iri ON term(iri);"
```

A snapshot's identity is a content hash over its own concepts, labels and edges, so correcting a
snapshot in place changes the release's identity rather than repairing it. Re-ingesting is the
repair, and it mints a new version id. **The file name is not the identity** — 1,061 of the 2,460
snapshots are named something other than their `version_id`, written under an older rule, and the
catalog's `file_path` is what resolves a snapshot.

```bash
sqlite3 $CEDAR_HOME/cedar-term/prod/catalog.sqlite \
  "SELECT n AS releases, COUNT(*) AS ontologies
     FROM (SELECT acronym, COUNT(*) n FROM snapshot GROUP BY acronym)
    GROUP BY n ORDER BY n;"
```

## Ingesting

`IngestJob` takes one ontology from BioPortal, an OBO PURL or a URL; `SearchIndexJob` rebuilds the
index from what the catalog holds. Both need a runtime classpath, kept beside the store rather than
in `/tmp`, which is swept:

```bash
cd $CEDAR_HOME/cedar-terminology-server
mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests
mvn -pl cedar-terminology-server-ingest dependency:build-classpath \
    -Dmdep.outputFile=$CEDAR_HOME/cedar-term/prod/ingest-cp.txt -DincludeScope=runtime
```

A missing classpath file leaves only the classes directory, and every ingest then dies on
`NoClassDefFoundError` in under a second — which reads as a thousand failures rather than as one
missing file. The drivers below refuse to start without it.

```bash
CP="$CEDAR_HOME/cedar-terminology-server/cedar-terminology-server-ingest/target/classes:$(cat $CEDAR_HOME/cedar-term/prod/ingest-cp.txt)"
BIOPORTAL_API_KEY=$CEDAR_BIOPORTAL_API_KEY java -Xmx10g -cp "$CP" \
    org.metadatacenter.terms.ingest.IngestJob \
    $CEDAR_HOME/cedar-term/prod/catalog.sqlite $CEDAR_HOME/cedar-term/prod/snapshots DOID
```

`--submission <id>` takes one named release rather than the current one, `--all` takes every release
a source offers, `--valuesets` files the acronym as a value-set collection, and `--source
obofoundry|url` draws from somewhere other than BioPortal. Ingest is idempotent on the content hash
and refuses to overwrite a good snapshot with an empty extraction, so a re-run costs a download.

Six drivers wrap it for bulk work, each writing a `results.tsv` and carrying on past a failure. Three
draw from BioPortal:

| script | what it does |
|---|---|
| `reingest-blank-label.sh` | re-ingests a plan of `acronym\|backend`, for repairing a defect |
| `backfill-releases.sh` | ingests named submission ids a line, for a short list worked out in advance |
| `backfill-tail.sh` | plans each ontology as it reaches it, for lists of hundreds |

and three draw from elsewhere:

| script | what it does |
|---|---|
| `harvest-ols-ingest.sh` | reads each EBI OLS ontology's `config.fileLocation` and ingests it |
| `harvest-obo-ingest.sh` | pulls each OBO Foundry ontology's current release from its canonical PURL |
| `harvest-github-releases.sh` | ingests an ontology's release history from GitHub, one snapshot a release |

The GitHub driver takes a plan naming, per ontology, the repository and a pattern for the asset to
take from each release:

```
MEDGEN	monarch-initiative/medgen	^medgen\.ttl\.gz$	OWL
EDAM	edamontology/edamontology	^EDAM_[0-9.]+\.owl$	OWL
```

The pattern is per-repository because release assets are named however a project names them, and a
project can rename them between releases: EDAM's older releases carry `EDAM_1.25.owl` and its newer
ones do not, so a pattern that matches both is worth checking with `--dry-run` before a long run.
`--max-releases` bounds how far back each ontology goes and `--since` cuts off by date; without both,
a weekly-releasing repository plans hundreds of downloads. `GITHUB_TOKEN` raises the API rate limit
from 60 requests an hour to 5,000, though one request per ontology means the anonymous limit covers
any plan a night can ingest.

`backfill-tail.sh` asks BioPortal what an ontology has at the moment it gets there and skips
submissions the catalog already records. Over a thousand ontologies that matters twice: a planning
pass would be a thousand API calls before the first ingest, and roughly a quarter of the tail has
one submission or none, which is only discoverable by asking.

Back the catalog up first — `cp catalog.sqlite catalog.sqlite.bak-<what>-<date>` — and rebuild the
index for whatever was touched when the run ends. The index is derived, so rebuilding a slice of it
is safe:

```bash
java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
    $CEDAR_HOME/cedar-term/prod/catalog.sqlite $CEDAR_HOME/cedar-term/prod/search-index.sqlite \
    --acronyms DOID,NCIT --force
```

Measured: ~300–530 classes a second, and 500–1,100 bytes on disk a class. A full index rebuild of
1,215 ontologies takes about four minutes; a slice of 989 took 83 seconds.

## Serving the Store

The terminology server reads the store when the profile names it, and reports itself unavailable
rather than answering from BioPortal when it does not:

```bash
export CEDAR_TERMINOLOGY_STORE_CATALOG="${CEDAR_HOME}/cedar-term/prod/catalog.sqlite"
export CEDAR_TERMINOLOGY_STORE_INDEX="${CEDAR_HOME}/cedar-term/prod/search-index.sqlite"
```

Both are in `cedar-profile-native-develop.sh`, and `cedar-services.sh` passes them to the
terminology service alone. The catalog and the index are separate variables because they are
separate files: a catalog can be served without an index, and `POST /search` and
`GET /search/hierarchy` then report themselves unavailable while `/bioportal/*` carries on.

Confirm from the startup log rather than from the port answering:

```bash
grep -E "terminology store enabled|Cross-snapshot search index" $CEDAR_HOME/log/cedar-terminology-server.log | tail -2
```

`localOnly=false` means an ontology outside the allowlist still proxies to BioPortal. The
UMLS-licensed sources — SNOMEDCT, MEDDRA, RCD, ICPC2P — cannot be held locally and can never be
pinned.

## What a Lookup Costs

`cedar_term_bench.py` times the lookup paths against whatever the server is serving, drawing its
query strings from the index so that every lookup matches something. Run it against a warm server
and against nothing else: a benchmark and the e2e smoke sharing one deployment turned a 30-second
smoke into a 78-second one, which reads as a regression until you notice what else was running.

```bash
python3 $CEDAR_HOME/cedar-development/ops/cedar_term_bench.py 30
```

An ontology-constrained `integrated-search`, the shape the authoring UI asks for, costs what the
ontology is large enough to make it cost. Measured 2026-08-25 on the 1,266-ontology store:

| ontology | terms | p50 |
|---|---|---|
| UO | 574 | 3 ms |
| DOID | 19,578 | 10 ms |
| MONDO | 36,070 | 24 ms |
| NCIT | 206,860 | 61 ms |
| NCBITAXON | 2,854,537 | 824 ms |

The relationship is close enough to linear above about twenty thousand terms to suggest a scan
rather than a seek, which puts NCBITAXON alone outside an interactive budget. Page size does not
enter into it: 10 results and 100 cost the same, because the work is in matching and ranking rather
than in building the answer. A shorter prefix costs more than a longer one, for the obvious reason.

A lookup is answered on the calling thread's own connection to each store it reads. That is worth
knowing when changing one: a store opened to write keeps the single connection its transactions
belong to, and only the three places that open a store to serve ask for the other mode. Sharing one
connection is what the server used to do, and it answered one lookup at a time however many arrived
— 16 requests a second whether one was in flight or sixteen, with latency climbing to 995 ms.
Throughput now rises with concurrency to about 98 requests a second and latency holds near 70 ms.

## When a Lookup Is Slow

Reach for the query before the server. `POST /search` puts each token of a query to the index as a
prefix match, and a token of one or two characters matches most of the index: `"d"*` reaches seven
million names where `"mannitol"*` reaches 2,398. Punctuation makes such tokens without anyone typing
them, because the index splits on it. Chemical and strain names are built out of exactly those
fragments.

A query with a long token in it holds its short tokens back and applies them afterwards, so
`D-mannitol` costs about what `mannitol` costs. A query with nothing long in it cannot: every token
of `L-alpha-amino acid`, `1,2,5` and `ce` is short, one of them is broad, and the query pays for it.
Those are the queries left to answer.

Choosing the tokens by how selective they actually are, rather than by assuming a long one is
narrow, is the obvious next idea and was measured on 2026-08-25 as worse. FTS5 keeps the counts and
an `fts5vocab` table reaches them cheaply, but doclist size turns out to predict what a query costs
poorly: what a match costs depends on how its doclists overlap, and holding back a broad token that
was usefully narrowing the intersection costs more than the token was costing. Over 300 labels drawn
from six ontologies, every threshold tried matched the shipped rule's speedup at best while making
29 to 39 of the queries more than half as slow again, where the shipped rule makes none of them
slower. The setting that finally answered `L-alpha-amino acid` was the worst of them overall. The
remaining queries need a different idea rather than a better threshold.

Confirm which case you are in before reading any code, since the two look identical from outside:

```bash
sqlite3 $CEDAR_HOME/cedar-term/prod/search-index.sqlite \
  "SELECT COUNT(*) FROM name_fts WHERE name_fts MATCH '\"ce\"*';"
```

A count in the millions is the query, not the server.

## Running the Picker

`$CEDAR_HOME/cedar-term-picker`, default branch `develop`. Node 24.19.0, the version `.nvmrc` pins.

```bash
npm --prefix $CEDAR_HOME/cedar-term-picker install
npm --prefix $CEDAR_HOME/cedar-term-picker start
```

That serves the development host on port 4500 — `src/index.html`, a page standing in for the
Template Designer, which sets the element's `query` attribute and listens for its `cancelled` event.
Nothing on that page ships. `proxy.conf.json` sends `/search` to the terminology server on 9004,
which keeps the call same-origin and CORS out of the picture.

**The proxy target is read once, at startup.** Changing it, or restarting the server it points at on
a different port, needs the dev server restarted too — otherwise every search returns 502 with
nothing wrong in the code.

## What the Picker Reads

`POST /search` answers all four constraint types at once, at a named version or the current one, and
describes every source it searched. `GET /search/hierarchy` answers where one term sits, at a named
release or the current one. Both are designed in
[The Search API](./VERSIONING-ROADMAP.md#the-search-api).

```bash
curl -s -X POST http://localhost:9004/search -H 'Content-Type: application/json' \
  -d '{"query":"melanoma","pageSize":25}' | python3 -m json.tool | head -40
```

Naming no source searches the whole corpus through the index; naming one searches its snapshot, can
pin a version, and gets each hit's whole ancestry rather than the one step the index holds.
`includeVersions` asks a source block for the releases it can be pinned to, which is what the row's
release list shows — fetched when a row first opens it rather than with every search, since a
corpus-wide query touches a hundred sources and an author opens one.

Both endpoints are unauthenticated, like `integrated-search`. That is deliberate, and it is also the
one thing the server is inconsistent about: `/bioportal/ontologies` and
`/ontologies/{acronym}/versions` refuse without an API key, which is why the picker takes version
histories through the search response rather than calling the versions endpoint.

## Building and Testing the Picker

| Command | What it does |
|---|---|
| `npm run build:production` | the custom-element bundle, into `dist/cedar-term-picker` |
| `npm test` | unit tests, through the Angular CLI's Vitest builder |
| `npm run lint` | ESLint over TypeScript and templates, Prettier included |
| `npm run typecheck` | `tsc` over every file under `src/`, including ones no build or test reaches |
| `npm run test:ci` | the gate: lint, typecheck, unit tests, the production build, then the browser tests against it |
| `npm run test:browser` | builds, then drives the bundle in Chromium with the terminology server stubbed |
| `npm run audit:prod` | advisories against what actually ships |

The browser tests live in their own workspace, `browser/`, with their own Playwright config and a
twenty-line static server — they drive `dist/` rather than `ng serve`, because a build that breaks
the bundle while leaving the dev server working is the failure they exist to catch. Every
terminology response is a fixture, so they need no server and no catalog. A stub answers only the
page it was asked for: the list appends what comes back and keeps asking until a page arrives short,
so a stub returning its one fixture for every page would have the list append that fixture to
itself.

`.github/workflows/test.yml` runs the gate on push and pull request, on the Node version `.nvmrc`
pins, with the audit as a separate step so a disclosure does not fail somebody's unrelated pull
request with an error they cannot fix there.

Three details of the setup are worth knowing before they surprise you.

**The build is zoneless.** Angular 22 generates a project without `zone.js`, and this one keeps it
that way. Change detection runs on signals, so a view updates on a microtask after the signal is set
rather than synchronously: a test or a console probe that reads the DOM in the same tick as the
change sees the old value. `await fixture.whenStable()` is the fix in a spec.

**`ng test` is the Angular CLI's own Vitest builder**, not a hand-written `vitest.config`. CEE
predates it and carries its own; nothing here needs to.

**The production bundle is unhashed**, because a host page loads it by name. It is about 310 kB raw
and 172 kB transferred, of which some 184 kB is the three embedded Roboto weights. That part is
fixed and does not compress — base64 of an already-compressed woff2 — so the transfer figure is
close to the raw one and stays that way.

The budgets are set around that: `initial` warns at 400 kB and fails at 550 kB, leaving roughly 90 kB
of growth before anyone is told. `anyComponentStyle` had to go to 190/200 kB, because the font
registrar's stylesheet *is* those 184 kB, and Angular's budgets cannot exempt one file. The
consequence is worth knowing rather than discovering: that budget no longer says anything useful
about an ordinary component stylesheet, since another one would have to reach 190 kB to trip it.

## Fonts, and Why There Is a Component That Renders Nothing

Browsers do not register `@font-face` from inside a shadow root, so the picker cannot simply put the
faces in its own encapsulated stylesheet. `FontRegistrar` is the answer CEE also arrived at: a
component with `ViewEncapsulation.None` and an empty template, whose stylesheet holds the font faces
and no selectors at all. Angular sends an unencapsulated component's styles to the document head,
which is what registers the fonts; it also copies them into the shadow root, so the base64 exists
twice in the DOM at runtime. That is a memory cost rather than a transfer one.

The selectors matter: an unencapsulated stylesheet reaches the host page, so anything beyond a
`@font-face` in that file would leak out of the component.

Verified in a browser rather than assumed — `document.fonts` carries `CEE Roboto` at 400 and 500 and
`document.fonts.check('14px "CEE Roboto"')` returns true.

A global stylesheet in `angular.json` would be the ordinary way to reach the document, and it does
not work here: the CLI emits it as a separate `styles.css` that a host page never loads.
`"styles": []` is deliberate, in this repository and in CEE.

## Class Names Are a Shared Namespace

The picker renders into one shadow root, so a class name means one thing across the whole component.
Three defects have come from forgetting that, each looking like a layout bug: `empty` on a spacer
picked up the empty-state paragraph's padding and stood every ontology row at 41px; `label` on a
tree node picked up the search caption's `text-transform: uppercase`; and the tree's own rules,
nested inside the detail panel's block, left a second tree elsewhere with no styling at all. Check
what a name already means before reusing it.

## Releasing the Picker

Nothing has been released. The repository will publish itself to npm rather than moving with the
platform release run, and `cedar-cli` has no entry for it — `skip_from_release` filters repositories
that are already registered, so one the CLI does not know is excluded already. This section gets its
commands when the first release is cut.
