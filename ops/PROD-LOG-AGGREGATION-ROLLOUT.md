# Prod rollout — log aggregation, pruning & analytics

Companion to `LOG-AGGREGATION-PLAN.md` (the design). This is the **operational prod plan**: order of
operations, env vars, what reads what, waits, and the safety analysis. Deploy mechanics follow
`PROD-DEPLOY-RUNBOOK.md` + [[cedar-prod-deploy]]. Feature branch: `feature/log-aggregation` (8 repos).

---

## 0. The safety property everything rests on
`cedar_log_production` is a **separate host** (`cedr-prd-db-01`), written **only** by the worker draining
Redis — **no CEDAR app path reads it synchronously** ([[cedar-log-db-async-no-downtime]]). So every heavy
thing here (full-table reads, backfill, prune) stresses *the log DB only*; even if it slows, **CEDAR
stays up**. That is why none of this needs downtime and why it is far safer than it looks.

## 1. How we know what prod uses
`serverTimezone: "America/Los_Angeles"` and `hbm2ddl.auto=update` are **hard-coded in the shared
artifacts** (`cedar-config-library/cedar-main.yml`; `hibernate.properties` in worker/monitor), which are
shaded into every server and deployed identically to prod. So prod uses them. **Caveat:** that is the
*config*; the definitive check of how existing rows are physically stored is to query prod
(`SELECT @@session.time_zone; SELECT requestTime FROM log_request LIMIT 5;`) from the staging host.

## 2. Timezone — DECIDED: do NOT force UTC on prod
Locally I had added `hibernate.jdbc.time_zone=UTC`; **that has been reverted** on the branch. Reasoning:
the aggregator is **self-consistent** under `serverTimezone=America/Los_Angeles` — the driver converts
each stored datetime to the correct instant (DST-aware), the fold truncates that instant to the UTC
hour, and every write and range-bound passes through the same connection tz, so rollups are correct.
`hourUtc` physically stores connection-tz wall-clock, but is always queried consistently. Forcing UTC
would make the connection **misread the years of existing LA-stored rows** (log_request/log_cypher and
`*_pre284`) by +7/8h → wrong hour/day buckets for all history. Reverting avoids migrating any existing
data. (Optional future cleanup: a one-time DST-aware `CONVERT_TZ` migration to make the columns literally
UTC — not needed for correctness.)

## 3. Schema migration — will Hibernate do it on restart?
**Columns + new tables: yes.** `hbm2ddl.auto=update` will `ADD` the nullable `status`/`apiKeyHash`/
`aggregatedAt` columns (nullable ⇒ `ALGORITHM=INSTANT`, fast even on huge tables) and create the empty
`agg_*` + `log_aggregation_state` tables. **Indexes: do NOT rely on it.** hbm2ddl may issue a plain,
non-online `CREATE INDEX` on a huge existing table **at boot**, blocking startup for a long time.
→ **Pre-create the columns + indexes by hand** (online, controlled, tmux) **before** deploying the new
build, using `cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql`
(`ADD ... ALGORITHM=INSTANT`, `CREATE INDEX ... ALGORITHM=INPLACE, LOCK=NONE`). Then the new build's
hbm2ddl finds everything present and does nothing. Let hbm2ddl create the (new, empty) `agg_*` tables.

## 4. Order of jobs — live first, then backfill (safe; your intuition addressed)
You asked if starting the live aggregator before the history backfill intermixes/loses precision. **It
does not.** Live covers post-2026-07-28 days; backfill covers pre-2026-07-28 history — **disjoint hour
buckets**. The one shared day (the 2026-07-28 rename) gets its pre-rename part from `*_pre284` and its
post-rename part from the live table, and the **additive upsert** (`count = count + VALUES(count)`)
sums them correctly; MySQL row-locking serializes concurrent writers to the same bucket, so no lost
updates. Order is therefore correctness-neutral. Live-first is chosen deliberately for **operational**
reasons: get ongoing data flowing and sanity-check the pipeline on small, recent, easily-eyeballed data
before unleashing the multi-night backfill.

## 5. Rollout phases (what happens on what day)

| Phase | Day | Action | Env | Wait |
|---|---|---|---|---|
| Land | — | merge branch → main across 8 repos; cut a release; get prod `COUNT(*)` of the 4 tables | — | — |
| **0** | Deploy | prod deploy (bump modifier → build all → stop/start java → keycloak listener → configure-frontends → CEE → nginx). **Pre-run the hand migration** (columns+indexes). | all jobs **false** | ALTER cols = seconds; indexes = minutes–hours |
| **1** | +1 | enable live aggregator; re-source; restart worker. Catches up settled days from 2026-07-28 forward, then 1 day/day. | `LIVE_AGG=true` | catch-up minutes–hours |
| **2** | +2…N | enable backfill (conservative). Drains `*_pre284` in id-range batches in the off-peak window; restartable via cursor. Parity-check → `READY_TO_DROP` → **`DROP TABLE *_pre284`**. | `BACKFILL=true` → false when done | several nights (throttled) |
| **3** | +weeks | after the rollups are trusted: enable prune (see §7 for the SAFE way). | `PRUNE=true` | first prune hours/nights |

## 6. Env vars (prod)
Enables (registered in `set-env-internal.sh` + template + worker README + docker-compose):
`CEDAR_LOG_BACKFILL_ENABLED`, `CEDAR_LOG_LIVE_AGG_ENABLED`, `CEDAR_LOG_PRUNE_ENABLED`.
**Conservative tuning lives in these** (defaults in code; overridable in `set-env-internal.sh`):
`CEDAR_LOG_BACKFILL_BATCH` (5000 → prod 1000), `_BACKFILL_PAUSE_MS` (500 → 2000),
`_BACKFILL_WINDOW_UTC` (2-6 → prod's real low-traffic UTC hours), `_LIVE_AGG_BATCH/_PAUSE_MS/_POLL_MS/
_MARGIN_HOURS`, `_PRUNE_RETENTION_DAYS` (30), `_PRUNE_BATCH` (2000 → 1000), `_PRUNE_PAUSE_MS` (500 →
2000), `_PRUNE_IDLE_MS`. Re-source + restart the worker after any change.

## 7. Is deleting history OK? Will prune kill MySQL? (your two biggest questions)
Both are real. Answers:
- **Confirm the log DB's obligations first.** Is `cedr-prd-db-01` replicated / PITR-backed / consumed by
  anything downstream, and is there a retention/compliance requirement? Aggregation preserves the
  *summary* forever, so pruning raw rows loses only row-level detail — but confirm nothing depends on
  those rows before enabling prune.
- **A mass `DELETE` is binlog/undo-heavy** — it can bloat the binlog and lag replication. Two ways to be
  safe: (a) **batched + paused + off-peak** `DELETE` (what the prune job does) — works today, just watch
  replication lag; or (b) **the proper time-series pattern: partition the log tables by day and
  `DROP PARTITION`** — instant, negligible binlog, no undo. Partitioning requires the partition key in
  the PK/unique keys, so retrofitting it onto the existing big tables is a one-time rebuild (do it in a
  maintenance window). Recommendation: batched DELETE for the first prune; plan partitioning for the
  long term.
- **`DROP TABLE *_pre284`** is a single cheap binlog event (not a per-row delete) — the right way to
  reclaim the history's disk. Parity-verify first; if a single multi-GB drop risks an I/O stall, batched
  `DELETE ... LIMIT` then drop the empty shell.
- **Will it kill MySQL?** The reads are **bounded/indexed** (backfill by PK id-range + LIMIT; live by the
  `requestTime` index for one settled day), throttled, and off-peak. And per §0 it is a **separate host
  with no synchronous app dependency**, so the blast radius is the log DB alone, never CEDAR. Monitor
  `cedr-prd-db-01` load + replication lag during the backfill; the throttle is there to dial it down.

## 8. Capturing "fishy past things" (your ask) — what we have + what to add
Already captured (survives pruning, kept forever):
- **Slow Cypher by shape** — `agg_cypher_hourly` (per-`runnableHash` count + duration histogram → p95/p99)
  + `agg_cypher_query_catalog` (one representative text per shape).
- **Most/least-used users & API keys** — `agg_request_user_hourly` (per `userId` × `authSource` ×
  `apiKeyHash` per hour).
- **Slow endpoints, error hotspots, traffic anomalies** — `agg_request_hourly` + the `/logs/usage/insights` endpoint.

**BUILT (outlier retention):** `agg_request_outlier` + `agg_cypher_outlier` — permanent tables holding
the top-N slowest + error request instances and top-N slowest Cypher instances (full text / params /
user / timestamp), so "this exact query took 45s at 03:00 by user X" is answerable **after** the raw row
is pruned. Filled server-side (`INSERT ... SELECT ... ORDER BY duration DESC LIMIT N`, so only the N
chosen rows' LOBs move): the live aggregator captures top-50 slow + top-50 error **per settled day**; the
backfill captures top-500 over all history once, before `*_pre284` is dropped. Read via
`/logs/explorer/outliers/{requests,cypher}`. Never pruned. (Config for N is currently in-code constants.)

## 9. The report — decouple GENERATE from DELIVER (Stanford email may be blocked)
Want: a periodic HTML report to a **dynamic** recipient list (add a person without a rebuild/restart).
Concern: on Stanford infra, app-sent email may be **disallowed** or need a from-address allowlisted.
CEDAR also has **no email/SMTP today** (the messaging server is in-app DB messages). So don't hard-depend
on email. Recommended, in order:
1. **Generate + expose in-app (no SMTP, works today).** A scheduled worker job renders the weekly HTML
   report from the rollups/insights (the mock is the template) and stores it; a monitor endpoint /
   internals "Reports" page serves the latest, MONITOR_READ-gated. Pull model — role-gated, zero email
   risk. **This is the safe default.**
2. **Push notice via the EXISTING in-app messaging** (`cedar-messaging-server`, `PersistentMessage`):
   post "weekly log report ready → <link>" to recipients. No external email; reuses infra.
3. **Email — only if Stanford SMTP is confirmed.** Keycloak already sends mail on this infra, so a relay
   exists; app-sending from a new from-address likely needs Stanford IT approval. Add it later as a thin
   optional layer (`jakarta.mail` + `CEDAR_SMTP_*` env, reusing Keycloak's relay). Don't block on it.

**Recipients (dynamic, no rebuild) — Keycloak role.** A realm role (`logReportRecipient`, or reuse
`monitorManager`); the job resolves role-holders' emails from Keycloak at send time. Add/remove = toggle
the role in admin — no restart, no rebuild. (Alt: an admin-editable recipient table + internals page. A
cedar-property list is rejected — needs a restart.)
Decision needed: build (1) now (safe, no email), or wait to confirm Stanford SMTP for (3)?

## 10. Prerequisites & open decisions
1. Merge + release the branch (8 repos) — prod deploys from `main`.
2. Get prod `COUNT(*)` for the 4 tables → sizes the index build, backfill duration, tuning.
3. Confirm `cedr-prd-db-01` replication/PITR/retention obligations before enabling prune (§7).
4. Decide: build `agg_outlier_samples` (§8) and the emailed report (§9) now, or later.
5. Per convention, write `worklog/YYYY-MM-DD-prod-deploy.md` when this ships.
