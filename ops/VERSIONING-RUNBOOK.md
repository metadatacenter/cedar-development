# Terminology Versioning — Runbook

Running the versioned terminology work: the local store, the terminology server that serves it, and
`cedar-embeddable-term-picker`, the Web Component an author picks a versioned constraint with. Open work and
the decisions behind it are in [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md); what the model is and why, and the
shapes of the endpoints the picker reads, are sections of that same roadmap —
[The Model](./VERSIONING-ROADMAP.md#the-model) and
[The Search API](./VERSIONING-ROADMAP.md#the-search-api).

Sibling runbooks:
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the CEDAR stack the terminology server sits
  in, and the port map.
- [FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee) — the CEDAR Embeddable Editor, the other Angular Web Component
  in the estate and the setup the picker follows.

---

## Exact identifier membership verification

`POST /bioportal/validate-term` accepts `{ "iri": "…", "valueConstraints": { … } }` using the
field's complete `_valueConstraints`, including source identity, release pins, ontology/class/branch/
value-set constraints and actions. Do not submit a label query or a reduced list of acronyms. The
HTTP 200 response carries `status`, `code`, `message` and the unchanged `iri`; malformed requests
return 400. Verification status is `passed`, `failed`, `notChecked` or `unavailable`.

The verifier checks exact identifiers against the declared source/release and hierarchy depth. It
applies the same delete/move membership effects as integrated search. A pinned release never falls
back to the current remote release. All declared sources must be checkable for a positive verified
result; partial coverage remains unavailable. With no membership constraint, existence has not been
checked. Bounded remote hierarchy traversal also reports unavailable when it cannot finish. These
facts are independent of save policy: failed instance membership is quality, while a known failed
template default cannot be saved.

Remote replies must establish both the exact identifier and requested ontology identity. Provisional
fallback cannot substitute a term from another ontology. A regular lookup outage followed by a
provisional 404 remains unavailable; only a wholly definitive absence can fail membership. Malformed
class or hierarchy responses are unavailable evidence, not empty result sets.

Candidate search is not verification evidence. The local SQLite search path currently returns the
whole subtree even when a finite `maxDepth` is requested; its candidates can therefore include a
term that exact membership correctly rejects. The verifier enforces the declared depth independently.
Use a genuinely permitted term when a journey expects all quality findings to clear.

## The Store

The store is `$CEDAR_HOME/cedar-term/prod`. Three parts of it answer requests:

- `catalog.sqlite` — every ontology the store knows, every snapshot of each, and the `latest` tag.
- `search-index.sqlite` — the cross-snapshot full-text index, one current version an ontology,
  rebuilt from the catalog rather than authored.
- `snapshots/<ACRONYM>/<version-id>.sqlite` — one file a release, holding its concepts, labels,
  edges and closure.

The ingest also keeps what it downloads. Each ontology's `snapshots/<ACRONYM>/raw/` holds every
source file under its content hash, as `<hash>.gz` when the ingest compressed it or `<hash>.raw`
when the source served it already compressed. These originals are the only copy of a release that
BioPortal may since have withdrawn, and re-extracting a release, as the property backfill does,
reads them. Beside each original the ingest writes an uncompressed working copy for the parser,
`<hash>.gz.expanded` or `<hash>.raw.expanded`, occasionally with a further `.noimports` variant.
Nothing reads a working copy once its ingest has finished, and the next ingest of that release
writes it again, so working copies can be deleted.

Measured on 2026-10-07, the store held 1,266 ontologies and 5,400 catalogued snapshots in 133 GB, of
which about 59 GB answers requests:

| Part | Size | Answers requests |
|---|---|---|
| Catalogued snapshots | 47.4 GB | yes |
| Search index | 11 GB | yes |
| Catalog | 4 MB | yes |
| Working copies | 62.6 GB | no |
| Original downloads | 4.5 GB | no |
| Snapshot files the catalog does not record | 2.7 GB | no |

A snapshot file the catalog does not record cannot be served. Those on disk in October 2026 were
left by runs in August.

Delete the working copies while no ingest is running. The command removes a working copy only when
its original is beside it:

```bash
find $CEDAR_HOME/cedar-term/prod/snapshots -path '*/raw/*' -type f -name '*.expanded*' \
  -exec sh -c 'for f; do [ -e "${f%%.expanded*}" ] && rm -- "$f"; done' sh {} +
```

Keep the catalog, the catalogued snapshots and the originals in a backup off the workstation. The
index is derived and rebuilds in minutes, so a backup can leave it out.

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

Each indexed term records one parent: the one its release's own path runs through, which is the
first of its direct parents by IRI, leaving out a genus edge another parent implies. A search row
names the chain that parent starts, and the tree the row opens draws the same chain. An index built
before 2026-10-23 recorded whichever parent a scan of the snapshot reached first, which follows
internal row ids, so some of its rows name a chain their tree does not draw. In the workstation's
index, 225,153 of 15,333,667 terms in 250 ontologies carried such a parent, 346 of them in DOID and
3,823 in UBERON. A full rebuild took eleven minutes on 2026-10-23. Rebuild an older index whole,
with a classpath built for the current version (see [Ingesting](#ingesting)), and copy it to any
host that serves it:

```bash
java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
    $CEDAR_HOME/cedar-term/prod/catalog.sqlite $CEDAR_HOME/cedar-term/prod/search-index.sqlite --force
```

A snapshot's identity is a content hash over its own concepts, labels and edges, so correcting a
snapshot in place changes the release's identity rather than repairing it. Re-ingesting is the
repair, and it mints a new version id. **The file name is not the identity** — 219 of the 5,400
catalogued snapshots are named something other than their `version_id`, written under an older
rule, and the catalog's `file_path` is what resolves a snapshot.

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

### Resource descriptions and public links

The four CEDAR controlled-term constraint kinds (ontology, branch, class and value set) accept the
same optional `links` object in core JSON and YAML. Instances continue to record only the selected
identifier and label. Selecting two sets writes two constraints, each with its own links.

```yaml
links:
  landingPage: https://comptox.epa.gov/dashboard/chemical/details/DTXSID8031865
  icon: https://registry.example/assets/source.svg
```

`landingPage` is the human-facing page for that particular constraint resource or selected term.
`icon` is an image URL, not a provider name or rendering token. Both are optional; omit `links` if
neither is known. The object is closed to these two keys and accepts only absolute HTTP(S) URLs
without credentials. There are no provider-specific members. The example icon above is illustrative;
the EPA adapter currently supplies landing pages without an icon. The normal fallback link icon
remains available. A failed image falls back to that link treatment.

Version remains in the existing top-level constraint `version` object; links carry no separate
version category. A public site may show its current record even when CEDAR uses a pinned snapshot.
The page does not assert which release the selected constraint uses. Canonical `sourceIri`, service
`sourceUri` (JSON `uri` for an ontology), and term identifiers retain their existing meanings and
spelling. A landing page is never substituted for any of them.

The canonical links schema is
`cedar-model-validation-library/schema/valueConstraintsLinksFieldContent.json`. All four constraint
items reference it. The Java validator validates stored artifacts; the Java artifact library reads,
writes and validates the links value. The TypeScript model uses a generated runtime validator from
the same schema, not merely a compile-time interface. Both libraries preserve links through JSON and
YAML. CETP validates incoming links using that TypeScript validator, and the designer preserves them
when converting the picker result to core constraints. Java integrated-search DTOs use the core
`ConstraintLinks` reader even when their surrounding mapper accepts legacy constraint fields.

`POST /resources/description` resolves one identity reference without expanding a constraint or
changing a selection. It still takes a reduced API reference: `type` (`class`, `branch`, `ontology`,
`valueSet`, or `property`), `sourceAcronym`, optional `sourceSystem` and canonical `sourceIri`,
`termIri` for a class/property or `termBaseIri` for a branch/value set, and optional `version`.
The pin uses the existing `id`, optional `effectiveDate`/`declaredVersion`, or `"latest"`.
Ontology references have no term field. This projection is validated by the endpoint's JSON Schema;
it is not the complete core artifact constraint. Consolidating that reference projection is tracked
in the roadmap.

The response contains `constraint` (the resolved reference) and optional `links`. Search hits,
source blocks and hierarchy entries carry `links` directly. Source blocks retain `authorityLabel`
for their existing repository display. Missing links are omitted, not serialized as `{}`. Missing
sources, resources or exact pins return 404; invalid references return 400. A missing pin is never
substituted with latest. Unpinned legacy BioPortal references outside the store retain their public
link convention; that link does not assert membership or remote availability.

The endpoint schema is
`cedar-terminology-server-core/src/main/resources/contracts/terminology-links.schema.json`.
Its links definition is checked against the core model fragment, and generated client types import
`ConstraintLinks` from the TypeScript model. Regenerate or check the API types from `$CEDAR_HOME`:

```bash
python3 cedar-terminology-server/tools/generate-terminology-types.py \
  cedar-embeddable-editor/src/app/modules/shared/models/generated/terminology-links.ts \
  cedar-embeddable-term-picker/src/app/search/generated/terminology-links.ts
# Add --check to verify both copies.
```

Adapters supply `SourcePresentation` during ingestion. This internal link-template configuration is
stored as `resource_presentation_v1` in snapshot metadata and excluded from the semantic content
hash: correcting a public URL must not mint a vocabulary release. BioPortal and EPA adapters supply
profiles; other sources can implement that hook or pass `--presentation <file.json>` to `IngestJob`.
This operator input is JSON; the artifact constraints themselves support both JSON and YAML.

```json
{
  "sourceSystem": "example-registry",
  "authorityLabel": "Example Registry",
  "links": {
    "class": {"landingPage":"https://registry.example/record?iri={termIri}","icon":"https://registry.example/icon.svg"}
  },
  "resourceLinks": {
    "urn:example:set:one": {"landingPage":"https://registry.example/lists/one"}
  }
}
```

The backend expands `{sourceAcronym}`, `{sourceIri}` (ontology pages), `{termIri}`, `{termBaseIri}`
and `{version.id}` as URL-encoded components. `{termIriRaw}` is available when an adapter declares
that the identifier is its public page. A version placeholder requires a resolved version. Only
absolute HTTP(S) URLs without credentials are emitted, with international paths encoded for transport.
Per-resource overrides replace type defaults; an empty override suppresses the inherited links.
Profiles contain public URLs, not API credentials. Stored profiles must use the current object shape;
the server does not translate old link arrays, icon tokens, resource-type aliases or placeholder names.
Update any older stored profile explicitly before deploying this reader. Only the profile metadata
may change: vocabulary tables, catalog versions and tags must remain intact. This metadata is excluded
from the content hash, so correcting its format does not require a new vocabulary version.
Older snapshots without profiles retain the BioPortal compatibility profile; unfamiliar ingested
providers do not inherit BioPortal conventions.
The existing BioPortal image is served publicly at `/resources/icons/bioportal.png`, and its absolute
URL is supplied by the backend like any other icon.

CEE consumes `links` in the existing source and selected-value link slots. Embedded links are used
when available; otherwise the resolver uses the template's source identity and exact pin. It keeps
stored labels visible, coalesces identical in-flight reads and bounds its memory cache. Batch reads
and cross-surface invalidation remain in the roadmap. Multiple selected sets keep separate links;
integrated search computes and deduplicates their union. A new provider using supported interactions
requires an adapter or configuration and ingestion. A new interaction requires an agreed shared
frontend enhancement.

### Targeted EPA PFAS value sets

`EPA-PFAS` is a native EPA collection, with `sourceSystem: "epa"` and canonical collection IRI
`https://metadatacenter.org/terminology/value-sets/epa-pfas`. It appears in the existing picker's
**Value sets** results. Choose either method list for an ordinary controlled-term field, or select
both lists on the same field to accept their union. Each selected list retains its own EPA SRS
link in the specification; no combined page or PFAS-specific authoring controls are needed.
Publishing the template freezes the sets to the current snapshot;
the populated instance keeps the chemical's CompTox IRI and label. The existing broad bridge-backed
PFAS field remains available.

The initial collection contains EPA Method 533, EPA Method 537.1, and their union. The live import
on 2026-10-27 contained 25, 18 and 29 distinct substances respectively. Membership comes from the
[EPA SRS method lists](https://cdxapps.epa.gov/oms-substance-registry-services/), not PFASSTRUCT or
the broader CompTox drinking-water list: the latter includes additional ammonium salts. The UCMR5
list also includes lithium, so it is not itself a PFAS-only set.

After building the ingester and its classpath above, source the normal native profile and run:

```bash
java -cp "$CP" org.metadatacenter.terms.ingest.IngestJob \
    "$CEDAR_HOME/cedar-term/prod/catalog.sqlite" \
    "$CEDAR_HOME/cedar-term/prod/snapshots" EPA-PFAS --source epa-pfas
java -Xmx10g -cp "$CP" org.metadatacenter.terms.ingest.SearchIndexJob \
    "$CEDAR_HOME/cedar-term/prod/catalog.sqlite" \
    "$CEDAR_HOME/cedar-term/prod/search-index.sqlite" --acronyms EPA-PFAS --force
cedarcli native restart microservice terminology
```

The source reads `CEDAR_COMP_TOX_API_KEY` from the profile. It sends that key only to CompTox;
SRS requests are unauthenticated. It checks list identity and count, resolves each current CAS
number to exactly one CompTox DTXSID, checks populated SRS cross-references, and fetches chemical
details and synonyms in batches. Missing synonym records are tolerated; incomplete membership,
missing details, ambiguous identities and conflicting cross-references fail the import before
publication. SRS method list IDs are 477 and 475; a changed or renamed list requires review.

Every chemical keeps its canonical CompTox page as its IRI, for example
[PFOA](https://comptox.epa.gov/dashboard/chemical/details/DTXSID8031865). The selected value links
there in CEE's read-only view and through the existing link-out button while editing. Search accepts
names, retained aliases, CAS numbers and DTXSIDs within the selected set. Deleted CompTox synonyms
and its lower-quality `other` group are excluded, as are inactive SRS names.

EPA's APIs provide current data, not a retrievable immutable release. Each import retains the exact
API response bodies and retrieval time in a key-free JSON archive under the usual raw content hash.
The normalized snapshot hash includes membership, labels and all searchable names; timestamps and
response ordering do not affect it. An unchanged re-import preserves the version ID, and changed
names or membership produce a new version while old pins remain resolvable. EPA snapshots opt into
name hashing without changing the identities of existing BioPortal snapshots. Refresh is manual;
an EPA retrieval date is not an EPA-issued release identifier. `EPA-PFAS` must be in both local
allowlists on a host serving these sets; the shared native configuration includes it.

### Bulk ingest drivers

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

Historical measurements recorded ~300–530 classes a second and 500–1,100 bytes on disk a class.
An earlier full index rebuild of 1,215 ontologies took about four minutes; a slice of 989 took
83 seconds. Those rebuild timings predate publication hardening; use the current benchmark below
when budgeting a full rebuild.

### Publication, interruption and cleanup

Snapshot publication and `--prune-orphans --apply` share a SQLite writer reservation on the catalog.
Ingestion and property enrichment build a private `.sqlite.tmp` file first, then atomically move it
into place and register it while holding that reservation. Cleanup acquires the reservation before
reading references or deleting files. A competing writer waits for its configured busy timeout or
receives `SQLITE_BUSY`; retry the operation after the current writer finishes. A failed registration
may leave an unreferenced complete file, which a later cleanup can remove. Dry-run cleanup remains
read-only. This coordinates the Java ingest, enrichment and cleanup paths; manual file deletion
bypasses the protocol.

Each ontology's classes, names/full-text postings, properties and version markers publish in
one search-index transaction. Full-text postings are deleted in a batch before the old content rows
are removed, then inserted in a batch after the new names exist. An interrupted update leaves the
previously committed version usable; a retry replaces it. An older snapshot without property
extraction clears the prior release's property results instead of serving them under the new release.

The server opens every snapshot and the search index read-only. A job that writes one of them in
place, `SearchIndexJob` or a property backfill, and dies mid-write leaves a hot journal beside the
file, and a read-only connection cannot roll it back. Every lookup against that file then fails
with `SQLITE_READONLY_ROLLBACK`. Rerun the interrupted job: opening the file to write rolls the
journal back, and the run then finishes the write.
Catalog and index writes roll back on unchecked failures as well as SQL failures. Bulk loading
retains the 200 MB cache but uses rollback
journaling and full synchronization. The large-corpus benchmark below measures the cost of the
complete publication change and separately probes the durability settings.

Deploy the matching store and ingest libraries together, and finish or stop old ingest/index/cleanup
jobs before using the new protocol. Schema initialization removes the previous per-name full-text
triggers; the matching writer maintains postings in batches instead. Do not run an older index writer
after this migration. The command still finishes with its full-text rebuild for repair and legacy
schema migration. These changes prevent new inconsistencies; they do not restore snapshot files
already removed by an older cleanup or automatically reconcile an index left inconsistent by an
older interrupted job.

**Deterministic recovery coverage (2026-10-12).** `TerminologyPublicationTest`,
`SnapshotPruneConcurrencyTest` and `IndexRollbackMatrixTest` run in the ordinary Maven build.
The initial 16 probes produced nine assertion failures and seven passes, with no test errors. They
exposed unchecked-failure commits, separately committed class/property releases, stale legacy
property results, stale full-text postings and cleanup deleting a snapshot during registration.
A subsequent page-cache-spill probe exposed rollback loss with journaling disabled during incremental
full-text maintenance. The final 23 cases cover five SQL failure points with both regular and bulk
settings, retries, SQL/runtime/error rollback, legacy transitions, existing-index upgrade, a forced
ingest/cleanup interleaving, page-cache spill, and child-JVM termination during a write. They use
small temporary SQLite stores, no external ontology service and no additional embedded-server startup.
The full terminology reactor and upgrade check passed 557 tests; the new cases took about 3–4
seconds. After local redeployment, whole-stack smoke passed 1,471 REST checks and every browser tier
(digest `fe2ffebb4977e530`); all 22 local applications were healthy.

**Batched-publication coverage (2026-10-13).** `IndexPublicationMatrixTest` adds 12 cases crossing
regular/bulk settings, class-only/combined publication and current/trigger-based/pre-scope FTS
schemas. They verify replacement, retries, clearing and repopulation, shared IRIs across ontologies,
duplicate and multilingual names, empty labels, reopening, and FTS integrity before a global rebuild.
Two further child-JVM cases terminate after both posting batches but before version publication
commits. The focused recovery suites now contain 37 cases, and the full terminology reactor passes
571 tests. Journaling and synchronization settings are unchanged; performance probes remain outside
the normal build.

Local redeployment was healthy. The whole-stack check passed all 1,471 REST checks and the main
browser workflow, but the split Workspace tier failed an instance-content preservation assertion:
editing Notes cleared `schema:description` (`modern-workspace-smoke.mjs`, digest
`e41dc24facd29564`). That assertion was added in concurrent frontend work; the full smoke gate is
not green for this run. An earlier attempt (`af8ef9a9cff8a538`) encountered a Workspace 502 during
a frontend rebuild/restart.

Run the focused matrix from `cedar-terminology-server`, with Java 17 and the native profile loaded:

```bash
./mvnw -o -pl cedar-terminology-server-ingest -am test \
  -Dtest=TerminologyPublicationTest,SnapshotPruneConcurrencyTest,IndexRollbackMatrixTest,IndexPublicationMatrixTest \
  -Dsurefire.failIfNoSpecifiedTests=false
```

### Index rebuild performance

Measured on 2026-10-13 using 1,266 current ontology snapshots: 15,333,667 terms, 44,627,568 stored
names and 246,639 properties. The comparison compiled the store and indexing sources from
`56fcca7` (before publication hardening), `e764738` (per-name triggers), and the subsequent batched
writer against the same dependencies, including SQLite JDBC 3.53.4.0. All ran with Java 17,
a 10 GiB heap and the 200 MB SQLite cache on
the same 16-CPU, 64 GiB macOS workstation. Each wrote a fresh temporary index from a frozen copy
of the catalog and read the original immutable snapshots; the served catalog and index were untouched.

The harness calls the production `indexOntology` for every ontology in acronym order, then
`rebuildFullText` and `optimize`, matching the CLI's build stages. These are indexing times;
additional consistency checks are timed separately.

| Stage | Before hardening | Per-name triggers | Batched postings |
|---|---:|---:|---:|
| Read snapshots and publish each ontology | 284.623 s | 754.804 s | 375.512 s |
| Final full-text rebuild | 62.425 s | 111.005 s | 67.321 s |
| Optimization and planner statistics | 44.235 s | 68.925 s | 37.567 s |
| Total, including initialization | **392.621 s (6:33)** | **935.069 s (15:35)** | **481.395 s (8:01)** |

The initial publication hardening took **2.38 times as long**, an additional nine minutes. Its two
runs indexed every ontology without a skip or failure, passed SQLite `quick_check` and the FTS5
external-content integrity check, and produced the same row counts and 9,714,892,800-byte index size.
All 1,266 class-version markers, 1,264 property-version markers and match counts for eight representative
full-text queries agreed.

A control used DOID, NCIT and CHEBI: 464,398 terms and 1,495,211 stored names. Each configuration
ran twice, in forward then reverse order, on fresh indexes:

| Configuration | Indexing time, two runs |
|---|---:|
| Old code and old bulk settings | 12.370 s / 12.510 s |
| Old code with only `journal_mode=DELETE` and `synchronous=FULL` changed | 11.822 s / 12.466 s |
| Per-name triggers and durable settings | 28.961 s / 30.391 s |

On this subset, durability settings alone cost less than the observed run-to-run variation. The
large increase appeared with the per-name publication implementation, which maintained full-text
postings through a trigger for every stored name and still rebuilt them all at the end. This
points to per-name full-text maintenance as the main cost, including its
interaction with journaling; it is not a full-corpus isolation of every implementation change.
The batched writer keeps both FTS changes in the ontology transaction using `INSERT ... SELECT`.
In a fresh forward/reverse subset comparison, triggers took 29.121/29.758 seconds and batching took
15.895/16.257 seconds. On the full corpus, batching reduced total indexing time by **48.5%**, while
retaining `journal_mode=DELETE`, `synchronous=FULL`, combined class/property publication and the final
rebuild. These measurements do not test omitting that final stage, including any work that might
move into optimization. The batched full run also passed SQLite and FTS5 consistency checks and
produced the same row counts and index size; its class-version markers and the eight sampled full-text
match counts agreed with the baseline.

Replacement was measured separately on populated copies of the three-ontology subset. Two forced
passes took **86.794/88.490 seconds with triggers versus 15.556/15.213 seconds with batches**: about
82% less time. These timings cover ontology replacement alone, excluding the CLI's final global
rebuild and optimization. Each pass passed FTS5 external-content integrity checking **without** a
global rebuild, and both resulting indexes agreed on versions and sampled search counts.

These are manual performance probes, outside Maven's normal tests. Full-corpus timings use one
fresh build per implementation. The trigger/before-hardening comparison ran in that order; the
batched writer ran subsequently against the same frozen corpus. Idle sleep was prevented and each
run has continuous ten-second heartbeat records. Filesystem caches were not flushed and normal
desktop services remained active; use the numbers as workstation measurements, not a production-host
guarantee. The harness, frozen catalog, source revisions, logs and timing records are retained locally
under
`$CEDAR_HOME/.cedar/benchmarks/terminology-index-20261013/`.

## Serving the Store

Configure the catalog and index paths in this installation's `set-env-internal.sh`:

```bash
export CEDAR_TERMINOLOGY_STORE_CATALOG="${CEDAR_HOME}/cedar-term/prod/catalog.sqlite"
export CEDAR_TERMINOLOGY_STORE_INDEX="${CEDAR_HOME}/cedar-term/prod/search-index.sqlite"
```

The native controller passes them only to Terminology as `terminologyStore.*` JVM properties.
Docker supplies the same properties through `CEDAR_JAVA_OPTS` and mounts the store from the host;
use container-visible paths there. Restart/recreate the service after changes.

The local service requires a catalog and a nonempty `localOntologies` search allowlist. Without
either, or if opening the catalog fails, legacy lookups use BioPortal and local version-aware
endpoints are unavailable. Without a search index, the catalog still serves local legacy lookups,
but `POST /search` and `GET /search/hierarchy` cannot use the cross-snapshot index.

`localRootsOntologies` independently selects local tree browsing; blank means use the search
allowlist. Search-only ontologies browse through BioPortal, and browse-only entries are supported.
The profile variables are `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES`,
`CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES` and `CEDAR_TERMINOLOGY_LOCAL_ONLY`.

Confirm from the startup log rather than from the port answering:

```bash
grep -E "terminology store enabled|Cross-snapshot search index" $CEDAR_HOME/log/cedar-terminology-server.log | tail -2
```

`localOnly=false` permits BioPortal fallback when a routed local operation is unsupported;
`true` makes that operation fail instead, which the equivalence harness needs. Ontologies outside
the applicable local allowlist still route remotely. A green fallback-enabled suite therefore does
not prove local coverage. UMLS-licensed sources (SNOMEDCT, MEDDRA, RCD, ICPC2P) remain remote and
cannot be pinned in this store.

## Moving the Store to Another Host

A staging or production host that serves the picker needs only the parts of the store that answer
requests. Ingest can stay on the workstation that keeps the originals, and the serving host then
receives copies of the files it writes. Give every host the same copy. A version identifier is a
hash of its snapshot's content, so a pin recorded on one host resolves on every host that holds the
same snapshot. Hosts that ingest separately can hold different snapshots and tag different ones
`latest`.

On 2026-10-28 the serving set was 61 GB: 5,401 catalogued snapshots totalling 50.9 GB, a 9.7 GB
search index and a 4.5 MB catalog. The catalogued snapshots had grown by 3.5 GB since 2026-10-07.
Put the copy on a data volume with room to grow, not on a small system partition. On app-05, `/var`
is 4 GB. A later copy writes each changed file in full beside the old one before replacing it, so
updating the index takes a further 10 GB while it runs. Plan for at least 75 GB free.

On the workstation the store is `$CEDAR_HOME/cedar-term/prod`, where `prod` separates the served
store from the trial stores, logs and scripts kept beside it in `$CEDAR_HOME/cedar-term`. A serving
host keeps nothing else there, so it needs no such level. Use `$CEDAR_HOME/cedar-term` itself, which
is `/srv/cedar/cedar-term` on the staging and production hosts. `<store>` below names that
directory.

Copy only what the catalog records, while no ingest or index job runs, since both write the store.
The store uses SQLite's rollback journal, so an unfinished write leaves a file ending in
`.sqlite-journal` beside the database it writes, never a `-wal` file. Wait for a running job to
finish. An interrupted job leaves the same file behind, and rerunning the job is the repair, as
[Publication, interruption and cleanup](#publication-interruption-and-cleanup) describes. A
`.sqlite.tmp-journal` belongs to an ingest's private working file, which is never copied.

Confirm too that the index is current before copying it. An index built before 2026-08-25 lacks two
columns that the server adds on startup. A serving host opens the index read-only and cannot add
them, so corpus-wide search starts off there. A current index prints 2.

Then build the list of files to copy and a manifest of their checksums. Keep both beside the store,
because `/tmp` is swept. `shasum` reports any snapshot the catalog records and the workstation
lacks. On 2026-10-07 the catalog recorded two FBBI snapshots, one of them `latest`, that were not
on disk.

```bash
cd $CEDAR_HOME/cedar-term/prod
find . -name '*.sqlite-journal'
sqlite3 -readonly search-index.sqlite \
  "SELECT (SELECT count(*) FROM pragma_table_info('term') WHERE name = 'definition')
        + (SELECT count(*) FROM pragma_table_info('name') WHERE name = 'ont')"
sqlite3 -readonly catalog.sqlite "SELECT file_path FROM snapshot" > serving-snapshots.txt
{ cat serving-snapshots.txt; echo catalog.sqlite; echo search-index.sqlite; } |
  tr '\n' '\0' | xargs -0 shasum -a 256 > serving-manifest.sha256
```

The snapshot files go first and the catalog, index and manifest last, so the host's catalog never
records a file the host lacks. `--partial-dir` keeps a partly sent file apart from the file it will
replace. An interrupted copy then leaves the host's file intact, and a rerun does not send the
arrived part again. Plain `--partial` would leave the truncated file in place of a good one. The
originals and the working copies never go to the serving host.

```bash
rsync -a --partial-dir=.rsync-partial --files-from=serving-snapshots.txt . <host>:<store>/
rsync -a --partial-dir=.rsync-partial catalog.sqlite search-index.sqlite serving-manifest.sha256 <host>:<store>/
```

Before serving from the copy, check it against the manifest on the host. The check prints nothing
when every file matches the workstation's, and names each file that is missing or differs.

```bash
cd <store>
sha256sum --quiet -c serving-manifest.sha256
```

Name the store in the host's `set-env-internal.sh` only once that check passes. The server does not
check that the catalog exists. A path into a directory that holds no catalog makes SQLite create an
empty one, and the server then reports the store enabled while serving nothing from it.

```bash
export CEDAR_TERMINOLOGY_STORE_CATALOG="${CEDAR_HOME}/cedar-term/catalog.sqlite"
export CEDAR_TERMINOLOGY_STORE_INDEX="${CEDAR_HOME}/cedar-term/search-index.sqlite"
```

The host's file sets only these paths. `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES` and
`CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES`, which select the ontologies the store answers for, are
declared once for every environment in
[`bin/util/set-env-generic.sh`](../bin/util/set-env-generic.sh). The profile sources that file after
`set-env-internal.sh`, so a list set on the host would be overwritten.

Re-source the environment, restart the terminology server, and confirm the store from the startup
log as [Serving the Store](#serving-the-store) shows. Then ask for a search. A host without a
catalog answers 503 with "Version-aware search needs the local terminology store, and no catalog is
configured."

```bash
curl -s -X POST http://localhost:9004/search -H 'Content-Type: application/json' \
  -d '{"query":"melanoma"}' | head -c 300
```

After a later ingest, repeat the whole procedure in the same order, manifest included, and restart
the terminology server. `rsync` replaces each file it updates, and a running server keeps reading
the files it opened until it restarts.

## What a Lookup Costs

`cedar_term_bench.py` times the lookup paths against whatever the server is serving, drawing its
query strings from the index so that every lookup matches something. Run it against a warm server
and against nothing else: a benchmark and the e2e smoke sharing one deployment turned a 30-second
smoke into a 78-second one, which reads as a regression until you notice what else was running.

```bash
python3 $CEDAR_HOME/cedar-development/ops/cedar_term_bench.py 30
```

An ontology-constrained `integrated-search`, the shape the authoring UI asks for, is answered from
one of two places, and which one decides what it costs.

A snapshot carries no text index. It answers by comparing every label it holds against the query, so
it costs what the ontology is large: 3 ms in UO's 574 terms, 10 in DOID's 19,578, 61 in NCIT's
206,860. Page size does not enter into it, since 10 results and 100 cost the same, and a shorter
prefix costs more than a longer one for the obvious reason.

The cross-snapshot index costs what the query matches instead, bounded by the ontology because the
ontology is indexed alongside the text. Past about a quarter of a million terms that is much the
cheaper, so an ontology above [the routing threshold](#which-store-answers) is answered from the
index. Measured 2026-08-26 through the same request, with a pinned version forcing the snapshot for
comparison:

| ontology | terms | from the index | from its snapshot |
|---|---|---|---|
| NCBITAXON | 2,854,537 | 103 ms | 905 ms |
| GAZ | 668,838 | 71 ms | 268 ms |
| MESH | 355,402 | 177 ms | 381 ms |
| LOINC | 297,723 | 108 ms | 252 ms |
| CCO | 264,891 | 73 ms | 132 ms |

Below the threshold the exchange reverses and the snapshot stays quicker. DOID answers in 9 ms from
its snapshot against 42 from the index, which is why this is a threshold rather than a switch.

A lookup is answered on the calling thread's own connection to each store it reads. That is worth
knowing when changing one: a store opened to write keeps the single connection its transactions
belong to, and only the three places that open a store to serve ask for the other mode. Sharing one
connection is what the server used to do, and it answered one lookup at a time however many arrived
— 16 requests a second whether one was in flight or sixteen, with latency climbing to 995 ms.
Throughput now rises with concurrency to about 98 requests a second and latency holds near 70 ms.

What a serving process holds open is bounded twice over, because a connection costs more than a file
handle — SQLite gives each one its own page cache. A snapshot untouched for a minute is closed once
more than sixty-four are open, the store just handed to a caller never among them; a minute because
a lookup reads its store after the resolution returns, and the slowest measured is about a second.
Reading connections are capped at 96 across every store rather than a store, since a per-store limit
multiplies by the number of snapshots cached. Past the cap a thread reads on its store's first
connection and waits, as it did before per-thread connections existed. Raise either where a
deployment wants more, with `-Dcedar.terminology.openSnapshots.max`,
`-Dcedar.terminology.openSnapshots.quietMillis` and `-Dcedar.terminology.readConnections.total`.

## Which Store Answers

An ontology uses the cross-snapshot index only when it is locally enabled, has at least 250,000
terms, has no explicit version constraint, and the index's release matches the catalog's current
release. Otherwise it uses its snapshot or, outside the local allowlist, BioPortal. A pinned release
always uses its snapshot; pin the current catalog version to compare both paths.

The index keeps one release per ontology. Version constraints and catalog/index agreement prevent
it from attributing terms to the wrong release after a re-ingest.

The paths differ in matching, ranking and totals:

| Behavior | Cross-snapshot index | Snapshot |
| --- | --- | --- |
| Matching | Whole-token prefixes | Substrings anywhere in a label |
| Ranking example: NCBITAXON `Escherichia` | Leads with `Escherichia` | Can lead with short labels matching only through synonyms, such as `Muvirus mu` |
| Large totals | Capped; MESH reported 10,000 | Exact; the same query reported 21,297 |

Measured comparisons returned 4,392 versus 4,509 PR hits and 6,101 versus 6,120 LOINC hits.
For GAZ `acid`, the index returned 2 versus 25: substring-only matches included `Lake Placid`,
`Almonacid de Toledo`, `Villacidro` and `Saint-Placide`. Both retained `Acid Factory Brook` and
`Municipality of Acidara`; `placid` still finds Lake Placid. These are examples, not proof of
identical result sets. Exact counting was slower than snapshot lookup in the DDSS experiment.

## When a Lookup Is Slow

Check the query, selected source and active store before tuning the server. `POST /search` uses
prefix matches. Short tokens can match millions of names: `"d"*` matched seven million, while
`"mannitol"*` matched 2,398. Punctuation can split chemical or strain names into broad tokens.
The query planner holds short tokens back when a longer token can narrow the search, so
`D-mannitol` costs about as much as `mannitol`; broad queries without a useful narrow token remain
expensive.

Corpus-wide label ranking groups all matching names before selecting the best 25 labels. A small
page therefore does not make a query matching 1.7 million names cheap. Selecting one source limits
the search to that ontology and commonly reduces latency to tens of milliseconds. The picker
requires at least three characters for an unscoped search; scoped searches permit shorter codes.

Check the match count:

```bash
sqlite3 $CEDAR_HOME/cedar-term/prod/search-index.sqlite \
  "SELECT COUNT(*) FROM name_fts WHERE name_fts MATCH '\"ce\"*';"
```

A count in the millions identifies a broad query; it does not by itself rule out server pressure.
For Docker memory checks, see [VM sizing](DOCKER-RUNBOOK.md#sizing-dockers-virtual-machine).

Retain these August 2026 experiments when evaluating another optimization:

| Experiment | Measurement and limitation |
| --- | --- |
| Select tokens by FTS5 vocabulary counts | Across 300 labels from six ontologies, tested thresholds matched the shipped rule at best and made 29–39 queries over 50% slower. Doclist size alone did not predict intersection cost. |
| Bound rows before grouping | The earlier slower verdict is invalid: one comparison used incorrectly bound parameters. Remeasure before drawing a conclusion. |
| Use FTS5 relevance ordering | 2–3 times faster, but led `disease` with `disease-disease association` and `acid` with `acidipropionibacterium`. |
| Fill from prefix labels first | `cell` fell from 5,609 to 148 ms and `acid` from 850 to 28 ms for the same 25 labels. Withdrawn on 2026-08-26 because switching to full ranking on later pages duplicated four `leukaemia` labels. |

The prefix experiment requires consistent ordering across pages. Computing the shortest-matching-name
tie-break over every match restores the work it tried to avoid. A prefix-first composite order
excluding earlier labels from later pages remains unverified. The first harness incorrectly bound
parameters and reported only 9/25 matching results where all 25 agreed; implausibly fast queries
must be checked for empty matches.

Historical typing measurements were 4,200 ms for `ce`, 2,512 ms for `cel` and 539 ms for `cellu`.
Longer queries reduce cost but do not eliminate corpus-wide ranking. Open optimization work belongs
in [VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md).

## Versioned Properties in Ontology Snapshots

Classes and properties belong to the same ontology release and the same snapshot SQLite file.
`ontology_property`, `property_literal` and `property_parent` hold object, datatype and annotation
properties, their literal annotations (including language-tagged labels and definitions), and every
asserted superproperty. Property hierarchy queries preserve multiple parents and terminate cycles.
Extraction reads the retained source itself; imports are not fetched from the network.
Turtle/NTriples inputs use two streaming passes to retain the property subgraph before OWLAPI
interprets it. This avoids loading all class annotations (MEDGEN expands to about 2.9 GB).
RDF/XML retains OWLAPI's native reader because the older Sesame RDF/XML reader trims literal
whitespace; OBO and OWL/XML also use their native parsers. Those formats can still need a large
heap. The corpus run uses `-Xmx24g` on a 64 GB workstation; smaller runs can use `-Xmx12g`.
OWLAPI's automatic illegal-punning repair is disabled, retaining asserted property kinds and
avoiding the expensive whole-signature repair encountered with DDSS.

A snapshot's content hash includes its property content once extraction has been performed. An
older snapshot without property extraction retains its original identifier and remains readable by
class pins. The offline backfill copies its existing class data, adds properties, writes a new
content-addressed snapshot, and registers it alongside the original. It moves `latest` only when
`latest` still points at the snapshot being enriched. `snapshot_property_enrichment` in the catalog
records the old-to-new relationship so reruns resume. This creates an enriched representation of a
retained release, not a newly downloaded release. No separate property database or property-version
namespace is used.

Build the terminology ingest module before running the commands below. The classpath must be
regenerated after a version change; an old `ingest-cp.txt` can name an older store library.

```bash
cd $CEDAR_HOME/cedar-terminology-server
mvn -pl cedar-terminology-server-ingest dependency:build-classpath \
    -Dmdep.outputFile=$CEDAR_HOME/cedar-term/prod/ingest-cp.txt -DincludeScope=runtime
CP="cedar-terminology-server-ingest/target/classes:cedar-terminology-server-store/target/classes:$(cat $CEDAR_HOME/cedar-term/prod/ingest-cp.txt)"
# Report retained archives whose bytes match the catalog hash; no database writes.
java -Xmx12g -cp "$CP" org.metadatacenter.terms.ingest.PropertyBackfillJob \
    $CEDAR_HOME/cedar-term/prod/catalog.sqlite OBI RO
# Apply to these sources. Omit the acronym arguments to process every catalog snapshot.
java -Xmx12g -cp "$CP" org.metadatacenter.terms.ingest.PropertyBackfillJob \
    $CEDAR_HOME/cedar-term/prod/catalog.sqlite --apply OBI RO
```

Back up the catalog before applying a corpus backfill. Preserve original snapshots: existing class
pins still name them. The report distinguishes missing archives, successful enrichments, already
processed versions and failures. A hash mismatch never substitutes the current BioPortal download.
The catalog may have merged source submissions with identical class content before property
extraction existed; the backfill can associate properties only with the retained source hash that
catalog entry actually records.

Rebuild the existing cross-snapshot index with `SearchIndexJob` after enrichment. Its property
search tables live in the same `search-index.sqlite` as the class index; they are derived data.
Future ingests extract properties before calculating the ontology version automatically.

The local-only API is unauthenticated, like version-aware class search:

- `POST /properties/search`: `query`, optional `sources: [{sourceAcronym, versionId}]`, optional
  `kinds` (`object`, `datatype`, `annotation`), and either `limit` and `offset` or `page` and
  `pageSize`. Unscoped search uses the index; a scoped request reads the requested ontology
  snapshot. Every hit reports the ontology version that answered, including when the corpus index is
  behind the catalog.
- `GET /properties?sourceAcronym=...&versionId=...&propertyIri=...&kind=...`: one property and its
  literal annotations and parent IRIs. `versionId` is the same ontology version used for classes;
  omitted means `latest`.
- `GET /properties/hierarchy` with those parameters and optional `limit` and `offset`: the selected
  property, its ancestor graph's nodes and a page of its direct children.
- `GET /properties/roots?sourceAcronym=...&versionId=...&kind=...` with optional `limit` and
  `offset`: a page of roots.
- `GET /properties/versions?sourceAcronym=...`: ontology releases with `propertiesAvailable`, so
  a pre-extraction version is distinguishable from one that contains zero properties.

By default a hierarchy or roots page holds 50 properties and a search page holds 20. No page holds
more than 200, the most the ontology store reads at once, and a request for more is refused with a
400 that names the range.

A missing release or property is 404; a release whose properties were not extracted, an unbuilt
corpus property index, or an unconfigured local store is 503. A snapshot that cannot be read is 500,
with a message and an `errorId` under which the database exception is logged. None of these paths
calls BioPortal.

## One-Time Catalog Conversions

Two jobs in the ingest module bring a catalog built under older identity rules up to the current
ones. Ingest has applied both rules itself since they were introduced, so a catalog built since then
needs neither job. Both read only what is on disk and download nothing, and both run with the
classpath built above.

`ContentHashCutover` moves each snapshot's identifier from the hash of its downloaded file to the hash
of its normalized content, the identity ingest has used since 2026-07-30. Two uploads whose bytes
differ but whose content is the same, such as a same-day re-upload, then share one identifier, so the
job keeps one of them, preferring the one `latest` points at, and removes the others' rows and files.
The downloaded file's hash stays in `file_hash` as provenance. The job reports by default and writes
only under `--apply`. Back up the catalog first, because a merge cannot be undone. The job computes the
same hash ingest does, and that hash leaves a snapshot taken before property extraction exactly as it
was, so on a converted catalog the report shows no identifier changing and no merge.

```bash
java -cp "$CP" org.metadatacenter.terms.ingest.ContentHashCutover $CEDAR_HOME/cedar-term/prod/catalog.sqlite
java -cp "$CP" org.metadatacenter.terms.ingest.ContentHashCutover $CEDAR_HOME/cedar-term/prod/catalog.sqlite --apply
```

`DeriveOntologyIriBackfill` records each ontology's canonical IRI, its identity across sources, for a
catalog built before ontologies had one. It takes the dominant namespace of the ontology's own
concepts in its `latest` snapshot, settles IRIs that several ontologies would share, and falls back to
the IRI the ontology file declares for any ontology still without one. Ingest applies the same rules
to each ontology it ingests. The job writes as it runs and has no dry run. With acronyms it handles
only those ontologies, and without them every ontology in the catalog.

```bash
java -cp "$CP" org.metadatacenter.terms.ingest.DeriveOntologyIriBackfill $CEDAR_HOME/cedar-term/prod/catalog.sqlite OBI RO
```

## Running the Picker

CETP is one `<cedar-embeddable-term-picker>` element with five selectable types:
`class`, `branch`, `ontology`, `valueSet`, and `property`. The `termTypes` JavaScript
property accepts any subset as an array; omitted enables all five. The optional
positive integer `maximumTerms` caps the combined selection table. Trying to add
another entry at the cap displays an error until an entry is removed. Omitting it
leaves the table unlimited. Done emits `constraintsSelected` with the whole draft.
The `language` property or attribute selects `en` (the default) or `hu`, and can change at any
time; any other value falls back to `en`. Each element keeps its own language, and both translation
maps in `src/assets/i18n` are compiled into the script. `npm test` also runs a guard that fails on a
user-visible string written outside those maps; deliberate exceptions go in `i18n-allowlist.json`
with a reason.

Properties use the local `/properties` API above, and their selected entries carry
`sourceType: 'ontology-property'`, `propertyKind`, property IRI and an exact ontology
`version.id`. The Properties tab supports parent/child navigation and release
selection. CED's vocabulary constraint editor explicitly enables the original four
types; property selections must not be serialized as class value constraints.
The legacy `selectionMode = 'constraint'` and `selectionMode = 'term'` single-pick
flows remain available. Explicit `termTypes` or `maximumTerms` selects the table
workflow. The default is the table workflow with all types.


`$CEDAR_HOME/cedar-embeddable-term-picker`, default branch `develop`. Node 24.22.1, the version `.nvmrc` pins.

```bash
npm --prefix $CEDAR_HOME/cedar-embeddable-term-picker install
npm --prefix $CEDAR_HOME/cedar-embeddable-term-picker start
```

That serves the development host on port 4500 — `src/index.html`, a page standing in for the
Template Designer, which sets the element's `query` and `selection-mode="constraints"` attributes and listens
for `constraintsSelected` and `cancelled`. `?mode=constraint` exercises the legacy
single-selection contract.
Nothing on that page ships. `proxy.conf.json` sends `/search` to the terminology server on 9004,
which keeps the call same-origin and CORS out of the picture.

**The proxy target is read once, at startup.** Changing it, or restarting the server it points at on
a different port, needs the dev server restarted too — otherwise every search returns 502 with
nothing wrong in the code.

For CED integration, assign `constraintSet = { constraints, actions }` and use
`selectionMode = 'constraints'`. The picker edits a draft and emits the entire set
on Done; `constraintsChanged` invalidates a host's pending validation, and Cancel
leaves the original intact. Branch depth is editable in each branch's details.
A bin icon removes an individual constraint or saved action. Exclusion and reordering controls are
deferred to the roadmap; retained actions are preserved unchanged. `selectionMode = 'term'` retains single-term output
for defaults. CED's default dialog assigns the field's set to `fieldConstraints`, and the picker then
searches only within it, through `bioportal/integrated-search`, showing one chip for each constraint.
Without `fieldConstraints`, multiple fixed `sources` appear in a vocabulary/release selector so two
pins of the same acronym are searched and browsed separately.

The picker validates the supplied draft as well as edits before Done. Its central
report identifies invalid identifiers, releases, depths, actions, duplicate entries,
disabled types and limits by row. Invalid rows remain removable; invalid depth edits
remain errors until corrected. Requests belong to their query, endpoint, scope and
release, so late search, history and nested hierarchy replies cannot replace newer
state. A pinned term remains unselectable until that release is verified. Failed
tree reads can be retried, and cyclic paths cannot recurse indefinitely.
`picker-state-matrix.spec.ts` covers response ordering, invalid incoming data,
nested release changes, paging and correction; the browser state-coordination tests
exercise the same recovery controls in the built component.

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

The picker does not ask for everything it could. A query of fewer than three characters naming no
source is declined in the component rather than sent, because those are the queries that cost most
and mean least — the characters an author passes through on the way to a word. It says so instead,
after a pause long enough that someone still typing never sees it. Narrowing lifts the floor, since
a search naming a source is answered in tens of milliseconds. Two consequences worth knowing when
reading the server's logs: a picker session shows no request for the first two characters typed, and
the server's own refusal below two characters is no longer what an author is shown.

Both endpoints are unauthenticated, like `integrated-search`. That is deliberate, and it is also the
one thing the server is inconsistent about: `/bioportal/ontologies` and
`/ontologies/{acronym}/versions` refuse without an API key, which is why the picker takes version
histories through the search response rather than calling the versions endpoint.

## Building and Testing the Picker

The picker's font, type scale and colours are CEDAR's, published from `cedar-design-tokens` as
`@org.metadatacenter/cedar-design-tokens`. `src/_cee-tokens.scss` and `src/_cedar-neutrals.scss`
were the copies the package was extracted from, and they went on 2026-09-15 — including the advisory
colour that had drifted, where the picker drew `#856404` against the editor's `#b45309`. The values
now come from `@use '@org.metadatacenter/cedar-design-tokens/tokens' as tokens`, with `node_modules`
on the Sass load path, and the variables carry no `cee-` prefix because the alias is what carries the
scope. The small and lead steps go on being derived from the base a host may set, so
`--cetp-font-size: 16px` still reads as a larger component rather than a broken one.

| Command | What it does |
|---|---|
| `npm run build:production` | the custom-element bundle, into `dist/cedar-embeddable-term-picker` |
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

<a id="fonts-and-why-there-is-a-component-that-renders-nothing"></a>

## Font Registration

Browsers do not register `@font-face` from inside a shadow root, so the picker cannot simply put the
faces in its own encapsulated stylesheet. `FontRegistrar` is the answer CEE also arrived at: a
component with `ViewEncapsulation.None` and an empty template, whose stylesheet holds the font faces
and no selectors at all. Angular sends an unencapsulated component's styles to the document head,
which is what registers the fonts; it also copies them into the shadow root, so the base64 exists
twice in the DOM at runtime. That is a memory cost rather than a transfer one.

The selectors matter: an unencapsulated stylesheet reaches the host page, so anything beyond a
`@font-face` in that file would leak out of the component.

Verified in a browser rather than assumed — `document.fonts` carries `CEDAR Roboto` at 400 and 500 and
`document.fonts.check('14px "CEDAR Roboto"')` returns true.

A global stylesheet in `angular.json` would be the ordinary way to reach the document, and it does
not work here: the CLI emits it as a separate `styles.css` that a host page never loads.
`"styles": []` is deliberate, in this repository and in CEE.

## Internal Boundaries

Each picker provides its own `TerminologyClient`; its property-detail child uses
that same instance. Multiple pickers can name different servers without sharing
endpoint state. Destruction cancels the search timer and outstanding node-page
requests.

`search/constraint-table` owns the selected-constraints presentation and emits
editing intents. The picker owns its draft, application and cancellation.
`constraint-presentation.ts` names the kinds, labels and identifiers;
`hierarchy-rows.ts` projects loaded hierarchy state into visible rows without
Angular or HTTP. Keep those domain operations outside the component.

## Class Names Are a Shared Namespace

The picker renders into one shadow root, so a class name means one thing across the whole component.
Three defects have come from forgetting that, each looking like a layout bug: `empty` on a spacer
picked up the empty-state paragraph's padding and stood every ontology row at 41px; `label` on a
tree node picked up the search caption's `text-transform: uppercase`; and the tree's own rules,
nested inside the detail panel's block, left a second tree elsewhere with no styling at all. Check
what a name already means before reusing it.

## Releasing the Picker

To build current picker sources into the local frontends, run `cedarcli build frontends`.
The local SNAPSHOT workflow includes uncommitted changes and needs no publication, pin update
or follow-up approval. The procedure here publishes registry dependencies for other installs.

The picker publishes development packages to CEDAR Nexus as
`@org.metadatacenter/cedar-embeddable-term-picker`; the split Designer consumes an exact npm alias.
Run its gate, then use the CLI's declared `cetp` component to plan and apply publication:

```bash
PORT=4607 npm run test:ci
cedarcli publish components --component cetp
cedarcli publish components --component cetp --apply
```

The source must be clean and at its pushed `develop` head. The CLI derives the immutable version,
rebuilds the staged package, publishes it and updates declared consumer pins for review; it commits
nothing. With an active local reactor, it leaves installed and served packages intact. See
[Recording a Pin](FRONTEND-RUNBOOK.md#recording-a-pin) for publication and activation rules.
`PORT` keeps browser tests off the CED demo's default 4599.

Build trains also publish and verify the picker from captured sources, with their own isolated
versions and consumer wiring; see [BUILD-RUNBOOK.md](BUILD-RUNBOOK.md).
