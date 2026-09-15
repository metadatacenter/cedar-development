# Deploy CEDAR 2.9.9 — staging, then production

A concrete, dated instance of [PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) for the
**2.9.5 → 2.9.9** step, written because this is the release that first carries the log-aggregation
schema. Staging first, production the next day with **the aggregation jobs left off**.

Companions: [PROD-LOG-AGGREGATION-ROLLOUT.md](./PROD-LOG-AGGREGATION-ROLLOUT.md) (why, and the phase
plan), [LOG-AGGREGATION-PLAN.md](./LOG-AGGREGATION-PLAN.md) (design).

> Replace `<prod-app-host>` and `<prod-log-db-host>` with the real hosts. Never commit hostnames,
> credentials, or raw migration SQL into this file.

---

## 0 · What this deploy actually is

| | Currently deployed | Target |
|---|---|---|
| Production (`cedar.metadatacenter.org`) | 2.9.5, modifier `-2026-08-01-1` | 2.9.9 |
| Staging (`cedar.staging.metadatacenter.org`) | 2.9.5, modifier `-2026-09-01-2` | 2.9.9 |
| CEE pin | 2.0.4 | **2.0.7** |
| Source commit served by both | `db782ea4…` | the 2.9.9 commit |

Verify the starting point rather than trusting this table:

```bash
curl -s https://cedar.metadatacenter.org/config/version.js
curl -s https://cedar.staging.metadatacenter.org/config/version.js
```

### The one schema change in the whole release

`git diff release-2.9.5 release-2.9.9` touches **exactly one** database: the **log DB**. No app-MySQL
migration, no messaging-DB change, no OpenSearch mapping change, no new SQL migration beyond the
already-committed phase-1 file. What 2.9.9 wants on the log DB:

| Object | DDL Hibernate will infer | Algorithm | Cost |
|---|---|---|---|
| `log_request.status` (`int` NULL) | `ADD COLUMN` | INSTANT | seconds |
| `log_request.apiKeyHash` (`varchar(32)` NULL) | `ADD COLUMN` | INSTANT | seconds |
| `log_request.aggregatedAt` (`datetime(6)` NULL) | `ADD COLUMN` | INSTANT | seconds |
| `log_cypher.aggregatedAt` (`datetime(6)` NULL) | `ADD COLUMN` | INSTANT | seconds |
| `IDX_log_request_status`, `_apiKeyHash`, `_aggregatedAt` | `CREATE INDEX` | **hbm2ddl gives no algorithm** | **minutes–hours, blocks boot** |
| `IDX_log_cypher_aggregatedAt` | `CREATE INDEX` | **same** | **same** |
| 6 new `agg_*` tables + `log_aggregation_state` | `CREATE TABLE` (empty) | metadata | instant |

No column *type* changes this time, so there is no `ALGORITHM=COPY` in this release — the
2026-09-01 outage cause is not repeating. The four **indexes** are the exposure: monitor (9014) and
worker (9011) run the log-DB schema update *before Jetty binds*, so an index build discovered at boot
is a fast-502 outage on exactly those two services, sized by row count. See
`PROD-LOG-AGGREGATION-ROLLOUT.md` §3a.

### The thing to be clear about before tomorrow

**The log-aggregation code ships in 2.9.9 whether or not you enable it.** `CEDAR_LOG_LIVE_AGG_ENABLED`,
`CEDAR_LOG_BACKFILL_ENABLED` and `CEDAR_LOG_PRUNE_ENABLED` all default to `false` in the jobs that read
them, and every log variable is declared *optional*, so the worker boots on a host that sets none of
them. Leaving the flags off is a real, supported choice and it is the right one for tomorrow.

What the flags do **not** gate is the schema. Hibernate maps the new columns and indexes regardless of
whether any job runs. So "not putting log aggregation live on prod" still means the log-DB DDL happens
— and the only safe way to have it happen is **by hand, before the deploy** (§B1), not at boot.

---

## A · Staging — today

Staging is a full rehearsal of everything **except DDL cost**: identical code and config, but its
`log_request` is nearly empty, so a slow ALTER cannot show up here. Do not read a clean staging run as
evidence about prod timing.

### A0 · Connect

```bash
ssh youruser@cedar.staging.metadatacenter.org
sudo su - cedar
tmux ls && tmux            # reuse or start
gocedar
cedarcli mode              # must report native
echo "$CEDAR_PROFILE"      # must be non-empty (server) — see the restart trap in §D
```

### A1 · Reconcile local state

```bash
cedarcli git status        # any repo dirty?
goeditor && git status     # the frontend is where hot-patches usually land
git checkout .             # only once you know what the change is
gocedar
```

### A2 · Pull 2.9.9 onto main

```bash
cedarcli git checkout main
cedarcli git pull
cedarcli git status        # expect clean
cedarcli check versions    # every repo at 2.9.9
```

### A3 · Version modifier

The version number itself moves 2.9.5 → 2.9.9, which busts the asset cache on its own, so **no
modifier bump is needed** — same reasoning as the 2026-07-29 staging deploy. If you change
`set-env-internal.sh` for any other reason (you will, in A4), you still need the re-source in A5.

### A4 · Register the log-aggregation variables

Staging is where the aggregator gets exercised, so turn the live aggregator **on** here. Add (or
correct) this block in `$CEDAR_HOME/set-env-internal.sh` — the versioned template at
`cedar-development/bin/templates/set-env-internal.sh` already carries it, so diff against that if the
host's copy is old:

```bash
vi set-env-internal.sh
```
```sh
# --- log aggregation (staging: live aggregator on, backfill/prune off) ---
export CEDAR_LOG_LIVE_AGG_ENABLED="true"
export CEDAR_LOG_BACKFILL_ENABLED="false"
export CEDAR_LOG_PRUNE_ENABLED="false"
# tuning is optional; defaults are in the jobs. Staging can stay on defaults:
#export CEDAR_LOG_LIVE_AGG_BATCH="2000"
#export CEDAR_LOG_LIVE_AGG_PAUSE_MS="200"
#export CEDAR_LOG_LIVE_AGG_POLL_MS="900000"
#export CEDAR_LOG_LIVE_AGG_MARGIN_HOURS="3"
```

### A5 · Re-source the environment

```bash
exit          # leave tmux → back to the cedar login shell
tmux          # fresh session re-reads set-env-internal.sh and any pulled aliases
gocedar
cedarcli env filter CEDAR_LOG        # confirm the three flags read back as intended
```

### A6 · Log-DB migration — before the new build boots

Cheap on staging, but do it in the same order you will use on prod so the order itself is rehearsed.

```bash
mysql -u root -p "$CEDAR_LOG_MYSQL_DB"
```
```sql
SELECT VERSION();
SELECT COUNT(*) FROM log_request;
SELECT COUNT(*) FROM log_cypher;
SHOW TABLES LIKE '%\_pre284';        -- does staging even have the frozen history?
```

Then run the committed migration — sections 1 and 2 only, exactly as written:

`cedar-microservice-libraries/cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql`

```bash
mysql -u root -p "$CEDAR_LOG_MYSQL_DB" < \
  "$CEDAR_HOME/cedar-microservice-libraries/cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql"
```

Verify, and expect the three columns + three indexes on `log_request` and `aggregatedAt` + its index on
`log_cypher`:

```sql
SHOW CREATE TABLE log_request\G
SHOW CREATE TABLE log_cypher\G
```

Leave the seven new tables (six `agg_*` plus `log_aggregation_state`) to hbm2ddl — they are created empty and instantly.

### A7 · Build (services still up)

```bash
# Hardened hosts mount /tmp noexec; cedarcli stages isolated frontend builds in the system temp dir.
mkdir -p "$CEDAR_HOME/tmp" && chmod 700 "$CEDAR_HOME/tmp"
export TMPDIR="$CEDAR_HOME/tmp"

time cedarcli build maven clean all --skip-tests
time cedarcli build all --skip-tests          # ~11 min was the 2026-07-28 prod figure
```

> **`/tmp` is mounted `noexec` on the CEDAR app hosts, and the build execs out of the temp dir twice.**
> Both failures below were hit on staging 2026-09-08 and both are new in the 2.9.5 → 2.9.9 range:
>
> 1. **The frontend build — this one is fatal and `--skip-tests` does not help.** cedarcli's
>    "Isolated TypeScript build" copies the repo into `tempfile.TemporaryDirectory()`
>    (`cedar-cli` `org/metadatacenter/util/BuildSafety.py`, no `dir=` argument) and runs `npm ci` +
>    `webpack` there. On a `noexec` `/tmp` that is `sh: 1: webpack: Permission denied`, **exit 126**.
>    Python's `gettempdir()` honours `TMPDIR`, so exporting it at an exec-capable path is the whole fix
>    — no cedarcli change needed.
> 2. **The Java tests.** `cedar-queue-operations-library` fails with
>    `AccessDeniedException: Redis binary /tmp/redis-…/redis-server… is not executable`: the embedded
>    Redis extracts a binary into `java.io.tmpdir` and execs it. The JVM's `java.io.tmpdir` defaults to
>    `/tmp` and **ignores `TMPDIR`**, so this one is not fixed by the export — it is fixed by not
>    running tests during a deploy, which is correct anyway for an already-CI-tested release.
>
> Exit 126 is the tell for both. If a build dies in a directory under `/tmp`, suspect the mount before
> suspecting the code.

Consider making `TMPDIR` permanent in `set-env-internal.sh` rather than a per-shell export, so future
deploys and the services themselves inherit an exec-capable temp directory. That is a change to the
service environment, so make it deliberately and outside a deploy window — not today.

### A8 · Redeploy (downtime starts)

```bash
cedarcli native stop microservices
cedarcli native status                 # confirm down
cedarcli dev copy-keycloak-listener    # jar into Keycloak providers/, then kc.sh build
cedarcli prod configure-frontends      # rewrite the domain into the served index.html files
```

### A9 · CEE 2.0.4 → 2.0.7

The pin is in source control for 2.9.9 — do **not** hand-edit `package.json` on the host.

```bash
export CEDAR_CEE_VERSION=2.0.7
node "$CEDAR_HOME/cedar-development/ops/propagate-cee-release.mjs" --check "$CEDAR_CEE_VERSION"

cd "$CEDAR_HOME/cedar-template-editor"
npm ci
npx gulp
gocedar
```

`workspace.` and `designer.` are not serving publicly, so skip
`cedarcli build split-frontends --server-payload` — but the `--check` above must still pass for all
seven pins.

### A10 · Start, bounce nginx

```bash
cedarcli native start microservices     # downtime window ends
cedarcli native restart ui-main         # frontends are NOT covered by stop/start microservices
cedarcli native status
```

> **`stop microservices` leaves the frontends running.** `ui-main` (and `ui-workspace`/`ui-designer`
> where deployed) are separate managed processes under gulp / `ng serve`. During the window the old
> frontend keeps serving against a dead backend, and after the rebuild it keeps serving the bundle it
> loaded at start until restarted. Restart it explicitly.
>
> **Use the status table's `Binary` column as the check, not file timestamps.** For frontends
> `cedar-services.sh` `cee_of()` compares the CEE version in `package-lock.json` against what `npm ci`
> installed, and then against the copy actually served. `STALE` therefore means one of two specific
> things: the lock moved and `npm ci` never ran, or `npm ci` ran and `copy:cee` never did — the second
> being a silently stale bundle after an apparently successful gulp. It must read `current` before you
> call the deploy done.
nginx is not the `cedar` user's to restart:
```bash
exit
sudo systemctl restart nginx            # staging is systemd; prod uses `service` (§B6)
```

### A11 · Verify

```bash
cedarcli check versions
curl -s https://cedar.staging.metadatacenter.org/config/version.js    # expect 2.9.9
```

- `cedarcli native status` — all 15 up. **Watch monitor and worker specifically**: they are the two
  that touch the log DB, and a fast 502 on just those two is the DDL-at-boot signature.
- Aggregator started: `tail -n 200 $CEDAR_HOME/log/worker.log | grep -i aggregator` should show
  `LiveAggregatorJob starting: batch=…` — **not** `LiveAggregatorJob disabled`.
- Backfill and prune must both log `disabled`.
- Rollups filling, after a settled day plus the 3-hour margin:
  ```sql
  SELECT * FROM log_aggregation_state;
  SELECT COUNT(*), MIN(hourUtc), MAX(hourUtc) FROM agg_request_hourly;
  SELECT COUNT(*) FROM agg_cypher_hourly;
  SELECT COUNT(*) FROM agg_request_outlier;
  ```
- Log explorer / insights endpoints answer on the monitor server; sign in once through
  `cedar-angular-app` as a non-admin acceptance user and call that user's `/users/{id}/summary`.
- Fresh incognito load serves 2.9.9 and can create and edit an instance.

2.9.9 also lands the role/authorization work (`Enforce resource roles across graph and search`,
`Implement inherited category role authorization`, `Separate category ownership from inherited
authority`, `Require every group to retain an administrator`). No index mapping changed, so no reindex
is mandated — but permission semantics did change on both the graph and the search side, so on staging
explicitly exercise **sharing with a second user, a group whose admin you try to remove, and a
category permission that should be inherited**, and only then decide whether prod wants
`ops/reindex.sh`. Do that test today; it is the part of 2.9.9 most likely to surprise Martin tomorrow,
and it has nothing to do with logging.

---

## B · Production — tomorrow, with aggregation off

Same sequence, three differences: the log-DB indexes are pre-created **ahead of the window**, the three
flags are left **off**, and nginx is bounced with `service`.

### B1 · Tonight, or early tomorrow — pre-create the log-DB schema

**Do this before the deploy, with CEDAR fully up.** It is the whole point: the index build is online,
so it costs nothing except time, and doing it here means tomorrow's boot finds everything present and
does no DDL at all. Skipping this is what turns a routine deploy into the 2026-09-01 outage.

The log DB is a separate host and is often unreachable from the prod app host — hop from staging.
**Confirmed 2026-09-08:** staging's own `set-env-internal.sh` points `CEDAR_LOG_MYSQL_HOST` at
`<prod-log-db-host>` and uses schema `cedar_log_staging` there. That is *why* the hop works — staging
already holds a working route and credentials to that server. Two consequences:

- You do not need a workaround. From the staging host, `$CEDAR_LOG_MYSQL_HOST` is already the right
  server; only the schema name differs (`cedar_log_staging` vs `cedar_log_production`). **Name the
  schema explicitly in every statement or `USE` it deliberately** — the two live side by side and a
  session defaulted to the wrong one is a silent mistake.
- Staging and production log data share **one MySQL server, one disk, one buffer pool**. Staging's
  tables are tiny so its migration is free, but the §3b disk-headroom check has to be read as
  *server-wide* free space, not per-schema, and any heavy staging work lands on prod's log-DB host.

```bash
ssh youruser@<prod-log-db-host>      # or straight from the staging host, which can already reach it
tmux                                  # this outlives your connection; use it
```


```bash
ssh youruser@<prod-log-db-host>      # from the staging host if prod refuses
tmux                                  # this outlives your connection; use it
```

> **The log DB is MariaDB 10.6.23, not MySQL 8** (confirmed 2026-09-08 from the staging host). The
> migration file's header says "Requires MySQL 8.0.12+"; that is wrong about the product but right
> about the capability — MariaDB has supported `ALGORITHM=INSTANT` since 10.3.7 and `ALGORITHM=INPLACE,
> LOCK=NONE` well before that, so every statement below is valid as written. Two consequences that are
> *not* cosmetic: `performance_schema` is commonly off in MariaDB, so the MySQL progress query returns
> nothing — use MariaDB's own `PROGRESS` column instead (below); and the InnoDB algorithm behaviour is
> MariaDB's, so confirm rather than reason from MySQL 8 release notes.
>
> **Credentials do not carry across schemas.** `cedar_log_usr@cedr-stg-app-03` holds
> `ALL PRIVILEGES` on `cedar_log_staging` (and `cedar_log_stage`) — and **nothing on
> `cedar_log_production`**. Reaching the prod log DB from staging gets you the network route, not the
> rights. Confirm which credential can do DDL on `cedar_log_production` **the day before**, not in the
> window.

Pre-flight — and this finally answers rollout §10 item 2, which has never had real numbers:

```sql
SELECT table_name,
       ROUND(data_length/1073741824,2)                AS data_gb,
       ROUND(index_length/1073741824,2)               AS idx_gb,
       ROUND((data_length+index_length)/1073741824,2) AS total_gb,
       table_rows
FROM information_schema.tables
WHERE table_schema='cedar_log_production'
ORDER BY data_length+index_length DESC;

SELECT COUNT(*) FROM log_request;    -- ~6 weeks, since the 2026-07-28 rename
SELECT COUNT(*) FROM log_cypher;
SELECT COUNT(*) FROM log_request_pre284;
SELECT COUNT(*) FROM log_cypher_pre284;
SHOW CREATE TABLE log_request\G      -- confirm queryParameters is longtext (closes out 2026-09-01)
```
```bash
df -h "$(mysql -N -e 'SELECT @@datadir')"
```

Record those four counts and the free space in the worklog — every later decision (backfill duration,
prune, partitioning) is sized off them.

Then run sections 1 and 2 of the committed migration against the prod log DB, **statement by statement
so you see each one land**. The explicit `ALGORITHM=` clauses are the safety mechanism: if MySQL cannot
do an add as INSTANT or an index as INPLACE it will *refuse* rather than silently start a COPY.

```sql
ALTER TABLE log_request
  ADD COLUMN status       int         NULL,
  ADD COLUMN apiKeyHash   varchar(32) NULL,
  ADD COLUMN aggregatedAt datetime(6) NULL,
  ALGORITHM=INSTANT;

ALTER TABLE log_cypher
  ADD COLUMN aggregatedAt datetime(6) NULL,
  ALGORITHM=INSTANT;

-- All three log_request indexes in ONE statement: a single InnoDB pass, not three.
ALTER TABLE log_request
  ADD INDEX IDX_log_request_status       (status),
  ADD INDEX IDX_log_request_apiKeyHash    (apiKeyHash),
  ADD INDEX IDX_log_request_aggregatedAt  (aggregatedAt),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE log_cypher
  ADD INDEX IDX_log_cypher_aggregatedAt (aggregatedAt),
  ALGORITHM=INPLACE, LOCK=NONE;
```

> **Do not use `CREATE INDEX ... ALGORITHM=INPLACE, LOCK=NONE`.** That comma is valid only inside
> `ALTER TABLE`; `CREATE INDEX` takes the options space-separated. The committed migration carried the
> comma form until 2026-09-08 and failed with `ERROR 1064` on the first index — on MySQL as well as
> MariaDB, so the file had demonstrably never been run anywhere. Discovered on staging, which is
> precisely what the staging rehearsal is for. If you are on a host whose checkout predates that fix,
> use the statements above rather than the file.

Watch a long one from a second session:

```sql
-- MariaDB reports ALTER progress natively; performance_schema is usually off here.
SELECT ID, TIME, STAGE, MAX_STAGE, PROGRESS, STATE, LEFT(INFO,60) AS stmt
FROM information_schema.PROCESSLIST
WHERE DB LIKE 'cedar_log%' AND INFO IS NOT NULL;
```

Rules while this runs:

- `LOCK=NONE` means the worker keeps writing throughout. No CEDAR downtime, no service restart.
- **Never touch `log_request_pre284` / `log_cypher_pre284`.** No columns, no indexes — an index there
  forces COPY on multi-GB frozen history. The backfill reads them with the missing columns projected
  as constants; that is deliberate.
- The index names must match the entity exactly (they do, in the file above). hbm2ddl matches by name;
  a typo means it rebuilds the index at boot, which is the outage you are avoiding.
- If an `ALTER` is refused for the algorithm, **stop and reassess** — do not retry without it.

Confirm before you walk away:

```sql
SHOW CREATE TABLE log_request\G      -- 3 new columns + 3 new indexes
SHOW CREATE TABLE log_cypher\G       -- aggregatedAt + its index
```

### B2 · Deploy — as §A0–A2, A5, A7–A9, with these changes

**Modifier (A3).** The version moves 2.9.5 → 2.9.9, so strictly no bump is required. Bump it anyway on
prod — `-2026-09-09-1` — because prod is the host that has been hot-patched before, prod is behind
Cloudflare, and prod is the one where a stale bundle is Martin's problem rather than yours. It costs
one line.

**Variables (A4) — the "not live" configuration.** Register all three flags explicitly as `false`
rather than leaving them unset. Both give the same behaviour; writing them down makes the decision
visible on the box and turns phase 1 into flipping one word:

```sh
# --- log aggregation: code deployed, jobs deliberately OFF (2.9.9, 2026-09-09) ---
export CEDAR_LOG_LIVE_AGG_ENABLED="false"
export CEDAR_LOG_BACKFILL_ENABLED="false"
export CEDAR_LOG_PRUNE_ENABLED="false"

# Pre-set the prod-conservative tuning now, while nothing reads it. Then phase 1 is one flag,
# not a flag plus four guesses made at the time.
export CEDAR_LOG_LIVE_AGG_BATCH="2000"
export CEDAR_LOG_LIVE_AGG_PAUSE_MS="200"
export CEDAR_LOG_LIVE_AGG_POLL_MS="900000"
export CEDAR_LOG_LIVE_AGG_MARGIN_HOURS="3"
export CEDAR_LOG_BACKFILL_BATCH="1000"          # code default 5000
export CEDAR_LOG_BACKFILL_PAUSE_MS="2000"       # code default 500
export CEDAR_LOG_BACKFILL_WINDOW_UTC="10-14"    # 03:00–07:00 America/Los_Angeles; confirm from traffic
export CEDAR_LOG_PRUNE_RETENTION_DAYS="30"
export CEDAR_LOG_PRUNE_BATCH="1000"             # code default 2000
export CEDAR_LOG_PRUNE_PAUSE_MS="2000"          # code default 500
```

`CEDAR_LOG_BACKFILL_WINDOW_UTC` is the one value above that is a guess. Set it from prod's own numbers
once the rollups exist — `SELECT HOUR(hourUtc) AS h, SUM(reqCount) FROM agg_request_hourly GROUP BY h
ORDER BY 2` gives the real low-traffic UTC hours — which is another reason phase 1 comes before phase 2.

**Migration (A6).** Skip it. It was done in B1. Re-verify with the two `SHOW CREATE TABLE`s and move on.

### B3 · Verify (prod)

Everything in A11, plus:

- All three jobs must log **`disabled`** in `worker.log`. If `LiveAggregatorJob starting:` appears, a
  flag leaked in — stop and fix `set-env-internal.sh` before anything else.
- `cedarcli env filter CEDAR_LOG` reads back all three as `false`.
- The seven new tables exist and are **empty** — that is hbm2ddl having created them and nothing
  writing to them, which is exactly right.
- Monitor and worker are 200, not a fast 502:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' --resolve "monitor.metadatacenter.org:443:<origin-ip>" \
    https://monitor.metadatacenter.org/health-check/worker
  ```
  Probing the origin directly bypasses Cloudflare, which is what made the 2026-09-01 diagnosis
  possible from outside the box.
- Purge Cloudflare for `/`, `/index.html`, `/config/version.js`, `/config/url-service.conf.json`,
  then confirm in incognito that `version.js` reports 2.9.9 and the new modifier.
- **Verify the public URL from off-box.** Curling the public hostname *from the app host itself*
  returned an empty body on staging 2026-09-08 while the site was serving fine — split-horizon DNS or
  the WAF. It looks exactly like an outage and is not one.
- **`/config/version.js` is served with no `Cache-Control` header** (checked on staging 2026-09-08:
  only `Last-Modified` and `ETag`). That file's *content* is what carries the cache-busting modifier,
  and its URL never changes — so an edge-cached copy pins clients to the old modifier and therefore the
  old bundle, and bumping the modifier cannot rescue it. Staging is unaffected because it is not behind
  Cloudflare; **prod is**. Purging is the minimum; serving `index.html` and `config/version.js` with
  `no-store` is the real fix — see the frontend-caching notes.

### B4 · nginx

```bash
exit
sudo su -
service nginx stop && service nginx start
```

Prod nginx has had **no log rotation since 2024-08-27** and its config is host-only and unversioned —
if you are in a root shell anyway, check `df -h /var/log` before you restart.

---

## C · Moving log aggregation forward on prod

Nothing below needs a build, a release, or CEDAR downtime. Each step is: edit `set-env-internal.sh` →
exit + restart tmux → `cedarcli native restart worker` → check the log line. The worker is the only
service that runs these jobs.

| Phase | When | Change | What happens | Watch |
|---|---|---|---|---|
| **0** | 2026-09-09 | flags `false` | code deployed, nothing runs | monitor + worker 200 |
| **1** | ≥ ~1 week later, once staging's rollups look right and prod has settled | `CEDAR_LOG_LIVE_AGG_ENABLED=true` | catches up each settled UTC day from the deploy forward, then ~1 day/day | `agg_request_hourly` growing; log-DB load |
| **2** | after phase 1 is trusted, and only in the window | `CEDAR_LOG_BACKFILL_ENABLED=true` | drains `*_pre284` in throttled id-range batches, off-peak, restartable from the cursor in `log_aggregation_state`; captures top-500 historical outliers before the drop | several nights; `cedr-prd-db-01` load + replication lag |
| **2b** | when backfill reports `READY_TO_DROP` | parity-check, then `BACKFILL_ENABLED=false` and **manual** `DROP TABLE log_request_pre284, log_cypher_pre284` | reclaims the disk headroom a future rebuild needs | one cheap binlog event, not per-row |
| **3** | weeks later | `CEDAR_LOG_PRUNE_ENABLED=true` | batched off-peak `DELETE` of aggregated rows past retention | replication lag; binlog growth |

Order note: phase 1 before phase 2 is an *operational* preference, not a correctness one. Live covers
post-2026-07-28 days, backfill covers pre-2026-07-28 history — disjoint hour buckets, and the one
shared rename day sums correctly through the additive upsert. Live-first just means you sanity-check
the pipeline on small recent data you can eyeball.

**Phase 3 has a prerequisite that is not technical.** Before enabling prune, confirm whether
`cedr-prd-db-01` is replicated or PITR-backed, whether anything downstream consumes those raw rows,
and whether a retention or compliance requirement applies. Aggregation keeps the summary forever and
the outlier tables keep the worst individual instances forever, so pruning loses only row-level
detail — but that is a question to answer, not to assume. Rollout §7 also recommends planning
day-partitioning plus `DROP PARTITION` as the long-term shape; batched DELETE is the right *first*
prune, not the permanent one.

**A standing cost of staying at phase 0:** with the flags off, nothing ever stamps `aggregatedAt`,
nothing drains `*_pre284`, and nothing prunes. Both live tables keep growing, and rollout §3b measures
roughly **+25 minutes on the next COPY-class rebuild per unpruned month**. Phase 0 is the right call
for tomorrow; it is not free to sit in indefinitely, and the next log-entity type change is when the
bill arrives.

---

## D · Traps specific to this deploy

- **The DDL is not optional, the jobs are.** Flags off does not mean "no log-DB change". §B1 is
  mandatory either way.
- **Staging cannot validate the DDL cost.** Identical code and config; the only variable is row count.
  Any log-entity schema work is prod-only risk by construction.
- **Re-source after editing `set-env-internal.sh`.** `cedar-services.sh` trusts a caller that already
  has an environment (it skips re-sourcing the profile when `CEDAR_DEVELOP_HOME` is set), so a restart
  issued from the tmux session you edited in silently keeps the **old** values. Exit tmux, start a
  fresh one, then restart the service.
- **`CEDAR_PROFILE` unset is a macOS trap, not a Linux one — but check it anyway.** The
  "stops everything, starts nothing" failure lives in `cedar-services.sh`'s **Darwin** branch, which
  refuses per service because launchd cannot inherit the shell's environment. The Linux branch is a
  plain `nohup "$SCRIPT_PATH" run-one "$name"`, with no such check: the child inherits the caller's
  environment and starts. Staging and prod are Linux, so an empty `CEDAR_PROFILE` there is untidy,
  not fatal. Export it anyway (`export CEDAR_PROFILE=server`) so the environment is self-describing.
- **The Linux danger is the opposite one: a stale environment starts silently.** The guard at the top
  of `cedar-services.sh` skips re-sourcing the profile whenever `CEDAR_DEVELOP_HOME` is set, and
  cedarcli passes `env=None` to `subprocess.Popen`, so the controller simply **inherits your shell**.
  Nothing re-reads `set-env-internal.sh` on your behalf and nothing warns you. A service started from
  the tmux session you edited in comes up with the old values and looks perfectly healthy. This is why
  the exit-tmux-and-restart step is not optional — it is the only thing that re-reads the file.
- **Never index the `*_pre284` tables.**
- **Hot-patches are invisible to `git pull`** — prod has been live-patched before (CEE 1.5.1 on
  2026-07-28). `git status` in the template-editor first.
- **Bump the prod modifier and purge Cloudflare**, or clients keep the 2.9.5 bundle.
- **`nginx` is `systemctl` on staging, `service` on prod**, and root in both cases.
- **CEE goes 2.0.4 → 2.0.7 from source.** `propagate-cee-release.mjs --check 2.0.7` must pass for all
  seven pins; do not hand-edit a manifest on a host.

## E · Rollback

The log-DB migration is additive and reversible — the rollback block at the foot of
`2026-07-29-log-capture-phase1.sql` drops the four indexes and the four columns, and `DROP COLUMN` is
also INSTANT. There is no reason to run it: 2.9.5 ignores columns it does not map, so the schema can
stay while the code goes back.

Code rollback is the ordinary path — `cedarcli git checkout` the 2.9.5 tag across the repos, rebuild,
restore the previous modifier, redeploy, purge the CDN. Record the current modifier and source commit
**before** starting so there is something to go back to.

## F · Afterwards

Per convention, write `worklog/2026-09-08-staging-deploy.md` and
`worklog/2026-09-09-prod-deploy.md`: versions and modifiers, what was reconciled, build time, the four
row counts and the disk headroom from §B1, index build durations, that the flags were deliberately
left off, and anything that surprised you. Link `[[cedar-prod-deploy]]` and the 2.9.9 release.
