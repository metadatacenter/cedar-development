# CEDAR Build Runbook

A build train publishes an immutable set of Maven, npm and Docker artifacts from exact source
commits. Versions are changed only in disposable checkouts; native `develop` keeps its ordinary
`<NEXT>-SNAPSHOT` versions. Maven train artifacts use `<NEXT>-dev.YYYYMMDD.HHMM` in
Nexus `cedar-maven-dev`.

Local frontend builds (`cedarcli build frontends`, `build all`, `build this`) are compile-only: disposable source
copies, private npm caches, `CI=true`, and `npm ci` with each repository's declared peer mode.
They discard output and do not share a live development server's `node_modules` or Angular cache.
Manifest/lock disagreements fail rather than rewriting locks.

Ordinary builds compare tracked state across the estate before and after, even on failure.
Pre-existing edits are the baseline; changes made during the build fail the guard, including edits
from another session. Keep concurrent writers idle during this verification window. Publishing owns
tracked distributions. `split-frontends --server-payload` is an explicit in-place exception and
refuses to run while a development runtime owns the checkout.

The `Angular build isolation canary` checks this boundary on Linux and macOS weekly, on dispatch
and when its implementation changes. It keeps Monitoring's real development server running with
Angular caching enabled, runs `cedarcli build this`, and verifies health, cache, output and tracked
state. Logs and machine-readable evidence are retained even on failure.

Negative subprocess statuses are Unix signals. The controllers report `SIGABRT`, `SIGKILL` or
`SIGSEGV` and point to macOS Diagnostic Reports or Linux coredumps.

Keep the three identities distinct:

| Identity | Meaning | May its bytes change? |
| --- | --- | --- |
| `<NEXT>-SNAPSHOT` | Native-development convenience version on `develop` | Yes |
| `<NEXT>-dev.YYYYMMDD.HHMM` | One recorded development build train | No |
| `<RELEASE>` | A formal CEDAR release | No |

Operators never type the timestamp for a new train. `cedarcli` allocates it. The only train ID an
operator supplies is an existing one passed to `--resume` or `--train`.

## One-Time Administration

The Nexus hosted Maven repository must be named `cedar-maven-dev`, use the **Release** version
policy, and have **Disable redeploy** selected. The two Docker hosted repositories are
`docker-cedar`, for the 29 runtime images, and `docker-cedar-internal`, for the two Java base
images. Both use HTTPS path-based routing and **Disable redeploy**. Anonymous read access is
sufficient for deployments; the GitHub Actions account needs write and read access.

The `cedar-development` repository needs access to the existing organization secrets
`BMIR_NEXUS_USERNAME` and `BMIR_NEXUS_PASSWORD`. Its Actions workflow also needs permission to
write repository contents. The workflow uses that permission only for the dedicated
`build-trains` state branch.

## Create a Train

Optionally rehearse the side-effect-free local preflight from a configured CEDAR shell:

```bash
cedarcli publish train --dry-run
```

The dry run uses the real local dispatch gate, prints the dispatch command and a prospective ID,
and changes nothing. The ID is not reserved; a real dispatch allocates again. It neither starts
Actions nor publishes artifacts, changes client configuration or writes a manifest.

Preflight runs two phases, collecting all findings within each. Fix local failures and rerun before
remote checks become available:

| Phase | Required checks |
| --- | --- |
| Local (seconds) | Maven/npm/31-image configuration; lock baselines; clean, pushed source; component consistency; npmrc key names; clean-archive packing of every published npm surface. A `prepack` must work without checkout `node_modules`. |
| Remote (roughly 90 seconds) | GitHub authentication and workflow; exact remote `develop` CI; matching local/remote heads; idle train slot and unused ID; anonymous source access; passing smoke record for those heads; publication-target availability. |

The publication probe checks Nexus service/writable status, `cedar-maven-dev`, npm identity and
Docker Registry v2 authentication. Credentials come from `BMIR_NEXUS_USERNAME` /
`BMIR_NEXUS_PASSWORD`, falling back to `bmir-nexus-releases` in `~/.m2/settings.xml`.

Source access is tested with unauthenticated `git ls-remote`, stripping credential helpers,
askpass and injected Git configuration. A private repository or missing `develop` fails before
hosted state is recorded; if discovered after dispatch, the ID is spent and recovery needs a new
train. The source inventory includes the term picker and designer without Maven phases.

`cedarcli check components` also runs independently. Preflight refuses served bytes absent from a
host's lock, custom elements absent from locked bundles, or component pins unexplained by source
history. Merely lagging a published component is advisory.

CI environment drift is also advisory: `cedarcli check ci-env` compares Java workflows with
`ops/ci-env-block.yml`; `--apply` repairs copies for review and a separate commit in each repository.

The CI question is also answered on its own by `cedarcli check ci`. It lists every captured
`develop` head whose CI is not green, with the run to look at and, for a red run, the `gh run
rerun --failed` command that repeats only its failed jobs. A release advances `develop` in forty
repositories at once, so run it after a release lands and before the next train, rather than
learning about a red repository from the dispatch preflight hours later.

The smoke question has its own command as well. `cedarcli test e2e` runs both whole-stack tiers
under `cedar-development/ops/e2e`, the REST suite and the browser smoke, against the native stack,
and records the run under the `develop` head of every train repository at that moment, in
`ops/e2e/reports/smoke-gate/`. The dispatch preflight reads the record for exactly the heads the
train would capture. It refuses when there is no such record, when either tier failed, when the REST
run did not execute the committed check inventory, or when a repository held uncommitted changes
while the smoke ran. A run is evidence about commits rather than about a moment, so it never
expires, and a commit to any train repository after it, a runbook edit included, calls for a rerun
of about three minutes. The command itself refuses to start while any managed service is unhealthy
or stale, because a green run against a stale jar says nothing about the source. No option skips
the gate.

The exact-SHA CI probe retries only a short GitHub indexing absence and transient network or
502/503/504 failures. It names the repository, SHA, attempt, and delay. Pending or red CI,
401/403, malformed data, and a persistently absent run remain early failures; a pending verdict
includes the workflow URL rather than waiting through CI. The same captured CLI implementation is
loaded by hosted preflight, so the local rehearsal and runner cannot disagree about the policy.
Local preflight also inspects npmrc key names once without reading values: an obsolete setting that
changes authentication semantics blocks, while harmless future-version author-setting warnings are
reported once.

The two repositories that own the release machinery are hard gates, too. `cedar-cli` must have a
green `CI` run and `cedar-development` must have a green `Release tooling CI` run at their exact
captured commits. The in-progress `Immutable development build train` workflow is deliberately
excluded from the latter decision: a train cannot prove the controller that is already running it,
and it may not substitute for the independent controller test workflow. Both the local dispatch
preflight and the hosted captured-source preflight enforce this rule.

Then create the train:

```bash
cedarcli publish train
```

The real command repeats that complete local preflight; `--dry-run` is a useful rehearsal, not a
safety step the operator can accidentally omit. No additional parameter opts into these checks.
The CLI reads the next version from `cedar-parent`, adds the current UTC minute, and dispatches the
`cedar-development` workflow. The train ID is allocated automatically; operators do not choose it.
On a successful dispatch, the CLI prints two views. Use the compact watcher when the GitHub matrix
detail obscures the overall state:

```bash
cedarcli publish train-status --watch
```

Without an ID the command reports the newest dispatched train; an explicit ID selects an older
one. It reports Maven, all three npm stages, the Docker plan, compact completed/running/queued/failed
counts for the 31-image matrix, and final verification. During a long unchanged stage it prints a
quiet one-minute heartbeat with the active job/step and elapsed time. Without `--watch`, the same command is a
one-shot status and recovery decision. For GitHub's full step log, the dispatch also prints the exact
workflow run URL and `gh run watch` command using that run ID:

```bash
gh run watch <RUN_ID> --repo metadatacenter/cedar-development --compact --exit-status
```

`cedar-design-tokens` is one of the npm repositories captured, and it is registered ahead of every
repository that consumes it. CEDAR's font stack, type scale, brand palettes and neutrals are
published from there as `@org.metadatacenter/cedar-design-tokens`, and a consumer's styles resolve
that package from Nexus when its own build starts: a frontend built before the tokens publish reads
the previous snapshot and renders the previous values. The order lives in the CLI's repository
registry rather than in prose, and `tests/test_design_tokens_registration.py` holds it
there.

The workflow first captures the exact `develop` commit of every Java, npm, frontend, Docker, CLI,
and orchestration repository. Before it records train state or starts Maven, a hosted preflight
validates every captured file and the complete cross-repository configuration, requires green CI
for each exact source commit that defines a workflow, verifies every required build surface, and
requires `IMAGE_VERSION`, `CEDAR_MAVEN_VERSION`, and
`CEDAR_APPLICATION_VERSION` in the captured Docker defaults to equal the train's source snapshot.
It authenticates to Nexus, proves writable status, and reads the `cedar-maven-dev` repository
root, then reads npm's `/-/whoami` endpoint and completes the Docker Registry v2 token challenge.
These are HTTP reads: preflight does not run `docker login`/`logout` or change runner credentials.
The train repository uses a Release version policy, so artifact-level `maven-metadata.xml` is not
expected and is not a valid health probe there. A
repository with no workflow has no CI contract to query, so the gate names it and relies on the
train's own build gates. This hosted check uses the workflow's existing secrets and requires no
new CLI parameter.

The configuration also binds every npm install surface to the SHA-256 of the reviewed lockfile and
records the advisory counts observed by the last successful baseline train. A changed dependency
graph stops in preflight and names the repository and lockfile. `cedarcli publish baselines` lists
every lock whose digest has moved, and `cedarcli publish baselines --refresh` recomputes the digest
and the `npm audit` counts of each and writes them to `frontend-train.json`; review the diff, commit
it in `cedar-development`, and rerun. This is a no-silent-regression gate, not a claim that the
legacy AngularJS build-time graphs contain no advisories. CEE's shipped dependency audit remains a
separate blocking zero-vulnerability gate. npm 11 install scripts are similarly explicit: each
required package/version is pinned in `allowScripts`, and the train enables
`strict-allow-scripts`, so a newly introduced lifecycle script fails instead of merely warning.
The release uses this same validator and strict environment for every consumer install. When a
release stamps a version into a tracked root lockfile, it also refreshes that lock's train baseline
in the release and next-development `frontend-train.json`; the next train therefore does not inherit
a stale byte digest merely because the release changed the root package version.

Only after that gate passes does the workflow record the immutable source manifest. It then builds
Maven in the dependency order already encoded by the CEDAR reactors:

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

The train is immutable artifact assembly, not a second test runner: its Maven phases deliberately
use `-DskipTests`. Run `cedarcli build java` (tests are on by default) or confirm the per-repository
CI checks for the captured commits before dispatching a train. The train still aborts immediately on
any compilation, packaging, publication, or verification failure.

The train Maven settings expose release repositories only. Immediately after stamping, the
controller rejects any configured POM that still contains `-SNAPSHOT`, including a nonstandard
property or dependency the selective stamper did not rewrite. After all Maven phases finish—but
before publication—it also rejects any `org/metadatacenter/**/**-SNAPSHOT` version directory in the
job-local repository. These two gates prevent a mutable snapshot from being resolved into a jar
published under an immutable train version.

After publication, the workflow queries Nexus for the libraries and runtime applications required
by Docker. Only a complete inventory creates `completed/<TRAIN_ID>.json` and advances `current.json`.
A partial or failed train can never become current.

Next, the workflow creates `npm/trains/<TRAIN_ID>.json` before npm publication and runs three visible,
ordered jobs:

1. **npm 1/3 · TypeScript model.** The job stamps the captured model commit in its disposable
   checkout as `<MODEL_NEXT>-dev.YYYYMMDDHHMM.g<SHA12>`, runs lint, typecheck, coverage, JSON and
   YAML parity, and the packed-consumer test, then publishes the scoped package to Nexus. It
   downloads the result, verifies its registry integrity and `gitHead`, and records
   `npm/model/completed/<TRAIN_ID>.json`.
2. **npm 2/3 · CEE.** The job starts again from the captured CEE commit, pins the train-published
   model alias with integrity in both the root and visual lockfiles, and stamps CEE as
   `<CEE_NEXT>-dev.YYYYMMDDHHMM.g<SHA12>`. On the ARM runner required by CEE, it runs the complete
   unit, coordinator, domain, visual, package, type and production-audit gate. Only that tested
   package is published and verified; `npm/cee/completed/<TRAIN_ID>.json` records the result.
3. **npm 3/3 · frontends.** In fresh captured checkouts, the job pins that exact CEE alias and
   integrity in all seven embedding manifests and lockfiles. It rebuilds Bridging because Bridging
   vendors CEE into its distributed bytes; OpenView receives the same verified CEE tarball through
   its explicit Docker runtime input. It records hashes of every prepared manifest, lock and built
   payload before publishing the seven frontend packages.

None of those version or dependency edits is written back to a source repository. They are
controlled transformations in isolated exact-commit checkouts, and their hashes become part of the
immutable npm plan. A frontend whose packaged bytes were prepared by the train uses the `p4`
packaging suffix; an unwired committed-source frontend retains `p3`. Missing packages are based on
`git archive HEAD`, then only the plan-recorded prepared paths are overlaid. An existing version is
accepted only when its `gitHead` is identical. Each frontend tarball carries an
`npm-shrinkwrap.json` normalized to its immutable package identity, and completion opens and hashes
that lock.

Finally, the workflow downloads every model, CEE and frontend tarball, verifies registry integrity
and records a SHA-256 in `npm/completed/<TRAIN_ID>.json`. This also covers the public webcomponents
runtime tarball OpenView copies. Only then does `npm/current.json` advance. A train therefore owns
the complete model → CEE → frontend chain; it never silently substitutes whichever dev packages
happened to have been published before the train began.

The workflow then records the expected Docker plan and builds the image estate in dependency
order. `cedar-java` and `cedar-microservice` publish to the internal repository. Seven
infrastructure, fifteen microservice, and seven frontend images publish to the runtime repository.
Independent images build in parallel; the Java bases remain ordered. The verified npm plan supplies
the frontend build arguments, overriding compatibility defaults in `cedar-images-base.sh`. Those
defaults name development packages, and Nexus keeps only the last couple of trains' development
packages, so left alone they stop resolving within days and the Docker build's own CI goes red. A
release rewrites them from the train's recorded inputs, as the release runbook describes. Every
image records the train, the exact `cedar-docker-build` commit, the source-manifest digest, and the
npm/frontend-manifest digest as OCI labels. Each frontend image also contains the complete graph at
`/usr/local/share/cedar-build-manifest.json`. A train build compares each downloaded application
tarball to that graph before extraction. The three source-package images install with `npm ci` from
the vendored shrinkwrap; OpenView extracts the exact verified CEE and webcomponents tarballs
directly, without resolving an npm dependency graph during the image build.

The final job removes local copies and pulls each of the 31 images from Nexus. It verifies the
labels, hashes the embedded manifest in every frontend container, and records the registry digest
and platform for every image. Only then does it create
`docker/completed/<TRAIN_ID>.json` and advance `docker/current.json`. The four administration images
are optional and are not part of this pointer.

At deployment time, `cedarcli docker start` reads that completion record again. It applies the
selected pull policy, requires every selected local image tag to carry the recorded repository
digest, and then starts Compose with pulling disabled. A tag that is absent, locally rebuilt, or
now resolves to different registry content is rejected before any service starts.

## What a Train Costs

Train 2.9.8-dev.20260905.0436 took 36 minutes: nine and a half for the Maven phases, two for the
TypeScript model, eight and a half for the CEE gate on its ARM runner, two for the seven frontends,
five for the 31 images, and eight and a half to pull every image back and verify it. Everything but
the image matrix runs serially. The local dispatch preflight takes about a minute, most of it the
CI probe across the 45 captured repositories, and a `--dry-run` rehearsal pays it a second time.

## Resume a Failed Train

Start with the status command. It names the failed job and step when GitHub exposes one, links the
workflow, reports which publication completions are recorded, and prints the recovery decision:

```bash
cedarcli publish train-status <TRAIN_ID>
```

- No source record means publication could not have started: create a new train ID.
- A source record with incomplete publication is resumable when source and train configuration stay
  unchanged. If the correction changes either, commit it and create a new train instead.
- A Docker completion record means the train is complete: neither resume nor abandon it.
- For a few seconds after the workflow concludes, neither holds: the run has succeeded and the
  completion record is still being written. The decision names that window and asks you to look
  again rather than offering a resume, which would spend an immutable version on a train that was
  merely finishing.

A complete train also reports whether it can still back a release. A release stamps a train's exact
commits and refuses any repository whose `develop` has left them, so a train stops being releasable
the moment anything lands in one of the forty-five it captured. The verdict counts the repositories
that moved against what the train captured and names them, which is the difference between one
commit that can be explained and an estate that has moved on.

Train state has no abandon operation. An incomplete immutable ID remains useful evidence of what was
attempted; it cannot block a later ID.

Inspect the resume without dispatching it:

```bash
cedarcli publish train --resume <TRAIN_ID> --dry-run
```

The preflight requires the immutable source manifest, repeats the applicable local source and
configuration checks, and reports the first incomplete stage. Then resume it:

```bash
cedarcli publish train --resume <TRAIN_ID>
```

Resume requires `trains/<TRAIN_ID>.json` on the `build-trains` branch and checks out the commits in that
manifest—not whatever is now at the head of `develop`. The hosted exact-source, credential,
registry, and configuration preflight runs again before the workflow continues. Identical Maven files already present in
Nexus are accepted; missing files are uploaded. When Maven publication is already complete, resume
skips it and continues with npm and Docker. npm artifacts are accepted only when their `gitHead`,
integrity, and tarball bytes match the recorded graph. A Docker tag already present is accepted only
when its train, source-manifest, and frontend-manifest labels match; a different image is a hard
failure.

Use a new train rather than resume when you want to include a source change. A train ID always means
one fixed commit set.

## Publication-Target Canary

`publication-preflight-canary.yml` runs the same read-only Nexus, Maven, npm, and Docker probe every
day and on manual dispatch. A failure opens or updates the issue **Build-train publication preflight
is failing**; recovery closes it. This is an early warning for expired credentials, an unavailable
registry, or a repository-shape change. Pull-back verification remains part of every real train: npm
tarballs are compared by integrity and SHA-256, existing Maven paths by content hash/bytes, and all 31
Docker images by recorded registry digest and provenance labels. A green canary proves reachability
and authentication, not artifact identity.

Server jars are fetched in a pinned official Maven builder stage and only the resulting jar and
configuration cross into the UBI runtime. The 15 server builds therefore do not install Maven with
`microdnf`. This also avoids repeating libdnf's RHEL 9.7 OpenPGP-v6 warning for Red Hat's retained
post-quantum signing key; the two UBI base builds may still show the upstream warning while Red Hat's
multisignature plugin is unavailable in the minimal UBI repositories. Do not remove that key.

## What the State Branch Contains

The `build-trains` branch is machine-owned operational state, separate from normal development:

- `trains/<TRAIN_ID>.json` records the source commits, source snapshot version, compatibility npm
  defaults, and target Maven repository;
- `completed/<TRAIN_ID>.json` records successful Nexus verification; and
- `current.json` points to the most recently completed Maven train;
- `npm/trains/<TRAIN_ID>.json` records the expected TypeScript model → CEE → frontend graph;
- `npm/model/completed/<TRAIN_ID>.json` records the verified model publication;
- `npm/cee/completed/<TRAIN_ID>.json` records the verified CEE publication;
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

## Use a Train for Docker

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

## Failure Diagnosis

Follow the dispatched job with:

```bash
gh run watch <RUN_ID> --repo metadatacenter/cedar-development --compact --exit-status
gh run view <RUN_ID> --repo metadatacenter/cedar-development --log-failed
```

A credentials preflight failure means the organization secrets have not been shared with
`cedar-development`, or their Nexus account lacks access to `cedar-maven-dev`. A failure when
pushing the state branch means Actions does not have write permission. Maven compilation failures
need a source fix and a new train; transient upload failures can use `--resume`.

### CEE Source CI Cannot Install Its Pinned Model Package

A CEE source check can fail before a train with an npm 404 for an exact
`@org.metadatacenter/cedar-model-typescript-library` development tarball. A valid lockfile does not
prove that Nexus still retains every tarball it names: CEE's root and visual manifests may still
pin a package from an older development train after cleanup has removed that package. Do not
re-publish bytes under the missing immutable version and do not replace the dependency with an npm
tag.

Choose an appropriate completed train whose model package is still present. Its byte-verified
identity is recorded on the `build-trains` branch; read the version rather than guessing it:

```bash
gh api \
  -H 'Accept: application/vnd.github.raw+json' \
  'repos/metadatacenter/cedar-development/contents/npm/model/completed/<COMPLETED_TRAIN>.json?ref=build-trains' \
  --jq '.package.version'
```

Pin that recorded version in both dependency surfaces and regenerate both locks with Node 24.19.0:

```bash
cd $CEDAR_HOME/cedar-embeddable-editor
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact \
  cedar-model-typescript-library@npm:@org.metadatacenter/cedar-model-typescript-library@<RECORDED_MODEL_VERSION>
npm --prefix visual install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact \
  cedar-model-typescript-library@npm:@org.metadatacenter/cedar-model-typescript-library@<RECORDED_MODEL_VERSION>

NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true npm ci --no-audit --no-fund
NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true npm --prefix visual ci --no-audit --no-fund
```

Review the resulting dependency graphs, then refresh the CEE baselines and commit the result:

```bash
cedarcli publish baselines --refresh --repository cedar-embeddable-editor
git -C $CEDAR_HOME/cedar-development commit -m "Refresh the CEE npm audit baselines" ops/frontend-train.json
```

`cedarcli publish train --dry-run` must pass the local
lock-baseline check, and the pushed CEE commit must pass its complete CI workflow before dispatch.
This correction changes captured source, so create a new train ID; never resume an immutable train
to incorporate it. The new train will still replace this source-development pin in its disposable
checkout with the model package built and verified by that new train.
