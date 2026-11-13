# CEDAR MCP Servers — Runbook

Build, configure, test and upgrade the four MCP servers under `$CEDAR_HOME/mcp`.
Open work is in [MCP-ROADMAP.md](./MCP-ROADMAP.md).

The [CEDAR MCPs Tutorial](https://metadatacenter.readthedocs.io/en/latest/tutorials/cedar_mcps_tutorial/)
covers conversational authoring, terminology lookup, form rendering and persistence end to end.

## The Four Servers

| Repository | Language | What it does | Credentials |
|---|---|---|---|
| `bioportal-term-mcp` | Python 3.14, `uv` | Resolves BioPortal ontologies, classes and value sets to canonical IRI tuples, by identifier or free-text search | `BIOPORTAL_API_KEY` |
| `cedar-artifact-mcp` | Java 17, Maven | Builds, edits, validates and renders templates, elements, fields and instances in memory | none |
| `cedar-cee-mcp` | Java 17, Maven | Renders a template or instance as a form in the browser, and collects what a person fills in | none |
| `cedar-artifact-rest-mcp` | Java 17, Maven | Creates, fetches, updates, deletes and validates artifacts on a live CEDAR server | `CEDAR_API_KEY`, `CEDAR_BASE_URL` |

## Build

```bash
cd $CEDAR_HOME/mcp/cedar-artifact-mcp && mvn package     # and the other two Maven servers
cd $CEDAR_HOME/mcp/bioportal-term-mcp && uv sync
```

Java 17, as everywhere in CEDAR. `mvn package` writes a shaded, executable jar and then a
version-less copy beside it — `target/<artifactId>.jar` — so a client's configuration can name a
fixed path that survives a version bump.

`cedar-artifact-mcp` and `cedar-cee-mcp` pin released `cedar-artifact-library` versions in their
respective POMs and resolve them from anonymous-read BMIR Nexus; no sibling checkout is needed.
`cedar-artifact-rest-mcp` does not use the library and resolves from Maven Central alone.

Tool descriptions ship inside the jar. Rebuild and restart the client after changing them so the
model receives descriptions matching the running implementation.

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

<a id="a-rebuilt-jar-does-not-take-effect-until-the-server-restarts"></a>

### Restart After Rebuilds or Configuration Changes

Restart the client, or stop the server and let the client respawn it, after changing its
configuration or rebuilding its jar. A build renames a new `target/<server>.jar` into place rather
than writing over the old file, so a running server keeps the jar it opened and goes on running the
earlier build until it restarts.

Verify `CEDAR_BASE_URL` before writing: its default is production. `ping` reports only the MCP
server's name/version and does not verify the destination deployment.

## Test

```bash
mvn test              # unit tests: in-process, no browser, no network, no CEDAR server
mvn verify            # + the end-to-end IT: spawns the shaded jar and speaks real JSON-RPC over stdio
uv run pytest         # bioportal-term-mcp, against recorded BioPortal answers
```

No suite needs a key or a server. `bioportal-term-mcp` replays answers recorded from BioPortal,
which `tests/record_bioportal_answers.py` records again when BioPortal's shapes are in question.
`cedar-artifact-rest-mcp` meets a real server in the whole-stack smoke instead: the REST tier's
`mcp` suite starts its built jar over stdio as the first test user and takes templates through
validation, creation, reading, update and deletion on the local stack. That suite fails when the
jar is older than its sources, so run `mvn package` in `mcp/cedar-artifact-rest-mcp` before a smoke
run.

`cedar-cee-mcp` also has a production-browser gate. After `mvn verify`, run `npm ci` and
`npx playwright install chromium firefox webkit` in its `browser/` directory, then `npm test`.
Linux hosts need the browser system libraries (`npx playwright install-deps chromium firefox webkit`);
CI installs them explicitly. `CEDAR_TEST_WORKERS` bounds parallel browser cases, defaulting to twelve
on local hosts with at least sixteen logical cores, up to four on smaller hosts, and two in CI.
One packaged JVM serves all workers through real MCP JSON-RPC and its real
session HTTP server; every case owns its sessions and browser contexts. A stale jar is refused.

The gate covers read-only templates and instances, editing and exact JSON-LD collection, replacement
submissions, refused-submission retry, simultaneous-session isolation, and bundle/session-data
failure and reload recovery in all three engines. It uses local fixtures and blocks external browser
requests. Browser JSON results, server logs and failure traces remain in `browser/reports/`.
This does not certify the MCP client's own UI, native Safari, mobile browsers, assistive technology,
or live terminology/authority providers. The unit suite additionally checks the server's configuration
keys against those CEE accepts. For the whole client experience, also open a form through the MCP
client and check rendering, submission and the browser console.

Measured on the 16-core macOS workstation on 2026-11-13: `mvn verify` passed 25 unit tests and four
packaged-server integration tests in 11.4 seconds. All 21 browser cases passed in 10.6 seconds with
four workers and 7.1 seconds with twelve. Five copies of the matrix passed all 105 cases in 26.0
seconds at twelve workers versus 28.4 seconds at eight; neither run retried or skipped a case, and
swap did not grow. These browser timings include JVM startup and teardown. The twelve-worker
stress run's peak one-minute load was 27.7, so worker count is a throughput budget, not a guarantee
that the host stays idle. CI retains its smaller allocation.

## Upgrading the CEE Bundle

`cedar-cee-mcp` serves the CEE web-component bundle out of its own jar. The build fetches the stable
public npm package and stages the bundle as a resource; a session then needs no network beyond the
terminology and bridge services the fields themselves call.

Two lines in `pom.xml` pin it:

```xml
<cee.version>2.0.30</cee.version>
<cee.sha256>87ec2da47f8efa70bd7d8b7fa8d05a8126ac807a21f878fd098607b0284ce3d6</cee.sha256>
```

The hash is the bundle's own, from the package's `bundle-manifest.json`, and the build refuses a
bundle that does not match. The hash also gives the same deployed-identity check that
[FRONTEND-RUNBOOK.md](./FRONTEND-RUNBOOK.md#cee) uses when a frontend looks wrong.

To bump: find the version the public `latest` dist-tag names, take its hash from the package's
`bundle-manifest.json`, change both lines, run the suite, and open a form in a browser with the
console visible.

```bash
curl -s https://registry.npmjs.org/cedar-embeddable-editor \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist-tags"])'
```

## Advancing the Session Page's Design Tokens

The session page that `cedar-cee-mcp` serves styles its bar, status line and Done button with the
shared CEDAR design tokens. The Maven build has no npm, and the token package exists only as
development builds on Nexus, which its cleanup removes. The compiled stylesheets the page links
are therefore vendored in `src/main/resources/web/vendor/cedar-design-tokens/`, beside a
`manifest.json` that names their version and each file's SHA-256 digest.

`cedarcli check design-tokens --repo mcp/cedar-cee-mcp --strict` treats the manifest as the pin. It
fails when a file no longer matches its digest, when the copy's `custom-properties.css` does not
declare the tokens held at the commit the version names, and when the page reads a token the pinned
version lacks. A pin that lags the token checkout does not fail. Advance it when the page needs a
newer token or when a value it reads has changed. To advance it, take the version the `dev`
dist-tag names, replace the vendored files from that tarball, and rewrite the manifest. The same
check fails when the page links the vendored stylesheets without `focus.css`, which draws the
shared focus ring.

```bash
cd $CEDAR_HOME/mcp/cedar-cee-mcp/src/main/resources/web/vendor/cedar-design-tokens
version=$(curl -s https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter%2fcedar-design-tokens \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist-tags"]["dev"])')
curl -sf "https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter/cedar-design-tokens/-/cedar-design-tokens-$version.tgz" \
  | tar -xzf - --strip-components=2 package/dist/custom-properties.css package/dist/focus.css \
      package/dist/secondary-action.css
python3 - "$version" <<'PY'
import hashlib, json, pathlib, sys
manifest = json.loads(pathlib.Path('manifest.json').read_text())
manifest['version'] = sys.argv[1]
manifest['files'] = {name: hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() for name in manifest['files']}
pathlib.Path('manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
```

Run the check and suite, [restart the server](#restart-after-rebuilds-or-configuration-changes),
and open a session with the console visible. A page that links another stylesheet must add it to the manifest, to
`CeeWebServer.TOKEN_STYLESHEETS` and to the page in one change; the unit suite fails while the three
disagree.

<a id="the-dependency-that-breaks-a-rebuild"></a>

## Dependency Conflicts

The MCP SDK validates tool schemas with `json-schema-validator` 3.x, and loads it at startup.
`cedar-artifact-library` brings 1.5.9, which Maven prefers as the nearer declaration, and which has
none of the classes the SDK wants: the server dies on its first `build()` with
`NoClassDefFoundError: com/networknt/schema/dialect/Dialects`.

`cedar-artifact-rest-mcp` and `cedar-cee-mcp` declare a 3.x release and are done with it.
`cedar-artifact-mcp` cannot: `CedarValidator`, from `cedar-model-validation-library`, calls
`com.networknt.schema.Format`, which 2.0.0 removed, and one classpath cannot hold both. It supplies
the MCP server its own validator built on the 1.x release already present, so the SDK never asks
for one. That validator does what the SDK's default does: it checks every tool's input schema
against JSON Schema 2020-12 when the server starts, and every call's arguments against that schema
before the handler runs.

The symptom to recognize: a jar that built cleanly and exits immediately on startup. Read the
server's stderr — the client hides it.

Jackson version conflicts can produce `NoClassDefFoundError: Could not initialize class
ObjectMapper`; inspect the first stack trace for the underlying `JacksonAnnotationIntrospector`
failure. Databind 2.22 needs `JsonSerializeAs`, absent from the annotations 3.0 release candidates.
Let `jackson-annotations` follow databind and match databind to `cedar-artifact-library`; do not
add an independent annotations pin. The SDK's Jackson 3 also accepts this line because
`JsonFormat.Shape.POJO` has existed since 2.20.

## What the Servers Write

`cedar-artifact-rest-mcp` is the only server that persists CEDAR artifacts. Its `delete_*` operations
are irreversible. Tool descriptions require human confirmation, but the server does not enforce it.

Identity belongs to CEDAR. Every identifier a stored artifact carries — its own, its children's, and
the property IRIs in its `@context` — is minted by the server on create, so nothing here invents one.
An artifact built in `cedar-artifact-mcp` names nothing until it is saved, which is why an instance
can only be built against a template that has been stored: `isBasedOn` has to name something real.
