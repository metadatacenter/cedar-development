# CEDAR MCP Servers — Roadmap

Open work across the four MCP servers under `$CEDAR_HOME/mcp`. Building, configuring and testing
them is in [MCP-RUNBOOK.md](./MCP-RUNBOOK.md).

Items live here when they span the servers or concern how they are built and released. Work inside
one server — a tool to add, a description to sharpen — belongs in that repository's own roadmap:
[cedar-artifact-mcp](../../mcp/cedar-artifact-mcp/ROADMAP.md),
[cedar-artifact-rest-mcp](../../mcp/cedar-artifact-rest-mcp/ROADMAP.md),
[cedar-cee-mcp](../../mcp/cedar-cee-mcp/ROADMAP.md),
[bioportal-term-mcp](../../mcp/bioportal-term-mcp/ROADMAP.md).

## Next

- **1. Build and release the MCP servers with everything else.** Four repositories, none part of
  `cedarcli build java`, none with a GitHub Actions workflow, and until now unmentioned by
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) or [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md). They are
  built by hand, which means they are built when somebody remembers.

  What that costs is particular to an MCP. **A tool's description is the only documentation the
  calling model ever reads, and it ships inside the jar.** `cedar-artifact-rest-mcp` once ran a
  30 July jar whose descriptions had been rewritten on 9 August, so a client spent a fortnight
  reading a surface that no longer described the tools — and a wrong description is followed, not
  ignored. A stale MCP jar is worse than a stale service jar.

  Deliver:

  - Build the three Maven servers with the rest, after `cedar-artifact-library`, so a library change
    that breaks a tool signature fails in the build rather than at a client's first call.
  - Give each repository the workflow every other Java repository already has.
  - Decide whether they join `cedarcli release all-in-one` or stay outside it, as CEE and the
    TypeScript model library do. `cedar-artifact-rest-mcp` is the one with a real choice to make:
    it resolves from Maven Central alone, so it could be published like any other package. The other
    two hold a local `cedar-artifact-library` SNAPSHOT and cannot be until that changes.
  - Make a running server state which CEDAR it talks to. `ping` reports the build and deliberately
    contacts nothing, so the target is invisible — and it is fixed when the process spawns, so
    editing a client's configuration changes nothing until the server restarts. That combination let
    a server go on writing to whatever it was started against after its configuration had been
    pointed elsewhere, which is a hazard when one of the two is production.

  Two obstacles this item used to carry are gone. The three Maven servers were unbuildable here,
  all pinning `cedar-artifact-library:2.8.4-SNAPSHOT` while `~/.m2/settings.xml` reached
  `oss.sonatype.org`, which answers `402 Payment Required` and aborted resolution before the BMIR
  Nexus was tried. The pin moved to 2.9.2-SNAPSHOT and they build. Separately, a rebuild produced a
  jar that would not start at all, from a `json-schema-validator` conflict between the MCP SDK and
  `CedarValidator`; that is resolved per server and written up in the runbook, but it is the kind of
  breakage that only surfaces on a rebuild, which is the argument for building them continuously.

- **2. Track the CEE bundle a client actually serves.** `cedar-cee-mcp` pins the CEE by version and
  hash and refuses a mismatch, so what a build produces is known. What a *client* is running is not:
  the jar is loaded when the process spawns, and a rebuilt jar takes effect only after a restart
  nobody is prompted to perform. `ping` reports the MCP's own version and says nothing about the
  bundle inside it.

  The CEE also publishes dev releases faster than anyone bumps a pin, and each one may narrow the
  configuration surface again — 2.0 dropped nine of the fourteen keys this server sent. A unit test
  now catches that at build time, but only for a build that happens.

- **3. Give the servers a shared release note surface.** Each repository has a README, a DESIGN, a
  ROADMAP and a CLAUDE.md, and the four sets restate the same conventions — how a jar is built and
  named, that descriptions are documentation, that secrets come from the environment. The
  duplication is mild and mostly harmless, but a convention that changes has four homes to visit.
  Consider whether the shared half belongs here, in the runbook, with each repository keeping only
  what is true of itself.

## Out of scope

- **What each server does.** The tool surface, its wording and its behaviour are the repository's
  own concern, and each has a ROADMAP for it.
- **The CEE itself.** Building, testing and releasing the web component is
  [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) and [CEE-ROADMAP.md](./CEE-ROADMAP.md); this pair covers only
  how `cedar-cee-mcp` consumes a published bundle.
- **The CEDAR server surface the REST MCP calls.** Endpoint behaviour, validation and content
  negotiation are backend work, in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).
