Contributing to CEDAR
=====================

CEDAR is about fifty repositories that build and run as one system: twelve microservices, five shared Java
libraries, several frontends, a control CLI, and this repository, which holds the development and operations
tooling. A change to one of them is rarely confined to it, so the first thing to get right is the environment
the whole estate expects.

## Setting Up

Every CEDAR repository is checked out as a sibling under one directory, and that directory is `CEDAR_HOME`.
Export it before sourcing the profile, or the profile's own variables come out empty:

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
```

Java 17 is a version lock, not a preference. Newer JDKs crash Keycloak at startup, so pin the toolchain
before building anything:

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

The persistence and infrastructure servers are locked too: Mongo, MySQL, Neo4j, Redis, OpenSearch and
Keycloak. Client libraries may move; those servers may not. The current framework baseline lives in
[BACKEND-RUNBOOK.md](ops/BACKEND-RUNBOOK.md).

## Building

`cedarcli build java` is the authoritative build. It walks the reactor in dependency order — parent, then
libraries, then servers — and runs every repository's unit and embedded integration tests. A green run means
the estate compiles and those suites pass.

Two things about it are worth knowing before your first build. `cedar-parent` declares the managed version of
every dependency, so build it before its consumers or they resolve stale versions and fail in ways that do
not name the cause. And never pipe a Maven run through `head` or `grep -m`: SIGPIPE can kill the reactor
partway through while it still reports a clean exit. Redirect to a file and search that.

To iterate on a single repository, use its wrapper directly:

```bash
./mvnw -o install
```

## Testing

Every server suite runs without a backend. `cedar-test-support-library` supplies an in-memory authorization
service and embedded Neo4j, Mongo and MariaDB on random ports, and the suites bind their HTTP ports in the
19xxx range — the development ports plus ten thousand — so a running development stack never collides with a
test run.

The tests that do need an external service are tagged and excluded by default: terminology's under
`bioportal`, the bridge server's under `datacite`. Run those deliberately, with credentials, or not at all.

Two shared helpers refuse to pass vacuously, and new tests should follow them: `PermissionMatrix` fails when
the matrix it was given is empty, and `RouteSurface` fails when reflection found no endpoints. A test that
asserts nothing reports success for a system that does nothing.

A green suite is necessary and not sufficient. Suites verify logic; a redeploy and an end-to-end run verify
reality, and real runtime failures have passed green suites. After any change to inter-service HTTP, to
validation, or to startup wiring, bring the stack up and exercise it:

```bash
bash $CEDAR_UTIL_BIN/services-generic/startinfra.sh
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh status
```

`status` prints a BINARY column and marks an unmanaged process with `~pid`, so a healthy row cannot hide a
service still running an old jar. Confirm every row reads `current` after a redeploy. Then, from
`ops/e2e`, `npm run smoke:rest` walks the REST surface and `npm run smoke` drives the browser through a real
login, a template round trip and a controlled-term lookup.

## Continuous Integration

GitHub Actions builds every Java repository on push and on pull request to `develop`, and a merge to
`develop` publishes that repository's snapshot to Nexus. Downstream builds and the Docker images resolve
CEDAR artifacts from Nexus rather than from a checkout, so an unpublished snapshot breaks a consumer that did
not change. When a build fails in a repository you did not touch, check whether its dependency published.

## Making a Change

Several repositories may be under edit at once. Check `git status` before staging, stage the specific files
your change touches, and never `git add -A` across a repository you did not read.

Declare a dependency version in `cedar-parent` and nowhere else. A child pom names the dependency; the parent
names its version.

Write the commit message about the change and the surface it affects. Do not refer to a numbered item on a
roadmap: those numbers are renumbered whenever an item is removed, so they do not survive as references.

## Documentation

Documentation under `ops/` comes in pairs by area: a runbook says how to run, build, release and deploy the
thing, and a roadmap tracks what remains open on it. Findings and measurements belong with whichever of the
pair they concern rather than in files of their own.

A roadmap is forward-looking. It records what is still open, never what was achieved: the commits are the
record of the work, and the runbook carries whatever current state an operator needs. When an item is
finished it leaves the document.

[README.md](README.md) points at the published developer guides and describes what this repository holds.
`AGENTS.md` maps the runbooks and roadmaps by area and carries the same guidance in the form the coding
assistants read; the instruction files at `CEDAR_HOME` are symbolic links to it.
