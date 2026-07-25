# CEDAR Local Operations Runbook

Operational knowledge for running and managing a **local, native CEDAR** on macOS — written
to be read by a human or an LLM agent. It covers the architecture, the bring-up sequence, the
non-obvious gotchas that will otherwise cost hours, and the two helper scripts in this folder.

Scope: the **native-develop** setup (infrastructure as local binaries, microservices as native
Dropwizard JVMs, frontends via `gulp`). The all-Docker deployment is a separate path and is not
covered here.

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
```

`cedarcli start all` does the same thing but opens ~15 Terminal tabs (one foreground process per
tab, by design — see below). The controller replaces that with background processes + one status view.

## The controller: `ops/cedar-services.sh`

Manages the 15 microservices + the main frontend as background (`nohup`) processes, each logging to
`$CEDAR_HOME/log/`, PIDs tracked in `$CEDAR_HOME/log/run/`. It forces `JAVA_HOME=17` and sources the
profile itself, so it is safe to run standalone.

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

## Login

`https://cedar.metadatacenter.orgx` — seeded test users: `test1@test.com` / `test1`,
`test2@test.com` / `test2`. `/etc/hosts` must map the `*.metadatacenter.orgx` names to localhost
(already configured on this machine).
