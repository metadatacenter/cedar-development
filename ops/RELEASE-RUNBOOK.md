# CEDAR Release Runbook

How to cut a CEDAR release with `cedarcli release all-in-one` — connect, verify, dry-run the
versions, run it, watch it, and recover if it stalls. Written to be followed by a human with no
tooling beyond a terminal, or read by an LLM agent. This is the **release** counterpart to
[BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) (which covers running CEDAR locally).

A companion visual — a live phase timeline + this same command sequence in tabs — is
[cedar-release-monitor.html](./cedar-release-monitor.html) (open in a browser; no build step).

> Replace `youruser@your-build-server` with your actual login/host, and `<VER>` / `<NEXT>` with the
> release version and next development version (e.g. `2.9.0` and `2.9.1-SNAPSHOT`).

## What `release all-in-one` does

CEDAR is a ~53-repo monorepo; a release touches ~48 of them. `all-in-one` runs eight phases in order:

1. **Checkout develop** — put the release repos on `develop`.
2. **Publish snapshot** — build and publish the current develop snapshot to Nexus/npm.
3. **Prepare** — `versions:set <VER>` across every repo, create `release/pre-<VER>` + `release/post-<NEXT>` branches, tag `release-<VER>`. (Bigger than it looks — it stamps every POM/package.)
4. **Commit** — per repo: merge the tag into `main` + push, merge the post-branch into `develop` + push.
5. **Cleanup** — delete the temporary `release/pre|post` branches.
6. **Checkout main** — release repos onto `main`.
7. **Publish develop** — publish `<NEXT>` snapshots (rebuild frontends + `./mvnw deploy` + `npm publish`).
8. **Deploy main** — publish the `<VER>` release to Nexus + npm.

It runs **~1h50m–2h30m** (a clean run is ~1:48). It is **not atomic** — failures cluster in the
**commit** phase (git pushes) and the **publish** tail (Nexus/npm). State it writes under `~/.cedar/`:
`last_plan_content.sh` (the full plan, written up front) and `last_release_{version,next_dev_version,tag,pre_branch,post_branch}` (the rollback handles, written during prepare).

CEE releases independently and is excluded from `release all-in-one`. Publishing CEE is not complete
operationally until its exact version has been propagated to all seven consumer manifests, including
the extracted Workspace, and those changes are committed in their owning repositories. Follow
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md#release) and require this gate before building a staging or
production frontend payload:

```bash
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check <CEE_VERSION>
```

Immutable development build trains are separate from `release all-in-one`. They do not merge,
tag, or alter any source repository; they publish a consistent development artifact set from exact
commits for Docker and integration use. See
[BUILD-RUNBOOK.md](./BUILD-RUNBOOK.md). The existing mutable snapshot phases remain in
the release procedure until the train path has completed its rollout.

Workspace and Template Designer are also independent of `release all-in-one` while migration is in
progress. Their exact current versions publish as npm packages to the CEDAR Nexus repository through
one deliberately named selector:

```bash
cedarcli publish split-frontends --dry-run
cedarcli publish split-frontends
```

The generic `cedarcli publish frontends` and `cedarcli publish all` selectors exclude them. The
explicit plan runs `npm ci`, then stages and publishes an immutable prerelease from each clean
commit without changing either working tree. npm cannot overwrite `<NEXT>-SNAPSHOT` the way Maven
can; versions therefore have the form `<NEXT>-dev.<UTC-commit-time>.g<12-char-commit>.p3`, where
`p3` identifies the committed-source, shrinkwrapped package format. The publisher packs from
`git archive HEAD`, not the working tree, so ignored local build output cannot enter the tarball.
Packages carry the full commit as `gitHead` and use
the `dev` dist-tag only as a convenience pointer. Docker builds
pin the exact version and never consume that moving tag.

Publication is an artifact operation, not an environment deployment: native staging/production
checks out the approved Git commits and runs `cedarcli build split-frontends --server-payload`;
nginx then serves the generated `app` trees directly. No Docker host is required. Keep them
excluded from the global version/tag/merge release until staging acceptance authorizes their normal
release membership. The other five frontend Docker inputs use the same staging helper directly;
the complete seven-target procedure is in the Docker runbook.

## Prerequisites — do these before anything

**Auth.** An expired GitHub token makes a private-repo `git pull` hang forever at a silent
`Username:` prompt. Guard against it and make git fail fast instead:

```bash
export GIT_TERMINAL_PROMPT=0        # keep set for the whole run
git ls-remote https://github.com/<org>/<a-private-repo>.git HEAD \
  >/dev/null 2>&1 && echo AUTH_OK || echo AUTH_FAIL
```

On `AUTH_FAIL`: refresh the PAT on GitHub (SSO-authorize it if the org requires), then
`cd $CEDAR_HOME/<a-private-repo> && git pull` once to re-cache it. (`test -s ~/.git-credentials` is
not enough — an *expired* token is non-empty but still fails.)

**Clean state.** `cedarcli git list branch` / `cedarcli git list tag` — expect no stray
`release/pre-*` / `release/post-*` branches and no `release-<VER>` tag yet.

**Versions confirmed.** Decide `<VER>` and `<NEXT>` deliberately — don't copy an old runbook's
exports (that's how you ship the wrong version).

## The sequence

Run everything in an interactive `cedar` shell inside `tmux` (so the long run survives a disconnect).
`cedarcli` is a shell alias — it won't work in a bare `bash script.sh`.

### A · Connect
```bash
ssh youruser@your-build-server
sudo su - cedar
tmux
gocedar
```

### 1 · Refresh + pre-flight build
```bash
cedarcli git checkout develop && cedarcli git pull && cedarcli maven clean all
exec bash -l                 # re-read the freshly-pulled env / aliases / cedarcli
export GIT_TERMINAL_PROMPT=0
cedarcli build all           # ~20 min; catches bad merges before the long run
```
**Re-source matters:** a pull can update the CEDAR profile, aliases, or `cedarcli` itself; the current
shell keeps the pre-pull versions until you start a fresh login shell.

### 2 · Dry run — the version guardrail
```bash
export CEDAR_RELEASE_VERSION=<VER>
export CEDAR_NEXT_DEVELOPMENT_VERSION=<NEXT>
cedarcli env release                        # confirm the two versions
cedarcli release all-in-one --dump-plan     # builds the plan, executes nothing
grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-SNAPSHOT)?' ~/.cedar/last_plan_content.sh | sort | uniq -c
```
Expect only `<VER>` and `<NEXT>` in the plan — no stray older versions, no `<VER>-SNAPSHOT`; tag
`release-<VER>`, branches `release/pre-<VER>/…` + `release/post-<NEXT>/…`. Nothing irreversible has
happened yet.

### 3 · Run it
```bash
{ cedarcli release all-in-one; echo "CEDARCLI_EXIT=$?"; } 2>&1 | tee /tmp/cedar-release.log
```
Leave it in tmux; detach with `Ctrl-b d` and it keeps running.

### 4 · Watch it
```bash
tail -f /tmp/cedar-release.log
# landmarks only:
tail -f /tmp/cedar-release.log | grep -E "Updating|Execution|BUILD (SUCCESS|FAILURE)|-> (main|develop)|npm notice"
```

### 5 · Verify
```bash
grep "Execution succeeded" /tmp/cedar-release.log        # the real success signal
cedarcli check versions
cedarcli git list tag | grep release-<VER>
```
Each release repo should show `main` at `<VER>` and `develop` at `<NEXT>`.

## Gotchas

- **Trust the exit code only after refreshing `cedar-cli`.** Current `cli.sh` and its Linux-oriented
  `python3` variant `cli3.sh` preserve the Python process's status across their trailing navigation
  handling. Hosts on an older CLI checkout—especially a build host whose alias still sources an old
  `cli3.sh`—can still turn a mid-run failure into exit `0`; on those hosts, grep for
  `Execution succeeded` and the absence of `Execution halted` / `Return code: [1-9]` /
  `remote rejected`. Keep those log checks as release evidence even after updating the wrapper.
- **`cedarcli git checkout main` is a blanket checkout of every repo** — it ignores `skip_from_release`
  and sweeps the frontend template repos onto their stale `main`. Don't use it to "prep" a deploy;
  `all-in-one` sets the branch layout up itself.
- The built-in progress **percentage bar is unreliable** — read the log content (subprocess numbers,
  `Location` panels, `Execution succeeded`), not the bars.

## If it halts — resume, don't roll back

A halt in the commit phase leaves some repos pushed and some not. **Finish forward:**

```bash
cedarcli release commit        # no args → prints the exact resume command with saved params; run it
cedarcli release cleanup       # no args → prints its command too
```

**Why not rollback:** `cedarcli release rollback` only deletes the pre/post branch + tag — it does
**not** un-push the `main`/`develop` merges already landed on the completed repos, so rollback + rerun
collides on re-merge. `cedarcli release commit` is **idempotent**: done repos no-op ("Everything
up-to-date"), the rest complete and retry the failed push. Transient GitHub push errors (e.g.
`remote: fatal error in commit_refs`) usually clear on a simple retry.

To see exactly how far a halted run got, fetch every repo and check `main`/`develop`/`tag` per repo,
then resume.

## Known failure signatures

| Signature | Meaning | Recovery |
|-----------|---------|----------|
| `status code: 5xx … BUILD FAILURE` on `./mvnw deploy` | transient Nexus 5xx | retry |
| `git pull` hangs at `Username:` | expired PAT + empty credential store | refresh PAT, re-cache; keep `GIT_TERMINAL_PROMPT=0` set |
| `RPC failed; curl 92 Stream error in the HTTP/2 framing layer` | transient push | retry (or `git config http.version HTTP/1.1`) |
| `remote: fatal error in commit_refs` / `remote rejected main -> main` | transient GitHub backend | retry the push, then `release commit` |
| merge conflict on generated `*-editor-*.js` / `*-form-*.js` in the distribution repo | dist-file conflict | resolve (take all), commit, push, finish the plan by hand |

## Branch layout for publication

The ~48 release repos publish from `main`; the 6 `skip_from_release` frontend repos build from
`develop`. `all-in-one` arranges this itself. If you ever end up doing a manual publication after a blanket
checkout, put the `skip_from_release` repos back on `develop` first, or their (older) `main` may not
even build.
