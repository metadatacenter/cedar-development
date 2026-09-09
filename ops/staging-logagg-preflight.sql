-- =============================================================================
-- Staging log-aggregation PRE-FLIGHT — read-only. Changes nothing.
-- Companion to STAGING-LOG-AGGREGATION-RUNBOOK.md §2. Run BEFORE deploying 2.9.7.
--
--   mysql -h <LOG_DB_HOST> -u <LOG_DB_USER> -p <LOG_DB_NAME> \
--     < cedar-development/ops/staging-logagg-preflight.sql | tee preflight-$(date +%F).txt
--
-- Keep the output. §6/§8 parity checks compare against it, and it is the input
-- for sizing next week's prod run.
-- =============================================================================

SELECT '=== 0. which schema am I in ===' AS section;
SELECT DATABASE() AS current_schema, VERSION() AS mysql_version;

SELECT '=== 1. is this schema shared with app tables? (want: log_* / agg_* ONLY) ===' AS section;
SELECT table_name FROM information_schema.tables
WHERE table_schema = DATABASE() ORDER BY table_name;

SELECT '=== 2. all schemas on this instance (prod=own host, staging=probably shared) ===' AS section;
SELECT table_schema, COUNT(*) AS tables,
       ROUND(SUM(data_length+index_length)/1073741824,2) AS total_gb
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
GROUP BY table_schema ORDER BY 3 DESC;

SELECT '=== 3. BASELINE ROW COUNTS - record these ===' AS section;
SELECT 'log_request'        AS tbl, COUNT(*) AS rows_ FROM log_request
UNION ALL SELECT 'log_cypher',         COUNT(*) FROM log_cypher
UNION ALL SELECT 'log_request_pre284', COUNT(*) FROM log_request_pre284
UNION ALL SELECT 'log_cypher_pre284',  COUNT(*) FROM log_cypher_pre284;

SELECT '=== 4. date span + id ranges (backfill cursor bounds) ===' AS section;
SELECT MIN(requestTime) AS first_request, MAX(requestTime) AS last_request FROM log_request;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, COUNT(*) AS n FROM log_request_pre284;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, COUNT(*) AS n FROM log_cypher_pre284;

SELECT '=== 5. SIZE + HEADROOM - an ALGORITHM=COPY needs free space > the table itself ===' AS section;
SELECT table_name,
       ROUND(data_length/1073741824,2)                AS data_gb,
       ROUND(index_length/1073741824,2)               AS idx_gb,
       ROUND((data_length+index_length)/1073741824,2) AS total_gb,
       table_rows                                     AS approx_rows
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY data_length+index_length DESC;
SELECT @@datadir AS datadir;   -- then on the host:  df -h <datadir>

SELECT '=== 6. THE DECISIVE CHECK - what DDL will 2.9.7 attempt at boot? ===' AS section;
-- queryParameters must already be LONGTEXT. varchar(350) => ALGORITHM=COPY => boot stall.
-- status / apiKeyHash / aggregatedAt missing => cheap INSTANT adds (fine).
-- IDX_* missing => must be created BY HAND (runbook §4b), never by hbm2ddl at boot.
SHOW CREATE TABLE log_request\G
SHOW CREATE TABLE log_cypher\G

SELECT '=== 6b. same, as a flat verdict ===' AS section;
SELECT column_name, column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'log_request'
  AND column_name IN ('queryParameters','status','apiKeyHash','aggregatedAt');
SELECT index_name, column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name IN ('log_request','log_cypher')
  AND index_name LIKE 'IDX_%' ORDER BY table_name, index_name;

SELECT '=== 7. do the new tables already exist? (expect NONE before deploy) ===' AS section;
SELECT table_name FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND (table_name LIKE 'agg\_%' OR table_name = 'log_aggregation_state');

SELECT '=== 8. timezone reality (config deliberately does NOT force UTC) ===' AS section;
SELECT @@session.time_zone AS session_tz, @@global.time_zone AS global_tz;
SELECT id, requestTime FROM log_request ORDER BY id DESC LIMIT 5;
