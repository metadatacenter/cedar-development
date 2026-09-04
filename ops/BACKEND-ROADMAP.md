# CEDAR Backend — Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).
Frontend work for the embeddable editor is tracked separately in
[CEE-ROADMAP.md](./CEE-ROADMAP.md), and the MCP servers in
[MCP-ROADMAP.md](./MCP-ROADMAP.md).

## Next

### Features

- **1. Settle the sharing and permission model, then write it down.** This is the umbrella item: the
  pieces below are each small, and separately each looks like a quirk, but together they say the model
  was never specified in one place, so every surface decided for itself. Controlled sharing is what
  CEDAR is for, which makes this the part most worth being deliberate about. All of it is now pinned by
  tests, so the behaviour cannot drift further while the decisions are made — and each test named here
  will fail and demand attention when a decision lands.

  What was found, in the order it bites a reader:

  - **Six declared permission levels, two enforced.** `READ` and `WRITE` are checked;
    `CHANGEPERMISSIONS`, `CHANGEOWNER`, `PUBLISH` and `CREATE_DRAFT` are consulted nowhere, yet can be
    granted and stored. Detailed below.
  - **`WRITE` confers re-sharing, but not versioning.** The ACL update asks only for write access, so
    editing implies re-sharing; versioning asks for ownership, so it does not. Two different answers to
    "what does write let me do", and neither is written down.
  - **Reading an ACL costs a different permission per resource kind.** A folder's permissions need read
    access; a category's need *write*. Same operation, different bar.
  - **Categories are world-readable, folders are not.** A category is readable by any authenticated
    user holding the role, with no per-category check, because it is a shared vocabulary. Defensible,
    and the opposite of every other resource, and undocumented.
  - **A user cannot classify their own artifacts.** Attaching a category needs a grant on the category
    rather than on the artifact, and only an administrator can give it. Detailed below.
  - **Group membership confers no read.** A member cannot fetch the group or its member list, so a user
    can reach resources through a group they cannot see and cannot discover who else can reach them.
  - **Denials answer 401 or 403 depending on which code path refuses.**
  - **Authority checks live in different layers per subsystem**, so one of them is bypassable by a
    non-HTTP caller.
  - **Transferring ownership does not transfer control.** The owner field moves, but a resource inside
    the donor's own tree is still reachable by the donor, because permissions inherit from the parent
    they still own. So handing something over leaves the donor with read and write on it, and the
    recipient is unlikely to expect that. Pinned in `SharingRoundTripTest`.
  - **Ownership is the one thing a WRITE grantee cannot take**, which is the model working: the owner
    check in `validateOwnerSetPermission` holds across folders and all four artifact types. Noted here
    because it is the boundary the rest of the model leans on, and because it is the only place
    `CHANGEOWNER` would be consulted if it were consulted at all.

  **The unenforced levels.** `FilesystemResourcePermission` declares six: `READ`, `WRITE`,
  `CHANGEOWNER`, `CHANGEPERMISSIONS`, `PUBLISH`, `CREATE_DRAFT`. Outside the enum declaration and
  tests, `CHANGEPERMISSIONS` and `CHANGEOWNER` appear nowhere in the codebase — nothing ever consults
  them. Only read and write are enforced.

  The visible consequence is that **a WRITE grant confers re-sharing**, on folders and on all four
  artifact types alike. Updating an ACL is gated by
  `ResourcePermissionRequestValidator.validateWritePermission`, which asks only
  `userHasWriteAccessToResource`, so anyone granted write on a folder or artifact may rewrite who else
  can see it — adding people, and revoking the grants of others. "Share so they can edit" is in
  practice "share so they can re-share". `FolderPermissionLevelMatrixTest` and
  `ArtifactPermissionLevelMatrixTest` pin this, and demonstrate it rather than inferring it from a
  status: a user holding only WRITE rewrites the ACL and their own grant disappears.

  `PUBLISH` and `CREATE_DRAFT` are inert in a sharper way, and it is now checked rather than assumed.
  Publishing and drafting are **owner-only**: `userCanPerformVersioning` asks
  `userIsOwnerOfFilesystemResource` and nothing else. So granting `PUBLISH` cannot let the grantee
  publish, and granting `CREATE_DRAFT` cannot let them draft — the levels name operations they do not
  confer. Worse, the grant is *accepted and stored*: `ArtifactLifecycleMatrixTest` grants each level
  successfully and then gets the same `VERSIONING_ONLY_BY_OWNER` refusal that a user with no grant
  receives.

  So the model as built has three tiers — read, write, owner — wearing a six-level enum. That may be
  the intended design, and it is consistent and enforced. The problem is what the extra levels do to a
  reader and to a client: a level that can be granted, is stored, and is never consulted reads as a
  restriction while being none. Either enforce the four unused levels or remove them and document the
  three tiers, including that write implies re-sharing and that versioning is owner-only.

  **Classifying an artifact.** Attaching a category requires a grant on the *category*, not merely on
  the artifact: `ATTACH` (or `WRITE`, which implies it) must be held on the category being attached.
  The category tree is writable only by someone with write on the root, which is an administrator, so
  out of the box a normal user can read the vocabulary and attach nothing to anything — including to
  templates they own.

  This is the design working as built, and `ATTACH` is one of the few permission levels that *is*
  enforced, which is what makes it the counter-example to the four that are not. But it means the
  category picker is inert for ordinary users until an administrator grants `ATTACH` on each category,
  and nothing in the product surfaces that. Either grant `ATTACH` broadly when a category is created,
  or make the requirement visible.

  One of the original findings is already fixed rather than listed: a permissions response containing a
  group grant could not be deserialized by the shared model, because `CedarGroupExtract` had no
  no-argument constructor while `CedarUserExtract` did. That is now a one-line constructor in
  `cedar-core-library`, with the typed read in `SharingRoundTripTest` as its regression test.

  A second original finding is also fixed rather than listed: one ACL request used to execute the
  owner change, each user and group addition or removal, and the everybody permission as separate
  Neo4j transactions, so a failure could leave a partially applied ACL. Resource and category
  permission updates now collect the complete diff through `updatePermissionsAtomically` and submit
  it as one `executeWriteBatch`. `PermissionUpdateBatchTest` pins both paths to one batch containing
  every requested change.

  The deliverable is **a permissions document** — there is none today, and its absence is the root of
  everything above. It should state the tiers, what each confers, how inheritance interacts with
  ownership, what `ATTACH` is for, and which of the listed behaviours are intentional. Only then is it
  worth making the code and the enum agree with it.

  Pinned by `FolderPermissionLevelMatrixTest`, `ArtifactPermissionLevelMatrixTest`,
  `SharingRoundTripTest`, `ArtifactsAndCategoriesAuthorizationMatrixTest`,
  `GroupMembershipAuthorizationMatrixTest`, `GroupSharingRevocationIntegrationTest`,
  `ArtifactLifecycleMatrixTest` and `ops/e2e/rest/suites/categories.mjs`.

### Infrastructure

- **2. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
  build manifest, while the client libraries have moved on. The
  [Docker roadmap](./DOCKER-ROADMAP.md) owns the shared build and deployment lock; this item owns the
  remaining server upgrades. Order them by risk, lowest first. **Keycloak is still at 22**, held
  there by CEDAR's own code rather than by this lock: it runs a forward-only Liquibase schema
  migration on the existing user store, and it is the one server where CEDAR's own code, not just a
  pin, decides how far it can go. What that amounts to is set out below. Rehearse each upgrade on a
  copy of production data and gate on the end-to-end smoke.

  Containerizing the production data stores needs each image pin moved up to the version already
  running, because an older engine cannot open existing data files, so this item unblocks the
  persistence migration tracked in the Docker roadmap. MySQL is the real decision left among the
  data stores; Keycloak is its own piece of work.

  **What actually holds Keycloak at 22.** Measured 2026-08-08 against Maven Central and the code, and
  it is one thing rather than the four this item used to list. The estate runs server 22.0.5 native
  and 22.0.4 in the image, `cedar-parent` sets `keycloak.version` to 22.0.4, and the current Keycloak
  is **26.7.1**.

  - **The blocker is `keycloak-adapter-core`,** the legacy Java OIDC adapter, whose last release is
    **25.0.3 in August 2024**. CEDAR uses it in exactly three files in
    `cedar-auth-operations-keycloak-library`: `KeycloakDeploymentProvider` builds an `AdapterConfig`
    into a `KeycloakDeployment`, `KeycloakUtils` makes a single
    `AdapterTokenVerifier.verifyToken(token, deployment)` call, and
    `AuthorizationKeycloakAndApiKeyResolver` passes the deployment along. Every server builds one of
    these in the shared bootstrap, so this is the bearer-token path for all fifteen.

    The replacement stays inside Keycloak's own supported artifacts: `TokenVerifier`,
    `RSATokenVerifier` and `JWKSUtils` are all present in `keycloak-core` 26.7.1. What the adapter
    supplied for free, and what would have to be written, is the rotating public-key locator and the
    HTTP client that fetches the realm's JWKS. That is the whole of the work, and it is small.

  - **`keycloak-admin-client-jakarta` is not a blocker,** which is how this item read before it was
    checked. It stopped at 21.1.2 because it was a transitional variant, not because it was abandoned:
    from Keycloak 22 the main `keycloak-admin-client` is itself Jakarta-based, and it is published at
    26.0.12. This is a coordinate change.

  - **The event listener is not a blocker either.** `EventListenerProvider.onEvent(AdminEvent,
    boolean)` — the signature `cedar-keycloak-event-listener` overrides — still exists verbatim in
    26.7.1, and `keycloak-server-spi`, `keycloak-server-spi-private` and `keycloak-services` all
    publish at that version. Its imports are the stable event and model SPI throughout.

  - **The theme is small rather than structural.** `cedar-03` is a login theme with `parent=keycloak`
    that overrides two FreeMarker templates, `login.ftl` and `template.ftl`, plus a stylesheet and
    three images. The stock login theme was superseded by `keycloak.v2` in 24, so those two templates
    need re-porting against the new base. Two files, not a theme.

  Two routes follow. The clean one moves the server to 26.7.1 and replaces the adapter usage in the
  same step. The other moves the server first and keeps the 25.0.3 adapter, betting that token
  verification is plain OIDC over JWKS and will keep working against a 26 realm. It probably would.
  It is also exactly the shape of the 2.19-client-against-1.3.6-server pairing this estate carried in
  Docker for years and was right to be uneasy about, on a library that has had no release since 2024.

  One thing still to confirm: the Java floor of the 26.x **server** distribution. It is not a
  client-side question — `keycloak-core` 26.7.1 is Java 8 bytecode and imposes nothing — and the
  Keycloak image installs `java-17-openjdk-headless` unpinned. Worth settling alongside this, since
  the reason the estate pins Java 17 at all is that newer JDKs crash *this* Keycloak on the removed
  security manager. Moving Keycloak forward is the thing most likely to retire that constraint.

  Production is the part this item owns for every store: each version rehearsed on a copy of
  production data and gated on the end-to-end smoke. Where the order above and the Docker roadmap
  disagree, the Docker roadmap governs, since it sequences the remaining work.

- **3. Make database schema evolution an explicit, privileged release operation.** Application
  startup can change CEDAR's relational schemas today: monitor, worker and messaging all ship
  `hibernate.hbm2ddl.auto=update`, and monitor and worker both register the logging entities against
  the same log database. A mapping change can therefore become unreviewed DDL before either service
  binds its connector, with two processes attempting it concurrently. The tests do not exercise that
  risk: they create a fresh empty MySQL or embedded MariaDB schema, while the production runbook says
  to run a release's migration set without providing a versioned mechanism or a gate that requires
  one.

  Remove schema-mutation authority from the applications at both layers. Every non-test runtime must
  use Hibernate `validate` (or no schema action where validation is unsuitable), while disposable
  test databases opt into `create-drop` explicitly. Production application accounts must have no
  `ALTER`, `CREATE`, `DROP` or `INDEX` grants; a separate migration identity holds DDL authority, so a
  configuration regression fails at startup rather than rebuilding a live table.

  Introduce one versioned, forward-only migration mechanism for each CEDAR-owned relational schema,
  baseline existing installations, and make its immutable migrations part of the release. Run them
  once, under the migration identity and a migration lock, before applications start. Prefer
  expand/contract changes that remain compatible with the old and new binaries. Any large-table DDL
  must state the MySQL algorithm and lock behavior and must use an evaluated online-schema method or
  an explicit maintenance window rather than inheriting whatever Hibernate chooses.

  Put the policy in the build and release gates. A change to a persistence mapping, Hibernate schema
  setting or migration directory must carry the target database and table, generated or expected
  DDL, compatibility window, production row-count and size evidence, expected algorithm and locking,
  timing, execution order and recovery plan. CI should reject automatic DDL outside test resources
  and reject a persistence-model change with neither a migration nor an explicit no-schema-change
  declaration. `cedarcli release start` should refuse a train whose required migrations are absent or
  unverified, and the production deploy should record exactly which migration checksums it applied.

  Test upgrades rather than only installations: build the previous schema with representative data,
  apply every pending migration, start the new applications in validation mode, and prove the data
  remains readable. Rehearse large changes against a recent sanitized production copy or a table with
  equivalent size and indexes on the production MySQL version; a small staging table is not evidence
  that a table-copy operation is safe. Done when no production application credential can execute
  DDL, no application startup can request it, each owned schema has an auditable migration history,
  and both CI and the release controller enforce the migration contract.

- **4. Decide whether four narrowly used servers should be retired.** Treat each as an explicit
  product and operations decision: confirm its real callers and production state, preserve or move any
  capability that remains required, then either retain it with a stated role or remove it completely.

  **Schema server.** Its entire HTTP surface is an index page, but it still inherits the full
  microservice bootstrap: a Neo4j user service, Keycloak token verification, and the persistent Redis
  application-log queue. Either retire it or record the role it is reserved for and give it a
  deliberately minimal bootstrap that does not initialize dependencies its index page never uses.

  **Impex server.** Its public work is the caDSR form-import command and status endpoint. Determine
  whether any current workflow still imports those forms, whether unfinished import state has value,
  and whether a retained one-off importer belongs in an application server; otherwise retire the
  service rather than carrying a permanent deployment for a historical migration path.

  **Value Recommender server.** It serves recommendation and rule-generation/status commands and
  consumes the persistent value-recommender queue. Establish whether the Workbench or any external
  client still uses recommendations, then either retain and own that product surface, move the needed
  function to an active service, or retire it after draining or deliberately discarding its queue and
  removing its producers.

  **Submission server.** It contains the NCBI, CAIRR, ImmPort, LINCS and AMIA/BioSample submission
  paths and consumes the persistent NCBI submission queue. Inventory actual production submissions,
  credentials, pending/dead-letter work and external commitments; preserve any live adapter elsewhere
  before retiring the collection of legacy integrations.

  Any retirement must remove the service from the native and Docker estates, nginx and DNS routing,
  configuration, credentials, queues and producers, service inventory, health and smoke expectations,
  build train, CI, Compose projects, deployment procedures and documentation. A retained service needs
  the opposite evidence: a named owner, current caller, supported contract and meaningful health and
  integration coverage.

  **Archive `cedar-rest-library`.** Everything inside the repository is done; what remains is
  outside it. Archive it on GitHub so a clone stops being offered, and drop it from any workspace
  tooling that still lists it. Until it is archived its name sends a reader looking for shared REST
  code somewhere other than `cedar-microservice-libraries/cedar-server-rest-library`, which is where
  that code is.

- **5. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
  and the build enforces it. 21 is the next LTS and the natural target, but the lock exists for a
  reason: newer JDKs (23/25) crash Keycloak (`getSubject … security manager`) and OpenSearch will not
  start under them. So this is not a blind bump — verify Keycloak and OpenSearch run on 21 first, then
  move the toolchain, the profile pins, and the build enforcement together, gated on the end-to-end
  smoke. Low urgency while 17 is supported; parked at the end of the list for that reason.

  **Tighten the pins as part of it, because there are three of them and they disagree.** The estate
  pins Java in three places at three different strengths, and nothing compares them:

  - the **build JVM**, `[17,18)` in `cedar-parent`'s enforcer — major only;
  - **CI**, `distribution: temurin` with `java-version: "17"` — major only, so whatever 17 the
    runner has that week;
  - the **CEDAR runtime JRE**, `eclipse-temurin:17.0.8_7-jre-ubi9-minimal` — exact, to the build
    number, and the most precisely pinned thing in the estate;
  - **Keycloak's own JVM**, `dnf install java-17-openjdk-headless` in its image — major only, and a
    different vendor from everything else.

  So the thing that runs the servers is pinned harder than the thing that compiles them, which is
  backwards. Measured 2026-08-09 while adding the Maven wrapper: the build JVM on this machine is
  **Oracle 17.0.14** against a runtime image on **Temurin 17.0.8_7** — a different vendor, six
  patches apart, and both are "17" as far as every check in the estate is concerned.

  Moving to 21 touches all four, so it is the natural moment to make them agree rather than merely
  move together: pin the enforcer and CI to the same exact version the runtime image ships, and give
  Keycloak's JVM the same treatment when its own upgrade lands. Maven is not part of this problem:
  repository builds use the wrapper, while container jar-fetch stages use a separately pinned Maven
  builder image that never enters the runtime.

- **6. Complete the remaining backend trust-boundary, transport and credential security work.**

  **Artifact-server trust boundary.** The workspace authorization model lives in Neo4j and is enforced
  by the resource server, while the Mongo-backed artifact server checks only authentication and a
  global permission granted to ordinary template creators. An ordinary account that can reach it
  directly can therefore read, list, change or delete artifacts it cannot access through the resource
  server: measured on 2026-08-13, a second user received `403` for another user's template through the
  resource server and `200` through the artifact server.

  Decide which security boundary CEDAR supports. If topology is the boundary, block the artifact vhost
  in every environment and bind internal-only services accordingly; production and the container stack
  already do this, while native development currently exposes the vhost and port. Alternatively, make
  the artifact server authorize against the workspace graph or a signed resource-server assertion, or
  accept only a service credential unavailable to ordinary users. Record and test the chosen trust
  boundary alongside the permission model rather than leaving the two service doors with different
  effective authorization.

  **Two terminology routes answer an anonymous caller, and that stays.** `POST
  /bioportal/integrated-retrieve` and `POST /bioportal/integrated-search` resolve no user. Measured
  2026-08-31: a request with no `Authorization` header returns `200`. Both reach BioPortal on the
  server's own `apiKey`, so an anonymous caller spends the deployment's BioPortal quota.

  Requiring a credential is not the remedy, for the reason item 7 gives: third-party deployments of
  the embeddable editor call these routes from a browser with nothing to send, so a gate would break
  every host that embeds it. Both methods now carry that reasoning where the check is disabled, and
  the OpenAPI no longer promises a `401` neither route sends. What bounds the cost is the edge rate
  limit in item 7, which covers `/ext-auth/*` and should cover these two on the same terms.

  `TerminologyServerApplicationSmokeTest.theIntegratedRetrieveRouteIsReachable` asserts reachability
  rather than a status, which matches the decision; it should keep doing so.

  **Keycloak TLS.** Confirm that staging and production leave `CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS`
  absent or `false`, trust the Keycloak issuer CA, and pass both a JWKS-backed token verification and
  a read-only admin operation. Never solve a failed trust check by enabling the development flag.

  **Keycloak provider rotation.** The 2023-07-05 development realm export carried its RSA
  token-signing key, HS256 secret and AES secret, and both committed copies sat in public
  repositories, so those providers must be treated as publicly known. Stripping the seed protects
  only realms created after it: Keycloak stores providers in MySQL, so every realm that ever imported the
  old seed — production, staging, and long-lived local stacks alike — still signs tokens with the
  exposed key, and a token it "verifies" proves nothing. In each such realm, create fresh signing,
  HMAC and AES providers, delete the imported ones, and only then treat the installation as trusted;
  rotation invalidates outstanding tokens, so users sign in again. The keys also remain recoverable
  from git history, which is why rotation, not the strip, is the fix. Done when every deployed
  realm's providers postdate 2026-08-26 and the production deployment runbook's pre-flight carries
  the check.

  **BioPortal service credential.** `Constants.BP_PUBLIC_API_KEY` in
  `cedar-terminology-server` holds a literal BioPortal key, and `Cache` sends it on the four calls
  that populate the ontology and value-set caches (`findOntology` twice, `findAllOntologies`,
  `findAllValueSets`). Those are the server's own calls rather than calls made for a signed-in user,
  so production runs on that key at every start and every cache refresh. The configured path already
  exists and is used elsewhere: `CEDAR_BIOPORTAL_API_KEY` reaches `BioPortal.getApiKey()` through
  `cedar-main.yml`. Read the key from there and delete the constant. `Cache` is static, so the
  configuration has to be threaded in, which is why this belongs to the terminology rewrite rather
  than ahead of it.

  BioPortal does not offer regeneration for this key, so rotation is not an actionable code or
  operations step. Treat the existing value as a fixed exposed credential: remove it from source,
  supply it only through deployment configuration, and avoid multiplying copies. Replacing it would
  require external coordination with BioPortal rather than another CEDAR endpoint. BioPortal
  rate-limits per key, and a burnt quota surfaces to users as controlled terms silently not existing,
  because the picker latches its empty cache for the life of the page.

- **7. Rate limit the edge in every environment.** An anonymous caller can spend the deployment's
  third-party quota, and only the development host bounds how fast. The `/ext-auth/*` routes are
  the clearest case: they proxy seven registries, three of them on credentials the deployment
  holds, and they carry none of their own. `POST /bioportal/integrated-search` and `/bioportal/integrated-retrieve`
  belong in the same limit: both are anonymous by the same decision and both spend the deployment's
  BioPortal key.

  A limit rather than a credential is deliberate. The embeddable editor calls them from a browser with
  nothing to send and nowhere in `CeeConfig` to keep a key, so a gate would break every host that
  embeds it, and a key shipped to a browser is not a secret and would stop nobody who wanted to
  relay through CEDAR.

  Three things remain. Staging is not covered: only its `sites-enabled` directory is mirrored here,
  and `limit_req_zone` is valid only in the `http` context, so the zone has to be added on that
  host. A per-address limit still multiplies for a caller holding many addresses, so a deployment
  that cares about the quota needs a ceiling on the total as well as on each source. And the two
  terminology routes named above spend the same kind of credential with no limit at all; whatever is
  decided about their gate, they want the same treatment.

  Done when every environment serving an unauthenticated third-party proxy carries a limit, the
  chosen rates are recorded where the deployment is documented rather than only in the config, and a
  probe shows the limit taking effect.

- **8. Bound the application-log queue, and let its consumer keep up.** Application logging can
  consume the host it runs on. The Redis queue has no ceiling and the consumer drains far below what
  the stack produces under load, so a busy period grows memory without limit and degrades every
  service while it does. Old rows have a way out, in the prune job the log aggregation work brought
  with it, but it ships disabled.

  Measured on 2026-08-31, after a day of local performance profiles: `CEDAR-QUEUE-app-log` held
  3.7 million messages and drained at about 1,054 a second, roughly an hour of backlog. Redis was
  using 5.77 GB against a peak of 24.86 GB, with `maxmemory` unset. A background save of a dataset
  that size takes most of a core and stalls every service reading through Redis, which is enough on
  its own to make a performance run measure the save rather than the code. `cedar_log.log_request`
  had reached 10.3 million rows, 6.8 GB of data and 4.4 GB of index.

  Three things hold the drain rate down, and they compound. Each message is its own `@UnitOfWork`,
  so one HTTP request costs several transactions rather than one. Every subtype after the first reads
  the row back by `localRequestId` before merging into it, so most of those transactions carry a
  lookup as well as a write. The table then carries seventeen declared secondary indexes, each
  maintained on every insert, on a table too large to keep them cached. That count rose by three when
  aggregation landed, so the write cost is growing rather than holding.

  The message count is larger than the usual request-filter START, request-handler and request-filter
  END triplet. `AbstractNeo4JProxy` also emits a `CYPHER_QUERY` message for every graph query. The
  comment in `AppLoggerQueueService` says this high-volume stream is disabled, but the condition that
  would disable it is itself commented out. Establish whether raw query logging still has an active
  operational consumer; if it does, make it explicitly configurable and consider sampling it. If it
  does not, stop producing it before optimizing a consumer for work the estate did not intend to keep.

  Deliver:

  - An application-log-specific ceiling on the queue and its dead-letter queue, with a stated answer
    for what happens when either is reached. Enforce the pending-queue limit with one atomic Redis
    operation rather than an `LLEN`/`RPUSH` race. Prefer shedding new messages to trimming the oldest:
    trimming removes a request's START first and leaves later messages with no row to merge into.
    Count and expose every shed message. All five durable queues share this Redis, so do not use an
    `allkeys-*` eviction policy that can evict security-sensitive permission work; a host-level limit,
    if added as a final guard, needs a deliberate `noeviction`/isolation decision and enough headroom.
  - One transaction per bounded batch rather than per message. Group messages by `localRequestId`,
    carry a START record forward inside the batch, fetch all cross-batch request ids in one query, and
    write each request row once. Preserve the existing claim/processing/ack protocol: acknowledge only
    after commit, make replay after a commit-before-ack crash idempotent, and isolate a poison message
    without ambiguously replaying an already committed batch.
  - A retention window chosen and turned on. `LogPruneJob` deletes aggregated rows past a window in
    bounded batches, defaulting to thirty days, and stays off behind `CEDAR_LOG_PRUNE_ENABLED`
    because deletion is the irreversible step. What remains is trusting the rollups enough to
    enable it, and saying which window each environment keeps.

  **Production database migration — a separate, explicitly controlled workstream.** Reducing the
  `log_request` index set is not an annotation cleanup and must not ride silently inside the consumer
  change. First inventory the physical production indexes with `SHOW INDEX`: the entity declares
  seventeen indexes as well as a unique constraint on `localRequestId`, and the actual structures can
  differ from the annotations after years of `hbm2ddl.auto=update`. Use the real `LogQueryDAO`,
  `LogExplorerDAO`, aggregation and prune queries with `EXPLAIN`; treat
  `sys.schema_unused_indexes` only as supporting evidence because its counters reset. Then prepare
  explicit forward and rollback DDL, establish the algorithm/lock behavior and disk headroom, and
  rehearse both directions against a production-sized copy. Deploy the index migration separately,
  during a named production window with a backup, observable progress, abort criteria and post-change
  query-plan and latency verification. Removing `@Index` annotations is not a migration, and no index
  is to be dropped merely because its name looks redundant.

  Done when a sustained load profile leaves the queue at a bounded depth it recovers from, Redis
  memory flat across the run, shed and orphaned messages visible, and the worker healthy throughout.
  The item is not complete until any production index changes have also passed the separately staged
  migration and rollback procedure above; a green Java build is not evidence that a live-table DDL
  change is safe.

- **9. Separate CEDAR dependency convergence from the Keycloak provider platform lock.** The eleven
  apparent test-classpath splits are not eleven candidates for one global version. Re-measuring all
  thirty Maven roots divides them into three different problems, and blindly managing the newer side
  in `cedar-parent` would make the Keycloak event listener compile against libraries its server does
  not provide.

  - **One is a real CEDAR classpath conflict:** `commons-collections4`. POI selects 4.5.0 on the
    application classpath while MariaDB4j's test tooling requests 4.4 through `ch.vorburger.exec`.
    The applications already run and test with 4.5.0 winning, so manage 4.5.0 for the ordinary CEDAR
    runtime once the event-listener exception below is in place.
  - **Five are unused admin-tool baggage:** `resteasy-jaxb-provider`,
    `resteasy-multipart-provider` and the three `apache-mime4j` artifacts. They reach
    `cedar-admin-tool` only through its direct `keycloak-admin-client-jakarta` dependency. CEDAR uses
    the JSON provider, and `cedar-auth-operations-keycloak-library` already excludes the same two
    RESTEasy providers for that reason. Put those exclusions on the admin tool's direct dependency;
    Mime4j leaves with the multipart provider, and none of the five needs a CEDAR-wide pin.
  - **The rest belong to a different runtime:** `checker-qual`, `jaxb-core`, `txw2`,
    `jackson-dataformat-cbor`, `jakarta.transaction-api` and the event listener's copy of
    `commons-collections4` are all `provided` transitives of `keycloak-services:22.0.4`. They are
    supplied by the Keycloak process and must follow its platform, not Dropwizard, Hibernate,
    OpenSearch or POI. The same is true of Keycloak's RESTEasy and Mime4j versions after their unused
    admin-tool path is removed.

  The event-listener POM currently inherits `cedar-parent` but does not import Keycloak's dependency
  management. Keycloak's server-extension guide requires an import of `keycloak-parent` at the server
  version. That import changes three of the raw transitive values recorded above to the versions the
  Keycloak 22.0.4 platform actually manages: `checker-qual` 3.34.0, JAXB 4.0.3 and CBOR 2.15.2.
  Comparing the listener's current compile tree with an isolated Keycloak-managed provider found 28
  common artifacts at different versions, including Jackson 2.18.3 versus Keycloak's 2.15.2. This is
  a real provider contract gap, not ordinary dependency drift.

  Importing `keycloak-parent` is necessary but not sufficient: direct entries inherited from
  `cedar-parent` beat versions supplied by an imported POM. Keep the CEDAR parent for the repository's
  shared build and release machinery, import the Keycloak parent, and add child-level overrides for
  the overlapping `provided` artifacts so the resulting tree matches the Keycloak 22 platform. Keep
  that exception local to `cedar-keycloak-event-listener`; do not weaken dependency management for the
  other Java repositories.

  Gate the change at all three boundaries: dependency trees must show the managed CEDAR versions, the
  admin tool must contain none of the unused provider stack, and the event listener must match the
  Keycloak platform. Run the whole estate's 7,814 tests, package the listener, boot Keycloak with it
  installed and trigger one event, then exercise one read-only admin-tool Keycloak operation. The
  last two remain integration gates even though the admin TLS construction and the listener's event
  selection, callback payload and authorization header now have focused tests: a unit test cannot
  prove that Keycloak loads the packaged provider or that a deployed admin operation reaches the
  configured realm.

- **10. Retire routine `CEDAR_VERSION_MODIFIER` cache busting.** Frontend code identity now comes
  from the source commit in the three AngularJS RequireJS keys and from content-hashed production
  bundles in the modern Angular applications. A deployment should not need a hand-edited modifier
  merely to make a new code revision visible. Keep the variable temporarily as a compatibility
  escape hatch for two materially different cached payloads built from the same source commit, not
  as a release counter.

  Audit every producer and consumer before deleting or clearing it: profile and environment files,
  cedar-cli build/version reporting, the three Gulp applications, native split-payload tooling,
  Docker entrypoints, release/deployment scripts, and operational documentation. Classify each use
  as source identity, genuine same-commit payload identity, display-only version metadata, or dead
  compatibility behavior. Remove routine deploy-time bumps and any check that treats a changed
  modifier as evidence that new code is live. If no cached asset can legitimately differ while its
  source commit stays fixed, remove the variable completely; otherwise retain the narrowly named
  override and add a test proving the exact same-commit case it serves.

  Make the production transition once, deliberately. Rehearse it in staging, clear or freeze the
  old modifier, rebuild every frontend from recorded commits, deploy the canonical nginx policy,
  and purge entry/config objects that may still carry the former headers. Verify that entry and
  runtime configuration are `no-store`, stable fallback assets revalidate, hashed assets are
  immutable, and every served build identity matches the accepted commit. Then use a browser that
  previously loaded the old payload to open, modify, save, reload, and save an existing instance;
  this must exercise the GET ETag and subsequent `If-Match` update rather than merely prove that the
  dashboard renders. The item is complete after two consecutive code deployments require no manual
  cache token, the cache-delivery smoke passes in staging and production, and rollback works by
  restoring payloads and routing without inventing a new modifier.

- **11. Converge on one pagination encoding.** Three servers paginate three ways, and all three build
  on the same `PagedResults` and `LinkHeaderUtil`, so nothing forces the split. The artifact server
  sends `Link` and `Total-Count` as headers and keeps the body to the collection. The resource server
  computes the same link set and puts it in the body under `paging`
  (`AbstractSearchResource.java:129`, `CategoriesResource.java:138`,
  `FolderContentsResource.java:308`). Terminology returns `page`, `pageCount`, `pageSize`,
  `totalCount`, `prevPage` and `nextPage` as flat body fields, built in
  `SqliteTerminologyService.java:220`. A client library that can page one server cannot page the
  other two.

  **The decision is which encoding wins, and it has to come first.** Headers are the conventional
  answer and the artifact server already implements them alongside the ETag, `If-Match` and `Vary`
  contract that the rest of the estate is measured against, so moving it would move the reference
  away from convention. A body field would instead move the artifact server and terminology onto the
  resource server's shape. Nothing in the code decides this; it is a product call about what a CEDAR
  client should look like.

  Whichever wins, deliver it additively first. Emit the chosen encoding everywhere alongside what each
  server sends today, document it as the supported form, and withdraw the others in a later release.
  Only the withdrawal breaks a caller, which is what keeps this off a flag day. The alternative is one
  coordinated release across the Template Editor, the embeddable editor, `cedar-cli`, the four MCP
  servers and `ops/e2e`, which the lockstep policy allows and the pinned check inventory in
  `rest/expected-checks.json` makes tractable.

  Two things are already in place. `Link` and `Total-Count` are on the CORS exposed-header list, so a
  browser can read them cross-origin wherever they are sent. And terminology's page-number fields are
  what the term picker reads, so they have to survive until it moves, whichever encoding wins.

  Done when one encoding is documented as the supported form, every paginating route emits it, the
  REST smoke asserts it on a route from each of the three servers, and the superseded encodings are
  either withdrawn or carry a recorded date for withdrawal.

- **12. Bound every outbound call by what the call actually is, and measure before choosing the
  numbers.** Two classes of outbound call are distinguished today, interactive and batch, each with a
  fixed connect, lease and response timeout and its own connection pool. That covers the difference
  between a call a user waits on and a job nobody waits on. It does not cover the difference between
  one hop and another, and nothing about it is configurable.

  **The external authorities run on values chosen for a hop to the next CEDAR service.** ORCID,
  PubMed, ROR, RRID, NIH RePORTER, the LINCS validator and DataCite are all reached through the
  interactive class, whose one-second connect timeout is generous for a loopback and mean for a cold
  TLS handshake to a transatlantic host, so a slow third party is reported as an unavailable one.
  Give the external calls their own class, with a connect timeout in the seconds and a response
  timeout chosen from what each service does.

  **No latency data exists to choose a response timeout from.** No server's `config.yml` configures
  `requestLog`, and Dropwizard's default access log format records no duration, so every value in
  force is arithmetic against nginx's 180-second `proxy_read_timeout` rather than a measured p99. Add
  `%D` to the request log, or a timer around the proxied calls, and collect a week of traffic before
  tuning. The artifact server's response timeout is the value most likely to be wrong, since a large
  instance write with validation is the plausible outlier.

  **Then move the values into configuration.** `servers:` in `cedar-main.yml` already models every hop
  and `ServerConfig` already reads it, so a per-hop timeout has a home; the external ones have theirs
  under `externalAuthorities:` and `dataCite:`. `MicroserviceUrlUtil` should hand out the timeouts
  with the URL, so a call site cannot obtain one without the other.
  `CedarTestRuntime.dependencyTimeoutMillis` is the precedent for the override and `Neo4JProxies` for
  applying it.

  **A hard user-facing bound needs a deadline rather than per-hop values.** Updating an artifact makes
  two proxied calls in series, and three when compensation runs, so the client's worst case is the sum
  of whatever each hop is allowed. Only a budget stamped on `CedarRequestContext` and decremented
  across the hops can say that the second call gets what is left of fifteen seconds. Worth doing when
  a response-time guarantee is promised, not before.

  **The compensating write in that path is still best effort.**
  `AbstractResourceServerResource.restoreArtifactAfterFailedGraphUpdate` restores the artifact
  document when the graph update did not commit, in the request, with one attempt and no retry, and
  its failure is the one that leaves the two stores disagreeing. It carries an `If-Match` on the
  replacement ETag, so a replay is safe. A replay after an unseen success answers 412 rather than
  overwriting a newer document. Hand it to the durable completion machinery artifact deletion already
  uses.

  **Retry belongs only where the verb allows it.** A GET may retry once, and only on a connect
  failure, a lease timeout, or a reset before any response, never on a response timeout, since the
  server may still be working. A PUT or DELETE carrying `If-Match` may retry once on a connect failure
  for the reason above. A create POST has no deduplication key and must not retry. Any retry comes out
  of the hop's budget rather than doubling it.

  **Circuit breaking earns its place in front of the external authorities and nowhere else.** A dead
  third party otherwise burns a full response timeout on every request. Keyed per authority, opening
  after several consecutive failures and half-opening on a single probe, that is a few dozen lines in
  the authority base class and needs no new dependency. The artifact server is not optional, so a
  breaker in front of it would only convert a timeout followed by 503 into an immediate 503, and would
  flap during a rolling restart.

  **Two clients still carry their own numbers, and one dead copy of the constants remains.** The
  terminology server builds its own pooled client in `HttpClientFactory` with a third set of values,
  and the submission server's `StatusNotifier` a JAX-RS client with a fourth. Both are defensible in
  isolation and neither is reachable from the shared configuration. The unused
  `HttpConnectionConstants` in `cedar-keycloak-event-listener` is a verbatim copy of the shared class
  that nothing reads.

  **The constants are in the wrong library.** `HttpConnectionConstants` sits in
  `cedar-model-library`, whose subject is the CEDAR artifact model, and outbound HTTP timeouts have
  nothing to do with it. `cedar-server-rest-library` is where they belong. Moving them changes a
  published library's public API, so it wants a coordinated release rather than a quiet edit.

  Done when each class of outbound call takes its timeouts from configuration, the request log carries
  durations, the compensating write is durable, and the remaining clients read the same settings.

- **13. Make native bring-up prove a service runs, and make one already-running layer not stop the
  rest.** `cedarcli native start` reports what the launcher accepted rather than what the stack ends
  up running, and the gap swallowed a whole-stack outage on 2026-09-02: every application exited in
  milliseconds for want of `CEDAR_PROFILE`, launchd's keepalive respawned each one, and the CLI
  printed `started <name> (pid N)` for all twenty-two because a PID existed each time it looked. The
  launcher passes that environment through today, rejects a service that dies at once, refuses a
  `JAVA_HOME` that is not a Java 17, and covers all three in tests. Two things remain.

  Confirm a service is serving, not merely alive. The survival check waits half a second and asks
  whether the process still exists, which catches the failures that land before a JVM starts and
  none after that. A microservice that boots, fails to reach Neo4j or Mongo, and exits after ten
  seconds is still reported as started. `cedarcli native health` already knows how to judge this and
  exits non-zero unless every managed application is healthy, so let `start` end by waiting for the
  services it just launched to pass that same gate, bounded by a timeout, and report the ones that
  never arrive along with the last lines of their logs.

  Let `start all` reach the applications when infrastructure is already up. It runs infrastructure,
  microservices and frontends in order, and a layer that is already running fails its ports with
  `Address already in use` and halts the run, so the applications never start and the operator is
  left to run the two remaining layers by hand. Treat an already-listening infrastructure port as
  the satisfied precondition it is.

  Done when `start` reports a service only once it is healthy or names why it is not, and `start
  all` completes against running infrastructure.

- **14. Take the dependency upgrades that need code changes.** The versions that could move without
  consequence have moved. What stayed behind stayed deliberately, and it separates into work to do,
  versions that follow something else, and versions upstream has not released.

  **The upgrades that need code or test changes.** Each of these is a change to make rather than a
  version to raise, which is why none of them rode along with a sweep.

  - **json-schema-validator 1.5.9 to 3.0.7.** Two major lines on the library that decides which
    stored artifacts CEDAR accepts. A change in validation behaviour is a change to the product, so
    this one is settled by differential testing against production artifacts, not by a green build.
  - **OWLAPI 4.5.9 to 5.5.1.** Ontology semantics, where a behavioural difference does not show up
    in a compile.
  - **Embedded Mongo 4.20.0 to 5.0.0.** Test lifecycle only, but that lifecycle was reworked twice
    in early September 2026, so this wants settled code under it.
  - **JsonPath 2.9.0 to 3.0.0.**
  - **The Maven Release plugin 2.5.3 to 3.3.1, with its SCM provider 1.11.1 to 2.2.1.** These decide
    how `cedarcli release start` cuts a release across the versioned repositories. Rehearse the
    release rather than trusting a build.
  - **Logback 1.5.33 to 1.6.3** needs SLF4J 2.1, which has only an alpha, so it waits on the last
    group below.

  **Versions that follow a locked server.** Six sit here: the Neo4j driver 5.28.14 to 6.2.1, MySQL
  Connector/J 8.4.0 to 26.7.0, the Mongo driver 5.1.2 to 5.11.0, the OpenSearch client 2.19.2 to
  3.8.0, the Lucene pin 9.12.1 to 10.5.1, and the Neo4j test harness 5.3.0 to 2026.07.1. Client
  libraries are free to move in general, but a driver crossing a major has to be proven against the
  pinned server it talks to, so these are sequenced behind item 2 rather than taken on their own.
  Keycloak 22.0.4 to 25.0.3 is item 2's own, and RESTEasy 6.2.4 to 7.0.4 is held by the Keycloak
  client stack, which items 2 and 9 own.

  **Versions that follow whatever pulls them in.** The transitive block exists so that every module
  resolves one version of an artifact nothing here depends on directly, which makes these five
  nobody's choice to raise: HK2 locator 3.0.6 to 4.0.2, Jandex 2.4.3 to 3.3.1, Netty 4.1.115 to
  4.2.17, protobuf-java 3.25.5 to 4.36.1 and Reactor Core 3.5.20 to 3.8.7. Each belongs to a
  framework above it, so each moves when Jersey, Hibernate, the Neo4j driver or OpenSearch moves.
  Raising one on its own would pin a version its owner does not expect.

  **Versions that are not released.** These wait on upstream to ship a final: HttpCore 5.5-beta2 and
  HttpClient 5.7-alpha1, Hibernate 8.0.0.Beta1, Jedis 8.1.0-beta1, SLF4J 2.1.0-alpha1, Log4j
  3.0.0-beta2, Jersey 5.0.0-M1, Angus Activation 2.1.0-M1, the Jakarta activation, persistence,
  servlet, validation and XML binding milestones, and the Maven 4.0.0 betas of Clean, Compiler,
  Deploy, Install, Jar, Resources and Source, with Site at a milestone. The old javax
  jaxb-api's only newer version is a 2018 build that was never finalized, so it stays too.

  Verifying any of this locally is unreliable, and the cause is worth knowing before an upgrade is
  blamed for it. Several suites bind fixed ports rather than asking the operating system for a free
  one: the artifact server's test configuration names port 9091 for every test class in the module,
  so a class that starts before its predecessor has released the port fails to bind. Others depend
  on timing under load, several of them in the resource server. Each shows up in one full run and
  not the next, which makes an unrelated version look guilty, and the estate's own convention that
  test servers sit on 19xxx ports is not in fact kept. Prefer the suites of the modules a change
  actually touches, and treat a single red full build as a question rather than an answer.

  Done when each upgrade above has either landed or been recorded as refused with its reason, and
  the estate no longer carries a dependency held back only because nobody looked at it.

## Production data

- **15. Normalize production artifacts to one explicit model contract.** Production contains several
  legacy representations that the current model surfaces tolerate or normalize differently, so bring
  them to canonical shapes before tightening readers or introducing terminology routing across source
  systems. The permission-scoped audit found 76 inherently-multiple fields deployed as JSON objects in
  31 stored schema artifacts: 23 templates and 8 elements. Every case is a multiple-select list; no
  object-shaped checkbox or attribute-value deployment was found. CEE correctly serializes these
  values as arrays, but each stored schema still says `type: object`, so instance validation rejects
  the array. The affected set is concentrated in the RADx/Data File family, with one template carrying
  fourteen affected checklist fields, but every reported parent artifact and path is a separate patch
  target. Updating a standalone element does not rewrite copies already embedded in templates.

  The rule is written. Check 32 in `ops/cedar_artifact_patch.py` wraps a confirmed object-shaped
  inherently-multiple child in the canonical array deployment, preserving the child body,
  identifier, property mapping, constraints and parent metadata, and recursing into an element
  embedded in a template so a copy is repaired where it sits. It refuses an ambiguous shape,
  reporting without a repair where existing bounds contradict each other; it makes no change when
  rerun, because a child it has already wrapped is an array; and it reports by default and writes
  only under `--apply`. Three tests in `ops/test_cedar_artifact_patch.py` cover the lossless repair
  of direct and nested deployments, the standalone-field exclusion, and the bounds cases. What
  remains of this item is the production run, and the paragraphs below are that run. Keep it a
  narrow store repair rather than an edit through the legacy Template Designer or a blanket REST
  resave, and do not combine it with the unrelated normalization an ordinary artifact update
  performs.

  Rehearse against a production copy and require the dry run to match the captured manifest: 31
  artifacts and 76 paths, subject to an explicitly reviewed drift report if production changes
  first. Those counts exist only as this prose, so capture them as a fixture beside the tool first,
  or the dry run has nothing to be checked against. Before applying, take a recoverable backup and
  retain the before/after documents and patch manifest.
  Treat this as data repair rather than authored modification: preserve root IDs, version/publication
  state and provenance timestamps. Afterward, require both model libraries to read every repaired
  artifact, populate representative single- and multi-instance elements in CEE, and validate the
  resulting instances against the exact repaired templates. A repeated audit must report zero
  `inherently-multiple-child-object` findings and no new save-rejected findings.

  The `title`/`internalName` contract is settled as part of this production repair: it is derived
  metadata, not a first-class authored value. JSON-Schema `title` and the model's `internalName` must
  always be composed from `schema:name` using the canonical `"<name> <type> schema"` form, matching
  the Java and TypeScript YAML readers. Add an idempotent patch rule that reports and normalizes every
  divergent stored title without changing `schema:name`, and make both model libraries prevent an
  independently supplied title from surviving a round-trip. Capture the affected production paths in
  the reviewed manifest and require JSON → YAML → JSON and JSON → model → JSON tests to prove the
  canonical result. The artifact server already derives `title` on every ordinary write and makes
  the name part of `description` follow it, keeping the `generated by …` signature, so the patch is
  for what is stored and nothing rewrites. This decision does not make `description` derived, and
  the title patch must not rewrite description or provenance text.

  **Normalize zero and unknown encodings.** Three keys currently use zero as a sentinel where the
  schema gives it a quantity, so settle and apply one model-wide convention before patching the stored
  population. The Template Designer writes `maxItems: 0` for an unbounded multi-instance field and its
  runtime treats zero as falsy, although JSON Schema defines it as an array that permits no items;
  omitting `maxItems` already expresses unbounded cardinality unambiguously. Existing templates require
  compatibility while the editor, extracted Designer, meta-schema and both model libraries converge on
  the canonical representation.

  Value-set and ontology constraints also carry `numTerms: 0` when the count is unknown. The Java and
  TypeScript models already support absence, but stored zero values cannot distinguish an empty
  vocabulary from an unmeasured one, and an entire-ontology constraint with zero currently fails the
  meta-schema's `minimum: 1` check even when the editor's interactive validation passes. Decide whether
  terminology must supply the real count, producers must omit an unknown count, or the schema must
  admit zero, then make every producer and validator agree and add an idempotent patch rule for stored
  artifacts. Inventory the affected paths in the reviewed manifest and retain read compatibility for
  historical zero values during the transition.

  Include stray cardinality keys in the same audit: a single-instance object can retain
  `minItems: 0, maxItems: 0` even though readers ignore cardinality outside an array envelope. Determine
  whether current frontends still produce that shape, stop the producer if they do, and normalize only
  the reviewed stored occurrences without changing the field's actual cardinality.

  Keep the broader legacy population out of this first patch. The same audit found 4,524 artifacts with
  repair-on-save conditions — chiefly missing `@context.required` entries, empty `pav:derivedFrom`, and
  child IDs or property IRIs that the server would mint. Those are not the cause of the instance-save
  failure and should receive separately scoped, field-preserving patch rules rather than hitchhiking on
  this urgent repair. Empty `pav:derivedFrom` is the first candidate because the strict Java reader
  cannot open it even though the compatibility reader and ordinary update can recover it.

  Null identifier annotations belong in that production inventory as a scoped repair of their own.
  A request path has been able to persist a top-level annotation such as
  `_annotations: {"https://datacite.com/doi": {"@id": null}}`, and the current meta-schemas define
  the intended annotation content without applying that definition to the artifact's top-level
  `_annotations` member. Add an audit rule that reports every annotation object carrying an explicit
  null `@id`, with the artifact ID and JSON Pointer, before changing validation. The patch may remove
  an annotation entry only when null `@id` is its sole payload, removing the `_annotations` container
  as well when that leaves it empty; an entry with any additional payload stays report-only for human
  review. Do not include `@value: null`, which is a separately supported value annotation, and never
  invent an identifier. Capture the production count and paths in the reviewed manifest, prove the
  patch is idempotent, and require a repeated audit to report zero null identifier annotations. Only
  then wire the existing annotation-content definition into every applicable top-level meta-schema so
  direct artifact writes cannot recreate the shape.

  Child definitions present in `properties` but absent from `_ui.order` are another such repair, and
  production contains enough of them that the model libraries cannot simply start refusing the shape.
  Add a raw-store audit rule that distinguishes this case from the inverse drift (an order entry with no
  property), then offer an idempotent, field-preserving rewrite that appends each omitted child key after
  the existing order without changing or deleting the child definition. Capture the production count and
  paths as a reviewed manifest, cover direct and nested containers, and prove a second run makes no
  changes. Only after that repair has run and a repeated audit reports zero omitted children should the
  Java and TypeScript readers replace their current cleanup behavior with strict rejection. Keep the
  inverse drift report-only: the store does not contain enough information to synthesize a missing child.

  **Make the model version explicit, then enforce it.** The two Java readers disagree about
  `schema:schemaVersion`, so one artifact is accepted as JSON and refused as YAML.
  `checkSchemaArtifactModelVersion` in `cedar-artifact-library`'s `JsonArtifactShapeChecks` rejects a
  value it cannot parse and accepts every value it can, because the comparison against the current
  model version is commented out; `YamlArtifactReader` declares a method of the same name that
  compares. Absence is the harder half. `readModelVersion` returns an empty result for an artifact
  that declares no version at all, and the disabled comparison rejects an empty result as well as a
  stale one, so re-enabling it refuses both the artifact written against an earlier model and the
  artifact that never carried a version. Production is expected to hold some of each.

  Measure the population before writing a rule for it. Neither `cedar_artifact_rest_audit.py` nor
  `cedar_artifact_patch.py` reads the field today, so the counts do not exist: how many stored
  artifacts declare a version older than the current one, which versions appear, and how many declare
  none. Add the audit rule first and capture its findings as a reviewed manifest, the way the
  object-shaped repair is checked against 31 artifacts and 76 paths.

  A version cannot be stamped on faith. `schema:schemaVersion` asserts that the artifact conforms to
  the model it names, so writing the current version into an artifact that does not conform replaces a
  detectable defect with an undetectable one. The patch rule therefore writes the current version only
  where the artifact already satisfies the current model — both model libraries read it, and no other
  patch rule reports a finding against it — and reports the remainder for a scoped repair of its own.
  Keep it under the tool's existing discipline: report by default, write only under `--apply`, no
  change when rerun. Only once a repeated audit reports no stale and no absent version should the
  comparison in `JsonArtifactShapeChecks` be restored and its explanatory note deleted.

  The suites cannot find this defect, which is why it stayed open, and the reason is worth fixing
  independently of the production run. Every JSON fixture and every programmatic case supplies the
  version by referencing the same constant the disabled comparison would compare against, and the YAML
  renderer writes that constant rather than the version its source artifact declared, so a
  cross-format round trip launders a stale version into a current one before the strict reader sees it.
  The in-memory model has no field to carry a model version at all. Restoring the comparison against
  the library's suites as they stood changed no result anywhere in them, across 1,138 tests.
  `ModelVersionEnforcementTest` now pins the divergence, stating what each reader does with a
  well-formed stale version and with none, so the difference is a recorded decision and the day it
  changes is a failure rather than a surprise. Its two JSON acceptances are the tests to replace with
  rejections once the comparison comes back.

  Finally reconcile the inventory boundary. Two search results point at artifacts that the typed
  resource endpoint returns as 404, and two duplicate search rows make the reported row count exceed
  the unique audit set. Determine whether each is a stale search/workspace projection or a missing
  artifact before changing anything; then repair the projection from the authoritative stores and
  rerun the audit to `COMPLETE_FOR_KEY`. Never delete a store artifact merely because its search entry
  is inconsistent.

  **Make terminology sources explicit.** A controlled-term constraint may name the system serving its
  vocabulary, and both model libraries read
  an absent `sourceSystem` as BioPortal —
  [the value-constraint shape](VERSIONING-ROADMAP.md#6-the-value-constraint-shape) defines the field and
  that default. The default is correct for production today, because every deployed constraint resolves
  through BioPortal. It stops being correct as soon as the versioned terminology store serves a second
  system: a constraint authored before the field existed and one that deliberately names BioPortal are
  then indistinguishable, while routing has to honour the rule that a non-BioPortal source is never
  proxied to BioPortal. Writing the default explicitly while it still holds turns silence into evidence.
  After the sweep, a constraint carrying no `sourceSystem` marks an artifact the patch never reached.

  The serving system cannot be derived from the term IRI, which is the tempting shortcut and a wrong one.
  The 51 HuBMAP assay templates carry 504 branch constraints whose targets sit under
  `https://purl.humanatlas.io/vocab/hravs#`, and every one of them resolves through BioPortal, which
  serves that vocabulary as HuBMAP Research Attributes Value Set under the acronym HRAVS. The acronym,
  paired with a system, is what addresses a source. So the rule writes `BioPortal` where the
  constraint's acronym resolves in BioPortal, and reports the remainder for review instead of guessing.

  Add it to `cedar_artifact_patch.py` as its own rule, under that tool's existing discipline: report by
  default, write only under `--apply`, no change when rerun, refuse any constraint whose system it cannot
  establish. It needs no library change, since both model libraries already read the field and write it
  whenever a constraint carries one, so a patched artifact round-trips through the strict readers
  unchanged. Keep the scope to this one field. The canonical ontology identity (`iri`, `sourceIri` in
  YAML) is a separate mandatory field with its own derivation precedence, and the free-text `source`
  display string is separately noncanonical — 497 of those 504 HuBMAP branch constraints record
  `"undefined (HRAVS)"` where BioPortal has the real name — so each wants a rule of its own rather than a
  ride on this one. Background work with no deadline of its own. Its value lands at the terminology
  cutover, which means it has to be finished before a second source system is served, not before
  anything else.

## Later decisions

- **16. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee and is
  unaffected either way — that one is enforced.

- **17. Finish the DataCite DOI minting lifecycle.** The durable lifecycle is what makes the operation
  recovery-safe, and none of it exists yet. Minting persists no state of its own: draft/reserved,
  published and locally attached are recorded nowhere, so the `reconciliationRequired` response names a
  condition no code resolves, and a retry after a timeout cannot tell whether the earlier attempt
  already minted a DOI. Define those states, retain the DataCite identifier before the fallible
  write-back, and make a retry resume or reconcile the same DOI rather than orphan or duplicate one.
  Tighten how an existing draft is associated with its source artifact: the lookup still matches
  DataCite records on the OpenView URL. Orchestration also still sits in `DataCiteResource`, so
  configuration and error mapping are not yet centralized. The offline suite still lacks
  create-versus-update, retry after timeout, and repeated publish, each of which needs the durable
  states before it can be written. Keep normal tests offline; add only an opt-in DataCite sandbox
  smoke test for the final wire contract and credential/configuration check.
