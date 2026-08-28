# CEDAR Production Deploy Runbook

How to deploy an **already-cut release** onto the production application server — reconcile any
live hot-patches, pull the release onto `main`, choose an environment modifier when needed, rebuild, redeploy the
backend + frontends, run the DB migrations (app DB **and** the separate log DB), and bring the
front door back up. Written to be followed by a human with a terminal, or read by an LLM agent.

This is the **prod-deploy** counterpart to:
- [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) — *cutting* a release (`cedarcli release start`,
  tag/merge/push across the repos, publish to Nexus + npm). Do that **first**; this runbook takes
  the released `main` and stands it up on prod.
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running CEDAR locally.

> Replace `youruser@<prod-app-host>` and `<prod-log-db-host>` with the real prod hosts, and
> `<MODIFIER>` with the deploy's version modifier (see step 3). Never commit real hostnames,
> credentials, or the raw migration SQL into this file.

## What a prod deploy actually is

Prod runs the released code from **`main`** at `$CEDAR_HOME`, built in place. A deploy:

1. **Reconciles local state** — prod may carry emergency **hot-patches** applied directly on the box
   (this deploy found prod hot-patched to a newer CEE). Those are un-committed working-tree edits;
   they must be reverted so the pull is clean.
2. **Pulls the release** onto `main`. The three AngularJS payloads automatically bind their module
   URLs to the source commit embedded by the build.
3. Optionally changes **`CEDAR_VERSION_MODIFIER`** in `set-env-internal.sh` when two payloads from
   the same source commit need distinct runtime content.
4. **Rebuilds** all Java + configures the static frontends for the prod domain, and **rebuilds every
   served CEE host** to the intended CEE version. During the split migration that means both the
   monolith and Workspace, not only the historical frontend.
5. **Migrates the databases** — the app MySQL (on the app host, as root) and the **log DB on a
   separate host**.
6. **Restarts** Java, then bounces nginx.

> **Downtime window.** Java is down from `cedarcli native stop microservices` until
> `cedarcli native start microservices` — do the
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
cedarcli mode       # production must report native
```

If this host predates persistent mode selection and reports that no mode is set, run
`cedarcli mode native` once. Stop if it reports `docker` or `hybrid`; do not change a production
topology until the deployment using that mode has been identified and stopped through its own
command surface.

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

### 3 · Choose the environment modifier, then re-source the env
The frontend build automatically incorporates its Git source commit into AngularJS module URLs;
modern Angular production builds use content-hashed filenames. `CEDAR_VERSION_MODIFIER` is an
additional discriminator for payloads that use the same commit but differ because of runtime or
environment configuration. Change it only in that case, not as a substitute for source identity.
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

# Certificate and hostname verification must stay enabled outside native development.
test "${CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS:-false}" = false
```

### 4 · Build (Java still running — keep the downtime window short)
```bash
cedarcli check versions        # every repo reports the expected version and any intended modifier
cedarcli maven clean all
cedarcli build all             # this deploy: ~0:11:24
```

### 5 · Redeploy backend + configure frontends (Java goes down here)
```bash
cedarcli native stop microservices
cedarcli native status                 # confirm Java services are down
cedarcli dev copy-keycloak-listener    # copy the event-listener jar into Keycloak, then kc.sh build
cedarcli prod configure-frontends      # rewrite window.cedarDomain + content domain in the dist index.html's
cedarcli git status                    # all green; release is on main
```

### 6 · Verify and rebuild every CEE host to the intended version

CEE propagation belongs in source control before deployment; do not hand-edit a package manifest on
the production host. The release's consumer commits must have been produced by the checked helper,
which includes Workspace and all existing consumers. Verify all seven pins, then build both CEDAR
hosts while they coexist:

```bash
export CEDAR_CEE_VERSION=<CEE_VERSION>
node $CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs --check "$CEDAR_CEE_VERSION"

cd $CEDAR_HOME/cedar-template-editor
npm ci
npx gulp

# Only after Workspace and Designer are deployed in this environment. The production profile must
# provide their exact HTTPS origins and CEDAR_FRONTEND_BEHAVIOR=server.
cedarcli build split-frontends --server-payload
```

If Workspace has not yet been deployed in that environment, its committed pin still must pass the
check; skip only the environment-local split payload build. Once the extracted applications are a
staging or production payload, omitting the native build is a deployment failure. The command runs
`npm ci` and Gulp from clean Git checkouts, writes each no-store build identity, and exits; nginx
serves the two generated `app` trees directly. It uses no Docker. Compare the Workspace-served CEE
bundle hash with the package staged by the CEE release before changing routes.

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
cedarcli native start microservices    # end of the downtime window
```
nginx runs as root, not `cedar`:
```bash
exit                                   # leave the cedar shell
sudo su -
service nginx stop
service nginx start
```

## Verify

- `cedarcli native status` — all Java services up on the new build.
- `cedarcli check versions` — every repo at the expected version + modifier.
- Confirm `CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS` is absent or `false`. Never use the native-development
  bypass to make a staging or production certificate failure disappear; install the Keycloak issuer
  CA in the JVM truststore and correct the hostname instead.
- Confirm the realm's key providers postdate 2026-08-26 (Keycloak admin console → Realm settings →
  Keys, or `kcadm.sh get keys`). The realm seed shipped before that date carried its signing key in
  public git history, so a realm still holding providers imported from it signs tokens anyone can
  forge; create fresh providers and delete the imported ones before deploying onto that realm. The
  exposure and the rotation procedure are in `DOCKER-RUNBOOK.md`, "Keycloak signing keys".
- With the restarted servers' signing-key cache cold, sign in once through `cedar-angular-app` as a
  designated non-admin acceptance user and call that user's `/users/{id}/summary` endpoint with the
  fresh bearer token. A 200 response exercises both secure paths: bearer verification fetches the
  realm JWKS, and the summary performs a read-only Keycloak admin-client lookup.
- That same login must produce one matching provisioning callback. Confirm the CEDAR account is
  usable, and inspect the Keycloak output for the test interval. Any
  `CEDAR user provisioning callback failed` line or callback transport exception fails deployment;
  Keycloak login success alone is not evidence that CEDAR provisioned the account.
- Load the monolith and, while migration is active, Workspace in fresh/incognito browser sessions;
  confirm both serve the intended CEE hash and can create/edit an instance (a stale bundle means the
  source commit was not embedded, the image was not rebuilt, or the CDN was not purged — see below).

## Gotchas

- **Hot-patches on prod are invisible to `git pull`.** If someone live-edited the box, `git pull`
  either conflicts or silently keeps the patch. Always `cedarcli git status` (and `git status` in the
  frontend) **first**, understand the diff, then reconcile — don't pull blind.
- **Re-source the env after editing `set-env-internal.sh` or after a pull.** The running shell keeps
  the old `CEDAR_VERSION_MODIFIER` and the pre-pull aliases/`cedarcli` until a fresh login shell.
  Exit + restart tmux. (Same trap as the release runbook.)
- **Do not use `CEDAR_VERSION_MODIFIER` to identify source code.** AngularJS module URLs contain the
  source commit and modern Angular bundles have content-hashed filenames. Use the modifier only when
  the same commit produces materially different environment payloads. Stale-UI prevention also
  requires nginx to serve entry/config responses with `no-store`; purge any older CDN objects whose
  previous headers allowed them to survive — see the frontend-caching notes.
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
| `cedarcli prod configure-frontends` | `sed`-rewrites `window.cedarDomain` and the content host in the active OpenView, Bridging, and Monitoring static `index.html` files to the production `CEDAR_HOST`. |
| `propagate-cee-release.mjs --check` | Proves all seven CEE manifests and lockfiles—including Workspace—pin the exact release from the correct registry. |
| `cedarcli publish split-frontends` | Publishes immutable commit-derived npm prereleases for Workspace and Designer to Nexus; generic frontend/all publish commands exclude them. It does not change an environment or modify either working tree. |
| `cedarcli build split-frontends --server-payload` | On a native host, refuses dirty split checkouts, runs `npm ci` + Gulp, and writes the static payload identities nginx serves. |
| `gulp` (in template-editor or Workspace) | Copies the pinned CEE bundle and builds that AngularJS host. |

## Split frontend cutover and rollback (migration only)

This section applies only while `cedar-workspace` and `cedar-template-designer` are replacing the
production monolith. It does not authorize a cutover. Final hostnames, TLS, Keycloak clients, and the
deployment window must be approved first. The invariant is that **routing is the only cutover
action**: both extracted applications and the known monolith rollback target are already running,
and neither cutover nor rollback rebuilds an application or changes stored data.

### Local route-only rehearsal

Run the automated routing rehearsal before preparing a staging change. It requires the monolith,
Workspace, and Designer to be listening locally on ports 4200-4202; they can be native Gulp servers
or already-built local images.

```sh
cd "$CEDAR_HOME/cedar-docker-deploy/cedar-frontend"
./rehearse-routing-switch.sh
```

The script owns only disposable gateways on ports 4280 and 4282. It first proves Workspace ownership
of the canonical dashboard and instance routes, Designer ownership of its independent origin, and
exact path/query preservation through temporary HTTP 307 redirects for the three design route
families. It then swaps the complete canonical nginx configuration to the monolith and proves all
routes there. The canonical gateway must change identity, the Designer gateway must not, and every
application container ID or native PID must remain unchanged. The gateways are removed on exit.

This is a route-mechanics and rollback gate, not staging acceptance: it has no TLS or authentication
and makes no realm, hostname, production Compose, or data change.

### Evidence required before routing changes

- Record the monolith commit, version modifier, deployed bundle identity, and current nginx
  configuration as the rollback target.
- Save the accepted split deployment record from
  `cedar-development/ops/e2e/record-split-frontend-deployment.mjs`. Both sources must be clean and
  its source commits must match the commits approved for the window.
- Run `smoke:split:deployment` against the deployed hosts with expected commit variables pinned.
- Run `smoke:split:authenticated` from cold Workspace, Designer, and CEE deep links after the exact
  Keycloak callbacks and web origins are approved.
- Run `propagate-cee-release.mjs --check <CEE_VERSION>` and verify the Workspace-served CEE sha256
  equals the release artifact accepted for the window.
- Verify both certificates, REST CORS, sharing with both test users, old bookmark behavior, and the
  complete acceptance matrix in the migration plan.
- Keep the monolith process or static payload, its bundle, and its nginx include in place. A deployment
  that deletes or overwrites them is not cutover-ready.

### Route-only cutover

1. Generate the accepted native Workspace and Designer static trees and install their nginx virtual
   hosts without changing canonical public routing.
2. Probe their health, build-identity endpoints, and browser journeys directly.
3. Save the active nginx include and obtain its checksum. Prepare a second complete include for the
   split routes; do not edit a live include incrementally during the window.
4. Use temporary `302` or `307` compatibility redirects during migration. A cached `301` can outlive
   rollback and keep browsers pinned to the failed destination.
5. Install the split include, run `nginx -t`, and stop if validation reports anything other than
   success.
6. Reload nginx. Do not stop the monolith and do not rebuild either split application.
7. Purge the CDN entries listed below, then run the public smoke and old-bookmark checks. Record the
   resulting deployment ID and response headers with the window evidence.

### One-step rollback

Rollback immediately on authentication failure, an unavailable create/open/save path, incorrect
permissions, a broken exact return, missing production fixes, or any high-impact Workspace resource
operation defect.

1. Restore the saved monolith nginx include as one file.
2. Run `nginx -t`; only after it succeeds, reload nginx.
3. Purge the same canonical entry points and any compatibility redirect responses.
4. Run the ordinary monolith smoke, verify cold authenticated deep links, and confirm the recorded
   monolith source commit and any intended environment modifier are being served.
5. Leave the split payloads and evidence intact for diagnosis. Rollback is a routing reversal, not a
   destructive cleanup.

### Cache invalidation for cutover and rollback

The split images serve `/index.html`, every `/config/` response, and
`/config/build-info.json` with `Cache-Control: no-store`; content-hashed JavaScript/CSS is immutable,
and stable fallback assets revalidate. Keep those policies at the public proxy and CDN. A prior
cached object can survive a header correction, so both cutover and rollback still require an
explicit purge.

Purge each affected public origin at least for `/`, `/dashboard`, `/index.html`,
`/config/version.js`, `/config/url-service.conf.json`, and `/config/build-info.json`, plus every old
route whose redirect target changed. Purge both the origin retaining the `cedar` hostname and any new
Designer origin. The CDN provider and credentials are deployment-environment details and must not be
committed here; record the purge request/result in the window evidence.

After the purge, use a cache-bypassing request and an incognito browser to verify:

- entry/config/build-identity responses carry `no-store` end to end;
- the served source commits and bundle SHA-256 values equal the accepted deployment record;
- no permanent redirect was cached for a migration route; and
- a second cold load returns the same application ownership and version.
