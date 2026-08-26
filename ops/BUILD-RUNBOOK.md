# CEDAR Build Runbook

A build train is one immutable, internally consistent set of development artifacts and container
images. It solves the failure mode where one repository publishes a new Maven `SNAPSHOT` while
another repository—or a Docker build—still sees an older member of the same nominal version.

Native development does not change. The `develop` branches and checked-out POMs continue to use a
normal Maven snapshot such as `<NEXT>-SNAPSHOT`. A train job checks out exact commits into a
disposable workspace, changes their CEDAR versions only there, and publishes a version such as
`<NEXT>-dev.YYYYMMDD.HHMM` to the immutable `cedar-maven-dev` Nexus repository.

Keep the three identities distinct:

| Identity | Meaning | May its bytes change? |
| --- | --- | --- |
| `<NEXT>-SNAPSHOT` | Native-development convenience version on `develop` | Yes |
| `<NEXT>-dev.YYYYMMDD.HHMM` | One recorded development build train | No |
| `<RELEASE>` | A formal CEDAR release | No |

Operators never type the timestamp for a new train. `cedarcli` allocates it. The only train ID an
operator supplies is an existing one passed to `--resume` or `--train`.

## One-time administration

The Nexus hosted Maven repository must be named `cedar-maven-dev`, use the **Release** version
policy, and have **Disable redeploy** selected. The two Docker hosted repositories are
`docker-cedar`, for the 29 runtime images, and `docker-cedar-internal`, for the two Java base
images. Both use HTTPS path-based routing and **Disable redeploy**. Anonymous read access is
sufficient for deployments; the GitHub Actions account needs write and read access.

The `cedar-development` repository needs access to the existing organization secrets
`BMIR_NEXUS_USERNAME` and `BMIR_NEXUS_PASSWORD`. Its Actions workflow also needs permission to
write repository contents. The workflow uses that permission only for the dedicated
`build-trains` state branch.

## Create a train

Run the side-effect-free preflight from a configured CEDAR shell first:

```bash
cedarcli publish train --dry-run
```

This allocates a prospective ID, checks GitHub CLI authentication and the workflow on `develop`,
rejects an existing train ID, validates that the source-capture and TypeScript model → CEE →
frontend configurations agree, and prints the exact dispatch command. It does not start GitHub
Actions, publish an artifact, or write a manifest.

Then create the train:

```bash
cedarcli publish train
```

The CLI reads the next version from `cedar-parent`, adds the current UTC minute, and dispatches the
`cedar-development` workflow. The train ID is allocated automatically; operators do not choose it.

The workflow first records the exact `develop` commit of every Java, npm, frontend, Docker, CLI,
and orchestration repository. It then builds Maven in the dependency order already encoded by the
CEDAR reactors:

1. `cedar-parent`
2. `cedar-libraries` and its six library repositories
3. `cedar-project`, which contains the shared microservice library, admin tool, and services
4. `cedar-clients`
5. `cedar-model-library-roundtrip`

All phases install into a clean job-local Maven repository. Nothing is published until every phase
has compiled. The train's timestamp is also the Maven archive output timestamp, so rebuilding the
same manifest produces stable archive timestamps. Publication uploads only the resulting
`org.metadatacenter` files. If a destination
already exists, the workflow requires identical bytes and skips it; different bytes are a hard
failure. This is what makes recovery compatible with Nexus's no-redeploy rule.

After publication, the workflow queries Nexus for the libraries and runtime applications required
by Docker. Only a complete inventory creates `completed/<TRAIN_ID>.json` and advances `current.json`.
A partial or failed train can never become current.

Next, the workflow creates `npm/trains/<TRAIN_ID>.json`. It derives each frontend package version
from its captured commit, and enforces this graph before publishing anything:

1. the scoped TypeScript model package already exists in Nexus at the version in its published
   manifest and has the captured model commit as `gitHead`;
2. CEE pins that exact model version in both of its manifests and lockfiles, and the scoped CEE
   package already exists with the captured CEE commit;
3. every deployed CEE consumer pins that exact CEE alias and integrity in its source manifest and
   lockfile; and
4. all seven frontend packages are present at their commit-derived immutable versions. Missing
   frontend packages are published from the clean captured checkout; an existing version is
   accepted only when its `gitHead` is identical.

The model and CEE artifacts retain their own full release gates; the train will not manufacture one
by bypassing those gates. It stops with an instruction to publish the missing prerequisite first.
After publication, the workflow downloads every npm tarball, verifies its registry integrity and
records a SHA-256 in `npm/completed/<TRAIN_ID>.json`. Only then does `npm/current.json` advance.

The workflow then records the expected Docker plan and builds the image estate in dependency
order. `cedar-java` and `cedar-microservice` publish to the internal repository. Seven
infrastructure, fifteen microservice, and seven frontend images publish to the runtime repository.
Independent images build in parallel; the Java bases remain ordered. The verified npm plan supplies
the frontend build arguments, overriding compatibility defaults in `cedar-images-base.sh`. Every
image records the train, the exact `cedar-docker-build` commit, the source-manifest digest, and the
npm/frontend-manifest digest as OCI labels. Each frontend image also contains the complete graph at
`/usr/local/share/cedar-build-manifest.json`.

The final job removes local copies and pulls each of the 31 images from Nexus. It verifies the
labels, hashes the embedded manifest in every frontend container, and records the registry digest
and platform for every image. Only then does it create
`docker/completed/<TRAIN_ID>.json` and advance `docker/current.json`. The four administration images
are optional and are not part of this pointer.

## Resume a failed train

Inspect the resume without dispatching it:

```bash
cedarcli publish train --resume <TRAIN_ID> --dry-run
```

The preflight requires the immutable source manifest and reports the first incomplete stage. Then
resume it:

```bash
cedarcli publish train --resume <TRAIN_ID>
```

Resume requires `trains/<TRAIN_ID>.json` on the `build-trains` branch and checks out the commits in that
manifest—not whatever is now at the head of `develop`. Identical Maven files already present in
Nexus are accepted; missing files are uploaded. When Maven publication is already complete, resume
skips it and continues with npm and Docker. npm artifacts are accepted only when their `gitHead`,
integrity, and tarball bytes match the recorded graph. A Docker tag already present is accepted only
when its train, source-manifest, and frontend-manifest labels match; a different image is a hard
failure.

Use a new train rather than resume when you want to include a source change. A train ID always means
one fixed commit set.

## What the state branch contains

The `build-trains` branch is machine-owned operational state, separate from normal development:

- `trains/<TRAIN_ID>.json` records the source commits, source snapshot version, compatibility npm
  defaults, and target Maven repository;
- `completed/<TRAIN_ID>.json` records successful Nexus verification; and
- `current.json` points to the most recently completed Maven train;
- `npm/trains/<TRAIN_ID>.json` records the expected TypeScript model → CEE → frontend graph;
- `npm/completed/<TRAIN_ID>.json` records registry integrities and downloaded tarball hashes;
- `npm/current.json` points to the most recently completed npm graph;
- `docker/trains/<TRAIN_ID>.json` records the exact 31-image publication plan;
- `docker/completed/<TRAIN_ID>.json` records the verified image digests; and
- `docker/current.json` points to the most recently completed Docker train.

The source manifest is never rewritten. The current pointer moves only after completion.

Inspect a train without opening the state branch manually:

```bash
cedarcli publish train-status <TRAIN_ID>
```

## Use a train for Docker

Image builds are topology-independent and may run without a configured deployment mode; this is
how the isolated train jobs build from only their pinned CLI and Docker-builder checkouts. Starting,
stopping, inspecting, or otherwise managing a deployment still requires `docker` or `hybrid` mode.
On a dedicated Docker host, inspect the current selection first:

```bash
cedarcli mode
```

If no mode is selected, configure `docker` once. If the machine is already configured for
`hybrid`, keep that selection. A reported `native` mode must be stopped and cleared before it can
be replaced; do not overwrite a running topology.

```bash
cedarcli mode docker
```

Then build the image groups you need:

```bash
cedarcli docker build infra
cedarcli docker build microservices
cedarcli docker build frontends
```

Every resulting image receives the same train tag. Choose an older completed train exactly when
reproducing or diagnosing it:

```bash
cedarcli docker build microservices --train <TRAIN_ID>
cedarcli docker start all --train <TRAIN_ID> --pull never
```

`--train` on a build first requires Maven completion. Starting without `--train` resolves
`docker/current.json`, so a clean deployment never guesses that a Maven-complete train also has a
complete image set. An explicit start likewise requires the Docker completion record.

The local-source path remains explicit and independent of published trains:

```bash
cedarcli build java
cedarcli docker build infra --local
cedarcli docker build microservices --local
cedarcli docker build frontends --local
cedarcli docker start all --local --pull never
```

Local images keep the development tag declared in `cedar-docker-build`; they are not evidence that
the corresponding published train was reproduced.

## Failure diagnosis

Follow the dispatched job with:

```bash
gh run list --repo metadatacenter/cedar-development --workflow build-train.yml
gh run view <RUN_ID> --repo metadatacenter/cedar-development --log-failed
```

A credentials preflight failure means the organization secrets have not been shared with
`cedar-development`, or their Nexus account lacks access to `cedar-maven-dev`. A failure when
pushing the state branch means Actions does not have write permission. Maven compilation failures
need a source fix and a new train; transient upload failures can use `--resume`.
