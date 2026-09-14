# The CEDAR logging pipeline — how it works, what it costs, what to fix

Reference companion to `LOG-QUEUE-RUNBOOK.md` (what to do when it backs up) and
`worklog/2026-09-14-app-log-queue-incident.md` (the incident that produced these numbers).

Every figure below was measured on production on **2026-09-14**.

---

## 1 · The path a log row takes

```
CEDAR service handles a request
  └─ enqueueEvent()  → Redis RPUSH → CEDAR-QUEUE-app-log        (best-effort; dropped if Redis is down)
                                        │
        cedar-worker-server ────────────┘
          AppLoggerQueueProcessor        single thread, one message at a time
            ├─ moveHeadToTail()          claim into CEDAR-QUEUE-app-log-processing
            ├─ handleLog()  @UnitOfWork  one Hibernate session + transaction PER MESSAGE
            │                            → cedar_log_production on cedr-prd-db-01
            └─ acknowledge()             LREM from the processing list
```

Two properties follow from this shape and explain everything else:

- **Writes are asynchronous.** No CEDAR request path reads this database synchronously, so log-DB
  work never takes CEDAR down at runtime. (It *can* block **boot** — see
  `PROD-LOG-AGGREGATION-ROLLOUT.md` §3a.)
- **The consumer is serial.** One message, one transaction, one round-trip set. Nothing is batched.

---

## 2 · One request is four queue messages

All four share a `globalRequestId`:

| # | type | what it does in the DB |
|---|---|---|
| 1 | `requestFilter` / `start` | **INSERT** a new `log_request` row |
| 2 | `cypherQuery` | **INSERT** into `log_cypher` — this is the `findUserByApiKey` lookup, i.e. API-key authentication logged as a Cypher query |
| 3 | `requestHandler` / `start` | `findByLocalRequestId` **SELECT**, then UPDATE |
| 4 | `requestFilter` / `end` | `findByLocalRequestId` **SELECT**, then UPDATE |

**So ~75 requests/second becomes ~300 messages/second**, and two thirds of the messages do a SELECT
before their UPDATE.

Message 2 is worth dwelling on: **every API-key-authenticated request writes a Cypher log row purely
for authentication.** `AppLoggerQueueService.enqueueEvent` still carries the filter that would
exclude it, commented out, with the original author's note:

```java
// We are disabling Cypher logging because of the large volume of logs generated - and the fact that
// this type of specialized logging is not required on an ongoing basis.
// if (message.getType() != AppLogType.CYPHER_QUERY)
```

It shows in the table sizes: `log_cypher` holds **5.2M** rows against `log_request`'s **2.9M**.

---

## 3 · Measured capacity: ~6 rows/s

| component | cost | how it was measured |
|---|---|---|
| ~4 statements (BEGIN, SELECT, INSERT/UPDATE, COMMIT) × **7.25 ms** | ~29 ms | 1000 × `SELECT 1` in one session = 7.253 s |
| Hibernate session + ByteBuddy proxy + `@UnitOfWork` | ~15 ms | worker JVM at 27.8% of one core, single-threaded |
| 2 Redis ops (local) | ~1 ms | |
| **≈ 45 ms/message → ~22 msg/s → ~7 rows/s** | | **observed 6.35** |

Thirty `jstack` samples of the consumer thread, top frame:

```
21  org.hibernate.id.insert.GetGeneratedKeysDelegate.performMutation
 8  com.mysql.cj.protocol.a.*PacketReader.readHeader / ClientPreparedStatement.executeInternal
 1  QueueServiceWithBlockingQueue.waitForMessages
 0  Thread.sleep
```

**97% of the time is spent executing or waiting on individual database statements.**

### Why batching alone will not fix it

Both log entities use `@GeneratedValue(strategy = GenerationType.IDENTITY)`. **Hibernate cannot
JDBC-batch inserts under IDENTITY** — it must execute each INSERT immediately to read back the
generated key. That is precisely the frame sampled 21 times out of 30.

Batching the consumer loop collapses the BEGIN/COMMIT round-trips, but leaves one round-trip per
row. Real insert batching requires a different ID strategy, which is a migration on existing
AUTO_INCREMENT tables.

### Why the 7.25 ms matters

ICMP RTT between `cedr-prd-app-05` and `cedr-prd-db-01` is **1.07 ms**. A MySQL-protocol statement
round-trip costs **7.25 ms** — a 7x amplification, possibly stateful firewall inspection between the
subnets (SSH between them is blocked). **Fixing that alone would be a ~7x win on this path**, with no
code change. Worth asking Alex.

### Headroom

Historical baseline traffic is **~0.76/s**, so the pipeline has run at roughly 8x headroom for years
and the ceiling was invisible. It is not a regression; it is an unexamined limit.

---

## 4 · What overwhelms it

**Anything sustained above ~6 requests/second.** Two independent real examples in one week, neither
malicious:

**A repair script.** Local scripts run against prod with the CEDAR Admin API key, walking template
instances. Made worse by an N+1 — the template was re-fetched for every instance, doubling requests.

**A group-membership change.** `GROUP_MEMBERS_UPDATED` on a 2016-era group with broad permissions.
The event is a 200-byte pointer; the work is walking every resource that group can reach and
reindexing each one, fetching it from the artifact server. One such message ran **48.5 hours without
completing**, with nine more queued behind it.

The second is the important one, because it is **ordinary administrative activity**. Someone editing
group membership in the UI can saturate the logging pipeline for days, and nothing reports that it is
happening.

---

## 5 · The defects, in priority order

1. **The permission reindex is unbounded and unobservable.** No batching, no time limit, no progress
   reporting, no way to distinguish "advancing" from "wedged". This is the top fix — the 2026-09-14
   cascade ran two days undetected precisely because nothing could say how far along it was.
2. **Cypher logging is on and was never meant to be.** Re-enable the filter in `enqueueEvent`, or make
   it configurable. It is 1 message in 4.
3. **Batch the log consumer** — claim N messages, one session, one commit.
4. **Drop the redundant SELECT.** `findByLocalRequestId` then update could be a single
   `UPDATE … WHERE localRequestId = ?`, removing a round-trip from two-thirds of messages.
5. **Move off `GenerationType.IDENTITY`** if real insert batching is wanted (see §3).
6. **`HANDLING_RETRY_DELAY_MILLIS = 1000` → ~50.** Not firing today, but a silent one-second stall per
   transient failure, with **no log line on non-final attempts**, is a landmine.
7. **Investigate the 7.25 ms statement round-trip** (§3).

### Already available, not yet used

`cedar-config-library` `cedar-main.yml` carries a **`rateLimits`** block — per-user quotas with
separate read and write budgets, `mode: observe` by default, configured through `CEDAR_RATE_LIMIT_*`.
That is the mechanism that would have capped both of §4's cases. It exists; it is not switched on.

---

## 6 · Facts about the log database

`cedar_log_production` on `cedr-prd-db-01`, **MariaDB 10.6.23** (not MySQL — `ANY_VALUE` does not
exist there, and `performance_schema` is off, so use `information_schema.PROCESSLIST.PROGRESS`).

| table | rows | data | idx | total |
|---|---|---|---|---|
| `log_cypher_pre284` | ~33.1M | 38.18 | 17.82 | **56.00 GB** |
| `log_request_pre284` | 4,159,527 | 8.85 | 2.60 | 11.45 GB |
| `log_cypher` | 5,226,673 | 3.09 | 2.49 | 5.58 GB |
| `log_request` | 2,914,145 | 1.40 | 1.86 | 3.26 GB |

**`*_pre284` is 67.5 GB — 88% of the database**, frozen since the 2026-07-28 rename, and what the
backfill → `DROP` reclaims. Never index those tables.

**Host:** 3.8 GB RAM, 2 vCPU, SSD, **disk 85% full (19 GB free of 120 GB)**. `50-server.cnf:101` has
a commented-out `innodb_buffer_pool_size = 8G` templated from a bigger machine — **2G is correct
here**, and `SET GLOBAL` does not survive a restart. A `60-galera.cnf` exists; check `wsrep_on`
before changing durability settings. `cedar_log_usr` is granted per `user@host` and is schema-scoped:
DDL on the prod log DB must be run **from `cedr-prd-app-05`**, and server-level changes need root on
the DB host, which is not reachable by SSH from either app host.

The columns hold **UTC** wall-clock despite `serverTimezone: America/Los_Angeles` — see
`PROD-LOG-AGGREGATION-ROLLOUT.md` §2, whose stated premise is wrong even though its conclusion (do
not force UTC) is right.
