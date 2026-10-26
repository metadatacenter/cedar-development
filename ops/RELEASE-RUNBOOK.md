# CEDAR Release Runbook

Cut a CEDAR release from a completed [build train](BUILD-RUNBOOK.md). For deployment use
[PROD-DEPLOY-RUNBOOK.md](PROD-DEPLOY-RUNBOOK.md); for local operation use
[BACKEND-RUNBOOK.md](BACKEND-RUNBOOK.md). The optional
[release monitor](cedar-release-monitor.html) opens directly in a browser.

These are release requirements. An ordinary development frontend build uses
`cedarcli build frontends` with current-source SNAPSHOT packages, including uncommitted edits.
It needs no release preparation, registry publication, pin update or additional authorization.

> Replace `<VER>` and `<NEXT>` with the release version and the next development version, for
> example `2.9.4` and `2.9.5-SNAPSHOT`.

## The Route

A release stamps the completed train's exact commits and verifies that published artifacts match
the train. Create the train using [BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md).

<a id="ask-what-the-workspace-can-answer-first"></a>

### Check Workspace Readiness

Run workspace readiness before creating a train, so fixes do not invalidate its captured source:

```bash
cedarcli release readiness --version <VER> --next-version <NEXT>
```

It checks consumer inventories, Maven modules/artifacts, npm publication surfaces and version
arithmetic, and packs each surface from a clean commit archive. A `prepack` depending on checkout
`node_modules` fails here. Versions are optional; `--skip-packaging` omits packing. Allow about ten
seconds. Registry inventories, digests and CEE equivalence require the completed train and remain
in `plan`.

For one combined read-only report, use:

```bash
cedarcli release readiness --full --version <VER> --next-version <NEXT> \
  --model-version <PUBLIC_MODEL> --cee-version <PUBLIC_CEE> --from-train <TRAIN_ID>
```

This reports public tarball integrity and identity, CEE's declared and embedded model pin,
consumer manifest/lock pins, exact-source CI, matching whole-stack smoke, clean/pushed
sources, release prerequisites, and the train's artifact/equivalence and source-eligibility
checks. Each gap includes a next action. Before a train exists, omit `--from-train`;
its evidence is explicitly `not checked`, not green. Omitted versions and skipped packing
are likewise incomplete. The command returns nonzero for failed or incomplete evidence.
It does not dispatch, publish, accept exceptions, or replace `release plan|start`.

### The Plan

Run a read-only plan with four explicit inputs. The CLI owns the immutable manifest under
`~/.cedar/train-releases/`; do not supply a manifest path or infer versions from the train ID.

```bash
cedarcli release plan \
  --version <VER> \
  --next-version <NEXT> \
  --from-train <TRAIN_ID> \
  --cee-version <PUBLIC_CEE_VERSION>
```

`plan` changes nothing. It validates the completed train, the exact source commits, the artifact
inventories—including the complete 28-image Docker plan and immutable registry digests—the explicit
versions, and the byte-equivalence proof between the train's development
CEE and the public npmjs CEE, and then runs the complete release gate. It must finish with
`No changes made.`

<a id="nothing-may-land-between-the-train-and-the-release"></a>

### Source Freeze

A release stamps the train's exact commits and refuses any captured repository whose `develop`
has moved. Finish CI, tooling and documentation changes before creating the train. A later source
change requires a new smoke-gated train.

The TypeScript model library is the one repository the release writes to without freezing it. Its
`develop` may move while a release runs, because the release commits the library's one change onto
`develop` as it then stands. The release refuses only when `tools/conformance/pom.xml` has changed
since the train captured it.

Use `cedarcli publish train-status` to check eligibility and identify moved repositories.
CEE's public and development version bases need not match: eligibility depends on the
[package equivalence proof](NPMJS-RELEASE-RUNBOOK.md#use-the-public-cee-in-a-train-backed-cedar-release),
whose permitted normalizations are defined in the npmjs runbook.

## What Plan Checks

`plan` and `start` run the same complete gate.

Preflight prints elapsed time for each check, including a check that fails. Remote
release-ref availability and dry-run push-permission probes use four concurrent
repositories and a 60-second deadline per probe. Findings remain in repository order;
a timeout blocks the release rather than being treated as permission or availability.
On the 16-core M4 Max (2026-09-25), these two checks across the release inventory
measured 62.4 seconds serial and 17.5 seconds with four workers, with identical passing
findings. Network conditions affect the timing; the actual release pushes remain ordered.

The plan settles four groups of question:

- **The machine can run a release.** Java 17 and Node 24.22.1 are active, `git`, `mvn`, and `npm`
  are on PATH, Git author name and email are configured, the CEDAR profile is sourced, npm's
  effective user configuration contains no obsolete authentication setting, and there is disk for
  the release's estimated clean checkouts, release/next Maven and frontend builds, publication
  caches and logs, plus headroom. No test-owned `mongod` executable under `~/.embedmongo` may be
  left from an earlier run; `cedarcli test status` inventories these processes and `cedarcli test
  cleanup` terminates only those exact embedded executables, never the native MongoDB. The estimate
  is derived from the manifest's repository and build counts rather than a fixed free-space
  threshold. The npmrc check reads key names only and never prints registry tokens or values. When
  the shell offers another Java or Node, the CLI looks for the required ones itself, through
  `/usr/libexec/java_home -v 17` and Homebrew's `node@24`, puts them first on PATH for the run, and
  prints a `Toolchain:` line for each substitution. When it finds neither, the plan names the export
  to run.
- **The source is ready.** Every participating repository—including the independent repositories
  whose CEE wiring the release integrates—is clean and pushed, and the CI run for the exact commit
  the train was built from is green wherever that commit defines a workflow. A whole-stack smoke
  run recorded by `cedarcli test e2e` against exactly the train's source commits has passed every
  tier. The immutable source
  also contains every declared wrapper, manifest, lock, build, preserve, version, and Docker stamp
  input before a long build is allowed to start. Every frontend lifecycle script in the captured
  lockfiles has an exact true/false `allowScripts` decision.
- **The writes will be accepted.** Both Nexus credentials are available and authenticate, npm holds an
  identity for both of CEDAR's Nexus npm registries, `npm-cedar` and `npm-cedar-releases`, the
  release version is absent from the Maven target and from both npm registries, and each remote
  accepts dry-run pushes of every ref the release can create: `main`,
  `develop`, `release/pre-<VER>`, `release-<VER>`, and, where applicable,
  `release/post-<NEXT>`. The TypeScript model library takes only `develop` and
  `release/post-<NEXT>`, so the plan asks its remote about those two alone.
- **The content is stampable.** Every file a Maven build regenerates with the version inside is
  declared, every `license.txt` carries a recognisable copyright line, and each remote's `main`
  holds nothing that `develop` does not. The TypeScript model library's conformance POM names both
  CEDAR libraries at the train source version, and the library's remote `develop` still carries
  that file as the train captured it.

Content present only on `main` blocks the release because integration replaces that tree. Port
unmerged hotfixes to `develop` before building the train. If the removal from `develop` was
intentional, use `--accept-main-only <repository>` after reviewing it; the ledger retains that
acceptance for resume. Branch-specific version stamps do not count as divergence.
Run `cedarcli check main` before creating the train to find this early.

Release build validation runs the Angular, Ember and React demo lint and test suites
against the prepared public CEE pins, in both release and next-development workspaces.
Frontend install, verification and build tasks precede the Maven builds. A failed
consumer check stops before publication and retains its log for `release resume`.

New release plans include a `development` phase between publication and acceptance.
It verifies published snapshot bytes and the prepared next-development train/audit
configuration, then checks CI at every exact integrated develop commit except the TypeScript
model library's, whose `develop` also carries work the train did not capture. The phase
dispatches `cedar-libraries` and `cedar-project` verification only after all sibling
refs are integrated; their earlier push runs are not accepted as this proof.
Pending CI is polled for up to 30 minutes, and a red result stops immediately with
the run URL. `release resume` continues from recorded dispatch intents and evidence,
without rebuilding or blindly dispatching duplicate runs. An uncertain dispatch
response must first be reconciled with GitHub; if no run exists, dispatch its CI
workflow on the unchanged develop ref, then resume. Final acceptance checks remote
refs again. Previously created release ledgers retain their original phase contract.

Neither a release nor a train needs `cedarcli check versions --strict`. A release stamps a train's
exact commits rather than anything on this machine, and the train's own preflight requires every
checked-out repository's `develop` to equal the live remote `develop`. The strict form is for a host
that builds from its own checkout, which is the production and staging deploy route rather than this
one.

**Nexus reads fall back to anonymous** and succeed whether or not credentials are available, so the
presence of `BMIR_NEXUS_USERNAME` and `BMIR_NEXUS_PASSWORD` proves nothing. The CLI uses those
variables when both are set; otherwise it reads the username and password from the
`bmir-nexus-releases` server entry in `~/.m2/settings.xml`. The Maven settings reader handles both
namespaced and unnamespaced settings files and never prints either value. There is no `release auth`
command: credential resolution and authentication happen automatically during `release plan`,
`release start`, and `release resume`. The plan then authenticates against an endpoint anonymous
callers cannot reach, and reads a repository as well, because the status endpoints answer from the
web tier and stay green while everything behind them fails.

The content probe reads retained release metadata for `cedar-parent`. Snapshot metadata may be
absent after cleanup even while repository reads and train uploads work. A missing probe (404)
is reported as a missing repository read, never as daily request-budget exhaustion; that diagnosis
is reserved for the observed HTTP 500 response with writable status still healthy.

**A Nexus over its request budget looks like an outage.** The instance is Community Edition, with a
limit on requests per day, and when it is over that limit it serves its status endpoints and returns
500 for every repository path. The plan names that shape rather than reporting a generic failure,
because it is the one condition that gets worse the harder a release tries: every retry spends the
budget that is exhausted. The budget is a rolling 24-hour window, so the answer is to stop and let it
roll off, and to check the Usage Center for what is consuming it. A train is a few hundred requests,
so a run of failed trains is itself a substantial contributor.

**CI must cover the train's exact source commit.** A missing, unreadable, queued or running
required check blocks the release. A repository with no workflow at that commit is advisory.

GitHub may briefly return no run while indexing a just-pushed SHA, and it may transiently return
502/503/504. The shared train/release probe gives only those cases a bounded retry, naming the
repository, short SHA, attempt, and delay. Authentication or authorization refusal, malformed data,
settled red CI, and a persistently absent run fail immediately or at the end of that short grace. A
queued or running run is not waited through; the refusal carries its workflow URL.

**The smoke gate is asked about the same commits.** `cedarcli test e2e` runs the REST, browser and
split smoke tiers against the native stack and records each run under the `develop` heads it tested, in
`cedar-development/ops/e2e/reports/smoke-gate/`. The record that answers for a train therefore
survives later runs against newer heads, and a release days after its train still finds it. The
gate refuses when no run covers the train's source, when any tier failed, when the REST run did
not execute the committed check inventory, or when a repository held uncommitted changes while the
smoke ran. Unlike a red develop, nothing accepts a missing or failed run. The answer to a flaky run
is to rerun it.

**Component pins must be reproducible.** Preflight uses `cedarcli check components` to reject
unexplained package provenance, served bytes inconsistent with the lock and custom elements absent
from locked bundles. Merely lagging a published component is advisory. Local bundle overrides are
excluded because release builds use isolated, locked installs.

**Frontend installs use the same policy in train and release.** `plan` reads `package.json` and
`package-lock.json` from each train-captured commit, requires every `hasInstallScript` dependency to
have an exact true/false `allowScripts` decision, and names any missing package/version before a
workspace is created. Preparation and both release/next build variants then set
`NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true`; no release path merely warns and continues. npm user settings
that npm no longer recognises are reported once in plan rather than on every install. Obsolete
authentication semantics such as `always-auth` block; harmless author metadata is one advisory.

The Docker source carries three suite selectors: `IMAGE_VERSION`, `CEDAR_MAVEN_VERSION`, and
`CEDAR_APPLICATION_VERSION`. Plan requires all three to equal the train source version, and release
stamping advances all three together on the release and next-development variants. This prevents a
new Docker tag from silently building old Maven or frontend application inputs.

When CI is genuinely broken for a reason that must not hold up a release, accept the specific run:

```bash
cedarcli release start ... --accept-red-develop cedar-repo-server=33211136456
```

The acceptance names one repository and one run. `start` records it in the ledger, and
`release resume` applies it again, so a release that stops before its remotes are written can still
be resumed. No flag skips the check for everything.

## Running the Release

```bash
cedarcli release start \
  --version <VER> \
  --next-version <NEXT> \
  --from-train <TRAIN_ID> \
  --cee-version <PUBLIC_CEE_VERSION>
```

Run in a `cedar` shell inside `tmux` to survive disconnects. Without the alias, export
`CEDAR_HOME` and invoke `bash "$CEDAR_HOME/cedar-cli/cli.sh" <args>`. For unattended execution,
use that entry point under `nohup`, redirect output to a file and follow it with `tail -f`;
the CLI line-buffers redirected output.

Transient transport retries are built in, so a network fault does not end a long release. The
bounded policy covers direct connection failures, HTTP 502/503/504 from resumable Git, Maven, and
npm commands, and Git's server-side 5xx failures.
It does not retry a changed tree, protected-ref refusal, failed byte verification, authentication
failure, or Nexus HTTP 500. The last one is deliberately a hard stop because it is also how the
daily request-budget failure presents itself.

Before snapshot publication, release publication, and final acceptance, a Nexus circuit breaker
makes only two cheap probes: writable status and one real repository read. It opens before any
ledger mutation or bulk registry verification. A direct connection failure remains eligible for
bounded retry; an HTTP refusal does not.

New release manifests record two concurrent build jobs, four frontend workers per job,
and two Maven reactor threads in `buildConcurrency`. Set these through `release start
--jobs N --workers N --maven-threads N`; resume uses the recorded limits. Independent
repositories and release/next-development variants may overlap. Each repository keeps
its own install/check/build order, and Maven phases wait for that variant’s frontend
checks and prior Maven phases. Only the coordinator writes progress and completion
evidence; a failure stops new work, drains active tasks, and retains successful tasks
for resume.
Release tests remain enabled; next-development compile and snapshot deployment use the
same thread limit. Older manifests without this policy retain serial Maven execution. New manifests also
reuse the validated next-development Maven repository during snapshot deployment, rather
than downloading dependencies into a second empty cache. The deploy lifecycle and
post-publication inventory verification still run. Exact-commit CI probes use at most
four workers; only the coordinator records their results, and settled repositories are
not polled again.

The release runs these phases, each verifying its work before the next begins:

1. Clone every train source commit into isolated workspaces, and pin the public CEE version in all
   seven frontend consumer manifests and lockfiles. Shared-component pins (tokens, picker and
   designer) also follow the train's verified package graph, at the copies the train retained in
   `npm-cedar-releases`. So does every other pin of the model library, in the designer and the
   applications alike, because the train built each of them against the model it published
   itself. CEE follows the model too, but the release pins the public CEE in its place. The copies carry the train's versions and bytes, at an
   address Nexus does not clean up. Their exact registry tarball and integrity are checked before
   and after lock generation, and preparation refuses a lockfile that still installs any tarball
   from another Nexus repository.
2. Stamp `<VER>` and `<NEXT>` from the same source commits, and move the copyright year in every
   `license.txt` to the release year. Both variants retain the stable public CEE wiring. The
   Docker build's frontend defaults in `cedar-images-base.sh` are rewritten from the train's
   recorded inputs. The next-development tree names the train's own packages, which exist the
   moment the release pushes. The release tree names the released frontends at `<VER>`, OpenView's
   Editor at the public CEE version, and `npm-cedar-releases` as `CEDAR_NPM_REGISTRY`, because
   those two registries keep a package indefinitely. The next-development tree also moves the two
   CEDAR versions in the TypeScript model library's `tools/conformance/pom.xml` to `<NEXT>`.
3. Run the release Maven test builds, the next-development Maven builds, all frontend installs, and
   the production frontend builds. A frontend installs with the whole setup the train and the
   reactor run for it, so a test package's own install and the browsers it drives are in place
   before its verification commands. Generated distribution bytes are inventoried, so an ignored
   `dist` file cannot change before publication. Each test-bearing Maven task checks for embedded
   MongoDB children both before it starts and after it returns; a leak stops the phase with the PID,
   listener, and `cedarcli test cleanup` recovery command instead of allowing a later task to reuse
   the port.
4. Replace each tracked frontend distribution with its byte-inventoried production build, retaining
   only its package metadata and removing obsolete generated files, then create and verify local
   `release/pre-<VER>`, `release/post-<NEXT>`, and `release-<VER>` refs without touching the ordinary
   CEDAR working trees. For OpenView, this also proves that the distributed CEE bundle is the public
   CEE selected by `--cee-version`, with only the declared production endpoint normalization.
5. Deploy the next-development Maven snapshots, in dependency order, from the prepared `develop`
   trees, and verify their Nexus inventory. Immutable build trains remain the owner of development
   frontend packages, so this route does not republish `-SNAPSHOT` npm versions.
6. Fetch the remotes, refuse to continue if a remote `develop` moved away from the train source,
   create explicit integration commits, then push the release branches, the tag, `main`, and
   `develop`. The TypeScript model library takes `develop` and `release/post-<NEXT>` alone. Its
   integration commit merges the prepared commit into `develop` as it stands at that moment,
   changes only the conformance POM, and is rebuilt on a `develop` that moves during the push. It
   stops only when `develop` has changed that POM since the train, or no longer contains the train
   source. Later checks, acceptance among them, require only that the library's `develop` still
   contains the commit.
7. Upload the exact locally validated Maven release bytes to Nexus, accepting an existing immutable
   path only when its bytes match, and verify the required artifact inventory.
8. Pack the nine stable npm surfaces from the exact integrated commits, record `gitHead`,
   and retain explicitly declared runtime assets that npm normally excludes. OpenView's packaged
   `node_modules` assets therefore include the exact CEE and Web Components files committed in its
   release distribution. The model-library demo's ignored `dist` is copied only from its
   byte-inventoried release build. Publish each tarball to `npm-cedar` and the same bytes to
   `npm-cedar-releases`, then download it from both and verify its integrity, content hash,
   provenance, and runtime-asset hashes. Nexus removes a release from `npm-cedar` thirty days after
   upload, so the retained copy is the one that lasts.
9. Verify next-development snapshot bytes, train/audit configuration and CI at the integrated
   `develop` commits other than the TypeScript model library's. The `development` phase and its
   resume rules are described above; older ledgers retain their original phase contract.
10. Accept the release, proving from outside the ledger that it holds. Acceptance also runs the
   captured build-train configuration validator against the complete `<NEXT>` workspace and its
   exact expected snapshot version, so `develop` is not considered ready merely because version
   stamping and publication succeeded.

Nothing reaches a remote until every local ref has been created and verified, so a release that
fails during preparation has changed nothing outside the machine it ran on.

The snapshots are deployed before the remotes, rather than after, because integrating the remotes is
what advances `develop` to the next version everywhere at once, and the CI each of those pushes
triggers resolves the parent and the libraries at that version from Nexus. Publishing first means
those builds find what they are looking for.

Integration writes the prepared tree to `main`. Replaced main-only content remains reachable
through the integration commit's first parent; restoring it requires a commit on `develop`.

The stable npm surfaces are Template Editor, Workspace, Template Designer, the TypeScript model
library demo, OpenView, Content Distribution, Monitoring, Bridging, and the Angular CEE demo.

<a id="what-a-release-costs"></a>

## Historical Release Timings

Release 2.9.8 ran 63 minutes from `start` to acceptance on the development workstation, with
Nexus and GitHub responsive throughout: about ten minutes to clone forty repositories and pin the
CEE in seven consumers, twenty to run the forty release and next-development builds, fifteen to
deploy the six snapshot trees, under ten to integrate and push forty remotes, ten to upload and
verify the eight release artifacts, and one to accept. The release before it, 2.9.7, ran 2 hours
41 minutes through the same phases. Release 2.9.20 ran 67 minutes, 24 of them in the development
phase and 20 of those waiting for `cedar-project`'s CI on the new `develop`. Plan on its own takes
about two and a half minutes, most of it the exact-commit CI probe and the remote survey.

## Watching and Finishing

`start` and `resume` automatically summarize measured stage timings on completion.
`cedarcli release timings` reads them later; `--compare <VER>` selects a prior release
(otherwise the newest other release with timing evidence is used).
Each attempt retains its result and wall time. CI polling sleeps and transient retry
backoff are measured separately from execution, which includes build work, network
requests and CI probes. Failed attempts remain in the totals. A process killed before
its final timing write leaves an explicitly incomplete record. Older ledgers have no
measured split and are reported as unavailable. Comparisons require matching workload
and concurrency signatures and complete timing evidence; source and network conditions
may still differ, so a delta is an observation rather than a benchmark.

Before resuming, `cedarcli release resume --dry-run` explains the recorded phase,
completed phases/tasks to preserve, the exact preflight checks the next stage repeats,
and the remaining build, ref, publication, CI and acceptance operations. It reads the
ledger only: no toolchain activation, lock acquisition, network probes, builds or writes.
Recorded completion remains provisional until real resume verifies its evidence. Partial
version preparation explicitly previews the required fresh frontend/version attempt.

```bash
cedarcli release status --watch
```

`start` and `resume` show compact phase/task progress by default. Full Maven, npm, embedded-service,
and package output is retained in the attempt's preparation, build, and publication logs instead of
flooding the terminal; add `--verbose` only when live raw output is useful. The watcher prints on a
state change and otherwise a quiet one-minute heartbeat with elapsed time, the active task, phase
counts, Maven file counts, a scheduled transient retry, and the exact terminal failure. Ctrl-C
stops only the watcher; it remains attached while automatic backoff is in progress.

The controller itself also emits a one-minute progress heartbeat during long stages,
including parallel task identifiers, the attempt log directory, and pending development
CI links. Unchanged CI polling messages are limited to once a minute. One-shot status
checks the kernel-held release lock to distinguish a running controller from a stopped
one: it recommends watching the running controller and resuming a stopped release.

Without `--watch`, `release status` is a one-shot phase table. It says `COMPLETE` only at acceptance,
marks the single next or failed phase, and prints the exact safe commands to run next. Every Maven
file is still checkpointed with completed/total, both disposition counts, and its current path, so
status can show `Maven files 47/126` instead of appearing stuck at `0/8`. Resume rechecks immutable
bytes and continues safely. Ledgers written by the earlier combined publication phase are interpreted
by task identity, so their snapshot records do not inflate the release-artifact count.

Acceptance is the last phase, and it is what makes the release self-proving. It asks, from outside
the ledger that recorded the work, whether every repository carries the release tag, every remote ref
stands where the ledger says, every published artifact still matches its recorded bytes, and the
frontends pin the proven CEE. It also proves that OpenView's committed distribution and published
npm artifact contain the normalized bytes of that exact public CEE, and that the complete prepared
next-development workspace passes its captured Maven/frontend/Docker train configuration with the
exact `<NEXT>` snapshot version. This is artifact and development-state acceptance;
after deployment, the environment smoke check must still prove which artifact the web server is
actually serving. A completed release reports `Release <VER> — COMPLETE` and shows acceptance at
`1/1`.

An accepted release advances `develop` in every repository it integrated and leaves the local
checkouts on the commits before it, so it prints what the next train needs: `cedarcli git pull`,
then `cedarcli check ci` and `cedarcli test e2e` at the new heads.

After successful acceptance, the controller retains the current `release/pre-<version>` and
`release/post-<next>` branches and removes older pairs, whose trees remain tagged. A refused delete
is recorded under `branchRetirement` without failing the accepted release. Failed acceptance
leaves the older branches intact.

Acceptance also marks the release concluded and frees the active slot. There is no separate
`finish` command. If the process stops after writing the accepted ledger but before marking its
pointer concluded, `cedarcli release resume` repairs that final bookkeeping step without rerunning
the release.

Only `COMPLETE` means successfully released. `ABANDONED` means the retained attempt was closed
without releasing it; every other status remains incomplete.

Local release state has a one-release retention policy. The current release keeps its ledger,
numbered attempt, caches, and logs so `status` and `resume` remain complete. When a new release takes
the current slot, the state layer immediately deletes every older ledger and attempt tree—including
dependency caches and large logs—before the new attempt is prepared. It first copies each deleted
ledger's stage timings into `timings/<version>.json`, a few records that `release timings` compares
against. There is no cleanup command and no archive tier: Git refs and published artifacts are the
durable record after a release stops being current.

## If a Phase Fails

Do not start again. A failure stops the release, records the reason, and retains the failed attempt
under `~/.cedar/train-releases/attempts/<VER>/`. Nothing in the current attempt is rolled back or
deleted, because it is the evidence needed by `resume`. It is deleted automatically only if a later
release replaces it as current.

```bash
cedarcli release status
cedarcli release resume
```

Resume starts at the recorded phase, verifies the completed evidence that phase consumes, and then
continues. Before doing so, it automatically reruns the checks that are still relevant at that
phase: local preparation rechecks the source and toolchain contract; remote integration rechecks
the exact refs and push permissions; publication rechecks credentials, registry health, and target
objects. It does not demand that conditions deliberately changed by an already completed phase
still look like a brand-new release. Remote ref drift, changed local evidence, or a different
immutable registry object is a hard stop; transient transport retry is automatic. No resume option
is required to enable this phase-aware gate.

An attempt whose immutable train is itself the problem cannot be repaired by `resume`. If the
release has not gone beyond `local-refs-created`, retain and close it explicitly:

```bash
cedarcli release abandon \
  --version <VER> \
  --reason "superseded by corrected train <TRAIN_ID>"
```

The exact version is a guard against closing the wrong active release, and the reason is stored in
the ledger. Abandonment marks status `ABANDONED`, retains the manifest and numbered attempt tree
while it remains current, frees the active slot, and permits another attempt at the same release
version. Starting that replacement makes it current and internally prunes the abandoned ledger and
attempt; there is no long-term abandoned-attempt archive.

`abandon` is deliberately unavailable once snapshot publication may have begun, even when no
snapshot task reached its completed-ledger write: Maven may have changed Nexus before returning a
failure. It likewise refuses any attempt with snapshot, remote-integration, or artifact-publication
evidence. From that boundary onward, repair the state and use `release resume`.

Never edit a ledger or a release manifest by hand. Those files are the release's own record of what
it verified, and a hand-edited record makes every guard downstream of it meaningless.

One release is active at a time. Acceptance closes a successful release; guarded abandonment closes
a local-only attempt that must be replaced by another train.

### Known Failure Signatures

| Signature | Meaning | Recovery |
|-----------|---------|----------|
| HTTP 502/503/504 or a direct connection failure on `./mvnw deploy` | transient Nexus transport/service failure | `release resume`; bounded retry is automatic |
| Nexus HTTP 500 while status is writable but a repository read fails | likely daily request budget exhaustion | stop; check Usage Center and wait for the rolling 24-hour window to recover |
| a prepared or generated file cannot match the immutable train, before snapshot publication | the attempt needs a corrected train rather than a retry | `release abandon --version <VER> --reason "…"`, then plan the corrected train |
| `git pull` hangs at `Username:` | expired PAT with an empty credential store | refresh the PAT, re-cache, keep `GIT_TERMINAL_PROMPT=0` set |
| `RPC failed; curl 92 Stream error in the HTTP/2 framing layer` | transient push | `release resume`, or `git config http.version HTTP/1.1` |
| `remote: fatal error in commit_refs` / GitHub HTTP 5xx | transient GitHub backend | `release resume`; bounded retry is automatic |
| a protected-branch or immutable-ref refusal | policy or state mismatch, not transport | fix the policy/state; it is never retried automatically |
| `Nexus is missing required … artifacts` | inventory not yet indexed after the publisher's bounded wait | use `release resume` once Nexus is healthy |
| `embedded Mongo test process(es) remain` | an earlier or just-finished Maven test left a `.embedmongo` child that can intercept an ephemeral port | end the owning test or run `cedarcli test cleanup`, then `release resume` |

## Before the First Release on a New Host

**Auth.** An expired GitHub token makes a private-repo `git pull` hang forever at a silent
`Username:` prompt. Guard against it and make git fail fast instead:

```bash
export GIT_TERMINAL_PROMPT=0        # keep set for the whole run
git ls-remote https://github.com/<org>/<a-private-repo>.git HEAD \
  >/dev/null 2>&1 && echo AUTH_OK || echo AUTH_FAIL
```

On `AUTH_FAIL`, refresh the PAT on GitHub, authorizing it for SSO if the org requires it, then run
`cd $CEDAR_HOME/<a-private-repo> && git pull` once to re-cache it. Checking `test -s
~/.git-credentials` is not enough, because an expired token is non-empty but still fails.

**Versions.** Decide `<VER>` and `<NEXT>` deliberately rather than copying an old runbook's values.

`release plan` covers the rest, including clean working trees, absent release tags, and credentials.

## What Publishes Independently

The TypeScript model library and CEE release independently, and the release neither versions nor
publishes either. It still writes one change to the library. On `develop`, it moves the two CEDAR
versions that `tools/conformance/pom.xml` names to `<NEXT>`, because CED's conformance gate
resolves those libraries from Nexus. The library's `main`, tags and packages stay its own.
Follow [NPMJS-RELEASE-RUNBOOK.md](./NPMJS-RELEASE-RUNBOOK.md) to choose the model version CEE
embeds, publish both verified packages from `main`, and restore their development channels.
Publishing CEE is not complete operationally until its exact version has been propagated to all
seven consumer manifests, including the extracted Workspace, and those changes are committed in
their owning repositories. Require this gate before building a staging or production frontend
payload:

```bash
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check <CEE_VERSION>
```

Workspace, Template Designer, and the TypeScript model library demo are ordinary platform release
repositories. They carry `<VER>` on `main`, `<NEXT>` on `develop`, and publish their stable packages
to CEDAR Nexus as part of `cedarcli release start|resume`. Their build-train development packages
remain immutable commit-derived prereleases; Docker builds pin the exact versions and never consume
the moving `dev` tag.

Publication is still an artifact operation rather than an environment deployment. Native staging
and production check out the approved Git commits and run
`cedarcli build split-frontends --server-payload`, and nginx then serves the generated `app` trees
directly. No Docker host is required. All seven frontend Docker inputs use the same staging helper
directly, and the complete seven-target procedure is in
[DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md).

## Branch Layout for Publication

The release repositories publish from `main`. The two independent public npmjs repositories—CEE and
the TypeScript model library—build from `develop` for train work and follow their own npmjs runbook.
The release arranges its own isolated checkouts; ordinary working trees do not need a blanket branch
change.

`cedarcli git checkout main` is a blanket checkout of every repository, including the two independent
npmjs repositories. Do not use it to prepare a release; the release controller owns isolated,
manifest-bound workspaces for that purpose.

### Repeated Nexus transport failures

A release's automatic retry loop stops after three Nexus transport failures, while
retaining phase, task and artifact evidence for `release resume`. GitHub transport
retries retain their separate existing allowance. HTTP 500 and throttling refusals
are not treated as ordinary connection blips. The failure names the request or
upload operation; successful health/read probes do not prove that a PUT works.
Use the optional dedicated write probe described in the build runbook when its
disposable repository is available.
