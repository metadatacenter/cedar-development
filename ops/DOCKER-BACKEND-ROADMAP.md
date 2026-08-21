# CEDAR Docker Backend Roadmap

Scope: make the seven infrastructure and fifteen Java microservice containers a repeatable,
registry-backed deployment. Frontends and admin tools are deliberately excluded.

The current state is a useful development deployment, not yet a release delivery path: all images
build and the entire backend passes its REST gate, but a fresh machine cannot pull the snapshot image
set named by Compose. The focused operating procedure is in
[DOCKER-BACKEND-RUNBOOK.md](./DOCKER-BACKEND-RUNBOOK.md).

## P0 — make a fresh-machine deployment repeatable

### 1. Publish the 24 backend images to Nexus

Publish seven infrastructure images, `cedar-java`, `cedar-microservice`, and fifteen server images
after a successful backend image build. Keep the human-readable version tag and also publish an
immutable commit/build tag or digest so a deployment can be reproduced after a mutable snapshot is
rebuilt.

Acceptance criteria:

- a clean Docker engine can authenticate to Nexus and pull all 24 images for one release manifest;
- images are pushed only after the Java build and image build succeed;
- a manifest records image name, version, source commit, platform, and digest;
- no registry credential is baked into an image, repository, or Compose file; and
- failed or partial builds cannot update the deployable alias.

### 2. Parameterize the registry and namespace everywhere

Replace hard-coded `metadatacenter/...` references in Dockerfiles and Compose with one image prefix,
for example `CEDAR_IMAGE_PREFIX=nexus.example:port/metadatacenter`, defaulting to
`metadatacenter` for compatibility. The build CLI, base-image `FROM` lines, Compose projects, CI,
and release tooling must consume the same value.

Acceptance criteria:

- `CEDAR_IMAGE_PREFIX=metadatacenter` preserves today's local/Docker Hub names;
- setting the Nexus prefix makes `docker compose pull` and `up` use Nexus without retagging;
- `cedarcli docker validate` fails when a required prefix/version is malformed or inconsistent; and
- a static CI check prevents a new hard-coded CEDAR image reference.

### 3. Split full-Docker and hybrid profiles

The current evaluation profile defaults `CEDAR_AUTH_HOST_TARGET=host-gateway` for native nginx, but
the full Docker backend requires `$CEDAR_NGINX_HOST`. Make the deployment mode explicit instead of
requiring an easy-to-miss override.

Acceptance criteria:

- the full-Docker profile routes `auth.<host>` to the nginx container by default;
- the hybrid profile routes it to `host-gateway` by default;
- a token-verification probe is part of startup acceptance; and
- sourcing either profile without `CEDAR_HOME` fails immediately with a useful error.

### 4. Add one backend deployment command

Add a `cedarcli docker start backend` (or `deploy backend`) workflow that validates configuration,
checks port conflicts, verifies the network/cert volumes, applies an explicit pull policy, starts
infrastructure then microservices, waits for all 22 health checks, and prints failed-container logs.
Add the symmetric `status backend` and `stop backend` commands.

Acceptance criteria:

- `--pull always`, `--pull missing`, and `--pull never` are explicit choices;
- local builds can be started without an accidental registry lookup;
- startup times out with the unhealthy container and its last logs named;
- native port conflicts fail before containers are partially created; and
- ordinary stop retains all named data volumes.

## P1 — turn the working deployment into a release gate

### 5. Run the backend REST estate in CI from `cedarnet`

Use the in-network test topology from the Docker runbook so Artifact remains private while all
cross-store assertions run. Preserve logs and the Compose model as build artifacts on failure.

Acceptance criteria:

- all 19 REST suites run after 22/22 containers become healthy;
- the gate has zero topology-related `fetch failed` exceptions;
- fixture cleanup runs on pass, failure, timeout, and cancellation; and
- CI captures container health, inspect output, and bounded logs for every failed service.

### 6. Define a release manifest and promotion model

Do not rebuild the same release separately for development, staging, and production. Promote the
tested digests in Nexus and generate an environment-specific deployment manifest that changes
configuration, not image bytes.

Acceptance criteria:

- staging consumes exactly the digests that passed CI;
- production promotion changes aliases/metadata without rebuilding;
- rollback selects the prior digest set; and
- the deployed manifest is queryable from the running environment.

### 7. Make persistence operations explicit

Document each named volume, ownership, backup command, restore command, and upgrade compatibility
for MongoDB, MySQL, Neo4j, Redis, and OpenSearch. Test backup and restore against a disposable stack.

Acceptance criteria:

- operators can identify which volume holds each durable dataset;
- a restore drill recreates a working backend and passes a targeted REST gate;
- image upgrades that change on-disk formats require a migration plan; and
- destructive volume removal is kept outside ordinary stop/restart commands.

### 8. Align and check coupled versions

Resolve the current OpenSearch 2.19.1 server versus 2.19.2 Java-client declaration intentionally,
then enforce the chosen compatibility rule in CI. Extend the same mechanism to other coupled
components rather than relying on prose.

Acceptance criteria:

- CI reads the Docker version manifest and Java dependency declarations and checks the rule;
- a mismatched unsupported pair fails before image publication; and
- the runbook records the compatibility policy, not a hand-maintained duplicate version list.

## P2 — harden supply chain and operations

### 9. Produce SBOMs, provenance, scans, and signatures

Generate an SBOM and build provenance for every image, scan OS and application layers, and sign the
published digest. Establish an exception process with owners and expiry dates rather than silently
accepting vulnerabilities.

### 10. Remove non-reproducible and unverified build inputs

Pin base images by digest, stop blanket package updates in deployable builds, pin installed OS
packages where practical, and verify every downloaded distribution. In particular, remove the
plain-HTTP MySQL repository with signature checking disabled from the shared microservice image.

### 11. Declare supported platforms and resource floors

Build and test every supported architecture explicitly, or declare amd64-only if that is the actual
contract. Record Docker/Compose minimum versions and CPU, memory, and disk requirements for a cold
22-container start and a representative REST run.

## Recommended delivery slices

1. **Nexus pull path:** items 1-3. Outcome: a fresh machine can pull and authenticate correctly.
2. **One-command backend:** item 4. Outcome: repeatable operator experience and useful failures.
3. **Release gate:** items 5-6. Outcome: the digest that passed is the digest promoted.
4. **Durability and hardening:** items 7-11. Outcome: recoverable, auditable operation beyond a
   developer workstation.

