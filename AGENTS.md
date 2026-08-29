# CEDAR (local dev root)

`$CEDAR_HOME` (`~/CEDAR`) is the container for all CEDAR repos on this machine — the
microservices (`cedar-*-server`), frontends (`cedar-template-editor`, …), libraries, `cedar-cli`,
and `cedar-development` (dev/ops tooling). This guidance applies across all of them. Its canonical,
version-controlled copy is `cedar-development/AGENTS.md`; the tool-specific instruction files at
`$CEDAR_HOME` and in `cedar-development` are symlinks to that one file.

Start multi-repository sessions with `$CEDAR_HOME` as the workspace root so the shared entry point is
discovered before work begins. Paths and Markdown links in this file are written from the
`cedar-development` repository unless they begin with `cedar-development/`.

## Managing the local CEDAR system → read the runbook

Choose the guide by task:

- **Native backend and native stack:** `cedar-development/ops/BACKEND-RUNBOOK.md`
- **Maven and Docker build trains:** `cedar-development/ops/BUILD-RUNBOOK.md`
- **Full-Docker and hybrid stacks:** `cedar-development/ops/DOCKER-RUNBOOK.md`
- **Open Docker delivery work:** `cedar-development/ops/DOCKER-ROADMAP.md`
- **Releases:** `cedar-development/ops/RELEASE-RUNBOOK.md`
- **Public npmjs releases (TypeScript model library and CEE):**
  `cedar-development/ops/NPMJS-RELEASE-RUNBOOK.md`
- **Production deployment:** `cedar-development/ops/PROD-DEPLOY-RUNBOOK.md`
- **The embeddable template designer:** `cedar-development/ops/DESIGNER-RUNBOOK.md`

Helper scripts are in `cedar-development/ops/`:
- `cedar-services.sh` — start / stop / **status** / watch / logs for the microservices + frontends,
  as background processes (no Terminal-tab sprawl). `status` shows a **BINARY** column and marks an
  unmanaged process `~pid`, so a green health check can't hide a service running an old jar; confirm
  every row reads `current` after a redeploy.
- `cedar_ontology_usage.py` — inventory ontologies referenced by templates/elements. With
  `--emit-constraints` it also harvests each field's `_valueConstraints` as integrated-search-ready
  JSONL, the raw corpus for terminology differential testing.
- `cedar_usage_matrix.py` — reduce that harvest to the atomic-target usage matrix: one row per
  distinct `(kind, acronym, target)` terminology lookup production performs, for comparing two
  terminology-server implementations (current vs SQLite-backed).
- `cedar_artifact_patch.py` — find and repair the defects stored artifacts carry rather than code: an
  empty `pav:derivedFrom` or `@id`, a forbidden `_ui.pages`, an unnamed attribute, a temporal field
  with no `temporalType`, an orphan `@context` term, a legacy constraint shape, a static field the
  schema demands of every instance. Reads a tree of artifact files or a Mongo store, reports by
  default, writes only under `--apply`.
- `cedar_artifact_rest_audit.py` — GET-only, permission-scoped production inventory for the hardened
  identifier and attribute-name rules. Defaults to the template/element schema-safety pass and can
  enumerate all four artifact kinds through `/search-deep` with `--types all`; it streams JSONL
  findings and checkpoints `processed/total` every 300 artifacts. It never writes an artifact and
  never stores or prints the API key.

- `cedar_term_bench.py` — times the terminology server's lookup paths against whatever it is
  serving, drawing query strings from the served index so every lookup matches something. Reports
  the latency distribution by ontology size, by query breadth and by page size. Give it a warm
  server and an otherwise idle stack: a benchmark competing with the e2e smoke makes each look like
  a regression in the other.

## Ops docs: roadmaps and runbooks

The documents under `cedar-development/ops/` include paired roadmaps and runbooks by area: a runbook
says how to run, build, release and deploy; a roadmap tracks open work. Findings and measurements sit
with whichever of the pair they belong to rather than in files of their own, so start from the pair
for your area and search within it.

Item numbers on a roadmap are for referring to items in conversation, nothing more. They are not
stable handles. **Numbering is contiguous and has no gaps: when an item is removed, renumber the
rest and fix the cross-references that named them.** Number in document order. **Never refer to a
numbered item — or to a phase number — in a commit or check-in message**; describe the concrete
change and the surface it affects.

The backend — the microservices, the shared Java libraries, the stack itself:
- [BACKEND-RUNBOOK.md](ops/BACKEND-RUNBOOK.md) — architecture, bring-up, the `cedar-services.sh`
  controller, port map, the expensive gotchas, building and testing (including which integration
  baseline each microservice meets), continuous integration and snapshot publishing, the e2e smoke
  test, and the current framework state.
- [BACKEND-ROADMAP.md](ops/BACKEND-ROADMAP.md) — cross-cutting backend work across the
  microservices, the shared libraries, and the test and ops tooling.
- [BUILD-RUNBOOK.md](ops/BUILD-RUNBOOK.md) — creating, resuming and consuming immutable development
  build trains across Maven artifacts and Docker images, including their Nexus and state-branch
  layout.
- [DOCKER-RUNBOOK.md](ops/DOCKER-RUNBOOK.md) — building and operating the full-Docker and
  native-frontend hybrid container stacks.
- [DOCKER-ROADMAP.md](ops/DOCKER-ROADMAP.md) — remaining registry-backed delivery, promotion,
  rollback, image-verification and persistence work.

The embeddable editor (CEE) and the TypeScript model library it consumes:
- [CEE-RUNBOOK.md](ops/CEE-RUNBOOK.md) — the Node version (one now, 24.19.0, read that first),
  running the app, the test gate and what CI runs, checking output against the CEDAR model,
  and building the model library.
- [NPMJS-RELEASE-RUNBOOK.md](ops/NPMJS-RELEASE-RUNBOOK.md) — releasing the public TypeScript model
  library and CEE packages, explicitly wiring the model into CEE, verifying the repository README
  in each tarball, restoring both development channels, and handing CEE to a train-backed release.
- [CEE-ROADMAP.md](ops/CEE-ROADMAP.md) — CEE's open work: what the finished Angular 14 → 22 march
  left behind, styling and theming, the host contract, plus the model library's own items and
  adoption status.

The embeddable designer (CED) — `cedar-embeddable-designer`, the authoring half of the pair CEE
completes, and the replacement for the AngularJS Template Designer:
- [DESIGNER-RUNBOOK.md](ops/DESIGNER-RUNBOOK.md) — running the development host, the two builds,
  the four test gates, the single-file distribution and the channel its version selects, embedding
  it alongside `<cedar-term-picker>`, and why controlled-term search needs a local terminology
  server today.
- [DESIGNER-ROADMAP.md](ops/DESIGNER-ROADMAP.md) — the distance to a designer anyone could switch
  to, measured against the production designer's own palette configuration, in the order to do it:
  the capability rules the palette still lacks, keeping the version an author pinned, the
  save-and-publish lifecycle it has none of, and then template elements.

Terminology versioning, the authoring surface included — `cedar-term-picker`, the Web Component
replacing the Workbench's controlled-term picker, is tracked here rather than in a pair of its own,
because it exists to author versioned constraints:
- [VERSIONING-RUNBOOK.md](ops/VERSIONING-RUNBOOK.md) — running it: the store on disk, ingesting and
  rebuilding the index, serving the store from the terminology server, and building, testing and
  running the picker.
- [VERSIONING-ROADMAP.md](ops/VERSIONING-ROADMAP.md) — everything else about versioning in one
  document: the model and why it is that (content-hash identity, the constraint shape,
  freeze-on-publish, multilingual labels), the numbered items still open across the model, the store
  and the picker, the request and response shapes of `POST /search` and `GET /search/hierarchy`, and
  the findings — what the picker replaces and has built, the ingestion tracker, the BioPortal
  reconciliation log, and the survey of ingesting from other repositories. A finished item leaves
  the numbered list and joins the built paragraph at the top; the numbers are not stable handles.

The MCP servers under `$CEDAR_HOME/mcp` — the four that let a language model author, look at,
resolve terms for and store CEDAR artifacts:
- [MCP-RUNBOOK.md](ops/MCP-RUNBOOK.md) — what each server is for, building and configuring them, the
  client-restart rule a rebuilt jar depends on, testing, upgrading the CEE bundle `cedar-cee-mcp`
  serves, and the dependency conflict that leaves a freshly built jar unable to start.
- [MCP-ROADMAP.md](ops/MCP-ROADMAP.md) — building and releasing them with everything else, which
  they are outside of today, and what that costs when a tool description is the only documentation
  the calling model ever reads.

The rest:
- [RELEASE-RUNBOOK.md](ops/RELEASE-RUNBOOK.md) — `cedarcli release start` across the ~48
  versioned repos, front and back. CEE, the TypeScript model library and three others are
  `skip_from_release` and publish themselves; their public procedure is in
  [NPMJS-RELEASE-RUNBOOK.md](ops/NPMJS-RELEASE-RUNBOOK.md).
- [PROD-DEPLOY-RUNBOOK.md](ops/PROD-DEPLOY-RUNBOOK.md) — deploying CEDAR to production.
- [WORDPRESS-RUNBOOK.md](ops/WORDPRESS-RUNBOOK.md) — the CEDAR WordPress site.

## The four things that bite first (don't skip)

1. **Source the profile with `CEDAR_HOME` exported first**, or its vars come out empty:
   ```bash
   export CEDAR_HOME=/Users/martin/CEDAR
   source $CEDAR_HOME/cedar-profile-native-develop.sh
   ```
2. **Use Java 17.** `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`. Newer JDKs (23/25) crash
   Keycloak (`getSubject … security manager`). The zsh shell already pins 17; bash pins 21 (avoid).
3. **OpenSearch** fails to start under Homebrew's JDK 25 → point it at 17:
   `launchctl setenv OPENSEARCH_JAVA_HOME "$(/usr/libexec/java_home -v 17)"; brew services restart opensearch`.
4. **Login shows a browser cert error but `curl -sk` works** → the local `.orgx` TLS **leaves expired**
   (~824-day life; the CEDAR CA is fine). Re-issue them from the CA and `sudo nginx -s reload` — full
   sequence in `cedar-development/ops/BACKEND-RUNBOOK.md` ("Browser blocks login with a cert error"). Check with:
   `echo | openssl s_client -connect cedar.metadatacenter.orgx:443 -servername cedar.metadatacenter.orgx 2>/dev/null | openssl x509 -noout -dates`.

## Bring it up

```bash
bash $CEDAR_UTIL_BIN/services-generic/startinfra.sh          # infra (after the env is set as above)
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh status
```
Then log in at **https://cedar.metadatacenter.orgx** as `test1@test.com` / `test1`
(also `test2@test.com` / `test2`).

To prove the stack end to end (real Keycloak login, folder and template round-trip, a Disease field
constrained to the DOID "disease" branch through the live BioPortal picker, and a populate-time term
suggestion, ~30 s): `cd cedar-development/ops/e2e && npm run smoke` — details in the runbook.

## Building and testing

- `cedarcli build java` is the authoritative full build (dependency order: parent → libraries →
  servers). It runs every Java repository's unit and embedded integration tests by default, so a
  green build says the stack compiles and those suites pass; use `--skip-tests` explicitly for a
  compile/install-only loop. Build `cedar-parent` before
  consumers, or they pick up stale managed versions and fail quietly. Never pipe `mvn` through
  `head`/`grep -m`: SIGPIPE can kill the reactor mid-build under a clean exit. Redirect to a file.
- Every server suite runs backend-free (in-memory auth + embedded Neo4j/Mongo/MariaDB from
  `cedar-test-support-library`). No suite needs an external service: the tests that do call one are
  tagged and excluded by default, terminology's under `bioportal` and bridge's under `datacite`.
  Tests boot on `19xxx` ports (dev + 10000) so a running dev stack never collides.
- GitHub Actions builds every Java repo on push and PR to `develop`, and a merge to `develop`
  publishes that repo's snapshot to Nexus. Downstream builds and the Docker images resolve CEDAR
  artifacts from Nexus, never from a checkout, so an unpublished snapshot breaks a consumer that
  did not change. Details in the runbook, "Continuous integration".
- Suites verify logic; a **redeploy + `ops/e2e` smoke run verifies reality**. Always redeploy and
  smoke after changes to inter-service HTTP, validation, or startup wiring: real runtime bugs have
  passed green suites.
- Full operational, build, test, and dependency-state detail lives in the runbook
  (`cedar-development/ops/BACKEND-RUNBOOK.md`).

## Version locks and framework state

- **Locked: Java 17, and the persistence/infra server versions** (Mongo, MySQL, Neo4j, Redis,
  OpenSearch, Keycloak). Client libraries may move; those servers may not.
- Current framework baseline (Dropwizard version, namespace, what's migrated) lives in the runbook —
  `cedar-development/ops/BACKEND-RUNBOOK.md`, "Version locks and framework state". Don't restate it here.

## Conventions

- Commit/push only when asked. Several `cedar-*` repos may be edited by parallel sessions —
  check `git status` and stage specific files; never blanket `git add -A`.
- `cedar-cli` is the control CLI (build/publish/start/stop); on macOS its `start` opens Terminal
  tabs, which is why `cedar-services.sh` exists for headless/background management.
