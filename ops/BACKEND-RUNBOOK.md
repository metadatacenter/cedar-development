# CEDAR Backend Runbook

Operational knowledge for running and managing a **local, native CEDAR** on macOS — written
to be read by a human or an LLM agent. It covers the architecture, the bring-up sequence, the
non-obvious gotchas that will otherwise cost hours, and the two helper scripts in this folder.

Scope: the **native-develop** setup (infrastructure as local binaries, microservices as native
Dropwizard JVMs, frontends via `gulp`). The all-Docker deployment is a separate path and is not
covered here.

Known backend work items, and the decisions about what is deliberately not being done, are tracked
in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

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
export CEDAR_HOME=$HOME/CEDAR
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
cedar-services.sh status              # one-shot table: PID / port / health / binary / error-count
cedar-services.sh watch               # auto-refreshing status
cedar-services.sh logs <name>         # tail -f a service log
cedar-services.sh health              # exit 0 only if every service is healthy (for scripts)
```

It **skips services already listening on their port** (so it won't collide with ones you started in
tabs) and **reports any service whose jar isn't built**. Health uses the Dropwizard admin
`/healthcheck` endpoint (200 = healthy, 500 = unhealthy).

Two columns exist so a green table cannot hide a stale one. **BINARY** compares when a process started
against when its jar was written: `STALE` means the service is serving a jar older than the build, so
its health says nothing about your latest code. **PID** shows `~pid` (a leading tilde) for a process
listening on the port that this script does not own — one started in a tab or left over from a previous
session, with no pidfile. Both were added after a real miss: the group and messaging servers ran a
two-day-old jar for a full session while `status` reported them healthy, because `stop` only ever
consulted the pidfile and so skipped them, and `restart` therefore left them up. `stop` now **adopts**
a tilde process — kills whoever actually holds the port — so a plain `restart` brings even a
tab-started service onto the current build. When either warning prints, `restart` clears it. Always
confirm `status` shows every service `current`, not merely `healthy`, before trusting a verification
gate.

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

## YAML is a native artifact format

YAML is a first-class CEDAR representation, not a side format you convert to. Both the resource
server and the artifact server negotiate it on the wire, so reading and writing artifacts as YAML
needs no conversion step: ask for it with `Accept`, send it with `Content-Type`. Two media types
are recognized, `application/yaml` (RFC 9512) and `application/x-yaml`. JSON stays the default when
`Accept` is absent or a wildcard, and an `Accept` naming neither yields `406`.

All four artifact types accept it — `/templates`, `/template-elements`, `/template-fields`,
`/template-instances` — on `GET`, `POST`, and `PUT`, plus `/{id}/download` on the resource server.
Both servers share one implementation, `ArtifactYamlTranscoder` in `cedar-server-rest-library`.

```bash
ID='https%3A%2F%2Frepo.metadatacenter.orgx%2Ftemplates%2F<uuid>'
curl -sk -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" -H 'Accept: application/yaml' \
  "https://resource.metadatacenter.orgx/templates/$ID" -o t.yaml
curl -sk -X PUT -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" -H 'Content-Type: application/yaml' \
  --data-binary @t.yaml "https://resource.metadatacenter.orgx/templates/$ID"
```

Authoring a new artifact needs no id and no provenance — the minimal form is enough, and the server
supplies the rest:

```bash
printf 'type: template\nname: Minimal\n' | curl -sk -X POST -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" \
  -H 'Content-Type: application/yaml' -H 'Accept: application/yaml' --data-binary @- \
  "https://resource.metadatacenter.orgx/templates?folder_id=<encoded-folder-id>"
```

Two things to know before relying on it:

- **`?compact=true` is read-only.** It returns the lean form — on a 23-field template, 40% of the
  full YAML and under a seventh of the JSON — by dropping provenance, version, and status. Writing
  it back is rejected with a `400` naming the compact form. Write the full form, or omit `id` to
  author minimally.
- **A template instance takes `?format=` ahead of `Accept`.** That parameter already names the
  representation (`jsonld`, `json`, `rdf-nquad`), so YAML negotiation applies only when it is absent.

Storage stays JSON on both servers: YAML is a request and response representation, transcoded per
request, never a stored form.

A YAML round trip is expected to be lossless. The case that historically was not is the `_ui._size`
box on `static-image` and `static-youtube-video` fields: the YAML serialization carries it in the
child's `configuration:` block, and a reader that looked only at the field level dropped it on every
nested static field. `YamlAsymmetryProbeTest` in `cedar-artifact-library` and `YamlNegotiationTest`
in `cedar-artifact-server` both pin it. If a round trip ever loses a setting again, add a probe there
rather than documenting the loss.

## Known gotchas and fixes (the expensive ones)

- **Browser blocks login with a cert error, but `curl` works** → the local TLS **leaf certs
  expired**. The `*.metadatacenter.orgx` sites are served by nginx with self-signed leaves issued by
  the CEDAR CA. The CA lives in `$CEDAR_CA_HOME` (`$HOME/CEDAR/CEDAR_CA`), is valid ~10 years,
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
  export CEDAR_HOME=$HOME/CEDAR
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

- **A build seems to "take forever" for a task that should finish in seconds** → suspect the monitor,
  not the build. First estimate the real cost — a single-module or few-module `install -DskipTests`
  is seconds; only the full ~70-module reactor is minutes — then check the actual state directly (the
  target jar's mtime, `pgrep` for the real `mvn`/`java`) rather than waiting on a loop. Two traps that
  make a finished build look stuck forever: `mvn -q` suppresses the `BUILD SUCCESS`/reactor-summary
  line, so any `until grep "BUILD SUCCESS"` wait can never fire (don't use `-q`; redirect full output
  to a file); and a `pgrep -f` for the build often matches your own wait-loop's command line, so the
  loop sees "still running" and waits on itself. When a wait outlives the estimate by an order of
  magnitude, verify the underlying artifact — do not keep waiting.

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

- **PFAS lookups return `503` and the bridge's `comp-tox` health message says the registry is not
  loaded** → the EPA CTX API is unreachable, and there is nothing to fix locally. The registry loads
  asynchronously from `https://comptox.epa.gov/ctx-api/`, and the loader retries forever with
  exponential backoff up to ten minutes. Confirm it is upstream with the same call the server makes:

  ```bash
  curl -sS -D- -o /dev/null -H 'Accept: application/json' -H "x-api-key: $CEDAR_COMP_TOX_API_KEY" 'https://comptox.epa.gov/ctx-api/chemical/list/chemicals/search/by-listname/PFASSTRUCTV5'
  ```
  An Apache `503 Service Unavailable` in `text/html` is EPA's load balancer with no backend — their
  whole data plane, not just this list, while `https://comptox.epa.gov/ctx-api/docs/chemical.json`
  keeps serving. The API itself has not moved: that spec still declares this exact path, the
  `x-api-key` header, and `https://comptox.epa.gov/ctx-api` as its server.

  The bridge **stays healthy** throughout, deliberately. CompTox is one of its eight resources, the
  other seven are unaffected, and the two PFAS endpoints already answer `503` with a `Retry-After`
  derived from the loader's next attempt — so nothing is hidden. The condition is reported in the
  health *message* instead, which names the attempt count and last error:

  ```bash
  curl -sk http://localhost:9115/healthcheck | python3 -c 'import sys,json;print(json.load(sys.stdin)["comp-tox"]["message"])'
  ```
  This used to fail the check, which meant an EPA outage made `cedar-services.sh health` exit
  non-zero and blocked the full gate below on a third party. A health check answers "should traffic
  reach this instance", and for a dependency the loader will retry forever the answer is yes.
  (`TerminologyServerHealthCheck` is right to do the opposite: the ontology catalogue is that
  server's entire job, and its degraded mode silently served a partial catalogue.)

- **The whole stack is green, but real requests 500 — often with `NoClassDefFoundError`** → a backend
  service is **`STALE`**: running a jar older than the one on disk, and that jar can be a *broken* build,
  not merely old code. A parallel session or an interrupted `restart` can start a service from a
  half-written or unshaded jar — one whose shade dropped a class, say Guava's
  `com.google.common.cache.RemovalCause` — and it boots and passes `/healthcheck`, then throws on the
  first request that needs the missing class (seen as a 500 on `GET /folders`, which breaks the whole
  dashboard). `health` cannot catch this: a stale service is still healthy. So **confirm no backend
  service is stale before trusting the stack for anything**, not only after your own redeploy — another
  session may have restarted it under you, which is exactly how this happened. The check is one line:

  ```bash
  bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh status | grep -q STALE \
    && echo "a backend service is STALE — restart it" || echo "all backend services current"
  ```
  Restart the offender by name so it loads the current jar, and re-check that its **BINARY** column
  reads `current`:
  ```bash
  bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh restart <name>
  ```
  If you suspect the *current* jar is itself a partial build, confirm it is a sound fat jar before
  restarting into it: `unzip -l <app>.jar | grep -c RemovalCause` should be non-zero, and the jar
  should be ~130 MB, not a few MB (a thin jar has no `Main-Class` and dies at start instead — a
  different, louder failure covered above).

## cedarcli (headless invocation)

`cedarcli` is a shell alias (`source $CEDAR_HOME/cedar-cli/cli.sh`) that activates a venv and runs
`cedar.py`. To drive it non-interactively (no alias):

```bash
export CEDAR_HOME=$HOME/CEDAR
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
MySQL). Nor does any suite need an external service. The tests that do call one are tagged and
excluded from the default build by their application POM: terminology excludes `bioportal` (61 tests
across six resource classes) and bridge excludes `datacite` (`DataCiteResourceTest`). Clear the
exclusion with `-DexcludedGroups=` to run them against the real service. Their CEDAR variables must
still be set even when the tests are excluded, because the configuration substitutes them as it
loads; a placeholder value is enough.

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
microservice-libraries 810 over seven modules (server-rest 249, workspace-operations 182,
search-operations 178), artifact-library 800, terminology 246 (61 more excluded under `bioportal`),
model-validation 216, resource 78, cadsr-tools 70, core-library 56, user 11, group 10, and a
one-to-seven-test boot-and-config tier on the remaining thin servers.

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
| REST smoke | 1 | The real stack, no browser: 15 suites, ~350 checks |
| End-to-end smoke | 1 | The real stack, through a browser |

`ops/e2e` holds the two whole-stack tests, and they answer different questions. `npm run smoke:rest`
drives the REST API directly, in about twenty seconds, and reaches what no unit suite can: the artifact
write path (which proxies, so the per-service suites cannot follow it), publish and create-draft,
whether the graph and the artifact server agree, and the things a real running stack does that an
embedded one cannot. It authenticates through Keycloak's password grant using the credentials already
in the profile, so there are no API keys to keep. Run one suite with `npm run smoke:rest -- <name>`;
the suites are `folders`, `artifacts`, `versioning`, `groups`, `sharing`, `group-sharing`, `openness`,
`categories`, `validation`, `search`, `finding`, `authentication`, `pagination`, `negotiation` and
`download` (JSON / YAML / compact-YAML export and read-negotiation across all four artifact kinds).

Four of them are where the running stack earns its keep, because each pins a defect an embedded suite
could not see:

- **`group-sharing` and `openness`** hold apart the two things "public" can mean. Sharing with
  *everybody* widens a grant to every account and still demands a login; making something *open* lets
  an anonymous caller read it through the OpenView server, no login at all. The suites assert both, and
  assert that neither leaks into the other.
- **`finding`** is the search story, and it is careful because indexing is asynchronous: every negative
  is asserted only after the matching positive has been observed. It is where the graph-versus-index
  split shows — a grant reaches every graph-backed view at once but never reaches term search.
- **`authentication`** is an audit of how credentials are treated, and it is the regression guard for
  the token-signature fix: it forges tokens (from nothing but a public user id, and by altering one
  character of a real token's signature) and asserts every one is refused while a genuine token still
  works. It writes only to throwaway folders on purpose — that discipline dates from when forged writes
  actually succeeded, and an earlier version aimed a permission change at a home folder and reassigned
  it for real.

Several suites carry `KNOWN DEFECT pinned:` assertions — they assert the *current, wrong* behaviour, so
the suite stays green while the defect stands and turns red the day it is fixed, which is the signal to
delete the pin and assert the right behaviour. Each corresponds to a roadmap item.

`npm run smoke` drives the same stack through a browser and is the only thing that covers the editor —
but it is bound to AngularJS markup, so it is the more brittle of the two and the one that will not
survive a frontend replacement. Prefer adding to the REST smoke.

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
- **Nothing covers** dependency failure (see the degradation item on the roadmap), the proxy boundary
  between services, or concurrent edits. Pagination is now covered on a folder's contents and search
  (`pagination` suite); the other paged listings are not.

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
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh status | grep -q STALE \
  && echo "a backend service is STALE — restart the straggler(s) before trusting the run"   # no service on an old jar
cd $CEDAR_HOME/cedar-development/ops/e2e && npm run smoke
```

Pass `restart` no service names. With no arguments it restarts everything the script manages,
which includes the gulp frontend and the five `ui-*` frontends, not only the 15 Dropwizard
services. Naming services explicitly narrows that and is easy to get wrong: a list of the Java
services alone leaves the frontend running whatever it started with, so the gate cannot catch a
frontend regression at all. Gate on `health` rather than reading the status table. It no longer
waits on the bridge: a CompTox registry that has not loaded leaves the bridge healthy and says so in
its health message, so an EPA outage cannot block the gate (see the PFAS `503` entry above).

A full `restart` is slow (it stops and starts 21 processes) and can be cut short — a shell timeout,
an interrupt — partway through, leaving some services on the previous build. So after it, run
`status` and confirm the **BINARY** column reads `current` for every service (see the BINARY/`~pid`
explanation above); a `STALE` warning means that service kept its old jar. Restart just the
stragglers by name — `cedar-services.sh restart <name...>` — and re-check. A `health` gate alone
will not catch this: a stale service is still healthy. This bit more than once during a fix-and-
redeploy pass, where a truncated `restart` left the group and messaging servers a build behind.

### Integration coverage matrix

Which integration baseline each CEDAR microservice meets. The baseline is one suite per application
module that boots the real service wiring, exercises a request over HTTP, and pins both a success and
a meaningful failure path, without any external service.

All fifteen microservices meet it. The point of recording that is so a newly added service cannot
quietly omit it: a row with gaps is visible here, where otherwise it takes a hand audit of fifteen
repositories to notice.

A suite must run without shared developer infrastructure or a live external API. Use
`cedar-test-support-library` for in-process stores and authentication, bind isolated `19xxx` ports
distinct from every other booting test class, and tag the few tests that genuinely need an external
sandbox. Suites must be runnable per repository and together through `cedarcli build`, with failures
attributed to the responsible service rather than disappearing inside the aggregate reactor output.

### The Matrix

Every service boots its real application through `DropwizardTestSupport` or `DropwizardAppExtension`,
so the "boots" column is uniformly yes and is left out. What varies is how each pins its failure path
and what it needs to run.

| Service | Failure path pinned by | Mechanism | Backend |
|---|---|---|---|
| artifact | `CreateResourceTest`, `FindResourceTest` and peers | explicit per-resource | embedded Mongo |
| bridge | `BridgeRoutesRespondTest` | `RouteSurface` 401 | none |
| group | `GroupsAuthorizationMatrixTest`, `GroupMembershipAuthorizationMatrixTest` | `PermissionMatrix` | embedded Neo4j |
| impex | `ImpexRoutesRespondTest` | `RouteSurface` 401 | none |
| messaging | `MessagingRoutesRespondTest` | `RouteSurface` 401 | embedded MariaDB |
| monitor | `MonitorRoutesAndPermissionsTest` | `RouteSurface` 401 + 403 | none |
| openview | `OpenViewUnknownArtifactTest` | anonymous, 404 for an absent artifact | embedded Neo4j |
| repo | `RepoRoutesRespondTest` | `RouteSurface` 401 | none |
| resource | `FoldersAuthorizationMatrixTest` and four peers | `PermissionMatrix` | embedded Neo4j |
| schema | `SchemaServerApplicationSmokeTest` | anonymous, 404 for an unrouted path | none |
| submission | `SubmissionRoutesRespondTest` | `RouteSurface` 401 | none |
| terminology | `TerminologyServerApplicationSmokeTest` | explicit | none |
| user | `UserServerApplicationSmokeTest` | explicit | embedded Neo4j |
| valuerecommender | `ValueRecommenderRoutesRespondTest` | `RouteSurface` 401 | none |
| worker | `WorkerRoutesRespondTest`, `AdminCommandAuthorizationMatrixTest` | `RouteSurface` 401 + `PermissionMatrix` | embedded Neo4j, MariaDB |

Every backend listed is in-process, from `cedar-test-support-library`. No row needs a running CEDAR
stack or a live external API.

### Reading the Mechanism Column

`RouteSurface` enumerates a resource class's endpoints by reflection and requires each to answer an
expected status. Its value is that it covers routes nobody wrote a test for, and it fails rather than
passes when the resource list is wrong — an empty surface is an explicit error, not a silent success.
Adding an endpoint to a covered resource extends the assertion automatically.

`PermissionMatrix` is the heavier form, used where authorization is a grid rather than a gate: it
asserts what each role may do to each artifact at each permission level.

"Explicit" means the failure path is asserted directly in per-resource tests rather than derived from
the route surface. It is not weaker — the artifact server's coverage is the deepest in the system —
but it is per-endpoint, so a newly added endpoint is not covered until someone writes for it.

### Two Services Have No 401 to Assert

`openview` and `schema` are anonymous by design, so "rejects an unauthenticated request" is not a
contract they have. Their rows pin what refusal means for them instead.

The open-view server builds an *anonymous* request context and serves artifacts that have been made
open. Its failure path is that an artifact it should not serve is refused rather than leaked. The
reachable half is an artifact absent from the graph, which answers 404; the other half, an artifact
present but not open, needs a seeded graph and belongs with the sharing tests. The 404 assertion also
checks the response body names the artifact, since a bare 404 would not distinguish an absent artifact
from an absent route.

The schema server's whole surface is its index. An unrouted path answering 404 is the only meaningful
way it can say no.

### Known Gaps

Three, none of them a missing row.

The matrix is derived from the test sources by hand, so nothing fails when a new service lands without
one. Wiring the derivation into the test-enabled `cedarcli build` mode would make a missing baseline
break the build rather than go unnoticed.

The "explicit" services — artifact, terminology, user — assert failure paths per endpoint rather than
over the route surface, so a newly added endpoint is uncovered until someone writes for it.

Open-view pins only the absent-artifact half of its contract. An artifact that exists but is not open
needs a seeded graph and belongs with the sharing tests.

### Regenerating This

The rows come from the test sources, not from a report, so they can be re-derived:

```bash
cd $CEDAR_HOME && for d in cedar-*-server; do
  T=$(find $d -path "*/src/test/java/*" -name "*.java" | grep -v /target/)
  echo "$d: $(echo "$T" | xargs grep -l "RouteSurface\|PermissionMatrix" 2>/dev/null | sed 's|.*/||')"
done
```

Tests that need something external are tagged and excluded by default: `datacite` in the bridge
server, `bioportal` in the terminology server. Both services keep untagged coverage of their
authenticated surface, so excluding the tagged tests does not silently drop a row to nothing.

## Continuous integration

Every Java repository builds in GitHub Actions from `.github/workflows/ci.yml`, on each push and
pull request to `develop` and on manual dispatch. The workflow is the same everywhere: Java 17 from
temurin with the Maven cache, the BMIR Nexus credentials from the `BMIR_NEXUS_USERNAME` and
`BMIR_NEXUS_PASSWORD` repository secrets, `mvn --update-snapshots verify`, and the surefire reports
uploaded whatever the outcome. Jobs carry a hard timeout: twenty minutes for a component,
forty-five for `cedar-project`, which builds nineteen repositories in one reactor.

Two repositories are aggregators over `../` sibling paths that a lone checkout cannot satisfy, so
`cedar-libraries` and `cedar-project` check their component repositories out beside themselves in
the workspace and run Maven from the aggregator directory.

The suites need no service container. The two exceptions both come from a real dependency rather
than from CEDAR code: `cedar-monitor-server` talks to a live MySQL, so its job runs a disposable
MySQL 8 service, and the embedded MongoDB that `cedar-artifact-server` boots is the 5.0 line the
deployment runs, whose only Linux build links against OpenSSL 1.1. Ubuntu 24.04 ships OpenSSL 3, so
that job installs `libssl1.1` on the runner first; without it `mongod` cannot start and every
resource test errors out. Moving the tests onto a newer MongoDB would drop that step, at the cost of
testing against a different engine than production runs.

### Publishing snapshots

Twenty-seven of the repositories deploy their snapshot to Nexus at the end of a successful build.
The step is gated on a real push to `develop`, so a pull request verifies and stops, and a build
that fails publishes nothing. `cedar-libraries` and `cedar-project` are the exceptions: their
modules are other repositories, which publish themselves, and deploying from the aggregate as well
would give one artifact two publishers.

This matters more than it first appears. Everything downstream resolves CEDAR artifacts from Nexus
rather than from a checkout — the servers take the libraries from there, and each microservice
Docker image fetches its own jar by coordinate in `install_deps.sh`. An unpublished snapshot is
therefore invisible: the code is on GitHub, and every consumer still compiles against, or ships, the
previously published jar. The failure surfaces far from its cause, as a compile error or a failing
test in a repository that has not changed.

The verification asks for fresh snapshots (`--update-snapshots`) for the same reason from the other
direction. Maven checks a snapshot for updates once a day by default and the runner restores a
cached `~/.m2`, so without it a build can compile against a stale CEDAR jar for the rest of the day
after a dependency was republished. The flag costs one metadata check per snapshot dependency, and
when Nexus is unreachable it degrades to a warning and falls back to the cached artifact rather than
failing.

Publishing by hand is still occasionally needed — to seed a layer Nexus never had, or after work
that bypassed CI:

```bash
cd $CEDAR_HOME/cedar-<name> && mvn --batch-mode deploy --settings .m2/travis-settings.xml
# needs BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD in the environment
```

To see whether a repository's published snapshot is behind its source, compare the Nexus timestamp
against the commits that touched the build:

```bash
curl -s https://nexus.bmir.stanford.edu/repository/snapshots/org/metadatacenter/<artifact>/2.9.2-SNAPSHOT/maven-metadata.xml \
  | grep -o '<lastUpdated>[^<]*'
git -C $CEDAR_HOME/<repo> log --since=<that timestamp> origin/develop -- 'src' '*/src' 'pom.xml' '*/pom.xml'
```

The Travis build these workflows replace deployed on every `develop` build, which is why Nexus
carried snapshots at all; publishing stopped silently when Travis was switched off, and the
repositories froze until the Actions workflows took it over.

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

### Terminology differential-testing corpus

`--emit-constraints PATH` makes the same walk also write, as JSONL, every controlled-term field's
`_valueConstraints` — trimmed to the shape the terminology server's `POST /bioportal/integrated-search`
accepts (all four lookup lists `ontologies`/`branches`/`classes`/`valueSets` present, empty when
absent, since that endpoint's validator rejects a null list) — with provenance. This is the raw
corpus for comparing two terminology servers (e.g. the current one against a SQLite-backed one):

```bash
export CEDAR_API_KEY=…                                                  # production key, read-only
python3 ops/cedar_ontology_usage.py --server https://resource.metadatacenter.org \
    --emit-constraints raw.jsonl                                        # harvest real constraints
python3 ops/cedar_usage_matrix.py --in raw.jsonl --out matrix.jsonl --tsv matrix.tsv
```

`cedar_usage_matrix.py` reduces the raw per-field harvest to the **atomic-target usage matrix**: one
row per distinct `(kind, acronym, target)` terminology lookup, where `kind` is `ontology` (whole),
`branch` (a class + its descendants), `class` (a picked class), or `valueSet`. It keeps EVERY distinct
target — no sampling — so the matrix covers the full breadth of real usage; each row records how widely
it is used (`seenIn` fields, `nArtifacts` artifacts), branch `maxDepth`s, one example provenance, and a
minimal single-target `valueConstraints` block that POSTs verbatim to `/bioportal/integrated-search`
(auth is disabled there) — so a row doubles as a runnable case. Display-name sources ending in a
parenthesised acronym (`BioAssay Ontology (BAO)`) are normalized to the acronym so an ontology does not
split into two rows.

`cedar_termdiff.py` replays that matrix against `POST /bioportal/integrated-search` and compares a
local, SQLite-backed answer to a BioPortal answer — both obtained through the same endpoint on two
differently-configured instances, so the shapes match. BioPortal is slow and drifts, so it is
record-then-replay:

```bash
# 1) record BioPortal goldens (the slow, standalone run) from a BioPortal-backed instance
python3 ops/cedar_termdiff.py record --matrix matrix.jsonl --goldens goldens \
    --server https://terminology.metadatacenter.org --ontology DOID GO HP --kinds branch class

# 2) verify a local-store instance (localOntologies set, terminologyStore.localOnly=true) vs the goldens
python3 ops/cedar_termdiff.py verify --matrix matrix.jsonl --goldens goldens \
    --server http://localhost:9004 --ontology DOID GO HP --kinds branch class --report readiness.json
```

`record` is resumable (one file per atom; already-recorded atoms are skipped, failures left
unrecorded to retry). Equivalence bar for the enumerate path (`inputText=""`): set-equality on result
IRIs plus preferred-label agreement — ordering and BioPortal-only metadata are ignored, since the
snapshot holds hierarchy plus preferred labels. The endpoint caps `pageSize` (~5000) and its
`page`/`nextPage` are inert, so the harness fetches each set in one request sized to `totalCount`;
sets larger than `--max-results` are marked truncated and excluded from the gate (whole-ontology
enumeration is not a browse test). `verify` emits a per-ontology readiness report; an ontology that is
100% set-equal with no errors is safe to add to `localOntologies`. The migration plan this feeds is
`cedar-terminology-server/ROADMAP.md`.

### Running the gate, and the current cutover state

`ops/cedar_term_gate.sh verify` is the one-command gate: it stands up a throwaway local-store instance
(all ingested ontologies, strict `localOnly`) on the 19xxx test ports, verifies it against the goldens
on both gates (integrated-search and `--roots`), prints the ready sets, and tears the instance down.
`cedar_term_gate.sh record` re-records the BioPortal goldens (drift refresh) from a BioPortal-proxy
instance — run it on a cadence (BioPortal content drifts; ours is pinned), monthly is ample given the
measured ~0.03%/day, additive pace of change. Paths default to
`$CEDAR_HOME/cedar-term/{prod/catalog.sqlite,goldens,goldens_roots,matrix.jsonl}`; override with
`TERM_*` env vars.

Cutover is **per-endpoint**, set from the profile and injected by `cedar-services.sh` (unset the vars
to revert to a pure BioPortal proxy):

- `CEDAR_TERMINOLOGY_STORE_CATALOG` — the catalog path (host-specific).
- `CEDAR_TERMINOLOGY_LOCAL_ONTOLOGIES` — served locally for **search/integrated-search** (the
  gate-proven, high-value path); eligibility is integrated-search equivalence alone.
- `CEDAR_TERMINOLOGY_LOCAL_ROOTS_ONTOLOGIES` — the subset that *also* serves the tree-browse endpoints
  (root classes, class tree) locally, i.e. whose roots are proven equivalent too. An ontology on the
  first list but not the second is local for search but browses from BioPortal — no browse regression
  while its local roots still diverge (roots divergence is dominated by BioPortal-endpoint quirks:
  import orphans we drop, Protégé/upper-ontology artifacts BioPortal lists that we drop — not our bug).

### Multilingual labels & synonyms (`lang=`)

For locally-served ontologies the store keeps every language variant of every name and every synonym
(captured at ingest, backfilled across the served catalog — see
[Multilingual labels](VERSIONING-DESIGN.md#10-multilingual-labels)). The read path serves them:

- **Search recall** — a query matches a label in any language or a synonym, not just the served
  `pref_label`; an empty-query browse is unchanged.
- **Synonyms** — returned on class detail (`GET /bioportal/ontologies/{acronym}/classes/{id}`).
- **`lang=<bcp47>`** — request a language on the class endpoint and on integrated-search:
  - `GET /bioportal/ontologies/{acronym}/classes/{id}?lang=fr`
  - `POST /bioportal/integrated-search?lang=fr`

  Returns the label in that language, falling back to the default (English-preferred) when a concept has
  none in it. Honored only on the local path; a BioPortal-proxied ontology returns BioPortal's own
  default. Deferred by decision: `lang=all` (the `{lang:value}` hash), `lang=` on the public
  `search`/tree output, and honoring the submission's `naturalLanguage` for the default.

Quick check (integrated-search has auth disabled, so no token needed):

```bash
curl -s -X POST 'http://localhost:9004/bioportal/integrated-search?lang=fr' \
  -H 'Content-Type: application/json' \
  -d '{"parameterObject":{"valueConstraints":{"ontologies":[{"acronym":"ONTOPARON"}],"branches":[],"valueSets":[],"classes":[]},"inputText":"occupational"},"page":1,"pageSize":3}' \
  | python3 -c 'import sys,json;[print(c["prefLabel"]) for c in json.load(sys.stdin)["collection"]]'
# -> professionnel / accident du travail / ergothérapie  (English by default)
```

### Re-ingesting an ontology

Ingest is `IngestJob <catalogPath> <snapshotDir> <ACRONYM>…`, `BIOPORTAL_API_KEY` in the env. OWLAPI
4.5.9 resolves http imports via Apache HttpClient and parses with JAXB, neither of which it declares
and JAXB is not in JDK 17 — both are now declared in the ingest module's pom, so a classpath from the
build is complete (a hand-assembled one that omits them makes an import-heavy ontology fail with
`NoClassDefFoundError` and, before the guard, produced an empty snapshot):

```bash
cd $CEDAR_HOME/cedar-terminology-server
mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests
mvn -q -pl cedar-terminology-server-ingest dependency:build-classpath \
    -Dmdep.outputFile=/tmp/ingest-cp.txt -DincludeScope=runtime
CP="cedar-terminology-server-ingest/target/classes:$(cat /tmp/ingest-cp.txt)"
BIOPORTAL_API_KEY=$CEDAR_BIOPORTAL_API_KEY java -cp "$CP" \
    org.metadatacenter.terms.ingest.IngestJob $CEDAR_HOME/cedar-term/prod/catalog.sqlite \
    $CEDAR_HOME/cedar-term/prod/snapshots DOID
```

Ingest is idempotent on the content hash (same download overwrites in place, atomically, only on a
non-empty extraction) and won't overwrite a good snapshot with a failed/empty one. `version_id`
changing means BioPortal's content changed; the old snapshot is then orphaned — delete rows/files not
referenced by any `version_tag`.

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
underlying frontend defect is unfixed and on the [roadmap](./BACKEND-ROADMAP.md); the retry tolerates it
rather than curing it.

## Login

`https://cedar.metadatacenter.orgx` — seeded test users: `test1@test.com` / `test1`,
`test2@test.com` / `test2`. `/etc/hosts` must map the `*.metadatacenter.orgx` names to localhost
(already configured on this machine).
