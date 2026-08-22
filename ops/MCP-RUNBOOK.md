# CEDAR MCP Servers — Runbook

Building, configuring, testing and upgrading the four MCP servers under `$CEDAR_HOME/mcp`. What is
still to do with them is in [MCP-ROADMAP.md](./MCP-ROADMAP.md).

An MCP server hands a language model a set of tools backed by real services. These four let a model
author a CEDAR template by conversation, resolve its ontology terms against BioPortal, see the form
it becomes, and store the result on a CEDAR server. The
[CEDAR MCPs Tutorial](https://metadatacenter.readthedocs.io/en/latest/tutorials/cedar_mcps_tutorial/)
walks that end to end.

## The Four Servers

| Repository | Language | What it does | Credentials |
|---|---|---|---|
| `bioportal-term-mcp` | Python 3.14, `uv` | Resolves BioPortal ontologies, classes and value sets to canonical IRI tuples, by identifier or free-text search | `BIOPORTAL_API_KEY` |
| `cedar-artifact-mcp` | Java 17, Maven | Builds, edits, validates and renders templates, elements, fields and instances in memory | none |
| `cedar-cee-mcp` | Java 17, Maven | Renders a template or instance as a form in the browser, and collects what a person fills in | none |
| `cedar-artifact-rest-mcp` | Java 17, Maven | Creates, fetches, updates, deletes and validates artifacts on a live CEDAR server | `CEDAR_API_KEY`, `CEDAR_BASE_URL` |

Each is its own repository. They compose rather than overlap: build in `cedar-artifact-mcp`, look
in `cedar-cee-mcp`, persist in `cedar-artifact-rest-mcp`, and reach for `bioportal-term-mcp`
whenever a real IRI is needed.

## Build

```bash
cd $CEDAR_HOME/mcp/cedar-artifact-mcp && mvn package     # and the other two Maven servers
cd $CEDAR_HOME/mcp/bioportal-term-mcp && uv sync
```

Java 17, as everywhere in CEDAR. `mvn package` writes a shaded, executable jar and then a
version-less copy beside it — `target/<artifactId>.jar` — so a client's configuration can name a
fixed path that survives a version bump.

Two of the three Maven servers depend on `cedar-artifact-library`, currently a local SNAPSHOT, so
they need it installed first. `cedar-artifact-rest-mcp` does not: it resolves from Maven Central
alone.

**The jar is the documentation.** A tool's description is the only thing the calling model ever
reads about it, and descriptions ship inside the jar. A stale MCP jar is therefore worse than a
stale service jar — the model does not ignore a description that disagrees with behaviour, it
follows it.

## Configure

Servers are launched by the MCP client over stdio; there is nothing to start by hand. Register them
once in the client's configuration (`~/.claude.json` for Claude Code), naming the stable jar path:

```json
{
  "mcpServers": {
    "bioportal-term": {
      "command": "/opt/homebrew/bin/uv",
      "args": ["--directory", "/Users/you/CEDAR/mcp/bioportal-term-mcp", "run", "bioportal-term-mcp"],
      "env": { "BIOPORTAL_API_KEY": "…" }
    },
    "cedar-artifact":      { "command": "/usr/bin/java", "args": ["-jar", "…/cedar-artifact-mcp/target/cedar-artifact-mcp.jar"] },
    "cedar-cee":           { "command": "/usr/bin/java", "args": ["-jar", "…/cedar-cee-mcp/target/cedar-cee-mcp.jar"] },
    "cedar-artifact-rest": {
      "command": "/usr/bin/java",
      "args": ["-jar", "…/cedar-artifact-rest-mcp/target/cedar-artifact-rest-mcp.jar"],
      "env": { "CEDAR_API_KEY": "…", "CEDAR_BASE_URL": "https://resource.metadatacenter.orgx" }
    }
  }
}
```

`CEDAR_BASE_URL` decides which CEDAR the writing server writes to, and defaults to **production**.
Point it at `https://resource.metadatacenter.orgx` for the local stack.

### A Rebuilt Jar Does Not Take Effect Until the Server Restarts

The client spawns each server as a child process at startup and holds it. Overwriting the jar
underneath a running process changes nothing: it goes on serving the code it loaded, tool
descriptions included. Restart the client, or kill the server processes and let the client respawn
them.

That combination has bitten before in a worse form. The target server is read from the environment
when the process spawns, so editing `CEDAR_BASE_URL` in a client's configuration also changes
nothing until the restart — and a server can go on writing to whatever it was started against long
after its configuration says otherwise. When one of the two is production, check before assuming.
`ping` reports the server name and version but deliberately contacts nothing, so it does not answer
the question of which CEDAR is on the other end.

## Test

```bash
mvn test              # unit tests: in-process, no browser, no network, no CEDAR server
mvn verify            # + the end-to-end IT: spawns the shaded jar and speaks real JSON-RPC over stdio
mvn verify -Plive     # cedar-artifact-rest-mcp only: hits a real server; needs CEDAR_API_KEY
uv run pytest         # bioportal-term-mcp
uv run pytest -m live # + the tests that call BioPortal; needs BIOPORTAL_API_KEY
```

Live tests are opt-in everywhere and excluded by default, so an ordinary build needs no key and no
server. A live test must delete whatever it creates, in a `finally`, and assert that it did.

Beyond the suites, two things only a browser can confirm for `cedar-cee-mcp`: that the form renders,
and that the CEE accepted the configuration it was handed. **Watch the browser console** — CEE
reports a configuration key it does not read and then ignores it, which is otherwise silent. A unit
test asserts every key the server sends is one CEE reads, so a release that narrows the surface
fails the build rather than the form.

## Upgrading the CEE Bundle

`cedar-cee-mcp` serves the CEE web-component bundle out of its own jar. The CEE publishes to the
BMIR Nexus under the `@org.metadatacenter` scope rather than to npmjs, so no public CDN carries it
and the host page has nothing to link to. The build fetches the package and stages the bundle as a
resource; a session then needs no network beyond the terminology and bridge services the fields
themselves call.

Two lines in `pom.xml` pin it:

```xml
<cee.version>2.0.0-dev.20260818.6dca9bf</cee.version>
<cee.sha256>2d7b7206222d36b5631b4648479500a8b8738daa7f40107cacf8796b2d3112b9</cee.sha256>
```

The hash is the bundle's own, from the package's `bundle-manifest.json`, and the build refuses a
bundle that does not match. It is pinned because a dev label can be republished: the version alone
does not identify the bytes, which is the same reason [CEE-RUNBOOK.md](./CEE-RUNBOOK.md) tells you
to compare hashes rather than version strings when a frontend looks wrong.

To bump: find the version the `dev` dist-tag names, take its hash from the manifest, change both
lines, run the suite, and open a form in a browser with the console visible.

```bash
curl -s https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter%2fcedar-embeddable-editor \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist-tags"])'
```

## The Dependency That Breaks a Rebuild

The MCP SDK validates tool schemas with `json-schema-validator` 3.x, and loads it at startup.
`cedar-artifact-library` brings 1.5.9, which Maven prefers as the nearer declaration, and which has
none of the classes the SDK wants: the server dies on its first `build()` with
`NoClassDefFoundError: com/networknt/schema/dialect/Dialects`.

`cedar-artifact-rest-mcp` and `cedar-cee-mcp` declare 3.0.0 and are done with it. `cedar-artifact-mcp`
cannot: `CedarValidator`, from `cedar-model-validation-library`, calls `com.networknt.schema.Format`,
which 2.0.0 removed, and one classpath cannot hold both. It supplies the MCP server its own
validator built on the 1.x release already present, so the SDK never asks for one.

The symptom to recognize: a jar that built cleanly and exits immediately on startup. Read the
server's stderr — the client hides it.

## What the Servers Write

`cedar-artifact-rest-mcp` is the only one that writes anything, and `delete_*` is irreversible. Its
tool descriptions say so, and the model is told to confirm with a person first, but nothing enforces
that. When it is pointed at production, treat it as production.

Identity belongs to CEDAR. Every identifier a stored artifact carries — its own, its children's, and
the property IRIs in its `@context` — is minted by the server on create, so nothing here invents one.
An artifact built in `cedar-artifact-mcp` names nothing until it is saved, which is why an instance
can only be built against a template that has been stored: `isBasedOn` has to name something real.
