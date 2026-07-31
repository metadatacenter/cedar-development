# CEDAR Log Explorer & Insight Boards — UI / Query Plan

Status: **phase 1 delivered and verified live; phases 2–5 designed** · drafted 2026-07-31 · extends and supersedes
`LOG-AGGREGATION-PLAN.md` §8 ("Query pages + pattern detection") and §9 (mocks) with the concrete
query contract, board catalog and UI grammar. Everything below is measured against the local
`cedar_log` DB on 2026-07-31 (156,863 `log_request` rows spanning 2025-02-14 → now; 224,368
`log_cypher` rows spanning 2025-02-13 → now).

---

## 0. Why — what the current explorer can't do

`/logs-explorer` today is `LogExplorerResource` (`GET /logs/explorer/{requests,cypher}?q&minDurationMs&limit`)
over `LogExplorerDAO`, rendered as a flat newest-first table with an expandable detail row. Three
hard limits, all structural:

1. **No paging.** The DAO ends in `ORDER BY requestTime DESC LIMIT :lim` with no offset and no
   cursor, and the resource caps `limit` at 500. There is no page 2 — rows 101+ are unreachable.
2. **One free-text filter for everything.** `q` is a single `LIKE %…%` OR-ed across 4 columns
   (`path`, `userId`, `className`, `globalRequestId` for requests). You cannot ask "5xx only",
   "component = resource-server", "this user AND this handler", or any range other than duration.
3. **No aggregation and no cross-table view.** Every question that needs `GROUP BY`, a percentile, a
   ranking, or the request↔cypher relationship is unanswerable, so the page can only ever be a
   tail -f. The three findings in §10 — all present in the data right now — are invisible to it.

Goal: keep the forensic row view, add an aggregation/query layer, and make the interesting questions
**pre-answered** rather than something the operator has to compose.

---

## 1. Principles

1. **One engine, many presets.** A single structured query endpoint; every "board" is a saved
   parameter set over it. No second code path for canned pages — otherwise they drift and only one
   gets maintained.
2. **URL is the state.** Filters, group-by, metrics, range, sort, cursor all serialize into the
   route. A board is a canned URL; any board can be *edited in place* the moment a number looks
   wrong, and the result is shareable and bookmarkable.
3. **Structured, not free SQL.** Every column is queryable through a whitelisted spec. No SQL text
   ever crosses the wire — the allowlist is both the injection defence and the "which columns are
   real" documentation.
4. **Same grammar over raw and rollups.** Identical filter/group-by/metric vocabulary against
   `log_request`/`log_cypher` (≤30d, exact) and `agg_*` (forever, approximate percentiles). One UI,
   two sources, an explicit precision badge.
5. **Rank by total time, not p95.** Cheap-but-constant calls dominate real systems (see §10) and
   p95-only rankings hide them.

---

## 2. What the data supports (measured 2026-07-31)

Every column below is **already indexed** on both raw tables (`SHOW INDEX`: 19 indexes on
`log_request`, 14 on `log_cypher`), so filtering and grouping on any of them is an index operation,
not a scan.

| dimension | distinct | UI treatment |
|---|---|---|
| `systemComponentName` | 9 (req) / 10 (cypher) | dropdown |
| `httpMethod` | 4 | dropdown |
| `authSource` | 3 | dropdown |
| `operation` (cypher) | 4 | dropdown |
| `className` | 39 | searchable dropdown |
| `className.methodName` (handler) | 85 (req) / 87 (cypher) | searchable dropdown |
| `runnableHash` (query shape) | 212 | searchable; join catalog for text |
| `clientSessionId` | 631 | free text + "trace this session" |
| `path` | 1,165 | free text + path-template grouping (§5, board 7) |
| `userId` | 4 (local dev; more in prod) | dropdown |
| `status` | 1 non-null so far — **see §9** | dropdown once populated |
| `apiKeyHash` | 1 non-null so far — **see §9** | dropdown once populated |
| `type` / `subType` | **1 / 1** | **dead columns — no UI** |

**The join is viable and is the biggest unlock.** 222,782 of 224,368 `log_cypher` rows carry
`globalRequestId`; joining to `log_request` yields 325,149 pairs over 150,112 distinct request ids.
`globalRequestId` is deliberately non-unique in `log_request` — one browser request fans out across
components — so a single id resolves to a **distributed trace**: every component's request row plus
every Cypher query underneath it.

---

## 3. The query spec (one engine)

`POST /logs/query` — body is the spec; the server validates every field against per-table
allowlists and builds parameterized SQL. Nothing is interpolated from user text except through bind
parameters.

```jsonc
{
  "table":  "request" | "cypher",
  "from":   "2026-07-31T00:00:00Z",     // required; defaults to now-24h
  "to":     "2026-07-31T23:59:59Z",
  "filters": [
    {"col": "systemComponentName", "op": "in",     "vals": ["cedar-resource-server"]},
    {"col": "status",              "op": "gte",    "val": 500},
    {"col": "path",                "op": "like",   "val": "/folders"},
    {"col": "errorPack",           "op": "notnull"}
  ],
  "groupBy": ["className", "methodName"],          // [] => raw rows
  "metrics": ["count", "sum:handlerDuration", "p95:handlerDuration",
              "max:handlerDuration", "distinct:userId"],
  "having":  [{"key": "count", "op": "gt", "val": "5"}],   // thresholds on the metrics above
  "orderBy": [{"key": "sum:handlerDuration", "dir": "desc"}],
  "limit":   100,
  "cursor":  null                                   // keyset, raw mode only (§7)
}
```

**Filter ops:** `eq · ne · in · notin · like · notlike · startswith · gte · lte · between · isnull ·
notnull`.
**Metrics:** `count · distinct:<col> · sum:<num> · avg:<num> · min:<num> · max:<num> ·
p50|p90|p95|p99:<num>`.
**Having ops:** `eq · ne · gt · gte · lt · lte`, on a metric that was actually selected. This is what
makes the pattern boards expressible without bespoke SQL — the N+1 detector is nothing more than
`groupBy: [globalRequestId, runnableHash]` + `having: [count > 5]`.
**Allowlisted columns** — per table, split into `dims` (groupable/filterable), `nums`
(aggregatable), `times` (range), `text` (LIKE-able, never groupable: `errorPack`, `runnable`,
`parameters`, `queryParameters`). Anything not on a list is a 400 naming the offending field.

**Response** carries its own provenance so the UI can be honest:

```jsonc
{ "rows": [...], "columns": [...], "rowCount": 100, "truncated": true,
  "nextCursor": "2026-07-31T19:41:02.113Z,148223",
  "elapsedMs": 34, "exact": true, "source": "log_request",
  "notes": ["status is NULL before 2026-07-30 — see coverage"] }
```

### Percentiles

MySQL 8 has no `PERCENTILE_CONT`. Two implementations, chosen by source:

- **Raw tables** — window function: `ROW_NUMBER() OVER (PARTITION BY dims ORDER BY col)` against
  `COUNT(*)` per group, pick the ceil(p·n)-th. Exact; bounded because the range filter bounds the
  input.
- **`agg_*` tables** — read the 15-bucket `Histogram15` and interpolate. Approximate by construction
  (that is why the histogram exists); response sets `"exact": false` and the UI shows a `~` badge.

---

## 4. Endpoints

| endpoint | purpose | status |
|---|---|---|
| `POST /logs/query` | the engine above (raw rows, aggregates, both tables) | **built** |
| `GET /logs/facets/{column}?table&from&to` | distinct values + counts for a dimension → dropdowns | **built** |
| `GET /logs/coverage` | queryable column surface + row counts + real time span + the §9 caveats | **built** |
| `GET /logs/trace/{globalRequestId}` | full trace: all component request rows + all cypher rows, ordered, with a computed waterfall | phase 4 |
| `GET /logs/boards` | board catalog (id, title, description, spec) — so the UI's board list is server-owned | phase 3 |

All `MONITOR_READ`-gated and `@UnitOfWork`, matching `LogExplorerResource`/`LogUsageResource`.
`POST` for the query (spec exceeds sane URL length); the UI keeps the shareable state in its own
route, not in the API URL.

---

## 5. Board catalog

Each board is `{id, title, question, spec}` — the spec is exactly a §3 body. "Rank by" reflects
principle 5.

**Requests**

1. **Traffic overview** — KPI tiles (requests, error rate, p50/p95/p99, distinct users, distinct
   sessions) + requests-per-minute sparkline. `groupBy: []` for tiles; a second call groups by minute.
2. **Slowest endpoints** — `groupBy: [className, methodName, httpMethod]`,
   `metrics: [count, sum, p95, max]`, order by `sum:handlerDuration`.
3. **Error hotspots** — `filters: [status gte 400]` OR `errorPack notnull`,
   `groupBy: [className, methodName, status]`, order by count. 4xx/5xx split where status exists.
4. **Heaviest users & API keys** — `groupBy: [userId, authSource, apiKeyHash]`,
   `metrics: [count, sum, p95]`. Bottom-N with `count > 0` answers the "barely-used key → candidate
   revoke" question from the aggregation plan.
5. **By component** — `groupBy: [systemComponentName]`, count + error rate + p95.
6. **Bursts & off-hours** — `groupBy: [hour-of-day]` (derived dim), flag hours > 3σ over the median.
7. **Path templates** — `groupBy: [pathTemplate]`, a derived dim that replaces UUID/id segments with
   `{id}`, collapsing 1,165 raw paths into a readable set.
8. **Session drilldown** — `groupBy: [clientSessionId]`, count + span + error count; row click → trace.

**Cypher**

9. **Slowest query shapes** — `groupBy: [runnableHash]`, order by `sum:duration`; join
   `agg_cypher_query_catalog` for representative text.
10. **Chattiest handlers** — `groupBy: [className, methodName]`, `metrics: [count,
    distinct:globalRequestId]`; ratio = Cypher calls per request.
11. **Volume by operation** — `groupBy: [operation, systemComponentName]`.

**Cross-table** (the ones the current page cannot express at all)

12. **Trace view** — one `globalRequestId` → component fan-out + Cypher waterfall.
13. **DB-time share** — per handler: `SUM(handlerDuration)` vs `SUM(cypher.duration)` joined on
    `globalRequestId` → "% of time in Neo4j". Finds handlers slow for non-DB reasons.
14. **N+1 detector** — `GROUP BY globalRequestId, runnableHash HAVING COUNT(*) > k`, ranked by
    repeats × duration. Also the per-request total-call view (§10 finding 1).

---

## 6. UI grammar

One page shell, three modes, shared controls:

- **Time range** — always present: 15m / 1h / 24h / 7d / 30d + custom. Required by the API; nothing
  is unbounded.
- **Filter chips** — one chip per filter (`component = resource-server`, `status ≥ 500`), each
  editable and removable. Facet dropdowns come from `/logs/facets/{col}`; text filters get a plain
  input. This is the "every column queryable" surface, and it is the same widget on every board.
- **Mode toggle** — `Rows` (raw, keyset-paged) · `Grouped` (pivot: pick dims + metrics) ·
  `Chart` (the grouped result as bars/lines/sparkline).
- **Board rail** — the §5 catalog down the left. Clicking one loads its spec into the *same*
  controls, so a board is a starting point, not a dead end. "Modified" badge when the operator has
  edited it; "Copy link" serializes back to a URL.
- **Row expansion** — unchanged from today (`errorPack`, full Cypher text + params, pretty-printed)
  plus **Copy as JSON** and **Open trace →**.
- **Export** — Copy as TSV (clipboard) / Download CSV, for the current result set, respecting filters.

---

## 7. The two operator questions, decided

### Copyable cell values without 600 icons

Per-cell copy buttons at 6 columns × 100 rows = 600 elements, each with an Angular binding and
listener — and 12,000 at a 2,000-row page size. The cost is the listeners and bindings, not the
glyph. Decision:

- **One delegated `(click)` on `<tbody>`**, resolving `event.target.closest('[data-copy]')`.
  `data-copy` is a plain attribute: no component, no listener, no binding per cell.
- **Icon via CSS `::after` on `:hover`** — zero DOM nodes for the cells nobody is pointing at.
- **Copy the full value, not the rendered text.** `shortUser()` truncates userId to 12 chars and
  `shortHash()` to 8; a naive copy hands over a useless prefix. `data-copy` carries the untruncated
  value — this is the real reason to implement it deliberately.
- **Row → Copy as JSON**, **result → Copy as TSV / Download CSV** for the bulk cases.

### Beyond 100 rows

**Keyset (seek) pagination**, not `OFFSET`: `WHERE (requestTime, id) < (:ts, :id) ORDER BY
requestTime DESC, id DESC LIMIT :n`, cursor `"<iso>,<id>"`. `requestTime` is indexed, `id` is the
PK, so page N costs the same as page 1 — `OFFSET 10000` does not. Paired with: explicit time window
(navigate by time, not page number), a per-filter row count so the operator knows the size of what
they're paging through, page sizes 100/500/2000, and CSV export for anything larger. Raw retention
is 30d per the aggregation plan, so the explorer is inherently bounded; longer ranges switch the
source to `agg_*`.

---

## 8. Performance guardrails

- **Time range is mandatory** (default 24h) and bounds every query's input set.
- `limit` capped server-side (raw 2,000; grouped 500); response carries `truncated` so the UI never
  implies completeness it doesn't have — the "no silent caps" rule.
- `elapsedMs` returned and displayed, so an expensive exploration is visible rather than mysterious.
- Group-by restricted to allowlisted `dims` — all indexed, all low-cardinality (§2). `path` is
  grouped via `pathTemplate`, never raw.
- `text` columns (`errorPack`, `runnable`, `parameters`) are LIKE-filterable but **never** groupable
  — they are LOBs.
- Leading-wildcard `LIKE '%x%'` can't use an index; keep it opt-in (`like` vs `startswith`) and
  prefer a facet where one exists. The engine attaches a note to the response when a leading-wildcard
  filter is used on a non-LOB column.

### Implementation constraint: no colons in generated SQL

These run as Hibernate **native** queries, and Hibernate scans the SQL text for `:name` bind
parameters *before* MySQL sees it — including inside backticked aliases and inside string literals.
Any colon that is not a declared parameter therefore fails at runtime with
`QueryException: Named parameter not bound`. This bit twice during phase 1:

- metric aliases (`AS \`sum:handlerDuration\``) → SQL aliases are now colon-free (`sum_handlerDuration`),
  while the public column key keeps the readable `fn:column` form (rows are assembled positionally, so
  the two need not match);
- the minute/hour buckets (`DATE_FORMAT(t,'%Y-%m-%d %H:%i:00')`) → replaced with colon-free date
  arithmetic (`DATE_ADD(DATE(t), INTERVAL HOUR(t) HOUR)`).

`LogQueryBuilderTest.colonsInSqlAreOnlyBindParameters` walks every generated statement and asserts
each `:` starts a bound parameter, so the whole class of bug is caught at build time rather than by a
500 in the UI. Keep every new column expression colon-free.

---

## 9. Data caveats the UI must state

- **`status` and `apiKeyHash` only exist from 2026-07-30** (added by the Phase-1 capture change).
  Older rows are NULL — currently 1 distinct non-null value in each. Status boards must show a
  coverage note and fall back to `errorPack IS NOT NULL` for error-ness on older rows; `/logs/coverage`
  exists for exactly this.
- **`type` / `subType` are single-valued** across all 156,863 rows. Not facets. Don't spend UI on them.
- **`*_pre284` history has no status and no apiKeyHash, ever** — same degradation, permanently.
- **Rollup percentiles are approximate**; raw percentiles are exact. Badge it.
- **`log_request` rows mutate** (start → handler → end → exception), so the newest rows can be
  mid-flight. Raw boards should say "live"; anything comparative should end at `now - 1m`.

---

## 10. Findings already sitting in the data (why this is worth building)

Run by hand on 2026-07-31 against local `cedar_log` — none of these are expressible in the current UI:

1. **A live N+1.** Query shape `5e6d523af30605d5266899c58ae852f5` executes **25 times within a
   single request**, repeatedly across many requests. The worst requests issue **140 Cypher calls
   across 31 distinct shapes** (~150–195 ms of DB time each).
2. **The monitoring UI is 87% of its own log volume.** `RedisQueueCountsResource.queueCounts`
   (99,228 calls) + `SummaryResource.getSummary` (36,654) = 135,882 of 156,863 rows. Polling drowns
   the signal → boards must exclude self-polling by default, with a "polling vs real traffic" toggle.
3. **A 31-minute request.** `CommandInclusionSubgraphResource.updateInclusionSubgraph`: 13 calls,
   max 1,879,573 ms, 2,393 s total. Found by ranking on total time — a p95 ranking buries it.

---

## 11. Phasing

1. **Query engine** — ✅ **done 2026-07-31.** Allowlists, spec DTOs, SQL builder (filters, group-by,
   metrics, HAVING, keyset cursor, exact window-function percentiles), `POST /logs/query` +
   `GET /logs/facets/{column}` + `GET /logs/coverage`. 33 builder tests, no DB needed; verified live
   against the local log DB (boards 2, 6, 10, 14 all expressible as plain specs, 2–160 ms).
   - `cedar-logging-operations-library`: `query/LogQueryColumns` (allowlist / security boundary),
     `query/LogQuerySpec`, `query/LogQueryResults`, `query/LogQueryBuilder` (pure spec→SQL),
     `dao/query/LogQueryDAO` (execute + facets + coverage).
   - `cedar-monitor-server`: `resources/LogQueryResource`, wired in `MonitorServerApplication`.
2. **Explorer polish** on the new engine — ✅ **done 2026-07-31** (visual pass pending a logged-in
   session). `/logs-explorer` now posts to `/logs/query` instead of `/logs/explorer/*`:
   - columns are driven by the response `ColumnMeta`, so one template renders both tables (and later
     the pivot mode) instead of two hardcoded tables;
   - keyset paging (`older →` / `← newer`) with a cursor stack, page sizes 100/500/2000;
   - time range 15m/1h/24h/7d/30d, facet dropdowns fed by `/logs/facets/{column}` with value counts,
     removable filter chips, contains-search and min-duration;
   - **one delegated `(click)` on `<tbody>`** resolving both copy-cell and expand-row, `data-copy`
     carrying the untruncated value, hover icon via CSS `::after`;
   - copy row as JSON, copy TSV, download CSV;
   - engine `notes` and `/logs/coverage` caveats rendered, so the page states its own limits.

   Note: this needed `anyComponentStyle` in `angular.json` raised from 2kb/4kb to 6kb/10kb. The
   budget measures **compiled** CSS, not SCSS source: with the original limit the build fails with
   `log-explorer.component.scss exceeded maximum budget … total of 5.39 kB` (verified by putting the
   old value back). `log-usage.component.scss` was already over the 2kb *warning* before any of this
   work, so the budget was effectively maxed out already.
3. **Boards** — ✅ **done 2026-07-31** (visual pass pending). `LogBoards` holds all 14 as saved
   specs, `GET /logs/boards` serves them, and the explorer shows them as a rail grouped by table.
   All 14 execute against the local DB in 2–47 ms. No new rendering code was needed: grouped results
   render through the same ColumnMeta-driven table as raw rows.
   - Needed one engine change: metrics with **no** groupBy now produce the totals shape (one row, no
     GROUP BY) rather than being rejected — that is what the KPI-tile boards are.
   - Still to do here: URL serialization of board + filter state (deep links), and KPI tiles rendered
     as tiles rather than a one-row table.
4. **Cross-table** — `/logs/trace/{id}`, trace waterfall, DB-time share, N+1 detector (boards 12–14).
5. **Same grammar over `agg_*`** — source switch + precision badge, so every board gets a >30d
   version. Needs the backfill actually run (`log_aggregation_state` is still empty).

---

## 12. Risks

- **Scope.** The pivot builder is the part most likely to sprawl. Ship the allowlist + a fixed
  metric set; resist per-board bespoke SQL (violates principle 1).
- **Prod cardinality is not local cardinality.** 4 local users and 1,165 paths become far larger on
  prod; re-measure §2 there before trusting the dropdown-vs-search choices.
- **Percentile window functions over a wide range can get heavy** even indexed. Enforce the range
  cap, watch `elapsedMs`, and fall back to histogram-approximate if raw p95 is slow at prod volume.
- **The join is not free.** `globalRequestId` is indexed on both tables, but 325,149 pairs locally is
  small; trace/N+1 boards must stay per-request or range-bounded, never "join everything".
- **`status`/`apiKeyHash` coverage will look like a data bug** to anyone who doesn't read §9. Surface
  it in the UI, not just here.
- **Handler attribution is only as good as the capture.**
  `CedarMicroserviceResource.buildRequestContext()` logs `getStackTrace()[2]` — its *immediate
  caller* — so any resource that calls it from a shared private helper logs every one of its
  endpoints under that helper's name. `LogQueryResource` was fixed (context built per endpoint);
  **`LogUsageResource` and `LogExplorerResource` still mis-attribute**, and any resource written that
  way in future will too. Every board grouping by `handler` silently loses resolution for them.
  A central fix (walk to the first JAX-RS-annotated frame) means touching
  `cedar-server-utils-dropwizard-library` and rebuilding every service — worth doing, not done.
