# CEDAR Release Runbook

How to cut a CEDAR release from an immutable development build train. Written to be followed by a
human with no tooling beyond a terminal, or read by an LLM agent. This is the **release**
counterpart to [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), which covers running CEDAR locally.

A companion visual, showing a live phase timeline alongside this command sequence, is
[cedar-release-monitor.html](./cedar-release-monitor.html). Open it in a browser; there is no build
step.

> Replace `<VER>` and `<NEXT>` with the release version and the next development version, for
> example `2.9.4` and `2.9.5-SNAPSHOT`.

## The Route

A release consumes a completed build train. The train has already built and verified a coordinated
source state, so the release takes its exact commits, stamps versions onto them, and proves that
what it publishes matches what the train built. Creating a train is covered in
[BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md).

The route begins with one read-only plan and four explicit inputs. Nothing is inferred from the
train identifier and no manifest path is accepted. The CLI owns the immutable manifest under
`~/.cedar/train-releases/`.

```bash
cedarcli release plan \
  --version <VER> \
  --next-version <NEXT> \
  --from-train <TRAIN_ID> \
  --cee-version <PUBLIC_CEE_VERSION>
```

`plan` changes nothing. It validates the completed train, the exact source commits, the artifact
inventories—including the complete 31-image Docker plan and immutable registry digests—the explicit
versions, and the byte-equivalence proof between the train's development
CEE and the public npmjs CEE, and then runs the complete release gate. It must finish with
`No changes made.`

The CEE version bases need not match. A train may already have advanced to the next development
base after the public package was cut, so eligibility comes from the tarball proof rather than from
version-name similarity.

The proof permits only named, source-bound non-executable differences. Besides package channel
metadata and the declared version, model identity, load trace, and release changelog entry, this
includes CEE's exact `allowScripts` install policy when Angular has embedded the root `package.json`
into the bundle. The planner reads that policy from `package.json` at the CEE commit captured by the
train, requires its minified literal exactly once in the development bundle, and removes only those
bytes before comparison. An undeclared policy, a malformed entry, a second occurrence, or any
adjacent JavaScript change still fails the byte proof. This keeps npm's build/install allowlist from
forcing a new public CEE release while preserving the rule that executable changes do.

## What Plan Checks

`plan` and `start` run the identical complete gate, so a release cannot begin from a state `plan`
would have refused. It answers in about a minute what previously took a build phase to discover.

The plan settles four groups of question:

- **The machine can run a release.** Java 17 and Node 24.19.0 are active, `git`, `mvn`, and `npm`
  are on PATH, Git author name and email are configured, the CEDAR profile is sourced, npm's
  effective user configuration contains no obsolete authentication setting, and there is disk for
  the release's estimated clean checkouts, release/next Maven and frontend builds, publication
  caches and logs, plus headroom. The estimate is derived from the manifest's repository and build
  counts rather than a fixed free-space threshold. The npmrc check reads key names only and never
  prints registry tokens or values. When the shell offers another Java or Node, the CLI looks for
  the required ones itself, through `/usr/libexec/java_home -v 17` and Homebrew's `node@24`, puts
  them first on PATH for the run, and prints a `Toolchain:` line for each substitution. When it
  finds neither, the plan names the export to run.
- **The source is ready.** Every participating repository—including the independent repositories
  whose CEE wiring the release integrates—is clean and pushed, and the CI run for the exact commit
  the train was built from is green wherever that commit defines a workflow. The immutable source
  also contains every declared wrapper, manifest, lock, build, preserve, version, and Docker stamp
  input before a long build is allowed to start. Every frontend lifecycle script in the captured
  lockfiles has an exact true/false `allowScripts` decision.
- **The writes will be accepted.** Both Nexus credentials are available and authenticate, npm holds an
  identity for CEDAR's Nexus registry, the release version is absent from both Maven and npm target
  namespaces, and each remote accepts dry-run pushes of every ref the release can create: `main`,
  `develop`, `release/pre-<VER>`, `release-<VER>`, and, where applicable,
  `release/post-<NEXT>`.
- **The content is stampable.** Every file a Maven build regenerates with the version inside is
  declared, every `license.txt` carries a recognisable copyright line, and each remote's `main`
  holds nothing that `develop` does not.

Two of those deserve their own note.

**Nexus reads fall back to anonymous** and succeed whether or not credentials are available, so the
presence of `BMIR_NEXUS_USERNAME` and `BMIR_NEXUS_PASSWORD` proves nothing. The CLI uses those
variables when both are set; otherwise it reads the username and password from the
`bmir-nexus-releases` server entry in `~/.m2/settings.xml`. The Maven settings reader handles both
namespaced and unnamespaced settings files and never prints either value. There is no `release auth`
command: credential resolution and authentication happen automatically during `release plan`,
`release start`, and `release resume`. The plan then authenticates against an endpoint anonymous
callers cannot reach, and reads a repository as well, because the status endpoints answer from the
web tier and stay green while everything behind them fails.

**A Nexus over its request budget looks like an outage.** The instance is Community Edition, with a
limit on requests per day, and when it is over that limit it serves its status endpoints and returns
500 for every repository path. The plan names that shape rather than reporting a generic failure,
because it is the one condition that gets worse the harder a release tries: every retry spends the
budget that is exhausted. The budget is a rolling 24-hour window, so the answer is to stop and let it
roll off, and to check the Usage Center for what is consuming it. A train is a few hundred requests,
so a run of failed trains is itself a substantial contributor.

**CI is asked about the train's source commit**, not about whatever `develop` points at now. A
missing, unreadable, queued, or running required check blocks the release; a repository whose exact
source commit defines no workflow is reported as advisory because it has no CI contract. That is
both the more precise question and the stable one, since a release advances `develop` everywhere at
once and a run against the new head answers for a commit nobody is releasing.

GitHub may briefly return no run while indexing a just-pushed SHA, and it may transiently return
502/503/504. The shared train/release probe gives only those cases a bounded retry, naming the
repository, short SHA, attempt, and delay. Authentication or authorization refusal, malformed data,
settled red CI, and a persistently absent run fail immediately or at the end of that short grace. A
queued or running run is not waited through; the refusal carries its workflow URL.

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

Those runs used to go red as a matter of course, because the snapshots they resolve arrived after
the pushes that triggered them. Publishing the snapshots first removed that, so a red `develop` now
means something. If you are looking at a release cut before that change, re-run the failed builds:
they pass unmodified once the snapshots are in Nexus.

When CI is genuinely broken for a reason that must not hold up a release, accept the specific run:

```bash
cedarcli release start ... --accept-red-develop cedar-repo-server=33211136456
```

The acceptance names one repository and one run, and it is recorded in the ledger. No flag skips the
check for everything.

## Running the Release

```bash
cedarcli release start \
  --version <VER> \
  --next-version <NEXT> \
  --from-train <TRAIN_ID> \
  --cee-version <PUBLIC_CEE_VERSION>
```

Run it in an interactive `cedar` shell inside `tmux`, so a long run survives a disconnect.
`cedarcli` is a shell alias and will not work in a bare `bash script.sh`.

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

The release runs these phases, each verifying its work before the next begins:

1. Clone every train source commit into isolated workspaces, and pin the public CEE version in all
   seven frontend consumer manifests and lockfiles.
2. Stamp `<VER>` and `<NEXT>` from the same source commits, and move the copyright year in every
   `license.txt` to the release year. Both variants retain the stable public CEE wiring.
3. Run the release Maven test builds, the next-development Maven builds, all frontend installs, and
   the production frontend builds. Generated distribution bytes are inventoried, so an ignored
   `dist` file cannot change before publication.
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
   `develop`.
7. Upload the exact locally validated Maven release bytes to Nexus, accepting an existing immutable
   path only when its bytes match, and verify the required artifact inventory.
8. Pack the six stable npm frontend surfaces from the exact integrated commits, record `gitHead`,
   and retain explicitly declared runtime assets that npm normally excludes. OpenView's packaged
   `node_modules` assets therefore include the exact CEE and Web Components files committed in its
   release distribution. Publish to CEDAR Nexus, then download each registry tarball and verify its
   integrity, content hash, provenance, and runtime-asset hashes.
9. Accept the release, proving from outside the ledger that it holds. Acceptance also runs the
   captured build-train configuration validator against the complete `<NEXT>` workspace and its
   exact expected snapshot version, so `develop` is not considered ready merely because version
   stamping and publication succeeded.

Nothing reaches a remote until every local ref has been created and verified, so a release that
fails during preparation has changed nothing outside the machine it ran on.

The snapshots are deployed before the remotes, rather than after, because integrating the remotes is
what advances `develop` to the next version everywhere at once, and the CI each of those pushes
triggers resolves the parent and the libraries at that version from Nexus. Publishing first means
those builds find what they are looking for.

Each integration commit is written from the prepared tree rather than merged towards it, so `main`
comes to hold exactly the released content. Anything committed to `main` alone and never merged back
into `develop` is therefore left out of the release, and out of `main` once the release lands. It
stays reachable through the integration commit's first parent, but restoring it takes a deliberate
commit on `develop`. Plan reports such content, and reconciling a divergent `main` belongs
before a release rather than after one.

The stable npm surfaces are Template Editor, OpenView, Content Distribution, Monitoring, Bridging,
and the Angular CEE demo. Workspace receives the stable CEE wiring on both `main` and `develop` but
keeps its independent publication path. Template Designer also remains independently published.

## Watching and Finishing

```bash
cedarcli release status --watch
```

`start` and `resume` show compact phase/task progress by default. Full Maven, npm, embedded-service,
and package output is retained in the attempt's preparation, build, and publication logs instead of
flooding the terminal; add `--verbose` only when live raw output is useful. The watcher prints on a
state change and otherwise a quiet one-minute heartbeat with elapsed time, the active task, phase
counts, Maven file counts, a scheduled transient retry, and the exact terminal failure. Ctrl-C
stops only the watcher; it remains attached while automatic backoff is in progress.

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

Acceptance also marks the release concluded and frees the active slot. There is no separate
`finish` command. If the process stops after writing the accepted ledger but before marking its
pointer concluded, `cedarcli release resume` repairs that final bookkeeping step without rerunning
the release.

The exact-ref query already proves each tag at its recorded commit, so acceptance does not make a
second tag-only request across all repositories. This matters on a forty-repository release and on a
Nexus installation with a finite request budget.

Only `COMPLETE` means successfully released. `ABANDONED` means the retained attempt was closed
without releasing it; every other status remains incomplete.

Local release state has a one-release retention policy. The current release keeps its ledger,
numbered attempt, caches, and logs so `status` and `resume` remain complete. When a new release takes
the current slot, the state layer immediately deletes every older ledger and attempt tree—including
dependency caches and large logs—before the new attempt is prepared. There is no cleanup command
and no archive tier: Git refs and published artifacts are the durable record after a release stops
being current.

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

The TypeScript model library and CEE release independently and are excluded from the release.
Follow [NPMJS-RELEASE-RUNBOOK.md](./NPMJS-RELEASE-RUNBOOK.md) to choose the model version CEE
embeds, publish both verified packages from `main`, and restore their development channels.
Publishing CEE is not complete operationally until its exact version has been propagated to all
seven consumer manifests, including the extracted Workspace, and those changes are committed in
their owning repositories. Require this gate before building a staging or production frontend
payload:

```bash
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check <CEE_VERSION>
```

Workspace and Template Designer are also independent while migration is in progress. Their exact
current versions publish as npm packages to CEDAR Nexus through one deliberately named selector:

```bash
cedarcli publish split-frontends --dry-run
cedarcli publish split-frontends
```

The generic `cedarcli publish frontends` and `cedarcli publish all` selectors exclude them. The
explicit plan runs `npm ci`, then stages and publishes an immutable prerelease from each clean
commit without changing either working tree. npm cannot overwrite `<NEXT>-SNAPSHOT` the way Maven
can, so versions have the form `<NEXT>-dev.<UTC-commit-time>.g<12-char-commit>.p3`, where `p3`
identifies the committed-source, shrinkwrapped package format. The publisher packs from
`git archive HEAD` rather than the working tree, so ignored local build output cannot enter the
tarball. Packages carry the full commit as `gitHead` and use the `dev` dist-tag only as a
convenience pointer; Docker builds pin the exact version and never consume that moving tag.

Publication is an artifact operation rather than an environment deployment. Native staging and
production check out the approved Git commits and run
`cedarcli build split-frontends --server-payload`, and nginx then serves the generated `app` trees
directly. No Docker host is required. Keep these repositories excluded from the global
version, tag, and merge release until staging acceptance authorizes their normal release membership.
The other five frontend Docker inputs use the same staging helper directly, and the complete
seven-target procedure is in [DOCKER-RUNBOOK.md](./DOCKER-RUNBOOK.md).

## Branch Layout for Publication

The release repositories publish from `main`, and the six `skip_from_release` frontend repositories
build from `develop`. The release arranges this itself. If you ever do a manual publication after a
blanket checkout, put the `skip_from_release` repositories back on `develop` first, or their older
`main` may not even build.

`cedarcli git checkout main` is a blanket checkout of every repository. It ignores
`skip_from_release` and sweeps the frontend template repositories onto their stale `main`, so do not
use it to prepare a deployment.
