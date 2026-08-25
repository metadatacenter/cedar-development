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
| Frontends (all-Docker mode) | 7 | 4200-4202, 4220, 4240, 4300, 4340 |
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

The Docker backend and native backend cannot run together: they claim the same infrastructure and
9xxx ports. Native and containerized frontends likewise cannot share their seven frontend ports.
The supported hybrid is deliberate: Docker owns the backend and public nginx while the seven native
frontend servers replace the seven frontend containers. Stop conflicting native components first,
then verify that the ports are actually free. Legacy microservice shutdown messages only work when
a service is listening on its stop port, and may leave unmanaged JVMs alive.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
cedarcli stop all

# The expected result is no listeners. Stop any remaining service from its owning terminal or
# process controller; do not use a broad `pkill java`, which can kill unrelated JVMs.
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(80|443|3306|6379|7474|7687|8080|8443|9200|9300|27017|90[0-9][0-9])\b'
```

## Set the Docker environment

`CEDAR_HOME` must be exported **before** the profile is sourced. A missing value makes the profile
source `/set-env-external.sh`, and Compose later resolves the terminology bind mount as
`/cedar-term`, which Docker Desktop rejects.

The Docker profile defines the fixed container topology. The aggregate CLI applies the selected
frontend routing only to its Docker child processes, so it does not mutate this shell. All supported
Docker modes run the infrastructure nginx container; Java services consequently resolve the public
authentication hostname to that container.

```bash
export CEDAR_HOME=$HOME/CEDAR
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
```

Keep that shell for all commands below.

### Select the image registries and namespaces

The default image prefix is `metadatacenter`. To build and run images in another registry, set the
runtime repository prefix before sourcing the Docker profile. Set the internal prefix only when the
two Java bases live elsewhere:

```bash
export CEDAR_IMAGE_PREFIX=<registry-host>:<port>/<namespace>
export CEDAR_BASE_IMAGE_PREFIX=<registry-host>:<port>/<internal-namespace>
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
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
cedarcli build train
```

The workflow publishes the Java train, builds the two internal bases and 29 runtime images, then
pulls and verifies all 31 before advancing `docker/current.json`. Resume a failed publication with
the train ID printed by the original command:

```bash
cedarcli build train --resume <TRAIN>
```

### Completed build train: normal published-artifact build

An ordinary Docker build reads the completed Maven-train pointer recorded by `cedar-development`. All
groups receive that train's version as their image tag, and the Java images download that exact
immutable Maven version from `cedar-maven-dev`:

```bash
cedarcli docker build infrastructure
cedarcli docker build microservices
cedarcli docker build frontends
# Or build the same 31-image core inventory in one command:
cedarcli docker build core
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
cedarcli docker build infrastructure --local
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

Select the topology explicitly. `full` runs all 29 core containers. `hybrid` runs the 22-container
backend and routes Docker nginx to the seven frontend development servers on the host. `backend`
runs the same 22 containers without requiring any frontend routes, which is useful for REST work.

```bash
cedarcli docker start all --mode full --pull never
```

Start resolves the current completed Docker train, which can lag the Maven pointer while images are
still building. Use `--train <TRAIN>` to select an exact Docker-complete train. When the images came
from `docker build --local`, add `--local` to start so Compose selects the development tag instead.

`--pull never` uses the images already present on the machine and fails if one is absent. This is
the safe choice for locally built development images. Use `--pull missing` to fetch only absent
images, or `--pull always` when the deployment must refresh every image from its configured
registry. Add `--include-admin` to start the four optional administration containers and
`--timeout SECONDS` to change the ten-minute readiness deadline.

The command validates all Compose projects, checks the Docker daemon, `cedarnet`, certificate
volumes, and published ports, and then starts infrastructure, microservices, frontends when
selected, and optional admin tools in dependency order. It waits after each stage. A timeout names
the unhealthy services and prints at most 100 recent log lines for each. Finally, it verifies that
a backend container can reach Keycloak's signing configuration and checks the public frontend
routes in `full` and `hybrid` modes.

Individual stack commands remain available for troubleshooting. They preserve the recorded mode
when recreating nginx, but they do not perform the aggregate preflight or readiness sequence.

## Health gate

The aggregate start records its successful mode under `$CEDAR_HOME/.cedar`. The Docker-aware status
command reads that mode, checks the appropriate Compose inventory and acceptance probes, and exits
nonzero when a required container or route is not ready. The top-level `cedarcli status` remains the
native process/host-port diagnostic and will report false failures for Docker-internal ports.

```bash
cedarcli docker status
```

Override the recorded expectation only when diagnosing another topology:

```bash
cedarcli docker status --mode full
cedarcli docker status --mode hybrid
cedarcli docker status --mode backend
```

Admin tools are optional and excluded from the normal result. Require them explicitly when that
stack is part of the deployment:

```bash
cedarcli docker status --include-admin
```

For a backend-only deployment, there must be exactly 22 running backend containers and every one
must report `healthy`:

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

Start only the seven frontends from a native-profile shell. The two absolute split-frontend URLs
are build-time inputs written into the generated application configuration. The Angular CLI servers
default to loopback, so `CEDAR_FRONTEND_BIND_HOST=0.0.0.0` is required for Docker Desktop to reach
them.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-profile-native-develop.sh
export CEDAR_FRONTEND_BIND_HOST=0.0.0.0
export CEDAR_WORKSPACE_FRONTEND_URL=https://workspace.metadatacenter.orgx
export CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL=https://designer.metadatacenter.orgx
cedarcli start frontends
```

Start the Docker backend from a Docker-profile shell in `hybrid` mode. The CLI stops any Docker
frontend project, points all seven nginx upstreams at `host.docker.internal`, recreates affected
containers, and waits for the backend and public frontend routes. The mode-specific values exist
only in the child processes and are recorded after the checks pass.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
cedarcli docker start all --mode hybrid --pull never
```

If switching from a running full-Docker deployment, first run `cedarcli docker stop frontends`, then
start the native frontend servers, and finally select hybrid mode as above. Once hybrid is recorded,
an individual infrastructure restart preserves its host upstreams instead of silently reverting
nginx to container addresses.

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
cedarcli stop frontends
```

Three frontend deployment modes remain distinct:

| Mode | Where frontend code is served | How it is started | Current status |
| --- | --- | --- | --- |
| Native hybrid | Seven macOS development-server processes | `cedarcli start frontends`, then `cedarcli docker start all --mode hybrid` | Proven local development mode |
| All-Docker frontends | Seven containers on `cedarnet` | `cedarcli docker start all --mode full` | Proven on 2026-08-21 |
| Native-only stack | Seven native development servers | Native profile and native nginx | Preserved; Docker work does not change it |

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

Stop all native frontend listeners, build the seven images, and select full mode. The aggregate
command starts the frontend containers and restores nginx's container upstreams as part of the same
operation:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli stop frontends

source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
cedarcli docker build frontends
cedarcli docker start all --mode full --pull never
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

To return to hybrid, stop the Docker frontend project, start the seven native processes, and run
`cedarcli docker start all --mode hybrid`. Backend data volumes are untouched by either frontend
switch. The concise topology and package procedure is also in
`cedar-docker-deploy/cedar-frontend/README.md`.

## REST acceptance gate

The repository's REST suites create and clean up their own fixtures. Run them from an ephemeral Node
container on `cedarnet`; this reaches the deliberately unexposed Artifact service and tests the
backend without involving any frontend.

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

If the optional administration stack was started outside the recorded aggregate deployment, add
`--include-admin`. An administration stack selected by `start all --include-admin` is remembered
and stopped automatically. The command removes containers and Compose-owned networks but retains
named data volumes, so a subsequent start reuses the data.

Individual stop commands remain available when changing one part of a development deployment, for
example stopping Docker frontends before starting their native replacements.

Do not add `-v`, run `cedarcli docker remove volumes`, or delete named volumes during an ordinary
restart. Those are destructive data-reset operations and need a backup plus explicit intent.

After the Docker projects are down and the ports are clear, source the native profile again before
restarting native CEDAR. Never mix values from the native and Docker profiles in one shell.

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
