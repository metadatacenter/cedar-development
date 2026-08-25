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

Run this from a configured CEDAR shell:

```bash
cedarcli build train
```

The CLI reads the next version from `cedar-parent`, adds the current UTC minute, and dispatches the
`cedar-development` workflow. The train ID is allocated automatically; operators do not choose it.

The workflow first records the exact `develop` commit of every Java, Docker, CLI, and orchestration
repository. It then builds Maven in the dependency order already encoded by the CEDAR reactors:

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
by Docker. Only a complete inventory creates `completed/<TRAIN>.json` and advances `current.json`.
A partial or failed train can never become current.

The workflow then records the expected Docker plan and builds the image estate in dependency
order. `cedar-java` and `cedar-microservice` publish to the internal repository. Seven
infrastructure, fifteen microservice, and seven frontend images publish to the runtime repository.
Independent images build in parallel; the Java bases remain ordered. Every image records the train,
the exact `cedar-docker-build` commit, and the source-manifest digest as OCI labels.

The final job removes local copies and pulls each of the 31 images from Nexus. It verifies the
labels and records the registry digest and platform for every image. Only then does it create
`docker/completed/<TRAIN>.json` and advance `docker/current.json`. The four administration images
are optional and are not part of this pointer.

## Resume a failed train

```bash
cedarcli build train --resume <TRAIN>
```

Resume requires `trains/<TRAIN>.json` on the `build-trains` branch and checks out the commits in that
manifest—not whatever is now at the head of `develop`. Identical Maven files already present in
Nexus are accepted; missing files are uploaded. When Maven publication is already complete, resume
skips it and continues with Docker. A Docker tag already present is accepted only when its train and
source-manifest labels match; a different image is a hard failure.

Use a new train rather than resume when you want to include a source change. A train ID always means
one fixed commit set.

## What the state branch contains

The `build-trains` branch is machine-owned operational state, separate from normal development:

- `trains/<TRAIN>.json` records the source commits, source snapshot version, frontend npm inputs,
  and target Maven repository;
- `completed/<TRAIN>.json` records successful Nexus verification; and
- `current.json` points to the most recently completed Maven train;
- `docker/trains/<TRAIN>.json` records the exact 31-image publication plan;
- `docker/completed/<TRAIN>.json` records the verified image digests; and
- `docker/current.json` points to the most recently completed Docker train.

The source manifest is never rewritten. The current pointer moves only after completion.

## Use a train for Docker

Ordinary Docker builds resolve the Maven `current.json` automatically:

```bash
cedarcli docker build infrastructure
cedarcli docker build microservices
cedarcli docker build frontends
```

Every resulting image receives the same train tag. Choose an older completed train exactly when
reproducing or diagnosing it:

```bash
cedarcli docker build microservices --train <TRAIN>
cedarcli docker start all --mode full --train <TRAIN> --pull never
```

`--train` on a build first requires Maven completion. Starting without `--train` resolves
`docker/current.json`, so a clean deployment never guesses that a Maven-complete train also has a
complete image set. An explicit start likewise requires the Docker completion record.

The local-source path remains explicit and independent of published trains:

```bash
cedarcli build java
cedarcli docker build microservices --local
cedarcli docker start all --mode backend --local --pull never
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
