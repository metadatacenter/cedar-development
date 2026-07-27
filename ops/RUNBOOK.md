# CEDAR Local Operations Runbook

Operational knowledge for running and managing a **local, native CEDAR** on macOS — written
to be read by a human or an LLM agent. It covers the architecture, the bring-up sequence, the
non-obvious gotchas that will otherwise cost hours, and the two helper scripts in this folder.

Scope: the **native-develop** setup (infrastructure as local binaries, microservices as native
Dropwizard JVMs, frontends via `gulp`). The all-Docker deployment is a separate path and is not
covered here.

Known backend work items, and the decisions about what is deliberately not being done, are tracked
in [ROADMAP.md](./ROADMAP.md).

## Architecture

Three tiers:

- **Infrastructure** — Keycloak (auth), MongoDB, MySQL, Neo4j, Redis, OpenSearch (search index),
  and nginx (TLS termination + reverse proxy for `*.metadatacenter.orgx`). In native-develop these
  run as **local binaries / Homebrew services**, not Docker containers.
- **Microservices** — 15 Dropwizard JVMs, one per `cedar-<name>-server` repo. Each is launched as
  `java -jar cedar-<name>-server-application-<version>.jar server .../config.yml`.
- **Frontends** — the main one is the Angular template editor (`cedar-template-editor`), served by
  `gulp` on port 4200 and proxied by nginx to `https://cedar.metadatacenter.orgx`. Auxiliary UIs
  (openview, monitoring, bridging, artifacts, content) exist but are not needed for login.

## Environment: two things that must be right first

**1. Source the profile with `CEDAR_HOME` already exported.** The profile reads `CEDAR_HOME`; if it
is unset when you source, key variables come out empty.

```bash
export CEDAR_HOME=/Users/martin/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh    # ~191 CEDAR_* vars, CEDAR_HOST=metadatacenter.orgx
```

**2. `JAVA_HOME` must be JDK 17.** CEDAR services and Keycloak require Java 17. The machine's default
`java` is newer (23/25) and **Keycloak crashes on it** (`Failed to start caches … getSubject is
supported only if a security manager is allowed` — the SecurityManager was disabled in JDK 18+).

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

Your `~/.zshrc` already pins Java 17; your `~/.bashrc` pins 21 — **use the zsh shell**, or the
Keycloak/services will fail the same way. The helper scripts here force Java 17 themselves.

## Bring-up sequence

```bash
# 0. one-time (only needed for the Docker cert volumes / network; harmless to skip in pure native)
cedarcli docker one-time-setup

# 1. infrastructure (local binaries + Homebrew services)
bash $CEDAR_UTIL_BIN/services-generic/startinfra.sh     # mongo, mysql, opensearch, neo4j, redis, keycloak, nginx

# 2. app tier — use the controller here instead of 15 Terminal tabs
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh status

# 3. log in
open https://cedar.metadatacenter.orgx    # test1@test.com / test1   (also test2@test.com / test2)

# 4. optional: prove the stack end to end (login, folder + template round-trip; ~30 s)
(cd ops/e2e && npm run smoke)
```

`cedarcli start all` does the same thing but opens ~15 Terminal tabs (one foreground process per
tab, by design — see below). The controller replaces that with background processes + one status view.

## The controller: `ops/cedar-services.sh`

Manages the 15 microservices + the main frontend (`gulp`) + the 5 auxiliary Angular frontends as
background (`nohup`) processes, each logging to `$CEDAR_HOME/log/`, PIDs tracked in
`$CEDAR_HOME/log/run/`. It forces `JAVA_HOME=17`, puts `/opt/homebrew/bin` on `PATH` (for `node`/`ng`),
and sources the profile itself, so it is safe to run standalone.

The auxiliary frontends are the `ui-*` entries — `ui-openview` (4220), `ui-content` (4240),
`ui-monitoring` (4300), `ui-artifacts` (4320), `ui-bridging` (4340) — each run as `ng serve` from its
`cedar-<name>[-src]` source dir (see `fe_dir()`). They are named `ui-*` because `openview`/`monitor`/
`bridge` are already microservice names. Their health is **port-only** (no Dropwizard `/healthcheck`).
`cedarcli start frontends` starts the same set but opens a macOS Terminal tab per app; this controller
runs them headless instead. The non-essential CEE demos (`cee-dev`/`demo.cee`/`docs.cee`) are not
managed here — `cedarcli` doesn't start them by default either.

```bash
cedar-services.sh start [name...]     # start all, or only the named services
cedar-services.sh stop  [name...]
cedar-services.sh restart [name...]
cedar-services.sh status              # one-shot table: PID / port / health / error-count
cedar-services.sh watch               # auto-refreshing status
cedar-services.sh logs <name>         # tail -f a service log
cedar-services.sh health              # exit 0 only if every service is healthy (for scripts)
```

It **skips services already listening on their port** (so it won't collide with ones you started in
tabs) and **reports any service whose jar isn't built**. Health uses the Dropwizard admin
`/healthcheck` endpoint (200 = healthy, 500 = unhealthy).

## Why the app tier is "tab-per-service" by design

`cedarcli start microservices` runs `start-dw-server.sh <name>` for each service, and that script
runs `java -jar … server config.yml` in the **foreground** (no `nohup`, no `&`). The intended UX is
one Terminal tab per service so a developer can watch/restart each. That does not scale to eyeballing
15 consoles — which is exactly why `cedar-services.sh` exists (background + single status view).

## Port map

| Service | app | admin | | Service | app | admin |
|---|---|---|---|---|---|---|
| artifact | 9001 | 9101 | | submission | 9010 | 9110 |
| repo | 9002 | 9102 | | worker | 9011 | 9111 |
| schema | 9003 | 9103 | | messaging | 9012 | 9112 |
| terminology | 9004 | 9104 | | openview | 9013 | 9113 |
| user | 9005 | 9105 | | monitor | 9014 | 9114 |
| valuerecommender | 9006 | 9106 | | bridge | 9015 | 9115 |
| resource | 9007 | 9107 | | | | |
| group | 9009 | 9109 | | frontend (gulp) | 4200 | — |
| impex | 9008 | 9108 | | Keycloak | 8080 / 8443 (https) | |

Admin port = app port + 100; health check at `http://127.0.0.1:<admin>/healthcheck`.

Auxiliary frontends (Angular `ng serve`, port-only health): `ui-openview` 4220, `ui-content` 4240,
`ui-monitoring` 4300, `ui-artifacts` 4320, `ui-bridging` 4340. Non-essential CEE demos (not started by
default): `demo.cee` 4260, `docs.cee` 4280, `cee-dev` 4400.

## Known gotchas and fixes (the expensive ones)

- **Browser blocks login with a cert error, but `curl` works** → the local TLS **leaf certs
  expired**. The `*.metadatacenter.orgx` sites are served by nginx with self-signed leaves issued by
  the CEDAR CA. The CA lives in `$CEDAR_CA_HOME` (`/Users/martin/CEDAR/CEDAR_CA`), is valid ~10 years,
  and is already trusted in your login keychain — but the **leaves last only ~824 days** and Chrome
  hard-blocks an expired cert (won't even offer "proceed"). `curl -sk https://cedar.metadatacenter.orgx/`
  still returns 200 because `-k` ignores expiry, which is the tell. Diagnose:

  ```bash
  echo | openssl s_client -connect cedar.metadatacenter.orgx:443 -servername cedar.metadatacenter.orgx 2>/dev/null \
    | openssl x509 -noout -dates
  ```
  Fix — re-issue every subdomain leaf from the existing CA and reload nginx (do **not** regenerate the
  CA itself: `cert ca` would force re-adding it to the keychain; only the leaves expire):

  ```bash
  export CEDAR_HOME=/Users/martin/CEDAR
  source $CEDAR_HOME/cedar-profile-native-develop.sh          # sets CEDAR_CA_HOME, CEDAR_CA_PASSWORD, CEDAR_CA_*
  SSL=/opt/homebrew/etc/nginx/cedar/ssl
  cp -r "$SSL" /tmp/cedar-ssl-backup                          # optional but wise (reversible)
  : > "$CEDAR_CA_HOME/index.txt"; mkdir -p "$CEDAR_CA_HOME/newcerts"   # reset issued-cert DB so openssl re-issues same subjects
  $CEDAR_HOME/cedar-cli/.venv/bin/python $CEDAR_HOME/cedar-cli/cedar.py cert domains   # re-sign all leaves (SAN preserved, 824 days)
  for d in "$CEDAR_CA_HOME"/certs/*/; do sub=$(basename "$d"); tgt="$SSL/$sub"; [ -d "$tgt" ] || continue;
    crt=$(ls "$d"*.crt | head -1); cp "$crt" "${crt%.crt}.key" "$tgt/"; done   # install into nginx ssl dirs
  sudo nginx -s reload                                        # nginx master runs as root → needs sudo
  ```
  Notes: `cedar cert domains` writes leaves to `$CEDAR_CA_HOME/certs/<subdomain>/`, but nginx reads from
  `$SSL/<subdomain>/` — hence the copy step. The subdomain dir names match on both sides. Skipping the
  `index.txt` reset makes `openssl ca` fail with "There is already a certificate for …". The reload is
  the only step that needs your password (the master is a root process; there is no passwordless sudo).

- **Keycloak won't start** → wrong JDK. Pin `JAVA_HOME` to 17 (see above). Symptom: `Failed to start
  caches … getSubject is supported only if a security manager is allowed`.

- **OpenSearch (Homebrew) stuck in `error`, port 9200 closed** → Homebrew upgraded its `openjdk` to
  25, which OpenSearch 2.19 cannot run on (`JvmErgonomics` parse failure, `jdk.incubator.vector`
  warning). Fix — point OpenSearch at JDK 17 in the launchd environment `brew services` inherits:

  ```bash
  launchctl setenv OPENSEARCH_JAVA_HOME "$(/usr/libexec/java_home -v 17)"
  brew services restart opensearch
  # verify: nc -z 127.0.0.1 9200 && curl -s localhost:9200/_cluster/health
  ```
  `opensearch-env` checks `OPENSEARCH_JAVA_HOME` before `JAVA_HOME`. `launchctl setenv` lasts the
  login session; for permanence add it to a login item (editing the brew plist won't stick — brew
  regenerates it).

- **Profile vars empty** → you sourced `cedar-profile-native-develop.sh` before exporting
  `CEDAR_HOME`. Export it first.

- **A microservice shows `down` in status with no jar** → that server was never built. Build it:
  ```bash
  mvn -o -f $CEDAR_HOME/cedar-<name>-server/pom.xml install -DskipTests   # -o = offline; drop it if a dep is missing
  # or: cedarcli build (see cedar-cli)
  ```
  (Seen unbuilt in this environment: schema, repo, submission, valuerecommender, openview, monitor.)
  `schema` is needed for template operations; `resource`/`user`/`artifact`/`terminology`/`group` are
  the core for login + workspace.

- **A service starts then dies with `no main manifest attribute, in …-application.jar`** → the jar is
  a thin jar (built without the shade/assembly step), so it has no runnable `Main-Class`. Rebuild that
  one server to produce the fat jar, then restart it:
  ```bash
  mvn -o -f $CEDAR_HOME/cedar-<name>-server/pom.xml install -DskipTests
  bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start <name>
  ```
  (Seen on `repo` in this environment.) Different from the case above: the jar exists, it just isn't
  a runnable artifact.

- **A Maven build "succeeds" but a later step behaves as if code never changed** → the build was
  piped through `head` or `grep -m`. When the reader closes early, the writing `mvn` takes SIGPIPE
  and can die mid-reactor while the shell still reports a clean exit. Never pipe `mvn` through a
  reader that can exit early. Redirect the full output to a file and grep the file afterward.

- **A test fails with `Failed to bind to 0.0.0.0:90xx` while the dev stack is up** → that test boots
  its server on a real dev port instead of the alternate `19xxx` test range. Every booted test must
  redirect its ports through `CedarEnvironmentSource.setOverride(...)` to the `19xxx` range (test
  port = dev port + 10000), so a running dev stack and a test run never collide. Give the offending
  test the same static-block redirect the other servers' tests use.

- **`UnitOfWorkAwareProxyFactory` or other startup code fails only in a non-interactive shell** →
  that shell did not pin `JAVA_HOME` to 17 (the zsh pin is interactive-only), so the build or run
  used the machine default JDK 23/25. Export `JAVA_HOME=$(/usr/libexec/java_home -v 17)` explicitly
  in scripts and background commands. The helper scripts here already do this.

- **A server rebuilt against a stale `cedar-parent` misbehaves subtly** (for example an unshaded jar
  with no `Main-Class`, or an old managed dependency version) → `cedar-parent` was not installed
  before the server was built. Always build in dependency order: `cedar-parent` first, then
  `cedar-microservice-libraries`, then the servers. `cedarcli build java` does this for you.

- **The bridge server reads `UNHEALTHY` for a minute or two after start, then goes healthy** →
  normal. Its real `CompTox` health check reports "registry not loaded yet" during an asynchronous
  warm-up. Wait for `curl -sk http://localhost:9115/healthcheck` to show `"comp-tox":{"healthy":true`.

## cedarcli (headless invocation)

`cedarcli` is a shell alias (`source $CEDAR_HOME/cedar-cli/cli.sh`) that activates a venv and runs
`cedar.py`. To drive it non-interactively (no alias):

```bash
export CEDAR_HOME=/Users/martin/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh >/dev/null 2>&1
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
$CEDAR_HOME/cedar-cli/.venv/bin/python $CEDAR_HOME/cedar-cli/cedar.py <command>
```

Command groups: `docker` (one-time-setup / start / stop), `start` (all/infra/microservices/frontends),
`stop`, `build`, `deploy`, `status`, `check`, `cert`, `dev`. On macOS `start` uses AppleScript to open
Terminal tabs (`use_osa = platform.system()=='Darwin'`), which is why headless bring-up uses the
underlying `services-generic/*.sh` scripts or `cedar-services.sh` instead.

## Building CEDAR

`cedarcli build java` is the authoritative full build. It compiles and installs the whole Java
stack in dependency order: `cedar-parent`, then `cedar-microservice-libraries`, then the fifteen
servers. Inside a single repo, `cedarcli build this` builds just that repo. Both need the profile
sourced and `JAVA_HOME` pinned to 17.

Order is not optional. A server compiled against a stale `cedar-parent` picks up the parent's old
managed versions and plugin configuration, which fails silently rather than loudly (see the
stale-parent gotcha above). When bumping a dependency or changing shared build configuration, always
install `cedar-parent` first, then the libraries, then rebuild consumers.

When invoking Maven directly, never pipe its output through a reader that can close early (`head`,
`grep -m`). A closing reader sends SIGPIPE to `mvn`, which can end the reactor early while the shell
reports success. Redirect the full log to a file and grep the file.

Packaging is centrally managed. The shade plugin configuration lives once in `cedar-parent`'s
`pluginManagement` as the `cedar-shade` execution, guarded by the `cedar.shade.phase` property
("none" by default). A server opts in by setting two properties in its application pom:

```xml
<cedar.shade.phase>package</cedar.shade.phase>
<cedar.shade.main.class>org.metadatacenter.cedar.<name>.<Name>ServerApplication</cedar.shade.main.class>
```

A packaging change is therefore a one-line edit in `cedar-parent`, not fifteen edits. To verify a
shaded jar is sound: it holds exactly one merged `META-INF/.../Log4j2Plugins.dat` (~22 KB, not the
~700-byte single-artifact version), a `Main-Class` in its manifest, and `java -jar <jar>` boots with
no `StatusLogger` "Unrecognized format specifier" errors.

## Testing CEDAR

Every server's test suite runs backend-free: no live Keycloak, Neo4j, Mongo, MySQL, or Redis. The
shared `cedar-microservice-libraries/cedar-test-support-library` supplies in-memory authentication
(`TestAuthUtil` / `InMemoryUserService`, exercising the real API-key path) and embedded backends
(in-process Neo4j via neo4j-harness, Mongo via Flapdoodle, MariaDB via MariaDB4j standing in for
MySQL). Two suites still need something external: terminology's BioPortal resource tests hit live
BioPortal (they are disabled or fail without a key), and the bridge server's DataCite and CompTox
tests need the live stack.

Test servers boot on the alternate `19xxx` port range (test port = dev port + 10000), so a running
dev stack and a test run coexist. Redirection goes through `CedarEnvironmentSource.setOverride(map)`,
a process-global test override read by the whole config layer. This replaced an earlier reflection
hack (`TestUtil.setEnv`, now deleted) that rewrote the real process environment and failed silently
without `--add-opens` flags. Because `CedarConfig` is injectable and rebuilds when the override
changes, surefire runs `reuseForks=true` (test classes share a JVM) with no `--add-opens` argLine.

The suites are JUnit 5. Booted-application tests use `io.dropwizard.testing.DropwizardTestSupport`
started in a static `@BeforeAll` and stopped in `@AfterAll`. Do not use the JUnit 5
`DropwizardAppExtension`: its version bundled with Dropwizard 2.1 is binary-incompatible with the
current JUnit platform.

Rough suite sizes: artifact 1279 (parameterized CRUD over four artifact types on embedded Mongo),
artifact-library 687, model-validation 210, terminology ~130 (13 need live BioPortal), resource 49,
microservice-libraries 19 (the workspace-graph and lifecycle tests), group 10, and a
two-to-three-test boot-and-config tier on the thin servers. Known exceptions: the submission server's
suite hangs at teardown (its NCBI queue enqueues a stop message to Redis on shutdown), so package it
with `-DskipTests`.

### What the suites actually cover

Roughly 113 test classes. They fall into layers, and it is worth knowing which layer a failure comes
from, because they answer very different questions:

| Layer | Classes | What a pass means |
|---|---|---|
| Config load | 16 | The server's YAML parses and env substitution resolves |
| Boot smoke | 11 | The application starts |
| Route surface | 7 | Every declared route answers, and answers 401 unauthenticated |
| Model validation | 7 | Template, element, field and instance schema rules hold |
| Artifact CRUD | 21 | Create, read, update, delete per artifact type, on embedded Mongo |
| Workspace graph | 5 | Permissions, inheritance, moves, categories and revocation, in Neo4j |
| Matrices | 7 | Authorization, permission levels and artifact lifecycle, as tables |
| Sharing and ownership | 1 | The `PUT .../permissions` round trip, including ownership transfer |
| Content negotiation | 2 | YAML and JSON transcode both ways |
| REST smoke | 1 | The real stack, no browser: the proxy, versioning, sharing, indexing |
| End-to-end smoke | 1 | The real stack, through a browser |

`ops/e2e` holds the two whole-stack tests, and they answer different questions. `npm run smoke:rest`
drives the REST API directly, in about a second, and reaches what no unit suite can: the artifact write
path (which proxies, so the per-service suites cannot follow it), publish and create-draft, whether the
graph and the artifact server agree, sharing as two real users, and search-index propagation. It
authenticates through Keycloak's password grant using the credentials already in the profile, so there
are no API keys to keep. `npm run smoke` drives the same stack through a browser and is the only thing
that covers the editor — but it is bound to AngularJS markup, so it is the more brittle of the two and
the one that will not survive a frontend replacement. Prefer adding to the REST smoke.

Two reusable helpers live in `cedar-test-support-library` and are the right starting point for new
work. `RouteSurface` reflects over a server's JAX-RS classes and asserts every route answers a given
status, honouring `@Consumes` so a probe reaches the auth check instead of being rejected during
content negotiation; it refuses to pass vacuously on an empty route list. `PermissionMatrix` states,
as a table, the status each actor must receive for each operation, collects every failing cell rather
than stopping at the first, and fails on an empty table.

Where the coverage is thin, stated plainly so nobody reads the class count as reassurance:

- **Terminology's REST surface is largely untested.** Of its 27 classes, six are `@Tag("bioportal")`
  and 26 methods are `@Disabled`, so a normal run exercises little of it. Serving ontologies from the
  local SQLite store is what would let those tests run offline and deterministically, which makes it
  the largest single coverage win available.
- **The thin servers have three classes each** — config, boot, routes. That is a real net, and it is
  what caught the media-type 505, but it means "starts and refuses strangers", not "is correct".
- **Nothing covers** dependency failure (see the degradation item on the roadmap), pagination across
  the thirty-one endpoints that declare it, the proxy boundary between services, or concurrent edits.

One hard constraint when adding to the resource server: **eight test classes that boot a server is the
ceiling** for that module. Each boots into the shared JVM and creates a Neo4j driver whose Netty
event-loop threads are never reclaimed, and the ninth fails with "failed to create a child event
loop". The failure appears only in a full run, never when the class runs alone, and it names whichever
class happened to boot last rather than the one that exhausted the JVM — so it reads as a flaky new
test. Merge into an existing class, or take up the roadmap item that fixes it properly.

The verification discipline that matters: **the suites verify logic; a redeploy plus the `ops/e2e`
smoke test verifies reality.** The suites cannot see the live inter-service proxy round-trip or the
real validation path. Two dependency migrations this stack went through (Apache HttpClient 4 to 5,
and the JSON Schema validator swap) passed every suite yet had real runtime defects that only a
redeploy and smoke run caught. After any change touching inter-service HTTP, validation, or startup
wiring: rebuild, redeploy, and run `ops/e2e` before trusting green suites.

The full gate, in order:

```bash
cedarcli build java                                                # authoritative full build
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh restart    # ALL 21 — pass no names
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh health     # exit 0 only if all healthy
cd $CEDAR_HOME/cedar-development/ops/e2e && npm run smoke
```

Pass `restart` no service names. With no arguments it restarts everything the script manages,
which includes the gulp frontend and the five `ui-*` frontends, not only the 15 Dropwizard
services. Naming services explicitly narrows that and is easy to get wrong: a list of the Java
services alone leaves the frontend running whatever it started with, so the gate cannot catch a
frontend regression at all. Gate on `health` rather than reading the status table, and expect it to
take a couple of minutes — the bridge server reports unhealthy until its CompTox registry finishes
loading, which is normal and not a fault.

## Dependency and Framework State

Two things are locked and must not move: **Java 17**, and the **persistence and infrastructure
server versions** (Mongo, MySQL, Neo4j, Redis, OpenSearch, Keycloak). Client libraries that talk to
those servers may move; the servers themselves may not.

Current framework baseline (all jakarta-namespace, all on Java 17): Dropwizard 4.0.17, Jetty
11.0.26, Jersey 3.0.18, Hibernate 6.1.7, jackson 2.17. Recently modernized client libraries: jedis
5.2, Apache HttpClient 5 (the exceptions are the OpenSearch low-level REST client and the Keycloak
event listener, which stay on HttpClient 4 because those external APIs require v4 types), slf4j 2.0
with logback 1.5, swagger-core v3 (OpenAPI 3), mysql-connector-j 8.4, log4j 2.24, commons-lang3.

JSON Schema validation uses the maintained networknt validator, not the abandoned java-json-tools
(FGE) fork. networknt's built-in `uri` and `date-time` formats are stricter than FGE's and would
reject valid CEDAR data (relative `@id` references, colon-less timezone offsets), so
`cedar-model-validation-library`'s `FgeCompatFormats` registers FGE-equivalent format checkers on the
Draft-04 meta-schema to preserve the exact accept boundary. The java-json-tools (FGE) fork is
otherwise fully removed — no module depends on it.

The **jakarta namespace migration (Dropwizard 4) is complete.** It runs on Java 17 (Dropwizard
4.0.17, Jetty 11, Jersey 3.0, Hibernate 6). `dropwizard-sundial` had no Dropwizard 4 release, so it
was retired rather than forked: the worker and valuerecommender schedulers are now plain `Managed`
poll loops. The namespace flip was mechanical; the four risk points all landed — the Jetty CORS
filter, the reflective `@Context`-injection feature, the Hibernate 6 data layer (its `AUTO` id
generation changed, so `@GeneratedValue` columns moved to `IDENTITY` on `AUTO_INCREMENT` tables), and
`commons-fileupload` to its jakarta successor `commons-fileupload2`.

## `ops/cedar_ontology_usage.py`

Inventories which ontologies CEDAR templates + elements reference, by walking their
`_valueConstraints` (ontologies / branches / class sources / value-set collections) via the resource
server API. Run-time API key (never hard-coded), partial-safe (streams CSV, always prints a ranked
aggregate even on Ctrl-C):

```bash
export CEDAR_API_KEY=…                                  # read-scoped key is enough
python3 ops/cedar_ontology_usage.py --out usage.csv     # templates + elements
python3 ops/cedar_ontology_usage.py --limit 50          # quick sample
```

Caveat: `/search` is permission-scoped, so it inventories what the key can see. For a complete,
instance-wide picture a MongoDB aggregate over the template collection's `_valueConstraints` is faster.

## End-to-End Smoke Test: `ops/e2e`

One command that proves the whole stack works from the outside, the way a user would exercise it:
a Playwright script logs in through the real Keycloak form as test user 1, creates a folder on the
dashboard, creates a template inside it, then deletes both, verifying each step. Pass = exit 0;
a failure leaves a screenshot in `ops/e2e/failures/`.

```bash
cd ops/e2e
npm install            # once per machine
npm run smoke          # headless, ~30 s
npm run smoke:headed   # watch it in a real browser
```

Needs the app tier up (frontend, resource, user, group, artifact at least — `cedar-services.sh
status`). Credentials and base URL come from the profile environment, with the local-dev values
as fallbacks. The UI gestures reuse the selectors verified by the tutorial runner, which now lives
in `cedar-mkdocs/runner` (`cedar-tutorial` is abandoned and its copy is stale).

Two gestures retry, and it is worth knowing what each retry is actually for, because both were
misdiagnosed for a long time and the wrong explanations cost hours.

**Deleting a row.** The sweetalert confirmation binds its click handler as the dialog animates in,
and Playwright clicks as soon as the button is visible, stable and enabled — none of which implies
a handler is attached. The click was being swallowed and the delete never issued. `confirmDelete`
settles before clicking, which fixed it. `deleteRow` also waits for the `DELETE` response rather
than watching the listing, so the three outcomes stay distinct: no request means the gesture never
reached the server and is worth retrying, a non-2xx fails immediately, and a 2xx means the delete
happened so a listing that stays stale is index lag rather than a failed delete. This step used to
fail about a third of runs and was long blamed on the search index lagging the delete; the request
simply was not being sent. If it starts burning retries again, check the Dropwizard access log for a
`DELETE` before suspecting the backend.

**Constraining a field to a DOID branch.** The whole create-template-and-constrain block retries as
a unit, each attempt starting from the designer deep link, because only a page load helps: the
editor loads BioPortal's ontology list once per page and latches an empty cache when that load
fails, so re-running the ontology *search* re-reads the same empty cache and can never succeed. The
underlying frontend defect is unfixed and on the [roadmap](./ROADMAP.md); the retry tolerates it
rather than curing it.

## Login

`https://cedar.metadatacenter.orgx` — seeded test users: `test1@test.com` / `test1`,
`test2@test.com` / `test2`. `/etc/hosts` must map the `*.metadatacenter.orgx` names to localhost
(already configured on this machine).
