-- =============================================================================
-- Staging log-aggregation PROGRESS — read-only. Re-run every 15-30 min during
-- runbook §7 (live aggregator) and §8 (backfill).
--
--   watch -n 900 'mysql -h <HOST> -u <USER> -p<PASS> <DB> < staging-logagg-progress.sql'
-- =============================================================================

SELECT '=== live aggregator: one row per source table per settled UTC day ===' AS section;
SELECT sourceTable, bucket, status, rowsIn, rowsOut, startedAt, finishedAt,
       LEFT(COALESCE(errorText,''),120) AS err
FROM log_aggregation_state
WHERE sourceTable IN ('log_request','log_cypher')
ORDER BY bucket DESC LIMIT 20;

SELECT '=== backfill: cursorId IS the progress bar ===' AS section;
SELECT sourceTable, status, minId, cursorId, maxId,
       ROUND(100*(cursorId-minId)/NULLIF(maxId-minId,0),2) AS pct_done,
       rowsIn, rowsOut, startedAt, finishedAt,
       LEFT(COALESCE(errorText,''),120) AS err
FROM log_aggregation_state
WHERE sourceTable LIKE '%\_pre284';

SELECT '=== anything FAILED? (must stay empty) ===' AS section;
SELECT * FROM log_aggregation_state WHERE status = 'FAILED';

SELECT '=== rollups growing ===' AS section;
SELECT 'agg_request_hourly'      AS tbl, COUNT(*) AS n, MIN(hourUtc) AS first_hour, MAX(hourUtc) AS last_hour FROM agg_request_hourly
UNION ALL SELECT 'agg_cypher_hourly',      COUNT(*), MIN(hourUtc), MAX(hourUtc) FROM agg_cypher_hourly
UNION ALL SELECT 'agg_request_user_hourly', COUNT(*), MIN(hourUtc), MAX(hourUtc) FROM agg_request_user_hourly;
SELECT 'agg_cypher_query_catalog' AS tbl, COUNT(*) AS n FROM agg_cypher_query_catalog
UNION ALL SELECT 'agg_request_outlier', COUNT(*) FROM agg_request_outlier
UNION ALL SELECT 'agg_cypher_outlier',  COUNT(*) FROM agg_cypher_outlier;

SELECT '=== raw rows still unaggregated ===' AS section;
SELECT COUNT(*) AS unaggregated_requests FROM log_request WHERE aggregatedAt IS NULL;
SELECT COUNT(*) AS unaggregated_cypher   FROM log_cypher  WHERE aggregatedAt IS NULL;

SELECT '=== PRUNE SAFETY INVARIANT - must always be 0 ===' AS section;
-- prune deletes only rows that are BOTH aggregated AND past retention; this counts
-- rows that are past retention but NOT yet aggregated, i.e. must never be touched.
SELECT COUNT(*) AS at_risk_requests FROM log_request
WHERE aggregatedAt IS NULL AND requestTime < DATE_SUB(NOW(), INTERVAL 30 DAY);

SELECT '=== DB load while this runs (shared instance on staging!) ===' AS section;
SELECT * FROM performance_schema.events_stages_current;
