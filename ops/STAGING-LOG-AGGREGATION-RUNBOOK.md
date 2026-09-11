# Staging rollout — CEDAR 2.9.7 + log aggregation

**Date:** 2026-09-04 · **Target:** `cedar.staging.metadatacenter.org` · **Release:** `release-2.9.7`
(cut by Martin 2026-09-04 03:21 PDT from train `2.9.7-dev.20260904.0620`).

Companions: `LOG-AGGREGATION-PLAN.md` (design), `PROD-LOG-AGGREGATION-ROLLOUT.md` (the prod plan this
rehearses), `PROD-DEPLOY-RUNBOOK.md` (deploy mechanics — staging variant noted inline).

---

## 0 · Why this run matters more than a normal staging deploy

Two things are different from every previous staging deploy, and they point in opposite directions.

**(a) The blast-radius guarantee does NOT hold on staging.**
`PROD-LOG-AGGREGATION-ROLLOUT.md` §0 rests on the log DB being a *separate host*
(`cedr-prd-db-01`), so backfill/prune can only stress the log DB and CEDAR stays up. On staging the
prod log copy most likely sits in the **same MySQL instance** as staging's app / messaging / Keycloak
schemas. If so, a prod-sized backfill contends for the *same* buffer pool, I/O queue and data volume
as the rest of staging. **Throttle staging at least as hard as prod, not less** — §5 sets this.

The code itself does not care: the log datasource is fully parameterised
(`CEDAR_LOG_MYSQL_HOST/PORT/DB/USER/PASSWORD`, with `hibernate.default_catalog` pinned to
`${CEDAR_LOG_MYSQL_DB}` in `cedar-config-library/src/main/resources/cedar-main.yml`). Same instance +
separate schema is a supported, normal shape — it is exactly the local-dev shape (`cedar_log`).
**Recommendation: give the restored copy its own schema** (e.g. `cedar_log_staging`) even on the
shared instance. Do not restore log tables into a schema that already holds app tables — hbm2ddl will
create the eight new `agg_*` / `log_aggregation_state` tables into whatever
`CEDAR_LOG_MYSQL_DB` names, and you want them isolated so §6's `DROP` is unambiguous.

**(b) Staging can now catch the boot-stall — this is the whole point.**
`PROD-LOG-AGGREGATION-ROLLOUT.md` §3a says *"Staging cannot catch this. Identical code, identical
config — the only variable is row count, and staging's `log_request` is small."* By restoring a copy
of prod's MySQL, **you have removed that exemption.** Staging's log tables are now prod-sized, so:

- Every DDL timing you measure here is a real estimate for next week's prod run.
- Conversely, staging's `cedar-monitor-server` (9014) and `cedar-worker-server` (9011) will now stall
  at boot exactly the way prod did on 2026-09-01 if any log-entity DDL needs `ALGORITHM=COPY`.
  Dropwizard runs the Hibernate schema update **before Jetty binds** — the signature is a *fast* 502
  from nginx (connection refused), JVM alive in `ps`, nothing listening.

**So the order is non-negotiable: migrate the log DB by hand (§4), timed, BEFORE monitor and worker
start on the 2.9.7 build.** Never let boot discover the DDL.

**Version modifier:** none needed. The version number itself moves (staging is on 2.9.1 per
`worklog/2026-07-29-staging-deploy.md`), which busts the asset cache. `CEDAR_VERSION_MODIFIER` is only
for same-version redeploys.

---

## 1 · Gather the connection facts

You need six values before anything else. **None of them are invented — five come from the staging
box, one comes from whoever took the MySQL copy.** Here is where each lives.

### Where to put them

Make a scratch file **on the staging app host**, in the `cedar` user's home — *not* in the repo, it
holds a password, and `$CEDAR_HOME` is a git checkout:

```bash
ssh <you>@<staging app host>
sudo su - cedar
vi ~/logagg-vars.sh        # scratch, gitignored by virtue of living outside $CEDAR_HOME
chmod 600 ~/logagg-vars.sh
```

```bash
# ~/logagg-vars.sh — scratch for the 2026-09-04 staging log-aggregation rollout
export LOG_DB_HOST=
export LOG_DB_PORT=3306
export LOG_DB_NAME=
export LOG_DB_USER=
export LOG_DB_PASS=
export COPY_TAKEN_ON=
```

Then `source ~/logagg-vars.sh` in every shell where you run the SQL. Delete it when the rollout is
done.

### Where each value comes from

**`LOG_DB_HOST` / `LOG_DB_PORT` / `LOG_DB_NAME` / `LOG_DB_USER`** — staging already runs a log DB
(2.9.1 has been writing to it for weeks), so these are already configured. Read the effective values:

```bash
gocedar
cedarcli env filter CEDAR_LOG_MYSQL
```

That prints `CEDAR_LOG_MYSQL_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD` as the running services
actually see them, **with the password redacted**. Copy the first four across.

**`LOG_DB_PASS`** — redacted by `cedarcli env filter`, so read it from the file that sets it:

```bash
grep CEDAR_LOG_MYSQL_PASSWORD $CEDAR_HOME/set-env-internal.sh
```

`$CEDAR_HOME/set-env-internal.sh` is the per-host secrets file (its committed skeleton is
`cedar-development/bin/templates/set-env-internal.sh:40-43`). It is also the file you edit in §5 and
§7–§9 to turn the jobs on, so you will be back in it.

> **`CEDAR_LOG_MYSQL_DB` is the value to think hardest about.** It names the schema Hibernate is
> pinned to (`hibernate.default_catalog` in `cedar-main.yml:77`) — i.e. where the nine new `agg_*` /
> `log_aggregation_state` tables will be created at boot, and where the aggregator will look for
> `log_request` / `log_cypher` / `*_pre284`.
>
> **The question this rollout hinges on: did the restored prod copy land in *that* schema, or in a
> different one?** Two possibilities:
>
> - The copy was restored **over** staging's existing log schema → `CEDAR_LOG_MYSQL_DB` is already
>   correct, nothing to change.
> - The copy was restored **alongside** it, into a new schema (e.g. `cedar_log_prod_copy`) → you must
>   point `CEDAR_LOG_MYSQL_DB` at the copy in §5, or you will deploy 2.9.7 and aggregate staging's own
>   tiny log tables, rehearsing nothing.
>
> §2's check 1 and check 2 tell you which world you are in. Do not assume.

**`COPY_TAKEN_ON`** — the date the prod MySQL dump was taken. **No command can tell you this; it comes
from whoever ran the dump (you, or Martin).** Write it down before you start, because it predicts the
single most expensive branch in this rollout:

- prod's `log_request.queryParameters` went `varchar(350)` → `LONGTEXT` on **2026-09-01** (commit
  `a7eaa255`) — the change that took prod down 23:19–01:29 UTC.
- Copy taken **after 2026-09-01** → already `LONGTEXT`; §4c does not apply; this is a short day.
- Copy taken **before 2026-09-01** → still `varchar`; §4c applies; budget hours, not minutes.

`COPY_TAKEN_ON` is your *expectation*. §2's check 6 is the *verification*. If they disagree, believe
check 6 — but the disagreement itself is worth understanding before you proceed.

If nobody remembers, this is a decent proxy:

```sql
SELECT MAX(requestTime) FROM log_request;   -- the copy can be no older than its newest row
```

---

## 2 · Pre-flight — measure before you change anything

One script, read-only, changes nothing. Run it **before** deploying. It establishes the baseline every
later check compares against, and it is the data that sizes next week's prod run.

Work in `tmux` on whichever host can reach the log DB, and keep that session for the whole rollout:

```bash
source ~/logagg-vars.sh
tmux new -s logagg

mysql -h "$LOG_DB_HOST" -P "$LOG_DB_PORT" -u "$LOG_DB_USER" -p "$LOG_DB_NAME" \
  < $CEDAR_HOME/cedar-development/ops/staging-logagg-preflight.sql \
  | tee ~/preflight-$(date +%F).txt
```

**Keep that output file.** §6 and §8 compare against it, and §10 copies numbers out of it.

### How to read the output

The script prints eight numbered sections. What each one decides:

| § | Question | What you want to see | If not |
|---|---|---|---|
| 1 | Is this schema log-only? | `log_*` and nothing else | App tables here → the copy went into a shared schema. Restore it into its own (`cedar_log_staging`) before continuing; §6's `DROP` needs to be unambiguous. |
| 2 | Which schemas share this instance? | tells you whether §0(a) applies | If staging's app/Keycloak/messaging schemas are on the same instance, the blast-radius guarantee is gone — throttle hard in §5. |
| 3 | **Baseline row counts** | four numbers | Record them. If they look like staging's own small tables rather than prod's, `CEDAR_LOG_MYSQL_DB` is pointing at the wrong schema (see §1). |
| 4 | Date span + id ranges | history back to CEDAR's early days | If `*_pre284` are missing, the dump excluded them — §8 has nothing to drain and you have not rehearsed the expensive half. |
| 5 | Size + headroom | free space **>** `log_request`'s own size | A `COPY` materialises a full second copy before swapping. Too tight → §4c is unsafe; use the `RENAME TABLE` escape hatch instead. |
| 6 | **`queryParameters` type** | `longtext` | `varchar(350)` → **stop and read §4c.** This is the boot-stall. |
| 6 | `status` / `apiKeyHash` / `aggregatedAt` | may be missing | Missing is fine — §4a adds them `INSTANT`, seconds. |
| 6 | the four `IDX_*` indexes | may be missing | Missing is expected. §4b creates them **by hand**; never let hbm2ddl try at boot. |
| 7 | Do `agg_*` already exist? | none | They should not exist before the deploy. If they do, someone has already run part of this. |
| 8 | Session/global timezone | `America/Los_Angeles`-consistent | Do **not** "fix" this to UTC. See §7's correctness check — forcing UTC is a prod landmine. |

Then, on the DB host itself (the script prints `@@datadir` for you):

```bash
df -h "$(mysql -N -u "$LOG_DB_USER" -p -e 'SELECT @@datadir')"
```

### Fill this in from the output before moving on

```
LOG_DB_NAME confirmed correct (prod-sized counts)  [ ]
log_request rows ................................  ______________
log_cypher rows .................................  ______________
log_request_pre284 rows .........................  ______________
log_cypher_pre284 rows ..........................  ______________
largest table total_gb ..........................  ______________
free space on datadir ...........................  ______________
queryParameters is LONGTEXT .....................  [ ] yes  [ ] NO -> §4c applies
IDX_* indexes present ...........................  [ ] all four  [ ] none -> §4b
shares instance with staging app schemas ........  [ ] yes -> throttle hard  [ ] no
```

---

## 3 · Deploy 2.9.7 to staging

Staging variant of `PROD-DEPLOY-RUNBOOK.md` §A–§6. Everything in an interactive `cedar` login shell
inside `tmux` (`cedarcli`/`gocedar`/`goeditor` are profile functions — they do not exist in a bare
`bash script.sh`).

```bash
ssh <you>@$STAGING_APP_HOST
sudo su - cedar
tmux ls || tmux
gocedar
cedarcli mode                              # must report native

# 3.1 Reconcile — investigate any dirty repo before discarding
cedarcli git status
# goeditor && git status && git checkout .   # only for a KNOWN hot-patch being folded in

# 3.2 Pull the release
cedarcli git checkout main
cedarcli git pull
cedarcli git status                        # expect clean across all repos
cedarcli check versions --strict           # expect 2.9.7 everywhere, no modifier, nothing behind

# 3.3 Build (Java still up — keeps the window short)
cedarcli build maven clean all
cedarcli build all
```

**Do not start the new build's Java yet.** Stop the services, then go do §4 while they are down.

```bash
cedarcli native stop microservices
cedarcli native status                     # confirm 9011 and 9014 are down
```

> Stopping monitor + worker before the migration is what makes §4 safe: they are the only two
> services pointing Hibernate at the log DB, and on 2026-09-01 they each extended the other's outage
> by contending on the same metadata lock.

---

## 4 · Log-DB migration — by hand, timed, in tmux

Source: `cedar-microservice-libraries/cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql`.

Run it against `$LOG_DB_NAME`. **Skip any section §2.5 showed is already applied.** Time every
statement — these numbers are next week's prod estimates.

### 4a · Columns (INSTANT — seconds even on huge tables)

```sql
SET @t0 = NOW(6);
ALTER TABLE log_request
  ADD COLUMN status       int         NULL,
  ADD COLUMN apiKeyHash   varchar(32) NULL,
  ADD COLUMN aggregatedAt datetime(6) NULL,
  ALGORITHM=INSTANT;
SELECT TIMESTAMPDIFF(SECOND, @t0, NOW(6)) AS seconds;

SET @t0 = NOW(6);
ALTER TABLE log_cypher
  ADD COLUMN aggregatedAt datetime(6) NULL,
  ALGORITHM=INSTANT;
SELECT TIMESTAMPDIFF(SECOND, @t0, NOW(6)) AS seconds;
```

Naming `ALGORITHM=INSTANT` explicitly is the point: MySQL **errors out** rather than silently doing a
rebuild. Never drop the clause to "make it work".

### 4b · Indexes (INPLACE — this is the one that takes real time)

Prod's `log_request`/`log_cypher` were small when this ran on 2026-07-29. On the restored copy they
are not. Expect minutes to hours. **This measurement is the main deliverable of the staging run.**

```sql
SET @t0 = NOW(6);
CREATE INDEX IDX_log_request_status       ON log_request (status)       ALGORITHM=INPLACE, LOCK=NONE;
SELECT TIMESTAMPDIFF(SECOND, @t0, NOW(6)) AS seconds;
-- repeat, timing each:
CREATE INDEX IDX_log_request_apiKeyHash   ON log_request (apiKeyHash)   ALGORITHM=INPLACE, LOCK=NONE;
CREATE INDEX IDX_log_request_aggregatedAt ON log_request (aggregatedAt) ALGORITHM=INPLACE, LOCK=NONE;
CREATE INDEX IDX_log_cypher_aggregatedAt  ON log_cypher  (aggregatedAt) ALGORITHM=INPLACE, LOCK=NONE;
```

Watch from a **second** mysql session:

```sql
SELECT stage, work_completed, work_estimated,
       ROUND(100*work_completed/NULLIF(work_estimated,0),1) AS pct
FROM performance_schema.events_stages_current;

SHOW PROCESSLIST;
```

### 4c · Only if §2.5 showed `queryParameters` is still `varchar`

```sql
-- Confirm the algorithm rather than assuming — expect this to FAIL:
ALTER TABLE log_request MODIFY queryParameters LONGTEXT NULL, ALGORITHM=INPLACE, LOCK=NONE;
```

When it fails, `COPY` is the only path. Options, in order of preference:

1. **Run it deliberately, off-peak, in tmux, with monitor+worker stopped** (they already are). Check
   free space **>** `log_request`'s own size first (§2.4). Time it — on prod, `log_request` at ~5
   weeks of data was ≤ ~2h; a years-old table was estimated 13–18h.
2. **The 2026-07-28 escape hatch:** `RENAME TABLE log_request TO log_request_preNNN;` and let hbm2ddl
   create a fresh empty table (metadata-only, instant). This is what brought prod back in minutes
   instead of ~13h. On staging it is also a legitimate rehearsal of that recovery.

### 4d · Verify before restarting anything

```sql
SHOW CREATE TABLE log_request\G   -- 3 new columns + 3 new indexes, queryParameters LONGTEXT
SHOW CREATE TABLE log_cypher\G    -- aggregatedAt + its index
```

**Do not create `agg_*` or `log_aggregation_state` by hand.** They are new and empty; hbm2ddl creates
them in milliseconds at boot. That is the one piece of DDL it is safe to delegate.

---

## 5 · Environment — all three jobs stay OFF for the first boot

Edit `$CEDAR_HOME/set-env-internal.sh` on the staging app host — the same file you read the password
out of in §1. (Its committed skeleton, with every variable named below, is
`cedar-development/bin/templates/set-env-internal.sh:40-61`.)

**Connection block — usually nothing to change.** These five are already set; staging has been logging
for weeks. Touch them **only** if §1/§2 showed the restored prod copy lives in a *different schema*
than the one `CEDAR_LOG_MYSQL_DB` currently names — in which case repoint `_DB` (and `_HOST` if the
copy is on another box) at the copy, or you will aggregate staging's own tiny tables and rehearse
nothing:

```bash
export CEDAR_LOG_MYSQL_HOST="$LOG_DB_HOST"       # from §1
export CEDAR_LOG_MYSQL_PORT="$LOG_DB_PORT"
export CEDAR_LOG_MYSQL_DB="$LOG_DB_NAME"         # <- the one that may need repointing
export CEDAR_LOG_MYSQL_USER="$LOG_DB_USER"
export CEDAR_LOG_MYSQL_PASSWORD="..."            # leave as-is unless the copy needs a different user
```

**Phase gates — these you do change.**

```bash
# Phase gates — ALL false for the first boot. You turn these on one at a time, in order.
export CEDAR_LOG_LIVE_AGG_ENABLED="false"
export CEDAR_LOG_BACKFILL_ENABLED="false"
export CEDAR_LOG_PRUNE_ENABLED="false"
```

Staging-specific tuning to add now (commented-out defaults are in the template):

```bash
# Backfill: same conservative throttle as prod, because on staging the log DB shares an instance
# with everything else (§0a). Window 0-0 means "always on" (start==end short-circuits inWindow()),
# which is correct on staging — there is no real traffic to stay off-peak from, and you want the
# full-drain wall-clock number for next week.
export CEDAR_LOG_BACKFILL_BATCH="1000"
export CEDAR_LOG_BACKFILL_PAUSE_MS="2000"
export CEDAR_LOG_BACKFILL_WINDOW_UTC="0-0"

# Live aggregator: defaults are fine. Poll is 15 min; margin 3h means "only settled days".
# export CEDAR_LOG_LIVE_AGG_BATCH="2000"
# export CEDAR_LOG_LIVE_AGG_PAUSE_MS="200"
# export CEDAR_LOG_LIVE_AGG_POLL_MS="900000"
# export CEDAR_LOG_LIVE_AGG_MARGIN_HOURS="3"

# Prune: leave OFF until §7.
export CEDAR_LOG_PRUNE_RETENTION_DAYS="30"
export CEDAR_LOG_PRUNE_BATCH="1000"
export CEDAR_LOG_PRUNE_PAUSE_MS="2000"
```

**Every env change requires a fresh login shell + a worker restart.** The jobs read their config once,
in the constructor, at boot:

```bash
exit          # leave tmux -> back to the cedar login shell, which re-reads set-env-internal.sh
tmux
gocedar
```

---

## 6 · First boot on 2.9.7 — the moment of truth

```bash
cedarcli dev copy-keycloak-listener
cedarcli prod configure-frontends          # staging uses the same command
cedarcli native start microservices
cedarcli native status
```

Then, as root:

```bash
exit
sudo su -
service nginx stop && service nginx start
```

### What to check, in this order

**1 · Did monitor and worker actually bind?** This is the boot-stall test — a *fast* 502 (connection
refused) means the JVM is alive but sitting inside a schema update.

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://localhost:9014/healthcheck
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://localhost:9011/healthcheck
ss -lntp | grep -E '9011|9014'             # must be LISTENING
```

If they are not listening, do **not** restart them in a loop — go straight to the DB and see what
statement they are stuck on:

```sql
SHOW PROCESSLIST;
SELECT stage, work_completed, work_estimated FROM performance_schema.events_stages_current;
```

**2 · Confirm no surprise DDL ran.** hbm2ddl should have created only the new empty tables.

```sql
SHOW TABLES LIKE 'agg_%';                  -- expect 6: agg_request_hourly, agg_cypher_hourly,
                                           -- agg_request_user_hourly, agg_cypher_query_catalog,
                                           -- agg_request_outlier, agg_cypher_outlier
SHOW TABLES LIKE 'log_aggregation_state';  -- expect 1
SELECT COUNT(*) FROM agg_request_hourly;   -- expect 0 — nothing is enabled yet
```

**3 · Confirm the jobs registered and are correctly disabled.**

```bash
grep -E 'HistoricalBackfillJob|LiveAggregatorJob|LogPruneJob' <worker log>
# expect exactly three lines, all "... disabled (set CEDAR_LOG_*_ENABLED=true to run)."
```

Three "disabled" lines is a **positive** result: it proves the jobs are wired into this build and
reading the env, and that nothing has started writing yet.

**4 · Confirm normal logging still works** (new capture columns are being written):

```sql
SELECT id, requestTime, status, apiKeyHash, aggregatedAt
FROM log_request ORDER BY id DESC LIMIT 10;
```

Click around staging, then re-run: new rows must appear with a non-NULL `status`. `aggregatedAt` stays
NULL — that is the aggregator's marker, and the aggregator is off.

**5 · Normal staging acceptance** — the `PROD-DEPLOY-RUNBOOK.md` "Verify" list still applies: version
check, `CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS` absent/false, a non-admin login producing one clean
provisioning callback, monolith + Workspace serving the intended CEE hash in an incognito window.

**Stop here for the day if anything above is off.** The deploy is complete and reversible at this
point; the jobs are all still off and nothing has been written or deleted.

---

## 7 · Phase 1 — live aggregator (recent data, small, easy to eyeball)

Deliberately first. Live covers post-2026-07-28 days, backfill covers pre-2026-07-28 history —
**disjoint hour buckets**, so order is correctness-neutral. Live-first is an *operational* choice: it
sanity-checks the pipeline on small, recent, verifiable data before the long drain.

```bash
vi set-env-internal.sh    # CEDAR_LOG_LIVE_AGG_ENABLED="true"
exit; tmux; gocedar
cedarcli native stop microservices && cedarcli native start microservices
```

### Watch

```bash
grep 'LiveAggregatorJob' <worker log>
# "LiveAggregatorJob starting: batch=2000, pauseMs=200, pollMs=900000, settleMarginHours=3"
# then, per settled day: "Aggregated live request day 2026-07-29 (N rows)."
```

```sql
-- Progress: one row per source table per UTC day
SELECT sourceTable, bucket, status, rowsIn, rowsOut, startedAt, finishedAt, errorText
FROM log_aggregation_state
WHERE sourceTable IN ('log_request','log_cypher')
ORDER BY bucket;

-- Rollups appearing
SELECT COUNT(*) AS buckets, MIN(hourUtc), MAX(hourUtc) FROM agg_request_hourly;
SELECT COUNT(*) FROM agg_cypher_hourly;
SELECT COUNT(*) FROM agg_request_user_hourly;
SELECT COUNT(*) FROM agg_cypher_query_catalog;

-- Rows are being marked
SELECT COUNT(*) AS unaggregated FROM log_request WHERE aggregatedAt IS NULL;
```

### Correctness check — pick one settled day and reconcile by hand

This is the check that actually proves the pipeline, and it is worth doing carefully once:

```sql
SET @d = '2026-08-15';   -- any fully settled day well inside the data

SELECT COUNT(*) AS raw_rows
FROM log_request
WHERE requestTime >= @d AND requestTime < DATE_ADD(@d, INTERVAL 1 DAY);

SELECT SUM(count) AS rolled_up
FROM agg_request_hourly
WHERE hourUtc >= @d AND hourUtc < DATE_ADD(@d, INTERVAL 1 DAY);
```

These must match. If they are offset by whole hours, that is the known timezone shape — `hourUtc`
physically stores connection-tz wall-clock under `serverTimezone: America/Los_Angeles`, queried
consistently, and **that is intentional**: forcing `hibernate.jdbc.time_zone=UTC` was tried and
reverted as a prod landmine (it would misread years of LA-stored rows by +7/8h). See the comment
block in `cedar-main.yml:78-82`. Reconcile using the same connection settings, not `UTC`.

### Read path

```bash
curl -H "Authorization: Bearer <token with MONITOR_READ>" \
  'https://<staging>/monitor/logs/usage/summary?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z'
# also: /usage/endpoints, /usage/cypher, /usage/users, /usage/insights
```

And in the browser: cedar-monitoring → Usage & Patterns, and the Log Explorer page. The Explorer
reads raw `log_request`/`log_cypher` directly, so it should show data immediately regardless of
aggregation state — a useful independent cross-check on the rollups.

### When to stop

Catch-up takes minutes to hours, then settles into one day per day. **Let it run at least overnight
before starting §8.** You are looking for: every settled day `AGGREGATED`/`COMPLETE`, no `FAILED` rows
in `log_aggregation_state`, no `LiveAggregatorJob batch failed` in the log, and the hand reconciliation
matching.

---

## 8 · Phase 2 — historical backfill (the expensive one)

Only after §7 has run clean overnight.

```bash
vi set-env-internal.sh    # CEDAR_LOG_BACKFILL_ENABLED="true"   (leave live agg true)
exit; tmux; gocedar
cedarcli native stop microservices && cedarcli native start microservices
```

The backfill is a **single pass at boot**, not a repeating schedule: it drains `log_request_pre284`,
then `log_cypher_pre284`, then captures history outliers, then logs `HistoricalBackfillJob finished.`
If it crashes or you restart the worker, it resumes from the persisted `cursorId` — it is restartable
by design, so stopping it is always safe.

### Watch

```bash
grep 'HistoricalBackfillJob' <worker log>
# "HistoricalBackfillJob starting: batch=1000, pauseMs=2000, windowUtc=0-0"
# "Drained log_request_pre284 -> READY_TO_DROP."
# "Drained log_cypher_pre284 -> READY_TO_DROP."
# "HistoricalBackfillJob finished."
```

```sql
-- The cursor IS the progress bar. Re-run every 15-30 min and note the rate.
SELECT sourceTable, status, cursorId, minId, maxId,
       ROUND(100*(cursorId-minId)/NULLIF(maxId-minId,0),2) AS pct,
       rowsIn, rowsOut, startedAt, finishedAt, errorText
FROM log_aggregation_state
WHERE sourceTable LIKE '%_pre284';
```

**Record the rows/hour rate.** Multiplied by prod's `COUNT(*)`, that is how many nights next week's
prod backfill needs — the number `PROD-LOG-AGGREGATION-ROLLOUT.md` §10.2 asks for and nobody has yet.

### Watch the DB while it drains (this is the §0a concern)

```bash
# On the DB host:
mysqladmin -u root -p extended-status | grep -Ei 'Innodb_row_lock_time_avg|Threads_running|Innodb_buffer_pool_wait_free'
iostat -x 5
df -h "$(mysql -N -e 'SELECT @@datadir')"
```

If staging's UI gets sluggish while the backfill runs, that is exactly the shared-instance contention
from §0a — **raise `CEDAR_LOG_BACKFILL_PAUSE_MS` and lower `_BATCH`**, then restart the worker. It
resumes from the cursor; nothing is lost. Note what values it took to stay quiet.

### Stop condition

Both `*_pre284` rows at `READY_TO_DROP`, `HistoricalBackfillJob finished.` in the log. Then:

```bash
vi set-env-internal.sh    # CEDAR_LOG_BACKFILL_ENABLED="false"   -- it is a one-shot; turn it off
exit; tmux; gocedar
cedarcli native stop microservices && cedarcli native start microservices
```

### Parity check, then reclaim the disk

```sql
-- Total folded rows vs the baseline you recorded in §2.2
SELECT sourceTable, rowsIn, rowsOut FROM log_aggregation_state WHERE sourceTable LIKE '%_pre284';
SELECT COUNT(*) FROM log_request_pre284;
SELECT COUNT(*) FROM log_cypher_pre284;

-- History outliers were captured before the drop
SELECT COUNT(*) FROM agg_request_outlier;    -- expect ~500 (top-N over all history)
SELECT COUNT(*) FROM agg_cypher_outlier;
```

Only when `rowsIn` matches the baseline counts:

```sql
DROP TABLE log_request_pre284;
DROP TABLE log_cypher_pre284;
```

A `DROP` is a single cheap binlog event, not a per-row delete — the right way to reclaim history's
disk. Re-check `df -h` after.

---

## 9 · Phase 3 — prune (test it HERE, not on prod)

Prune is the only destructive job. Staging holding a *copy* makes it the correct place to exercise it
— worst case you re-restore the dump. **Do not carry prune to prod next week**; per
`PROD-LOG-AGGREGATION-ROLLOUT.md` §5 it waits weeks, until the rollups are trusted, and §7 requires
confirming `cedr-prd-db-01`'s replication / PITR / retention obligations first.

```bash
vi set-env-internal.sh    # CEDAR_LOG_PRUNE_ENABLED="true"
exit; tmux; gocedar
cedarcli native stop microservices && cedarcli native start microservices
```

```bash
grep 'LogPruneJob' <worker log>
# "LogPruneJob starting: retentionDays=30, batch=1000, pauseMs=2000"
# "Pruned N request + M cypher rows older than 30 days."
```

```sql
-- The safety property: prune only ever deletes rows that are BOTH aggregated AND past retention.
-- This must be 0 at all times, before and after:
SELECT COUNT(*) FROM log_request
WHERE aggregatedAt IS NULL AND requestTime < DATE_SUB(NOW(), INTERVAL 30 DAY);

-- Rollups must NOT change while raw rows disappear — that is the whole point:
SELECT COUNT(*) AS buckets, SUM(count) AS events FROM agg_request_hourly;   -- before and after
SELECT COUNT(*) FROM log_request;                                            -- shrinks
```

Then turn it back off and record what it cost.

---

## 10 · Carry-over to prod (next week)

Fill this table in as you go — it *is* the prod plan.

| Measured on staging | Value | Prod implication |
|---|---|---|
| `log_request` / `log_cypher` / `*_pre284` row counts | | sizes everything below |
| §4a column ADDs | | expect seconds; if not, stop |
| §4b index builds (each) | | the boot-stall window you must pre-empt |
| §4c `queryParameters` COPY (if needed) | | the 13–18h class of risk |
| Free-space headroom ratio | | must exceed the table's own size |
| §7 live catch-up wall-clock | | prod's phase-1 wait |
| §8 backfill rows/hour at batch=1000/pause=2000 | | ÷ prod row count = nights required |
| Throttle values that kept the DB quiet | | prod's starting tuning |
| Disk reclaimed by `DROP *_pre284` | | prod's headroom gain |

Prod differences to remember, beyond the numbers:

- Prod's log DB is a **separate host** (`cedr-prd-db-01`) and may be unreachable from the prod app
  host — `PROD-DEPLOY-RUNBOOK.md` §7 notes the last deploy hopped from the staging host.
- Prod needs `CEDAR_LOG_BACKFILL_WINDOW_UTC` set to prod's **real low-traffic UTC hours**, not `0-0`.
- Prod has real users: keep the §6 stop-and-assess discipline, and keep the deploy's downtime window
  short by building before stopping Java.
- **Prune does not go to prod in this round.**

---

## 11 · Rollback

- **Before §7** — nothing has been written. Redeploy the previous release; the added columns/indexes
  are harmless to older code (all nullable, additive) and `DROP COLUMN` is also INSTANT if you want
  them gone. The migration file's rollback block has the exact statements.
- **After §7/§8, before the `DROP`** — aggregation is **non-destructive**. Set all three env gates to
  `false`, restart the worker, and the rollups sit there inert; raw data is untouched. To redo from
  scratch: `TRUNCATE` the `agg_*` tables, `DELETE FROM log_aggregation_state`,
  `UPDATE log_request SET aggregatedAt = NULL` (batched), and re-run.
- **After `DROP TABLE *_pre284`** — history is gone from staging; the rollups retain the summary and
  `agg_*_outlier` retains the worst instances forever. Recovery is re-restoring the dump.
- **A stalled boot** is not a rollback situation. Let the ALTER finish — prod recovered untouched on
  2026-09-01. Killing MySQL mid-`COPY` is worse than waiting.

---

## 12 · Convention

Write `worklog/2026-09-04-staging-log-aggregation.md` when this ships, and update
`PROD-LOG-AGGREGATION-ROLLOUT.md` §10.2 with the measured numbers from §10.
