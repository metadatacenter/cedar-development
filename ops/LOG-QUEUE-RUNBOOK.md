# Runbook — the app-log queue is growing

**Symptom:** the monitoring **Queue Counts** page shows *App Log* climbing and not coming back down.
Left alone it reaches millions of messages and degrades Redis, which also serves search permissions
and caching — so the blast radius is wider than logging.

Written after the 2026-09-08→14 incident (`worklog/2026-09-14-app-log-queue-incident.md`). Companion
analysis: `LOG-PIPELINE-CAPACITY.md`.

---

## 0 · The One Thing to Understand First

**The consumer drains at ~6 rows/s and always has.** It cannot be tuned into keeping up. So queue
growth always means *something upstream is producing more than 6/s*, and the fix is always to find
and stop that thing — never to speed up the consumer in the moment.

Historical baseline traffic is ~0.76/s, so there is normally ~8x headroom and nothing is visible.

---

## 1 · Triage in Four Commands

Run these on the app host (`cedr-prd-app-05`). They take under a minute and they split every case.

> The Monitor's **Queue Counts** page now shows pending, processing and dead-letter depths for every
> queue, so (a), (c)'s two counts and §4b's depths are readable without an SSH session. Come here for
> (b), for the in-flight message's own payload, and whenever the Monitor is itself unavailable.

```bash
# a. Is the queue growing, and how fast?
redis-cli LLEN CEDAR-QUEUE-app-log; sleep 60; redis-cli LLEN CEDAR-QUEUE-app-log

# b. Is the consumer alive and writing? (run twice, 60s apart; max_id must climb)
mysql -h "$CEDAR_LOG_MYSQL_HOST" -u "$CEDAR_LOG_MYSQL_USER" -p "$CEDAR_LOG_MYSQL_DB" -e "
  SELECT MAX(id) AS max_id, MAX(requestTime) AS newest,
         TIMESTAMPDIFF(SECOND, MAX(requestTime), UTC_TIMESTAMP()) AS lag_seconds
  FROM ${CEDAR_LOG_MYSQL_DB}.log_request;"

# c. IS A PERMISSION CASCADE RUNNING?  <-- check this early, it is the most likely cause
redis-cli LLEN CEDAR-QUEUE-search-permission
redis-cli LLEN CEDAR-QUEUE-search-permission-processing
redis-cli LRANGE CEDAR-QUEUE-search-permission-processing 0 -1

# d. What is actually being queued right now?
redis-cli LRANGE CEDAR-QUEUE-app-log -3 -1
```

**Reading them:**

| observation | meaning |
|---|---|
| (b) `max_id` not moving | consumer is dead — see §4 |
| (b) `max_id` climbing ~6/s, queue still growing | normal consumer, excess inbound — find the source |
| (c) `-processing` = **1** with an old `createdAt` | **a permission cascade is grinding — most likely cause, §2** |
| (c) pending count static for hours *and* `-processing` = 1 | same thing; a static pending count does **not** mean idle |
| (d) messages are `SERVER_ARTIFACT` / `template-instances` | something is walking the artifact tree |
| (d) `userId` = CEDAR Admin, `authSource` = apiKey | internal machinery **or** a script using the admin key — both look identical |

> `globalRequestIdSource: "new"` does **not** prove an external client. Background jobs have no
> inbound request to propagate from, so they also generate fresh IDs.

---

## 2 · Most Likely Cause: An Unbounded Permission Cascade

`GROUP_MEMBERS_UPDATED`, `GROUP_DELETED` and `FOLDER_PERMISSION_CHANGED` each enqueue a ~200-byte
pointer, but the work is derived: the consumer walks **every resource that group or folder can
reach** and reindexes its permissions, fetching each one from the artifact server.

There is **no batching, no time limit, no progress reporting, and no way to tell whether one is
advancing or wedged.**

On 2026-09-14 a single `GROUP_MEMBERS_UPDATED` on the 2016-era **"CEDAR Dev Team"** group had been
in flight for **~48.5 hours** without finishing, with nine more queued behind it.

The message tells you when it started:

```json
{"id":"...groups/295c93d3-...","eventType":"GROUP_MEMBERS_UPDATED",
 "createdAt":"2026-09-12T11:16:25-07:00"}
```

Identify the group before deciding anything — its reach is the difference between "will finish" and
"never will":

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

Once inbound stops, the backlog clears at roughly 5/s net — **about 60 hours per million messages.**

If the backlog is mostly a cascade's own artifact fetches (it usually is, and it has no analytical
value), purge it instead, **while the worker is stopped**:

```bash
redis-cli LLEN CEDAR-QUEUE-app-log      # record the number first
redis-cli DEL CEDAR-QUEUE-app-log
redis-cli DEL CEDAR-QUEUE-app-log-processing
```

Then verify the fix held:

```bash
redis-cli LLEN CEDAR-QUEUE-app-log; sleep 60; redis-cli LLEN CEDAR-QUEUE-app-log
```

**A flat single- or double-digit number is what success looks like.**

---

## 4 · If the Consumer Really Is Dead

`max_id` not moving at all. The consumer catches every exception and retries every 10 s forever, so
it does not exit — it spins.

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

**Start on the Monitor's Queue Counts page.** It reports three depths per queue — pending,
processing and dead-letter — so the whole of this section's triage is readable without shelling into
the app host. The `redis-cli` equivalents below still work and are what to use when the Monitor is
the thing that is down.

```bash
curl -s http://127.0.0.1:9111/healthcheck | python3 -m json.tool | grep -A3 queue-dead-letter

for q in app-log search-permission cloneInstances valuerecommender ncbi-submission; do
  printf '%-30s ' "$q"; redis-cli LLEN "CEDAR-QUEUE-$q-dead-letter"
done
```

A message lands there after `handleWithRetries` fails **3 times** (`MAX_HANDLING_ATTEMPTS`, 1 s
apart). The payload is parked rather than lost, and the depth is the alarm.

> **Changed 2026-09-15: a parked message no longer makes the worker UNHEALTHY.** It used to —
> `queue-consumers` failed on any non-empty dead-letter queue, which 500'd the admin endpoint, and
> `cedar-services.sh` derives readiness from that endpoint and accepts only 200. So one parked
> message made **every** `cedarcli native start microservices` wait out its full 240 s budget on a
> worker that was listening and serving, then report the start as failed. Prod's 54 did exactly that
> on 2026-09-15.
>
> The check is now split: **`queue-consumers`** still fails when a consumer has stopped or is failing,
> and **`queue-dead-letter`** reports depths and stays healthy. A parked message is a backlog to look
> at, not a server that cannot serve. **It still needs looking at** — the depth is on the health
> message and on Queue Counts, and it is nobody's alarm if nobody reads either.

**Read one before clearing** — they are usually all the same shape, and the shape is the diagnosis:

```bash
redis-cli LRANGE CEDAR-QUEUE-app-log-dead-letter 0 2
```

Clearing needs **no restart** — the check reads the depth live:

```bash
redis-cli LRANGE CEDAR-QUEUE-app-log-dead-letter 0 -1 > ~/app-log-dead-letter-$(date +%F).json
redis-cli DEL CEDAR-QUEUE-app-log-dead-letter
```

### Why Messages Dead-Letter, and It Is Not the Message

**Settled 2026-09-15 from prod's own logs.** The payload is not the cause. Both prod's 54 and
staging's 26 shared a shape — `type: cypherQuery`, `methodName: findUserByApiKey` or
`getResourceMaterializedPermission`, **both request IDs null** — and that shape reads as systematic.
It is not. It is what happens to be in flight when a dependency goes away.

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

**The 54 ConnectExceptions are the 54 parked messages, exactly.** The log DB was unreachable on the
evening of 2026-09-14 while `cedr-prd-db-01` was resized and restarted. Three attempts a second apart
is a ~3-second budget against a restart that takes minutes, so everything consumed in that window
parked.

The null request IDs are a consequence of the backlog, not of the message type. The payloads are
stamped 17:21:59 and were not consumed until 18:15 — an hour behind, which is what a 6/s consumer
with a backlog looks like. At 17:21 the only producer was the permission cascade, and background work
has no HTTP request to take an ID from. Whatever had been running would have parked.

**So: a dead-letter depth after a database or Redis outage is expected and needs no investigation
beyond confirming the window.** Capture, read one, clear.

### MISCONF: Redis Refusing Writes Duplicates Log Rows

The 96 MISCONF failures are a different and worse problem, and all three fall on flood days:

```
MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on
disk. Commands that may modify the data set are disabled
```

Redis could not write its snapshot, so it refused every write command. `handleWithRetries` writes the
row to MySQL **first** and then calls `acknowledge()`, so with Redis refusing writes the row lands in
the database and the acknowledge fails — the message is retried and **written again**, up to three
times. Dead-lettering then also fails, so it stays in the processing list and is replayed on the next
restart.

**A MISCONF window therefore multiplies log rows rather than losing them.** `log_cypher` went 5.2M to
17.0M across exactly these days. Some of that is the flood; some of it is this.

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

If the depth climbs back after clearing with no outage to explain it, then it is worth investigating.

---

## 5 · Dead Ends — Measured 2026-09-14, Do Not Re-Try

| hypothesis | result |
|---|---|
| nginx rate limits / external abuse | nginx saw 36,452/day against ~357,798 DB rows — **~30:1**. The traffic never touches nginx; it is internal or direct-to-port. |
| `innodb_buffer_pool_size` (was 128 MB vs a 76 GB DB) | raised to 2 GB: **+26%**. Worth keeping, not a fix. |
| `innodb_flush_log_at_trx_commit` 1 → 2 | **+20%**. Not a fix. |
| `acknowledge()`'s O(N) `LREM` | `-processing` was 1. Not the problem. |
| silent 1 s `Thread.sleep` in `handleWithRetries` | 0 of 30 thread samples. Not firing. |
| network latency | ICMP 1.07 ms. Innocent as raw RTT. |
| valuerecommender rule generation | fails instantly on a dead OpenSearch client; 246 requests total. |
| the log-table indexes added 2026-09-10 | ~20%. Real, marginal. |

**The database is not the constraint.** Its connections sit `Sleep`, the app host shows `0.0 wa`, and
the worker uses ~28% of one core. Tuning moved the ceiling ~50% cumulatively and changed nothing that
mattered.

---

## 6 · Escalation Facts Worth Having to Hand

- **Redis has no `maxmemory`** (`maxmemory_policy: noeviction`). It grows until the host runs out —
  roughly 1.1 KB per message, ~37 GB available, so ~32M messages. There is no hard cliff at a
  specific count; degradation comes first.
- **`cedr-prd-db-01` is small:** 3.8 GB RAM, 2 vCPU. `50-server.cnf:101` carries a commented-out
  `innodb_buffer_pool_size = 8G` templated from a larger host — **2G is the correct value here.**
  `SET GLOBAL` does not survive a restart; persist it.
- **Disk on that host is 85% full**, 19 GB free of 120 GB.
- **`SELECT 1` costs 7.25 ms** against a 1.07 ms ICMP RTT between app and DB hosts — 7x
  amplification, possibly stateful firewall inspection. Fixing it would be a ~7x win on this path.
- SSH to `cedr-prd-db-01` is blocked from both app and staging hosts; server-level MariaDB changes
  need Alex or root on that box. `cedar_log_usr` has schema-scoped grants only.
