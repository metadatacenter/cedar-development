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

## Find a Runbook

| Task | Runbook |
| --- | --- |
| Operate the native stack; diagnose backend behavior; audit or repair artifacts | [Backend](ops/BACKEND-RUNBOOK.md) |
| Build and test browser applications, embeddable components and the TypeScript model | [Frontend](ops/FRONTEND-RUNBOOK.md) |
| Publish or resume an immutable development build train | [Build trains](ops/BUILD-RUNBOOK.md) |
| Run Docker or hybrid deployments | [Docker](ops/DOCKER-RUNBOOK.md) |
| Cut a platform release from a completed train | [Release](ops/RELEASE-RUNBOOK.md) |
| Publish the independently versioned model, CEE, CED or term-picker packages | [Public npmjs release](ops/NPMJS-RELEASE-RUNBOOK.md) |
| Deploy a released platform to a native server | [Production deployment](ops/PROD-DEPLOY-RUNBOOK.md) |
| Ingest and serve terminology; build and test the term picker | [Terminology versioning](ops/VERSIONING-RUNBOOK.md) |
| Build, configure or upgrade the MCP servers | [MCP servers](ops/MCP-RUNBOOK.md) |
| Diagnose an application-log backlog or dead letters | [Log queue](ops/LOG-QUEUE-RUNBOOK.md) |
| Rehearse the log-aggregation migration | [Staging log aggregation](ops/STAGING-LOG-AGGREGATION-RUNBOOK.md) — release-specific historical plan; verify applicability first |
| Write, preview and publish a website post | [WordPress](ops/WORDPRESS-RUNBOOK.md) |

### Command Conventions

Export `CEDAR_HOME` for this installation and use `cedarcli env status` to check the selected mode,
profile and host before operating it. The CLI loads its own environment. If the shell has no
`cedarcli` alias, use `bash "$CEDAR_HOME/cedar-cli/cli.sh" <arguments>`.

Commands with paths beginning `ops/` run from `"$CEDAR_HOME/cedar-development"`; component
commands run from the repository named in that section. Direct scripts, Maven or npm commands
that use CEDAR variables need the selected profile in their calling shell; see the
[native environment procedure](ops/BACKEND-RUNBOOK.md#environment-select-the-native-mode-first).

Dated measurements describe the source, inputs and environment recorded with them. Recheck the
current deployment before using a historical result as an operational decision. Keep procedures and
useful evidence in the runbooks, and remaining engineering work in the paired roadmaps.
