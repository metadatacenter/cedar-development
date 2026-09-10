# CEDAR Backend — Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).
Work on the main browser applications is in [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md), work on
the embeddable editor is in [CEE-ROADMAP.md](./CEE-ROADMAP.md), and work on the MCP servers is in
[MCP-ROADMAP.md](./MCP-ROADMAP.md).

## Next

### Infrastructure

- **1. Document the versioning model, then audit the implementation against it.** The user guide
  says what an author sees and the YAML specification defines the keys, but no document states the
  model: which artifact kinds are versioned, what publishing freezes, how a draft succeeds a published
  version, how version numbers must order, what the three latest-version flags mean, and what deleting
  a version does to the chain. Write that model in one place, beside the permission model. Then audit
  the resource server, the graph and the search index against it, and record each divergence as a
  decision to make or a defect to fix. `ArtifactLifecycleMatrixTest` pins the current rules until
  then. Done when the model is published and every divergence is fixed or recorded.

- **2. Protect `main` in every repository, and give the release an identity of its own.** `main` is
  unprotected in all forty-four repositories, so a commit can land there without ever reaching a
  train, which captures `develop`. The next release then replaces it: the work leaves the branch
  that held it and nothing says so afterwards. A hotfix and the unit test guarding it came within
  one reading of an advisory line of going that way. The release gate refuses such a source now, and
  `cedarcli check main` answers the same question between releases, but neither prevents the push.

  Requiring a pull request on `main` does not settle it by itself. `cedarcli release start` pushes
  straight to `main` in forty-two repositories, as whoever runs it, so a bypass naming that person
  protects nothing against the case that prompted this. Give the release a machine identity, a
  GitHub App or a dedicated account, grant the bypass to that rather than to a human, and
  authenticate the release as it. The bypass has to cover every ref a release creates — `develop`,
  the tags, and `release/pre-*` among them — or a release fails after its Maven and frontend builds
  are already spent. Prove the ruleset against one repository before it reaches all forty-four.

  The npm releases already go through pull requests and need nothing. Until the machine identity
  exists, run `cedarcli check main` on a schedule, so divergence is found the next morning rather
  than mid-release.

- **3. Rename the legacy role relationships in production Neo4j.** The application currently
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

- **4. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
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

- **5. Make database schema evolution an explicit, privileged release operation.** Application
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

- **6. Decide whether four narrowly used servers should be retired.** Treat each as an explicit
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

- **7. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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

- **8. Complete the remaining backend trust-boundary, transport and credential security work.**

  **Two terminology routes answer an anonymous caller, and that stays.** `POST
  /bioportal/integrated-retrieve` and `POST /bioportal/integrated-search` resolve no user. Measured
  2026-08-31: a request with no `Authorization` header returns `200`. Both reach BioPortal on the
  server's own `apiKey`, so an anonymous caller spends the deployment's BioPortal quota.

  Requiring a credential is not the remedy, for the reason item 9 gives: third-party deployments of
  the embeddable editor call these routes from a browser with nothing to send, so a gate would break
  every host that embeds it. Both methods now carry that reasoning where the check is disabled, and
  the OpenAPI no longer promises a `401` neither route sends. What bounds the cost is the edge rate
  limit in item 9, which covers `/ext-auth/*` and should cover these two on the same terms.

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

- **9. Rate limit the edge in every environment.** An anonymous caller can spend the deployment's
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

- **10. Put the MySQL connections on TLS, and make the timezone a setting rather than a constant.**
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

- **11. Decide the CORS contract per deployment instead of defaulting to `*`.** **Production
  consequence:** a browser application fails cross-origin unless its exact origins are configured
  first, so every environment needs its list before the default changes.

  `resolveCorsAllowedOrigins` falls back to `DEFAULT_CORS_ALLOWED_ORIGINS`, which is `"*"`, whenever
  `CEDAR_CORS_ALLOWED_ORIGINS` is unset or blank
  (`CedarMicroserviceApplication.java:56`, `:316`). Credentials are then allowed unless an entry
  equals exactly `*` (`:339`), so a pattern Jetty's `CrossOriginFilter` accepts —
  `https://*.example.org` — receives credentialed access while the bare wildcard does not.

  **The decision is which origins each deployment serves, and whether a wildcard pattern may ever
  carry credentials.** It has one complication worth settling with it. The embeddable editor is
  hosted by third parties, and item 8 keeps `POST /bioportal/integrated-search` and
  `/bioportal/integrated-retrieve` anonymous for exactly that reason, so those two are called from
  origins CEDAR does not know. A deny-by-default list closes them unless the policy names them.

  Default to no CORS headers rather than to `*`, require the allow-list in each deployment profile,
  refuse credentials for any origin expression containing a wildcard rather than only for the bare
  one, and state what the third-party-embedded routes get. Done when no deployment relies on the
  fallback, each environment's origins are recorded where it is documented, and tests cover blank,
  exact, multiple and wildcard configurations.

- **12. Take stored API keys out of cleartext, and retire the keys minted before random minting.**
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

- **13. Validate and encode the DOI the DataCite metadata route resolves.** **Production
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

- **14. Bound the application-log queue, and let its consumer keep up.** Application logging can
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

- **15. Ship INFO as the default log level, and bound what a log file can grow to.** **Production
  consequence:** diagnostic detail drops after rollout, so choose the size limits against production
  capacity before deploying. Nothing migrates.

  Fifteen shipped `config.yml` files set `org.metadatacenter: DEBUG`, and the artifact server sets
  `org.metadatacenter.config: DEBUG` beside it. Every console appender takes `threshold: ALL`, and
  every file appender archives by day with no size limit: `maxFileSize` and `totalSizeCap` appear in
  no configuration in the estate. A busy day therefore writes one file that nothing bounds, and
  request-path DEBUG buys I/O that nobody reads. Archive depth already disagrees, measured
  2026-09-10: twelve services keep `archivedFileCount: 30`, and messaging, monitor and worker keep
  5.

  Nothing connects these files to the Redis queue of item 14. `AppLogger` hands every message to
  `AppLoggerQueueService.enqueueEvent`, which pushes it to Redis without consulting a log level, so
  shipping INFO takes nothing off that queue and a ceiling on the queue takes nothing off these
  files. What bounds each differs as well: a queue is bounded by what its consumer can keep up with,
  a file by what the disk can hold.

  Ship INFO with an environment-controlled override for a service under investigation, put
  `maxFileSize` and `totalSizeCap` on every file appender, and use one retention policy across
  services rather than one per configuration file. Done when no shipped configuration sets DEBUG for
  a whole package, every file appender carries both limits, and the retention policy is recorded
  where the deployment is documented.

- **16. Separate CEDAR dependency convergence from the Keycloak provider platform lock.** The eleven
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

- **17. Converge on one pagination encoding.** Ten paging shapes are in service across seven
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

- **18. Bound every outbound call by what the call actually is, and measure before choosing the
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

- **19. Make native bring-up prove a service runs.** `cedarcli native start` reports what the
  launcher accepted rather than what the stack ends up running, and the gap swallowed a whole-stack
  outage on 2026-09-02: every application exited in milliseconds for want of `CEDAR_PROFILE`,
  launchd's keepalive respawned each one, and the CLI printed `started <name> (pid N)` for all
  twenty-two because a PID existed each time it looked. The launcher passes that environment through
  today, rejects a service that dies at once, refuses a `JAVA_HOME` that is not a Java 17, and covers
  all three in tests.

  What remains is to confirm a service is serving, not merely alive. The survival check waits half a
  second and asks whether the process still exists, which catches the failures that land before a JVM
  starts and none after that. A microservice that boots, fails to reach Neo4j or Mongo, and exits
  after ten seconds is still reported as started. `cedarcli native health` already knows how to judge
  this and exits non-zero unless every managed application is healthy, so let `start` end by waiting
  for the services it just launched to pass that same gate and report the ones that never arrive
  along with the last lines of their logs.

  **Wait once, after launching, rather than per service.** Waiting for each service before starting
  the next makes the cost the sum of twenty-two JVM boots and their dependency connections, which is
  minutes; polling the whole set after launching them all makes it the slowest service alone. Bound
  the total rather than each service, and report each one as it arrives, so a developer sees progress
  rather than a silent block.

  Most of what it adds is already being paid. The survival check sleeps half a second per service,
  serially, which is about eleven seconds of every `start all` spent waiting on nothing in
  particular. A health gate subsumes it — a service that died at once will never pass — so those
  sleeps can go, and the early per-service error they print is what the report of services that never
  arrived already covers.

  `start infra` is the layer where waiting earns the most. Microservices connect to Neo4j, Mongo and
  Keycloak while they boot, so returning before those are serving is what produces the failure the
  survival check cannot see; waiting there prevents a cascade rather than reporting one.

  A flag that skips the wait restores exactly the behaviour this item exists to remove, so if one
  exists it should be asked for explicitly and never be the default.

  One constraint on the implementation. `ServerWorker` probes each service in turn with no per-probe
  timeout, which is fast only because a stopped service refuses the connection; a service that
  accepts one and then hangs would stall the loop and make the gate its own source of delay. A poll
  needs a bounded probe, and reads better concurrent.

  Done when `start` reports a service only once it is healthy or names why it is not, and `start all`
  costs the readiness of its slowest service rather than the sum of all of them.

- **20. Run the whole-stack tiers in CI, and gate the workflow train the way the CLI is gated.**
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
  both tiers through `cedarcli test e2e`, and retains its report as an artifact. Make the workflow
  train call the same gate implementation the CLI calls rather than a second preflight path. Done
  when both tiers run unattended on a cadence, their reports are retained, and a train dispatched
  through Actions is refused on the same evidence that refuses one dispatched from `cedarcli`.

- **21. Let the artifact server own the uniqueness of `@id`.** No two documents in an artifact
  collection may share an `@id`. The server relies on a unique index on that field to enforce it. A
  create is a read that finds the identifier absent followed by an insert, and
  `GenericLDDaoMongoDB.create` answers a duplicate-key rejection with the same 412 the update path
  gives a stale writer. Nothing in the application creates that index. The Docker image's Mongo init
  script does, and natively the admin tool's `artifactServer-initDB` task does, which `SystemReset`
  runs as its second step, so a store that has been reset carries it and the development workstation's
  does. Neither `cedarcli native start` nor the backend runbook names the task, so a native store
  that never saw it has no index. There two concurrent creates of one identifier both succeed,
  `findWithRevision` reads only the first, and a conditional delete removes one document and leaves
  the other unreachable through the API. The embedded Mongo the server suites run against creates
  no index either, so no suite exercises the rejection the DAO translates. The DAO test mocks it.

  Ensure the four indexes at artifact-server startup, so the invariant stops depending on a step an
  operator remembers. Creating an index that already exists with the same options is a no-op, so a
  deployment whose collections were provisioned pays nothing, and only a store that was never
  provisioned builds one on first boot. On the pinned Mongo 5.0 that build keeps the collection
  readable and writable and takes seconds to a few minutes over 400,000 documents, once. Give
  `EmbeddedCedarMongo` the same indexes, so the suites run against the constraint the store actually
  has, and add a resource test that inserts the same identifier twice through the real store rather
  than through a proxied service.

  **This can take production down if it is done carelessly.** A unique index cannot be built over a
  collection that already holds two documents with the same `@id`, and a store that ever ran without
  the index may hold exactly that. If the startup ensure treats a failed build as fatal, the first
  release carrying it turns a latent data defect into an artifact server that refuses to boot, and
  every retry fails the same way. Two rules follow. The ensure never stops the server: a failed build
  is logged at error and reported through the health check, and the server keeps serving as it does
  today. And the production deploy runbook gains a preflight, run before the release that carries the
  ensure, which lists the indexes each of the four collections holds and counts identifiers that occur
  more than once. Production is expected to pass both, because `artifactServer-initDB` has provisioned
  every CEDAR store since before 2019, but the expectation is verified, not assumed. Duplicates found
  are repaired first, with `cedar_artifact_patch.py` or by hand, and only then can a build succeed.
  Done when a fresh, unprovisioned Mongo refuses the second insert, the suites prove it, a store with
  duplicates still boots and reports why its index is missing, and the runbook carries the preflight.

- **22. Take the dependency upgrades that need code changes.** The versions that could move without
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
  - **Logback 1.5.33 to 1.6.3** needs SLF4J 2.1, which has only an alpha, so it waits on the last
    group below.

  **Versions that follow a locked server.** Six sit here: the Neo4j driver 5.28.14 to 6.2.1, MySQL
  Connector/J 8.4.0 to 26.7.0, the Mongo driver 5.1.2 to 5.11.0, the OpenSearch client 2.19.2 to
  3.8.0, the Lucene pin 9.12.1 to 10.5.1, and the Neo4j test harness 5.3.0 to 2026.07.1. Client
  libraries are free to move in general, but a driver crossing a major has to be proven against the
  pinned server it talks to, so these are sequenced behind item 4 rather than taken on their own.
  Keycloak 22.0.4 to 25.0.3 is item 4's own, and RESTEasy 6.2.4 to 7.0.4 is held by the Keycloak
  client stack, which items 3 and 15 own.

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

- **24. Decide whether an attribute-value child keeps its declared property IRI.** Both model
  libraries read such a child's property IRI out of a template's `@context` and then decline to write
  it back as JSON, so a read-and-write cycle over `template-022.json` loses
  `https://schema.metadatacenter.org/properties/d01cb533-265c-474a-95f3-9afb4616a6e1` from the
  `ATTR-Value` mapping the source document carried. Both YAML writers keep it, so one model yields a
  document in one format that names the child's property and a document in the other that does not.
  Three attribute-value children carry one, across templates 022 and 029, and all three are minted
  identifiers rather than terms an author chose.

  The loss is recorded rather than repaired. `JSON_TEMPLATE_ROUND_TRIP_DIVERGENCES` grants template
  022 one round-trip error under the reason `legacy attribute-value context mapping is absent`, and
  the cross-library parity gates stay green because both libraries drop it in the same place:
  `ParentSchemaArtifact.getChildPropertyUris` excludes static and attribute-value children by name,
  and the TypeScript writer matches it.

  The exclusion's stated reason is sound as far as it goes: an IRI is identity, the repository assigns
  it on upload, and deriving one from a child's key would assert an identity nothing granted. That is
  an argument against minting an IRI, not against preserving one a document already carries.

  Two things settle it. What the artifact server does with such a mapping when a template is uploaded,
  and whether the entries in those two production templates mean anything or are debris from an
  earlier writer. If they are meaningful, both JSON writers should keep them and the expectation entry
  goes. If they are debris, `cedar_artifact_patch.py` should remove them and both YAML writers should
  stop carrying them.

  This is not the question a requirement on the same type answers, and the difference is the whole of
  it: a requirement has nowhere to go in the JSON form, because an attribute-value field carries no
  `_valueConstraints` node at all, so the YAML writers record nothing. A property IRI has somewhere to
  go, is there in production, and is being dropped on the way out.

  Whichever way it goes, the three children and their generated fixtures move with it, and the Java
  library's corpus verifier reports them stale until they are regenerated.

## Production data

- **25. Normalize production artifacts to one explicit model contract.** Production contains several
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
  `_annotations` member. `cedar_artifact_validation_audit.py` reports every annotation object carrying
  an explicit null `@id`, with the artifact ID and JSON Pointer, and says whether the null identifier
  is the entry's whole payload; run it before changing validation. The patch may remove
  an annotation entry only when null `@id` is its sole payload, removing the `_annotations` container
  as well when that leaves it empty; an entry with any additional payload stays report-only for human
  review. Do not include `@value: null`, which is a separately supported value annotation, and never
  invent an identifier. Capture the production count and paths in the reviewed manifest, prove the
  patch is idempotent, and require a repeated audit to report zero null identifier annotations. Only
  then wire the existing annotation-content definition into every applicable top-level meta-schema so
  direct artifact writes cannot recreate the shape.

  Child definitions present in `properties` but absent from `_ui.order` are another such repair, and
  production contains enough of them that the model libraries cannot simply start refusing the shape.
  `cedar_artifact_validation_audit.py` distinguishes this case from the inverse drift (an order entry
  with no property) over REST; add the same distinction as a raw-store rule in the patch tool, then
  offer an idempotent, field-preserving rewrite that appends each omitted child key after
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

  Measure the population before writing a rule for it: how many stored artifacts declare a version
  older than the current one, which versions appear, and how many declare none.
  `cedar_artifact_validation_audit.py` reports all three, per artifact and in its summary, while
  `cedar_artifact_patch.py` still reads nothing of the field. Run the audit against production and
  capture its findings as a reviewed manifest, the way the object-shaped repair is checked against 31
  artifacts and 76 paths.

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
  After the sweep, a constraint carrying no `sourceSystem` marks an artifact the patch never reached,
  and `cedar_artifact_validation_audit.py` counts those constraints, so the sweep has a before and an
  after.

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

- **26. Decide which request JSON objects are closed contracts, then enforce that boundary.** A
  strict shared mapper does not by itself make CEDAR's request contract consistent: Jersey binds
  some request DTOs, other resources convert selected subtrees by hand, and artifact endpoints
  deliberately accept extensible JSON-LD. Applying unknown-property rejection to every inbound
  object would therefore turn valid extension data into `400` responses.

  Inventory the request body of every endpoint and classify each object boundary as either closed
  or open. A closed command or options DTO should reject misspelled and unsupported fields. An
  artifact document, merge-patch body, JSON-LD object, or explicitly documented extension map
  should remain open. Record the same decision in OpenAPI: use `additionalProperties: false` only
  for closed objects, and leave open shapes explicit rather than relying on a mapper default.

  Route every closed DTO binding and manual tree conversion through the named strict mapper, remove
  `ignoreUnknown` annotations that contradict that contract, and test unknown properties at both
  the root and nested closed-object boundaries as `400` responses. For every open boundary, add a
  preservation or acceptance test so later cleanup cannot tighten it accidentally. Treat any
  endpoint that becomes stricter than its current behavior as a public API compatibility change:
  identify its callers, document the rejected shape, and stage the change through the normal
  release process rather than coupling it to response-reader compatibility work.

- **27. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee with its own
  boundary: ordinary editing is refused, and a verbatim write is not, because that write states the
  whole document rather than editing it and is how a defect in a published artifact's stored
  representation is corrected. Whichever way deletability is settled, the docs have both exceptions
  to describe.

- **28. Address artifacts by bare identifier in REST paths, keeping the full IRI as stored
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

- **29. Decide what each compatibility adapter is for, now that neither reads artifacts itself.**
  Repo and OpenView exist to preserve URLs rather than to do work: the runbook's account of artifact
  route ownership gives repo the identifier dereferencing URLs and OpenView the anonymous
  presentation and open-artifact URLs, and says neither adapter should own artifact storage or an
  independent read policy. Both used to open artifact's Mongo collections and read documents
  themselves. Neither does now — repo's four artifact routes and OpenView's four anonymous reads
  delegate to resource, and both services' artifact Mongo initialization is gone — so each one's
  artifact surface differs from resource's only by a hostname and a path convention.

  That makes the question live rather than answered. It is not the retirement question item 6 asks
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
  retirement takes the whole checklist item 6 states, and a reduction takes the part of it that
  applies.

  The prerequisite is already written down. The runbook's repo rollout asks for repo and resource
  reads to be compared across all four artifact types, as an owner and as another user, with matching
  bodies and ETags, private reads still denied, and neither a missing identifier nor a downstream
  outage producing a successful read. That comparison is what proving routing compatibility means,
  and no adapter should be reduced before it passes on the deployed topology.

  Item 28 settles a different question about the same two services — which path shape a route takes —
  and the two interact: retiring repo's routes would retire the bare-identifier convention that item
  28 proposes to generalize, so whichever is decided first constrains the other.

  Done when each of the two hosts has a stated role, an owner, and either a current caller that needs
  the process or a routing arrangement that keeps its URLs resolving without one.
