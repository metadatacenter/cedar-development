# Runbook — the app-log queue is growing

**Symptom:** the monitoring **Queue Counts** page shows *App Log* climbing and not coming back down.
An unchecked backlog can exhaust Redis capacity and affect search permissions and caching.

Historical capacity measurements are in [LOG-PIPELINE-CAPACITY.md](LOG-PIPELINE-CAPACITY.md).
The current queue protocol and replay guarantees are in the
[backend runbook](BACKEND-RUNBOOK.md#the-redis-queues-and-where-failed-permission-events-go).

---

<a id="0--the-one-thing-to-understand-first"></a>

## 0 · Measure Arrival and Drain Rates

Measure current arrival and drain rates first. Look for a producer surge, a blocked
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

Current workers batch permission events and update graph-derived search fields without fetching
existing artifact content; missing index documents still require a full rebuild. Older workers
fetched every reachable artifact during a cascade and could flood the log queue. Check the deployed
binary before applying that diagnosis. See the current
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

Estimate drain time as `backlog / (consumption rate - arrival rate)`. If consumption does not
exceed arrivals, the queue cannot drain under the measured load.

If the captured messages confirm a cascade-generated backlog and discarding those log records is
approved, purge it **while the worker is stopped**:

```bash
redis-cli LLEN CEDAR-QUEUE-app-log      # record the number first
redis-cli DEL CEDAR-QUEUE-app-log
redis-cli DEL CEDAR-QUEUE-app-log-processing
```

Then verify the fix held:

```bash
cedarcli native start microservice worker
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
(`dropwizard-%d.log`, five archives kept). An absent error may have rotated out; it does not prove
the consumer is making progress.

`AppLoggerQueueProcessor` logs nothing per message in normal operation, so **silence proves nothing
either way.** Use `max_id` as the liveness signal, not the log.

---

## 4B · Dead-Lettered Log Messages

Read the depths on Monitor's **Queue Counts** page, or use these shell checks:

```bash
curl -s http://127.0.0.1:9111/healthcheck | python3 -m json.tool | grep -A3 queue-dead-letter

for q in app-log search-permission cloneInstances; do
  printf '%-30s ' "$q"; redis-cli LLEN "CEDAR-QUEUE-$q-dead-letter"
done
```

A retryable message lands there after `handleWithRetries` fails **3 times** (`MAX_HANDLING_ATTEMPTS`,
1 s apart). Malformed or explicitly non-retryable messages are parked immediately. The payload is
parked rather than lost, and the depth is the alarm.

`queue-consumers` fails when a consumer stops or fails. `queue-dead-letter` reports parked-message
depths without failing readiness. Inspect nonzero depths even when the worker is healthy; nothing
automatically retries those messages.

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

Correlate dead letters with Redis persistence errors and log-MySQL connection failures before
blaming a message shape. Three attempts one second apart cannot span a database outage. A null
request ID on a background Cypher event does not by itself make that event invalid. Preserve the
messages and confirm the dependency has recovered before choosing replay or approved disposal.

<a id="misconf-redis-refusing-writes-duplicates-log-rows"></a>

### MISCONF: Redis Refusing Writes

```
MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on
disk. Commands that may modify the data set are disabled
```

Check the Redis host's free disk, memory and RDB errors. `stop-writes-on-bgsave-error` turns a failed
snapshot into refused writes, including acknowledgements and moves to the dead-letter list. A
message can therefore remain in processing and be recovered on restart even after MySQL committed.

Current workers commit a `log_event_receipt` with the database mutation, so replay skips a request
phase or Cypher execution already recorded. Keep that ledger when pruning raw logs. Older workers
without receipts could duplicate rows after an acknowledgement failure; pre-upgrade writes have no
receipt proving whether they ran. Verify the deployed worker and ledger before relying on replay
safety. Migration, rollback limits and incomplete-request handling are documented under
[application-log persistence](BACKEND-RUNBOOK.md#application-log-persistence-and-rollout).

### Reading the Reason

`AppLoggerQueueProcessor.deadLetter` writes the exception at ERROR, as does
`QueueServiceWithBlockingQueue.deadLetter` on a failed move. **The appender rotates daily and keeps five archives**, so
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

The September incident's throughput, tuning experiments and database sizes are retained in
[LOG-PIPELINE-CAPACITY.md](LOG-PIPELINE-CAPACITY.md). They describe the older consumer and host,
not a current capacity limit or a prescribed MySQL setting.

---

<a id="6--escalation-facts-worth-having-to-hand"></a>
<a id="6--historical-host-capacity-and-access"></a>

## 6 · Check Host Capacity and Access

Recheck Redis's memory limit and eviction policy, persistence status and host disk space. Measure
MySQL memory, buffer-pool size, disk headroom and connection latency on the actual log host before
changing tuning. Do not copy the incident's 2 GB buffer-pool setting onto a different host.

Confirm the approved SSH route and database grants with the operator. Schema-scoped log credentials
do not authorize server-level configuration changes. Persist approved runtime tuning in the host's
managed configuration so it survives a restart.
