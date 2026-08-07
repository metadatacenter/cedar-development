# CEDAR (local dev root)

`$CEDAR_HOME` (`~/CEDAR`) is the container for all CEDAR repos on this machine — the
microservices (`cedar-*-server`), frontends (`cedar-template-editor`, …), libraries, `cedar-cli`,
and `cedar-development` (dev/ops tooling). This guidance applies across all of them; its canonical
copy lives in `cedar-development/CLAUDE.md` and is symlinked at `$CEDAR_HOME/CLAUDE.md`, so it loads
for a session rooted in any repo under the container.

## Managing the local CEDAR system → read the runbook

Full operational knowledge (architecture, bring-up sequence, gotchas, port map) lives in:

**`cedar-development/ops/BACKEND-RUNBOOK.md`**

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

## Ops docs: roadmaps and runbooks

More docs live under `cedar-development/ops/`. The runbooks tell you how to run, build, release
and deploy; the roadmaps track open work, where item numbers are stable handles.

Runbooks:
- [BACKEND-RUNBOOK.md](ops/BACKEND-RUNBOOK.md) — the local native stack: architecture, bring-up,
  gotchas, port map, and current framework state.
- [CEE-RUNBOOK.md](ops/CEE-RUNBOOK.md) — build and test the embeddable editor (CEE).
- [TS-MODEL-LIBRARY-RUNBOOK.md](ops/TS-MODEL-LIBRARY-RUNBOOK.md) — build and test the TypeScript
  model library.
- [ANGULAR-14-22-UPDRADE.MD](ops/ANGULAR-14-22-UPDRADE.MD) — preparation baseline and safety-net
  contract for incrementally upgrading CEE from Angular 14 through 22.
- [RELEASE-RUNBOOK.md](ops/RELEASE-RUNBOOK.md), [CEE-RELEASE-RUNBOOK.md](ops/CEE-RELEASE-RUNBOOK.md)
  and [PROD-DEPLOY-RUNBOOK.md](ops/PROD-DEPLOY-RUNBOOK.md) — releasing the artifacts, publishing the
  CEE npm package, and deploying to production.
- [WORDPRESS-RUNBOOK.md](ops/WORDPRESS-RUNBOOK.md) — the CEDAR WordPress site.

- [TEST-COVERAGE-MATRIX.md](ops/TEST-COVERAGE-MATRIX.md) — which integration baseline each microservice
  meets, how it pins its failure path, and what in-process backend it needs.

Roadmaps:
- [BACKEND-ROADMAP.md](ops/BACKEND-ROADMAP.md) — cross-cutting backend work: the microservices, the
  shared libraries, and the test and ops tooling.
- [CEE-ROADMAP.md](ops/CEE-ROADMAP.md) — the embeddable metadata editor.
- [TEMPLATE-DESIGNER-ROADMAP.md](ops/TEMPLATE-DESIGNER-ROADMAP.md) — the AngularJS Template Designer
  frontend (`cedar-template-editor`).
- [VERSIONING-ROADMAP.md](ops/VERSIONING-ROADMAP.md) — terminology versioning (its design is in
  [VERSIONING-DESIGN.md](ops/VERSIONING-DESIGN.md)).
- [TS-MODEL-LIBRARY-ROADMAP.md](ops/TS-MODEL-LIBRARY-ROADMAP.md) and
  [MODEL-LIBRARY-PARITY.md](ops/MODEL-LIBRARY-PARITY.md) — the TypeScript model library and its
  parity with the Java one.

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
  servers). Build `cedar-parent` before consumers, or they pick up stale managed versions and fail
  quietly. Never pipe `mvn` through `head`/`grep -m`: SIGPIPE can kill the reactor mid-build under a
  clean exit. Redirect to a file.
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
- `cedar-cli` is the control CLI (build/deploy/start/stop); on macOS its `start` opens Terminal
  tabs, which is why `cedar-services.sh` exists for headless/background management.
