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
completed immutable development train or built directly from checked-out source. A clean pull and
runtime acceptance of a completed train was re-proven on 2026-08-24 on Apple Silicon with Docker
Engine 29.6.2 and Compose 5.3.1:

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

The complete Maven → npm → Docker publication chain also completed successfully on 2026-08-26.
That run recorded and verified the TypeScript model, CEE, and seven frontend package inputs before
building the images. It then pulled all 31 images back from Nexus and verified their source and
frontend-manifest provenance before advancing the deployable Docker pointer.

The builder, Compose projects, CLI validation, and cleanup use `CEDAR_IMAGE_PREFIX` for the 29
runtime images. `CEDAR_BASE_IMAGE_PREFIX` can place the two Java bases in a separate internal
repository and otherwise defaults to the runtime prefix.

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
- For a normal published-image deployment: `cedar-cli`, `cedar-development`,
  `cedar-docker-build`, and `cedar-docker-deploy`. After installing the CLI,
  `cedarcli git clone docker` retrieves the latter three.
- The complete Java source tree only when building microservice images from checked-out source.
  Hybrid mode additionally needs all seven frontend source repositories and their native Node
  toolchains.
- `$CEDAR_HOME/set-env-external.sh` and `set-env-internal.sh` configured for the installation.
- A JDK 17 only when compiling Java; pulling and running a published train does not require it.
- The certificate identity and CA password values in `set-env-internal.sh` configured for the
  installation. First-time setup creates a local CA and leaves under `$CEDAR_HOME/CEDAR_CA` when
  they are absent; it reuses complete custom certificate pairs and refuses partial state.
- At least 32 GB of memory allocated to Docker's virtual machine wherever the terminology server
  reads a local store. The reason, and what too small an allocation looks like from the outside,
  are in [Sizing Docker's Virtual Machine](#sizing-dockers-virtual-machine).

The Docker backend and native backend cannot run together: they claim the same infrastructure and
9xxx ports. Native and containerized frontends likewise cannot share their seven frontend ports.
The supported hybrid is deliberate: Docker owns the backend and public nginx while the seven native
frontend servers replace the seven frontend containers.

Begin by asking the CLI which topology currently owns the machine:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli mode
```

If it reports `native`, stop that stack and clear the selection:

```bash
cedarcli native stop all
cedarcli mode --clear
```

If it reports `hybrid`, stop both owned surfaces before clearing:

```bash
cedarcli native stop frontends
cedarcli docker stop all
cedarcli mode --clear
```

If it reports `docker`, run `cedarcli docker stop all` and then `cedarcli mode --clear`. If no mode
is set, there is nothing to clear. After the selected deployment is stopped, verify that the ports
are actually free:

```bash
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

Native and hybrid selections must name the native environment explicitly:

```bash
cedarcli mode native --profile develop   # workstation
cedarcli mode native --profile server    # staging or production host
cedarcli mode hybrid --profile develop   # workstation hybrid stack
cedarcli mode docker                     # no native profile
```

There is no default profile: `cedarcli mode native` or `cedarcli mode hybrid` without
`--profile develop|server` fails without recording a mode. `develop` selects local frontend builds
and the workstation-only TLS allowance for `.orgx`; `server` selects served frontend payloads,
requires certificate verification, and rejects placeholder server secrets. The option chooses the
environment that later native child processes receive; it does not start anything. By contrast,
`cedarcli mode` with no mode argument only reports the recorded mode and profile.

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

Image builds do not require a selected deployment mode: they consume the Docker manifest and their
explicit registry/train inputs without reading a runtime profile. Commands that manage or inspect a
deployment remain gated by the configured `docker` or `hybrid` mode.

Create and publish a new immutable Maven, npm, and Docker train with:

```bash
cedarcli publish train
```

The workflow records one source manifest, then completes three ordered publication stages:

1. It compiles and publishes the immutable Maven graph.
2. It stamps and publishes the captured TypeScript model as an immutable development package, wires
   and tests the captured CEE against that exact model, publishes CEE, pins it into the seven
   captured frontend packages, and verifies every tarball, integrity value, and source commit.
3. It builds the two internal bases and 29 runtime images from those Maven and npm inputs, then
   pulls and verifies all 31 before advancing `docker/current.json`.

The Maven, npm, and Docker completion pointers move independently and only after their own stage
has passed. A failed train never becomes the current deployable Docker train. Resume a failed
publication with the train ID printed by the original command:

```bash
cedarcli publish train --resume <TRAIN_ID>
```

### Completed build train: normal published-artifact build

An ordinary Docker build reads the completed Maven-train pointer recorded by `cedar-development`.
The infrastructure and Java images receive that train's version as their image tag, and the Java
images download that exact immutable Maven version from `cedar-maven-dev`:

```bash
cedarcli docker build infra
cedarcli docker build microservices
```

Do not use an interactive frontend build to claim reproduction of the frontend portion of a
published train. The central workflow injects the train's verified npm graph and embedded frontend
manifest; a normal shell build instead uses the compatibility package pins in the checked-out
Docker manifest. Pull the published images for an exact train, or use the explicit local path below
for development work.

Select a particular completed train instead of the current pointer when reproducing it:

```bash
cedarcli docker build microservices --train <TRAIN_ID>
```

### Checked-out Java source: explicit local build

This is the path used for the 2026-08-21 deployment proof. The Java build installs the parent,
shared libraries, the 70-module server reactor, and clients in dependency order, running the unit
and embedded integration suites by default. Use `--skip-tests` explicitly only for a previously
verified compile/install loop; the REST gate below remains the deployment acceptance test. `--local`
then stages each newly built fat JAR into its server image and clears the staged file after the
build.

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

All seven frontend images are part of the normal build group. A published train derives an
immutable package version from each captured frontend commit, verifies the corresponding Nexus
tarball, and passes those exact versions into the image build. Each frontend image contains
`/usr/local/share/cedar-build-manifest.json`, which records the train, source-manifest digest, npm
plan digest, package commits, integrity values, and tarball hashes. Publication verifies the file
and its digest label after pushing and pulling the image. During a train build, the Dockerfile also
requires its downloaded application tarball to match the recorded SHA-256 before extracting it.
Main, Workspace, and Template Designer then use `npm ci` with the shrinkwrap vendored into the
published package; OpenView extracts its verified CEE and webcomponents tarballs directly. Thus a
rebuild does not re-resolve transitive package versions. The local `--local` compatibility path may
still consume an older package without a shrinkwrap, but it is explicitly not a reproducible train.

Each image also carries its exact application source commit. The Main, Workspace, and Designer
entrypoints pass that identity into Gulp, so RequireJS module URLs change with the source even when
the Maven-style application version does not. Modern Angular production bundles use content-hashed
filenames. Private nginx never stores entry/config responses, marks only content-hashed JavaScript
and CSS immutable, and makes stable fallback assets revalidate.

`cedar-docker-build/bin/cedar-images-base.sh` retains exact package pins as compatibility defaults
for a local shell build. They are not the source of truth for a published train, and neither path
uses a moving npm snapshot or dist-tag.

The full core build inventory is 31 images: seven infrastructure images, two Java bases, fifteen
microservices, and seven frontends. `cedarcli docker build all` additionally builds the four
optional admin images, for 35 total.

## One-time Docker setup

Run this before the first deployment, or after intentionally recreating the CEDAR network and
certificate volumes. It creates `cedarnet` at `192.168.17.0/24`, creates a local CA and any missing
leaf certificate pairs without rotating existing complete pairs, then populates the two external
certificate volumes from that local material. It does not fall back to private keys bundled in
`cedar-docker-deploy`.
It removes an existing `cedarnet` while recreating it, so do not run it under a live CEDAR stack.

```bash
cedarcli docker setup one-time-setup
```

For repair work, the same `docker setup` group exposes the three constituent operations as
`create-network`, `create-certificates-volume`, and `copy-certificates`. The aggregate command is
the normal first-deployment path.

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
still building. Use `--train <TRAIN_ID>` to select an exact Docker-complete train. When the images came
from `docker build --local`, add `--local` to start so Compose selects the development tag instead.

`--pull never` uses the images already present on the machine and fails if one is absent. This is
the safe choice for locally built development images. Use `--pull missing` to fetch only absent
images, or `--pull always` when the deployment must refresh every image from its configured
registry. Use the separate `admin` target for optional administration containers. Use
`--timeout SECONDS` to change the ten-minute readiness deadline.

For a published train, every pull policy is followed by the same fail-closed gate: the CLI loads
`docker/completed/<TRAIN_ID>.json` and compares each selected tag's `RepoDigests` with the verified
digest in that record. Compose is then forced to `--pull never` so it cannot re-resolve a tag
between verification and start. This also makes resume safe: a pre-existing tag is reused only
when its registry digest matches the completion record.

The fifteen Java services run as the fixed non-root identity `10001:10001`. Before starting that
stack, the CLI prepares the log, Resource state, and Terminology cache named volumes once and marks
each migrated volume with `.cedar-owner-10001`. This makes volumes created by older root-running
images safe to reuse without deleting their data. The brief ownership container runs as root with
`--pull=never` from an already selected microservice image (Artifact for aggregate starts); the
service containers themselves remain non-root. The shared CA stays read-only, and each service
imports it into its own user-writable
truststore.

The Java runtime images also carry no build tooling: each server's jar is fetched with Maven in a
build stage the served image never keeps, so neither Maven nor the JDK its package drags in exists
at runtime. The seven frontend containers run nginx as the image's own unprivileged `nginx` user —
every vhost listens on a high port, the start-time writes (the gulp build, the `index.html` host
rewrite) stay inside the app home the image hands that user, and the pid file lives in `/tmp`. The
`log_frontend_*` named volumes predate this and receive no writes; nginx logs go to the container's
stdout. The one nginx still running as root is `infra-nginx`, the TLS edge — converting it moves
its listeners off 80/443 and remaps Compose ports, tracked in
[DOCKER-ROADMAP.md](./DOCKER-ROADMAP.md).

The command validates all Compose projects, checks the Docker daemon, `cedarnet`, certificate
volumes, and published ports, and then starts infrastructure, microservices, and frontends when
selected by the configured mode. It waits after each stage. A timeout names the unhealthy services
and prints at most 100 recent log lines for each. Finally, it verifies that a backend container can
reach Keycloak's signing configuration and checks the public frontend routes in `docker` and
`hybrid` modes. The aggregate deliberately excludes the optional admin project.

Individual stack commands remain available for troubleshooting. Published-train starts retain the
same digest and volume-ownership gates. They preserve the recorded mode when recreating nginx, but
they do not perform the aggregate preflight or readiness sequence.

## Health gate

The Docker-aware status command reads the configured CEDAR mode, checks the appropriate Compose
inventory and acceptance probes, and exits nonzero when a required container or route is not ready.
It also reports the completed image train recorded by the last successful aggregate Docker start.
`cedarcli native status` is rejected in hybrid and Docker modes because its host-port inventory
would report false backend failures.

```bash
cedarcli docker status
```

A microservice container reads healthy when the dependencies it holds answer, not merely when its
process is alive: every one of the fifteen probes Neo4j, and each adds Mongo, MySQL, OpenSearch or
its own Redis queue where it owns one. The `depends_on` edges in the microservice stack order the
start and do not wait on health, so an unreachable database marks one container unhealthy instead of
preventing the containers behind it from starting at all. Staged readiness belongs to
`cedarcli docker start`, which brings up infrastructure, microservices and frontends in turn and
waits between them. What each server probes, and why a dependency is gating rather than reported, is
in [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md).

The command renders one compact table grouped by infrastructure, microservices, and (in full Docker
mode) frontends. Each row shows Compose health, whether the running image matches the configured
image set, published or internal ports, and the container restart count. `MISMATCH` is the Docker
equivalent of a native `STALE` binary: a healthy container is still rejected when its configured
image reference does not match the selected train or local development tag. The summary records
container readiness, acceptance-probe readiness, and the image set in one line; failures are named
below the table instead of being buried in a wide free-form detail column.

Do not use `cedarcli native status` as a container health check. If that lower-level native
controller is run directly, it labels container-owned rows `docker` in both PID and HEALTH, labels
Artifact's unexposed port `internal`, and points back to `cedarcli docker status`. Those labels say
which runtime owns the service; only the Docker-aware command reads Compose health and acceptance
probes.

## Keycloak signing keys

The development realm seed contains realm settings and test accounts, but no signing, encryption,
HMAC, or AES key provider material. Keycloak generates a unique set of providers when it imports the
realm for the first time. Keep exported provider material out of both the Keycloak image source and
the native `os-mirror` copy; repository tests reject it in both locations.

Rebuilding the image does not rotate an existing realm because Keycloak stores its providers in
MySQL. That matters beyond copied databases: the seed shipped before 2026-08-26 carried its RSA
signing key, HMAC secret and AES secret in public git history, so **every realm that ever imported
that seed — production, staging, and long-lived local stacks alike — is running on publicly known
keys until its providers are rotated**, and a token such a realm verifies proves nothing. In each
affected realm, create fresh providers, remove the imported ones, and only then treat the
installation as trusted. Rotating providers invalidates tokens signed with the previous key, so
users must sign in again. The strip alone is not the fix; the keys remain recoverable from
history.

Admin tools are optional and managed separately from the aggregate deployment:

```bash
cedarcli docker build admin --train <TRAIN_ID>
cedarcli docker start admin --train <TRAIN_ID> --pull never --detach
cedarcli docker stop admin
```

The four admin images are outside the verified 31-image Docker-train pointer. Build them explicitly
for the train used by the deployment before starting them.

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
cedarcli mode hybrid --profile develop
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
| Hybrid | Seven macOS development-server processes | `cedarcli mode hybrid --profile develop`, then native frontends and `cedarcli docker start all` | Proven local development mode |
| All-Docker frontends | Seven containers on `cedarnet` | `cedarcli mode docker`, then `cedarcli docker start all` | Proven on 2026-08-21 |
| Native-only stack | Seven native development servers | `cedarcli mode native --profile develop`, then `cedarcli native start all` | Preserved; Docker work does not change it |

Do not run native and containerized frontends on the same published ports. The normal frontend
Compose stack now contains Template Editor, Workspace, Designer, OpenView, Content, Monitoring, and
Bridging. Each application has its own image and private nginx; infrastructure nginx remains the
single public TLS and routing layer.

### All-Docker frontend deployment

The frontend source repositories remain Docker-agnostic. All Dockerfiles, entrypoints, and private
nginx configurations are in `cedar-docker-build`; Compose topology is in `cedar-docker-deploy`.
Each image downloads one immutable npm package from Nexus. The build train derives the TypeScript
model, CEE, and seven frontend package versions from their captured source commits, publishes and
verifies that complete graph, then injects its exact identities into the Docker build. Public npmjs
releases remain independent; a formal CEDAR release later proves its chosen public CEE is
byte-equivalent to the development CEE the train tested.

Commit the frontend source changes and publish the coordinated train:

```bash
cedarcli publish train
```

The train refuses dirty or mismatched source, records each package commit and registry integrity,
and embeds that npm graph in every frontend image. Use the resulting completed Docker train when
the deployment must be reproducible. Do not substitute a moving npm dist-tag or treat the
compatibility pins used by an interactive shell build as published-train provenance.

Stop the hybrid deployment, clear its mode, and configure Docker mode. The aggregate
command starts the frontend containers and restores nginx's container upstreams as part of the same
operation:

```bash
export CEDAR_HOME=$HOME/CEDAR
cedarcli native stop frontends
cedarcli docker stop all
cedarcli mode --clear
cedarcli mode docker
cedarcli docker start all --pull missing
```

The mode switch removes captured `host.docker.internal` upstream values before checking all seven
frontend containers and public routes. The 2026-08-21 browser acceptance then opened the Smoke
Tests folder in Workspace and opened its template in Designer without console errors.

For a one-off image experiment using the compatibility package pins in the checked-out Docker
manifest, use the explicit local path:

```bash
cedarcli docker build frontends --local
cedarcli docker start all --local --pull never
```

A local build is useful for development but is not a completed train and must not be promoted as
one.

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
switch. The concise Compose routing contract is also in
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
  -e CEDAR_WORKER_BASE=http://server-worker:9011 \
  -e CEDAR_KEYCLOAK_BASE=http://infra-keycloak:8080 \
  -e CEDAR_ADMIN_USER_API_KEY \
  -e CEDAR_FRONTEND_local_USER1_LOGIN \
  -e CEDAR_FRONTEND_local_USER1_PASSWORD \
  -e CEDAR_FRONTEND_local_USER2_LOGIN \
  -e CEDAR_FRONTEND_local_USER2_PASSWORD \
  node:20-alpine node rest-smoke.mjs
```

Resource and Terminology deliberately go through containerized nginx so this also covers their
published API and Swagger UI routes. Artifact stays on its internal service address, and Worker is
addressed directly because its diagnostic-authentication checks have no nginx vhost. Expected: 19
suites pass and the final result is `PASS`. The first invocation may pull `node:20-alpine`.

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

## Browser acceptance gate

Run the authenticated browser journey from the host after the REST gate:

```bash
export CEDAR_HOME=$HOME/CEDAR
source $CEDAR_HOME/cedar-development/bin/templates/cedar-profile-docker.sh
cd $CEDAR_HOME/cedar-development/ops/e2e
npm run smoke:docker
```

The Docker profile records container bridge addresses for service-to-service traffic. Those
addresses are not host-routable on Docker Desktop for macOS, so `smoke:docker` deliberately uses the
published localhost ports for its REST setup and teardown while the browser continues through the
production-shaped HTTPS hostnames. Do not replace it with plain `npm run smoke` for this topology.
The journey logs in, creates and constrains a template, populates and re-edits an instance through
CEE, verifies JSON and YAML getters, opens it anonymously through OpenView, and removes everything
created by that run.

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
cedarcli mode native --profile develop
```

The CLI supplies the selected profile internally; do not mix native and Docker profile values in the
calling shell.

## Known limitations

- Published build-train images currently target `linux/amd64`. Docker Desktop runs them through
  emulation on Apple Silicon; native multi-architecture publication remains roadmap work.
- An interactive frontend image build uses compatibility package pins and does not reconstruct the
  verified npm graph of a published train. Use published images for exact reproduction or `--local`
  for an explicitly local experiment.
- Artifact is intentionally private to `cedarnet`; host-only test runners cannot exercise its
  cross-store contract directly.
- The runtime OpenSearch image is 2.19.1 while `cedar-parent` declares Java clients 2.19.2. This is
  accepted because their compatibility contract is the shared 2.19 line; Docker-build CI enforces
  that major/minor pairing mechanically.
