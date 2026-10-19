# Runbook — the app-log queue is growing

**Symptom:** the monitoring **Queue Counts** page shows *App Log* climbing and not coming back down.
An unchecked backlog can exhaust Redis capacity and affect search permissions and caching.

Written after the 2026-09-08→14 incident (`worklog/2026-09-14-app-log-queue-incident.md`). Companion
analysis: `LOG-PIPELINE-CAPACITY.md`.

---

<a id="0--the-one-thing-to-understand-first"></a>

## 0 · Measure Arrival and Drain Rates

During the September 8–14 incident the consumer drained about 6 rows/s against normal traffic of
about 0.76/s. Measure current arrival and drain rates first. Look for a producer surge, a blocked
consumer or dependency failure before changing tuning; the commands below distinguish these cases.

---

## 1 · Triage in Four Commands

Run these on the app host. Sample counts at least 60 seconds apart.

> Monitor's **Queue Counts** page shows pending, processing and dead-letter depths. Use the shell
> for database progress, message payloads, or when Monitor is unavailable.

```bash
# a. Is the queue growing, and how fast?
redis-cli LLEN CEDAR-QUEUE-app-log; sleep 60; redis-cli LLEN CEDAR-QUEUE-app-log

# b. Is the consumer alive and writing? (run twice, 60s apart; max_id must climb)
mysql -h "$CEDAR_LOG_MYSQL_HOST" -u "$CEDAR_LOG_MYSQL_USER" -p "$CEDAR_LOG_MYSQL_DB" -e "
  SELECT MAX(id) AS max_id, MAX(requestTime) AS newest,
         TIMESTAMPDIFF(SECOND, MAX(requestTime), UTC_TIMESTAMP()) AS lag_seconds
  FROM ${CEDAR_LOG_MYSQL_DB}.log_request;"

# c. Is permission work in flight?
redis-cli LLEN CEDAR-QUEUE-search-permission
redis-cli LLEN CEDAR-QUEUE-search-permission-processing
redis-cli LRANGE CEDAR-QUEUE-search-permission-processing 0 -1

# d. What is actually being queued right now?
redis-cli LRANGE CEDAR-QUEUE-app-log -3 -1
```

**Reading them:**

| observation | meaning |
|---|---|
| (b) `max_id` not moving while request messages are pending | consumer or dependency may be blocked — see §4 |
| (b) `max_id` climbing, queue still growing | arrivals exceed the drain rate — identify the producer and measure both rates |
| (c) processing is nonzero with old `createdAt` values | permission work is pending or in flight; inspect worker logs and the deployed version, §2 |
| (c) pending count static while processing is nonzero | not evidence that the consumer is idle |
| (d) messages are `SERVER_ARTIFACT` / `template-instances` | something is walking the artifact tree |
| (d) `userId` = CEDAR Admin, `authSource` = apiKey | internal machinery **or** a script using the admin key — both look identical |

> `globalRequestIdSource: "new"` does **not** prove an external client. Background jobs have no
> inbound request to propagate from, so they also generate fresh IDs.

---

<a id="2--most-likely-cause-an-unbounded-permission-cascade"></a>

## 2 · Permission Cascades

This was the cause of the September 2026 incident on the older worker. Group/folder events walked
every reachable resource and fetched each artifact again. One `GROUP_MEMBERS_UPDATED` for
**"CEDAR Dev Team"** had been in flight for **~48.5 hours**, with nine events queued behind it.

Current workers batch permission events and update graph-derived search fields without fetching
existing artifact content; missing index documents still require a full rebuild. Check the deployed
binary before applying the old diagnosis. See the current
[queue protocol and permission projection](BACKEND-RUNBOOK.md#the-redis-queues-and-where-failed-permission-events-go).

The message records when the event was created, not when handling began:

```json
{"id":"...groups/295c93d3-...","eventType":"GROUP_MEMBERS_UPDATED",
 "createdAt":"2026-09-12T11:16:25-07:00"}
```

Identify the group and its reachable resources before deciding whether to interrupt the work:

```bash
curl -s -H "Authorization: apiKey $CEDAR_ADMIN_USER_API_KEY" \
  "https://group.${CEDAR_HOST}/groups/<url-encoded group id>" | python3 -m json.tool
```

### Stopping One

**Order matters.** The worker holds the in-flight message, and `recoverInFlightMessages()` restores
it from `-processing` on restart — so you must stop the worker and clear **both** keys.

```bash
cedarcli native stop microservice worker
cedarcli native status                        # confirm worker down

# capture first: this is the record of which permission changes were dropped
redis-cli LRANGE CEDAR-QUEUE-search-permission 0 -1  > ~/dropped-search-permission-$(date +%F).json
redis-cli LRANGE CEDAR-QUEUE-search-permission-processing 0 -1 >> ~/dropped-search-permission-$(date +%F).json

redis-cli DEL CEDAR-QUEUE-search-permission
redis-cli DEL CEDAR-QUEUE-search-permission-processing

cedarcli native start microservice worker
```

**Cost:** those permission changes never reach the search index. Search permissions go stale for
whatever the groups touched — people may see resources they should not, or miss ones they should.
**Schedule a full `REGENERATE_SEARCH_INDEX`** to repair it. Get agreement before dropping; this is a
correctness trade, not a cleanup.

---

## 3 · Draining the Backlog

The incident's net drain rate was roughly 5/s — **about 60 hours per million messages**.
Estimate current drain time from measured arrival and consumption rates.

If the captured messages confirm a cascade-generated backlog and discarding those log records is
approved, purge it **while the worker is stopped**:

```bash
redis-cli LLEN CEDAR-QUEUE-app-log      # record the number first
redis-cli DEL CEDAR-QUEUE-app-log
redis-cli DEL CEDAR-QUEUE-app-log-processing
```

Then verify the fix held:

```bash
redis-cli LLEN CEDAR-QUEUE-app-log; sleep 60; redis-cli LLEN CEDAR-QUEUE-app-log
```

Verify that the backlog drains and stays bounded under normal traffic.

---

## 4 · If the Consumer Really Is Dead

If request messages are pending but `max_id` does not move, inspect the consumer and its dependencies.
A retrying consumer can remain alive without making progress.

```bash
grep -n 'log queue consumer failed' $CEDAR_HOME/log/cedar-worker-server/dropwizard*.log | tail -5
```

That line appears **only on the first failure**; later ones are collapsed to a count, so search the
whole file, not the tail — and every file, not just the current one: the appender rotates daily
(`dropwizard-%d.log`, five archives kept). Its absence means the consumer has not thrown.

`AppLoggerQueueProcessor` logs nothing per message in normal operation, so **silence proves nothing
either way.** Use `max_id` as the liveness signal, not the log.

---

## 4B · Dead-Lettered Log Messages

Read the depths on Monitor's **Queue Counts** page, or use these shell checks:

```bash
curl -s http://127.0.0.1:9111/healthcheck | python3 -m json.tool | grep -A3 queue-dead-letter

for q in app-log search-permission cloneInstances valuerecommender ncbi-submission; do
  printf '%-30s ' "$q"; redis-cli LLEN "CEDAR-QUEUE-$q-dead-letter"
done
```

A message lands there after `handleWithRetries` fails **3 times** (`MAX_HANDLING_ATTEMPTS`, 1 s
apart). The payload is parked rather than lost, and the depth is the alarm.

`queue-consumers` fails when a consumer stops or fails. `queue-dead-letter` reports parked-message
depths without failing readiness. Inspect nonzero depths even when the worker is healthy; nothing
automatically retries those messages. Before 2026-09-15, a parked message also failed readiness and
could exhaust the native launcher's 240-second wait.

Read representative messages and the corresponding exceptions before deciding whether to clear:

```bash
redis-cli LRANGE CEDAR-QUEUE-app-log-dead-letter 0 2
```

Clearing needs **no restart** — the check reads the depth live:

```bash
redis-cli LRANGE CEDAR-QUEUE-app-log-dead-letter 0 -1 > ~/app-log-dead-letter-$(date +%F).json
redis-cli DEL CEDAR-QUEUE-app-log-dead-letter
```

<a id="why-messages-dead-letter-and-it-is-not-the-message"></a>

### Dependency Outages and Dead Letters

In the 2026-09-15 investigation, production's 54 and staging's 26 parked messages were
`cypherQuery` events with `findUserByApiKey` or `getResourceMaterializedPermission` and null request
IDs. Dependency failures, rather than that payload shape, caused the production dead letters.

Prod's `$CEDAR_HOME/log/cedar-worker-server/dropwizard-2026-09-14.log`, exception by minute:

```
26  2026-09-12 12:35  MISCONF                    <- Redis refusing writes
44  2026-09-12 14:48  MISCONF
26  2026-09-13 17:18  MISCONF
12  2026-09-14 18:15  java.net.ConnectException  <- MySQL unreachable
 6  2026-09-14 18:52  java.net.ConnectException
 9  2026-09-14 18:53  java.net.ConnectException
 7  2026-09-14 18:54  java.net.ConnectException
20  2026-09-14 18:55  java.net.ConnectException
```

The 54 connection failures matched the 54 parked messages while the log DB was resized and
restarted. Three attempts one second apart could not span that outage. Payloads created at 17:21:59
were consumed after 18:15; their null request IDs came from background permission work.

Correlate dead letters with dependency outages before blaming a message shape. Preserve the
messages and confirm the dependency has recovered before choosing replay or approved disposal.

### MISCONF: Redis Refusing Writes Duplicates Log Rows

The incident also recorded 96 MISCONF failures during three backlog surges:

```
MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on
disk. Commands that may modify the data set are disabled
```

Redis could not write its snapshot, so it refused every write command. `handleWithRetries` writes the
row to MySQL **first** and then calls `acknowledge()`, so with Redis refusing writes the row lands in
the database and the acknowledge fails — the message is retried and **written again**, up to three
times. Dead-lettering then also fails, so it stays in the processing list and is replayed on the next
restart.

A MISCONF window can duplicate log rows. `log_cypher` grew from 5.2M to 17.0M during the incident;
the measurements do not separate producer traffic from retry duplicates.

Suspected cause: a Redis holding millions of queued messages cannot fork and snapshot on a host with
limited free disk. That makes it a consequence of the flood as well as a contributor to it. Check the
Redis host's disk and the Redis log's RDB errors; `stop-writes-on-bgsave-error` is what turns a failed
snapshot into refused writes.

### Reading the Reason

`AppLoggerQueueProcessor.deadLetter` writes the exception at ERROR, as does
`QueueServiceWithBlockingQueue.deadLetter` on a failed move. Both have been there since `946802c`
(2026-08-25, in every release from 2.9.3). **The appender rotates daily and keeps five archives**, so
yesterday's errors are in `dropwizard-%d.log`, not `dropwizard.log`, and expire after five more days.

```bash
grep -h -A60 -E 'dead-letter|unprocessable' "$CEDAR_HOME"/log/cedar-worker-server/dropwizard*.log \
  > ~/dl-$(hostname -s).txt

# which dependency, and when
awk '/^ERROR \[/{ts=substr($0,8,16)}
     match($0,/java\.net\.ConnectException|CJCommunicationsException|MISCONF/){
       print ts, substr($0,RSTART,RLENGTH)}' ~/dl-$(hostname -s).txt | sort | uniq -c
```

`$CEDAR_HOME` is **not set** in a non-interactive `ssh host '<cmd>'` shell — wrap it in `bash -lc`, or
use the literal path (`/srv/cedar` on prod).

Investigate any renewed growth after recovery.

---

<a id="5--dead-ends--measured-2026-09-14-do-not-re-try"></a>

## 5 · Incident Measurements (2026-09-14)

| hypothesis | result |
|---|---|
| nginx rate limits / external abuse | nginx saw 36,452/day against ~357,798 DB rows — **~10:1**. The traffic never touches nginx; it is internal or direct-to-port. |
| `innodb_buffer_pool_size` (was 128 MB vs a 76 GB DB) | raised to 2 GB: **+26%**. Worth keeping, not a fix. |
| `innodb_flush_log_at_trx_commit` 1 → 2 | **+20%**. Not a fix. |
| `acknowledge()`'s O(N) `LREM` | `-processing` was 1. Not the problem. |
| silent 1 s `Thread.sleep` in `handleWithRetries` | 0 of 30 thread samples. Not firing. |
| network latency | ICMP 1.07 ms. Innocent as raw RTT. |
| valuerecommender rule generation | fails instantly on a dead OpenSearch client; 246 requests total. |
| the log-table indexes added 2026-09-10 | ~20%. Real, marginal. |

In that incident, database connections were sleeping, app-host I/O wait was zero, and the worker
used about 28% of one core. Tuning improved throughput by roughly 50% without clearing the overload.
Use these measurements to avoid repeating the same investigation unless current evidence differs.

---

<a id="6--escalation-facts-worth-having-to-hand"></a>

## 6 · Historical Host Capacity and Access

These host measurements are from the incident; recheck capacity and access before acting.

- **Redis has no `maxmemory`** (`maxmemory_policy: noeviction`). It grows until the host runs out —
  roughly 1.1 KB per message, ~37 GB available, so ~32M messages. There is no hard cliff at a
  specific count; degradation comes first.
- **`cedr-prd-db-01` is small:** 3.8 GB RAM, 2 vCPU. `50-server.cnf:101` carries a commented-out
  `innodb_buffer_pool_size = 8G` templated from a larger host — **2G is the correct value here.**
  `SET GLOBAL` does not survive a restart; persist it.
- **Disk on that host is 85% full**, 19 GB free of 120 GB.
- **`SELECT 1` costs 7.25 ms** against a 1.07 ms ICMP RTT between app and DB hosts — 7x
  the ICMP latency. This alone identifies neither the cause nor an achievable throughput gain.
- SSH to `cedr-prd-db-01` is blocked from both app and staging hosts; server-level MariaDB changes
  need Alex or root on that box. `cedar_log_usr` has schema-scoped grants only.
