# CEDAR Build Runbook

A build train publishes an immutable set of Maven, npm and Docker artifacts from exact source
commits. Versions are changed only in disposable checkouts; native `develop` keeps its ordinary
`<NEXT>-SNAPSHOT` versions. Maven train artifacts use `<NEXT>-dev.YYYYMMDD.HHMM` in
Nexus `cedar-maven-dev`.

For local development, use `cedarcli build frontends` (build, checks, redeploy and smoke) or
`cedarcli test frontends` (build and checks). Both use current working-tree sources, including
uncommitted edits, and supply local packages to consumers without registry publication or tracked
pin changes. Their [SNAPSHOT completion contract](FRONTEND-RUNBOOK.md#the-reactor) is independent
of the clean, captured-source publication requirements below. The explicit
`split-frontends --server-payload` path follows the
[deployment procedure](PROD-DEPLOY-RUNBOOK.md#6--verify-and-rebuild-every-cee-host-to-the-intended-version).

The `Angular build isolation canary` checks that isolated builds preserve the live checkout on
Linux and macOS weekly, on dispatch
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
`docker-cedar`, for the 25 runtime images, and `docker-cedar-internal`, for the two Java base
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

Preflight runs two phases and collects every finding within each:

| Phase | Required checks |
| --- | --- |
| Local (seconds) | Maven/npm/27-image configuration; lock baselines; clean, pushed source; component consistency; npmrc key names; clean-archive packing of every published npm surface. A `prepack` must work without checkout `node_modules`. CEE's visual and CED's browser suites listed through the train's own Playwright report wrapper, which must list as many tests as each package's config. |
| Remote (roughly 90 seconds) | GitHub authentication and workflow; exact remote `develop` CI; cross-repository contracts covering their consumers; matching local/remote heads; idle train slot and unused ID; anonymous source access; passing smoke record for those heads; publication-target availability. |

A rehearsal runs both phases whatever the first one finds. Clearing a remote finding can take
minutes, a contract run or a smoke run for example, and that work can overlap the local repairs. A
dispatch stops after a local refusal, because that refusal already decides it.

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

Run `cedarcli check ci` after a release and before the next train. It lists captured `develop`
heads without passing CI, links their runs and prints `gh run rerun --failed` for failed jobs.

Some workflows check other repositories. The design tokens' Consumer contracts and Token readers
each check out eight consumers at `develop`. Their runs answer only for the consumer heads they
checked out, and a consumer push does not run them, so a consumer change can stay unchecked until
the tokens next change. That can be the release's own push, which then has to accept a red run
it cannot fix. `cedarcli check ci` therefore also requires the newest run of each contract at its
`develop` head to be green and to have started after every consumer's head was pushed, and the
dispatch preflight refuses otherwise. `cedarcli check ci --dispatch-stale-contracts` starts a run
of each contract no run covers yet; dispatch the train once they pass.

`cedarcli test e2e` runs the native REST, monolith-browser and split-application tiers and records
every train repository's `develop` head in `ops/e2e/reports/smoke-gate/`. Dispatch requires a passing
record for exactly the captured heads, the complete committed REST check inventory, and clean
sources during the run. Records do not expire, but any later commit, including a runbook edit,
requires another run. Unhealthy or stale managed services block smoke. No option skips this gate.
Live BioPortal availability is not part of that gate: terminology health does not fetch its catalogue,
and release smoke excludes legacy BioPortal pagination and live term-selection journeys. Offline
terminology route and SQLite integration tests remain required in their normal Java CI suites.

The exact-SHA CI probe retries only a short GitHub indexing absence and transient network or
502/503/504 failures. It names the repository, SHA, attempt, and delay. Pending or red CI,
401/403, malformed data, and a persistently absent run remain early failures; a pending verdict
includes the workflow URL rather than waiting through CI. The same captured CLI implementation is
loaded by hosted preflight, so the local rehearsal and runner cannot disagree about the policy.
Local preflight also inspects npmrc key names once without reading values: an obsolete setting that
changes authentication semantics blocks, while harmless future-version author-setting warnings are
reported once.

Each workflow answers for itself. A workflow whose every run at the commit was cancelled holds
the commit back until it is rerun, whatever another workflow concluded there.

A commit passes the CI check on a green GitHub Actions run or on a passing
[local CI](BACKEND-RUNBOOK.md#local-ci) run. The hosted preflight runs on GitHub's runner, which
holds no workstation's records. It reads a local run from the `cedar/local-ci` commit status that
the run posted. The dispatch preflight therefore refuses a commit whose only passing evidence is
this workstation's record, because the runner would see neither a green run nor a status. A record
made with `--no-status` is in that position wherever GitHub Actions is not green.
`cedarcli ci status --post` publishes the status of each such record.

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

The command repeats the complete preflight, derives the train ID from `cedar-parent` and the UTC
minute, and dispatches the workflow. Follow its compact status with:

```bash
cedarcli publish train-status --watch
```

Without an ID the command reports the newest dispatched train; an explicit ID selects an older
one. It reports Maven, all three npm stages, the Docker plan, compact completed/running/queued/failed
counts for the 27-image matrix, and final verification. During a long unchanged stage it prints a
quiet one-minute heartbeat with the active job/step and elapsed time. Without `--watch`, the same command is a
one-shot status and recovery decision. For GitHub's full step log, the dispatch also prints the exact
workflow run URL and `gh run watch` command using that run ID:

```bash
gh run watch <RUN_ID> --repo metadatacenter/cedar-development --compact --exit-status
```

The train publishes `@org.metadatacenter/cedar-design-tokens` before its consumers so they compile
the captured design values. The CLI registry defines this order;
`tests/test_design_tokens_registration.py` verifies it.

The workflow first captures the exact `develop` commit of every Java, npm, frontend, Docker, CLI,
and orchestration repository. Before it records train state or starts Maven, a hosted preflight
validates every captured file and the complete cross-repository configuration, requires green CI
or a passing local CI status for each exact source commit that defines a workflow, verifies every
required build surface, and
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
it in `cedar-development`, and rerun. npm's audit service answers inconsistently for a while after
an advisory is published, so a refresh can record a lock as clean that a later one does not. To see
a lock's current state, ask npmjs directly:
`npm audit --package-lock-only --prefer-online --registry=https://registry.npmjs.org/`. This is a
no-silent-regression gate, not a claim that the legacy AngularJS build-time graphs contain no
advisories. CEE's shipped dependency audit remains a
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
2. `cedar-libraries` and its declared library modules
3. `cedar-project`, which contains the shared microservice libraries, tools, and services
4. `cedar-clients`

Maven schedules modules within each phase with two threads by default (`build_train.py build
--threads 1` is the serial diagnostic path, maximum eight). The parent/library/service
phase boundaries remain ordered. All phases install into a job-local Maven repository seeded only with cached third-party downloads.
CEDAR artifacts are excluded when saving and restoring that cache. Nothing is published until every phase
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

Hosted dependency caches are keyed by OS, architecture and captured POM/lockfile content,
with stage-specific npm caches. Keys use committed inputs before train stamping or wiring.
Only npm download content and third-party Maven dependencies are cached; checkouts,
credentials, test results and build outputs are not. Every gate and package integrity check
still runs. The first run populates these caches; savings apply to subsequent runs.

After the common exact-source capture and preflight job, Maven assembly and the npm
chain run independently. The npm chain creates `npm/trains/<TRAIN_ID>.json` before
publication and runs model, parallel CEE/picker, then frontend jobs:

1. **npm 1/3 · TypeScript model.** The job first builds, publishes and verifies the captured design
   tokens under a train-owned version. It then stamps the captured model commit in its disposable
   checkout as `<MODEL_NEXT>-dev.YYYYMMDDHHMM.g<SHA12>`, runs lint, typecheck, coverage, JSON and
   YAML parity, and the packed-consumer test, then publishes the scoped package to Nexus. It
   downloads the result, verifies its registry integrity and `gitHead`, and records
   `npm/model/completed/<TRAIN_ID>.json`.
2. **npm 2/3 · CEE.** The job starts again from the captured CEE commit, pins the train-published
   model alias with integrity in both the root and visual lockfiles, wires the train-owned tokens,
   and stamps CEE as
   `<CEE_NEXT>-dev.YYYYMMDDHHMM.g<SHA12>`. On the ARM runner required by CEE, it runs the complete
   unit, coordinator, domain, visual, package, type and production-audit gate, with four
   workers by default (`frontend_train.py publish-cee --workers 1` for serial diagnosis). Only that tested
   package is published and verified; `npm/cee/completed/<TRAIN_ID>.json` records the result.
   The token-dependent term picker publishes in a separate ARM64 job alongside CEE. Both
   must pass before frontend preparation; the picker records its verified package identity separately.
3. **npm 3/3 · frontends.** The job verifies the already-published picker and builds the designer, wiring
   the train tokens into both and the train model into the designer. In fresh application
   checkouts, it pins those shared components and that exact CEE alias and
   integrity in all seven embedding manifests and lockfiles. It rebuilds Bridging, Monitoring and OpenView from those wired sources rather than packing
   their previously committed distributions; OpenView receives the same verified CEE tarball through
   its explicit Docker runtime input. It records hashes of every prepared manifest, lock and built
   payload before publishing the seven frontend packages.

The frontend publication job runs on Linux ARM64, matching component visual baselines.
Component setup installs the captured Playwright Chromium before browser tests; legacy
Karma consumers use that executable through `CHROME_BIN`, and Testem discovers the
same executable as `chrome` on the job PATH, including on clean runners.
The hosted runner grants user namespaces only to that executable with an AppArmor
profile and proves a sandboxed launch before spending time on component gates.
Component gates use the same frontend worker budget as consumer checks.
Picker and designer gates declare that they produce their publishable package. The
controller removes stale staging output before verification and publishes the resulting
package only after checking its train identity, without running a second `dist` build.
Legacy plans and components without that declaration retain their explicit build step.

CEE's hosted train gate builds and packages once, runs all source/domain/unit/coordinator gates
and its production audit, then transfers the candidate to four browser/visual shards. They keep
the pinned Linux ARM64 container, every browser project, screenshot baseline and existing skip.
The container's `--prebuilt` mode tests the transferred bundle and fixtures without rebundling.
Publication checks the complete test inventory and candidate hashes, and verifies the registry
contains the tested package bytes. Default local gates and container commands remain complete.

The hosted train builds CED once after its non-browser gates, then transfers that candidate to
four browser shards and a separate ARM64 visual-baseline job. Chromium, WebKit and real CEF/picker
inputs remain enabled exactly as in the full gate. Publication requires every shard's success,
the exact union of the original test inventory (including declared skips), and matching candidate,
source and dependency hashes. A missing, duplicate or foreign receipt refuses publication.
Workspace runs its complete checks and production preparation on a separate runner. Its verified
archive is restored by the final frontend job without rerunning those checks. The six independent
consumer repositories run their complete gates and production builds in isolated matrix jobs alongside
CED. Only the Template Designer host waits for CED publication. The final frontend job requires the
complete set of consumer archives, bound to the captured source, plan and configuration hashes; it
restores their tested outputs and exact lockfiles before recording and publishing the seven packages. Local and serial paths still run the
full gates; CED's `prepare` gate alone is not publication evidence.

The Template Designer host prepares its wired app and runs all non-browser checks once after CED
publication. Four isolated browser shards test that same app with the original Playwright settings,
including the real CED/Java conformance cases. Publication requires the complete test inventory,
every shard receipt and unchanged app bytes. The final job restores the verified host and all
other consumer outputs; it performs no browser rerun or rebuilding of transferred artifacts.

Before frontend publication, the final job runs the captured CLI's `prod configure-frontends`
twice and `prod reset-frontends` against temporary Git-backed copies of the actual assembled
OpenView, Bridging and Monitoring payloads. The baseline is the newly built output, not the old
dist committed in the source checkout. Configuration must change exactly one JavaScript module
per application, and only its compiled hostname; repeating it must make no further change. Reset
must restore every payload file and its permissions exactly. Missing or ambiguous configuration,
command failures and any other file changes fail the job before publication. The source payloads
are never modified. The `frontend-configuration` workflow artifact records the configuration
modules and original file hashes. This check adds no frontend build or browser rerun.


The remaining frontend preparation uses two concurrent repository jobs and four workers per job
(`frontend_train.py prepare-frontends --jobs 1 --workers 1` is the serial path). Each repository
waits only for its package and integration-bundle producers. Commands within a repository stay
ordered: dependency wiring, then the complete verification recipe. OpenView, Monitoring, Bridging
and the Template Designer host declare which verification command produces their production output.
The controller clears those output directories before checks, requires fresh nonempty output after
checks, and packages those same bytes without another install/build. Designer transfers both its
component assets and generated `app/host` bundle. Older plans retain their explicit build commands. Shared integration bundles
are staged atomically. The coordinator records hashes and overlays only after every repository
succeeds. A failed producer blocks its consumers and leaves no frontend completion evidence.

None of those version or dependency edits is written back to a source repository. They are
controlled transformations in isolated exact-commit checkouts, and their hashes become part of the
immutable npm plan. A frontend whose packaged bytes were prepared by the train uses the `p4`
packaging suffix; an unwired committed-source frontend retains `p3`. Missing packages are based on
`git archive HEAD`, then only the plan-recorded prepared paths are overlaid. An existing version is
accepted only when its `gitHead` is identical. Each frontend tarball carries an
`npm-shrinkwrap.json` normalized to its immutable package identity, and completion opens and hashes
that lock.

Finally, the workflow downloads every model, CEE and frontend tarball, verifies registry integrity
and records a SHA-256 in `npm/completed/<TRAIN_ID>.json`. Only then does `npm/current.json`
advance. A train therefore owns
the complete model → CEE → frontend chain; it never silently substitutes whichever dev packages
happened to have been published before the train began.

Nexus cleanup runs daily at 08:00 UTC: `npm-cedar` removes prereleases after three days and releases
after thirty. Completion therefore copies the train's tokens, picker, designer and model tarballs,
unchanged, to `npm-cedar-releases`, which has no cleanup policy and disables redeploy. Releases use
these retained packages for shared-component and non-CEE model pins. The completion record lists
them under `retainedPackages`; a release refuses a train without that evidence.

Once Maven completes, the workflow records `docker/backend-trains/<TRAIN_ID>.json` and starts
the twenty backend/base/infrastructure images while CEE and frontend gates run. That immutable
plan binds the source manifest, CLI and Docker-builder commits, image inventory and registry
references. It needs no npm completion. After npm completes, the full 27-image plan binds that
backend-plan hash to the verified npm graph and starts the seven frontend images. `cedar-java` and `cedar-microservice` publish to the internal repository. Seven
infrastructure, eleven microservice, and seven frontend images publish to the runtime repository.
Independent images build in parallel; the Java bases remain ordered. The verified npm plan supplies
the frontend build arguments, overriding compatibility defaults in `cedar-images-base.sh`. Those
defaults name published releases in the retained registry, so Docker CI remains reproducible after
train-package cleanup. Release readiness refuses expiring compatibility defaults before a train.
Development preserves the captured retained pins while the release tree adopts its own released
packages, as the release runbook describes. Every
image records the train, exact `cedar-docker-build` commit and source-manifest digest as OCI
labels. Backend images additionally record their backend-plan digest; frontend images record the
npm/frontend-manifest digest. Schema-3 plans/completions carry both digests. Verification of older
schema-2 trains retains their original all-images frontend-label contract. Each frontend image also contains the complete graph at
`/usr/local/share/cedar-build-manifest.json`. A train build compares each downloaded application
tarball to that graph before extraction. The three source-package images install with `npm ci` from
the vendored shrinkwrap; OpenView extracts the exact verified CEE tarball
directly, without resolving an npm dependency graph during the image build.

The final job removes local copies and pulls each of the 27 images from Nexus with
four bounded verification workers (`docker_train.py verify --workers 1` provides serial diagnosis).
Each worker owns a distinct image reference and records its elapsed time; completion is
written in plan order only after all workers succeed. Failed runs drain active workers
and never advance the completion pointer. It verifies the
labels, hashes the embedded manifest in every frontend container, and records the registry digest
and platform for every image. It stages `docker/completed/<TRAIN_ID>.json` and
`docker/current.json` locally; neither is published until fresh-stack acceptance passes.

On the same ephemeral Ubuntu runner, the final job checks out the captured CLI, deployment,
Docker-build and test-harness sources. It starts the verified images from empty volumes with no
admin-tool or entrypoint compatibility mounts. OpenView, Monitoring and Bridging must configure
production and non-production domains with exactly one hostname change and byte-exact restoration.
All six modern frontend images must serve ES modules with a JavaScript MIME type and return 404
for a missing module while preserving the existing JavaScript, CSS and HTML response types.
The real nginx-served applications then pass all 17 modern frontend scenarios (34 normal-profile
cold/warm checks), including authenticated Workspace, Designer, Monitoring and Bridging, public
OpenView, content, and standalone CEE/CED/CETP. Only standalone fixtures use the private static lab;
application payloads are not patched or substituted. Production DNS is blocked in the browser.
Timings remain reporting-only; failed loading, readiness, interactions or fixture cleanup fail the
train. The completion record carries `freshStackAcceptance`, with the workflow URL, report hash,
coverage and runtime identities; the `docker-fresh-stack-acceptance` artifact retains screenshots
and reports for 30 days. Sanitized diagnostics remain for 14 days. The runner stops its stack on
success or failure and never uses a workstation.

The internal `docker start all --verified-state <workspace>/build-trains --train <TRAIN_ID>` option
lets this GitHub-hosted gate read the controller's local verification record before publication;
image digest checks still apply. It is rejected on workstations and self-hosted runners. Normal
operators continue using the published completion record. The frozen daily calibration workflow
keeps its original train and compatibility adjustments, so acceptance does not reset its cohort.
The four administration images are optional and are not part of this pointer.

At deployment time, `cedarcli docker start` reads that completion record again. It applies the
selected pull policy, requires every selected local image tag to carry the recorded repository
digest, and then starts Compose with pulling disabled. A tag that is absent, locally rebuilt, or
now resolves to different registry content is rejected before any service starts. Every image tag
carries the train ID, and Nexus removes a `-dev.` tag from both Docker repositories three days after
upload, so a machine can pull a train's images only within three days of the train.
The fixed hosted performance baseline is explicitly exempted from cleanup; its exact retained
inputs and retirement procedure are recorded in the
[frontend runbook](FRONTEND-RUNBOOK.md#hosted-full-stack-measurements). This exception does not
extend the lifetime of other development trains.

<a id="what-a-train-costs"></a>

<a id="historical-train-timings"></a>

## Train Timing and State Writes

Use `cedarcli publish train-status --watch` and the linked workflow to measure the selected train.
Maven overlaps the npm chain; backend Docker builds start after Maven, while frontend images wait for npm. Timings from older serial workflows
or different image inventories are not estimates for the current train.

Concurrent state-branch writers rebase independent evidence commits with bounded retries;
conflicts stop the job and are never force-pushed. A `--dry-run` rehearsal repeats the preflight
work that dispatch will perform.

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

A completed train's status also reports release eligibility and names repositories whose `develop`
has moved. Source changes in drift-checked repositories require a new train.
Retries are selected by their last update, so a cancelled duplicate does not hide a later successful
retry of the original run. A recorded Docker completion makes status successful regardless of a
duplicate workflow's conclusion.

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

Resume requires `trains/<TRAIN_ID>.json` on the `build-trains` branch and repeats local preflight.
When GitHub still has the failed workflow, the CLI retries only its failed jobs with `gh run rerun
--failed`: successful jobs, including frontend verification, keep their outputs. The retry uses the
original workflow and captured commits. A complete train is never dispatched again.

If no workflow is available, the CLI dispatches a resume workflow that checks out the commits in the
manifest. Its hosted exact-source, credential, registry, and configuration preflight runs again.
Identical Maven files already present in
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
tarballs are compared by integrity and SHA-256, existing Maven paths by content hash/bytes, and all 27
Docker images by recorded registry digest and provenance labels. A green canary proves reachability
and authentication, not artifact identity.

Server jars are fetched in a pinned official Maven builder stage and only the resulting jar and
configuration cross into the UBI runtime. Server builds therefore do not install Maven with
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
- `docker/backend-trains/<TRAIN_ID>.json` records the twenty backend images and their independent provenance;
- `docker/trains/<TRAIN_ID>.json` records the exact 27-image publication plan;
- `docker/completed/<TRAIN_ID>.json` records the verified image digests; and
- `docker/current.json` points to the most recently completed Docker train.

The source manifest is never rewritten. The current pointer moves only after completion.

Inspect a train without opening the state branch manually:

```bash
cedarcli publish train-status <TRAIN_ID>
```

## Use a Train for Docker

Follow the Docker runbook's [mode prerequisites](DOCKER-RUNBOOK.md#prerequisites), then
[start the completed image train](DOCKER-RUNBOOK.md#start-the-docker-deployment):

```bash
cedarcli docker start all --train <TRAIN_ID> --pull missing
```

Starting without `--train` resolves `docker/current.json`; an explicit train must also have Docker
completion evidence. Maven completion alone does not prove a complete image set.

For image builds, use the Docker runbook's
[published-Maven path](DOCKER-RUNBOOK.md#completed-build-train-normal-published-artifact-build) or
[explicit local-source path](DOCKER-RUNBOOK.md#checked-out-java-source-explicit-local-build).
An interactive frontend image build uses the checkout's compatibility pins; pull the published
images when reproducing the train's exact frontend graph. Local tags are not proof of published
artifact identity.

## Failure Diagnosis

Use a plain exact version when a dependency key already equals its published package name.
npm canonicalizes a same-name `npm:` alias to that plain version. Renamed dependencies, such as
the unscoped model key consuming the scoped train package, still require an alias. Both train
verification and release preparation follow these two forms; test wiring against real npm as
well as mocked lockfiles so a generated-lock mismatch is caught before the hosted build.

Every train-built component needs a strict install-script decision and audit baseline, including
tokens, the term picker and the designer. A local install without strict enforcement can pass
while the hosted train refuses `npm ci`: the tokens build requires the reviewed
`@parcel/watcher@2.6.0` install script. The dispatch preflight checks these component graphs before
spending a train version, just as it checks the consuming applications.

An HTTP 502 during Maven upload can occur after compilation succeeds and after some immutable
files have reached Nexus. The 2.9.18 reactor-validation train hit it on large application jars.
The uploader retries transport failures with bounded backoff; if retries are exhausted, check
publication-target health and resume the same train ID while its captured source is unchanged.
Do not replace partially published versions. A source correction instead requires a new
smoke-covered train, even when the earlier failure itself was only a transport problem.

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

Pin that recorded version in both dependency surfaces and regenerate both locks with Node 24.22.1:

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

### Check a release-intended train before dispatch

When a train is intended for a release, supply all three explicit targets:

```bash
cedarcli publish train --release-version 2.9.19 --next-version 2.9.20-SNAPSHOT --cee-version 2.0.17 --dry-run
```

Remove `--dry-run` to dispatch after the same checks pass. The release target must
match the train base, and the next development version must advance. As `release plan` does,
the check first puts Java 17 and Node 24 on PATH when the shell offers other versions, and
prints a `Toolchain:` line for each substitution. Release
credentials, target refs and registry occupancy, toolchain and source contracts
are checked before the expensive train. A failed or unreadable prerequisite
refuses dispatch. Ordinary development trains need none of these options.

The same checks rehearse the CEE promotion proof that `release plan` runs once the train
exists. They prove the development package CEE's CI published for the captured `develop`
commit a promotion of the public CEE named by `--cee-version`, with the plan's own
comparison. A refusal stops the dispatch, because the plan would refuse the train's CEE the
same way. Release CEE from that `develop`, or remove the difference, first. When CEE's
model or design-token pins name packages built from commits other than the ones the train
captures, a refusal may be the pins' doing and is reported as advisory; move the pins to
rehearse exactly. When the public CEE is not yet on npmjs, the proof waits for
`release plan`.

The pre-train checks also survey every release repository's remote main/develop
sources and required license files. Main-only paths are labeled as declared generated
distributions or source/unclassified files; neither label bypasses review. After reviewing
the replacement, repeat `--accept-main-only REPOSITORY` for each accepted repository.
This train option requires release intent and does not carry acceptance into a later
`release plan|start`: supply the reviewed acceptance there again.

### Nexus failure budget and optional write probe

Train reads/uploads now stop after three transient attempts. HTTP 500 stops
immediately; a 429 without a short `Retry-After`, or a requested delay above
60 seconds, stops rather than spending more requests. A possibly accepted PUT is
reconciled against Nexus's checksum before another PUT. Preserve the train ID and
resume after recovery; do not allocate a new train to retry the same bytes.

`cedarcli publish probe` checks the existing read-only publication endpoints.
`cedarcli publish probe --upload` additionally writes, reads and removes a unique
64 KiB object, **only** in the dedicated Nexus raw repository `cedar-cli-probes`.
That repository must be provisioned with read, write and delete permissions; the
CLI does not create it or use a release repository as a scratch area. Cleanup is
attempted even after a lost PUT response, and a cleanup failure reports the exact
path. This small probe cannot establish that large uploads or later requests will
succeed. Status and GET success alone never establish upload recovery.
