-- Read-only profile of what the graph is actually being asked, while a search
-- reindex is running. Answers three questions in order:
--   1. is the reindex's Cypher reaching this table at all?
--   2. which query shapes dominate, and at what cost?
--   3. how much of it is the identical query with the identical arguments?
--
-- The window is anchored to MAX(logTime) rather than NOW() on purpose: logTime is
-- written from an Instant and the session timezone shifts it, so comparing the
-- table against itself is the only self-consistent clock here.
--
-- duration is stored in NANOSECONDS.

-- 0. Is anything arriving, and from which service?
SELECT systemComponentName,
       COUNT(*)                      AS rows_10min,
       ROUND(COUNT(*) / 600, 1)      AS per_sec,
       MIN(logTime)                  AS first_seen,
       MAX(logTime)                  AS last_seen
FROM log_cypher
WHERE logTime > (SELECT MAX(logTime) FROM log_cypher) - INTERVAL 10 MINUTE
GROUP BY systemComponentName
ORDER BY rows_10min DESC;

-- 1. Which query shapes dominate, by total time spent.
SELECT systemComponentName,
       className,
       methodName,
       runnableHash,
       COUNT(*)                            AS calls,
       ROUND(SUM(duration) / 1e9, 1)       AS total_sec,
       ROUND(AVG(duration) / 1e6, 2)       AS avg_ms,
       ROUND(MAX(duration) / 1e6, 2)       AS max_ms
FROM log_cypher
WHERE logTime > (SELECT MAX(logTime) FROM log_cypher) - INTERVAL 10 MINUTE
GROUP BY systemComponentName, className, methodName, runnableHash
ORDER BY total_sec DESC
LIMIT 15;

-- 2. Redundancy: same query text AND same parameters, more than once.
--    A high count here is work that a cache would have removed outright.
SELECT runnableHash,
       parametersHash,
       COUNT(*)                        AS repeats,
       ROUND(SUM(duration) / 1e9, 1)   AS wasted_sec_if_cached
FROM log_cypher
WHERE logTime > (SELECT MAX(logTime) FROM log_cypher) - INTERVAL 10 MINUTE
GROUP BY runnableHash, parametersHash
HAVING repeats > 1
ORDER BY repeats DESC
LIMIT 15;
