# CEDAR Log Aggregation, Pruning & Analytics — Plan

Status: **proposal / design** · Author drafted 2026-07-29 · Supersedes the sketch in
`worklog/2026-07-28-log-aggregation-design.md` (retained decisions: daily grain, mergeable
histograms, worker-produces / monitor-serves / monitoring-shows, runtime cypher toggle).

---

## 0. Why

The app-level log DB (`cedar_log_production`, its own MySQL instance, written **only** async off
Redis by the worker — see [[cedar-log-db-async-no-downtime]]) accumulates a row per HTTP request
(`log_request`) and a row per Neo4j query (`log_cypher`). Nobody reads it. It costs disk + energy.

On 2026-07-28 the live tables were renamed to `log_request_pre284` / `log_cypher_pre284` to escape a
13–18h `AUTO_INCREMENT` `ALTER` (see `worklog/2026-07-29-0004-...`), and the worker recreated fresh
empty `log_request` / `log_cypher` (`id BIGINT AUTO_INCREMENT`, via `hbm2ddl.auto=update`). So today:

| table | contents | id type | written now? |
|---|---|---|---|
| `log_request`, `log_cypher` | post-rename, growing | `bigint AUTO_INCREMENT` | yes (worker, off Redis) |
| `log_request_pre284`, `log_cypher_pre284` | years of history, frozen | old (`int`) | no |

Goal: turn all of this — history and ongoing — into small, permanent, queryable **aggregates**, prune
the raw rows on a schedule, drain and drop the `*_pre284` tables, and expose the result as analytics
that make the app better (slow queries, slow endpoints, over/under-used users & keys, traffic anomalies).

---

## 1. What the raw rows actually contain (feasibility of the ask)

`log_request` (see `ApplicationRequestLog.java`): `globalRequestId`, `localRequestId`,
`systemComponentName`, `type`/`subType`, `userId`(70), `authSource`(`token`|`apiKey`|`anonymous`),
`jwtTokenHash`(md5, **bearer only**), `clientSessionId`, `requestTime`/`startTime`/`endTime`,
`handlerDuration`+`preHandlerDuration` (**nanos**), `httpMethod`, `path`(350), `queryParameters`(lob),
`className`(85)+`methodName`(60)+`lineNumber`, `errorPack`(lob).

`log_cypher` (see `ApplicationCypherLog.java`): `systemComponentName`, `duration`(nanos),
`logTime`/`startTime`/`endTime`, `operation`, `runnableHash`(md5), `parametersHash`(md5),
`original`/`runnable`/`interpolated`/`parameters` (all lob), `className`+`methodName`+`lineNumber`.

| Requested pattern | Feasible from current data? |
|---|---|
| Slow Cypher queries | ✅ `duration` + `runnableHash` (+ text). Group by hash → p95 × volume. |
| Slow REST endpoints | ✅ `handlerDuration` + `className`/`methodName` (exact handler) + `httpMethod`. |
| Over/under-used **users** | ✅ `userId` counts. |
| Over/under-used **API keys** | ⚠️ Only **per-user** API-key traffic (`userId` + `authSource=apiKey`). Individual keys need a new `apiKeyHash` (small change, §7). |
| Excessive calls to a Cypher shape / method | ✅ `runnableHash` / (`className`,`methodName`) counts vs baseline. |
| Tricky traffic patterns (bursts, off-hours) | ✅ with an **hourly** rollup (§4) — daily grain alone can't see intraday. |
| Error hotspots, 4xx vs 5xx | ⚠️ error-vs-success is derivable from `errorPack`; **4xx/5xx split needs HTTP status**, which is *not stored today* → add it (small change, §7; `ResponseLoggerFilter` already holds the response). |

`*_pre284` note: no status column ever existed there → historical `statusClass` = `unknown` (error vs
ok still derivable from `errorPack`). Plan for graceful degradation on the history.

---

## 2. Target architecture

```
                 (unchanged) every microservice --Redis--> worker: AppLoggerQueueProcessor
                                                                     |
                                                                     v  writes raw
                                              log_request / log_cypher  (retention: 30d raw)
   cedar-worker-server                                   |
   ┌─────────────────────────────────────────────┐      | reads settled days (>=1d old)
   │ RequestLogAggregatorJob  (daily 01:00)  ─────┼──────┘  folds -> rollups, marks aggregated_at
   │ LogPruneJob              (daily 03:00)  ─────┼──────>  deletes raw where aggregated & >30d
   │ HistoricalBackfillJob    (throttled)    ─────┼──────>  drains *_pre284 -> rollups, then DROP
   └───────────────────────────────┬─────────────┘
                                    v  writes/reads
                    agg_* rollup tables  (retention: forever, tiny)
                                    ^  reads
   cedar-monitor-server            │
   ┌────────────────────────────────────────────┐
   │ LogUsageResource   (aggregated + patterns)  │◄── cedar-monitoring "Usage & Patterns" page
   │ LogExplorerResource(live raw, <=30d)        │◄── cedar-monitoring "Live Log Explorer" page
   └────────────────────────────────────────────┘
```

Placement rationale (matches current style): the worker already owns writes to this DB and is the
background-jobs server (`Managed` loops off Redis); monitor-server already binds the log entities +
DAOs and pairs with the `cedar-monitoring` Angular app.

---

## 3. Aggregation grain & the histogram trick

- **Canonical grain = HOURLY, timestamped in UTC** (`hourUtc DATETIME`, i.e. a UTC day + hour 0–23).
  This is the key decision and it subsumes two earlier concerns:
  - **Timezone** (CEDAR is worldwide): a day/week bucket in a *single* zone can't be re-bucketed to
    another zone (an EU day = 23:00–23:00 UTC cuts across two UTC days). Hourly-UTC fixes it — **any**
    timezone's day/week/weekend is a `SUM` of the right 24 (or 168) hourly buckets, with the offset
    applied at query time through a real `java.time.ZoneId` so **DST is correct** (an EU day is
    sometimes 23 or 25 hours). "Day" / "week" become *query-time folds parameterised by timezone*, not
    a storage grain.
  - **Arbitrary ranges** (your "not on a weekend boundary" point): still a plain `SUM`, now down to the
    hour.
  - Caveat: sub-hour-offset zones (India +5:30, Nepal +5:45, parts of AU) are ±1h fuzzy at the day edge
    — everything in the Americas/Europe/most of Asia is a whole-hour offset and exact. Drop to 15-min
    grain only if those zones ever need to be precise (not now). Cost of hourly vs daily ≈ 24× rollup
    rows — still microscopic next to raw.
- Durations stored as **count / sum / min / max** (compose across buckets) **plus a fixed log-scale
  latency histogram** (15 integer columns) that **merges by column-wise SUM**, so p50/p95/p99 over any
  arbitrary range *and any timezone* are recoverable (approximately — which is all a percentile ever
  is). Bucket ceilings (ms): `1,2,5,10,25,50,100,250,500,1000,2500,5000,10000,30000,∞`.
- UI implication: the query pages carry a **timezone selector** (default e.g. `America/Los_Angeles` or
  `UTC`); the mock's date picker gains that control.

---

## 4. Aggregation database schema

Created the same way the raw tables are today — as Hibernate entities in
`cedar-logging-operations-library`, auto-created by `hbm2ddl.auto=update` (no manual migration files,
matching current practice). Logical definitions:

All time-bucketed tables key on **`hourUtc DATETIME`** (a UTC day+hour). Every day/week/timezone report
is a query-time `SUM` over the covered `hourUtc` rows (§3). `statusClass` is now real (from the new
`status` column, §7); `unknown` only for `*_pre284` history.

### 4.1 `agg_request_hourly` — REST endpoint rollup
Dims (composite unique key): `hourUtc`, `systemComponentName`, `className`, `methodName`, `httpMethod`,
`statusClass` (`2xx|3xx|4xx|5xx|err|unknown`), `authSource`.
Metrics: `reqCount BIGINT`, `errorCount BIGINT`, `sumHandlerNanos BIGINT`, `minHandlerNanos BIGINT`,
`maxHandlerNanos BIGINT`, `sumPreHandlerNanos BIGINT`, `h00..h14 INT` (latency histogram),
`samplePath VARCHAR(350)` (one representative). Index each dim + `hourUtc`.
(The intraday / burst / off-hours "traffic shape" view and the volume sparkline are just this table
grouped by `systemComponentName` — no separate hourly table needed once the grain is already hourly.)

### 4.2 `agg_request_user_hourly` — who is calling (users & API keys)
Dims: `hourUtc`, `userId`, `authSource`, `apiKeyHash` (nullable; now populated — §7, and the reason a
single user's *individual* keys are separable post-rotation). Metrics: `reqCount`, `errorCount`,
`sumHandlerNanos`, `distinctSessions INT` (approx), `distinctComponents INT`. Kept separate from 4.1 so
`userId × handler × hour` never explodes.

### 4.4 `agg_cypher_hourly` — Cypher shape rollup
Dims: `hourUtc`, `systemComponentName`, `operation`, `runnableHash`. Metrics: `execCount BIGINT`,
`sumNanos`, `minNanos`, `maxNanos`, `h00..h14`. FK-ish: `runnableHash` → catalog.

### 4.5 `agg_cypher_query_catalog` — dedup the giant LOBs
Key: `runnableHash`. Cols: `operation`, `runnableSample MEDIUMTEXT`, `interpolatedSample MEDIUMTEXT`,
`firstSeen`, `lastSeen`, `sampleClassName`, `sampleMethodName`. **This is the big disk win**: millions
of duplicated query-text LOBs collapse to one row per distinct shape.

### 4.6 `log_aggregation_state` — orchestration / idempotency / observability
Cols: `id`, `sourceTable` (`log_request`|`log_cypher`|`*_pre284`), `bucket` (the **UTC day** processed
— which yields 24 `hourUtc` rollup rows — or an id-range label for backfill), `status`
(`PENDING|RUNNING|AGGREGATED|FAILED`), `rowsIn`, `rowsOut`, `minId`/`maxId` (backfill cursor),
`startedAt`, `finishedAt`, `error`. Unique (`sourceTable`,`bucket`). A day/range is aggregated
**exactly once**; re-runs skip. Also the progress dashboard for backfill. (Aggregating whole settled
UTC days keeps the aggregator simple and timezone-agnostic; the timezone fold happens only at read.)

### 4.7 (optional, phase 3) `agg_insights` — precomputed pattern findings
`day`, `kind` (`SLOW_CYPHER|SLOW_ENDPOINT|HEAVY_USER|IDLE_KEY|TRAFFIC_ANOMALY|ERROR_HOTSPOT`),
`subjectKey`, `score`, `detailJson`. v1 computes insights on demand from the rollups (they're tiny);
promote to this table only if on-demand gets slow.

---

## 5. Workers, schedules, modes of operation

No scheduler exists in the repo (no Quartz/@Scheduled). Match the existing pattern: a `Managed`
component per job holding a background thread loop (as `AppLoggerQueueProcessor` does), registered in
`WorkerServerApplication`, each **independently enable/disable-able and time-configurable** from config
(and later UI-toggleable). All best-effort: a failed run logs + retries next tick, never throws into
anything user-facing.

### 5.0 Lifecycle & crash-safety contract (applies to every job)
The answers to "when does it start / stop / what if the server dies / when does it delete" all reduce
to one mechanism:
- **Atomic additive batch.** Each batch commits, in **one log-DB transaction**, both the rollup deltas
  (`... = ... + VALUES(...)`, histograms column-wise) **and** the advance of a cursor in
  `log_aggregation_state`. Applied exactly once: commit → cursor moved; crash mid-batch → whole txn
  rolls back → the batch simply re-runs on restart. No double-count, no lost rows, no manual cleanup.
  Additive (not delete-then-insert) so the historical and live jobs can both write the rename-day's
  hour buckets without clobbering each other.
- **Start** = `Managed` thread on worker boot; work is driven by the state table, not a wall clock, so
  it is a **catch-up scheduler** — after downtime it processes exactly the buckets it missed.
- **Stop** = the loop idles (sleeps) when no eligible bucket remains; it never needs a clean "end" to be
  correct. Shutdown flips a `doProcessing=false` flag (as the queue processor does) and the thread exits
  after the current batch.
- **Server stops mid-run** = resume from the persisted cursor/state on next boot. Single worker
  instance today (like the single-thread queue consumer); if ever scaled, a `RUNNING` lease row in the
  state table prevents two runners on one bucket.
- **Deletion never happens inside aggregation** — see 5.2 (live prune) and 5.3 (historical drop); both
  are gated on the data already being safely in the rollups.

### 5.1 `RequestLogAggregatorJob` + `CypherLogAggregatorJob` — ongoing, incremental
- Trigger: the loop wakes every N minutes (configurable; a preferred off-peak hour is a hint, not a
  hard cron) and processes any eligible day. Catch-up: after downtime it processes every missed day.
  Also a manual admin trigger endpoint.
- Candidate days = every UTC `day` with raw rows where `day <= today-1` **plus a settle margin** (the
  rows are written async off Redis, so a day is only fully drained a few hours after it ends — process
  day `D` after `D+1` + margin) and no `AGGREGATED` row in `log_aggregation_state`.
- For each candidate day: mark `RUNNING`; stream raw rows for that day in `id`-ranged batches
  (`WHERE requestTime >= :d AND requestTime < :d+1 AND id > :cursor ORDER BY id LIMIT :batch`); fold into
  in-memory rollup maps (dims → metrics + histogram); **atomic batch** (§5.0) = additive-upsert the
  hourly rollups + advance cursor; then `UPDATE ... SET aggregatedAt = NOW()` for that day's raw rows
  (bounded — one day); mark `AGGREGATED` with row counts. A day is processed exactly once; re-runs skip.

### 5.2 `LogPruneJob` — daily, separate thread, offset in time
- Trigger: daily (default 03:00) — deliberately after the aggregator, staggered so both never hammer
  MySQL at once.
- Deletes raw rows that are **marked aggregated and older than 30 days**, in bounded batches with a
  sleep between them (`DELETE FROM log_request WHERE aggregated_at IS NOT NULL AND requestTime <
  :cutoff LIMIT :batch`, loop until 0 rows, `Thread.sleep(pauseMs)` each iteration). Same for
  `log_cypher` (keyed on `logTime`). Batch size + pause configurable → never a long lock, never an I/O
  spike. Retention (30d) configurable.

### 5.3 `HistoricalBackfillJob` — throttled, scattered, self-terminating
- Purpose: drain `log_request_pre284` / `log_cypher_pre284` (years of rows) into the same rollup tables,
  then reclaim the disk.
- Mode: read-only over the frozen tables via **native SQL** (their old schema — `int id`, no `status`,
  no `aggregated_at` — is *not* mapped as an entity; don't fight Hibernate over a dead schema). Walk by
  `id` range in small batches; fold into the **same** rollup maps and **additively upsert**
  (`ON DUPLICATE KEY UPDATE reqCount = reqCount + VALUES(reqCount), ...`, histograms column-wise) — safe
  because pre284 and live are time-disjoint, so day buckets rarely coincide (only possibly the rename
  day). Record the `id` cursor in `log_aggregation_state` so it is **restartable**.
- Throttle: only run inside a configurable off-peak window (e.g. 02:00–06:00), small batch, sleep
  between batches. "Scattered in time not to overload MySQL", exactly.
- Stop: cursor climbs to `MAX(id)`; a short final batch marks the source `COMPLETE` and the loop idles.
  The nightly window closing is not a stop — the cursor is persisted, it resumes next window.
- Reclaim (never during aggregation): on `COMPLETE`, verify parity (`SUM(rollup counts) ==
  COUNT(*)` on the source), then the job marks `READY_TO_DROP` — the actual `DROP TABLE
  log_request_pre284` is a **deliberate, confirmed** step (or a separate authorizing flag), never
  automatic, per the "no accidents" rule. `DROP` is an instant metadata op reclaiming all disk at once;
  if a single multi-GB `DROP` risks an I/O stall on `cedr-prd-db-01`, fall back to throttled batched
  `DELETE ... LIMIT` then `DROP` the empty shell.

---

## 6. "Marked aggregated" + pruning mechanics (honoring your model)

- Add a nullable `aggregated_at TIMESTAMP NULL` to `log_request` and `log_cypher`. Adding a **nullable**
  column is an `ALGORITHM=INSTANT` change in MySQL 8 — metadata only, **no table rebuild** (this is the
  whole point: we do *not* repeat the `AUTO_INCREMENT` COPY mistake). Do it via the entity + confirm
  Hibernate emits an instant-eligible `ALTER`, or run the one-line `ALTER ... ALGORITHM=INSTANT` in tmux.
- The daily aggregator sets `aggregated_at` on a day's rows (cheap — one day's volume). The prune job
  keys off it. The `log_aggregation_state` table is the orchestration/restart/observability layer on
  top.
- Backfill (`*_pre284`) does **not** per-row mark — deletion/drop is the "done" signal there; marking
  billions of frozen rows before dropping them would be pure waste.
- Alternative considered (and rejected as default): state-table-only, no per-row column — lighter, but
  it doesn't match "mark the rows" and makes the prune predicate a day-set join. Per-row `aggregated_at`
  is cheap enough at daily volume and is the clearer contract.

---

## 7. Codebase changes (by module, in current style)

**`cedar-microservice-libraries/cedar-logging-operations-library`**
- New `@Entity` rollup + state classes (§4) in `.../logging/dbmodel/agg/` with `AbstractDAO` DAOs in
  `.../logging/dao/` (mirrors `ApplicationRequestLogDAO`).
- `LogAggregationService` — the fold + histogram-bucketing logic, shared by daily + backfill.
- **DONE (2026-07-29): capture HTTP `status`.** Added `Integer status` (+ index) to
  `ApplicationRequestLog`, `STATUS` to `AppLogParam`, captured `responseContext.getStatus()` in
  `ResponseLoggerFilter.filter(...)`, merged in `mergeEndLog` (guards 0 → null = unknown).
- **DONE (2026-07-29): capture `apiKeyHash`.** Added `apiKeyHash`(32) (+ index) to
  `ApplicationRequestLog`, `API_KEY_HASH` to `AppLogParam`, and md5-hashed the apiKey header in
  `CedarMicroserviceResource.buildRequestContext()` (mirrors `jwtTokenHash`; key itself never stored).
  This is what makes a single user's *individual* keys separable after the multi-key + rotation change.
- **DONE (2026-07-29): `aggregatedAt`** added to both `ApplicationRequestLog` and `ApplicationCypherLog`
  (+ indexes). Set by the aggregation job, not the logging path.
- **DONE (2026-07-29): migration** `cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql`
  — LIVE tables only (status/apiKeyHash/aggregatedAt as INSTANT nullable adds + indexes while small);
  `*_pre284` left frozen (aggregator projects NULLs). On branch `feature/log-capture-phase1`.

**`cedar-worker-server`**
- `RequestLogAggregatorJob`, `CypherLogAggregatorJob`, `LogPruneJob`, `HistoricalBackfillJob` as
  `Managed` + `ScheduledExecutorService`; register in `WorkerServerApplication.runApp()` next to the
  existing queue processors. Native-SQL access to `*_pre284` for backfill. Config-gated.
- Admin trigger endpoints (`POST /command/aggregate-now`, `/backfill/{step}`) on an
  `AbstractWorkerResource`, gated by a capability, for manual kicks + testing.

**`cedar-monitor-server`**
- Bind the new rollup entities in `CedarMonitorHibernateBundle`; build their DAOs in
  `MonitorServerApplication.initializeApp()`.
- `LogUsageResource` — date-range queries over `agg_*` + the pattern-detection endpoints (§8).
- `LogExplorerResource` — paged/filtered queries over the **live raw** tables (≤30d): by user, session,
  request id, path, handler, slow-cypher drilldown with full text. Register both in `runApp()`.

**`cedar-config-library`**
- New `logAggregation` block in `cedar-main.yml` + a `LogAggregationConfig` POJO on `CedarConfig`
  (mirror `getDBLoggingConfig()`), + env vars in `CedarConfigEnvironmentDescriptor` /
  `CedarEnvironmentVariable`. (Config lives in config-library, so no core-library shading rebuild is
  triggered — but if any shared enum lands in core-library, remember [[cedar-core-library-shading-rebuild]].)

**`cedar-monitoring` (Angular internals app)**
- Two routes/pages under `src/app/modules/resources/pages/` (matching `resource-counts`, `queue-counts`
  structure): `usage-patterns/` and `log-explorer/`, each with component + `load-data` service + model,
  guarded by `route.data['roles']` (MONITOR_READ), added to nav. The mock (§9) is the target UI.

**DB migrations**: rollup + state tables auto-created by the worker's `hbm2ddl.auto=update` (same path
that recreated `log_request` post-rename). Only manual DDL is the two `INSTANT` `ALTER`s for
`status` + `aggregated_at` (run in **tmux** per the runbook lesson), and eventually `DROP TABLE *_pre284`.

---

## 8. Query pages + pattern detection

**Page 1 — Usage & Patterns (aggregated).** The mock already built (arbitrary date range,
merged-histogram percentiles, component/route/status/user breakdowns, storage panel, cypher toggle).
Fast because it hits only the tiny `agg_*` tables. Adds an **Insights** strip:

| Insight | Query (over rollups) |
|---|---|
| Slowest Cypher shapes | `agg_cypher_daily` in range → merge histograms per `runnableHash` → rank by `p95 × execCount`; join catalog for text. |
| Slowest REST endpoints | `agg_request_daily` → per (class,method,httpMethod) p95 × reqCount. |
| Heaviest users / API keys | `agg_request_user_daily` → top-N reqCount; split by `authSource`. |
| **Barely-used** keys/users | bottom-N with `reqCount>0`, or keys present historically but absent in the recent window (candidate revokes). |
| Excessive calls to one shape/method | z-score of daily count vs the subject's own trailing mean (spot a runaway caller). |
| Traffic anomalies | `agg_traffic_hourly` → off-hours mass, day-over-day spikes. |
| Error hotspots | high `errorCount/reqCount` per endpoint or per user. |

**Page 2 — Live Log Explorer (raw, ≤30d).** Row-level forensics the aggregates deliberately drop:
search/filter by `userId`, `globalRequestId`, `path`, handler, `authSource`, status, min-duration;
open a request to see its `errorPack`; open a slow Cypher row to see full `interpolated` text +
parameters. This is the "something looks fishy right now" tool; it pairs with the runtime **cypher
logging toggle** (flip on → the fishy queries start landing here → investigate → flip off).

---

## 9. Mocks

- Page 1 (Usage & Patterns): `worklog/`-adjacent mock already delivered
  (artifact `CEDAR Internals · Logs & Usage`).
- Page 2 + Insights: second mock delivered alongside this plan (`log-explorer-insights-mockup.html`).

---

## 10. Rollout / phasing

1. **Schema + capture**: add `status` + `aggregated_at` (INSTANT ALTERs, tmux); add rollup/state
   entities (auto-created). No behaviour change yet.
2. **Daily aggregator + prune** on the *live* tables. Watch `log_aggregation_state`. Once trusted, the
   raw tables stop growing unboundedly (30d cap).
3. **Backfill** `*_pre284` in the off-peak window; verify row-count parity; `DROP`. Reclaims the years.
4. **Monitor endpoints + two Angular pages**; then the Insights/pattern layer.
5. (Optional) UI toggles for jobs + cypher logging; `apiKeyHash` for per-key analytics; `agg_insights`
   precompute if on-demand slows.

---

## 11. Risks & "fishy" callouts

- **Never add AUTO_INCREMENT / non-instant columns to the big tables again** — that was the 13h stall.
  All new columns here are nullable/INSTANT; verify the algorithm before running on prod.
- **`log_request` rows mutate** (start→handler→end→exception). Only aggregate settled days (≥1d old) —
  already the rule — so no row is aggregated mid-flight.
- **Percentiles are approximate** post-merge (histogram-bounded). Fine for ops; state it in the UI.
- **Per-row `aggregated_at` UPDATE** rewrites one day of rows daily — acceptable; if ever not, fall back
  to state-table-only pruning (§6).
- **Single `DROP` of a multi-GB `*_pre284`** may stall I/O on that disk — verify parity first, prefer
  DROP, keep batched-DELETE as the fallback.
- **History has no status / no apiKeyHash** — degrade to `unknown` / per-user; don't pretend otherwise
  in the UI.
- **Tune on real data**: bucket edges, batch sizes, and the off-peak window should be set from a prod
  sample (`SELECT` cardinalities + p99 duration) before the backfill runs at scale.
```
