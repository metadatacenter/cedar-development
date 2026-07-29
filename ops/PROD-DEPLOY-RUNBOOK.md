# CEDAR Production Deploy Runbook

How to deploy an **already-cut release** onto the production application server — reconcile any
live hot-patches, pull the release onto `main`, bump the version modifier, rebuild, redeploy the
backend + frontends, run the DB migrations (app DB **and** the separate log DB), and bring the
front door back up. Written to be followed by a human with a terminal, or read by an LLM agent.

This is the **prod-deploy** counterpart to:
- [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) — *cutting* a release (`cedarcli release all-in-one`,
  tag/merge/push across the repos, publish to Nexus + npm). Do that **first**; this runbook takes
  the released `main` and stands it up on prod.
- [DEVELOPMENT-RUNBOOK.md](./DEVELOPMENT-RUNBOOK.md) — running CEDAR locally.

> Replace `youruser@<prod-app-host>` and `<prod-log-db-host>` with the real prod hosts, and
> `<MODIFIER>` with the deploy's version modifier (see step 3). Never commit real hostnames,
> credentials, or the raw migration SQL into this file.

## What a prod deploy actually is

Prod runs the released code from **`main`** at `$CEDAR_HOME`, built in place. A deploy:

1. **Reconciles local state** — prod may carry emergency **hot-patches** applied directly on the box
   (this deploy found prod hot-patched to a newer CEE). Those are un-committed working-tree edits;
   they must be reverted so the pull is clean.
2. **Pulls the release** onto `main` and **bumps `CEDAR_VERSION_MODIFIER`** (cache-buster — see
   Gotchas) in `set-env-internal.sh`.
3. **Rebuilds** all Java + configures the static frontends for the prod domain, and **rebuilds the
   embeddable-editor frontend** to the intended CEE version (the hot-patch, done properly this time).
4. **Migrates the databases** — the app MySQL (on the app host, as root) and the **log DB on a
   separate host**.
5. **Restarts** Java, then bounces nginx.

> **Downtime window.** Java is down from `cedarcli stop java` until `cedarcli start java` — do the
> build *before* stopping Java to keep the window short. The **log DB migration causes no downtime**:
> the log DB is written only by the worker draining Redis, asynchronously, so it can be migrated while
> the rest of the system is up (or even before the window).

## The sequence

Run everything in an interactive `cedar` shell inside `tmux` (survives a disconnect). `cedarcli`,
`gocedar`, and `goeditor` are shell aliases/functions from the CEDAR profile — they only work in a
full interactive `cedar` login shell, not a bare `bash script.sh`.

### A · Connect
```bash
ssh youruser@<prod-app-host>
sudo su - cedar
tmux ls            # reuse an existing session if one is running
tmux               # else start one
gocedar            # cd $CEDAR_HOME
```

### 1 · Reconcile local state — revert any hot-patches
Prod can drift from git when someone live-patches the box. Check, and discard working-tree edits so
the pull can't conflict.
```bash
cedarcli git status                       # any repo showing modified/dirty?
goeditor                                  # cd the template-editor frontend
git status                                # this deploy: prod was hot-patched to a newer CEE
git checkout .                            # revert the hot-patch (re-applied cleanly in step 6)
gocedar
```
> Only `git checkout .` (discard) once you've confirmed *what* the local change is and that it's a
> known hot-patch being folded into this release. If it's an unexplained edit, stop and investigate
> — discarding it loses it.

### 2 · Pull the release onto `main`
```bash
cedarcli git branch                       # see where each repo sits
cedarcli git checkout main                # prod deploys from main
cedarcli git pull
cedarcli git status                        # expect clean; "prod data is now on main"
```

### 3 · Bump the version modifier, then re-source the env
`CEDAR_VERSION_MODIFIER` is appended to the build version and drives asset cache-busting. **Bump it
every deploy** or clients keep the stale bundle (see Gotchas + the frontend-caching notes).
```bash
vi set-env-internal.sh
#   export CEDAR_VERSION_MODIFIER="-<MODIFIER>"    # e.g. a dated, incrementing tag like -2026-07-28-1
```
Then **re-source the environment** — exit tmux and start a fresh session so the login shell re-reads
the edited `set-env-internal.sh` *and* any profile/alias/`cedarcli` changes the pull brought in:
```bash
exit               # leaves this tmux; back to the cedar login shell
tmux               # fresh session = fresh env
gocedar
```

### 4 · Build (Java still running — keep the downtime window short)
```bash
cedarcli check versions        # every repo reports the expected version + new modifier
cedarcli clean maven all
cedarcli build all             # this deploy: ~0:11:24
```

### 5 · Redeploy backend + configure frontends (Java goes down here)
```bash
cedarcli stop java
cedarcli status                        # confirm Java services are down
cedarcli dev copy-keycloak-listener    # copy the event-listener jar into Keycloak, then kc.sh build
cedarcli prod configure-frontends      # rewrite window.cedarDomain + content domain in the dist index.html's
cedarcli git status                    # all green; release is on main
```

### 6 · Rebuild the embeddable-editor frontend to the intended CEE version
This is the hot-patch from step 1, applied the right way — through `package.json` and a real build.
```bash
goeditor
#   edit package.json → set the cedar-embeddable-editor (CEE) version
npm install
gulp                                   # build the template-editor bundle
```

### 7 · Database migrations
**App MySQL — as root, on the app host:**
```bash
# in a root shell: start MySQL if needed, then run the release's migration queries.
# (Keep the actual SQL out of this file — take it from the release's migration set.)
```
**Log DB — on a separate host (no downtime; async worker DB):**
The log DB is not the app DB and may **not be reachable from the prod app host**. This deploy
reached it from staging:
```bash
ssh youruser@<prod-log-db-host>        # if refused from prod, hop from the staging host
# run the release's log-DB migration queries here.
```

### 8 · Start Java, then bounce nginx
```bash
cedarcli start java                    # end of the downtime window
```
nginx runs as root, not `cedar`:
```bash
exit                                   # leave the cedar shell
sudo su -
service nginx stop
service nginx start
```

## Verify

- `cedarcli status` — all Java services up on the new build.
- `cedarcli check versions` — every repo at the expected version + modifier.
- Load the prod UI in a fresh/incognito browser and confirm the new version + working CEE editor
  (a stale bundle here means the modifier didn't change or the CDN wasn't purged — see below).

## Gotchas

- **Hot-patches on prod are invisible to `git pull`.** If someone live-edited the box, `git pull`
  either conflicts or silently keeps the patch. Always `cedarcli git status` (and `git status` in the
  frontend) **first**, understand the diff, then reconcile — don't pull blind.
- **Re-source the env after editing `set-env-internal.sh` or after a pull.** The running shell keeps
  the old `CEDAR_VERSION_MODIFIER` and the pre-pull aliases/`cedarcli` until a fresh login shell.
  Exit + restart tmux. (Same trap as the release runbook.)
- **Bump `CEDAR_VERSION_MODIFIER` every deploy.** It's the cache-buster. If it doesn't change, users
  keep the old frontend bundle even after a good build. Stale-UI fixes also require nginx serving
  `index.html`/`version.js` with `no-store` **and** purging the CDN — see the frontend-caching notes.
- **The log DB is a different server and may be unreachable from prod.** Hop from staging. It's an
  **async** worker DB (fed off Redis), so migrating it does **not** take CEDAR down.
- **nginx is bounced as `root`, not `cedar`.** Separate `sudo su -` shell.
- **Keep the downtime window tight:** `build all` *before* `stop java`; DB migrations and the editor
  rebuild can overlap the window, but don't `start java` until the app-DB migration is done.

## What each non-obvious command does

| Command | What it does |
|---------|--------------|
| `gocedar` / `goeditor` | cd to `$CEDAR_HOME` / to the template-editor frontend (profile aliases). |
| `cedarcli check versions` | Verifies every repo reports the expected version (incl. the modifier). |
| `cedarcli dev copy-keycloak-listener` | Copies `cedar-keycloak-event-listener.jar` into Keycloak's `providers/`, then runs `kc.sh build` so Keycloak picks up the provider. |
| `cedarcli prod configure-frontends` | `sed`-rewrites `window.cedarDomain` and the `content.metadatacenter.org` host in the static dist `index.html`s (openview, bridging, monitoring, artifacts) to the prod `CEDAR_HOST`. |
| `gulp` (in template-editor) | Builds the Angular template-editor bundle after the CEE `package.json` bump + `npm install`. |
