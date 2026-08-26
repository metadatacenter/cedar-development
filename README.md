# CEDAR Development and Operations

Start with the published documentation:

- [Developer Install](https://metadatacenter.readthedocs.io/en/latest/install-developer/overview/)
  explains how to prepare a development machine, build CEDAR, and run the native stack.
- [cedarcli Manual](https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedarcli/)
  explains repository management, builds, publication, and the native, hybrid, and Docker modes.
- [Docker Install](https://metadatacenter.readthedocs.io/en/latest/install-docker/overview/)
  explains how to configure and run the published container stack.

This repository is the implementation and operations layer behind those guides. It is not a second
installation manual.

## Repository Contents

- `bin/templates/` contains the shared environment profiles loaded by `cedarcli`.
- `ops/` contains service controllers, acceptance tests, release and build-train machinery, and
  maintenance utilities.
- `ops/*-RUNBOOK.md` records detailed operator procedures and technical findings.
- `ops/*-ROADMAP.md` records unfinished engineering work.
- `.github/workflows/` coordinates repository-wide publication, including immutable Maven and
  Docker build trains.

The runbooks are intentionally lower-level than the MkDocs guides. Use them when maintaining the
tooling or diagnosing a deployment; use the published guides for the normal installation and
development workflow.
