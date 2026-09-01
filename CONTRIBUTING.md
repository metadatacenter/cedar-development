Contributing to CEDAR
=====================

CEDAR is about fifty repositories that build and run as one system: twelve microservices, five shared Java
libraries, several frontends, a control CLI, and this repository, which holds the development and operations
tooling. A change to one of them is rarely confined to it.

`cedarcli` is the control surface for all of it. It clones and inspects the repositories, builds them in
dependency order, brings the stack up and down, manages certificates, and cuts releases. Prefer it to the
underlying scripts: those are implementation, and they change.

Two documents come before this one. The
[Developer Install](https://metadatacenter.readthedocs.io/en/latest/install-developer/overview/) guide takes
a machine from nothing to a running native stack, and the
[cedarcli Manual](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/) is the reference
for every command named here. This guide covers what a contributor needs on top of them.

## Setting Up

Follow the developer install guide in order:
[prerequisites](https://metadatacenter.readthedocs.io/en/latest/install-developer/prerequisites/),
[configuration](https://metadatacenter.readthedocs.io/en/latest/install-developer/configuration/),
[the CLI](https://metadatacenter.readthedocs.io/en/latest/install-developer/cedar-cli-and-scripts/),
[building](https://metadatacenter.readthedocs.io/en/latest/install-developer/building-the-code/),
[certificates](https://metadatacenter.readthedocs.io/en/latest/install-developer/ssl-certificates/), then the
[infrastructure services](https://metadatacenter.readthedocs.io/en/latest/install-developer/infrastructure-services/),
[microservices](https://metadatacenter.readthedocs.io/en/latest/install-developer/microservices/) and
[frontends](https://metadatacenter.readthedocs.io/en/latest/install-developer/frontends/).

Three things in it are version locks rather than preferences, and getting them wrong costs an afternoon.
Java 17 is required: newer JDKs crash Keycloak at startup. The persistence and infrastructure servers are
pinned too, so Mongo, MySQL, Neo4j, Redis, OpenSearch and Keycloak stay where they are declared even when
their client libraries move. And every repository is checked out as a sibling under one directory, which is
`CEDAR_HOME`.

`cedarcli env status` shows the mode you are in and where its environment came from, which is the fastest way
to find out why a value is not what you expected. `cedarcli cheat` opens the command cheatsheet.

## Building

`cedarcli build java` is the authoritative build. It walks the reactor in dependency order — parent, then
libraries, then servers — and runs every repository's unit and embedded integration tests, so a green run
means the estate compiles and those suites pass. `cedarcli build parent`, `build libraries`, `build
frontends` and `build all` address the same reactor in smaller pieces, and `cedarcli build this` builds the
repository you are standing in. The
[building](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/building/) page covers
the options.

Two things are worth knowing before your first build. `cedar-parent` declares the managed version of every
dependency, so it builds before its consumers or they resolve stale versions and fail without naming the
cause. And never pipe a Maven run through `head` or `grep -m`: SIGPIPE can kill the reactor partway through
while it still reports a clean exit. Redirect to a file and search that.

`cedarcli check versions` and `cedarcli check repos` report version and repository consistency across the
estate, which is worth running when a build fails in a repository you did not touch.

## Testing

Every server suite runs without a backend. `cedar-test-support-library` supplies an in-memory authorization
service and embedded Neo4j, Mongo and MariaDB on random ports, and the suites bind their HTTP ports in the
19xxx range — the development ports plus ten thousand — so a running development stack never collides with a
test run.

The tests that do need an external service are tagged and excluded by default: terminology's under
`bioportal`, the bridge server's under `datacite`. Run those deliberately, with credentials, or not at all.

Two shared helpers refuse to pass vacuously, and a new test should follow them. `PermissionMatrix` fails when
the matrix it was given is empty, and `RouteSurface` fails when reflection found no endpoints. A test that
asserts nothing reports success for a system that does nothing.

A green suite is necessary and not sufficient. Suites verify logic; a redeploy and an end-to-end run verify
reality, and real runtime failures have passed green suites. After any change to inter-service HTTP, to
validation, or to startup wiring, bring the stack up and exercise it:

```bash
cedarcli native start all
cedarcli native status
```

`cedarcli native status` prints a BINARY column and marks an unmanaged process with `~pid`, so a healthy row
cannot hide a service still running an old jar. Confirm every row reads `current` after a redeploy.
`cedarcli native health` exits non-zero unless every managed application is healthy, which is what to call
from a script. `cedarcli native restart <service>` redeploys one service, `cedarcli native logs <service>`
follows its log, and `cedarcli native watch` refreshes the whole table. The
[native mode](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/native/) page covers
the rest, and [modes](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/modes/)
explains how native, hybrid and Docker differ.

Then, from `ops/e2e`, `npm run smoke:rest` walks the REST surface and `npm run smoke` drives a browser
through a real login, a template round trip and a controlled-term lookup. The
[REST API reference](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedar-rest-apis/)
describes what those exercise.

## Continuous Integration

GitHub Actions builds every Java repository on push and on pull request to `develop`, and a merge to
`develop` publishes that repository's snapshot to Nexus. Downstream builds and the Docker images resolve
CEDAR artifacts from Nexus rather than from a checkout, so an unpublished snapshot breaks a consumer that did
not change.

## Making a Change

Several repositories may be under edit at once. Check `git status` before staging, stage the specific files
your change touches, and never `git add -A` across a repository you did not read. `cedarcli git status`
reports the whole estate at once.

Declare a dependency version in `cedar-parent` and nowhere else. A child pom names the dependency; the parent
names its version.

Write the commit message about the change and the surface it affects. Do not refer to a numbered item on a
roadmap: those numbers are renumbered whenever an item is removed, so they do not survive as references.

Releases run through `cedarcli release start` across the versioned repositories. A few publish themselves to
npmjs instead and are marked `skip_from_release`. See
[Releasing CEDAR](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/release/).

## Documentation

The published documentation lives in `cedar-mkdocs` and covers the
[user guide](https://metadatacenter.readthedocs.io/en/latest/user-overview/),
[tutorials](https://metadatacenter.readthedocs.io/en/latest/tutorials/),
[install guides](https://metadatacenter.readthedocs.io/en/latest/install-overview/) and the
[developer guide](https://metadatacenter.readthedocs.io/en/latest/developer-overview/). A change that alters
what an operator types or what a client receives belongs there.

Documentation under `ops/` in this repository is the operations layer behind those guides, and it comes in
pairs by area: a runbook says how to run, build, release and deploy the thing, and a roadmap tracks what
remains open on it. Findings and measurements belong with whichever of the pair they concern rather than in
files of their own.

A roadmap is forward-looking. It records what is still open, never what was achieved: the commits are the
record of the work, and the runbook carries whatever current state an operator needs. When an item is
finished it leaves the document.

`AGENTS.md` maps the runbooks and roadmaps by area and carries this guidance in the form the coding
assistants read. The instruction files at `CEDAR_HOME` are symbolic links to it.
