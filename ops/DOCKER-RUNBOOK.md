# CEDAR Docker Runbook

This is the operating guide for CEDAR's Docker deployment: seven infrastructure containers,
fifteen Java microservices, and seven frontend containers. Those 29 containers form the required
all-Docker runtime. The 22-container backend can also run with seven native frontend development
servers as a supported hybrid. Four admin-tool containers are optional and excluded from both core
counts.

The broader native and hybrid guide remains in [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md). Work
needed to make this a registry-driven, production-ready deployment is tracked in
[DOCKER-ROADMAP.md](./DOCKER-ROADMAP.md).

## Current verdict

The complete application **can be deployed locally with Docker today**, provided its images are
built locally. It was re-proven on 2026-08-21 on Apple Silicon with Docker Engine 29.6.2 and
Compose 5.3.1:

- all 70 Java reactor modules built successfully on JDK 17 with `-DskipTests`;
- all 24 backend images built: seven infrastructure, two Java bases, and fifteen microservices;
- all 22 backend runtime containers became healthy;
- all 19 REST suites passed in one in-network run: 683 assertions, 0 failures;
- all seven frontend images built from exact immutable npm artifacts;
- all 29 required runtime containers became healthy and all seven public UI hostnames returned 200;
  and
- an authenticated browser opened Workspace's Smoke Tests template in Designer without console
  errors.

This is not yet a pull-and-run snapshot deployment. The Compose files and Docker builder hard-code
the `metadatacenter` Docker Hub namespace, and `2.9.2-SNAPSHOT` infrastructure images are not
published there (`cedar-infra-mysql:2.9.2-SNAPSHOT` returned `not found` on 2026-08-21). Nexus can
hold these images, but registry selection is not wired into Compose yet. Use local builds until the
P0 registry work in the roadmap is complete.

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

The checked-in Docker evaluation profile defaults authentication to `host-gateway` for the hybrid
mode where nginx is native. A complete Docker deployment must override it to the nginx container.
Without this override, health checks can pass but bearer-token validation returns 500 when a server
cannot fetch Keycloak signing keys.

```bash
export CEDAR_HOME=$HOME/CEDAR
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker-eval.sh
export CEDAR_AUTH_HOST_TARGET="$CEDAR_NGINX_HOST"
```

Keep that shell for all commands below.

## Validate configuration

```bash
cedarcli docker validate
```

This validates all four Compose projects. Infrastructure, microservices, and frontend must be `OK`
for the required all-Docker runtime. Admin must also parse cleanly even though starting that stack
is optional.

## Build or obtain the images

There are two supported build paths today.

### Checked-out Java source: strongest verification

This is the path used for the 2026-08-21 deployment proof. The Java build installs the parent,
shared libraries, the 70-module server reactor, and clients in dependency order. It deliberately
skips tests; the REST gate below supplies runtime coverage. `--local` then stages each newly built
fat JAR into its server image and clears the staged file after the build.

```bash
cedarcli build java
cedarcli docker build infrastructure
cedarcli docker build microservices --local
```

### Published Maven snapshots on Nexus: faster image build

When the `2.9.2-SNAPSHOT` Java artifacts are known to be current on Nexus, omit `--local`.
Each server image downloads its application JAR by Maven coordinate during `install_deps.sh`.

```bash
cedarcli docker build infrastructure
cedarcli docker build microservices
```

Both paths currently tag images locally as `metadatacenter/cedar-*:2.9.2-SNAPSHOT`. Do not assume
that this name means the image was published to Docker Hub or Nexus.

### Frontend images

All seven frontend images are part of the normal build group. They consume exact immutable npm
prereleases pinned in `cedar-docker-build/bin/cedar-images-base.sh`; they do not use a moving npm
`2.9.2-SNAPSHOT`.

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

With locally built snapshot images, use `--pull never` so Compose cannot substitute a remote image
or fail while looking for an unpublished Docker Hub tag.

```bash
cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose up -d --pull never

cd $CEDAR_HOME/cedar-docker-deploy/cedar-microservices
docker compose up -d --pull never

cd $CEDAR_HOME/cedar-docker-deploy/cedar-frontend
docker compose up -d --pull never
```

The microservice project encodes its dependency chain in health conditions. Artifact and Messaging
start first; Resource, Submission, Worker, and Monitor follow as their dependencies become healthy.
A cold start can take several minutes.

The equivalent convenience commands default to `--pull never`, which is the safe policy for the
current locally built snapshots. Pass `--pull missing` or `--pull always` explicitly after the
registry-driven deployment work is complete.

```bash
cedarcli docker start infrastructure -d
cedarcli docker start microservices -d
cedarcli docker start frontends -d
```

Omit the frontend start only for the documented native-frontend hybrid. Admin tools remain
independent and optional: `cedarcli docker start admin -d`.

## Health gate

Use the Docker-aware status command for the normal all-Docker gate. It checks the expected Compose
inventory for infrastructure, microservices, and all seven frontends, and exits nonzero when a
required container is missing, stopped, unhealthy, or still starting. The top-level
`cedarcli status` remains the native process/host-port diagnostic and will report false failures for
Docker-internal ports.

```bash
cedarcli docker status
```

For the 22-container backend with native frontends, exclude the frontend Compose project:

```bash
cedarcli docker status --no-frontends
```

Admin tools are optional and excluded from the normal result. Require them explicitly when that
stack is part of the deployment:

```bash
cedarcli docker status --include-admin
```

For a backend-only inventory view, there must be exactly 22 running backend containers and every
one must report `healthy`:

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
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh start \
  frontend workspace designer ui-openview ui-content ui-monitoring ui-bridging
```

Recreate only Docker nginx from a Docker-profile shell, overriding all frontend upstreams. These
values are captured in the container environment when it is created; merely exporting them later
does not change a running nginx container.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker-eval.sh
export CEDAR_AUTH_HOST_TARGET="$CEDAR_NGINX_HOST"
export CEDAR_FRONTEND_EDITOR_HOST=host.docker.internal
export CEDAR_FRONTEND_CONTENT_HOST=host.docker.internal
export CEDAR_FRONTEND_OPENVIEW_HOST=host.docker.internal
export CEDAR_FRONTEND_MONITORING_HOST=host.docker.internal
export CEDAR_FRONTEND_BRIDGING_HOST=host.docker.internal
export CEDAR_FRONTEND_WORKSPACE_HOST=host.docker.internal
export CEDAR_FRONTEND_DESIGNER_HOST=host.docker.internal
cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose up -d --no-deps --force-recreate nginx
```

Recreating nginx later with the unmodified Docker profile points its frontend upstreams back to
reserved container addresses, not the native processes. Repeat the overrides above whenever nginx
is recreated in hybrid mode.

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
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh stop \
  frontend workspace designer ui-openview ui-content ui-monitoring ui-bridging
```

Three frontend deployment modes remain distinct:

| Mode | Where frontend code is served | How it is started | Current status |
| --- | --- | --- | --- |
| Native hybrid | Seven macOS development-server processes | `cedar-services.sh` plus nginx host overrides above | Proven local development mode |
| All-Docker frontends | Seven containers on `cedarnet` | `cedarcli docker start frontends -d` | Proven on 2026-08-21 |
| Native-only stack | Seven native development servers | Native profile and native nginx | Preserved; Docker work does not change it |

Do not run native and containerized frontends on the same published ports. The normal frontend
Compose stack now contains Template Editor, Workspace, Designer, OpenView, Content, Monitoring, and
Bridging. Each application has its own image and private nginx; infrastructure nginx remains the
single public TLS and routing layer.

### All-Docker frontend deployment

The frontend source repositories remain Docker-agnostic. All Dockerfiles, entrypoints, and private
nginx configurations are in `cedar-docker-build`; Compose topology is in `cedar-docker-deploy`.
Each image downloads one exact npm package from Nexus. Because npm versions are immutable, a Maven-
style moving `2.9.2-SNAPSHOT` package is not valid. The pinned package inputs instead use
`2.9.2-dev.<UTC-commit-time>.g<12-char-commit>` versions from clean source commits.

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

Stop all native frontend listeners, build and start the seven images, then recreate only the public
nginx with the Docker profile's reserved frontend addresses:

```bash
export CEDAR_HOME=$HOME/CEDAR
bash $CEDAR_HOME/cedar-development/ops/cedar-services.sh stop \
  frontend workspace designer ui-openview ui-content ui-monitoring ui-bridging

source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker-eval.sh
export CEDAR_AUTH_HOST_TARGET="$CEDAR_NGINX_HOST"
cedarcli docker build frontends
cedarcli docker start frontends -d

cd $CEDAR_HOME/cedar-docker-deploy/cedar-infrastructure
docker compose up -d --no-deps --force-recreate nginx
```

That final recreation is essential after hybrid operation: it removes the captured
`host.docker.internal` upstream values. Confirm `nginx -T` names the reserved `192.168.17.*`
frontend addresses, all seven frontend containers are healthy, and all seven public hostnames
return 200. The 2026-08-21 browser acceptance then opened the Smoke Tests folder in Workspace and
opened its template in Designer without console errors.

```bash
docker exec infra-nginx nginx -T 2>/dev/null | grep -A1 'upstream cedar-frontend'
docker ps --filter 'name=frontend-' --format '{{.Names}}\t{{.Status}}'
for host in cedar workspace designer openview content monitoring bridging; do
  curl -sk -o /dev/null -w "$host %{http_code}\n" \
    "https://${host}.metadatacenter.orgx/"
done
```

To return to the hybrid, run `cedarcli docker stop frontends`, start the seven native processes,
and repeat the `host.docker.internal` nginx override block in the preceding section. Backend
containers and named data volumes are untouched by either frontend switch. The concise topology
and package procedure is also in `cedar-docker-deploy/cedar-frontend/README.md`.

## REST acceptance gate

The repository's REST suites create and clean up their own fixtures. Run them from an ephemeral Node
container on `cedarnet`; this reaches the deliberately unexposed Artifact service and tests the
backend without involving any frontend.

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker-eval.sh

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

Stop frontends, then microservices, then infrastructure:

```bash
cedarcli docker stop frontends
cedarcli docker stop microservices
cedarcli docker stop infrastructure
```

Or use `docker compose down` in the corresponding three directories (only the backend two in
hybrid mode). This removes containers and the Compose networks but retains named data volumes. A
subsequent start reuses the data.

Do not add `-v`, run `cedarcli docker remove volumes`, or delete named volumes during an ordinary
restart. Those are destructive data-reset operations and need a backup plus explicit intent.

After the Docker projects are down and the ports are clear, source the native profile again before
restarting native CEDAR. Never mix values from the native and Docker profiles in one shell.

## Known limitations

- Snapshot images are buildable but not currently pullable through the checked-in Compose path.
- Image names hard-code `metadatacenter`; the historical `CEDAR_DOCKERHUB`/Nexus guidance only
  supports manual tag/push/pull and Compose cannot select that registry.
- The Docker profile is shared with hybrid operation and defaults auth routing to `host-gateway`.
- The CLI has explicit per-stack pull policies but no aggregate start/wait command that sequences
  the complete deployment and collects failed-container logs.
- Artifact is intentionally private to `cedarnet`; host-only test runners cannot exercise its
  cross-store contract directly.
- Java build success means compilation/package success because `cedarcli build java` uses
  `-DskipTests`.
- The runtime OpenSearch image is 2.19.1 while `cedar-parent` declares Java clients 2.19.2. This is
  accepted because their compatibility contract is the shared 2.19 line; Docker-build CI enforces
  that major/minor pairing mechanically.
