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

- **3. Decide whether four narrowly used servers should be retired.** Treat each as an explicit
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

- **4. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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
  Keycloak's JVM the same treatment when its own upgrade lands. Maven is no longer part of this
  problem — every Java repository now carries a wrapper at 3.9.14 and CI invokes `./mvnw` — except
  inside the build images, which still `microdnf -y install maven` unversioned.

- **5. Complete the remaining backend trust-boundary, transport and credential security work.**

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

  Requiring a credential is not the remedy, for the reason item 6 gives: third-party deployments of
  the embeddable editor call these routes from a browser with nothing to send, so a gate would break
  every host that embeds it. Both methods now carry that reasoning where the check is disabled, and
  the OpenAPI no longer promises a `401` neither route sends. What bounds the cost is the edge rate
  limit in item 6, which covers `/ext-auth/*` and should cover these two on the same terms.

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

- **6. Rate limit the edge in every environment.** Nothing in CEDAR bounds how often an anonymous
  caller may spend the deployment's third-party quota. The `/ext-auth/*` routes are the clearest
  case: they proxy seven registries, three of them on credentials the deployment holds, and they
  carry none of their own. `POST /bioportal/integrated-search` and `/bioportal/integrated-retrieve`
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

- **7. Separate CEDAR dependency convergence from the Keycloak provider platform lock.** The eleven
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

- **8. Retire routine `CEDAR_VERSION_MODIFIER` cache busting.** Frontend code identity now comes
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

## Production data

- **9. Normalize production artifacts to one explicit model contract.** Production contains several
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
  canonical result. This decision does not make `description` derived, and the title patch must not
  rewrite description or provenance text.

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

  Child definitions present in `properties` but absent from `_ui.order` are another such repair, and
  production contains enough of them that the model libraries cannot simply start refusing the shape.
  Add a raw-store audit rule that distinguishes this case from the inverse drift (an order entry with no
  property), then offer an idempotent, field-preserving rewrite that appends each omitted child key after
  the existing order without changing or deleting the child definition. Capture the production count and
  paths as a reviewed manifest, cover direct and nested containers, and prove a second run makes no
  changes. Only after that repair has run and a repeated audit reports zero omitted children should the
  Java and TypeScript readers replace their current cleanup behavior with strict rejection. Keep the
  inverse drift report-only: the store does not contain enough information to synthesize a missing child.

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

- **10. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee and is
  unaffected either way — that one is enforced.

- **11. Finish the DataCite DOI minting lifecycle.** The durable lifecycle is what makes the operation
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
