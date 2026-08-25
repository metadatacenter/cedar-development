# CEDAR Docker Runbook

This is the operating guide for CEDAR's Docker deployment: seven infrastructure containers,
fifteen Java microservices, and seven frontend containers. Those 29 containers form the complete
all-Docker runtime. The 22-container backend can also run with seven native frontend development
servers as a supported hybrid. Four admin-tool containers are optional and excluded from both core
counts.

The broader native and hybrid guide remains in [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md). Work
needed to make this a registry-driven, production-ready deployment is tracked in
[DOCKER-ROADMAP.md](./DOCKER-ROADMAP.md).

## Current verdict

The complete application **can be deployed locally with Docker today**. Images can be pulled as a
completed immutable development train or built directly from checked-out source. A clean pull of a
newly completed train was re-proven on 2026-08-24 on Apple Silicon with Docker Engine 29.6.2 and
Compose 5.3.1:

- all 70 Java reactor modules built successfully on JDK 17 with `-DskipTests`;
- all 24 backend images built: seven infrastructure, two Java bases, and fifteen microservices;
- all 22 backend runtime containers became healthy;
- all 19 REST suites passed in one in-network run: 683 assertions, 0 failures;
- all seven frontend images built from exact immutable npm artifacts;
- all 29 core runtime containers became healthy and all seven public UI hostnames returned 200;
  and
- the authenticated browser smoke created a template in Workspace, edited and populated it,
  exercised BioPortal suggestions, saved and re-edited an instance, downloaded JSON and YAML, and
  rendered it anonymously through OpenView before cleaning up.

The builder, Compose projects, CLI validation, and cleanup use `CEDAR_IMAGE_PREFIX` for the 29
runtime images. `CEDAR_BASE_IMAGE_PREFIX` can place the two Java bases in a separate internal
repository and otherwise defaults to the runtime prefix. The central build train publishes the
split Nexus inventory and advances a Docker pointer only after all 31 images have been pulled back
and their provenance labels and registry digests verified.

## What runs

| Tier | Containers | Host ports |
| --- | ---: | --- |
| Infrastructure | 7 | 80/443, 3306, 6379, 7474/7687, 8080/8443, 9200/9300, 27017 |
| Microservices | 15 | 9002-9015; Artifact's 9001 is intentionally internal only |
| Frontends (`docker` mode) | 7 | 4200-4202, 4220, 4240, 4300, 4340 |
| Frontends (alternative hybrid mode) | 0 containers / 7 macOS processes | Same seven ports |
| Admin tools (optional) | 4 | Environment-configured admin ports |

The two estates use different storage. Docker uses named volumes; the native stack uses its own
Homebrew/local data. `docker compose down` retains named volumes and therefore retains Docker data.

## Prerequisites

- Docker Engine with Compose v2; Compose 5.3 or newer is the known-good version.
- A complete `$CEDAR_HOME` checkout, including `cedar-development`, `cedar-docker-build`,
  `cedar-docker-deploy`, the Java parent/libraries/aggregators, and all fifteen server repositories.
- `$CEDAR_HOME/set-env-external.sh` and `set-env-internal.sh` configured for the installation.
- A JDK 17 selected through `JAVA_HOME` when compiling Java.
- Custom local certificates in `$CEDAR_HOME/CEDAR_CA`. The setup otherwise falls back to the
  bundled certificate set, which may be expired.
- At least 32 GB of memory allocated to Docker's virtual machine wherever the terminology server
  reads a local store. The reason, and what too small an allocation looks like from the outside,
  are in [Sizing Docker's Virtual Machine](#sizing-dockers-virtual-machine).

The Docker backend and native backend cannot run together: they claim the same infrastructure and
9xxx ports. Native and containerized frontends likewise cannot share their seven frontend ports.
The supported hybrid is deliberate: Docker owns the backend and public nginx while the seven native
frontend servers replace the seven frontend containers. Stop conflicting native components first,
then verify that the ports are actually free. Legacy microservice shutdown messages only work when
a service is listening on its stop port, and may leave unmanaged JVMs alive.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
cedarcli native stop all

# The expected result is no listeners. Stop any remaining service from its owning terminal or
# process controller; do not use a broad `pkill java`, which can kill unrelated JVMs.
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(80|443|3306|6379|7474|7687|8080|8443|9200|9300|27017|90[0-9][0-9])\b'
```

## Sizing Docker's Virtual Machine

Docker Desktop gives its virtual machine a fixed slice of host memory, and the default is smaller
than the CEDAR stack needs once the terminology server reads a local store. The 29 core containers
hold about 13 GB resident. A 16 GB virtual machine leaves roughly 1.4 GB for everything else, and
the container processes start evicting and swapping.

The terminology server pays for that, because a corpus-wide search reads an 8.2 GB SQLite index.
Measured 2026-08-25 on the same image and the same data, the two-letter query `ce` took between 5.8
and 77 seconds across runs against a 16 GB virtual machine. Raising the allocation to 32 GB held it
between 4.95 and 5.06 seconds over six consecutive runs. The larger allocation buys consistency
rather than speed: the fast result was always reachable, and only became repeatable.

The extra memory does not cache the index. A bind mount delivers the store, and virtiofs serves it
from the host's page cache rather than the guest's, so reading all 8.2 GB inside a container leaves
the guest's `buff/cache` where it was. The allocation relieves the container processes instead.

Latency that swings by a factor of ten reads as a defect in the query and is not one, so check the
allocation before reading any code:

```bash
docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -u -n -i free -m
```

An `available` figure below the size of the store's index means the virtual machine is too small.
Raise it in Docker Desktop's resource settings, which restarts the daemon and stops all 29
containers.

Start them again in place rather than through `cedarcli docker start all` whenever a container is
pinned to an image the aggregate start would not choose. That command recreates each container from
Compose, and Compose resolves every image afresh from the configured registry and namespace, so a
locally built image pinned into one service is lost.

```bash
docker start infra-mongo infra-mysql infra-neo4j infra-opensearch infra-redis-persistent \
             infra-keycloak
docker start server-artifact server-repo server-schema server-terminology server-user \
             server-valuerecommender server-resource server-impex server-group server-submission \
             server-worker server-messaging server-openview server-monitor server-bridge
docker start frontend-main frontend-workspace frontend-template-designer frontend-openview \
             frontend-content frontend-monitoring frontend-bridging infra-nginx
```

Each stage needs the one before it healthy.

## Configure the deployment mode

`cedarcli mode` selects one persistent topology before any native or Docker operation is allowed.
It starts nothing. It loads and validates the required profile internally, validates all four
Compose projects for `docker` and `hybrid`, pins Java 17 for native commands, and records the choice
in `$CEDAR_HOME/.cedar/mode.json`. Subsequent commands work from a bare shell; cedarcli supplies the
selected profile to its own child processes rather than changing the calling shell.

The three choices are `native`, `hybrid`, and `docker`. A second selection is rejected. To switch,
stop the selected deployment, run `cedarcli mode --clear`, then configure the new mode. Native mode
rejects every Docker command; Docker mode rejects every native command. Hybrid permits Docker
backend operations and native frontend operations, while rejecting the opposite combinations. The
CLI also reconciles that choice with the runtime: native commands are refused while a recorded or
running CEDAR Compose project exists; Docker starts are refused while verified native applications
or host infrastructure listeners are still running; and hybrid Docker starts allow native frontend
processes but reject native backend processes and leftover Docker frontend containers. Stop commands
on an allowed surface remain available when the selected mode and runtime disagree. In particular,
hybrid permits Docker frontend stops even though it refuses Docker frontend starts, so a stale
frontend project can be removed without changing modes first.

Mode clearing checks the components owned by the selected topology. In native mode, stop the native
applications and infrastructure. In hybrid mode, stop the native frontends and Docker deployment.
In Docker mode, stop the Docker deployment. The CLI refuses to discard the mode while those
components remain because doing so would remove the normal command path used to stop them. If the
optional admin project is running, stop it separately with `cedarcli docker stop admin`; the core
aggregate deliberately does not include it.

Keep Docker running until `cedarcli docker stop all` completes. If Docker was deliberately shut down
first, Compose cannot confirm or perform teardown. In that recovery case only, use `cedarcli mode
--clear --force` to discard the inactive Docker deployment record. It does not stop containers and
is refused when the daemon reports any running CEDAR Compose project.

### Select the image registries and namespaces

The default image prefix is `metadatacenter`. To build and run images in another registry, set the
runtime repository prefix before configuring `docker` or `hybrid`. The mode record retains both
prefixes for later bare-shell commands. Set the internal prefix only when the two Java bases live
elsewhere:

```bash
export CEDAR_IMAGE_PREFIX=<registry-host>:<port>/<namespace>
export CEDAR_BASE_IMAGE_PREFIX=<registry-host>:<port>/<internal-namespace>
cedarcli mode docker
```

Use Docker image syntax, not a URL: omit `https://`, an image tag, and a trailing slash. For a
private registry, run `docker login <registry-host>:<port>` first. The runtime prefix controls
Compose pulls and starts. The base prefix controls `FROM` resolution and the tags assigned to
`cedar-java` and `cedar-microservice`. `cedarcli docker remove images` covers both. Changing either
after a build selects a different image set.

The CEDAR Nexus publication uses HTTPS path routing:

```bash
export CEDAR_IMAGE_PREFIX=nexus.bmir.stanford.edu/docker-cedar
export CEDAR_BASE_IMAGE_PREFIX=nexus.bmir.stanford.edu/docker-cedar-internal
```

After setting any installation-specific values, configure the topology. For the complete container
deployment:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli mode docker
```

## Validate configuration

```bash
cedarcli docker validate
```

This validates all four Compose projects. Infrastructure, microservices, and frontend must be `OK`
for the complete all-Docker runtime. Admin must also parse cleanly even though starting that stack
is optional.

## Build or obtain the images

There are two supported build paths today. Train creation, state, and recovery are described in
[BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md).

Create and publish a new immutable Maven and Docker train with:

```bash
cedarcli publish train
```

The workflow publishes the Java train, builds the two internal bases and 29 runtime images, then
pulls and verifies all 31 before advancing `docker/current.json`. Resume a failed publication with
the train ID printed by the original command:

```bash
cedarcli publish train --resume <TRAIN>
```

### Completed build train: normal published-artifact build

An ordinary Docker build reads the completed Maven-train pointer recorded by `cedar-development`. All
groups receive that train's version as their image tag, and the Java images download that exact
immutable Maven version from `cedar-maven-dev`:

```bash
cedarcli docker build infra
cedarcli docker build microservices
cedarcli docker build frontends
```

Select a particular completed train instead of the current pointer when reproducing it:

```bash
cedarcli docker build microservices --train <TRAIN>
```

### Checked-out Java source: explicit local build

This is the path used for the 2026-08-21 deployment proof. The Java build installs the parent,
shared libraries, the 70-module server reactor, and clients in dependency order. It deliberately
skips tests; the REST gate below supplies runtime coverage. `--local` then stages each newly built
fat JAR into its server image and clears the staged file after the build.

```bash
cedarcli build java
cedarcli docker build infra --local
cedarcli docker build microservices --local
cedarcli docker build frontends --local
```

The local path keeps the development version declared by the Docker build manifest. It does not
claim to reproduce a published train. Both paths tag images locally under `CEDAR_IMAGE_PREFIX`; do
not assume that a local tag means the image was published.

### Frontend images

All seven frontend images are part of the normal build group. They consume exact immutable npm
prereleases pinned in `cedar-docker-build/bin/cedar-images-base.sh`; they do not use a moving npm
snapshot version.

```bash
cedarcli docker build frontends
```

The full core build inventory is 31 images: seven infrastructure images, two Java bases, fifteen
microservices, and seven frontends. `cedarcli docker build all` additionally builds the four
optional admin images, for 35 total.

## One-time Docker setup

Run this before the first deployment, or after intentionally recreating the CEDAR network and
certificate volumes. It creates `cedarnet` at `192.168.17.0/24`, plus external certificate volumes.
It removes an existing `cedarnet` while recreating it, so do not run it under a live CEDAR stack.

```bash
cedarcli docker one-time-setup
```

Confirm the network and certificate volumes exist:

```bash
docker network inspect cedarnet >/dev/null
docker volume inspect cedar_cert cedar_ca >/dev/null
```

## Start the Docker deployment

The configured `docker` mode runs all 29 core containers. Configured `hybrid` mode runs the
22-container backend and routes Docker nginx to the seven frontend development servers on the host.

```bash
cedarcli docker start all --pull never
```

Start resolves the current completed Docker train, which can lag the Maven pointer while images are
still building. Use `--train <TRAIN>` to select an exact Docker-complete train. When the images came
from `docker build --local`, add `--local` to start so Compose selects the development tag instead.

`--pull never` uses the images already present on the machine and fails if one is absent. This is
the safe choice for locally built development images. Use `--pull missing` to fetch only absent
images, or `--pull always` when the deployment must refresh every image from its configured
registry. Use the separate `admin` target for optional administration containers. Use
`--timeout SECONDS` to change the ten-minute readiness deadline.

The command validates all Compose projects, checks the Docker daemon, `cedarnet`, certificate
volumes, and published ports, and then starts infrastructure, microservices, frontends when
selected, and optional admin tools in dependency order. It waits after each stage. A timeout names
the unhealthy services and prints at most 100 recent log lines for each. Finally, it verifies that
a backend container can reach Keycloak's signing configuration and checks the public frontend
routes in `docker` and `hybrid` modes.

Individual stack commands remain available for troubleshooting. They preserve the recorded mode
when recreating nginx, but they do not perform the aggregate preflight or readiness sequence.

## Health gate

The Docker-aware status command reads the configured CEDAR mode, checks the appropriate Compose
inventory and acceptance probes, and exits nonzero when a required container or route is not ready.
It also reports the completed image train recorded by the last successful aggregate Docker start.
`cedarcli native status` is rejected in hybrid and Docker modes because its host-port inventory
would report false backend failures.

```bash
cedarcli docker status
```

Admin tools are optional and managed separately from the aggregate deployment:

```bash
cedarcli docker start admin --detach
cedarcli docker stop admin
```

For a hybrid deployment, there must be exactly 22 running backend containers and every one must
report `healthy`:

```bash
docker ps \
  --filter name=infra- \
  --filter name=server- \
  --format '{{.Names}}\t{{.Status}}' | sort
```

Useful failure inspection:

```bash
cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose ps
docker compose logs --tail 200 <service>

cd $CEDAR_HOME/cedar-docker-deploy/cedar-microservices
docker compose ps
docker compose logs --tail 200 <service>
```

Treat `healthy` as a readiness check, not the deployment acceptance test. It does not prove that a
valid token can be verified or that a Resource write reaches MongoDB, Neo4j, Redis, and OpenSearch.

## Optional hybrid: native frontends through Docker nginx

The currently proven interactive development topology keeps the full backend and nginx in Docker,
but runs all frontend development servers directly from their source checkouts on macOS. This does
not copy HTML, JavaScript, CSS, fonts, or images into the nginx container. Docker nginx terminates
TLS and streams each frontend response from a native server through `host.docker.internal`.

For example, a Workspace page load follows this path:

```text
browser: https://workspace.metadatacenter.orgx/
  -> /etc/hosts: 127.0.0.1
  -> Docker's published port 443
  -> infra-nginx workspace virtual host
  -> http://host.docker.internal:4201
  -> native gulp-connect rooted at $CEDAR_HOME/cedar-workspace/app
  -> app/index.html, followed by the scripts, styles, fonts, and images under app/
```

After the browser loads the frontend, API calls use API hostnames such as
`resource.metadatacenter.orgx`. Docker nginx routes those requests inward over `cedarnet` to the
Java containers. The same nginx container therefore proxies frontend assets outward to macOS and
API traffic inward to Docker.

Each frontend has its own Node.js process; there is no shared frontend server:

| Public hostname | Controller name | Native source root | Development server | Port |
| --- | --- | --- | --- | ---: |
| `cedar.metadatacenter.orgx` | `frontend` | `cedar-template-editor/app` | Gulp / gulp-connect | 4200 |
| `workspace.metadatacenter.orgx` | `workspace` | `cedar-workspace/app` | Gulp / gulp-connect | 4201 |
| `designer.metadatacenter.orgx` | `designer` | `cedar-template-designer/app` | Gulp / gulp-connect | 4202 |
| `openview.metadatacenter.orgx` | `ui-openview` | `cedar-openview/cedar-openview-src` | Angular CLI / `ng serve` | 4220 |
| `content.metadatacenter.orgx` | `ui-content` | `cedar-content-distribution` | Angular CLI / `ng serve` | 4240 |
| `monitoring.metadatacenter.orgx` | `ui-monitoring` | `cedar-monitoring/cedar-monitoring-src` | Angular CLI / `ng serve` | 4300 |
| `bridging.metadatacenter.orgx` | `ui-bridging` | `cedar-bridging/cedar-bridging-src` | Angular CLI / `ng serve` | 4340 |

The three Gulp applications are legacy AngularJS applications. The four `ui-*` applications use
Angular CLI. Both kinds are Node.js processes; the difference is their historical build toolchain.

Configure hybrid once, then start only the seven native frontends. Cedarcli loads the native profile,
binds the frontend servers to `0.0.0.0`, and supplies the absolute Workspace and Designer URLs to
those child processes. Backend-native targets are rejected in this mode.

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli mode hybrid
cedarcli native start frontends
```

Start the Docker backend under the same configured mode. The CLI stops any Docker
frontend project, points all seven nginx upstreams at `host.docker.internal`, recreates affected
containers, and waits for the backend and public frontend routes. Docker-frontend targets are
rejected in hybrid mode.

```bash
cedarcli docker start all --pull never
```

To switch from a running Docker deployment, stop it, clear `docker` mode, configure `hybrid`, then
start the native frontends and Docker backend as above. An individual infrastructure restart keeps
the configured hybrid upstreams instead of silently reverting nginx to container addresses.

Verify the public shells, Keycloak origins, navigation origins, and REST CORS:

```bash
for host in cedar workspace designer openview content monitoring bridging; do
  curl -sk -o /dev/null -w "$host %{http_code}\n" "https://${host}.metadatacenter.orgx/"
done

cd $CEDAR_HOME/cedar-development/ops/e2e
npm run smoke:split:hostnames:keycloak
npm run smoke:split:hostnames
```

Expected: all seven hostnames return 200 and both split smoke commands pass. The 2026-08-21 proof
met those expectations while all 22 backend containers remained healthy.

Stop only the native frontends without touching the Docker backend:

```bash
cedarcli native stop frontends
```

Three frontend deployment modes remain distinct:

| Mode | Where frontend code is served | How it is started | Current status |
| --- | --- | --- | --- |
| Native hybrid | Seven macOS development-server processes | `cedarcli mode hybrid`, then native frontends and `cedarcli docker start all` | Proven local development mode |
| All-Docker frontends | Seven containers on `cedarnet` | `cedarcli mode docker`, then `cedarcli docker start all` | Proven on 2026-08-21 |
| Native-only stack | Seven native development servers | `cedarcli mode native`, then `cedarcli native start all` | Preserved; Docker work does not change it |

Do not run native and containerized frontends on the same published ports. The normal frontend
Compose stack now contains Template Editor, Workspace, Designer, OpenView, Content, Monitoring, and
Bridging. Each application has its own image and private nginx; infrastructure nginx remains the
single public TLS and routing layer.

### All-Docker frontend deployment

The frontend source repositories remain Docker-agnostic. All Dockerfiles, entrypoints, and private
nginx configurations are in `cedar-docker-build`; Compose topology is in `cedar-docker-deploy`.
Each image downloads one exact npm package from Nexus. Because npm versions are immutable, a
Maven-style moving snapshot package is not valid. The pinned inputs use development prereleases
derived from clean source commits.

Publish a new source commit when needed, then copy the printed version into the corresponding
`CEDAR_*_NPM_VERSION` declaration in `cedar-docker-build/bin/cedar-images-base.sh`:

```bash
export CEDAR_HOME=$HOME/CEDAR
bash $CEDAR_HOME/cedar-development/ops/publish-frontend-package.sh \
  main|workspace|designer|openview|content|monitoring|bridging
```

The helper stages the package without modifying the source checkout, records the full commit as
`gitHead`, refuses dirty repositories, and is idempotent for the same commit. Never substitute the
moving `dev` dist-tag in an image build. The Dockerfile verifies the package identity and records
its full source commit and tarball SHA-256 inside the image.

Stop the hybrid deployment, clear its mode, and configure Docker mode. The aggregate
command starts the frontend containers and restores nginx's container upstreams as part of the same
operation:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli native stop frontends
cedarcli docker stop all
cedarcli mode --clear
cedarcli mode docker
cedarcli docker build frontends
cedarcli docker start all --pull never
```

The mode switch removes captured `host.docker.internal` upstream values before checking all seven
frontend containers and public routes. The 2026-08-21 browser acceptance then opened the Smoke
Tests folder in Workspace and opened its template in Designer without console errors.

```bash
docker exec infra-nginx nginx -T 2>/dev/null | grep -A1 'upstream cedar-frontend'
docker ps --filter 'name=frontend-' --format '{{.Names}}\t{{.Status}}'
for host in cedar workspace designer openview content monitoring bridging; do
  curl -sk -o /dev/null -w "$host %{http_code}\n" \
    "https://${host}.metadatacenter.orgx/"
done
```

To return to hybrid, stop the Docker deployment, clear and reconfigure the mode, then start the
seven native frontends and the Docker aggregate. Backend data volumes are untouched by either mode
switch. The concise topology and package procedure is also in
`cedar-docker-deploy/cedar-frontend/README.md`.

## REST acceptance gate

The repository's REST suites create and clean up their own fixtures. Run them from an ephemeral Node
container on `cedarnet`; this reaches the deliberately unexposed Artifact service and tests the
backend without involving any frontend. This is a direct `docker run`, not a cedarcli command, so
the shell must load the Docker profile to obtain the container addresses used below.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh

docker run --rm --network cedarnet \
  --add-host resource.metadatacenter.orgx:"$CEDAR_NGINX_HOST" \
  --add-host terminology.metadatacenter.orgx:"$CEDAR_NGINX_HOST" \
  -v "$CEDAR_HOME/cedar-development/ops/e2e:/work:ro" -w /work \
  -e CEDAR_RESOURCE_BASE=https://resource.metadatacenter.orgx \
  -e CEDAR_USER_BASE=http://server-user:9005 \
  -e CEDAR_GROUP_BASE=http://server-group:9009 \
  -e CEDAR_ARTIFACT_BASE=http://server-artifact:9001 \
  -e CEDAR_TERMINOLOGY_BASE=https://terminology.metadatacenter.orgx \
  -e CEDAR_OPENVIEW_BASE=http://server-openview:9013 \
  -e CEDAR_KEYCLOAK_BASE=http://infra-keycloak:8080 \
  -e CEDAR_ADMIN_USER_API_KEY \
  -e CEDAR_FRONTEND_local_USER1_LOGIN \
  -e CEDAR_FRONTEND_local_USER1_PASSWORD \
  -e CEDAR_FRONTEND_local_USER2_LOGIN \
  -e CEDAR_FRONTEND_local_USER2_PASSWORD \
  node:20-alpine node rest-smoke.mjs
```

Resource and Terminology deliberately go through containerized nginx so this also covers their
published API and Swagger UI routes. Artifact stays on its internal service address. Expected: 19
suites pass and the final result is `PASS` (683 assertions on 2026-08-21). The first invocation may
pull `node:20-alpine`.

A host-side run is useful for testing published ports and nginx:

```bash
cd $CEDAR_HOME/cedar-development/ops/e2e
export CEDAR_KEYCLOAK_BASE=http://127.0.0.1:8080
export CEDAR_OPENVIEW_BASE=http://127.0.0.1:9013
export NODE_TLS_REJECT_UNAUTHORIZED=0
npm run smoke:rest
```

On the current Compose topology, the host run cannot reach Artifact on port 9001. Consequently the
`contract` and `freeze` suites end in `fetch failed` even though their public API work passed. Do not
publish Artifact merely to satisfy the harness; use the in-network gate above.

## Stop, restart, and preserve data

Stop the core Docker deployment in reverse dependency order:

```bash
cedarcli docker stop all
```

The command does not stop the optional administration stack. Manage that independently with
`cedarcli docker stop admin`. Stopping removes containers and Compose-owned networks but retains
named data volumes, so a subsequent start reuses the data.

Individual stop commands remain available when changing one part of a development deployment, for
example stopping Docker frontends before starting their native replacements. Cleanup commands do
not enforce the ordinary runtime-consistency gate: a mismatched deployment record must not make the
command needed to repair that mismatch unavailable. Native process stops still verify the expected
JAR or frontend source directory before sending a signal.

If Docker is unavailable, aggregate stop fails once before invoking Compose. Start Docker and rerun
the stop normally. If Docker will remain shut down and the intent is only to abandon its saved mode,
use `cedarcli mode --clear --force`; this clears CLI state, not Docker resources.

Do not add `-v`, run `cedarcli docker remove volumes`, or delete named volumes during an ordinary
restart. Those are destructive data-reset operations and need a backup plus explicit intent.

After the Docker projects are down and the ports are clear, clear the Docker mode and select native:

```bash
cedarcli mode --clear
cedarcli mode native
```

The CLI supplies the selected profile internally; do not mix native and Docker profile values in the
calling shell.

## Known limitations

- Registry selection is implemented, but a complete tested snapshot image set is not yet published
  automatically; confirm availability before relying on `--pull missing` or `--pull always`.
- Artifact is intentionally private to `cedarnet`; host-only test runners cannot exercise its
  cross-store contract directly.
- Java build success means compilation/package success because `cedarcli build java` uses
  `-DskipTests`.
- The runtime OpenSearch image is 2.19.1 while `cedar-parent` declares Java clients 2.19.2. This is
  accepted because their compatibility contract is the shared 2.19 line; Docker-build CI enforces
  that major/minor pairing mechanically.
