# CEDAR Backend — Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. A shared library's internal items are
here as well, rather than in that library's own repository.
Work on the main browser applications is in [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md), work on
the embeddable editor is in [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee), and work on the MCP servers is in
[MCP-ROADMAP.md](./MCP-ROADMAP.md).

## Next

### Infrastructure

- **1. Protect `main` in every repository, and give the release an identity of its own.** `main` is
  unprotected in all forty-five repositories, so a commit can land there without ever reaching a
  train, which captures `develop`. The next release then replaces it: the work leaves the branch
  that held it and nothing says so afterwards. A hotfix and the unit test guarding it came within
  one reading of an advisory line of going that way. The release gate refuses such a source now, and
  `cedarcli check main` answers the same question between releases, but neither prevents the push.

  **The goal is that no ordinary push lands on `main`.** How the release lands its own commit is a
  second decision, and the two are worth keeping apart, because a protection rule written around
  whoever runs the release protects nothing against the case that prompted this. `cedarcli release
  start` pushes to `main` in forty-two repositories as that person, so granting them the bypass
  reopens the hole the rule closes. Whichever route below is taken, the release needs credentials of
  its own: a GitHub App or a dedicated account, authenticated as itself rather than as an operator.

  **Route one, a bypass on a direct push.** The release keeps the mechanism it has, and the ruleset
  grants the bypass to the release identity. The bypass has to cover every ref a release creates —
  `develop`, the tags, and `release/pre-*` among them — or a release fails after its Maven and
  frontend builds are already spent. It changes nothing in the release code, and it leaves the
  protection weaker on paper than a review gate, since the identity holding the bypass can write
  anything.

  **Route two, a pull request the release opens.** Nothing in the design forbids it. Each repository
  gets its integration commit on a branch, a pull request, and a merge through the API, which is how
  the npm releases already reach `main`. It costs three things. GitHub's merge produces a commit
  that is not the one the release prepared, so the ledger's `expectedCommit` check has to verify
  `main` by the tree it already records beside that commit (`release_support/integration.py`).
  Something has to merge forty-two pull requests: requiring only a pull request lets the release
  merge its own, which buys an audit trail rather than a review, while requiring an approval means a
  person approves forty-two of them mid-release, since GitHub refuses self-approval. And a pull request is a step other people can
  close or merge out of order, which weakens the guarantee that a resumed run reproduces the refs it
  recorded.

  The npm releases are the working example of route two and need nothing, but they are driven by an
  operator who is already there for the twenty-five commands item 23 exists to remove. Automating
  that route puts the identity question back.

  Prove whichever ruleset is chosen against one repository before it reaches all forty-five. Until
  the release has an identity, run `cedarcli check main` on a schedule, so divergence is found the
  next morning rather than mid-release.

- **2. Rename the legacy role relationships in production Neo4j.** The application currently
  interprets `CANREAD` as Viewer and `CANWRITE` as Manager, so the new permission model can be
  deployed without changing the stored graph. The category permission model follows the same initial
  approach: `CANATTACHCATEGORY` stores Classifier grants and `CANWRITECATEGORY` stores Manager grants.
  Category Viewer and Editor grants already use the canonical `VIEWER_ROLE` and `EDITOR_ROLE` names.

  Before migrating category data, add `CLASSIFIER_ROLE` as the canonical Classifier relationship.
  Make the application read both `CANATTACHCATEGORY` and `CLASSIFIER_ROLE`, read both
  `CANWRITECATEGORY` and `MANAGER_ROLE`, and write only the canonical names. Deploy that compatibility
  code to every environment before changing stored relationships.

  Patch the production graph to rename artifact and folder `CANREAD` relationships to `VIEWER_ROLE`
  and `CANWRITE` relationships to `MANAGER_ROLE`. In the same migration, rename category
  `CANATTACHCATEGORY` relationships to `CLASSIFIER_ROLE` and `CANWRITECATEGORY` relationships to
  `MANAGER_ROLE`. `EDITOR_ROLE` requires no migration for either resource family.

  Rehearse the patch against a recent production copy and record the relationship counts before and
  after it runs. Take a recoverable backup immediately before applying it in production. The patch
  must preserve each relationship's endpoints and properties, make no access changes, and be safe to
  run again. After applying it, regenerate the search index from Neo4j and verify the role counts and
  representative direct, group and inherited access paths for artifacts, folders and categories.
  Remove the compatibility interpretation of `CANREAD`, `CANWRITE`, `CANATTACHCATEGORY` and
  `CANWRITECATEGORY` only after every deployed environment has been patched and verified.

- **3. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
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

- **4. Make database schema evolution an explicit, privileged release operation.** Application
  startup can change CEDAR's relational schemas today. Monitor, worker and messaging each carry a
  byte-identical `hibernate.properties` under `src/main/resources` that sets
  `hibernate.hbm2ddl.auto=update`, nothing in `cedar-main.yml` overrides it, and monitor and worker
  both register the logging entities against the same log database. A mapping change can therefore
  become unreviewed DDL before either service binds its connector, with two processes attempting it
  concurrently. `update` only ever adds. A removed or retyped field leaves its column behind, a rename
  creates a second column, and a local log database already holds `hibernate_sequence` beside
  `log_request_SEQ` and `log_cypher_SEQ`, the generator tables of two Hibernate generations. The
  tests do not exercise that risk: they create a fresh empty MySQL or embedded MariaDB schema and
  rely on `update` to build it. Schema changes reach production as SQL run by hand. The production
  runbook says to run a release's migration set, and the one such set that exists,
  `cedar-logging-operations-library/db-migrations/2026-07-29-log-capture-phase1.sql`, was written
  because `update` adds columns but not reliably their indexes. There is no versioned mechanism and
  no gate that requires one.

  Remove schema-mutation authority from the applications at both layers. Every non-test runtime must
  use Hibernate `validate` (or no schema action where validation is unsuitable), while disposable
  test databases opt into `create-drop` explicitly. The setting is already reachable without a code
  change. Dropwizard copies every entry of a database's `properties` map in `cedar-main.yml` into the
  Hibernate configuration, and an explicit property beats the classpath default, so one
  `hibernate.hbm2ddl.auto` entry per database block, driven by a profile variable, can pin `validate`
  on a server profile while the development profile and the test-support library's environment
  override keep the value the suites depend on. Changing the shipped file itself would break every
  messaging, monitor and worker suite. Production application accounts must have no
  `ALTER`, `CREATE`, `DROP` or `INDEX` grants; a separate migration identity holds DDL authority, so a
  configuration regression fails at startup rather than rebuilding a live table.

  **Widen it past the relational schemas.** Mongo's unique `@id` indexes and Neo4j's index and
  constraint declarations are the same kind of statement: something that has to be true of a store
  before the code depending on it runs. Each is written down twice today, in a container's
  first-boot script and in an admin-tool task a person runs, and neither copy is applied again once
  a store is up, so a changed definition reaches no existing installation. `cedarcli check stores`
  reports the artifact collections' indexes and the artifact server logs them at startup, which
  makes a gap visible but leaves the definition in two places the release does not own.

  Introduce one versioned, forward-only migration mechanism for each CEDAR-owned relational schema.
  `dropwizard-migrations` sits on the Dropwizard line `cedar-parent` already manages. Baseline
  existing installations, the hand-run log-capture SQL included, and make its immutable migrations
  part of the release. Run them
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

- **5. Decide which of four narrowly used servers to retire, and support the one that stays.** Treat
  each as an explicit product and operations decision: confirm its real callers and production state,
  preserve or move any capability that remains required, then either retain it with a stated role or
  remove it completely. Schema and value recommender are open questions, impex is retained, and
  submission is expected to go once its inventory is done.

  **Schema server.** Its entire HTTP surface is an index page, but it still inherits the full
  microservice bootstrap: a Neo4j user service, Keycloak token verification, and the persistent Redis
  application-log queue. Either retire it or record the role it is reserved for and give it a
  deliberately minimal bootstrap that does not initialize dependencies its index page never uses.

  **Impex server.** It stays, so the work is the evidence a retained service needs rather than an
  inventory of whether anyone still calls it. Its public surface is two routes, `POST
  /command/import-cadsr-forms` and `GET /command/import-cadsr-forms-status`, and two gaps in what
  supports them are concrete. Import status is process-local: `CadsrImportStatusManager` is a
  singleton holding a `ConcurrentHashMap` keyed by upload identifier, so a redeploy during an import
  leaves a caller asking about work the server no longer remembers. And no test imports anything.
  The suite proves both routes reject an unauthenticated request (`ImpexRoutesRespondTest`) and
  stops there. Name the owner, state the supported contract for both routes, decide whether
  in-flight import state has to survive a restart, and cover an import end to end.

  **Value Recommender server.** It serves recommendation and rule-generation/status commands and
  consumes the persistent value-recommender queue. Establish whether the Workbench or any external
  client still uses recommendations, then either retain and own that product surface, move the needed
  function to an active service, or retire it after draining or deliberately discarding its queue and
  removing its producers.

  **Submission server.** Retirement is the expected answer, and the inventory that has to precede it
  is what remains. It contains the NCBI, CAIRR, ImmPort, LINCS and AMIA/BioSample submission paths
  and consumes the persistent NCBI submission queue. Inventory actual production submissions,
  credentials, pending and dead-letter work and external commitments. Should one path turn out to be
  live, where that single adapter goes is the decision rather than whether the service stays.

  Any retirement must remove the service from the native and Docker estates, nginx and DNS routing,
  configuration, credentials, queues and producers, service inventory, health and smoke expectations,
  build train, CI, Compose projects, deployment procedures and documentation. A retained service needs
  the opposite evidence: a named owner, current caller, supported contract and meaningful health and
  integration coverage.

- **6. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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

- **7. Complete the remaining backend trust-boundary, transport and credential security work.**

  **Two terminology routes answer an anonymous caller, and that stays.** `POST
  /bioportal/integrated-retrieve` and `POST /bioportal/integrated-search` resolve no user. Measured
  2026-08-31: a request with no `Authorization` header returns `200`. Both reach BioPortal on the
  server's own `apiKey`, so an anonymous caller spends the deployment's BioPortal quota.

  Requiring a credential is not the remedy, for the reason item 8 gives: third-party deployments of
  the embeddable editor call these routes from a browser with nothing to send, so a gate would break
  every host that embeds it. Both methods now carry that reasoning where the check is disabled, and
  the OpenAPI no longer promises a `401` neither route sends. What bounds the cost is the edge rate
  limit in item 8, which covers `/ext-auth/*` and should cover these two on the same terms.

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

- **8. Rate limit the edge in every environment, and turn the authenticated user quotas on.** An
  anonymous caller can spend the deployment's third-party quota, and only the development host
  bounds how fast. The `/ext-auth/*` routes are the clearest case: they proxy seven registries,
  three of them on credentials the deployment holds, and they carry none of their own. `POST
  /bioportal/integrated-search` and `/bioportal/integrated-retrieve` belong in the same limit: both
  are anonymous by the same decision and both spend the deployment's BioPortal key.

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

  **The authenticated half admits requests and refuses none.** A signed-in user's own traffic is
  bounded by a second mechanism, inside the applications rather than at nginx, and it covers what
  the edge limit cannot address by source address. Every route on a shared
  `CedarMicroserviceResource` acquires two token buckets — the user's total, and the bucket for the
  method's class, reads or writes — in one atomic Lua evaluation against the persistent Redis, keyed
  by a hash of the user identifier. The check runs where the resource builds its request context
  from the authenticated user, so an anonymous handler never spends a quota and no header can carry
  one. A refusal answers 429 with `Retry-After`, now on the CORS exposed-header list, and a body
  naming the policy. An unreachable Redis fails open for reads and, once enforcement is on, closed
  for writes. The artifact server marks a verified internal service call exempt, so a proxied hop
  does not charge the user twice.

  Nothing is refused yet, and the numbers are guesses. `cedar-main.yml` ships `mode: observe`, so
  every decision is counted through the `cedar.rateLimits.*` meters and every request proceeds, and
  the rates counted against — 720 requests a minute in total, 600 reads and 120 writes — were
  chosen without traffic to choose them from. So collect those meters from a deployment carrying
  real traffic and set the rates from what they show. Decide the mode per environment, since
  `set-env-internal.sh` carries the overrides commented out and no profile sets one. Then prove a
  refusal end to end: no environment has run under `enforce`, so the 429, its `Retry-After` and the
  write bucket's closed failure mode have passed their unit tests and nothing else.

  **The same buckets already reach the anonymous terminology routes, and only the key is missing.**
  `UserRateLimitFeature` registers its admission filter on every resource assignable from
  `CedarMicroserviceResource`, and `AbstractTerminologyServerResource` is one, so `prepare()` runs on
  `integrated-search` and `integrated-retrieve` and stashes a bucket the request then never spends.
  `UserRateLimits.check` has one call site, `CedarMicroserviceResource`, and it passes the
  authenticated user, which those handlers do not have. `QuotaStore.acquire` takes a string it
  hashes, so the identity it charges need not be a user.

  What that buys is a ceiling on the total, which is the half a per-address limit cannot give: one
  bucket for all anonymous traffic to these routes bounds the deployment's whole BioPortal spend.
  Keying by client address instead would restate the edge limit inside the application and need a
  trust decision about forwarded addresses that nothing here makes today. The edge limit stays as
  the fairness half, because a shared bucket refuses whoever arrives when it is empty rather than
  whoever emptied it. Three details decide whether such a bucket is safe. Both routes are POST, so
  `prepare()` files them under writes: the wrong rate, and the wrong failure mode, since a closed
  failure breaks every page embedding the editor where an open one spends the credential the bucket
  exists to protect. A constant key applied to every shared resource would pool unrelated anonymous
  traffic, so it has to be scoped to these routes and `/ext-auth/*`. And `VERIFIED_INTERNAL_SERVICE`
  already exempts a verified internal hop, which wants confirming for the resource server's own
  calls into terminology.

  **A request is not a call, so the rate cannot be read off CEDAR's meters alone.** The bucket counts
  requests to CEDAR; the quota belongs to BioPortal. One `integrated-search` carries a set of value
  constraints rather than a fixed number of upstream lookups, and `RoutingTerminologyService` answers
  some ontologies from the local store without reaching BioPortal at all, so the multiplier between
  what is metered and what is spent varies per ontology. It also shrinks by design as ontologies pass
  the equivalence gate, which moves the denominator any rate is calibrated against. The deeper limit
  is that the bucket is open-loop: nothing observes the key's remaining allowance, so a rate tuned by
  the minute can still pass a cap measured by the day, and the deployment learns that from BioPortal
  rather than from `cedar.rateLimits.*`. Establish what the BioPortal key is actually allowed, by
  what period, before choosing a rate; if the binding limit is a daily one, spend accounting is the
  instrument and a token bucket only bounds the burst. A 429 to a browser with nothing to
  authenticate also invites a retry loop, so the editor has to honour `Retry-After` for the refusal
  to reduce spend rather than reshape it.

  Done when every environment serving an unauthenticated third-party proxy carries a limit, every
  environment states the mode and rates its authenticated quotas run at, both are recorded where the
  deployment is documented rather than only in the config, and a probe shows each taking effect.

- **9. Put the MySQL connections on TLS, and make the timezone a setting rather than a constant.**
  **Production consequence:** server certificates and client trust have to exist before rollout, and
  messaging, monitor and worker restart into the change. No schema migration.

  Both shipped connection blocks hardcode the same three properties: `useSSL: "false"`,
  `allowPublicKeyRetrieval: "true"` and `serverTimezone: "America/Los_Angeles"`
  (`cedar-main.yml:82` for messaging, `:104` for the log store). The first two together permit
  public-key substitution on an unencrypted authentication channel, which is the part to fix.

  The timezone is a different matter and the comment beside it says why: the aggregator is
  self-consistent under the connection timezone, and forcing UTC would make the connection misread
  the years of existing rows in `log_request`, `log_cypher` and their `_pre284` predecessors.
  Converting those rows is its own piece of work with its own evidence, so this item only moves the
  value out of the constant and into the profile.

  Make all three profile-controlled, ship TLS on and public-key retrieval off everywhere but a
  developer machine, and record the developer exception where the profile is documented. Done when
  no deployment reads the hardcoded values, a non-development stack refuses an untrusted server
  certificate, and the timezone is set by the profile that owns the data it was chosen for.

- **10. Decide the CORS contract per deployment instead of defaulting to `*`.** **Production
  consequence:** a browser application fails cross-origin unless its exact origins are configured
  first, so every environment needs its list before the default changes.

  `resolveCorsAllowedOrigins` falls back to `DEFAULT_CORS_ALLOWED_ORIGINS`, which is `"*"`, whenever
  `CEDAR_CORS_ALLOWED_ORIGINS` is unset or blank
  (`CedarMicroserviceApplication.java:56`, `:316`). Credentials are then allowed unless an entry
  equals exactly `*` (`:339`), so a pattern Jetty's `CrossOriginFilter` accepts —
  `https://*.example.org` — receives credentialed access while the bare wildcard does not.

  **The decision is which origins each deployment serves, and whether a wildcard pattern may ever
  carry credentials.** It has one complication worth settling with it. The embeddable editor is
  hosted by third parties, and item 7 keeps `POST /bioportal/integrated-search` and
  `/bioportal/integrated-retrieve` anonymous for exactly that reason, so those two are called from
  origins CEDAR does not know. A deny-by-default list closes them unless the policy names them.

  Default to no CORS headers rather than to `*`, require the allow-list in each deployment profile,
  refuse credentials for any origin expression containing a wildcard rather than only for the bare
  one, and state what the third-party-embedded routes get. Done when no deployment relies on the
  fallback, each environment's origins are recorded where it is documented, and tests cover blank,
  exact, multiple and wildcard configurations.

- **11. Take stored API keys out of cleartext, and retire the keys minted before random minting.**
  **Production consequence:** this is a production credential migration. It rewrites stored Neo4j
  data and invalidates keys people and integrations hold, so it needs a rotation plan,
  rollback and operator communication. A backup taken before it still contains usable keys and has
  to be protected or expired accordingly.

  A presented key is matched against the cleartext list property: `getUserByApiKey` is
  `WHERE {api_key} IN user.apiKeys` (`CypherQueryBuilderUser.java:128`), and `updateUserApiKeys`
  writes that list plus an `apiKeyMap` object keyed by the key value itself
  (`CypherParamBuilderUser.java:137`). Minting is random now, 32 bytes from a `SecureRandom`
  (`CedarUserUtil.java:19`), but keys created by deployments that predate that change were derived
  and are still valid. The salt that derived them is dead configuration rather than a live secret:
  `cedar-main.yml:297` fills `BlueprintDefaultAPIKey.getSalt()`, which nothing reads — only the
  service name and description of that blueprint are used (`CedarUserUtil.java:50`).

  **The decision is the verifier and the lookup, because they are one choice.** A hashed list cannot
  be matched with `IN`, so authentication needs either a deterministic keyed digest that can be
  looked up directly or an index from a key identifier to its record. Decide that, the hash or KDF,
  the migration window and the rollback, and whether every key rotates or only those that can be
  identified as derived.

  Then inventory the existing key records, store a versioned non-reversible verifier, provide an
  administrative migration and rotation command, revoke the legacy keys, delete the salt setting and
  its environment variable, and confirm no backup or log carries a key. Done when no user node holds
  a key that can be read, authentication verifies without reversing one, and the rotation is
  recorded against the deployments it covered.

- **12. Validate and encode the DOI the DataCite metadata route resolves.** **Production
  consequence:** some path values accepted today answer 400. No data migration.

  `getDOIMetadata` takes the path segment as a URL, keeps `new URI(doiIdUrl).getPath()`,
  concatenates it into the configured endpoint with a query string, and sends the result with the
  deployment's DataCite basic credentials (`DataCiteResource.java:151`). Nothing validates the value
  between the two steps, so traversal and query delimiters surviving a double decode influence an
  authenticated upstream request. The draft-DOI path concatenates the same way after stripping
  quote characters (`:651`). Authorization on the route is `LoggedIn` alone.

  **Decide what the public contract accepts** — a DOI name (`10.x/suffix`), a `doi.org` URL, or
  both — and whether `LoggedIn` is the right gate for a route that spends repository credentials.

  Parse the accepted form into a DOI value, validate registrant and suffix, reject traversal, query
  and fragment syntax, and build every upstream URI with a builder that encodes each path component
  rather than by string concatenation. Done when no DataCite URI in the bridge is assembled by
  concatenation, and tests cover traversal, an injected query delimiter and both accepted input
  forms.

- **13. Bound the application-log queue, and let its consumer keep up.** Application logging can
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

  Those figures count what reached Redis, and some messages never do. The producer borrows from a
  pool of eight connections with a 100 millisecond deadline and drops the message when none comes
  free, which a comment in `QueueService` explains as keeping a reporting-only queue from exhausting
  the request threads. A 30-minute soak on 2026-09-04 shed 182 messages in the resource server and
  15 in the artifact server. Two things follow. The production rate above is a floor rather than a
  measurement, because it counts arrivals and not attempts. The ceiling described below would also
  be the second shedding mechanism rather than the first, so it has to say whether the existing one
  stays. That one sheds whichever message happens to find the pool full, which is no policy at all.

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

- **14. Ship INFO as the default log level, and bound what a log file can grow to.** **Production
  consequence:** diagnostic detail drops after rollout, so choose the size limits against production
  capacity before deploying. Nothing migrates.

  Fifteen shipped `config.yml` files set `org.metadatacenter: DEBUG`, and the artifact server sets
  `org.metadatacenter.config: DEBUG` beside it. Every console appender takes `threshold: ALL`, and
  every file appender archives by day with no size limit: `maxFileSize` and `totalSizeCap` appear in
  no configuration in the estate. A busy day therefore writes one file that nothing bounds, and
  request-path DEBUG buys I/O that nobody reads. Archive depth already disagrees, measured
  2026-09-10: twelve services keep `archivedFileCount: 30`, and messaging, monitor and worker keep
  5.

  Nothing connects these files to the Redis queue of item 13. `AppLogger` hands every message to
  `AppLoggerQueueService.enqueueEvent`, which pushes it to Redis without consulting a log level, so
  shipping INFO takes nothing off that queue and a ceiling on the queue takes nothing off these
  files. What bounds each differs as well: a queue is bounded by what its consumer can keep up with,
  a file by what the disk can hold.

  Ship INFO with an environment-controlled override for a service under investigation, put
  `maxFileSize` and `totalSizeCap` on every file appender, and use one retention policy across
  services rather than one per configuration file. Done when no shipped configuration sets DEBUG for
  a whole package, every file appender carries both limits, and the retention policy is recorded
  where the deployment is documented.

- **15. Separate CEDAR dependency convergence from the Keycloak provider platform lock.** The eleven
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

- **16. Stop the resource server shipping the Keycloak server SPI.** Every Keycloak login makes
  CEDAR's event listener post the event to the resource server's `/command/auth-user-callback`, which
  provisions the user: the user record, membership of Everybody and the home folder. The endpoint
  reads one field of the event, `clientId`, to confirm the login came through CEDAR's own client. It
  reads that field by deserializing the whole event into Keycloak's `org.keycloak.events.Event`, a
  class in `keycloak-server-spi-private`. `cedar-resource-server-application` therefore declares
  `keycloak-server-spi` and `keycloak-server-spi-private` at compile scope, and 794 of the 1,333
  Keycloak classes in its shaded jar come from those two jars, among them the `models`,
  `authorization`, `authentication`, `broker` and `storage` packages. Nothing else in the service
  uses them.

  Two costs follow. The resource server ships part of an unsupported Keycloak 22.0.4 server, the
  code the advisories against `keycloak-server-spi-private` and `keycloak-services` describe, and any
  scanner that reads the jar reports it. That code does not run as a Keycloak server, so the practical
  exposure is small, but it has no reason to be there. The parse also uses the strict mapper, which
  refuses unknown properties. A field that a later Keycloak adds to `Event` would therefore fail every
  login's callback and stop new users being provisioned, so the upgrade in item 3 would meet that
  failure in a service that should not have to change with the Keycloak server.

  Read the event into a CEDAR type that declares `clientId` and ignores every other property, and
  remove both SPI dependencies from the resource server's POM. The documented request schema,
  `AuthUserCallbackRequest` in `openapi-base.yaml`, already says that only `clientId` is read and
  admits other properties, so the endpoint's contract does not change. The event listener keeps its
  `provided` SPI dependencies, which are correct for a provider that Keycloak loads. The resource
  server keeps `keycloak-core` and `keycloak-adapter-core` through
  `cedar-auth-operations-keycloak-library` for its token checks, and those follow item 3.

  This closes no Dependabot alert. The alerts are raised against `cedar-parent`, which manages the
  Keycloak versions, and only item 3 clears them.

  Done when a unit test parses a serialized Keycloak login event that carries properties the CEDAR
  type does not declare, and provisions only for CEDAR's own client; when the shaded jar contains no
  class from either SPI jar; and when a redeployed resource server passes the browser smoke, whose
  Keycloak login posts this callback. The REST smoke does not exercise the endpoint.

- **17. Answer a superseded artifact write correctly, and keep every compensation record durable
  under concurrent writes.** Two races in the resource server's restore outbox appear whenever
  conditional PUTs to one artifact follow each other closely. Both came with the change of
  2026-09-15 that made the compensating write durable. The `hotset` k6 profile reproduces them on
  every run, and on 2026-09-25 it failed 118 of its checks this way.

  The outbox keys a restore job by artifact identifier alone, so concurrent writes to one artifact
  share one job. A write that commits to the artifact server records its job before the graph
  update. When a second write, holding the new ETag, commits next, its `prepare` matches the same
  node and replaces the first write's `jobId`. The first write's graph update is conditioned on its
  own `jobId` through `ArtifactRestoreTransaction.lockForGraph`, finds no such job and returns null,
  and `AbstractResourceServerResource` answers `500`. The first write did succeed and was then
  superseded, so it should receive the `200` its write earned rather than a server error. The 118 failures were 47 field, 30 instance, 25 template and 16 element PUTs. No stored
  state was damaged, because the superseding write's graph update ran.

  The second race loses durability silently. `Neo4jArtifactRestoreOutbox.prepare` matches an
  existing job and then reads its `protocolVersion`. When a concurrent graph update deletes that job
  in between, the read returns null, `asInt(0)` turns it into 0, and the job is refused as a legacy
  one needing inspection. `ArtifactRestoreCompletionService.prepare` logs the refusal and lets the
  write continue without a durable compensation record, which is the window the 2026-09-15 change
  exists to close. The same `hotset` run logged 1,764 such refusals.

  A fix must give a superseded writer the status its write earned, must never treat a vanished job
  as a legacy one, and must leave every successful artifact write with a durable compensation record
  until its own graph update commits. Done when a focused test reproduces each race and passes, and
  when `hotset` passes at 100% with no compensating-write errors in the resource-server log.

- **18. Take the search-permission relay off the request thread.** Every artifact or folder move,
  ACL change and group-membership change appends a search-permission event to the durable outbox and
  then relays the pending batch before the request returns (`SearchPermissionEnqueueService`, since
  `39af8ad0` of 2026-08-29). `relayPending` is `synchronized`, and `Neo4jSearchPermissionOutbox.pending`
  takes the single `CedarSearchPermissionOutboxRelayLock` in Neo4j and scans every outbox node for
  malformed records while holding it. Concurrent permission-changing requests therefore queue
  behind one another in the resource server.

  The REST soak measures the cost. At fifty VUs, conditional moves and artifact and folder ACL
  updates reach a p95 of about 3.6 s against a 1.5 s threshold; on 2026-09-25 their median was
  1.58 s and their maxima near 10 s, while artifact conditional PUTs stayed near 650 ms. The latency scales with concurrency:
  about 170 ms at five VUs, 640 ms at fifteen and 3.8 s at fifty. Every valid 50-VU soak recorded
  since 2026-09-05 shows these figures, so the soak has not passed since the change. The runbook's
  REST performance section holds the measurements.

  The outbox exists so that a committed permission change cannot be lost before the search index
  follows it, and that guarantee must stay. What has to change is where the relay runs and how much
  one caller does. The request needs to commit its outbox event and return. The managed relay, which
  already runs every five seconds, or a prompt signal to it, can deliver the event. The malformed-record
  quarantine does not need to run inside every relay, and it does not need to scan under the global
  lock. The relay's cross-process lock may stay if resource and group servers still share the
  outbox, but it should serialize only the relay, not the requests that produce events.

  Done when the fifty-VU soak passes its move and ACL route thresholds and every other gate, when the
  permission-outbox smoke (`npm run smoke:permission-outbox`) still proves that a committed event
  survives a relay failure, and when search reflects a move or ACL change within the relay's
  five-second interval.

- **19. Converge on one pagination encoding.** Ten paging shapes are in service across seven
  applications. The artifact, resource and OpenView listings all build on the same `PagedQuery` and
  `LinkHeaderUtil`, so nothing in the code forces even the split between those three. The shapes
  differ on three independent axes: the request parameters, the page base, and where the response
  metadata goes. A client library that can page one of them cannot page the rest.

  - **`limit`/`offset`, with `Link` and `Total-Count` as headers and the body kept to the
    collection.** The artifact server's template, element, field and instance listings
    (`AbstractArtifactCrudResource.java:284`). No other server sends those headers. An offset at or
    past the total answers 400 rather than an empty page
    (`AbstractArtifactServerResource.java:105`).
  - **`limit`/`offset`, with the same link set in the body under `paging` beside `totalCount`.**
    Folder contents, contents-extract, search and categories on the resource server
    (`AbstractSearchResource.java:157`, `FolderContentsResource.java:319`,
    `CategoriesResource.java:145`), and the OpenView server's folder listing
    (`FoldersResource.java:123`).
  - **An opaque forward-only continuation.** `?continuation=` on `/search-deep`, answered with
    `continuation` in the body and first and next links alone in the `paging` block. The token binds
    the user, a query fingerprint, an OpenSearch point-in-time and `search_after`, and a request
    carrying both a continuation and an offset is refused (`AbstractSearchResource.java:99`,
    `SearchContinuation.java`).
  - **One-based `page`, with `page_size` and `pageSize` both accepted and BioPortal's flat body
    fields.** The terminology server's proxy and local-store routes answer `page`, `pageCount`,
    `pageSize`, `totalCount`, `prevPage` and `nextPage` (`PagedResults.java:8`,
    `SqliteTerminologyService.java:208`). The answer's `pageSize` reports the size of the page
    returned rather than the size asked for.
  - **One-based `page` and `pageSize` in a POST body, with a result block per constraint type.**
    Versioned `POST /search` gives each block its own `totalCount`, `countCapped`, `page` and
    `pageSize` (`SearchRequest.java:22`, `VersionAwareSearchService.java:120`). `POST
    integrated-search` also pages from the body, and answers the flat BioPortal-shaped fields.
  - **Zero-based `page` and `pageSize`, echoed back with `found`, no links and no total.** The
    bridge server's `/search-by-name` across the seven external authorities
    (`ExternalAuthorityResource.java:124`). No other route in the estate bases `page` at zero.
  - **A zero-based `offset` against a page size the server fixes.** `GET /search/hierarchy` returns
    at most `CHILD_LIMIT` children, 50, and echoes the offset so a client can ask for the rest. It
    takes no page size and reports no count (`VersionAwareSearchResource.java:132`,
    `HierarchyResponse.java:29`).
  - **A keyset cursor in a POST body.** The monitor server's log query takes `limit` and a
    `"<iso>,<id>"` `cursor`, and answers `nextCursor`, null once the walk is exhausted
    (`LogQuerySpec.java:29`, `LogQueryResults.java:27`). The cursor names an ordered column rather
    than carrying an opaque token, so it is a second cursor encoding rather than the same one.
  - **`limit` as plain truncation.** The log explorer and usage routes take a limit and no offset,
    which leaves row N+1 unreachable (`LogExplorerResource.java:72`, `LogUsageResource.java:112`).
  - **An unpaged collection with a count.** The messaging server returns every message and a `total`
    (`MessagesResource.java:105`).

  **Three divergences sit underneath the shapes, and the first is a defect however the decision
  goes.** The `page_size`/`pageSize` alias resolves by argument position, and the two route families
  pass the arguments in opposite orders: `SearchResource` binds `page_size` to the first parameter,
  while `ClassResource`, `ValueResource` and `ValueSetResource` bind `pageSize` to it
  (`AbstractTerminologyServerResource.java:82`). A request sending both spellings therefore gets a
  route-dependent answer, and the OpenAPI text promises only that either spelling is accepted.
  Defaults and maxima are set per surface and shared by none: 100/500 on the resource server, 20/500
  on the artifact server and on categories (`cedar-main.yml:360`), 50 with a silent clamp in
  terminology, 100 with `pageSize > 1` enforced on the bridge, and a fixed 50 for a hierarchy's
  children. Bad input is refused three ways, since `PagedQuery` answers 400, terminology clamps, and
  the bridge answers 400 with a message of its own.

  **The decision is which encoding wins, and it has to come first.** Headers are the conventional
  answer and the artifact server already implements them alongside the ETag, `If-Match` and `Vary`
  contract that the rest of the estate is measured against, so moving it would move the reference
  away from convention. A body field would instead move the artifact server and terminology onto the
  resource server's shape. Nothing in the code decides this; it is a product call about what a CEDAR
  client should look like.

  Six of the ten shapes page by number or offset, and those converge on whichever encoding wins. The
  two cursor walks are the exception and have to be documented as one, because a continuation and a
  keyset cursor buy something an offset cannot: a walk of a whole result set at one request per
  page. Truncation without an offset and the unpaged listing are gaps to fill rather than encodings
  to choose between.

  Whichever wins, deliver it additively first. Emit the chosen encoding everywhere alongside what each
  server sends today, document it as the supported form, and withdraw the others in a later release.
  Only the withdrawal breaks a caller, which is what keeps this off a flag day. The alternative is one
  coordinated release across the Template Editor, the embeddable editor, the term picker, the
  designer, `cedar-cli`, the four MCP servers and `ops/e2e`, which the lockstep policy allows and the
  pinned check inventory in `rest/expected-checks.json` makes tractable.

  Clients are split along the same lines already. The Template Editor's controlled-term autocomplete
  and CEE's integrated search read the flat page-number fields, the Template Editor walks the
  `paging` block for its listings, the term picker reads the versioned per-type blocks, and the
  designer sends `page_size` on the proxy path and `pageSize` in the versioned body
  (`autocomplete.service.js:91`, `integrated-search-response.ts:11`, `search-types.ts:168`,
  `terminology.service.ts:107`). The flat page-number fields therefore have to survive until the
  Template Editor and CEE move, whichever encoding wins.

  One piece of the work is already done. `Link` and `Total-Count` are on the CORS exposed-header
  list, so a browser can read them cross-origin wherever they are sent
  (`CustomHttpConstants.java:25`).

  Done when the alias resolves centrally rather than by argument order, every page base and default
  is documented, and one encoding is documented as the supported form and emitted by every route
  that pages by number or offset, with the two cursor walks recorded as the stated exception. The
  REST smoke has to assert the canonical form on a route from each application that serves one; it
  covers the two `limit`/`offset` shapes today (`rest/suites/pagination.mjs`). Every superseded shape
  is then either withdrawn or carries a recorded date for withdrawal.

- **20. Choose the response timeouts from the durations the request log now carries, and give a
  user-facing call a deadline.** Outbound calls are bounded by what the call is: an interactive
  class for a hop to the next CEDAR service, a batch class for a job nobody waits on, and an
  external class for a registry CEDAR does not operate, each with its own three timeouts and pool,
  all of them configurable under `http:` in `cedar-main.yml`. What remains is the part that needed
  data rather than code.

  **The numbers are still arithmetic rather than measurement.** Every response timeout in force is
  the value the estate ran on before any of it was configurable, carried forward deliberately:
  choosing one properly needs latency data, and none existed, because no server configured
  `requestLog` and Dropwizard's default access format records no duration. Each server now logs
  access lines ending in `%D` to `$CEDAR_HOME/log/<server>/access.log`. Collect a week and set the
  values from the p99s, per hop where the hops differ. The artifact server's is the one most likely
  to be wrong, since a large instance write with validation is the plausible outlier, and it already
  has its own `servers.artifact.timeouts` to take the measured value.

  **A hard user-facing bound needs a deadline rather than per-hop values.** Updating an artifact
  makes two proxied calls in series, and three when compensation runs, so the client's worst case is
  the sum of whatever each hop is allowed. Only a budget stamped on `CedarRequestContext` and
  decremented across the hops can say that the second call gets what is left of fifteen seconds.
  Worth doing when a response-time guarantee is promised, not before.

  **That deadline is also what a lease-timeout retry is waiting for.** A GET repeats once on a
  connect failure or a connection closed before any response, and a PUT or DELETE carrying
  `If-Match` does the same; a response is never repeated, whatever its status, and neither is a
  response timeout. A lease timeout is the one answerless failure deliberately left un-repeated: the
  pool is saturated by definition, so an immediate repeat queues against the same full pool and
  doubles the wait the call site was promised. With a budget to come out of it becomes safe, and the
  rule can be revisited then.

- **21. Run the whole-stack tiers in CI, and gate the workflow train the way the CLI is gated.**
  **Production consequence:** none at runtime. CI needs a deployable environment, credentials, time
  and somewhere to keep the reports.

  Neither smoke tier runs in GitHub Actions. `cedar-development` carries six workflows —
  `angular-build-isolation-canary`, `build-train`, `publication-preflight-canary`,
  `realm-seed-hardening`, `release-tooling-ci` and `snapshot-freshness` — and none of them invokes
  `cedarcli test e2e`, the REST tier or the browser tier. No workflow in any other repository does
  either, and per-repository CI proves a different thing: that each Java repository compiles and its
  unit and embedded integration suites pass.

  The gate is also entered two ways with two answers. `cedarcli publish train` and `release
  plan|start` refuse a source no passing run covers, but `build-train.yml:94` calls
  `python3 controller/ops/build_train.py preflight`, which names no smoke gate, so a train
  dispatched through Actions is ungated while the same train dispatched from the CLI is not.

  Add a scheduled and manually dispatchable whole-stack workflow that brings up a known source, runs
  every tier through `cedarcli test e2e`, and retains its report as an artifact. Make the workflow
  train call the same gate implementation the CLI calls rather than a second preflight path. Done
  when every tier runs unattended on a cadence, their reports are retained, and a train dispatched
  through Actions is refused on the same evidence that refuses one dispatched from `cedarcli`.

- **22. Take the dependency upgrades that need code changes.** The versions that could move without
  consequence have moved. What stayed behind stayed deliberately, and it separates into work to do,
  versions that follow something else, and versions whose newest release is not a final.

  **The upgrades that need code or test changes.** Each of these is a change to make rather than a
  version to raise, which is why none of them rode along with a sweep.

  - **json-schema-validator 1.5.9 to 3.0.7.** Two major lines on the library that decides which
    stored artifacts CEDAR accepts. A change in validation behaviour is a change to the product, so
    this one is settled by differential testing against production artifacts, not by a green build.
  - **OWLAPI 4.5.9 to 5.5.1.** Ontology semantics, where a behavioural difference does not show up
    in a compile.
  - **jaxb2-maven-plugin 4.1.0 to 4.2.0.** A code generator whose only consumer is
    `cedar-cadsr-tools`, so what has to be reviewed is the sources it emits rather than the version.

  **Versions that follow a locked server or framework.** Six sit here: the Neo4j driver 5.28.14 to
  6.2.1, MySQL Connector/J 8.4.0 to 26.7.0, the Mongo driver 5.1.2 to 5.11.1, the OpenSearch client
  2.19.2 to 3.8.0, the Lucene pin 9.12.1 to 10.5.1, and the Neo4j test harness 5.3.0 to 2026.07.1.
  Client libraries are free to move in general, but a driver crossing a major has to be proven
  against the pinned server it talks to, so these are sequenced behind item 3 rather than taken on
  their own. The Mongo driver is the exception: 5.11.1 stays inside major 5, so nothing about it
  needs proving against the pinned server, and it is grouped here only to move with that server's
  own upgrade. Keycloak 22.0.4 to 25.0.3 is item 3's own, and RESTEasy 6.2.4 to 7.0.4 is held by the Keycloak
  client stack, which items 3 and 15 own.

  Embedded Mongo 4.20.0 to 5.0.0 belongs here too, and it is the deployed Mongo it follows rather
  than a framework. The code cost is one import, since flapdoodle moved `de.flapdoodle.reverse` to
  `de.flapdoodle.commons.reverse`, and `EmbeddedCedarMongo` is the estate's only consumer. The
  obstacle is the binary: 5.0.0 offers no mongod 5.0 package for macOS on ARM, so every suite that
  starts the embedded store dies at `could not resolve package for
  V5_0:Platform{operatingSystem=OS_X, architecture=ARM_64}`, while 6.0, 7.0 and 8.0 all start.
  MongoDB published no macOS ARM build before 6.0 and 4.20.0 resolves one anyway; 5.0.0 does not.
  Taking the upgrade therefore means running the suites against a different major from the deployed
  5.0.31, which is the one thing `EmbeddedCedarMongo` exists to avoid. It moves with item 3.

  Logback 1.6 belongs here rather than among the upgrades to make, and SLF4J is not what holds it:
  every 1.6 release builds against slf4j 2.0.18, which the estate already carries. Dropwizard does.
  Raising logback to 1.6 fails before a test runs — `LogbackAccessRequestLayout` reads
  `DEFAULT_CONVERTER_MAP`, which logback 1.6 removed, so every Dropwizard-booting suite dies in a
  class initializer. `mvn test -Dlogback.version=1.6.3` in a server module reproduces it, and an
  enforcer rule in `cedar-parent` now fails the build there rather than inside a test JVM, where
  the error names a logback-access class for a field that lives in logback-classic.

  What the hold costs is only what 1.6 itself carries, because the 1.5 maintenance line is still
  open and `cedar-parent` runs on it, ahead of the 1.5.33 that Dropwizard 5.0.2 pins.
  logback-access is held by its own build rather than by that rule: its 2.0.15 release compiles
  against logback-core 1.6.3, so it cannot move while 1.6 is banned. Both wait on Dropwizard
  shipping a line built against 1.6.

  **Versions that follow whatever pulls them in.** The transitive block exists so that every module
  resolves one version of an artifact nothing here depends on directly, which makes these five
  nobody's choice to raise: HK2 locator 3.0.6 to 4.0.2, Jandex 2.4.3 to 3.3.1, Netty 4.1.138 to
  4.2.18, protobuf-java 3.25.5 to 4.36.1 and Reactor Core 3.5.20 to 3.8.7. Each belongs to a
  framework above it, so each moves when Jersey, Hibernate, the Neo4j driver or OpenSearch moves.
  Raising one on its own would pin a version its owner does not expect.

  **Versions whose newest release is not a final.** These have no final to move to: HttpCore
  5.5-beta2 and HttpClient 5.7-alpha1, Hibernate 8.0.0.Beta1, Jedis 8.1.0-beta1, SLF4J
  2.1.0-alpha1, Log4j 3.0.0-beta2, Jersey 5.0.0-M1, Angus Activation 2.1.0-M1, and the Jakarta
  activation, persistence, servlet, validation and XML binding milestones. The old javax jaxb-api's
  only newer version is a 2018 build that was never finalized, so it stays too.

  Read that list with suspicion, because the report it came from hides releases.
  `versions:display-property-updates` names only the newest version an artifact has, so a
  pre-release at the head conceals every stable release behind it. Seven Maven plugins sat in this
  group behind 4.0.0 betas, and Site behind a milestone, until each was checked against the
  published metadata and turned out to have a current stable release — which is how the compiler
  plugin reached 3.16.0 from a 2018 build, and Site 3.22.0. Every entry above was gathered the same
  way and is unverified in the same way. Read an artifact's
  `maven-metadata.xml`, or `versions:display-plugin-updates`, which reports the newest release a
  given Maven version can actually use, before concluding that something cannot move.

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

- **23. Give the public CEE release a CLI route.** Publishing `cedar-embeddable-editor` to npmjs is a
  runbook of about twenty-five commands across `develop`, a pull request, `main`, the registry, a
  tag, the development-state restore and the train baseline refresh. Release 2.0.6 took an hour of
  operator attention for two minutes of gate time, and CEE has shipped four public versions in a
  week. Build `cedarcli release cee` as a resumable, ledger-backed route like the platform release:
  pin the chosen public model, write the changelog entry, run the gate, open and merge the pull
  request, rebuild and publish from `main`, verify the registry with a retry for the seconds npm's
  read replicas lag behind a publish, tag, restore the next development version with the chosen
  model snapshot, refresh the CEE lock baselines, and stop at each remote step it cannot prove. The
  provenance comparison the platform release already performs verifies the published tarball. Once
  the command exists, rewrite the npmjs runbook into a description of what it does and where it
  stops.

- **24. Keep an attribute-value child's declared property IRI in both JSON writers.** Both model
  libraries read such a child's property IRI out of a template's `@context` and then decline to write
  it back as JSON, so a read-and-write cycle over `template-022.json` loses
  `https://schema.metadatacenter.org/properties/d01cb533-265c-474a-95f3-9afb4616a6e1` from the
  `ATTR-Value` mapping the source document carried. Both YAML writers keep it, so one model yields a
  document in one format that names the child's property and a document in the other that does not.
  Three attribute-value children carry one, across templates 022 and 029, and all three are minted
  identifiers rather than terms an author chose.

  The loss is recorded rather than repaired. `JSON_TEMPLATE_ROUND_TRIP_DIVERGENCES` grants template
  022 one round-trip error under the reason `legacy attribute-value context mapping is absent`, and
  the cross-library parity gates stay green because both libraries drop it in the same place.
  `ParentSchemaArtifact.getChildPropertyUris` excludes static and attribute-value children by name,
  and the TypeScript writer matches it.

  The exclusion's stated reason is sound as far as it goes: an IRI is identity, the repository assigns
  it on upload, and deriving one from a child's key would assert an identity nothing granted. That is
  an argument against minting an IRI, not against preserving one a document already carries.

  **The artifact server already preserves one.** On a create and on an ordinary update,
  `LinkedDataUtil.addChildPropertyIris` in `cedar-config-library` mints a mapping for every child
  that lacks one, skips attribute-value children along with the static kinds, and never removes a
  mapping already present. `repairInheritedDefects` removes an inherited child mapping only when it
  is not a single absolute IRI, and the three production entries are well-formed IRIs. A verbatim
  write stores the document as sent. The server therefore neither mints such an IRI nor discards
  one, and has kept these three through every save; only the libraries' JSON writers drop them. The
  libraries should do what the server does.

  **One document shows the shape with a term an author chose, and no corpus case covers it.**
  `template-033-original.json` carries it twice, on `Data Characteristics Table in Key-Value Pairs`
  and `Data File Descriptive Key-Value Pairs`, and its values are
  `https://w3id.org/radx/radmo/dataCharacteristicsTableInKeyValuePairs` and
  `https://w3id.org/radx/radmo/auxiliaryMetadataKeyValuePair` rather than minted identifiers. The
  shape cannot be treated as debris in general, whatever the three minted entries turn out to be.
  The canonical `template-033.json` has no attribute-value child at all, because the case was
  restructured in April 2024, so nothing in the corpus exercises an attribute-value child carrying a
  vocabulary term.

  This is not the question a requirement on the same type answers, and the difference is the whole of
  it: a requirement has nowhere to go in the JSON form, because an attribute-value field carries no
  `_valueConstraints` node at all, so the YAML writers record nothing. A property IRI has somewhere to
  go, is there in production, and is being dropped on the way out.

  The work is in both libraries. `getChildPropertyUris` and the TypeScript writer should emit an
  attribute-value child's mapping when the model holds one, and still mint none. The template 022
  entry leaves `JSON_TEMPLATE_ROUND_TRIP_DIVERGENCES`, and a corpus case adds an attribute-value child
  carrying a vocabulary term. The three children's generated fixtures change with it, and the Java
  library's corpus verifier reports them stale until they are regenerated. Whether the three minted
  entries are worth keeping is a separate question about production data, not about the writers.

- **25. Decide what an ordinary write may change about the artifact it stores.** Every non-verbatim
  write is normalized before it is validated, and two different things travel under that one name.
  One is minting: a child identifier, a property IRI for an attribute the author named, an element
  occurrence identifier, and the JSON Schema `title` and `description` derived from `schema:name`.
  That is identity the repository owns rather than a client, and it stays. The other is
  `LinkedDataUtil.repairInheritedDefects` in `cedar-config-library`, which removes a defect only
  where the request carried it unchanged out of storage and leaves a newly introduced one for
  validation to reject. That half was built for artifacts written before the rules hardened, so it
  has a population and an end, and the population is nearly gone.

  **Retire each compatibility branch as its population reaches zero.** On templates and elements
  there is almost nothing left for it to do. The 2026-09-08 corpus audit found 8,402 artifacts
  carrying an empty `pav:derivedFrom` and 418 an unusable child property IRI; the 2026-09-12 audit
  of every template and element reports neither, and one artifact with a missing child `$schema`.
  The instance branches are the live ones, measured over all 150,640 instances on 2026-09-16:
  `occurrence-id-unusable` in 120 artifacts over 833 occurrences, `attribute-property-iri-missing`
  in 58 over 1,029, `orphan-property-iri` in 7, and `attribute-name-blank` in 4. Delete a branch
  once its count is zero, so that shape meets a refusal rather than a silent accommodation, and
  record the change where the API is documented: a caller that has been relying on the
  accommodation starts receiving a 400.

  **A resave repairs almost nothing, so do not reach for it as an instrument.** The update path
  normalizes and then validates, answering 400 when the result is invalid
  (`TemplateInstancesResource.java:433`), so only an artifact that is already valid after
  normalization can be written. In the 2026-09-16 baseline, of 1,047 invalid production instances,
  2 had nothing wrong but
  a missing occurrence identifier, which is the one defect this path does repair, by removing the
  unusable inherited value and minting a replacement. The rest fail on what no normalizer touches:
  799 carry a key their template does not declare, 715 lack a child it requires, and 166 carry a
  property IRI their template replaced with a vocabulary term in a later edit. About 45 instances
  are valid while carrying a repairable condition and would go through, but an ordinary write also
  calls `stampProvenanceForPut` (`AbstractArtifactCrudResource.java:408`), so each would record a
  modification nobody made. That is the reason `?verbatim=true` exists, and it is why the remaining
  production work belongs to a verbatim rule rather than to a bulk resave.

  **Separate the one step that tightens a contract rather than repairing a document.**
  `addChildPropertyIris` calls `requireChild` for every mapped child of every template and element
  it writes (`LinkedDataUtil.java:684`), adding the child to `@context.required` whether or not the
  stored artifact ever declared it. That changes what an instance must carry, which is not a repair
  of the artifact being saved but a new demand on documents nobody is looking at. Measured
  2026-09-12, 2,218 artifacts are missing those entries across 29,087 child paths, 458 of them
  templates rather than elements, so editing one of those templates through any client tightens its
  contract silently. `ops/repairs/ctxreq_at_risk.py` exists to weigh exactly this before a repair
  run, by validating every instance a template already has against the proposed body; the save path
  performs the same tightening with nothing weighed. Decide whether the write should carry that
  check, stop adding entries a stored artifact never had, or state the tightening as the contract
  and accept that a template edit can invalidate instances.

  **Warn authors before a template edit invalidates existing instances.** Changing a property's
  IRI or narrowing a field's allowed representation can invalidate documents that were valid when
  entered. Nothing propagates that change to existing instances or warns the author. Whatever is
  decided about `requireChild`, check the dependent population for any template edit that narrows
  what an instance may hold.

  Done when the compatibility branches that have no population are gone, each remaining one names
  the count that keeps it, an ordinary write no longer tightens a contract without the instance
  check or an explicit decision to do so, and an author editing a template is told what it does to
  the instances that already exist.

### Shared Libraries

- **26. Render a sparse instance to JSON against its template.** A CEDAR JSON instance must carry
  an entry for every field its template defines, unset ones included, because the template's JSON
  Schema marks those properties `required`; an unset literal renders as `{"@value": null}` and an
  unset IRI as `{}`. The YAML instance form is the opposite, and correct as it stands — it omits an
  unset field entirely. Rendering a sparse instance model to JSON therefore produces an incomplete
  JSON instance, and a YAML-to-JSON translation that is to produce a valid one must re-add the
  empty placeholders, which takes the template, since only it says which fields exist. The
  asymmetry is an old model decision the group is not fond of, and it stays until the next model
  iteration.

  `cedar-artifact-library` already has the template-driven traversal in `InstanceInflater` and
  `EmptyFieldInstances`, recursive elements included, and MCP callers compose it with rendering
  themselves. What is missing is the rendering API that does both, such as
  `renderTemplateInstanceArtifact(template, sparseInstance)`. The existing one-argument renderer
  cannot inflate, because an instance alone does not carry the schema that says which fields are
  absent.

  Done when a YAML-to-JSON caller renders a valid CEDAR instance through one call, and no caller
  composes inflation and rendering by hand.

- **27. Take the parse-library tree type out of the public reader and renderer API.** This is a
  major-version change. `JsonArtifactReader` and `JsonArtifactRenderer` take and return Jackson's
  `ObjectNode`, and `YamlArtifactReader` and `YamlArtifactRenderer` take and return JDK
  `LinkedHashMap<String, Object>` trees, so the tree representation is part of the public contract
  and leaks even into the shared `ArtifactReader<N>` type parameter. A caller must obtain or build
  one of those trees before it can call the library at all.

  Move the boundary to the wire format itself. `readTemplate(String)` and
  `renderTemplate(artifact)` returning `String`, with the element, field and instance
  counterparts, parse and serialize internally. That hides both parse libraries, gives JSON and
  YAML one symmetric `read(String)` and `render(Artifact)` contract, and matches what callers
  actually hold, which is text from a file or an HTTP body. The internals do not change: the
  String methods prepend a parse and append a serialize. A bespoke `JsonNode`-style abstraction
  interface would trade one library coupling for a hand-rolled tree API plus adapters that callers
  must still populate, so it is not the answer.

  Migrate additively. Add the String methods, mark the node-typed ones
  `@Deprecated(forRemoval = true)` delegating to them, and remove those at the next major version.
  Two cleanups fall out: the keyed, tree-returning render overloads such as
  `renderElementSchemaArtifact(key, artifact)` are internal child-composition helpers and can
  become package-private, and the `ArtifactReader<N>` type parameter disappears. A caller that
  wants the rendered artifact as a tree, to embed in a larger document or to validate it without
  re-parsing, loses direct access. If that need proves real, keep one explicitly
  parse-library-typed opt-in method, so the coupling exists only where it is consciously chosen.

- **28. Translate between an instance and RDF.** The model is designed so an instance maps to RDF:
  the schema's `instanceType` gives each instance or element its `rdf:type`, each child's
  `propertyIri` gives the predicate, the instance `id` is the subject, and field values are the
  objects, a controlled term or link contributing its IRI and a literal contributing a plain or
  typed literal. The library implements neither direction. Its renderers are JSON, JSON-LD
  `@context`, JSON Schema, YAML, Excel and UBKG, and none produces a triple graph.

  The JSON instance form is already JSON-LD, carrying `@context`, `@type` and `@id`, so an
  external JSON-LD processor can serialize it as RDF. A model-level translator would drop that
  dependency and, more to the point, work from the sparse YAML instance form, which relies on its
  template for the predicates and types the instance itself does not carry. Add a template-driven
  RDF renderer taking an instance model and its template and, if round-tripping is wanted, an RDF
  reader taking RDF and a template. The "Mapping to RDF" section of the CEDAR YAML specification
  documents the intended mapping.

## Production Data

- **29. Resolve the remaining production artifact defects and review semantic migrations.**
  Classify the remaining invalid instances by their actual schema declarations, then repair only
  transformations whose meaning is established. A missing `@id` in a controlled-term field is a
  missing entered term, not an element identity to mint. Multiple populated occurrences cannot be
  reduced to one without a decision. Empty representations and populated data need separate rules,
  each with a narrow invariant and validation of the complete candidate.

  Refresh the broader retained 561-instance/211-template inventory against current stored templates
  before reporting a current total. Distinguish instance defects from noncanonical declarations against
  Java's model. Reconcile any TypeScript disagreement with Java and preserve entered information
  when a stored representation must migrate; check every dependent instance before changing a
  template declaration.

  These counts cover the flagged subset, not the corpus. An instance clean on both axes at the last
  full walk is not in them, and neither is anything created since.

  **Resolve the remaining schema conversion and source issues.** Outstanding findings from the
  151,835-schema production inventory freshly re-read on 2026-09-25:

  | Remaining issue | Schema artifacts |
  | --- | ---: |
  | Indexed artifacts whose typed GET returns 404, including on the final retry | 6: 1 template, 1 element, 4 fields |
  | TypeScript strict-reader diagnostics on Java-validator-valid source schemas; conversions still succeed | 48: 44 context additional-properties declarations and 4 missing-child requirements; fresh full audit on 2026-09-25 |

  Reconcile the unavailable search/graph entries with the store; the legacy `.net` template also
  returns 404 under the corresponding `.org` ID.

  Reconcile instance-context `additionalProperties` declarations in 44 remaining templates.
  For 42 of them, 195 dependent instances block tightening:
  62 currently valid instances contain populated undeclared fields, while 133 already fail
  validation. Keep the 62 extra-field cases unresolved; do not delete values or mappings, invent
  declarations, or infer renames to satisfy the canonical rule.
  The other two, Human Cognitive Neuroscience Data and FAIR-EuMon metadata template,
  need document/graph DOI reconciliation: the write endpoint rejects their unchanged document DOI
  because it reports a null stored DOI. Preserve the DOI while resolving that inconsistency through
  [DOI minting recovery](./FRONTEND-ROADMAP.md#doi-minting-recovery), which tracks the affected IDs,
  rejection details and regression requirements.
  Missing child names in `required` remain in four templates: SWATH-DIA Experimental
  Specifications, Cell, Chemical Tool and Expression. Resolve their 24 blocking instances before
  tightening the templates; their errors include undeclared fields, conflicting property mappings
  and ontology values in text fields. Keep these source diagnostics separate from failed conversions.
  Require property IRIs for ordinary child fields and elements in both Java and TypeScript JSON
  and YAML readers. First complete [MCP property-IRI authoring](./MCP-ROADMAP.md#property-iri-authoring)
  so exchange artifacts have their mappings before another tool reads them, and recheck production
  coverage before enabling enforcement. Keep static fields and attribute-value groups exempt;
  actual dynamic attributes carry their IRIs in instance contexts. Prove authoring, cross-library
  round trips and repository creation together.

  Classify source-to-output normalizations and losses before asserting preservation. Pairwise
  converter agreement is insufficient: compare each result with its stored source as well. Preserve
  every array's order, check generated JSON key order separately from JSON content, and require
  byte-identical YAML. Turn each further proven library defect into a regression fixture. Keep this
  audit GET-only and distinguish key-visible search coverage from authoritative store/index parity.
  The retained corpus, per-artifact evidence and full issue list are under
  `$CEDAR_HOME/.cedar/audits/2026-09-25-schema-matrix-rerun/`; the
  [backend runbook](./BACKEND-RUNBOOK.md#comparing-both-schema-libraries-over-the-full-stored-corpus)
  describes how to resume and recheck it after a library change.

  **Resolve the remaining production instance sources and pipeline findings.** The retained
  findings and checked repairs leave 42 affected instances under the latest libraries. Production
  adoption of the Unicode IRI fix remains pending for eight additional instances.
  Consistent reader rejection of an invalid source still requires a source repair.

  Resolve three remaining instances whose legacy `description` attribute-value groups sit in
  element structures that no longer match their template: `de5299da-97ed-4795-8cc4-5c405314bfce`,
  `e6cdd723-2f7a-45e1-b062-a6187d615bd1` and `38c3559b-68e6-42ac-97cb-70624f581cb2`.
  Their template is `6a4ac641-f55d-4a48-b00d-1e01de28cc4d`. Establish the intended element/field
  mapping before renaming those groups to `description attributes`; a key-only repair cannot
  validate these sources. Preserve every value. These overlap existing findings; do not add three
  to the 42-instance baseline. Account for their stricter-reader rejection before production
  rollout. Live dependency checks and retained originals are under
  `$CEDAR_HOME/.cedar/audits/2026-09-25-reserved-name-review/migration-apply/`.

  | Remaining issue | Instances |
  | --- | ---: |
  | Stored multiple-datatype literals; narrow repairs blocked by other template errors | 3 |
  | Stored mixed `@id`/`@value` fields | 11 |
  | Malformed/empty stored URI is the first Java rejection | 17 |
  | Malformed annotation objects | 8 |
  | Numeric JSON literals or an unexpected nested field array | 3 |

  Release and deploy Unicode field-IRI support across the Java artifact library, model validator,
  TypeScript consumers and repository paths. Preserve the eight Niger identifiers verbatim; do not
  replace U+00A0 with `%C2%A0` or substitute the different version-2 vocabulary term. Verify the
  deployed JSON/YAML write path before the repeatable-link migration below. Resolve the production
  terminology HTTP 403 access restriction before claiming live lookup compatibility. Current-code
  replay evidence is under `$CEDAR_HOME/.cedar/repairs/2026-09-26-unicode-iri-library/`.

  Reconcile the remaining library behavior without silently discarding data.
  Thirteen instances have narrow source corrections prepared but still fail validation for other
  reasons; resolve those blockers before writing. Preserve conflicting populated values and ambiguous
  URI spellings until the intended replacement is established. The GeoExposure CASTNET link fields
  can lose their exact duplicate `@value`, but unrelated template errors block the complete write.
  Preserve DOI annotations while resolving the document/graph write guard before retrying the HEAL
  annotation repair. Plans, validation errors, backups and readbacks are under
  `$CEDAR_HOME/.cedar/repairs/2026-09-25-instance-values/REPORT.md`.
  Of the eight malformed-annotation instances, seven retain other validation defects; the HEAL
  instance's otherwise-valid correction is blocked by DOI attachment inconsistency. Recheck the
  retained proposals after those blockers are resolved. Current conditional-write and conversion
  evidence is in `$CEDAR_HOME/.cedar/repairs/2026-09-26-annotation-instance-cleanup/`.

  Make `Source Hyperlink` repeatable in `VODAN-COVID-Migrants-Tunisia`
  (`05ce128b-c631-45c8-bfcf-a229ea1fcce5`) and split F050TUN's two stored URLs after
  production adopts the library changes. All 368 instances require object-to-array migration; the
  fresh preflight validates every proposed body under the updated validator. Production still needs
  Unicode IRI support before eight of those bodies can be written. Do not switch the template
  until the deployed write path accepts all dependents. This approved repair remains within the
  42-instance backlog; its dependencies overlap existing findings. Audit evidence and proposed
  bodies are under
  `$CEDAR_HOME/.cedar/repairs/2026-09-26-repeatable-source-hyperlink/`, with targeted dependency
  rechecks under `$CEDAR_HOME/.cedar/repairs/2026-09-26-guardian-source-link/` and
  `$CEDAR_HOME/.cedar/repairs/2026-09-26-webmanagercenter-source-link/`, plus the formatting
  repairs under `$CEDAR_HOME/.cedar/repairs/2026-09-26-a147-link-numeric/` and
  `$CEDAR_HOME/.cedar/repairs/2026-09-26-e052-link-numeric/`. Refresh the full
  dependency inventory and all proposals before migration.

  The four unresolved index entries return 404 even after retry; reconcile the index and store
  rather than declaring them converted. Investigate already-invalid sources without a pipeline
  discrepancy separately from library disagreements. Revalidate against actual templates before
  any source repair. Retained replay evidence is under
  `$CEDAR_HOME/.cedar/audits/2026-09-25-instance-strict-shapes-replay/`; the
  [instance pipeline runbook](./BACKEND-RUNBOOK.md#full-production-instance-matrix) describes coverage.

  **Finish the blocked annotation declarations and deploy the updated writers.** Seven templates
  still need optional `_annotations` declarations and `@nest` context mappings. Their unchanged
  document DOIs conflict with null graph DOIs; reconcile the seven IDs tracked in
  [DOI minting recovery](./FRONTEND-ROADMAP.md#doi-minting-recovery), preserve their DOIs, then
  refresh the dependent-instance checks and retry the conditional patches. The unavailable `.net`
  template remains part of the indexed-404 group above. The HEAL instance still needs its malformed
  `_annotations/@id` repaired after DOI reconciliation. Keep malformed annotation values rejected.
  Adopt the updated Java/TypeScript writers in backend and editor deployments so subsequent model
  renders retain these optional declarations. Backups, proposals, validation and readbacks are in
  `$CEDAR_HOME/.cedar/repairs/2026-09-26-annotation-backfill/`.

  **Prioritize the largest remaining groups.** Measured 2026-09-25 over the flagged subset.
  Repeated names identify distinct templates; ID prefixes distinguish them.

  | Template | Invalid instances |
  | --- | ---: |
  | Migrant-Interviews (`ad459f36…`) | 34 |
  | LINCS DSGC Dataset Submission (`70b010f2…`) | 26 |
  | Adverse Events V2 | 25 |
  | VODAN-COVID-Migrants-Tunisia (`1988902f…`) | 22 |
  | causal pathway | 21 |
  | PGHD_BP_template | 15 |
  | Expression | 14 |
  | VODAN-COVID-Migrants-Tunisia (`05ce128b…`) | 14 |
  | LINCS DSGC Dataset Submission (`f4034b6f…`) | 11 |
  | GeoExposure_Data_1.5.1_Template (`ce1436c0…`) | 11 |
  | MyFirstTemplate | 10 |
  | Updated week X | 8 |
  | UPDATED HEAL Study Core Metadata (`a91e12b0…`) | 8 |
  | MiAIRR V1.1.0 | 7 |
  | Human Cognitive Neuroscience Data | 7 |
  | Citation | 7 |
  | COVID Project Content | 6 |
  | COVID-19_Project-Admin_V4 (`337cb6f3…`) | 6 |
  | File Metadata | 6 |

  Another 190 templates carry 1–4 invalid instances each, 286 between them: 131 have one, 34 have
  two, 13 have three, and 12 have four. These groups include *Cell*, with four remaining instances:
  resolve ontology assertions in the text-only `Reporter_type`/`Mod_type` fields and the undeclared,
  malformed `Publication_title` structure without discarding populated data.

  **Resolve MiAIRR V1.1.0's legacy representations.** Seven of its instances are invalid. Review old BioSample field names and property mappings,
  ontology-valued `Sex` against its text declaration, release dates containing `NA`, and unexplained
  numeric strings or URI-shaped values in text fields. Matching property IRIs support several
  renames; `Cell Processing Protocol` → `Processing Protocol` and `Related Subjects` →
  `Relation to Other Subjects` also change the predicate and need a semantic decision. Do not infer
  meanings for numbered values or treat `NA` as empty without an applicable owner decision.

  **Reconcile previous semantic changes with the saved bodies and recorded decisions.** Review
  removed fields against the assertions still present, not merely equal literal values; the property
  IRI matters. Review historical context alignment as a semantic migration. Use the existing
  preimages to recover a proven lost value into its established destination, preserving subsequent
  edits. Where the template no longer declares a destination, obtain a schema decision rather than
  inventing a field, moving the value to an unrelated equal-valued field, or replacing the entire
  artifact with an old body. The `SCAA_posneg` values removed from the *Updated week X* template
  need this decision. Recorded mappings to null must remain distinguishable from heuristic renames.

  **Regenerate the decision sheet under the conservative rules.** Similar spelling and shared values
  can suggest a pairing but cannot settle it. `ops/repairs/rename_sheet.py` must present unconfirmed
  proposals for review, and a many-to-one mapping must resolve competing populated values explicitly.
  Keep named exceptions for cases where the historical template or an owner's meaning cannot be
  recovered. The rules and current measured scope are in the backend runbook's production repair
  section; old residual counts and inferred mappings are not a fresh inventory.

  **Rerun the full inventory before claiming a corpus-wide result.** Targeted revalidation measures
  the reviewed IDs only. Reconcile the four search-enumerated 404 instances and the unresolved
  template against the authoritative stores, without deleting artifacts on search evidence, and
  include creations and edits since the last complete walk. Record validator, script and template
  inputs so a verdict is reproducible.

  **The schema artifacts that remain cannot be repaired, only decided.** The last full
  template and element audit, 2026-09-12, left 8 templates and 1 element invalid. They are
  structurally broken rather than drifted: a child inside `properties` is missing `@type`, `title`,
  `_ui`, `_valueConstraints`, `schema:schemaVersion` and its provenance members outright, which no
  field-preserving repair can synthesize without inventing content. A separate seven templates are
  refused by the server with `doiCanNotBeAltered`, and they carry what is left of the title,
  model-version and object-shape findings. Decide what each group gets: a repair path that does not
  go through the ordinary update, an owner's edit, or a recorded exception. The enforcement below
  waits on that answer, because those artifacts are why three classes cannot reach zero by repair.

  **Find templates that demand instance shapes the editors cannot produce.** Decide whether the
  element meta-schema should restrict the remaining entries of `required` after its first two tuple
  entries, so an element occurrence cannot demand root-instance provenance or `schema:isBasedOn`.

  Two further demands of this kind are measured only where they turned up, and each wants a
  corpus-wide count before a rule. A static field can carry a `required` naming `_content`, which no
  static field declares; `canonicalise-field-required` clears it, but production has never been
  counted for it, because the condition that names targets looks for a value or an address rather
  than for whatever a static field was given. Separately, a literal field can carry a vocabulary
  constraint: the constraint calls for a term while the field declares `@value`, so the two halves
  of the field disagree about what an instance may hold. Seven are known. Settling one means
  choosing which half is wrong, and rewriting `properties` invalidates any instance already holding
  the other shape, so neither is a repair a lookup answers.

  **Make the model version explicit.** Decide what an artifact carrying no `schema:schemaVersion`
  gets, should one appear. The deployed population has never forced the question and the readers
  now refuse a stale version and an absent one alike, so the case arises only for an artifact
  written outside them. A version cannot be stamped on faith, because `schema:schemaVersion` asserts that the
  artifact conforms to the model it names, so writing the current version into an artifact that
  does not conform replaces a detectable defect with an undetectable one. Write it only where the
  artifact already satisfies the current model, and report the remainder for a scoped repair.

  **Make terminology sources explicit.** A controlled-term constraint may name the system serving its
  vocabulary, and both model libraries read an absent `sourceSystem` as BioPortal —
  [the value-constraint shape](VERSIONING-ROADMAP.md#6-the-value-constraint-shape) defines the field
  and that default. The default is correct for production today, because every deployed constraint
  resolves through BioPortal. It stops being correct as soon as the versioned terminology store
  serves a second system: a constraint authored before the field existed and one that deliberately
  names BioPortal are then indistinguishable, while routing has to honour the rule that a
  non-BioPortal source is never proxied to BioPortal. Writing the default explicitly while it still
  holds turns silence into evidence, so afterwards a constraint carrying no `sourceSystem` marks an
  artifact the sweep never reached. Measured 2026-09-12 across templates and elements, 4,039
  artifacts carry 28,046 such constraints; the 2026-09-08 corpus audit, standalone fields included,
  counted 72,393 over 46,937 artifacts.

  The same entries hold two more noncanonical values, measured across the seven GDMT templates on
  2026-09-24 and unmeasured beyond them: 43 of 57 constraint entries record `source` as a
  `bioportal.bioontology.org` browse URL rather than the display string, and 50 give `name` the
  acronym again instead of the term's label. Both are this item's business rather than a repair of
  their own, and a rule for either wants the corpus-wide count first.

  The serving system cannot be derived from the term IRI, which is the tempting shortcut and a wrong
  one. The 51 HuBMAP assay templates carry 504 branch constraints whose targets sit under
  `https://purl.humanatlas.io/vocab/hravs#`, and every one of them resolves through BioPortal, which
  serves that vocabulary as HuBMAP Research Attributes Value Set under the acronym HRAVS. The
  acronym, paired with a system, is what addresses a source. So the rule writes `BioPortal` where the
  constraint's acronym resolves in BioPortal, and reports the remainder for review instead of
  guessing.

  Add it to `cedar_artifact_patch.py` as its own rule, under that tool's existing discipline: report
  by default, write only under `--apply`, no change when rerun, refuse any constraint whose system it
  cannot establish. It needs no library change, since both model libraries already read the field and
  write it whenever a constraint carries one, so a patched artifact round-trips through the strict
  readers unchanged. Keep the scope to this one field. The canonical ontology identity (`iri`,
  `sourceIri` in YAML) is absent from 3,973 artifacts over 27,485 constraints and needs the
  terminology catalogue rather than a string rule, and the free-text `source` display string is
  separately noncanonical — 497 of those 504 HuBMAP branch constraints record `"undefined (HRAVS)"`
  where BioPortal has the real name — so each wants a rule of its own rather than a ride on this one.
  Background work with no deadline of its own. Its value lands at the terminology cutover, which
  means it has to be finished before a second source system is served, not before anything else.

  **Reconcile the inventory boundary.** It persists across every pass and is what keeps a run from
  reporting `COMPLETE_FOR_KEY`. On 2026-09-16 four instances that search enumerated answered 404
  from the typed resource endpoint and one template would not resolve at all; no duplicate search
  rows remained. Determine whether each is a stale search or workspace projection or a missing
  artifact before changing anything, repair the projection from the authoritative stores, and rerun
  the audit. Never delete a store artifact merely because its search entry is inconsistent.

  **Resolve the remaining CCP and HEAL instance properties.** Five instances of *CCP Digital
  Object* (`62c8b5f2…`) and eight of *UPDATED HEAL Study Core Metadata* (`a91e12b0…`) remain
  invalid in the flagged subset. Review populated undeclared fields, cardinality and conflicting
  context predicates individually. A dynamic attribute member remains meaningful when a group
  names it, even if its value is null; deleting it is not a substitute for reconciling the group
  declaration with the canonical model. Revalidate after each repair because an earlier failure
  can hide another defect.


  **Decide what seven pasted constraints were meant to constrain.** Seven templates constrain a
  `mimeType` field to the whole of the GDMT vocabulary, because someone pasted a BioPortal browse
  URL into the entry. The address is repaired and confirmed against BioPortal, but the URL's
  `conceptid` names one class in that ontology, `https://w3id.org/gdmt/MIMEType`, so the author may
  have meant a single class rather than every term GDMT serves. Changing an `ontologies` entry into
  a `classes` entry narrows what an instance may say, which is a decision about the template's
  meaning and not one a lookup answers. Ask the owner, or record that constraining to the whole
  ontology is intended.

  Done when every enumerable artifact is valid or recorded as a named exception, the rename sheet is
  answered or explicitly abandoned for its tail, and no constraint lacks a `sourceSystem` the sweep
  could have written.

## Later Decisions

- **30. Enforce the request-body classification, and decide what an open body requires.**
  `cedarcli check openapi` reads `additionalProperties` only when deciding whether a schema counts
  as a stub, so nothing across the estate fails when a new request schema states neither that it is
  closed nor that it is open. Only the resource server asks, in its own contract test. Add the rule,
  with the same two answers: a command or options body is closed, and an artifact document is open
  because its properties are the model's and the artifact server is what validates them.

  No open body has a floor. `PATCH /groups/{id}` declares `minProperties: 1` and accepts `{}`,
  answering 200 with the group unchanged — the same answer a patch gets when its values already
  match, so a caller cannot tell "nothing asked" from "nothing to do". Decide whether a merge patch
  naming no property is a bad request, and whether an artifact body needs anything the artifact
  server does not already check.

  Then pin the open boundaries so later tightening cannot close one by accident: an artifact
  document keeps the properties its template permits, and the user preference patch keeps its
  dotted keys.

  The two hand-rolled `ObjectMapper` instances in `cedar-submission-server` still read a request
  subtree outside the named mappers. Sixteen more across the servers and shared libraries read
  responses or build output, where the tolerant mapper is what they want.

- **31. Address artifacts by bare identifier in REST paths, keeping the full IRI as stored
  identity.** **Production consequence:** an addressing migration rather than a data one. Stored
  identifiers in MongoDB, Neo4j and OpenSearch do not change, and no reindex is required, but
  clients that build URLs in the current form need the legacy shape kept as an alias until traffic
  shows it unused. Deferred by decision; recorded so the addressing is not settled by accident.

  CEDAR stores an artifact's identity as a full JSON-LD IRI, and three conventions ask for it. The
  artifact and resource services take the whole percent-encoded IRI in one path segment. The repo
  service takes the bare final identifier and rebuilds the IRI from the route's type
  (`AbstractRepoResource.java:37`). OpenView accepts either and resolves a bare one before lookup
  (`TemplatesResource.java:51`). Monitor carries identifiers in query parameters instead, and the
  user service is addressed by a bare UUID although a user's stored identity is an IRI too.

  A full IRI inside a path parameter is fragile because proxies and frameworks do not treat an
  encoded slash alike. Where an intermediary decodes `%2F`, the value stops being one segment and
  `/templates/{id}` no longer matches. Staging carries the cost in its configuration: two exact
  `location =` blocks in `server-resource.inc.conf` name individual artifact identifiers and
  re-encode the collapsed form into a `proxy_pass`, one block per artifact that arrived broken.

  **The proposed contract:** keep the full IRI as the stored identity and in JSON-LD fields such as
  `@id`, and use the bare final identifier in resource-specific paths and query parameters, with the
  route supplying the type and a shared parser rebuilding and validating the IRI before any store is
  read. An endpoint that is genuinely untyped may keep a full IRI, as a stated exception rather than
  an accident.

  Deliver it the way the other contract changes go. One shared parser accepts both forms first —
  OpenView's resolver is the working example — while server-generated links and shared clients
  emit the bare form. Measure the legacy form, mark it deprecated, and remove legacy parsing and
  the two nginx blocks only after a compatibility period and evidence that no caller depends on it.
  Done when every resource-specific route takes the bare identifier, one parser owns the
  reconstruction, and staging's per-artifact blocks are gone.

- **32. Decide what each compatibility adapter is for, now that neither reads artifacts itself.**
  Repo and OpenView exist to preserve URLs rather than to do work: the runbook's account of artifact
  route ownership gives repo the identifier dereferencing URLs and OpenView the anonymous
  presentation and open-artifact URLs, and says neither adapter should own artifact storage or an
  independent read policy. Both used to open artifact's Mongo collections and read documents
  themselves. Neither does now — repo's four artifact routes and OpenView's four anonymous reads
  delegate to resource, and both services' artifact Mongo initialization is gone — so each one's
  artifact surface differs from resource's only by a hostname and a path convention.

  That makes the question live rather than answered. It is not the retirement question item 5 asks
  of four narrowly used servers: these two are neither narrowly used nor removable on the same terms,
  because what they preserve is addressing that other people's data depends on.

  What cannot change is the reason they exist. An artifact stores its own address — `"@id":
  "https://repo.metadatacenter.org/templates/<uuid>"` — and an instance names the template it was
  filled from the same way. Those strings sit in MongoDB, in Neo4j, in every instance anyone has
  downloaded, in published DOIs and in citations outside CEDAR, and the designer mints new ones in
  that form. `repo.metadatacenter.org` therefore has to keep answering whatever happens to the
  process behind it, which is why the compatibility migration's rule is to preserve public hosts and
  stored IRIs.

  Neither service is a pure pass-through either, and the difference matters to the answer. Repo
  resolves a bare path identifier to its full IRI, which nothing else does, and authenticates before
  delegating. OpenView's folder listings still read the workspace graph, and it keeps the estate's
  user-details configuration; only its artifact reads became redundant.

  So the decision is per host, and there are three honest answers for each: retain the service with a
  stated role, reduce it to the part that is not duplicated, or serve the URL contract some other way
  — nginx routing plus something that still resolves a bare identifier — and retire the process. A
  retirement takes the whole checklist item 5 states, and a reduction takes the part of it that
  applies.

  The prerequisite is already written down. The runbook's repo rollout asks for repo and resource
  reads to be compared across all four artifact types, as an owner and as another user, with matching
  bodies and ETags, private reads still denied, and neither a missing identifier nor a downstream
  outage producing a successful read. That comparison is what proving routing compatibility means,
  and no adapter should be reduced before it passes on the deployed topology.

  Item 31 settles a different question about the same two services: which path shape a route takes.
  The two interact, because retiring repo's routes would retire the bare-identifier convention it
  proposes to generalize. Whichever is decided first constrains the other.

  Done when each of the two hosts has a stated role, an owner, and either a current caller that needs
  the process or a routing arrangement that keeps its URLs resolving without one.

- **33. Revisit controlled-term result actions: define scalable semantics, narrow them, or delete
  them.** Exclusion and `move` actions are stored beside a field's complete constraint set and apply
  to the result after all ontology, branch, class and value-set constraints have been combined. They
  are not customizations of one constraint row. Before the picker exposes authoring controls, state
  what each action means for a single large ontology, multiple branches, multiple sources, pinned
  releases and query-ranked results.

  The current execution model cannot be that contract. Multi-source integrated search merges and
  sorts one page and explicitly reports invalid pagination. Actions are then applied to that returned
  page: a deletion can leave a hole, the server does not fetch a replacement, and a move is clamped
  to the current page. Consequently, “move this term to position N” is neither a stable global order
  over a 100,000-term ontology nor a well-defined position across different search queries.

  Keep exclusion only if it can be pushed into result construction before pagination, with full
  pages and correct totals regardless of which constraint admitted the term. For ordering, choose one
  of two explicit products: replace arbitrary moves with a small ordered set of preferred terms whose
  interaction with query matching is defined, or remove move actions from the supported authoring
  model. Preserve imported actions while deciding, and provide a migration or compatibility rule for
  existing actions before changing their stored shape or execution.

  Prove the chosen contract with a large locally served ontology and with overlapping branches from
  more than one source. Tests must cover paging beyond the first page, query and empty-query results,
  pinned releases, duplicate terms admitted by multiple constraints, stale action targets, totals and
  page filling. Only then should the terminology picker expose a table-level result-customization UI.
  The compact picker presentation remains tracked in
  [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md); this item owns the backend meaning and scale limit.

- **34. Validate a write with `cedar-artifact-library`, not the meta-schema alone.** Nothing but
  `cedar-model-validation-library` stands between a caller and the store: the artifact server's
  `validateTemplate` calls `newModelValidator()`, and the resource classes never mention
  `org.metadatacenter.artifacts.model` at all. The artifact library reads a stored artifact only
  later, when something asks for YAML — which is why defects sat in production for years before a
  read found them.

  The two disagree, and the meta-schema is always the more permissive. It asks every literal field
  for an `inputType` and nothing more, so a temporal field with no granularity is accepted and then
  unreadable. It types `pav:version` as a non-empty string, so `0.9` is accepted and has no YAML
  form. It shares one value-constraints shape across all ten literal input types, so a text field
  may carry an option list and a numeric field may carry one too. Every artifact repaired in
  September 2026 entered through that gap.

  The library is also the cheaper check. Measured warm over 100 runs: a 343 KB template costs it
  2.70 ms to read and render against 17.14 ms to validate; 163 KB, 1.83 ms against 11.77 ms;
  42 KB, 0.29 ms against 3.05 ms. Across all 151,806 production schema artifacts the library sits
  at 0 ms through the 99th percentile where the validator reaches 7 ms, and on the largest
  artifacts the gap is widest — 271 KB cost 5 ms to convert and 88 ms to validate. Adding the
  library to a path that already pays for the validator costs roughly a sixth again.

  And it says what is wrong. Draft-04 `oneOf` reports every failed branch, so one duplicated
  literal produced 242 errors whose first named `/properties/theme/items/properties/@value/type:
  array found, string expected` — a path with nothing wrong with it. The library answers `No text
  value present for field temporalGranularity at /properties/Analysis Complete / Release date/_ui`.

  **Instances are unmeasured and have to be settled before any of this lands.** The September 2026
  work covered the 151,831 schema artifacts and left the 150,579 instances alone. An instance is
  validated against the template it names rather than a fixed meta-schema, the library reads one
  through `readTemplateInstanceArtifact`, and neither the cost nor the disagreement is known for
  them. Measure both before deciding, since instances outnumber schema artifacts and a write gate
  that doubles their cost is a different proposition.

  Order is forced, as it was for `pav:version`. Refusing on write what the library cannot read
  makes every stored artifact carrying such a shape unsaveable, including through the repair that
  would fix it, so the corpus has to be clean first. `cedar_artifact_rest_audit.py` now reports the
  shapes found so far — `temporal-precision-absent`, `field-offers-choices-it-cannot-present`,
  `literal-label-blank`, `class-constraint-unresolved`, the three `artifact-version-*` rules — and a
  pass over instances would say what else is waiting.

  Decide, too, whether the library gates or advises. Gating refuses the write; running it ahead of
  the validator and surfacing its message keeps the meta-schema authoritative while giving the
  author something they can act on. The second is reversible and the first is not.
