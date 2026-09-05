# CEDAR Backend Runbook

Operational knowledge for running and managing a **local, native CEDAR** on macOS — written
to be read by a human or an LLM agent. It covers the architecture, the bring-up sequence, the
non-obvious gotchas that will otherwise cost hours, and the two helper scripts in this folder.

Scope: the **native-develop** setup (infrastructure as local binaries, microservices as native
Dropwizard JVMs, frontends via `gulp`). The containerized alternative has a summary below and a
focused [Docker runbook](./DOCKER-RUNBOOK.md).

Known backend work items, and the decisions about what is deliberately not being done, are tracked
in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).
Docker deployment work has a narrower execution plan in
[DOCKER-ROADMAP.md](./DOCKER-ROADMAP.md).

## Architecture

Three tiers:

- **Infrastructure** — Keycloak (auth), MongoDB, MySQL, Neo4j, Redis, OpenSearch (search index),
  and nginx (TLS termination + reverse proxy for `*.metadatacenter.orgx`). In native-develop these
  are host services managed by the native infrastructure scripts. Docker mode owns containerized
  infrastructure; hybrid mode owns the Docker backend and native frontends. The three supported
  modes deliberately do not include native JVMs over an independently assembled Docker data tier.
- **Microservices** — 15 Dropwizard JVMs, one per `cedar-<name>-server` repo. Each is launched as
  `java -jar cedar-<name>-server-application-<version>.jar server .../config.yml`.
- **Frontends** — the production-safe AngularJS monolith (`cedar-template-editor`) is served by
  `gulp` on port 4200 and proxied by nginx to `https://cedar.metadatacenter.orgx`. During its
  extraction, `cedar-workspace` (4201) and `cedar-template-designer` (4202) run beside it as preview
  frontends. The active auxiliary UIs are openview, monitoring, bridging, and content.

## Environment: select the native mode first

Begin by checking which topology owns the machine. If no mode is selected, select `native` once.
That loads and validates the native profile internally, pins Java 17 for its child processes, and
records the selection without starting anything. Later native commands work from a bare shell.
Direct shell scripts still require the profile to be sourced explicitly.

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli mode
```

If the result says no mode is set, select the mode and name the environment this host runs:

```bash
cedarcli mode native --profile develop
```

`--profile` takes `develop` for a workstation or `server` for a staging or production host, and it
is required, because the two differ in ways nothing can safely guess. The choice is recorded beside
the mode in `.cedar/mode.json`, and `cedarcli env status` shows it. A host that selected its mode
before profiles existed adds the missing one with the same command, which records it in place
without stopping anything.

One versioned file serves every native host,
`cedar-development/bin/templates/cedar-profile-native.sh`, read straight from the checkout as the
Docker profile already is. It takes `CEDAR_PROFILE` as its only input and derives everything else
from `CEDAR_HOME`, from this installation's own `set-env-external.sh` and `set-env-internal.sh`,
and from `uname -s` for the infrastructure aliases. `develop` builds the frontends locally, targets
`local`, and bypasses Keycloak TLS verification for the reason below; `server` serves built
payloads, targets `server`, and verifies certificates. Selecting a mode validates what the profile
produced, and refuses a server whose environment carries the bypass or whose credentials are still
the template's `changeme` placeholders.

If it reports `docker` or `hybrid`, stop the components owned by that topology and clear the mode
before selecting native. The complete transition commands are in the
[Docker runbook](./DOCKER-RUNBOOK.md#prerequisites). Do not select a second mode over a running
deployment.

`JAVA_HOME` must be JDK 17 for commands run directly rather than through cedarcli. CEDAR services and Keycloak require Java 17. The machine's default
`java` is newer (23/25) and **Keycloak crashes on it** (`Failed to start caches … getSubject is
supported only if a security manager is allowed` — the SecurityManager was disabled in JDK 18+).

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

The native controller and `cedarcli` select JDK 17 for managed processes. Set `JAVA_HOME` yourself
only for direct Java or Keycloak commands outside the CLI.

**Keycloak TLS verification is secure by default.** Both the bearer-token client that fetches realm
JWKS and the admin client that sends the CEDAR administrator password use the JVM truststore and
hostname verification unless `CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS=true`. That flag is a
development-only escape hatch: the native profile sets it because its locally issued `.orgx` leaves
are not installed in the workstation JVM truststore. The Docker images import the CEDAR development
CA and therefore leave the flag unset. Never set it in staging or production; ensure the JVM
truststore contains the Keycloak issuer CA, leave the flag absent or `false`, and exercise both token
verification and one admin operation after deployment.

## Bring-up sequence

```bash
# cedarcli loads the native profile and starts infrastructure, services, and frontends.
cedarcli native start all
cedarcli native status

# Log in
open https://cedar.metadatacenter.orgx    # test1@test.com / test1   (also test2@test.com / test2)

# Optional: prove the stack end to end (login, folder + template round-trip; ~30 s)
(cd ops/e2e && npm run smoke)
```

`cedarcli native start all` runs both steps above, including native infrastructure. It does not open or
control a terminal application. Each application has its own PID file and log instead.

## The containerized stack

An alternative to the native bring-up: the same fifteen microservices and the same infrastructure,
as containers. It is the `cedar-docker-build` images driven by the `cedar-docker-deploy` compose
stacks. Re-proven on 2026-08-21 — all 70 Java reactor modules built, seven infrastructure and all
fifteen microservices healthy, the whole REST estate green (683 assertions, 0 failures in one
in-network run), and all seven frontend containers healthy. All seven public UI hostnames returned
200 through Docker nginx; the authenticated Workspace-to-Designer template-open journey also
passed. See [DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md) for the reproducible build,
deployment, health, and acceptance procedures.

**It cannot run beside the native stack.** Both want 80/443, 3306, 27017, 6379, 9200, 7474/7687,
8080 and the 9xxx range. Take the native one down first with `cedarcli native stop all`, which unlike
`cedarcli native stop all` also stops the infrastructure. Storage is separate — the containers use
their own named volumes and never touch `/opt/homebrew/var/*`, so the two estates keep independent
data.

Stop native mode before selecting Docker mode. The CLI validates the Docker profile and Compose
projects when the mode is configured, then supplies that profile internally to later Docker calls.

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli native stop all
cedarcli mode --clear
cedarcli mode docker
cedarcli docker setup one-time-setup
cedarcli docker start all --pull missing
cedarcli docker status
```

An ordinary aggregate start selects the current completed Docker train; `--pull missing` downloads
only images absent from this machine. To deploy from another registry, export
`CEDAR_IMAGE_PREFIX=<registry-host>:<port>/<namespace>` before `cedarcli mode docker`. The
complete selected train must exist under that prefix.

The checked-out-source alternative is explicit and does not claim to reproduce a published train:

```bash
cedarcli build java
cedarcli docker build infra --local
cedarcli docker build microservices --local
cedarcli docker build frontends --local
cedarcli docker start all --local --pull never
```

`--pull never` is for images already built or pulled on this machine. `--pull always` checks the
registry even when a local image exists.

Certificates come from `$CEDAR_HOME/CEDAR_CA` when it exists, and only fall back to the expired set
bundled in `cedar-docker-deploy/cedar-assets` when it does not.

**The 22-container hybrid backend does not start a frontend Compose project.** Do not infer frontend
container status from a 22/22 backend health result. In configured Docker mode,
`cedarcli docker start frontends --detach` starts the separate seven-container project containing
Template Editor, Workspace, Designer, OpenView, Content, Monitoring, and Bridging. Hybrid mode
rejects that command and permits `cedarcli native start frontends` instead. Running
the REST estate without frontends still needs the two services
that have no vhost addressed directly, and Keycloak addressed on its published port, because
container addresses are not routable from macOS:

```bash
cd ops/e2e
export CEDAR_KEYCLOAK_BASE=http://127.0.0.1:8080 CEDAR_OPENVIEW_BASE=http://127.0.0.1:9013
export NODE_TLS_REJECT_UNAUTHORIZED=0
npm run smoke:rest
```

The artifact server publishes no host port, deliberately, since nothing outside the container
network should address a server that authorizes on global roles alone. A host-side REST run therefore
passes the public estate but ends the `contract` and `freeze` suites with `fetch failed`. Run the
suite from an ephemeral Node container on `cedarnet`, as documented in the Docker runbook, to test
those internal cross-store contracts without exposing Artifact.

To get back to the native stack, stop the complete Docker deployment, clear its mode, and select
native before starting anything on the host:

```bash
cedarcli docker stop all
cedarcli mode --clear
cedarcli mode native --profile develop
cedarcli native start all
```

### Running the native frontends against the containerized backend

This is the current interactive development mode for a full Docker backend. Docker nginx serves the
public hostnames and proxies to native frontend development servers on the Mac. This was proven on
Docker Desktop on 2026-08-21: all seven UI hostnames returned 200, the Workspace/Designer hostname,
Keycloak, navigation-origin, and REST-CORS gates passed, and the earlier browser smoke completed
login, fixture creation, BioPortal constraint lookup, and template creation.

No frontend application code is copied into the nginx container. A Workspace request, for example,
travels from the browser to Docker's published port 443, through the Workspace nginx virtual host,
to `host.docker.internal:4201`; the native Gulp server then serves
`$CEDAR_HOME/cedar-workspace/app/index.html` and its assets. Browser API requests return to Docker
nginx on the API hostnames and are proxied over `cedarnet` to the Java containers.

| Public hostname | Native source root | Server | Port |
| --- | --- | --- | ---: |
| `cedar.metadatacenter.orgx` | `cedar-template-editor/app` | Gulp / gulp-connect | 4200 |
| `workspace.metadatacenter.orgx` | `cedar-workspace/app` | Gulp / gulp-connect | 4201 |
| `designer.metadatacenter.orgx` | `cedar-template-designer/app` | Gulp / gulp-connect | 4202 |
| `openview.metadatacenter.orgx` | `cedar-openview/cedar-openview-src` | Angular CLI / `ng serve` | 4220 |
| `content.metadatacenter.orgx` | `cedar-content-distribution` | Angular CLI / `ng serve` | 4240 |
| `monitoring.metadatacenter.orgx` | `cedar-monitoring/cedar-monitoring-src` | Angular CLI / `ng serve` | 4300 |
| `bridging.metadatacenter.orgx` | `cedar-bridging/cedar-bridging-src` | Angular CLI / `ng serve` | 4340 |

These are seven independent Node.js processes: three legacy AngularJS applications use Gulp and
four newer Angular applications use Angular CLI. The focused Docker procedure, verification, stop
path, and three-mode comparison are in [DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md).

Select hybrid mode once, then start the native frontend tier and the Docker deployment. If another
mode is already selected, stop its owned components and clear it first. The CLI loads both profiles
for the commands that need them, binds the Angular development servers so Docker nginx can reach
them, and refuses any native backend operation that would collide with the containers:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli mode hybrid --profile develop
cedarcli native start frontends
cedarcli docker start all --pull never
```

Hybrid mode points all seven Docker nginx frontend upstreams at `host.docker.internal`. Docker's
ordinary network gateway reaches published container ports but not native macOS listeners, so that
special host name is required. To change modes, stop the current deployment, run
`cedarcli mode --clear`, and select the replacement mode.

The Docker nginx image sets `proxy_read_timeout` and `proxy_send_timeout` to 180 seconds globally.
This is deliberate: an unmodified nginx returned 504 at 60.05 seconds for a 65-second upstream;
with the 180-second timeout, the identical request returned 200 at 65.01 seconds.

The older fallback still works: stop `infra-nginx`, start native nginx on 80/443, and leave the
frontends on their default loopback bind. Do not run both nginx instances together.

Use `cedarcli docker status` in hybrid mode. `cedarcli native status` is deliberately rejected because
the backend ports belong to containers. If the lower-level `cedarcli native status` is run directly,
container-owned services are marked `docker` in the PID and HEALTH columns. This describes ownership,
not readiness; the footer points to `cedarcli docker status` for the authoritative container health
check. Native start, stop, and restart still refuse to signal Docker's port-forwarding process.

The populate-time term suggestion remains the one browser-smoke failure: the expected controlled-term
picker input does not appear. It is not an nginx timeout—the failure is a 20-second locator wait, and
nginx and the backend remain responsive. The template carries the branch constraint and the
containerized terminology server answers the query. Compare the same browser smoke against the
native backend to decide whether this is a frontend defect or a mixed-topology artifact.

### Legacy diagnostic split: native servers against containerized infrastructure

This older diagnostic arrangement puts selected data stores in containers while the JVMs remain
native. It is not one of the three CLI modes and is not a supported aggregate deployment. The
procedures below use direct Homebrew, Docker, and maintenance commands intentionally; do not infer
that `native` or `hybrid` mode owns this mixed runtime.

`set-env-generic.sh` derives every infrastructure host from `CEDAR_NET_GATEWAY`, the native profile
sets it to `127.0.0.1`, and the containers publish the selected stores on the same host ports the
servers already read.

**Redis has moved.** Swap it with the native stack running, from a second shell — the stack needs
the Docker profile for the container's pinned address, and the servers keep running under the
native one:

```bash
brew services stop redis                      # frees 6379
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose up -d redis-persistent
```

To go back, `docker stop infra-redis-persistent && brew services start redis`. `brew services stop`
unloads the launch agent, and the container carries `restart: unless-stopped`, so after the swap
Redis returns on reboot as a container rather than as a Homebrew service.

**Expect about ten seconds of queue errors, then silence.** Three servers poll Redis and log the
outage: the worker's value-recommender reindex, the messaging server's pool validation, and the
submission server's NCBI queue consumer. All three recover on their own retry interval once the
container answers. No restart is needed, and a server that is still logging Redis failures a minute
later is a real problem rather than the swap.

Verify with `cd ops/e2e && npm run smoke`, then `redis-cli -p 6379 info stats`. The smoke run drives
a few thousand commands through the store, so a counter still near zero means the servers are
talking to something else. `redis-cli -p 6379 info server` should report `redis_version:7.2.7`.

**OpenSearch has moved too,** at 2.19.1, the version already running natively. Same shape:

```bash
brew services stop opensearch                 # frees 9200
docker compose up -d opensearch               # from cedar-infrastructure, Docker profile
cedarat search-regenerateIndex                # native profile; rebuilds from Mongo + Neo4j
cedarat rules-regenerateIndex
```

Rolling back is `docker stop infra-opensearch && brew services start opensearch`. The native data
directory under `/opt/homebrew/var/opensearch` is never touched by any of this, so the native index
is still there when you go back.

**Regenerate rather than migrate.** The index is derived from Mongo and Neo4j, so rebuilding it is
both the cheapest migration and a correctness check on the store you just stood up. `IndexUtils`
deletes the indices it owns and leaves everything else alone, which matters on 2.x: that image ships
plugins 1.3.6 did not, and they create `.plugins-ml-config` and a `top_queries-*` index of their own.
Expect to see them, and expect the regenerate log to say it is not touching them.

**Do not read `docs.count` as a resource count.** CEDAR indexes nested documents, so `_cat/indices`
inflates. Count root documents with a `match_all` search instead, and compare that against the
`FileSystemResource` nodes in Neo4j.

**Mongo and Neo4j have moved as well,** at 5.0.31 and 5.26.0, the versions running natively. These
are the two that carry the source of truth, so each is a real migration rather than a rebuild.

Mongo goes through `mongodump` and `mongorestore`. Restore only the `cedar` database: the container
creates its own users in `admin` on first start, native runs without auth, and restoring native's
`admin` over the container's would take those users away.

```bash
mongodump --db cedar --out /tmp/cedardump                    # while native is still up
# stop native (see the note below), then start the container
docker compose up -d mongo
mongorestore --uri "mongodb://${CEDAR_MONGO_ROOT_USER_NAME}:${CEDAR_MONGO_ROOT_USER_PASSWORD}@127.0.0.1:27017/?authSource=admin" \
  --drop --db cedar /tmp/cedardump/cedar
```

Neo4j goes through `neo4j-admin`, which dumps offline, so the database has to be stopped first. Load
into the volume with a one-off container before starting the service:

```bash
$CEDAR_HOME/neo4j/bin/neo4j stop
$CEDAR_HOME/neo4j/bin/neo4j-admin database dump neo4j --to-path=/tmp/neodump
docker run --rm -v neo4j_data:/data -v /tmp/neodump:/dump --entrypoint sh \
  ${CEDAR_IMAGE_PREFIX}/cedar-infra-neo4j:${CEDAR_DOCKER_VERSION} \
  -c 'neo4j-admin database load neo4j --from-path=/dump --overwrite-destination=true'
docker compose up -d neo4j
```

Load only the `neo4j` database. Neo4j 5 keeps authentication in `system`, so the container's own
credentials survive, which is what you want since both sides use the same ones.

**MySQL and Keycloak have moved as a pair,** because Keycloak's realm is the `cedar_keycloak`
schema. MySQL is now the Docker Official `mysql` image at **8.4 LTS**, not Oracle's
`mysql/mysql-server`, which was abandoned in January 2023 with 8.0.32 as its last tag — that is why
this pin never moved. LTS deliberately, rather than the 9.x innovation line the native install
drifted onto: an innovation release is superseded roughly quarterly, which is the opposite of a
locked version.

Only what matters crosses. `cedar_keycloak` and `cedar_messaging` are 3.2 MB together; `cedar_log`
held 2.4 GB of request and cypher logging and was dropped, its five tables restored empty so logging
resumes. A dump from native 9.6 restores into 8.4 cleanly — rehearse it on a throwaway container
first, and strip `GTID_PURGED` from the dump or the restore aborts before it creates anything.

```bash
mysqldump -u root -p --databases cedar_keycloak cedar_messaging --single-transaction > cedar.sql
mysqldump -u root -p --no-data --databases cedar_log | grep -v GTID_PURGED > log-schema.sql
brew services stop mysql            # see the warning below — mysqladmin shutdown is not enough
docker compose up -d mysql keycloak
docker exec -i infra-mysql mysql -u root -p"$CEDAR_MYSQL_ROOT_PASSWORD" < cedar.sql
```

**Provision the databases and users by hand in this hybrid.** The containerized estate provisions
itself: `cedar-microservice` carries a `wait-and-init-mysql.py` that creates each server's database
and user from `CEDAR_SERVER_NAME`, and the Keycloak image has its own for the realm database. Native
servers never run either. So a containerized MySQL under native servers gets only what Keycloak's
container creates, and `cedar_log` and `cedar_messaging` need their databases, users and grants
created explicitly — at `@'%'`, since the connection now arrives from outside the container rather
than from `localhost` as it did natively.

**Stopping native MySQL needs `brew services stop mysql`.** `mysqladmin shutdown` is not enough:
launchd restarts `mysqld_safe`, which restarts `mysqld`, within seconds. Combined with the port trap
below this is genuinely dangerous — native rebinds `127.0.0.1:3306`, wins every connection back from
the container, and nothing reports it. Two full REST runs passed against native MySQL while the
container sat idle and healthy before this was noticed. Check `lsof` and `SELECT VERSION()` after
stopping, not just that the container says healthy.

**Which nginx serves 443 decides what the containers must resolve `auth.<host>` to.** Every server
verifies bearer tokens against the realm behind that name, so `extra_hosts` has to point at whichever
nginx is actually listening — and that is not the same thing as the nginx container's address on
cedarnet. They have separate variables for that reason:

| serving 443 | `CEDAR_AUTH_HOST_TARGET` |
|---|---|
| native nginx (the resting state here) | `host-gateway` |
| the `infra-nginx` container | `${CEDAR_NGINX_HOST}` |

Getting it wrong is silent until a token is verified. The request reaches the server, the server
cannot fetch the realm's signing keys, and a **valid** token comes back `500` while an invalid one
still correctly returns `401` — so the failure looks like a server bug rather than a routing one.
The log says `java.net.NoRouteToHostException`.

**The Keycloak container cannot reach a native resource server.** Its event listener posts user
lifecycle events to `CEDAR_RESOURCE_SERVER_HOST`, which under the Docker profile is a
`192.168.17.x` container address that does not exist when the servers are native, so the log fills
with `NoRouteToHostException`. Login, token verification and the whole REST estate are unaffected —
only event propagation is, so new-user provisioning is the thing to watch. Point it at
`host.docker.internal` if that matters to you. The callback runs on a matching
`cedar-angular-app` `LOGIN`, not on Keycloak registration itself, so a later login is the retry. A
transport failure is logged with its cause; a non-2xx response is logged with status, URL, event
type and user id. Treat either message as a provisioning failure rather than accepting a healthy
login as proof that the CEDAR account exists.

**Stopping native Mongo needs `db.shutdownServer()`, not the Homebrew service.** Two things bite
here. `brew services start mongodb-community@5.0` now fails: Homebrew refuses the `mongodb/brew` tap
as untrusted, cannot read the formula, and writes a launch agent with no `ProgramArguments`. Run
native Mongo directly instead, and shut it down through the shell:

```bash
/opt/homebrew/opt/mongodb-community@5.0/bin/mongod --config /opt/homebrew/etc/mongod.conf --fork
mongosh --quiet --eval 'db.getSiblingDB("admin").shutdownServer()'
```

`brew trust mongodb/brew` followed by `brew services start` restores the launchd path, at the cost of
trusting that tap. `mongod --shutdown` is not available in this build.

**A native store and its container can both hold port 27017 and nothing warns you.** Native binds
`127.0.0.1` specifically while Docker binds the wildcard, so both listen, the more specific bind wins,
and every client silently keeps talking to the native server. `docker ps` says healthy throughout.
Check with `lsof -nP -iTCP:27017 -sTCP:LISTEN` and confirm only Docker is there before believing a
swap took.

**What is verified.** Every migration is exact: Mongo restored 62 documents with collection counts
matching the source, the graph came across at 18 nodes and 29 relationships with the same folder and
template counts, and MySQL carried 92 Keycloak tables, six users and 17 messages. `npm run
smoke:rest` passes at 641 assertions against all six containerized servers, with request logging
resuming into the new MySQL — confirm that by checking `SELECT VERSION()` on 3306 reports the
container's, not by trusting a green run.

### The local terminology store, and the two levers that govern it

The store is a read-mostly SQLite catalog of about 31 GB at `$CEDAR_HOME/cedar-term`. It is shared
rather than copied — a read-only bind mount, the same shape as the static content nginx already
mounts — because copying it into a named volume would be absurd and nothing writes to it while the
server reads.

Sharing the file is only half of it. **The server reads `terminologyStore.*` JVM system properties,
not the environment.** `cedar-services.sh` builds those `-D` flags for the native path; the
containerized half is `CEDAR_JAVA_OPTS`, which `cedar-microservice`'s entrypoint passes to the JVM,
set by the `server-terminology` compose entry. Passing the four `CEDAR_TERMINOLOGY_*` variables into
a container without that hook does nothing at all, which is worth knowing before debugging a 404.

**Lever one: on or off.** The server disables the store entirely when either the catalog path or the
ontology allowlist is blank, and serves everything through BioPortal instead:

```java
if (catalogPath == null || catalogPath.isBlank() || localOntologies.isEmpty()) {
  log.info("Local terminology store disabled; serving all ontologies via BioPortal");
```

`cedar-main.yml` ships `catalogPath: ""`, so **BioPortal is the shipped default** and the system
properties are the only thing that turns the store on. Which makes the switch one line in the
profile — `CEDAR_TERMINOLOGY_STORE_CATALOG`, empty for BioPortal, the mount point for the store —
plus a container recreate. The bind mount can stay either way; it is inert when the path is blank.
Confirm which mode you are in from the server's own log rather than by inference, and check the
observable consequence: `bioportal/ontologies/DOID/versions/current` answers 200 with a content-hash
version id when the store is on, and 404 when it is off.

**Lever two: strict or fail-soft.** `terminologyStore.localOnly` decides whether a locally-served
ontology may fall back to BioPortal when the local store cannot answer. It is `false` normally, so a
local gap is silently covered by BioPortal — safe, and worth remembering, because **it means a green
suite does not prove the local store is complete**. Strict mode exists for the equivalence harness,
where a gap should fail loudly instead of being masked.

A third setting is not a lever so much as a distinction. `localRootsOntologies` is a subset of
`localOntologies`: the ontologies whose roots are proven BioPortal-equivalent. One in the allowlist
but not in that subset is served locally for search and integrated-search but **browses from
BioPortal**, because its local roots still diverge. So the split is per-operation, not per-ontology.

Which vocabularies the store serves, and whether exclusively, are declared once in
`set-env-generic.sh` and inherited by both profiles. Only the catalog path differs, since it is a
filesystem path and the host's is not the container's.

**Currently: off.** The containerized terminology server serves everything through BioPortal, with
the mount left in place so turning it back on is the one profile line.

### Building an image against your own code

By default every image fetches its jar from Nexus while it builds, so an image can only run code
that has already been published. `--local` builds against the checkout instead:

```bash
cd $CEDAR_HOME/cedar-artifact-server && cedarcli build this --wd "$PWD"
cedarcli docker build artifact-server --local
```

**`cedarcli docker build` is the only builder.** The compose stacks carry no `build:` stanzas, so
`docker compose up` runs images and never makes them. Two reasons: only the CLI builds the CEDAR
base images a target is built `FROM` first, and only the CLI supplies the locked server versions.
Those live in `cedar-docker-build/bin/cedar-images-base.sh` — one `export <SERVER>_VERSION=` each —
and the Dockerfiles declare them as build arguments with **no default**, so a build that was not
given a version fails instead of quietly choosing one. A bare `docker build` therefore no longer
works on the infrastructure images, which is deliberate. To change a server version, change it there
and nowhere else; `ops/check_version_pairing.py` then checks it still pairs with the client
`cedar-parent` ships.

The image name is the source repository minus its `cedar-` prefix, for all fifteen servers and the
admin tool. `cedarcli docker build` also takes `all`, a group (`infra`, `microservices`, `frontends`,
`admin`), a component target such as `frontend workspace`, or any image name. It always builds the CEDAR bases an image is built `FROM`
first — which a bare `docker build` does not, and which is how a stale base silently gets used.

**Build clean when a library changed.** `./mvnw install` without `clean` can re-shade a fat jar around
a cached assembly and leave an old copy of a dependency class inside it. The jar is newer than the
library it should contain, so no timestamp check catches this, and every downstream step reports
success: staging copies the jar faithfully, the image hash matches, and the container runs the old
code. If you changed a shared library, `./mvnw clean install` in the consuming server before staging.


## The controller: `cedarcli native`

Manages the 15 microservices + three AngularJS/Gulp frontends + the 4 auxiliary Angular frontends as
background processes: non-restarting submitted `launchd` jobs on macOS and `nohup` children on other
systems. Each logs to `$CEDAR_HOME/log/`, with its PID tracked in `$CEDAR_HOME/log/run/`. The
controller resolves `JAVA_HOME` to a JDK 17 and refuses to start anything on another JDK, puts
`/opt/homebrew/bin` on `PATH` (for `node`/`ng`), and sources the profile itself, so it is safe to run
standalone.

`cedarcli native` is the interface. `ops/cedar-services.sh` is the controller behind it, and
`NativeWorker` calls that script for every verb below. Reach for the script directly only for the
one case the CLI does not cover, noted after the table.

The Gulp frontends deliberately run side by side: `ui-main` is the production monolith on 4200,
`ui-workspace` is the extracted Workspace preview on 4201, and `ui-designer` is the extracted
Template Designer preview on 4202. Starting the previews does not change nginx routing or production
traffic. Start the migration comparison set with `cedarcli native start frontend main`, then
`workspace` and `designer`.

Native development must not cache frontend responses: the Gulp and Angular development servers use
stable filenames while their bytes change underneath them. Install the canonical no-store proxy
policy after changing or recreating the local nginx configuration:

```bash
bash $CEDAR_HOME/cedar-development/ops/install-local-frontend-cache-policy.sh
```

The three AngularJS applications also give each development page load a fresh RequireJS cache key,
so a copied or incomplete proxy configuration cannot silently reuse an old module. Server payloads
use their Git source commit in that key; `CEDAR_VERSION_MODIFIER` remains the explicit discriminator
for two environment-specific payloads built from the same commit. It is not needed merely to make a
new source revision visible.

The remaining four are Angular applications, each run with `ng serve` from its
`cedar-<name>[-src]` source dir (see `fe_dir()`): `ui-openview` (4220), `ui-content` (4240),
`ui-monitoring` (4300) and `ui-bridging` (4340). Every frontend is named `ui-*`, which keeps
`ui-openview` apart from the
`openview` microservice and `ui-monitoring` and `ui-bridging` apart from `monitor` and `bridge`. The
prefix marks the category, not the launcher: `ui-main`, `ui-workspace` and `ui-designer` carry it
too, and will keep it when they stop being AngularJS. Frontends have no Dropwizard `/healthcheck`,
so the controller requests their HTTP root: an Angular compiler failure leaves `ng serve` listening
but returning 404 and is therefore `UNHEALTHY`, not green. `cedarcli native start frontends` starts
all seven through this controller, and the
`cedarcli native`, `start frontend` and `stop frontend` subcommands name a frontend without the
prefix — `main`, `workspace`, `openview` — which the controller receives as `ui-<name>`.

Each managed Angular start clears that checkout's ignored `.angular/cache` before compiling and
uses its project-local Angular CLI when installed (`ui-content` retains its host-CLI fallback). This
matters when an ordinary frontend build ran `npm ci` while the old development server was live: the
server may otherwise persist a module graph observed while `node_modules` was being replaced, then
reuse the invalid graph after a restart even though the completed lock install builds correctly.

```bash
cedarcli native start all             # infra + microservices + frontends
cedarcli native start infra           # or: backends, microservices, frontends
cedarcli native start microservice <name>   # artifact, bridge, group, resource, …
cedarcli native start frontend <name>       # main, workspace, designer, openview, …
cedarcli native stop all              # same shapes as start
cedarcli native restart [name...]     # all managed applications, or only the named ones
cedarcli native status                # one-shot table: PID / port / health / binary / error-count
cedarcli native watch                 # auto-refreshing status
cedarcli native logs <name>           # tail -f a service log
cedarcli native health                # exit 0 only if every managed application is healthy
```

`start` and `stop` name one service at a time through their `microservice` and `frontend`
subcommands, while `restart` takes a list. Starting an arbitrary named subset in one call is only
available on the controller itself:

```bash
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start ui-main ui-workspace ui-designer
```

`cedarcli native status` is the preferred whole-host view. It renders one grouped table for the
managed applications and native infrastructure. Managed rows retain every
controller diagnostic — PID ownership, application port and listener state, health, binary
freshness and cumulative log-error count — instead of printing the controller table followed by a
second, less informative port table. The controller exposes the same rows to the CLI through its
internal tab-separated status action; its ordinary `status` output remains convenient for shell
use and gates such as the `STALE` check below.

It recognizes a native service already listening on its port, including one started in a terminal,
and **reports any service whose jar or configuration is not built/present**. An occupied port is not
treated as proof of ownership: if the listener is not the expected CEDAR jar or frontend process in
the expected source directory, start and stop both fail without signalling it. Backend health uses
the Dropwizard admin `/healthcheck` endpoint (200 = healthy, 500 = unhealthy); frontend health
requires a successful response from the served root.

Two columns exist so a green table cannot hide a stale one. **BINARY** compares when a process started
against when its jar was written: `STALE` means the service is serving a jar older than the build, so
its health says nothing about your latest code. For the `ui-main` and `ui-workspace` rows the column
asks the equivalent question of the Embeddable Editor, which each of those frontends takes from npm
and a gulp task copies out of `node_modules` into the tree gulp serves. Those two hops are invisible
to git, because the served copy is ignored, so moving the pin without `npm ci`, or running `npm ci`
without `copy:cee`, keeps the previous editor on screen while `package.json`, the lock and the
release ledger all name the new one. `STALE` there means the served bundle is not the one
`package-lock.json` names, and the remedy the footer prints for each stale frontend is a reinstall
and a recopy in its own checkout rather than a restart:

```bash
(cd $CEDAR_HOME/cedar-template-editor && npm ci && npx gulp copy:cee)
(cd $CEDAR_HOME/cedar-workspace && npm ci && npx gulp copy:cee)
```

The other frontends read `-`: none of them depends on the Embeddable Editor. **PID** shows `~pid` (a leading tilde) only for a
verified CEDAR process listening without this controller's pidfile — for example, one started in a
terminal. `stop` may safely adopt that verified process, so `restart` brings it onto the current
build. `docker` in the PID and HEALTH columns means the port belongs to Docker; Artifact is also
recognized through its running container because its application port is intentionally private to
`cedarnet`, and its PORT column reads `internal`. These labels do not claim that a container is
healthy: use `cedarcli docker status`, as the table footer says. `!pid` is reserved for a genuinely
foreign listener. Lifecycle commands refuse to touch either Docker's forwarding process or a foreign
owner. Stale pidfiles are likewise ignored unless the live PID still matches the expected service.
For a native deployment, always confirm `status` shows every service `current`, not merely `healthy`,
before trusting a verification gate.

## How native processes are managed

`cedarcli native start microservices` and `cedarcli native start frontends` delegate to
`cedar-services.sh`.
Applications run in the background; the CLI never opens iTerm or Terminal. Use `cedarcli native
status`, `cedarcli native watch`, `cedarcli native logs <name>`, or `cedarcli native restart
[name...]` instead of keeping a console open for each process.

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
| impex | 9008 | 9108 | | workspace (gulp preview) | 4201 | — |
| | | | | designer (gulp preview) | 4202 | — |
| | | | | Keycloak | 8080 / 8443 (https) | |

Admin port = app port + 100; health check at `http://127.0.0.1:<admin>/healthcheck`. The same report
is served on the application port at `/healthcheck`, where it requires the `monitorManager` role and
is what the Monitor's cross-service health page reads.

In Docker only the application port is published to the host. Admin connectors bind loopback inside
their container for the Compose health check and are not host-mapped; do not add `9111:9111` (or any
other admin mapping) to the core Compose stack. Native admin connectors likewise bind `127.0.0.1`.

Frontends (HTTP-root health): `ui-main` 4200, `ui-workspace` 4201 and `ui-designer` 4202 under
gulp; `ui-openview` 4220, `ui-content` 4240, `ui-monitoring` 4300 and `ui-bridging` 4340 under
`ng serve`.

## API-key credentials and management identifiers

An API key has two identifiers with deliberately different jobs. Its `key` is the credential sent
in `Authorization: apiKey <key>` and must be handled as a secret. Its `id` is a stable, non-secret
management handle returned with the key in the user profile. The profile UI and other management
clients regenerate or delete a key through the user server with that handle:

```text
POST   /users/{userId}/api-keys/{keyId}/regenerate
DELETE /users/{userId}/api-keys/{keyId}
```

Never substitute the credential for `{keyId}` or put it in a URL. URLs are routinely retained in
nginx access logs, browser history, traces and monitoring. New keys receive an independent UUID when
they are created, and regeneration preserves that ID while replacing only the credential. A key
stored before IDs were introduced is exposed with a deterministic `legacy-<sha256>` management ID;
this keeps it addressable without revealing the credential, and the ID is persisted on the next
profile write. Authentication itself is unchanged and still looks up the secret `key` value.

## The Redis queues, and where failed permission events go

Five persistent queues carry work between services. Their names are set in
`cedar-config-library/src/main/resources/cedar-main.yml` under `queueNames`, and all five live in
the persistent Redis on 6379:

| Queue | Redis key | Carries |
|---|---|---|
| searchPermission | `CEDAR-QUEUE-search-permission` | permission and move events that the search index must follow |
| ncbiSubmission | `CEDAR-QUEUE-ncbi-submission` | submissions bound for NCBI |
| appLog | `CEDAR-QUEUE-app-log` | application log events |
| valuerecommender | `CEDAR-QUEUE-valuerecommender` | templates whose recommender rules need regenerating |
| cloneInstances | `CEDAR-QUEUE-cloneInstances` | bulk instance-clone requests |

All five consumers use a claim/acknowledge protocol. A claim atomically moves the oldest message to
`<queue>-processing`; only successful handling removes it. On service restart, anything left in the
processing list is restored ahead of newer messages in FIFO order. Clone, app-log and permission
handlers retry three times before atomically moving the raw message to `<queue>-dead-letter`.
Value-recommender polls claim at most 100 messages, rather than draining an unbounded backlog into
memory, and a failed batch is retried before its messages are dead-lettered. The submission server's
NCBI consumer acknowledges handled submissions, dead-letters malformed ones, and wakes for shutdown
by interrupting its blocking connection; it does not enqueue the old JSON `null` sentinel or log an
empty one-second blocking-pop timeout as an error.

The search-permission queue is the most security-sensitive one, but every worker dead-letter queue
is worth watching. For example:

```bash
redis-cli llen CEDAR-QUEUE-search-permission-dead-letter
```

Zero is the expected reading. A nonzero search-permission value means the search index's permissions
are behind the graph for the resources those events name; the other suffixes mean clone, application
log or recommender work needs attention. Nothing retries dead-lettered work on its own.

Resource and group producers first persist each permission event as a
`CedarSearchPermissionOutbox` node in Neo4j. Redis acceptance removes that node; if Redis is down,
the request's graph mutation still succeeds and the managed relay retries every five seconds, across
producer restarts. Delivery can repeat if a producer dies after the Redis push but before the Neo4j
acknowledgement, which is safe because permission projection is idempotent. To exercise that boundary
against the native local stack (the command stops and restores the Homebrew Redis service in a
`finally` block):

```bash
cd $CEDAR_HOME/cedar-development/ops/e2e
npm run smoke:permission-outbox -- --manage-homebrew-redis
```

The producer validates persisted outbox records before relay. A record missing its outbox id,
resource id or event type, or naming an unknown event type, is relabelled
`CedarSearchPermissionOutboxDeadLetter` with `deadLetterReason` and `deadLetteredAtTS`; it no longer
blocks valid records behind it, but remains in Neo4j for inspection. A relay failure after the new
event has been persisted is contained by the producer and retried in the background rather than
turning the already-committed REST mutation into a `500`. Resource and group relay the same outbox;
if one acknowledges and removes an event while the other is materializing it, the losing relay
ignores Neo4j's null projection because the winning relay has already delivered that event. Their
outbox scans and acknowledgements also take the same `CedarSearchPermissionOutboxRelayLock` mutex
in Neo4j, protected by a unique lock-name constraint. This prevents one producer from deleting a
node while the other is reading it; lock initialization occurs in the contained relay path, so an
unavailable Neo4j instance does not turn application construction into a startup failure.

Read what is parked before deciding anything. Each entry is the original JSON event, carrying the
resource id, the event type and the time it was created:

```bash
redis-cli lrange CEDAR-QUEUE-search-permission-dead-letter 0 -1
```

The worker log says why each one was parked. Fix that cause first — replaying into a broken
dependency simply parks the events again. Then move them back, oldest first, appending behind
whatever is already queued rather than jumping ahead of it:

```bash
while [ "$(redis-cli llen CEDAR-QUEUE-search-permission-dead-letter)" -gt 0 ]; do redis-cli eval "local m = redis.call('LPOP', KEYS[1]); if m then redis.call('RPUSH', KEYS[2], m); end; return m" 2 CEDAR-QUEUE-search-permission-dead-letter CEDAR-QUEUE-search-permission > /dev/null; done
```

A message that cannot be parsed is parked on its first failure rather than retried, since retrying
will not make it parse. Such a message will never apply, so drop it once the log has been read
rather than replaying it.

That replay is a Lua script, as the queues themselves are, so that it runs on every Redis CEDAR
deploys to. A consumer claims a message by moving it from the queue to the processing list in one
step, which `LMOVE` does as a single command from Redis 6.2 onwards. Development runs 7.2.7 and
staging runs 6.0.16, so the queue library builds that move out of `EVAL`, available since 2.6,
rather than requiring the newer command. Each server's Redis health check compares the server's
reported version against that minimum and names a server below it, instead of leaving consumers to
retry a command the server will never accept.

When the dead-letter transfer itself cannot reach Redis, the message remains in the processing list
whenever Redis retained the earlier claim and is recovered on the next consumer initialization. The
worker logs the failed transfer; inspect both `-processing` and `-dead-letter` after restoring Redis.

Rebuilding the index from the graph fixes permission drift whatever its cause, since the graph is the
source of truth. It reads the resources from the folder server, indexes them into a new index, then
points the `cedar-search` alias at it and deletes the old one:

```bash
curl -s -X POST http://localhost:9007/command/regenerate-search-index -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" -H "Content-Type: application/json" -d '{"force": true}'
```

Call the resource server directly rather than through nginx, which answers an unmatched path with a
200 and an HTML body, so a mistyped route looks like success. It is the heavier instrument, and it
discards the index the alias is serving, so prefer a replay when the dead-letter queue explains the
drift.

The rebuild is queued rather than performed, so the command answers `202` with the job it started:
the body carries the job's `jobId` and state, and a `Location` header names where to poll it. Add
`-D-` to the call above to see that header. Poll it until the state leaves `RUNNING`. It reports the
job this command started rather than whichever job ran last over the index, so a rebuild somebody
started after yours cannot be mistaken for it, and a `FAILED` carries the reason — which the resource
server log has in full.

### A rebuild that answers 409, and taking the index back

Only one rebuild runs at a time over an index, because each one ends by deleting every index for its
alias but its own: two together leave the alias naming an index that no longer exists. A second
command over a busy index is refused with a 409 that names the job holding it and carries the same
`Location` a 202 would, so a caller refused a rebuild can watch the one already under way.

Two routes report a job. `GET /command/index-job-status` says what became of the last rebuild of each
index and whether one is running now, which is the question to ask about an index. Appending a job
identifier — `GET /command/index-job-status/{jobId}` — asks about one job instead, and that is the
question to ask about a rebuild you started. Jobs are held in memory, so an identifier from before
the last restart, or one that twenty later jobs have pushed out, is no longer known and answers 404.
The same exclusion and the same pair of routes cover the value sets ontology import, under
`GET /command/load-valuesets-ontology-status`.

A job that throws releases the index whatever it threw. A job that never returns cannot, so a claim
is believed for six hours. Past that the status reports it as `overdue`, and the refusal names the
command that takes the index back:

```bash
curl -s -X POST http://localhost:9007/command/reset-search-index-job -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY"
```

`reset-rules-index-job` and `reset-valuesets-import` are the same command for the other two claims.
A reset does not stop the abandoned job, so read the resource server log first and run it only once
that job has stopped making progress; the job it abandons can no longer report, so it cannot say
COMPLETE over the rebuild that follows it. A claim still within its deadline is left alone and
answers 409, and the reset asks for the same permission as the rebuild it unblocks.

The deadline governs the reset alone, not the refusal. A new rebuild is refused whenever a claim is
held, whatever age that claim has reached, so an abandoned one blocks every rebuild until someone
resets it. Nothing expires a claim on a timer, and waiting out the six hours changes only what the
status calls it. The value sets import behaves the same way.

## Identifiers: what a client sends, and what the server fills

Only the repository assigns an identity. A client says which identifiers it wants assigned rather
than inventing them, and there are two spellings, chosen by what the schema demands rather than by
taste: **`null` where the key is required, absence where it is not.**

| What | A draft writes | Who fills it |
|---|---|---|
| An artifact's own `@id` | `null`, and the key must be there | the server, on create |
| An element occurrence's `@id` | `null`, or the key left out | the server, on create and update |
| — and a template types that key `["string", "null"]`, so the draft validates | | |
| An attribute's `@context` term | nothing — the term is left out | the server, on create and update |
| A template child's property IRI | nothing — the mapping is left out | the server, on create and update |

A draft is checkable before it is sent. A template types an element occurrence's `@id` as
`["string", "null"]`, matching how it has always typed its own instance's, so
`POST /command/validate?resource_type=instance` accepts an instance whose new occurrences carry null
— the identifiers the server is about to assign. Both meta-schemas accept either typing and both model
libraries read either, so a template rendered before this validates and reads exactly as it did;
nothing rewrites a stored artifact, and one is not wrong for predating a rule. Only the renderers
changed, so a stored template starts typing the key the new way when something reads it and writes it
back.

**A YAML body asks the other way round.** The two dialects say "no identifier yet" differently, and
each is refused in the other's form. JSON carries the key with null in it, because the meta-schema
requires the key. YAML has no such requirement and no use for a placeholder, so the authoring form
simply omits `id`, and an explicit `id: null` is refused with *"null is not a valid value; omit the
key if the value is unknown"*. An update over YAML must name the identifier it is updating, as over
JSON. `/command/validate` takes YAML too, so a client that authors in YAML can ask whether its work is valid
before sending it — the same transcode the write routes use, on every artifact kind. A body it cannot
read answers `400`: it is the client's mistake, not the server's. It used to accept JSON alone and
answer `500` from the deserializer, which made it the one write-adjacent route that refused what the
write routes accept. The JSON-only composite body — an instance together with the template to validate
it against — is unaffected.

**Create refuses a body with no `@id` key**, and refuses one carrying a real IRI. The first is
refused because an absent key cannot be told from a forgotten one, and because the meta-schema types
`@id` as `["string", "null"]` and marks it required — so an omitted key was the one body shape that
created here and failed `/command/validate` there. Both refusals answer `400` with `templateNotCreated`
or its sibling for the kind. Nothing else about a create body changed: `@id: null` has always worked,
and it is what the REST MCP, the Template Designer's blueprints and CEE all send.

The filling happens in `LinkedDataUtil` in `cedar-config-library`, which the artifact server calls
before validation on `POST` and on `PUT`. It walks the instance, assigns
`…/template-element-instances/<uuid>` to every element occurrence that asks, and
`…/properties/<uuid>` to every attribute an attribute-value field names and no `@context` term
covers — into the context of the node holding the field, which is the root for a field at the top
level and the occurrence's own context for one inside an element. On a template or an element it
does the same for a child the `@context` block does not map, and lists the child in that block's
`required`, skipping the children no property could name: a static field displays something and
holds nothing, and an attribute-value field's names are mapped in the instance instead.

Two rules keep it honest, and both are load-bearing. **An identifier already there is left alone**,
whoever assigned it: an identifier is worth having because it is stable, so an update returns what it
was given, and the property IRIs the editors minted before this rule stay as they are. **An empty
string is not an absent identifier**: a new request carrying one is invalid, and the ordinary minting
pass does not confuse it with an honest absence. Strict model readers refuse it. The February 2024
TypeScript compatibility reader and CEE make one deliberately narrower concession for production:
an empty `@id` on a legacy element occurrence is opened with a warning and written as `null`, so an
ordinary update can ask the server for the identifier it never received.

**An ordinary update is differential.** Before normalization, the artifact server fetches the stored
artifact and compares the two. An unusable template-child mapping, element-occurrence `@id`, unsafe
attribute-value name, or missing nested child `$schema` declaration is repaired only when the stored
artifact proves the defect was inherited. A restored declaration is always the canonical
`http://json-schema.org/draft-04/schema#`. The same malformed value or omission introduced into a
clean artifact is left for validation to reject; a missing root declaration and an explicit bad child
declaration are never repaired. A hardened client may already have made the safe half of the repair:
Designer can omit an inherited unusable mapping and CEE can replace an inherited empty occurrence ID
with `null`; normal server minting then finishes both. The resource server performs no artifact
validation before proxying the PUT, so this comparison happens before a legacy document can be
refused. `skip_validation` cannot bypass the post-normalization validation, and a verbatim write
remains strict.

This compatibility path makes an ordinary edit safe; it does not clean artifacts nobody edits. Use
the GET-only REST audit below to inventory what remains before deciding whether a bulk patch is
worthwhile.

**A term whose attribute is gone is removed**, in the same pass, and this is the one place the server
deletes something a client sent. Three questions decide each term, and two of them need the template,
which is why the prune runs where the template is already loaded — fetched to validate against. A name
the template declares is structure and stays, filled in or not: an unfilled child is absent from the
body and its definition still belongs there. A name an attribute-value field still holds is in use and
stays. Anything else goes, and only when the IRI is one the repository assigned — an author who mapped
a child to a term from a real vocabulary chose that IRI, and it is never touched.

Inside the document an orphan and a structural term look identical: a name in the context, mapped to a
`…/properties/…` address, used nowhere in the body. `instances/005` in the shared corpus carries two of
the second kind, which is why the rule that drops whatever the body does not use deletes an author's
work. What is already stored keeps its orphans until something rewrites it, which is a patch item on
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

**The JSON Schema `title` and `description` follow the name.** A template, element or field is also
a JSON Schema document, and the meta-schemas require both keywords. Nothing reads them but a person
looking at the document, and they have always been generated from `schema:name`. Every ordinary
`POST` and `PUT` rewrites the artifact's own pair before validation. The title is derived outright,
in the canonical form the Java and TypeScript YAML readers compose:
`<name> template schema`, with `element` or `field` for the other kinds. The description is that
title followed by an attribution, and the attribution is the one thing a client keeps. Every
generator signs the document in its description, `generated by the CEDAR Template Editor 2.9.5`
say, and `ops/cedar_static_required_audit.py` reads that signature to tell which tool wrote a stored
artifact. A description with no signature takes the artifact library's,
`generated by the CEDAR Artifact Library`, which is also what an artifact posted as YAML receives.
The Template Designer used to be the only thing that regenerated the pair, and only while the
artifact was open in it, so a rename from the dashboard rewrote the name and left the pair
describing the old one. An embedded element or field carries a pair of its own, written by whatever
generated that piece, and it is left as sent. A verbatim write stores the pair as given, like
everything else in the document, and what is already stored keeps a stale pair until something
rewrites it.

## Patching stored artifacts: `ops/cedar_artifact_patch.py`

The rules above govern what the server accepts from now on. They say nothing about what a store
already holds, and several defects are in circulation there: an empty `pav:derivedFrom`, an empty
`@id` on an element occurrence, a `_ui.pages` the meta-schema forbids, an attribute-value field
naming an attribute nobody named, a temporal field declaring no `temporalType`, a `@context` term
whose attribute is gone, controlled-term constraints predating the versioned source fields, an
inherently multiple field deployed as an object rather than an array, and a static field the stored
schema demands of every instance. An empty `pav:derivedFrom` stops the strict Java reader; the
TypeScript compatibility reader opens it as absence and omits it on write, and an ordinary server
update removes the inherited value. A blank occurrence `@id` stops strict readers, while CEE and the
February 2024 TypeScript compatibility reader can open it and turn it into the `null` that an
ordinary server update repairs. The patch is still required for artifacts nobody edits and for
consumers that correctly choose strict reading.

One script finds and repairs all nine. It reports by default and writes only under `--apply`:

```bash
python3 ops/cedar_artifact_patch.py --tree ../cedar-test-artifacts/artifacts
```

Two sources are accepted. `--tree` walks a directory of artifact files, which is how the shared corpus
is read; `--mongo` reads a store, one pass over `templates`, `template-elements`, `template-fields` and
`template-instances`:

```bash
python3 ops/cedar_artifact_patch.py --mongo mongodb://localhost:27017 --db cedar
```

The Mongo source needs `pymongo`, and the system Python on this machine is externally managed, so give
it a virtual environment rather than `--break-system-packages`:

```bash
python3 -m venv /tmp/cedar-patch && /tmp/cedar-patch/bin/pip install pymongo
```

Four things about a run are worth knowing before trusting its numbers. `--items` narrows it to the
checks you mean, using the stable check numbers printed by the report, which matters because a full
run over a large store reads every artifact. Report mode defaults to all nine checks, but `--apply`
is refused unless `--items` is supplied explicitly and names at least one check. The
`*-original.json` files in a tree are skipped: those are preprod
captures kept beside their corrected copies so a defect stays legible, and `--include-originals` reads
them but cannot be combined with `--apply`. And a repair is offered only where the correction is
settled — a populated `_ui.pages`, an artifact whose own `@id` is empty, an empty attribute name with
something keyed by it, and a constraint whose acronym the terminology catalog cannot resolve are all
reported and left alone, since each needs a decision the script has no grounds to make.

Every Mongo apply creates a new pre-image directory before connecting. By default it is a timestamped
`cedar-artifact-patch-backup-*` directory under the caller's working directory; production work should
name a durable, nonexistent destination explicitly with `--backup-dir`. Each replaced document is
written there as canonical Mongo Extended JSON with its SHA-256. Immediately before replacement the
tool hashes a fresh read and refuses a mismatch; the replacement itself matches the complete original
pre-image atomically and increments `_cedarRevision`. A save that races either check is preserved, the
repair run stops, and the process exits `2`. The backups are tool-side rollback material, but they do
not replace the deployment's ordinary database backup and restore procedure.

Check 32 is the multi-select incident repair. It inspects only field deployments inside templates and
elements; a standalone field artifact is the reusable inner definition and is intentionally left
object-shaped. The rewrite preserves the complete inner schema, moves any settled positive bounds to
the array envelope, derives an absent `minItems` from `requiredValue`, and reports without rewriting
when existing bounds contradict each other. The Template Designer deliberately does not perform this
repair on load: opening an artifact must not silently change what its next save writes. Audit it alone
before considering a write:

```bash
python3 ops/cedar_artifact_patch.py --mongo mongodb://localhost:27017 --db cedar --items 32
# only after reviewing the JSON report and taking the ordinary database backup:
python3 ops/cedar_artifact_patch.py --mongo mongodb://localhost:27017 --db cedar \
  --items 32 --apply --backup-dir /var/backups/cedar-artifact-patch-<RUN_ID>
```

A corpus run reports one unreadable file, and it is meant to be unreadable. `cee-suite/086` is not
valid JSON and `templates/003` disagrees with its own `_ui.order`; both are named in
`TemplateCorpusReadability.spec.ts` as deliberate failures, so a reader that refuses them is being
tested rather than obstructed. Do not repair either.

Item 30 is the one that needs more than the artifact. A `@context` term naming no key in the instance
may be an orphan or a child the instance does not fill, and only the template says which, so the script
resolves one — by `schema:isBasedOn` against the store, or by the sibling `template-NNN.json` in a
tree — and reports rather than rewrites when it cannot. Run template-blind, the corpus yields four
findings and all four are false positives.

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
  full YAML and under a seventh of the JSON — by dropping provenance, version, status, and model
  version while retaining the artifact identifier. Writing it back is rejected with a `400` naming
  the compact form. Write the full form, or omit `id` to author minimally.
- **A template instance takes `?format=` ahead of `Accept`.** That parameter already names the
  representation (`jsonld`, `json`, `rdf-nquad`), so YAML negotiation applies only when it is absent.

Storage stays JSON on both servers: YAML is a request and response representation, transcoded per
request, never a stored form.

Canonical YAML deliberately leaves a small set of structural values unquoted. Both model-library
writers use the same `YamlPlainScalarPolicy`: a scalar is plain only when its mapping key is one of
`type`, `modelVersion`, `status`, `version`, `datatype`, `action`, `granularity`, `termType` or
`inputTimeFormat` **and** its value belongs to that key's CEDAR-controlled vocabulary. Versions must
match `N.N.N`; all other eight positions use the exact values enumerated by the model. Everything
else remains double-quoted, including IRIs, timestamps, user text and `sourceSystem`. This is a writer
style, not a stricter input contract: the readers accept the old quoted form and the new plain form,
so an existing artifact does not need patching merely because of scalar style. CEE metadata YAML and
YAML downloads inherit the policy from the TypeScript writer rather than implementing a third copy.

The 2026-08-18 corpus refresh changed 4,730 scalar spellings across all 389 YAML fixtures without
changing any parsed value. Exhaustive policy tests cover every admitted value and rejection outside
the nine key/value sets. In Java run `mvn test` under Java 17; in TypeScript run `npm test`,
`npm run verify:java-lock:source` and `npm run parity:yaml`. The CEE integration checks are `npm test`,
`npm run typecheck` and `npm run test:domain` against the candidate TypeScript package.

A YAML round trip is expected to be lossless. The case that historically was not is the `_ui._size`
box on `static-image` and `static-youtube-video` fields: the YAML serialization carries it in the
child's `configuration:` block, and a reader that looked only at the field level dropped it on every
nested static field. `YamlAsymmetryProbeTest` in `cedar-artifact-library` and `YamlNegotiationTest`
in `cedar-artifact-server` both pin it. If a round trip ever loses a setting again, add a probe there
rather than documenting the loss.

### The two model libraries agree, and how to confirm it

`cedar-artifact-library` (Java) and `cedar-model-typescript-library` (TypeScript) implement the same
model and are meant to write the same document for the same artifact. They do: byte-identical YAML
over all 82 corpus artifacts in the full form and the compact one, matching JSON over the same set,
and each reads every document the other writes. Anything a run reports from here is a regression.

Both comparisons live in the TypeScript library, which carries the corpus in-repo, so a plain clone
runs them with nothing cloned or symlinked first:

```bash
npx ts-node ./itest/scripts/compare-verbatim-ts-java-yaml-files.ts
npm run parity:yaml:compact
```

Each reads as a summary — a case with output on only one side is counted and skipped rather than
thrown — and a green run names the four artifact kinds with `0 differing` against 18 fields, 6
elements, 37 templates and 21 instances. Full and compact output have independent parity gates, so
drift in either representation fails explicitly.

Each library also holds two properties about itself as tests, so a regression fails a build rather
than waiting for a comparison run. Every scalar returns as the string it went in as, over a few
thousand adversarial strings generated from a fixed seed — `YamlScalarRoundTripTest` in Java,
`YamlScalarRoundTrip.spec.ts` in TypeScript. And the compact form reads back as the artifact it was
written from, keeping the identifier and carrying none of the model version, version, status or
provenance — `CompactYamlRoundTripTest` and `CompactYamlRoundTrip.spec.ts`. Reading the compact form
has to be asked for on both sides: the ordinary reader refuses it over the absent model version, and
a reader for it is a separate constructor, `YamlArtifactReader(true)` in Java and
`getStrictForCompact()` in TypeScript.

Both readers make the same compatibility concession for `$schema`: an artifact root must carry the
canonical draft-04 URI, while a nested legacy field or element may omit it on input. Both writers put
the canonical declaration back, so a read-render cycle repairs the omission. An explicit wrong or
non-text declaration remains an error. The artifact server keeps the wire contract strict and makes
the same inherited-only repair on an ordinary update; new omissions and verbatim updates are refused.

Two deliberately harmless reader differences remain. A document with `modelVersion` only at its root
and none on its children is accepted by Java and refused by TypeScript; it is a hybrid neither writer
emits, because authoring form is compact throughout and stored form is full throughout. An empty array
inside an instance is classified as an empty multi-instance field by Java and an empty list by
TypeScript, while both emit the same bytes for it.

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
  CEDAR_CA_HOME=$CEDAR_HOME/CEDAR_CA
  SSL=/opt/homebrew/etc/nginx/cedar/ssl
  cp -r "$SSL" /tmp/cedar-ssl-backup                          # optional but wise (reversible)
  cedarcli cert setup                                          # safe to repeat; preserves CA state
  cedarcli cert domains --force                                # renew all leaves (SAN preserved, 824 days)
  for d in "$CEDAR_CA_HOME"/certs/*/; do sub=$(basename "$d"); tgt="$SSL/$sub"; [ -d "$tgt" ] || continue;
    crt=$(ls "$d"*.crt | head -1); cp "$crt" "${crt%.crt}.key" "$tgt/"; done   # install into nginx ssl dirs
  sudo "$(brew --prefix)/bin/nginx" -s reload                 # nginx master runs as root → needs sudo
  ```
  Notes: `cedarcli cert domains` writes leaves to `$CEDAR_CA_HOME/certs/<subdomain>/`, but nginx reads from
  `$SSL/<subdomain>/` — hence the copy step. The subdomain dir names match on both sides. Skipping the
  `--force` option protects existing leaves from accidental replacement. Renewal keeps the CA issuance
  history and writes each replacement atomically, so a failed OpenSSL command leaves the prior leaf in
  place. The reload is the only step that needs your password (the master is a root process; there is no
  passwordless sudo).

- **`brew services start mongodb-community@5.0` breaks MongoDB** → it fails with
  `launchctl bootstrap gui/<uid> ... exited with 5`, and running it again keeps failing because it
  is the cause, not the victim. The formula ships its own `macos_mongodb.plist` and its `service`
  block only names it, which is the old Homebrew convention; current `brew services` ignores that
  and *generates* a plist from the `service` block instead. That block defines no `run`, so the
  generated plist has an empty `ProgramArguments` and launchd has nothing to start. Each attempt
  overwrites the good plist with the empty one.

  Reinstall the formula's own plist and load it:
  ```bash
  cp /opt/homebrew/opt/mongodb-community@5.0/homebrew.mxcl.mongodb-community@5.0.plist \
     ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/homebrew.mxcl.mongodb-community@5.0.plist
  ```
  It then runs under launchd with `RunAtLoad`, survives a reboot, and `brew services list` reports
  it started. To restart it afterwards use
  `launchctl kickstart -k gui/$(id -u)/homebrew.mxcl.mongodb-community@5.0` rather than
  `brew services`, which would regenerate the empty plist.

  The underlying cause is the pinned version: the tap has moved to MongoDB 8.x while the deployment
  is locked to 5.0, so the 5.0 formula carries a convention Homebrew no longer honours. Expect this
  to return after a Homebrew upgrade.

  Two `mongod` processes from `~/.embedmongo` may also be running: those are embedded MongoDBs left
  by a test run using `cedar-test-support-library`. They hold no ports and are harmless, but
  `pkill -f '\.embedmongo.*mongod'` clears them.

- **Keycloak won't start** → wrong JDK. Pin `JAVA_HOME` to 17 (see above). Symptom: `Failed to start
  caches … getSubject is supported only if a security manager is allowed`.

- **`startinfra.sh` seems to hang for minutes, and Keycloak is dead once it returns** → the script
  was piped. `startkeycloak.sh` runs `kc.sh start &`, and that backgrounded Keycloak inherits the
  script's stdout, so a reader on the other end of a pipe never sees end-of-file however long ago the
  script itself finished. Whatever eventually gives up sends SIGTERM to the process group, which
  includes the Keycloak that started perfectly well. The symptom is therefore a long stall followed
  by an infra tier missing one service, which reads as a Keycloak failure and is not one. Redirect
  instead of piping, and read the file afterwards:

  ```bash
  bash $CEDAR_UTIL_BIN/services-generic/startinfra.sh > /tmp/startinfra.log 2>&1
  ```

  The same applies to anything else that leaves a child holding stdout. `cedar-services.sh` is safe
  either way: it detaches what it starts.

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

- **Profile vars empty** → you sourced `cedar-profile-native.sh` before exporting
  `CEDAR_HOME`. Export it first.

- **A microservice shows `down` in status with no jar** → that server was never built. Build it:
  ```bash
  mvn -o -f $CEDAR_HOME/cedar-<name>-server/pom.xml install -DskipTests   # -o = offline; drop it if a dep is missing
  # or: cedarcli build java
  ```
  (Seen unbuilt in this environment: schema, repo, submission, valuerecommender, openview, monitor.)
  `resource`/`user`/`artifact`/`terminology`/`group` are the core for login + workspace. `schema` is
  not needed by anything: it serves only its index page, and no service or frontend calls it — the
  host in its name is the namespace under which property IRIs are minted, by string construction
  alone. Whether it should exist at all is an open question on
  [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

- **A service starts then dies with `no main manifest attribute, in …-application.jar`** → the jar is
  a thin jar (built without the shade/assembly step), so it has no runnable `Main-Class`. Rebuild that
  one server to produce the fat jar, then restart it:
  ```bash
  mvn -o -f $CEDAR_HOME/cedar-<name>-server/pom.xml install -DskipTests
  cedarcli native start microservice <name>
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
  in scripts and background commands. The helper scripts here already do this. The native
  controller refuses rather than running on the wrong JDK, reporting `CEDAR needs JDK 17, and
  <path> reports 23`, so this symptom belongs to `mvn`, `npm` and anything else started outside
  `cedarcli`.

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
  This used to fail the check, which meant an EPA outage made `cedarcli native health` exit
  non-zero and blocked the full gate below on a third party. A health check answers "should traffic
  reach this instance", and for a dependency the loader will retry forever the answer is yes.
  (`TerminologyServerHealthCheck` is right to do the opposite: the ontology catalogue is that
  server's entire job, and its degraded mode silently served a partial catalogue.)

- **The whole stack is green, but real requests 500 (often with `NoClassDefFoundError`), or a
  service answers as an older build would** → a backend service is **`STALE`**: running a jar older
  than the one on disk, and that jar can be a *broken* build, not merely old code. A parallel
  session or an interrupted `restart` can start a service from a half-written or unshaded jar — one
  whose shade dropped a class, say Guava's
  `com.google.common.cache.RemovalCause` — and it boots and passes `/healthcheck`, then throws on the
  first request that needs the missing class (seen as a 500 on `GET /folders`, which breaks the whole
  dashboard). `health` cannot catch this: a stale service is still healthy. So **confirm no backend
  service is stale before trusting the stack for anything**, not only after your own redeploy — another
  session may have restarted it under you, which is exactly how this happened. The check is one line:

  ```bash
  cedarcli native status | grep STALE \
    || echo "every service current"
  ```
  Restart the offender by name so it loads the current jar, and re-check that its **BINARY** column
  reads `current`:
  ```bash
  cedarcli native restart <name>
  ```
  If you suspect the *current* jar is itself a partial build, confirm it is a sound fat jar before
  restarting into it: `unzip -l <app>.jar | grep -c RemovalCause` should be non-zero, and the jar
  should be ~130 MB, not a few MB (a thin jar has no `Main-Class` and dies at start instead — a
  different, louder failure covered above).

  Staleness does not always announce itself. A jar that is merely old rather than broken answers
  `200` and does exactly what the build it came from did, so nothing reaches any log and the service
  simply disagrees with the source in front of you. Suspect the binary before the code whenever what
  the stack does contradicts what the source says it should do. One tell settles it without a
  redeploy: pick a line the code path logs unconditionally — `BioPortalFailure.relay` warns for
  every BioPortal status at or above 400, say — and if the running service never wrote it, that
  service does not have that code. A terminology-server relay path was reported broken on this,
  having been read in source that already handled the case while the running jar predated it.

## cedarcli (headless invocation)

`cedarcli` is normally a shell alias (`source $CEDAR_HOME/cedar-cli/cli.sh`) that activates a venv
and runs `cedar.py`. To drive it non-interactively, invoke the same Python entry point. The selected
mode must already be recorded; the CLI loads its profile and JDK internally:

```bash
export CEDAR_HOME=$HOME/CEDAR
$CEDAR_HOME/cedar-cli/.venv/bin/python $CEDAR_HOME/cedar-cli/cedar.py <command>
```

The `docker` group covers build, validation, Docker-aware status, per-stack start/stop, one-time
network/certificate setup, and destructive removal. Native `start` and `stop` manage infrastructure
and the application groups without terminal automation. The `native` group exposes application
status, health, logs, restart, and the continuously refreshing status view.

## Building CEDAR

`cedarcli build java` is the authoritative full build. It compiles and installs the whole Java
stack in dependency order: parent, libraries, project, and clients. Inside a single repo,
`cedarcli build this --wd "$PWD"` builds just that repo. The CLI loads the selected profile and pins
JDK 17 for these child processes.

**Maven comes from the wrapper, not from the machine.** Every Java repository carries `mvnw` pinned
to 3.9.14, CI invokes it, and `cedarcli` does too, so the build tool is the same everywhere instead
of whatever each developer and each runner happens to have installed. It is script-only — no jar is
committed — and fetches its distribution into `~/.m2/wrapper` on first use. Run `./mvnw` rather than
`mvn` from inside a repository; the exceptions in this document are the commands that pass `-f` with
an absolute path from outside one, where a wrapper cannot be resolved. Container jar-fetch stages
use the `MAVEN_BUILDER_VERSION` pinned in `cedar-images-base.sh`; Maven and its JDK never enter a
served runtime image.

Java is not pinned this tightly. The enforcer requires `[17,18)` and CI asks for `17`, both major
only, while the runtime image ships an exact Temurin build — so the thing that runs the servers is
pinned harder than the thing that compiles them. The roadmap carries that, with the Java 21 move.

The CLI build runs the Java test suites by default: every Java repo is built with
`./mvnw clean install`, so a green `cedarcli build` means its unit and embedded integration suites
passed as well as compiled. The default suites are backend-free, so nothing needs to be up. The
seven build commands that can reach Java — `this`, `parent`, `libraries`, `project`, `clients`,
`java`, and `all` — accept the paired `--tests` / `--skip-tests` option; use `--skip-tests`
explicitly for a fast compile/install loop. Frontend-only build commands do not expose an inert
Java-test option.
Release preparation, Maven publication, and immutable build-train assembly remain explicit
`-DskipTests` paths; verify with the default CLI build or repository CI before invoking them.

Order is not optional. A server compiled against a stale `cedar-parent` picks up the parent's old
managed versions and plugin configuration, which fails silently rather than loudly (see the
stale-parent gotcha above). When bumping a dependency or changing shared build configuration, always
install `cedar-parent` first, then the libraries, then rebuild consumers.

When invoking Maven directly, never pipe its output through a reader that can close early (`head`,
`grep -m`). A closing reader sends SIGPIPE to `mvn`, which can end the reactor early while the shell
reports success. Redirect the full log to a file and grep the file.

**Rebuilding a server without `clean` can ship the previous build's dependency.** Change a shared
library, `mvn install` it, then `mvn install` a server that depends on it, and the server's fat jar is
rewritten — with the library's *old* classes still inside. Everything says the build worked: the
reactor is green, the jar's modification time is seconds old, `cedarcli native status` reports the
binary `current`, and a `dependency:build-classpath` scan finds only the new library. The service then
runs the old code. The tell is inside the jar rather than around it, and this is how to see it:

```bash
unzip -l cedar-artifact-server/cedar-artifact-server-application/target/*-SNAPSHOT.jar \
  | grep 'org/metadatacenter/server/jsonld/LinkedDataUtil.class'
```

An entry dated days ago in a jar built moments ago is the whole diagnosis: shade preserves each
entry's timestamp from the jar it copied, so the date names when that class was compiled rather than
when it was packaged. `mvn clean install` in the consuming repository fixes it. `cedarcli build java`
is unaffected — it passes `clean` — so this bites exactly when rebuilding one server by hand to try a
library change, which is the common case while developing one.

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

Only the deployable modules shade. The shared libraries publish thin jars — as of 2026-08-26,
the two HTTP parameter-constant classes formerly released from `cedar-rest-library` live in
`cedar-model-library`, and the REST library is retired from the build and release trains.
`cedar-config-library` and `cedar-core-library` likewise publish only their own classes. Before the
thin-jar cleanup these libraries declared the shade plugin themselves, so `cedar-config-library`
shipped 12,516 classes, and `createDependencyReducedPom`
dropped the bundled dependencies from the published pom, leaving a consumer to resolve Jackson, Guava
or another CEDAR library out of whichever jar its classpath reached first. Keep a library thin: its
pom should declare what it uses and publish that, so every consumer resolves each dependency from the
artifact that owns it.

## How the REST API changes

CEDAR ships one version of its REST API. There is no path segment, no media-type parameter and no
version header, and none is planned: a correction to a status code, an error body or a route replaces
the old behaviour for every caller at once, and the clients move in the same release.

That is already the policy in practice. Requiring `If-Match` on artifact updates turned a request that
answered 200 into one that answers 428, and it shipped without an opt-in. Adding a version mechanism
now would describe a caution the estate does not otherwise exercise.

What the policy asks in exchange is that a breaking change is deliberate and swept. A change to what a
client receives moves in one release together with the Template Editor, the embeddable editor, the four
MCP servers under `mcp/`, `cedar-cli`, and the `ops/e2e` suites. The REST smoke's pinned inventory in
`rest/expected-checks.json` names every expected check, so regenerating it with `--update-inventory`
turns the sweep into a diff to read rather than a search to conduct.

Two consequences worth stating. External callers hold API keys and get no migration window, so a
breaking release needs a note that reaches them. And a correction that can be made additively should
be: accepting a second spelling of a parameter, adding a field to an error body, adding a `GET`
alongside an existing `POST`, or sending a header nobody reads yet costs no caller anything and needs
no release to be coordinated around it.

The committed `swagger.json` and `swagger.yaml` in each server are the machine-readable side of the
same contract. Maven regenerates them from the resource annotations and `src/main/swagger/openapi-base.yaml`
during `prepare-package`; a source change and its generated documents belong in one commit. Adding an
OpenAPI-only `@RequestBody`, response `content`, or documentation schema does not change JAX-RS body
binding, content negotiation, Jackson serialization, or an HTTP status. It does change regenerated
client source: an untyped `Object` or `void` result can become a concrete return type, and a formerly
implicit body can become a typed method argument. Treat that as an SDK compatibility change even when
the bytes on the wire did not move. Never add a JAX-RS method parameter merely to make the generator
see a body, and keep open JSON-LD artifacts open with `additionalProperties: true` rather than publishing
a closed schema the server does not enforce. Focused `OpenApiContractTest` classes pin the high-value
request and response schemas in resource, artifact, group, messaging, and worker server CI.

## Artifact write and diagnostic contracts

Artifact creation and replacement use different authorization checks even though both can arrive as
`PUT /.../{id}`: an absent id requires that artifact type's `CREATE` permission, while an existing id
requires `UPDATE`. Do not collapse this back to a route-level update check; custom roles need the
distinction even though the default roles normally grant both permissions.

Every successful artifact create, single-artifact read and update returns a strong revision `ETag`.
The read service derives the public content and revision from the same Mongo document, so the ETag
can never describe a newer replacement than the body it accompanies.
An update of an existing artifact must send that exact value in `If-Match`:

```text
GET /templates/{id}             -> ETag: "7"
PUT /templates/{id} If-Match:"7" -> ETag: "8"
```

A missing `If-Match` returns `428 Precondition Required`; a stale value returns `412 Precondition
Failed`. The Mongo replacement predicates on both `@id` and the internal `_cedarRevision`, so the
check remains atomic when two requests pass the HTTP read check at the same time. Legacy documents
without the internal field read as revision zero and acquire revision one on their first conditional
update. `_cedarRevision` is storage metadata and must never appear in public artifact JSON.

The shared AngularJS backend service stores the ETag on each in-memory artifact representation and
adds that representation's value to its later `PUT`. Do not replace this with a URL-global latest
value: two in-page editors can hold different representations of the same URL, and borrowing the
newer editor's ETag would recreate lost updates. Internal server read-modify-write operations must
likewise forward the ETag from their own preceding `GET`; fetching a fresh ETag immediately before
writing would defeat the concurrency guarantee. CORS allows the `If-Match` request header and exposes
the `ETag` response header to browser JavaScript.

Template-instance validation is unconditional. `skip_validation=true` remains accepted only for
wire compatibility and does not bypass validation or storage checks. If a privileged bypass is ever
needed again, introduce a separately authorized internal operation rather than reviving the public
query switch.

A green health check means a server's dependencies answer, not that its process is alive. Two
outcomes are available when a probe fails, and `CedarDependencyHealthCheck` names them. A *gating*
dependency is one the server cannot serve requests without, and its failure makes the server
unhealthy. A *reporting* dependency is one whose loss degrades the server without stopping it: the
condition goes into the health message and the result stays healthy. The distinction has a cost
attached, because `cedarcli native health` and `cedarcli docker status` exit nonzero unless every
check passes and both runbooks gate deploys on that. Gating a dependency the server survives without
blocks a deploy for a condition nobody needs to act on, which is the case `CompToxHealthCheck`
argues at length for the Bridge server's view of the EPA registry.

The shared bootstrap probes what every microservice opens. Neo4j is gating: it resolves the caller
of every authenticated request, so a server that cannot reach it can serve nothing. The Redis
application log queue is reporting: enqueueing is best-effort by design and drops events rather
than failing the request that produced them. Every server therefore carries `neo4j` and
`app-log-queue` in addition to Dropwizard's own `deadlocks`.

Servers add what they own on top of that. `initMongoServices` builds the document-store probe and
the shared bootstrap registers it, so artifact, repo, openview and monitor each carry `mongo`.
Dropwizard's Hibernate bundle registers `hibernate` wherever a server opens MySQL, which is
messaging, monitor and worker. Resource and valuerecommender gate on `opensearch`, both being
unable to answer without their index. Submission gates on `ncbi-submission-queue`, whose contents,
unlike the log queue's, cannot be dropped. Terminology's `ontology-catalogue` reports the size and
name quality of the loaded catalogue. Bridge's `comp-tox` reports the EPA registry's condition and
never fails on it.

Each probe carries its own timeout, and the reason is specific: the Neo4j driver waits 30 seconds to
establish a connection by default, while a container health check gives the whole endpoint 10. An
unbounded probe would not report a slow dependency, it would hang `/healthcheck` itself, and the
container would read as down for a reason no check names. At most one probe runs at a time per
check, so a permanently blocked dependency costs one thread rather than one per poll.

Worker health is also work-aware. Its `queue-consumers` check fails when a processor thread stops,
its latest processing attempt remains failed, a dead-letter list is nonempty, or Redis cannot report
dead-letter depth. A green worker means its datastores answer and all four consumers can still make
clean progress.

The report is served on both connectors. Dropwizard serves it on the admin connector, which is bound
to loopback so that `/metrics` and `/threads` stay off the network, and which the container health
check curls on localhost. `CedarHealthCheckResource` serves the same body and status on the
application connector, because under Compose every server is its own host and the Monitor's
cross-service health page could otherwise reach no server but itself. That route is gated on
`MONITOR_READ`, as the insight routes are and for the same reason: nginx proxies the application
connector to a public host, and a health report names every dependency a server holds and quotes the
error text when one is unreachable. Insight endpoints are operationally sensitive in the same way:
`/insight/thread-details` exposes stack and thread state and requires the same role.

Inclusion-subgraph regeneration is a tracked single-flight worker job. An authorized
`POST /command/regenerate-inclusion-subgraph` returns `202 Accepted`, a job document, and a
`Location` header for `GET /command/regenerate-inclusion-subgraph/{jobId}`. While that job is queued
or running, another POST returns `409 Conflict` with the active job and the same status location.
Status records expose queued, running, succeeded and failed states, including timestamps and an
error for failures. The latest 100 records are retained in worker memory, so a worker restart loses
history and interrupts a running regeneration; resubmit after confirming the old process stopped.

## Testing CEDAR

Every server's default test suite runs backend-free: no live Keycloak, Neo4j, Mongo, MySQL, Redis or
OpenSearch. The shared `cedar-microservice-libraries/cedar-test-support-library` supplies in-memory authentication
(`TestAuthUtil` / `InMemoryUserService`, exercising the real API-key path) and embedded backends
(in-process Neo4j via neo4j-harness, Mongo via Flapdoodle, MariaDB via MariaDB4j standing in for
MySQL). Nor does any suite need an external service. The tests that do call one are tagged and
excluded from the default build by their application POM: terminology excludes `bioportal` (61 tests
across six resource classes) and bridge excludes `datacite` (`DataCiteResourceTest`). Clear the
exclusion with `-DexcludedGroups=` to run them against the real service. Their CEDAR variables must
still be set even when the tests are excluded, because the configuration substitutes them as it
loads; a placeholder value is enough.

Search is the deliberate exception in CI. `cedar-microservice-libraries` and
`cedar-resource-server` run `verify -Popensearch-it` against a disposable OpenSearch 2.19.1 service.
The library integration test executes the materialized user/everybody permission filter,
grant/revoke materialization changes and a point-in-time continuation walk against the engine. The
resource server integration test sends real `/search` and `/search-deep` requests through
Dropwizard to the same engine. For a local reproduction, start the native infrastructure and run
the matching module with the profile; the usual `CEDAR_OPENSEARCH_HOST` and
`CEDAR_OPENSEARCH_REST_PORT` select the engine and default to `127.0.0.1:9200`. The tests use
disposable or run-unique documents and clean them afterward.

Backend-free Maven tests suppress the application-log queue through the
`cedar.test.suppressAppLogQueue` system property inherited from `cedar-parent`. This is deliberate
test harness behavior: pointing Redis at a dead port while leaving the logger active turns every
request into a connection timeout and can make the HTTP client time out first, producing broken-pipe
failures unrelated to the behavior under test. The queue and logging libraries test Redis delivery,
outage and recovery separately against an embedded real Redis. The property exists only in Maven
test JVMs (Surefire by default and the resource-server OpenSearch Failsafe profile); native and
deployed servers retain the production queue behavior.

The same inherited Surefire configuration pins both CEDAR Redis hosts to `127.0.0.1` and both ports
to the deliberately dead port `1`. Other best-effort queue paths can therefore exercise an absent
Redis without inheriting a developer profile's remote address and waiting for a network timeout.
Dedicated queue tests bypass the CEDAR environment and point their service directly at their
embedded Redis instance.

Surefire also sets `cedar.test.dependencyTimeoutMillis=1000`. The Mongo and Neo4j client factories
honor that property only when it is present: Mongo server selection/connection and Neo4j pool
acquisition and transaction retry therefore reach the same unavailable-dependency exception paths
in about one second instead of the production drivers' roughly thirty-second defaults. Neo4j keeps
a separate five-second floor for initial Bolt connection establishment; a healthy embedded server's
first handshake exceeded one second on a constrained CI runner, so treating that startup latency as
an outage made the suite flaky. Local dead ports still refuse immediately, and the outage HTTP tests
carry five-second request deadlines. Normal JVMs have no property and retain the production
timeouts.

Worker processor tests inject short poll and retry intervals directly; the public constructors
retain the production five-second value-recommender poll and one-second handling retry. This
shortens the clock without skipping the queue state transitions or the retry/dead-letter assertions
the tests exist to cover. Blocking Redis consumers retain their one-second idle wait even in tests,
which is what a consumer spends between claims when its queue is empty.

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

Rough suite sizes: artifact 1334 (parameterized CRUD over four artifact types on embedded Mongo),
server-rest 281, workspace-operations 182, search-operations 208, artifact-library 800,
terminology 246 (61 more excluded under `bioportal`), model-validation 220, resource 63,
cadsr-tools 70, core-library 57, user 23, group 15, messaging 15, bridge 57, monitor 8, and a
one-to-seven-test boot-and-config tier on the remaining thin servers.

### Reproducing a Flake That Depends on Class Order

Test classes share a JVM, so process-wide state outlives the class that set it. A test that holds a
static field or a singleton past its own end decides what the next class sees, and JUnit 5 fixes
neither class order nor method order in a way a reader can predict. Such a suite passes locally,
passes five CI runs, and fails the sixth.

Surefire pins both halves of that order. `-Dsurefire.runOrder=alphabetical` and its
`reversealphabetical` counterpart fix which class runs first, and
`-Dtest='Leaker#theMethodThatLeaks,Victim'` fixes which method runs last before the victim. An
intermittent failure then either happens on every run or on none.

Running the whole suspect class first often proves nothing, because state usually escapes from
particular methods rather than from all of them. The job-claim tests show it. Most of their claims
sit at a fixed instant in the past, which any deadline-gated cleanup already clears, and only the
single method claiming at the wall clock leaves a claim that survives one. Name that method rather
than its class, and run both orders after a fix rather than only the order that failed.

Suites that boot an application need the CEDAR variables the CI workflow supplies, and `env:` in a
repository's `.github/workflows/ci.yml` holds them. Sourcing those values runs a suite without a
developer profile's pointers to live services. Each value has to arrive verbatim.
`CEDAR_TRUSTED_FOLDERS` carries backslash-escaped quotes, and `cedar-main.yml` substitutes it into a
double-quoted scalar, so an unescaped quote closes that scalar early. Dropwizard reports the parse
error that follows as `Could not read the CEDAR configuration file cedar-main.yml`, which reads like
a missing file.

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
| REST smoke | 1 | The real stack, no browser: 19 suites, 803 expected checks |
| End-to-end smoke | 1 | The real stack, through a browser |

**The browser smoke is green as of 2026-08-29 in both monolith and authenticated split-frontend
modes.** It logs in through Keycloak and treats browser-observed request and response headers as part
of the acceptance contract. In Workspace it conditionally renames and deletes a folder, replaces its
permissions twice, updates a group twice, replaces that group's membership twice, and conditionally
deletes the group. It also opens and closes a folder while checking inherited anonymous access,
moves an artifact and a folder through the real destination-picker modal, and enables and disables
OpenView on an artifact; all six commands must send `If-Match` and return an `ETag`. In Designer it
creates a template with a DOID-constrained field and a text field,
saves the same open template twice without reloading, and proves the second `If-Match` is the first
update's returned `ETag`. It then fills and saves an instance, reopens and updates it, checks the JSON
and YAML getters, opens the result anonymously through OpenView, and conditionally deletes the
temporary artifacts through the UI. A failed run can stop before teardown and leave its folder,
template, field, instance, mutation folder or mutation group behind;
`ops/e2e/cleanup-smoke-leftovers.mjs` removes timestamped artifact leftovers, while the smoke's own
catch path removes every fixture whose identifier it acquired before the failure.

`ops/e2e` holds the two whole-stack tests, and they answer different questions. `npm run smoke:rest`
drives the REST API directly, in about 65–80 seconds, and reaches what no unit suite can: the artifact
write path (which proxies, so the per-service suites cannot follow it), publish and create-draft,
whether the graph and the artifact server agree, and the things a real running stack does that an
embedded one cannot. It authenticates through Keycloak's password grant using the credentials already
in the profile, so there are no API keys to keep. Run one suite with `npm run smoke:rest -- <name>`;
the suites are `apidocs`, `artifacts`, `authentication`, `categories`, `contract`, `download`,
`finding`, `folders`, `freeze`, `group-sharing`, `groups`, `inclusion`, `negotiation`, `openness`,
`pagination`, `search`, `sharing`, `validation` and `versioning`. The committed
`rest/expected-checks.json` inventory holds 803 exact suite/section/check identities; a passing run
must execute that same ordered inventory, so an early return, removed loop or conditional omission is
a failure even when every check that did run passed. Freeze keeps the inventory stable when the local
terminology store is absent by recording its seven checks as skipped rather than silently omitting
them. `download` includes JSON / YAML / compact-YAML export and read-negotiation across all four
artifact kinds.

Every run writes `reports/rest-smoke.json` by default; `--report=PATH` chooses another file. The JSON
records the selected suites, pass/fail/skip totals, duration, inventory verdict and each individual
check for CI artifact upload. A deliberate coverage change regenerates the inventory only from a
clean pass:

```bash
npm run smoke:rest -- --update-inventory
```

The runner refuses to replace the inventory after a failure or interruption. It also inventories
timestamped smoke folders and categories before and after the run, failing if an earlier run leaked
state or the current teardown did not restore the baseline.

An interrupted run still cleans up after itself. `SIGINT` or `SIGTERM` stops it at the next suite
boundary, the teardown a finished run performs runs anyway, and the verdict is `INTERRUPTED` with exit
130 rather than a pass covering only the suites that ran. A second signal exits at once and forgoes the
cleanup, which is the way out of a suite that will not return. Before this, a killed run stranded its
whole working subtree. Thirty-two artifacts from one such run sat in the first user's home for thirteen
hours, through several later runs that each cleaned up after themselves and reported success. Tearing
down from inside the signal handler was tried and is the wrong shape: installing a handler suppresses
the default exit, so the run carries on while that cleanup deletes artifacts out from under suites still
using them, which surfaces as a screenful of unrelated failures and a working folder that cannot be
deleted.

Teardown also reports what it was never told about. Every folder and artifact a POST mints is recorded
against the suite that was running, and anything created but never registered for deletion is named,
attributed to that suite, and swept. Every suite registers correctly today, so this reports nothing;
what it buys is that a suite which forgets cannot leak inside a run that passes.

Attributing a leftover starts with the timestamp in its name, and that timestamp is UTC. `REST Suites
2026-08-19T04-27-53` was created at 21:27 the previous evening in Pacific time, seven hours earlier
than it reads, which is enough to credit one run's mess to another.

`ops/e2e/cleanup-smoke-leftovers.mjs` finds and removes them. Run with no arguments it reports what
it found and deletes nothing; `--apply` deletes. It keys on that same run stamp, and a stamped folder
carries its whole subtree, so an artifact the suites created inside a working folder without stamping
its own name goes with it. Deletion follows dependency order: instances before the templates they
populate, elements and fields after the templates that embed them, folders last and deepest first,
since a folder still holding anything cannot be removed. A JSON list of `[type, name, id]` triples
still deletes exactly those, for when a run has already named its casualties.

**It covers the category tree, which sits outside the folder tree.** Two stray categories from that
interrupted run survived a cleanup that walked only folders, and were found the next day in the
Workbench's category filter rather than by anything that reported on the run. Deleting one needs
`CEDAR_ADMIN_USER_API_KEY`, since a category belongs to the administrator who created it, and the
tool refuses rather than half-finishing when the key is absent. Matching is by the stamp in the name
and not by `schema:identifier`: the suite that exercises renaming leaves the parent category's
identifier null.

Anything younger than fifteen minutes is reported and skipped, because a run still in flight names
its working folder exactly as a dead one did and two sessions share this stack. `--min-age=0`
includes it, which is what to pass when the run is known to be over.

### REST performance testing

`ops/e2e/rest-perf` is the k6 load harness for the real REST stack. It is deliberately separate from
the REST smoke: the smoke proves the complete contract once, while this harness repeats a bounded
representative workload and records latency, error and concurrency behaviour. Install k6 once on the
development host (`brew install k6` on macOS), source the native profile, and choose a local password
that is not committed:

```bash
export CEDAR_HOME=/Users/martin/CEDAR
CEDAR_PROFILE=develop source "$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
export CEDAR_PERF_USER_PASSWORD='choose-a-local-password'
cd "$CEDAR_HOME/cedar-development/ops/e2e"
```

Every performance command first ensures the 50-identity pool exists. This idempotent phase creates
`restperf-001@test.com` through `restperf-050@test.com`, assigns the normal realm role, performs a real
`cedar-angular-app` password grant, and waits until CEDAR has created each user, Everybody membership
and home folder. It also repairs a fresh install or system reset and resets the pool to the supplied
password. The phase completes before fixture setup and k6 measurement. `test1@test.com` and
`test2@test.com` remain smoke identities and receive no performance-fixture grants. The generated
non-secret inventory is ignored under `reports/rest-perf/users.json`.

The provisioning command remains useful as a standalone preflight, but is not required before a load
command:

```bash
npm run perf:rest:provision -- --count=50
```

The seven load profiles are:

| Command | Default shape | What it exercises |
|---|---:|---|
| `npm run perf:rest:quick` | 10 identities, ramp 1 → 5 → 10 → 0 in 4.5 minutes | Artifact reads, folder listings, search, conditional artifact updates, conditional moves, and OpenView toggles |
| `npm run perf:rest:contention` | 20 identities, three complete matrix rounds | Twenty-way compare-and-swap races across artifact content, workspace graph state, ACLs, group records and membership, and categories; update/delete, repeated-delete and wildcard/delete cases use sacrificial fixtures |
| `npm run perf:rest:hotset` | 20 identities and 20 VUs for 10 minutes | Sustained independent GET/conditional-mutation loops over a small shared set of templates, elements, fields, instances, folders, groups and categories; both conflicts and successful forward progress are required |
| `npm run perf:rest:resilience` | 10 identities and 10 VUs for 90 seconds | Independent artifact reads and conditional updates while resource-server is stopped for five seconds and restarted; the run requires an observed outage and at least 20 successful responses after the recovery budget |
| `npm run perf:rest:churn` | 10 identities, two complete lifecycles per second for 5 minutes | Low-rate POST → GET → conditional PUT → conditional DELETE → verified `404` turnover, distributed reproducibly across templates, elements, fields and instances |
| `npm run perf:rest:burst` | 50 identities; 5/s baseline, 40/s burst, then 5/s recovery, 30 seconds each | Reproducible artifact reads and conditional updates across all four artifact kinds; requires no dropped arrivals and post-burst p95 to return near the measured pre-burst baseline; the full pool prevents a brief server stall from exhausting the load generator first |
| `npm run perf:rest:soak` | 50 identities and 50 VUs for 30 minutes | A steady, non-destructive mix across template, element, field and instance reads and conditional updates; folder listing, search, moves and OpenView; artifact and folder ACLs; group records and membership; and category records and ACLs |

`--users=N`, `--vus=N` and `--duration=10s` override those defaults. `--seed=NAME` makes the soak's
per-user schedule reproducible; without it, the run ID is the seed. The contention profile also
accepts `--rounds=N`; its `--duration` is a maximum rather than a steady-state duration.
The resilience profile accepts `--fault-delay=N`, `--fault-downtime=N` and
`--recovery-budget=N`, all in seconds. Its duration must leave at least ten seconds of traffic after
the recovery budget. The package command deliberately supplies `--allow-service-restart=true`; a
direct resilience invocation without that explicit opt-in is refused.

The churn profile accepts `--churn-rate=N` (default 2 and capped at 20 complete artifact lifecycles
per second). Its constant-arrival-rate executor fails the run if the selected VU ceiling cannot keep
up rather than silently reducing the intended pressure. Each dynamic artifact is created inside the
participant's stamped run root and deleted immediately. Teardown recursively inventories every run
root before removing the setup manifest, deleting any dynamic artifact left by an interrupt between
creation and deletion; it never searches or deletes outside those roots.

The burst profile accepts `--baseline-rate=N`, `--burst-rate=N`, `--phase-duration=30s` and
`--recovery-p95-percent=N`. The burst rate must exceed the baseline. Three non-overlapping
constant-arrival-rate phases use the same operation mix, with a five-second graceful boundary between
them. Besides the ordinary correctness and no-drop thresholds, the controller reads the completed
summary and fails unless recovery p95 is at most the greater of the configured percentage of
baseline (150% by default) or baseline plus 100 ms. That relative check distinguishes genuine
post-load degradation from a universally slow or universally fast run.

Every profile reports server-wait and client-blocked p95/p99/max components in addition to route
latency. Requests taking at least 500 ms emit a timestamped diagnostic with the operation, status,
timing components, VU and iteration; `--slow-request-ms=N` changes that boundary and
`--slow-request-log-limit=N` caps the output per VU (three by default). These diagnostics distinguish
a backend pause from connection-pool or load-generator delay without turning an ordinary run into a
trace dump.

For a backend concurrency qualification, run contention first, then churn, resilience, burst and the
requested soak, one at a time against an otherwise idle stack. Use a named seed for each recorded run
and keep the default rates unless the purpose is explicitly capacity finding. A green run requires the
correctness and route thresholds, the profile-specific progress/recovery checks, and successful
teardown; a low aggregate p95 does not excuse a failed route or recovery gate. If total latency is
almost entirely `waiting` while `blocked`, connection and TLS time remain near zero, correlate the
timestamp with the native service and datastore before changing a threshold. In particular, Neo4j
transaction-log force latency can hold a resource-server graph update at commit even when resource
and Neo4j GC pauses are negligible. Preserve durability and treat a repeatable phase-level breach as
a storage/backend finding; an isolated maximum that leaves the p95 and recovery gates green is useful
tail evidence, not a reason to fail the run by inspection.

The 2026-08-29 qualification exercised all ETag-enabled artifact kinds and the workspace, ACL,
group, membership and category mutation routes. Churn completed 601 full create/update/delete
lifecycles without interruption; dependency resilience completed 15,927 iterations, including 442
expected outage responses and 10,447 recovered operations, with no unexpected response. The final
burst completed 1,501 iterations with no failed checks or dropped iterations; operation p95 was
170.9 ms, server-wait p99 was 285.5 ms and the recovery p95 remained below its gate. Fixture cleanup
reported no residue. Together with the completed 30-minute soak and 20-minute stress runs, this is
the current native-stack performance baseline. The burst profile's 50-user pool is identity and VU
capacity; it does not mean that fifty requests execute continuously throughout an arrival-rate run.

A 30-minute soak is the routine qualification gate. Do not run an overnight soak merely to repeat
the same concurrency coverage: contention, churn, resilience and burst create useful failure modes
far more efficiently. Use a six-to-eight-hour soak when investigating a suspected slow heap,
connection, queue or fixture leak; after a material change to caches, pools, asynchronous workers,
storage or deployment topology; or when production telemetry shows latency or resource use drifting
over hours. Such a run needs an otherwise idle host and observation of heap/RSS, garbage collection,
queue and outbox depth, database/storage latency and cleanup residue at both the beginning and end.

`--pool-size=N` can raise the
ensured identity-pool floor above 50, while a larger `--users` value always expands the pool to fit.
A VU count may not exceed the selected identities: independent writers must not accidentally contend
merely because the runner reused an account. The identity ensure phase and initial authentication
happen outside the measured workload; expired tokens are refreshed during a long soak. `412` is
expected only in the contention and hot-set profiles. Category setup and administrator-only ACL mutations use
the administrator key loaded by the native profile; it is never stored in a manifest or summary.
The soak gives every VU its own artifacts, folders, group and category, and executes a 24-operation
mix that is half pure reads/list/search and half conditional mutations. Each complete cycle preserves
that exact mix but shuffles it deterministically by seed, identity and cycle, with a per-identity phase
offset. This avoids synchronized VUs while keeping failures replayable: error lines name the seed, VU
and iteration, and the JSON summary records the seed. ACL operations alternate real
grant and revocation transitions for a paired identity, then verify both the stored permission set and
that identity's resulting access. Group membership likewise alternates join and leave against a folder
with a stable group grant, proving that the membership transition changes effective access rather than
merely accepting an unchanged roster. Category ACLs alternate a peer's write grant and revocation and
verify that the peer gains and loses access to the ACL. Any semantic mismatch fails the run through a
zero-tolerance invariant metric. The soak deliberately excludes
create/delete churn, update-versus-delete, repeated DELETE and wildcard deletion: those operations
belong to the bounded contention matrix, where exact winner/loser outcomes and cleanup can be asserted
without corrupting the steady-state latency and resource-leak signal.
Mutation bodies are parsed afresh from the wire representation before editing. Do not mutate the
object returned by k6's cached `Response.json()` and assume the outgoing body changed: a replacement
PUT can validly advance the ETag even when that cached object left the serialized body unchanged.

The hot-set profile is the bridge between the finite contention matrix and the long independent soak.
Its users continuously race on seven shared revision domains. Each successful write must return the
submitted state and advance exactly one revision; each loser must receive `412`. The run fails if
fewer than one percent of mutations conflict, because it did not create a hot set, or if at least 95
percent conflict, because the test has stopped demonstrating useful forward progress. It creates no
sacrificial delete fixtures and teardown removes the bounded shared set normally.

The resilience profile is local-only even when ordinary performance runs have been allowed to target
a remote host. A sidecar waits until the declared fault time, stops only resource-server through
`cedar-services.sh`, holds it down for the bounded interval, starts it through the same controller and
waits for the admin health check. k6 accepts gateway failures only from one second before the fault
until the recovery deadline. It requires at least one such response, rejects any that escape that
window, and requires more than 20 successful responses after it. An interrupted sidecar restores
resource-server before exiting; the wrapper waits for that restoration before fixture cleanup.
Gateway failures impose 200–299 ms of deterministic per-VU backoff. Without it, a fast `502` path
turns a small constant-VU test into an accidental retry storm precisely while the service is down.
The aggregate latency guard remains broad (`p95 < 3 s`), but a fast route is not allowed to hide a
slow one. Every route exercised by the selected profile has a p95 threshold: ordinary reads,
preflights and verification requests are capped at 750 ms (2.5 s in the deliberately saturated
contention matrix); mutations are capped at 1.5 s, with 2 s for the quick mix, 2.5 s for shared
hot-set mutations and 5 s for the finite contention races. These are regression guardrails rather
than capacity claims: they sit comfortably above repeated quiet-host measurements while still
failing a several-fold route-specific slowdown.

Every participant gets one stamped root holding source and destination folders plus four templates:
read, mutable, movable and OpenView. Burst and soak runs add independently writable element, field
and instance fixtures. A soak also adds a group and category for each participant; the mutable
template and stamped root serve as that participant's ACL fixtures. A contention run instead creates a separate shared fixture for
each revision domain: all four artifact-content routes, artifact and folder graph records, artifact
and folder ACLs, a group record and membership roster, and a category record and ACL. Three bounded
sacrificial pools cover update-versus-delete, repeated delete and wildcard deletion for templates,
elements, fields, instances, folders, groups and categories. Setup writes every returned ID to
`reports/rest-perf/runs/<run-id>/run.json` immediately, before creating the next resource. k6 writes
its complete summary beside that manifest. In addition to the aggregate trend, each measured route
has its own `cedar_route_*_duration` trend so a fast read cannot hide a slow mutation.

The wrapper checks that k6 exists before setup, then always performs teardown after the load process,
including a failed threshold or first `SIGINT`/`SIGTERM`. Teardown reads the current ETag, deletes in
reverse dependency order, requires the verification GET to return 404, and lists every participating
home folder to ensure the run stamp is absent. A second signal is the explicit emergency exit that
forgoes remaining cleanup.

A machine crash and `kill -9` cannot run `finally`, so the independent janitor searches all 50 home
folders for the exact `CEDAR REST PERF User <n> <timestamp>-<nonce>` convention. It reports only by
default, ignores runs younger than 24 hours, refuses unexpected resource kinds, and deletes only with
`--apply`:

```bash
npm run perf:rest:cleanup
npm run perf:rest:cleanup -- --apply
# A known failed run can be included immediately:
npm run perf:rest:cleanup -- --min-age-hours=0 --apply
```

The Node-side naming, token-subject and concurrency helpers have a fast local gate:

```bash
npm run test:rest-perf
```

Unless `CEDAR_PERF_ALLOW_REMOTE=1` is explicit, both the Node setup and k6 refuse targets outside
localhost and the `.metadatacenter.orgx` development names. Do not use that override casually: the
harness is write-heavy by design.

**The artifact server is addressed on its port, not through a vhost.** Several checks read it directly
to confirm a write reached the datastore, and `artifact.${CEDAR_HOST}` answers 404: the artifact server
authorizes on global roles alone and holds no resource-level ACL, so anything that reaches it can read
or change any artifact in the installation, and both production and this host close that door. The
suites therefore default to `http://localhost:9001`, which is also why they must run beside the stack
rather than against a remote one. `CEDAR_ARTIFACT_BASE` overrides it — needed for the containerized
stack, where that service publishes no port at all and the checks cannot reach it from the host.

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

Two smaller browser smokes cover the frontends that one does not reach. `npm run smoke:frontend-cache`
checks all seven origins for a 200 and `Cache-Control: no-store` without credentials, which a
completely broken application still passes. `npm run smoke:frontend-app` signs in through Keycloak and
waits for Monitoring and Bridging to render content only their own components produce, failing on the
console errors an application cannot run through. That distinction is the point: the Angular 22 upgrade
left OpenView building clean and dying at bootstrap with an injector error, which every gate then in
place reported as green.

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
- **Dependency coverage is partial but deliberate.**
  The shared proxy, exception mapper, worker queues and health checks are covered, with real HTTP
  dead-port tests for artifact/MongoDB, resource-to-artifact, monitor-to-artifact, user and group
  Neo4j reads, value-recommender and resource OpenSearch reads, the messaging SQL store and the
  Keycloak admin lookup, monitor Redis reads, bridge external-authority HTTP, the resource graph and
  OpenView's store boundary. There is no HTTP application-log read: log persistence is an app-log
  worker concern and its retry/dead-letter path is covered. Resource index rebuilds are accepted
  asynchronous jobs whose failed status is covered rather than synchronous requests that can answer
  503.

  The remaining direct clients deliberately do something else. Publishing asks terminology to pin
  controlled-term versions, but the resolver is fail-safe: it leaves that pin absent and increments
  `skippedResolutionCount` when terminology is unavailable. Monitor's Keycloak user detail is a
  diagnostic assembled from several stores, so it logs the Keycloak failure and returns that section
  as unavailable without discarding the other sections. Submission notification and FTP traffic runs
  after queue acceptance in background submission processing, not as a synchronous HTTP dependency.
  DataCite is the exception still needing work: its minting client and recovery behavior belong to the
  explicit DataCite lifecycle roadmap item rather than a dead-port-only degradation test.

  Concurrent edits are covered both over HTTP and directly at the Mongo compare-and-swap boundary.
  Pagination is covered on a folder's contents and search (`pagination` suite); the other paged
  listings are not.

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
cedarcli native restart          # ALL 22 — pass no names
cedarcli native health           # exit 0 only if all healthy
cedarcli native status | grep STALE \
  || echo "every service current"                          # nothing on an old jar or an old editor
cd $CEDAR_HOME/cedar-development/ops/e2e && npm run smoke
```

Pass `restart` no service names. With no arguments it restarts everything the script manages,
which includes the three gulp frontends and the four `ui-*` frontends, not only the 15 Dropwizard
services. Naming services explicitly narrows that and is easy to get wrong: a list of the Java
services alone leaves the frontend running whatever it started with, so the gate cannot catch a
frontend regression at all. Gate on `health` rather than reading the status table. It no longer
waits on the bridge: a CompTox registry that has not loaded leaves the bridge healthy and says so in
its health message, so an EPA outage cannot block the gate (see the PFAS `503` entry above).

A full `restart` is slow (it stops and starts 21 processes) and can be cut short — a shell timeout,
an interrupt — partway through, leaving some services on the previous build. So after it, run
`status` and confirm the **BINARY** column reads `current` for every service (see the BINARY/`~pid`
explanation above); a `STALE` warning means that service kept its old jar. Restart just the
stragglers by name — `cedarcli native restart <name...>` — and re-check. A `health` gate alone
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
`BMIR_NEXUS_PASSWORD` repository secrets, `./mvnw --update-snapshots verify`, and the surefire reports
uploaded whatever the outcome. The search-library and resource-server workflows also upload their
Failsafe reports, add the `opensearch-it` profile and an OpenSearch service; other component
workflows remain backend-free. Jobs carry a hard timeout: twenty minutes for a component, thirty
for those two OpenSearch jobs, forty-five for `cedar-project`, which builds nineteen repositories
in one reactor.

Two repositories are aggregators over `../` sibling paths that a lone checkout cannot satisfy, so
`cedar-libraries` and `cedar-project` check their component repositories out beside themselves in
the workspace and run Maven from the aggregator directory.

Each of those workflows gives its tests the same block of `CEDAR_` environment entries, because a
suite builds a real `CedarConfig` and a variable a component declares but does not receive stops it
at the first `getInstance`. The block lives once, in `ops/ci-env-block.yml`, and each `ci.yml`
carries a copy. `ops/check_ci_env.py` asks `CedarConfigEnvironmentDescriptor` through `jshell` what
the servers actually declare, checks the block still satisfies it, and compares every copy against
the block; `--apply` rewrites the copies that have drifted. Run it after adding a variable to the
descriptor, and after any change to a workflow's environment:

```bash
ops/check_ci_env.py            # report
ops/check_ci_env.py --apply    # rewrite the drifted copies
```

It is the same instinct as `check_docker_env.py`, pointed at the other set of copies: ask the code
rather than reading the declaration by eye. Twenty-two repositories held their own copy and nothing
compared them, so they had diverged — `cedar-monitor-server` carried 55 of the 118 entries, missing
`CEDAR_SALT_API_KEY`, `CEDAR_TRUSTED_FOLDERS` and both test-user identifiers among sixty-three
others. Nothing runs this in CI yet, because a check over every repository has no natural home in
any one of their workflows; until it does, it is a local step.

Most suites need no service container. Search-library and resource-server CI intentionally use
OpenSearch to verify permission-filter semantics rather than merely the shape of a mocked request.
Two other exceptions both come from a real dependency rather than from CEDAR code:
`cedar-monitor-server` talks to a live MySQL, so its job runs a disposable
MySQL 8 service, and the embedded MongoDB that `cedar-artifact-server` boots is the 5.0 line the
deployment runs, whose only Linux build links against OpenSSL 1.1. Ubuntu 24.04 ships OpenSSL 3, so
that job installs `libssl1.1` on the runner first; without it `mongod` cannot start and every
resource test errors out. Moving the tests onto a newer MongoDB would drop that step, at the cost of
testing against a different engine than production runs.

### Snapshot freshness

A merge to `develop` publishes that repository's snapshot to Nexus, and every downstream build
resolves CEDAR artifacts from Nexus rather than from a checkout. A repository whose commit is on
`develop` but whose snapshot never published is therefore invisible in the place anyone looks: its
branch is green and its source is right, while every consumer builds against the artifact it
replaced.

```bash
cedarcli check snapshots
```

It asks Nexus for each publishing repository's recorded timestamp and GitHub for the time of the
head commit on `develop`, and reports a snapshot that is older than its source, or absent. It exits
non-zero on either. An unreadable Nexus or GitHub is reported and does not fail the check, because
failing there would blame the estate's source for a fault in the network reaching it. The grace
period is two hours, so a build still running is not a finding; `--grace-hours` moves it.

`.github/workflows/snapshot-freshness.yml` runs the same command daily and opens an issue naming the
repositories, commenting on it while the condition lasts and closing it when every snapshot is
current again. It reports through an issue rather than a red run because a scheduled workflow that
merely goes red notifies whoever last touched it and nobody else.

What it is for happened on 2026-08-29. A Dropwizard upgrade landed in `cedar-parent`, its deploy step
met a Nexus 500, and the snapshot stayed a day old. Every Java repository's CI failed from then on,
resolving a parent that did not manage a dependency the new poms named, and every build train failed
with it. Four unrelated regressions — a Keycloak entrypoint that aborted on its own diagnostic, seven
frontend nginx configs that could not be parsed, stale CEE visual baselines, and the parent snapshot
itself — accumulated behind that one unpublished artifact before anyone compared the two sides. The
repair, when it was finally found, was to re-run the failed deploy.

When the check reports a repository, re-run that repository's failed CI run. If its deploy step is
what failed, the publication needs repeating rather than the source.

### Automated dependency updates

The Mend-hosted Renovate GitHub App runs for `cedar-parent` and `cedar-docker-build`. Both
repositories keep `renovate.json` on `main`, because the hosted app reads configuration from the
default branch, and on `develop`, where the actual work lands. `baseBranchPatterns` is set to
`develop`, so Renovate branches and pull requests must target `develop`, never `main`. Changes to a
config therefore need a config-only pull request to `main` as well as the ordinary `develop` commit.

`cedar-parent` is the Java dependency control point. Its config reads Maven through the CEDAR Nexus
pull-through proxy, avoiding Maven Central's hosted-runner rate limit; groups the Dropwizard,
Metrics, Jetty, Jersey and Hibernate baseline; does not offer Java 17 changes; and leaves Keycloak
updates behind dashboard approval. `cedar-docker-build` watches the locked server variables in
`bin/cedar-images-base.sh` through its custom manager as well as ordinary Dockerfile and Actions
references. It groups the locked server updates and keeps platform-changing updates behind
approval. Neither repository permits automerge, and both impose a fourteen-day minimum release age.

Each repository has a Renovate **Dependency Dashboard** issue for approving held updates and
retrying or rebasing branches. A scan can also be started from the repository's **Actions → Run
Renovate scan** control at `https://developer.mend.io/github/metadatacenter/<repository>`. The
**Create/Rebase** action discards manual commits on each selected Renovate branch before recreating
it, so select only branches whose edits are intentionally being replaced.

Validate either config with the same current Renovate generation the hosted service runs:

```bash
npm exec --yes --package=renovate@latest -- renovate-config-validator renovate.json
```

Every Renovate pull request runs the repository's normal suite. In addition,
`ops/check_version_pairing.py` runs in both `cedar-parent` and `cedar-docker-build` CI, checking the
client versions from the parent POM against the locked server images in the Docker manifest. That
check is the invariant Renovate cannot infer: a syntactically valid update is not safe when it moves
only one half of a client/server pair.

### Mutable development snapshots and immutable build trains

Twenty-seven of the repositories deploy their snapshot to Nexus at the end of a successful build.
The step is gated on a real push to `develop`, so a pull request verifies and stops, and a build
that fails publishes nothing. `cedar-libraries` and `cedar-project` are the exceptions: their
modules are other repositories, which publish themselves, and deploying from the aggregate as well
would give one artifact two publishers.

This matters more than it first appears. Everything downstream resolves CEDAR artifacts from Nexus
rather than from a checkout. Mutable `<NEXT>-SNAPSHOT` artifacts remain a convenience for ordinary
native development, where a developer expects the latest successful `develop` build. They are not
a deployment identity: the bytes behind one snapshot name can change at any time.

Docker and integration deployments use an immutable build train instead. `cedarcli publish train`
allocates a version such as `<NEXT>-dev.YYYYMMDD.HHMM`, captures the exact source commits, builds
parent, libraries, and services in dependency order, and publishes into the no-redeploy
`cedar-maven-dev` repository. Docker consumes that train version, never the mutable snapshot. A
failed job resumes only from its recorded source manifest:

```bash
cedarcli publish train
cedarcli publish train --resume <TRAIN_ID>
```

Create a new train, rather than resuming, when newer source commits must be included. The complete
procedure and Nexus state layout are in [BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md).

The verification asks for fresh snapshots (`--update-snapshots`) for the same reason from the other
direction. Maven checks a snapshot for updates once a day by default and the runner restores a
cached `~/.m2`, so without it a build can compile against a stale CEDAR jar for the rest of the day
after a dependency was republished. The flag costs one metadata check per snapshot dependency, and
when Nexus is unreachable it degrades to a warning and falls back to the cached artifact rather than
failing.

Publishing by hand is still occasionally needed — to seed a layer Nexus never had, or after work
that bypassed CI:

```bash
cd $CEDAR_HOME/cedar-<name> && ./mvnw --batch-mode deploy --settings .m2/nexus-settings.xml
# needs BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD in the environment
```

The extracted AngularJS frontends publish to the npm repository on Nexus, not through Maven. They
remain outside the release during migration and are excluded from the generic frontend/all
publish selectors. Publishing them therefore requires the explicit command and never changes a
running environment:

```bash
cedarcli publish split-frontends --dry-run
cedarcli publish split-frontends
```

That plan runs `npm ci` in exactly `cedar-workspace` and `cedar-template-designer`, then calls the
staging helper that publishes immutable commit-derived prereleases without changing either working
tree. npm cannot overwrite a `<NEXT>-SNAPSHOT` version like Maven; the published version is instead
`<NEXT>-dev.<UTC-commit-time>.g<12-char-commit>` and carries the full source commit as `gitHead`.
Each manifest's `publishConfig` selects the CEDAR Nexus npm repository. The command does not build a
Docker image, edit nginx, or start a frontend. The same helper accepts all seven Docker frontend
targets when their pinned image inputs need advancing.

To see whether a repository's published snapshot is behind its source, compare the Nexus timestamp
against the commits that touched the build:

```bash
curl -s https://nexus.bmir.stanford.edu/repository/snapshots/org/metadatacenter/<artifact>/<NEXT>-SNAPSHOT/maven-metadata.xml \
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

Four of those six moved on 2026-08-08, deliberately and as part of containerizing them for
development: Redis to 7.2.7, OpenSearch to 2.19.1, Mongo to 5.0.31 and Neo4j to 5.26.0, each set to
the version already running natively. MySQL and Keycloak have not moved.

**Keycloak is held at 22 by CEDAR's own code, not by the lock.** The current release is 26.7.1, and
the one thing in the way is `keycloak-adapter-core` — the legacy Java OIDC adapter, last published at
25.0.3 in August 2024 — which the bearer-token path of all fifteen servers is built on. Everything
else that was thought to block it does not: the admin client, the event-listener SPI and the login
theme are a coordinate change, no change at all, and two FreeMarker files respectively. The evidence
and the two routes forward are on the roadmap under upgrading the persistence and infrastructure
servers; do not restate them here.

Current framework baseline (Jakarta EE 10, all on Java 17): Dropwizard 5.0.2, Jetty 12.1.9, Jersey
3.1.11, Hibernate 6.6.52.Final, Servlet 6, Persistence 3.1 and Jackson 2.21.4. Recently modernized
client libraries: jedis 5.2, Apache HttpClient 5 (the exceptions are the OpenSearch low-level REST
client and the Keycloak event listener, which stay on HttpClient 4 because those external APIs
require v4 types), slf4j 2.0
with logback 1.5, swagger-core v3 (OpenAPI 3), mysql-connector-j 8.4, log4j 2.24, commons-lang3.

The test stack pins Mockito 5.23.0 and manages both `byte-buddy` and `byte-buddy-agent` at
1.18.8-jdk5 in `cedar-parent`. Mockito's own POM names byte-buddy 1.17.7; the newer managed pair is
intentional so Mockito and Dropwizard Hibernate share one version. Keep the core and agent
together, and verify a change against the complete `cedar-microservice-libraries`,
`cedar-bridge-server` and
`cedar-worker-server` reactors rather than compile alone. The current pairing passes all 1,083 tests
in those reactors with no failures, errors or skips.

JSON Schema validation uses the maintained networknt validator, not the abandoned java-json-tools
(FGE) fork. networknt's built-in `uri` and `date-time` formats are stricter than FGE's and would
reject valid CEDAR data (relative `@id` references, colon-less timezone offsets), so
`cedar-model-validation-library`'s `FgeCompatFormats` registers FGE-equivalent format checkers on the
Draft-04 meta-schema to preserve the exact accept boundary. The java-json-tools (FGE) fork is
otherwise fully removed — no module depends on it.

The **Jakarta EE 10 framework migration (Dropwizard 5) is complete.** `dropwizard-sundial` had no
Dropwizard 4 release and remains retired rather than forked: the worker and value-recommender
schedulers are plain `Managed` poll loops. Multipart upload uses
`commons-fileupload2-jakarta-servlet6`, and CORS uses Jetty's EE10 servlet package.

Two compatibility settings are deliberate. CEDAR artifact identifiers are IRIs encoded into path
segments and can contain `%2F`; Jetty 12 checks that ambiguity once at the HTTP connector and again
in the EE10 servlet handler. `CedarMicroserviceApplication` permits only
`AMBIGUOUS_PATH_SEPARATOR` in `UriCompliance` and enables ambiguous-URI decoding on the servlet
handler, rather than selecting Jetty's broad unsafe mode. Hibernate 6.6's grouped JDBC metadata can
otherwise match MariaDB system relations with the same name in another catalog, so the messaging
and database-logging bundles set `hibernate.default_catalog` to their configured application
databases. Messaging's physical `user` table is quoted, and its recipient/sender/user
find-or-create paths use one atomic `INSERT ... ON DUPLICATE KEY UPDATE` followed by the connection's
`LAST_INSERT_ID()`; this avoids the repeatable-read miss and concurrent gap-lock deadlock exposed by
the new Hibernate line.

The 2026-08-29 acceptance run used only locally installed CEDAR snapshots while Nexus was
unavailable. A clean 70-module reactor passed; dependency trees and all fifteen shaded jars were
free of active Jetty 11, Jersey 3.0, Hibernate 6.1, Servlet 5, Persistence 3.0 and Jetty EE9 runtime
content; all fifteen services booted healthy with `BINARY` = `current`; and `ops/e2e` passed the
real-stack smoke through login, live terminology, publication/versioning and instance
create/update/delete.

## Auditing production artifacts through REST

`ops/cedar_artifact_rest_audit.py` is the read-only counterpart to the Mongo/tree patch tool. Its
default, intentionally short safety pass enumerates every template and element visible to an API key
through `/search-deep`, fetches the full artifacts through their typed resource-server GET endpoints,
and checks the stored documents against the hardened minting and compatibility rules. `--types all`
adds standalone fields and instances for the longer whole-corpus inventory. Its HTTP client implements
GET only. It never calls validation by POST, never saves a sampled artifact, and never writes to CEDAR.

Keep the key out of shell history and the process list:

```bash
export CEDAR_API_KEY=…
python3 ops/cedar_artifact_rest_audit.py \
  --server https://resource.metadatacenter.org \
  --out production-schema-findings.jsonl
```

Use `--types all` for a full four-artifact-type run, or an explicit comma-separated subset such as
`--types template,element,instance`. The template/element default is the pass that detects stored
schema shapes capable of making CEE emit an instance the exact template then rejects.

The key may instead come from a one-line `--api-key-file`, or from a hidden prompt when the script is
run interactively. There is deliberately no `--api-key VALUE` argument. TLS verification is always
on; `--ca-file` adds a private CA, while `--allow-http` exists only for a loopback/local test server.
Redirects are refused so an authorization header cannot be forwarded to another origin.

The script reads the selected `/search-deep` totals, enumerates and deduplicates the selected IDs, and
then fetches the first artifact. Enumeration follows the continuation each page carries instead of
counting offsets, so one page is one request rather than one request plus everything in front of it,
and the whole pass reads a single snapshot of the search index. A server that predates continuations
answers the first page without one while reporting more rows than it returned; the script recognises
that and finishes the pass by offset. Either way the refs manifest and the summary record which ran,
under `paginationByType`. Each terminal checkpoint therefore reports `processed/total` against
the exact unique audit set, percentage, elapsed time and ETA, as well as both batch and cumulative
affected-artifact counts. The JSONL is streamed and flushed after every artifact,
and the adjacent `production-schema-findings-summary.json` is atomically checkpointed every **300
artifacts**. The adjacent `production-schema-findings-refs.jsonl` stores the exact enumerated refs and
an append-only completion record for every processed artifact. All three output files are owner-only,
and the streamed findings and refs paths refuse symlinks.
`--progress-every` changes the interval and `--limit` makes an explicitly labelled sample run. Ctrl-C
and request failures retain partial output. Resume the same audit without re-enumerating or truncating
findings by repeating the original arguments and adding `--resume`:

```bash
python3 ops/cedar_artifact_rest_audit.py \
  --server https://resource.metadatacenter.org \
  --out production-schema-findings.jsonl \
  --resume
```

Resume validates the server, selected types, limit, ruleset and exact script SHA against the refs
header. It skips completion records, and also treats an artifact ID already present in findings as
complete to close the small crash window between flushing its findings and recording completion.
Artifacts with no findings are still resumable because their completion lives in the refs sidecar.
A complete run normally exits zero even when it finds defects; `--fail-on-findings` makes findings
exit 1, while an incomplete run exits 2.

Every summary carries an audit ruleset version, SHA-256 of the exact script that ran, and the source
revisions whose reader and server behavior the rules mirror. It also separates counts of finding rows
from counts of distinct affected artifacts by rule, risk and artifact type. This prevents a long run
started before a script update from being mistaken for output produced by the updated rules.

Findings say what an ordinary update will do rather than flattening every problem into “invalid”:

- `repair-on-save`: inherited unusable/missing child property IRIs, child IDs, occurrence IDs,
  missing nested child `$schema` declarations, `@context.required` entries, unsafe attribute-value
  names, missing attribute property IRIs, repository-minted orphan terms and unusable inherited
  `pav:derivedFrom` values;
- `instance-save-rejected`: a checkbox, attribute-value or multiple-choice list deployment is
  object-shaped, so CEE's correctly emitted array cannot validate against the exact stored template;
- `save-rejected`: unusable root IDs, root/search-ID disagreement, missing or invalid root `$schema`,
  explicit invalid child `$schema`, unrecognised child types, malformed multi-instance children,
  child IDs caught in the server's trim-before-test gap, null/non-string value IDs, missing
  instance/occurrence contexts and unusable `schema:isBasedOn`;
- `reader-blocking`: empty link or controlled-term IDs rejected by both JSON readers, and malformed URI
  values rejected by the strict Java reader; these are deliberately outside CEE's occurrence-only
  compatibility adapter;
- `manual-review`: field/element ID-prefix contradictions and existing non-absolute attribute
  mappings, plus relative link/controlled-term IDs. Current readers accept a relative URI reference,
  but it is not an absolute JSON-LD identifier and cannot be repaired without understanding its
  intended namespace;
- `audit-incomplete`: an instance's template could not be resolved, so template-aware occurrence and
  attribute-name checks could not be finished.

Template shapes are retained in reduced form and used to distinguish real attribute-value fields from
arbitrary string arrays. This is what makes the blank/reserved/collision/duplicate checks match
`CedarValidator` rather than guess. A structural occurrence walk runs as a fallback, so bad occurrence
IDs are still found when a template is unavailable.

**“Complete” is intentionally qualified as `COMPLETE_FOR_KEY`.** `/search-deep` and every typed GET
are permission-scoped, so the result covers all artifacts the key can enumerate and read, across all
versions and publication states. It does not prove that an underprivileged key saw the deployment, or
that Neo4j/search and Mongo have not drifted. A complete instance-wide claim still needs a privileged
key plus a store/graph parity check; the Mongo patch tool is the authoritative store-side inventory.
If totals change or pages overlap during the run, the REST audit marks itself partial rather than
claiming a stable snapshot. Against a server that serves continuations the enumeration itself reads
one snapshot, so artifacts created or deleted while it runs no longer move a later page onto rows an
earlier one already returned; a changed total is then a fact about the deployment rather than about
the walk.

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
If the throwaway instance does not become healthy within the startup window, the command exits 1
before running either differ and points to `$TERM_REPORT_DIR/term-gate-instance.log` (or its default).
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
[Multilingual labels](VERSIONING-ROADMAP.md#10-multilingual-labels)). The read path serves them:

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

### Building the cross-snapshot search index

A corpus-wide term search — a query naming no ontology — is answered from one index rather than by
opening every snapshot in the catalog. `SearchIndexJob` builds it, and the terminology server reads
it when `terminologyStore.searchIndexPath` points at one. Without that property a search must name
its sources, and the startup log says so.

```bash
cd $CEDAR_HOME/cedar-terminology-server
mvn -q -pl cedar-terminology-server-ingest -am install -DskipTests
java -Xmx24g -cp "cedar-terminology-server-ingest/target/classes:cedar-terminology-server-store/target/classes:\
$HOME/.m2/repository/org/xerial/sqlite-jdbc/3.53.2.1/sqlite-jdbc-3.53.2.1.jar" \
  org.metadatacenter.terms.ingest.SearchIndexJob \
  $CEDAR_HOME/cedar-term/prod/catalog.sqlite $CEDAR_HOME/cedar-term/prod/search-index.sqlite
```

Measured 2026-08-13 over the served prod catalog: **1,215 ontologies, 13,939,470 terms, 24,278,806
names, 196 seconds, 5.44 GB**. The heap is what NCBITaxon needs — an ontology is loaded one at a
time, and that one is 2.85M concepts. `--skip-larger-than N` leaves the giants for a separate run
with a bigger heap; whatever is skipped is printed, because an index silently missing an ontology
answers "no matches" for it.

The job is idempotent and incremental: an ontology already indexed at the catalog's current version
is skipped, so a rebuild after a few re-ingests costs a few ontologies rather than the corpus.
`--force` reindexes anyway, `--acronyms A,B` limits it to named ones.

The index holds each ontology's **current** version and no other, and records which. A corpus-wide
search cannot be pinned — there is no one version to pin it to — so it searches what is current,
and a pinned search names its sources and reads their snapshots. Full design in
[The Search API](VERSIONING-ROADMAP.md#the-search-api).

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

One command that proves the whole stack works from the outside, the way users would exercise it.
The Playwright script logs in through the real Keycloak form, uses Workspace and Designer to create
and mutate a template, populates and re-edits an instance in CEE, presents the template anonymously
in OpenView, and conditionally deletes its artifacts. Pass = exit 0; a failure leaves a screenshot
in `ops/e2e/failures/`.

```bash
cd ops/e2e
npm install            # once per machine
npm run smoke          # headless, ~60 s
npm run smoke:headed   # watch it in a real browser
```

The concurrency coverage includes two independently loaded Designer pages: the first update wins,
the stale page receives HTTP 412 and visible failure feedback, the stored winner is preserved, and
the stale page reloads and saves successfully with the new revision. The sharing coverage uses a
second authenticated browser context for test user 2: the owner grants read access through the
visible Workspace dialog, the recipient sees read-only controls in **Shared with Me**, the owner
upgrades the grant to write, the recipient edits in Designer, and the owner revokes the grant. The
already-open recipient editor must then receive HTTP 403 without overwriting the stored value, and
the artifact must disappear from the recipient's **Shared with Me** listing. Every permission and
artifact update is also checked for an `If-Match` request header.

Workspace's graph-command coverage drives all six UI variants: make an artifact open and not open,
make a folder open and not open, and move an artifact and a folder. The visibility checks prove the
corresponding anonymous-access transition; the move checks prove the source loses the resource and
the chosen destination gains it. The browser observes `If-Match` on each command and the fresh
`ETag` on every successful response.

The smoke reads and prints the package version rendered by CEE in both Metadata Editor and
OpenView, fails if those two served surfaces disagree, and includes the version in its final PASS
line. For release acceptance, make the required identity an assertion:

```bash
CEDAR_EXPECT_CEE_VERSION=<CEE_VERSION> npm run smoke
```

The extracted Workspace and Template Designer also have a fast, credential-free contract smoke.
It proves that both preview route shells and independent AngularJS bootstraps are being served, the
Workspace carries its pinned CEE bundle, both applications agree on their navigation and Keycloak
origins, and the live resource service accepts authenticated CORS preflights from both origins:

```bash
cd $CEDAR_HOME/cedar-development
cedarcli native start frontend workspace   # then: designer
cd ops/e2e
npm run smoke:split
```

The defaults target `http://localhost:4201`, `http://localhost:4202`, the profile's auth host, and
the native resource service on port 9007. For a remote preview deployment, set
`CEDAR_WORKSPACE_PREVIEW`, `CEDAR_DESIGNER_PREVIEW`, `CEDAR_AUTH_URL`, and `CEDAR_RESOURCE_API`.
This check intentionally stops at the authentication boundary; it does not enter credentials or
mutate data.

The route-only cutover and rollback can be rehearsed locally before that authorization. Start the
monolith and the two extracted applications on ports 4200-4202 (native Gulp servers or the local
preview images), then run:

```bash
cd $CEDAR_HOME/cedar-docker-deploy/cedar-frontend
./rehearse-routing-switch.sh
```

Disposable nginx gateways prove split ownership and exact HTTP 307 path/query preservation, replace
only the complete canonical route table, and then prove every route is back on the monolith. The
gate also verifies that the three application container IDs or native PIDs and the Designer gateway
do not change. It removes both gateways on exit and deliberately performs no authentication, realm,
hostname, production Compose, or data change.

After the preview origins are authorized in Keycloak, run the split-aware form of the full
Playwright journey:

```bash
cd $CEDAR_HOME/cedar-development/ops/e2e
npm run smoke:split:authenticated
# or watch the cross-origin login/navigation journey:
npm run smoke:split:authenticated:headed
```

The local authenticated commands run `smoke:split:keycloak` first. That credential-free preflight
asks Keycloak to accept each `/silent-check-sso.html` callback and verifies the token endpoint's
CORS response echoes each exact origin with credentials and POST enabled. A Web Origin is an origin
only (`http://localhost:4201`), never a route wildcard (`http://localhost:4201/*`); the latter looks
similar in the admin console but cannot match the browser's `Origin` header. For non-local hosts,
set `CEDAR_SPLIT_KEYCLOAK_ORIGINS` to a comma-separated list of exact origins.

It first drives Workspace's real **New → Template** gesture, verifies that Designer receives the
complete Workspace `returnTo` URL, waits for SSO on the Designer origin, and drives Designer's
create-flow cancel action to prove exact restoration. It then runs the existing
folder/template/controlled-term/CEE
create-save-edit/OpenView/cleanup journey with Workspace as `CEDAR_BASE` and Designer as
`CEDAR_DESIGNER_BASE`. The ordinary `npm run smoke` leaves both values on the production monolith,
so this extension does not change the production smoke contract. Remote preview hosts can use the
same journey by setting both variables explicitly instead of using the localhost npm shortcut.

For a production-shaped local rehearsal, map `workspace.metadatacenter.orgx` and
`designer.metadatacenter.orgx` to `127.0.0.1`, authorize their exact HTTPS callbacks and Web Origins
in Keycloak, then generate only their two leaves from the already-trusted development CA. Do not
regenerate the CA:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli cert domains workspace designer --force
bash $CEDAR_HOME/cedar-development/ops/install-local-split-hostnames.sh
```

The installer verifies each SAN, expiry, and CA signature before copying the leaves and tracked
nginx includes into `/opt/homebrew/etc/nginx/cedar`. It validates the nginx configuration and then
reloads nginx when direct non-interactive sudo is available, otherwise it uses the CEDAR-scoped
stop/start helpers. It adds only the two hostname virtual hosts; the monolith virtual host remains
untouched. Local development can run native Gulp servers with
`cedarcli native start frontend split-frontends`. The all-Docker variant uses the normal seven-frontend
stack. Stop native listeners first because both modes publish the same ports:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli native stop frontends
cedarcli mode --clear
cedarcli mode docker
cedarcli docker build frontends
cedarcli docker start frontends --detach

cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose up -d --no-deps --force-recreate nginx

cd $CEDAR_HOME/cedar-development/ops/e2e
npm run smoke:split:hostnames:deployment
npm run smoke:split:hostnames:authenticated
```

This is an intentional coexistence mode, not a routing cutover:

- `https://cedar.metadatacenter.orgx` continues to serve the monolith on port 4200.
- `https://workspace.metadatacenter.orgx` serves the extracted Workspace on port 4201.
- `https://designer.metadatacenter.orgx` serves the extracted Designer on port 4202.

All three use the same Keycloak realm and backend data. Keycloak SSO bridges authentication, while
browser-local AngularJS state remains origin-specific and cross-application return state travels in
the validated `returnTo` URL. Starting or stopping the frontend Compose project changes neither the
backend containers nor stored CEDAR data.

### Native staging payloads (no Docker)

Staging follows the existing monolith deployment model. Publish the npm artifacts on the release
host with the explicit command above, but deploy from approved Git commits on the staging host. The
staging profile must set `CEDAR_FRONTEND_BEHAVIOR=server`, the normal CEDAR host/REST variables, and
the two exact HTTPS origins:

```bash
export CEDAR_WORKSPACE_FRONTEND_URL=https://<workspace-staging-host>
export CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL=https://<designer-staging-host>

cedarcli git status                 # both checkouts must be clean
cedarcli git pull                   # or check out the exact approved commits/tags
cedarcli build split-frontends --server-payload
```

The last command refuses a dirty source checkout, runs `npm ci` and Gulp for both repositories, and
writes a no-store `app/config/build-info.json` containing the package version, full source commit,
version modifier, and SHA-256 of the exact generated tree. Gulp exits in `server` mode. Native nginx
serves `$CEDAR_HOME/cedar-workspace/app` and `$CEDAR_HOME/cedar-template-designer/app` directly, so
there is no frontend container and no long-running Gulp service on staging. Install and validate the
two static-root virtual hosts, certificates, Keycloak entries, and backend CORS list separately;
then run the deployment and authenticated smokes before any route switch.

`cedarcli build split-frontends` without `--server-payload` only installs the locked dependencies.
`cedarcli native start|stop frontend split-frontends` is for the local `develop` profile on ports 4201 and
4202, not for a staging static payload.

Workspace is also a mandatory CEE release consumer. After publishing any stable or development CEE
version, propagate and verify all seven consumer manifests rather than updating only the historical
frontends:

```bash
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --apply <CEE_VERSION>
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check <CEE_VERSION>
```

Then regenerate the native Workspace server payload (or rebuild an optional local preview image) and
rerun the deployment and authenticated hostname smokes.
The detailed release, registry, build, and served-hash procedure is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md#release).

The shared Dropwizard CORS filter reads `CEDAR_CORS_ALLOWED_ORIGINS` as a comma-separated list of
Jetty origin patterns. An unset or blank value retains the historical `*` default, so introducing
the setting does not silently change an existing environment. The filter sets `allowCredentials`
explicitly: an exact origin list enables credentials, while any list containing the global `*`
forces credentials off. Never combine `*` with credentials or mix it into an exact allowlist; the
entire list will be treated as credentialless. Set the value before starting or restarting the
backend services. Inventory every legitimate browser origin first: do not configure only Workspace
and Designer while the monolith, OpenView, or another browser client is still in use.

The local stack currently retains the backward-compatible wildcard. Its positive preflights from
both local HTTPS origins pass and require no rebuild. Before staging, publish the updated shared
library, rebuild and redeploy the servers, then set an exact environment-specific list. Prove both
positive entries and a negative control:

```bash
export CEDAR_CORS_ALLOWED_ORIGINS='https://workspace.example.org,https://designer.example.org,https://openview.example.org'
# restart the backend services after installing builds that consume the updated shared library

cd $CEDAR_HOME/cedar-development/ops/e2e
CEDAR_WORKSPACE_PREVIEW=https://workspace.example.org \
CEDAR_DESIGNER_PREVIEW=https://designer.example.org \
CEDAR_RESOURCE_API=https://resource.example.org \
CEDAR_CORS_REJECT_ORIGIN=https://not-authorized.example.org \
npm run smoke:split:deployment
```

The smoke fails if either configured frontend loses its exact echoed origin or if the deliberately
unlisted origin receives `Access-Control-Allow-Origin`. Keep paths and trailing slashes out of exact
origin entries. Retain the wildcard only as a temporary compatibility default; an environment is
not allowlist-accepted until the negative control passes.

Every accepted staging payload adds one stronger gate. Native builds and optional preview images
both expose a no-store `/config/build-info.json` containing the full source commit, clean/dirty
marker, and SHA-256 of the exact environment-specific tree nginx serves. Validate both endpoints
and optionally pin the expected commits:

```bash
CEDAR_EXPECT_WORKSPACE_COMMIT=$(git -C "$CEDAR_HOME/cedar-workspace" rev-parse HEAD) \
CEDAR_EXPECT_DESIGNER_COMMIT=$(git -C "$CEDAR_HOME/cedar-template-designer" rev-parse HEAD) \
npm run smoke:split:deployment
```

Record the accepted payloads as a durable JSON deployment artifact:

```bash
CEDAR_DEPLOYMENT_ENVIRONMENT=staging npm run record:split:deployment \
  > "split-frontend-staging-$(date -u +%Y%m%dT%H%M%SZ).json"
```

Set `CEDAR_WORKSPACE_PREVIEW` and `CEDAR_DESIGNER_PREVIEW` for remote hosts. The recorder refuses a
dirty or provenance-unknown image by default; `CEDAR_ALLOW_DIRTY_PREVIEW=1` exists only for informal
local work and is not an acceptance setting. The record's source commits identify the inputs, while
its bundle digests identify what was actually generated and served in that environment. Save the
record with the deployment evidence so cutover and rollback can name exact payloads rather than tags.

Needs the app tier up (frontend, resource, user, group, artifact at least — `cedarcli native
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
