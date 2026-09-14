# Runbook — the app-log queue is growing

**Symptom:** the monitoring **Queue Counts** page shows *App Log* climbing and not coming back down.
Left alone it reaches millions of messages and degrades Redis, which also serves search permissions
and caching — so the blast radius is wider than logging.

Written after the 2026-09-08→14 incident (`worklog/2026-09-14-app-log-queue-incident.md`). Companion
analysis: `LOG-PIPELINE-CAPACITY.md`.

---

## 0 · The one thing to understand first

**The consumer drains at ~6 rows/s and always has.** It cannot be tuned into keeping up. So queue
growth always means *something upstream is producing more than 6/s*, and the fix is always to find
and stop that thing — never to speed up the consumer in the moment.

Historical baseline traffic is ~0.76/s, so there is normally ~8x headroom and nothing is visible.

---

## 1 · Triage in four commands

Run these on the app host (`cedr-prd-app-05`). They take under a minute and they split every case.

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

## 2 · Most likely cause: an unbounded permission cascade

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

### Stopping one

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

## 3 · Draining the backlog

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

## 4 · If the consumer really is dead

`max_id` not moving at all. The consumer catches every exception and retries every 10 s forever, so
it does not exit — it spins.

```bash
grep -n 'log queue consumer failed' $CEDAR_HOME/log/cedar-worker-server/dropwizard.log | tail -5
```

That line appears **only on the first failure**; later ones are collapsed to a count, so search the
whole file, not the tail. Its absence means the consumer has not thrown.

`AppLoggerQueueProcessor` logs nothing per message in normal operation, so **silence proves nothing
either way.** Use `max_id` as the liveness signal, not the log.

---

## 5 · Dead ends — measured 2026-09-14, do not re-try

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

## 6 · Escalation facts worth having to hand

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
