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

The dependency-degradation pass completed on 2026-08-26. Shared exception handling now returns a
sanitized `503 Service Unavailable` for transport failures from inter-service HTTP, Neo4j, MongoDB,
OpenSearch, JDBC and Redis. Real HTTP regressions cover the store or client boundaries owned by the
artifact, resource, monitor, user, group, messaging, value-recommender, OpenView and bridge servers;
worker queue retry, dead-letter and dependency-health behavior is covered separately. The remaining
direct clients have intentional contracts: terminology pin resolution during publication is
fail-safe and counted, monitor's Keycloak detail is an explicitly partial diagnostic, submission's
messaging and FTP calls run in background submission processing, and DataCite minting remains the
larger lifecycle refactor tracked below.

## Next

### Features

- **1. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee and is
  unaffected either way — that one is enforced.

- **2. Clean up the DataCite DOI minting workflow.** Treat minting as one explicit, auditable lifecycle
  rather than a preparatory GET followed by a loosely coupled POST. The mutation endpoint must itself
  enforce write access and the source artifact's open/published requirements — today those checks are
  made only by the GET, so a caller can bypass them by invoking the POST directly. It also computes the
  CEDAR-instance validation result but never refuses an invalid instance.

  Make the external operation idempotent and recovery-safe. A successful DataCite publish is currently
  followed by a local DOI-annotation update whose response is ignored; if that update fails, DataCite
  has minted the DOI while CEDAR still appears to have none. Define durable states for draft/reserved,
  published and locally attached; retain the DataCite identifier before any fallible follow-up; and
  make retries resume or reconcile the same DOI rather than create an orphan or duplicate. Tighten how
  an existing draft is associated with its source artifact, and report DataCite and local persistence
  failures distinctly.

  Extract the HTTP client and orchestration from `DataCiteResource`, centralize configuration and error
  mapping, and pin the lifecycle with unit tests using a fake DataCite boundary: unauthorized direct
  POST, invalid metadata, create-versus-update, retry after timeout, DataCite success/local update
  failure, and repeated publish. Keep normal tests offline; add only an opt-in DataCite sandbox smoke
  test for the final wire contract and credential/configuration check.

- **3. Settle the sharing and permission model, then write it down.** This is the umbrella item: the
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

  The deliverable is **a permissions document** — there is none today, and its absence is the root of
  everything above. It should state the tiers, what each confers, how inheritance interacts with
  ownership, what `ATTACH` is for, and which of the listed behaviours are intentional. Only then is it
  worth making the code and the enum agree with it.

  Pinned by `FolderPermissionLevelMatrixTest`, `ArtifactPermissionLevelMatrixTest`,
  `SharingRoundTripTest`, `ArtifactsAndCategoriesAuthorizationMatrixTest`,
  `GroupMembershipAuthorizationMatrixTest`, `GroupSharingRevocationIntegrationTest`,
  `ArtifactLifecycleMatrixTest` and `ops/e2e/rest/suites/categories.mjs`.

- **4. Decide whether the artifact server is allowed to have no authorization of its own.** The
  workspace model in the item above lives in Neo4j and is enforced by the resource server. The
  artifact server, which holds the artifacts themselves in Mongo, consults none of it. Every path in
  `AbstractArtifactCrudResource` — create, find, find-all, update, delete — asks the same two
  questions and no others: is the caller logged in, and does the caller hold the matching global
  permission. Those permissions come from `templateCreator`, which the `normal` blueprint grants to
  everyone, and no resource id appears in any assertion. The server then reads or writes Mongo by id.

  So an ordinary account reaching that server directly can read, list, change or delete any artifact
  in the installation. Measured on 2026-08-13 against the dev stack, as user 2 with a plain password
  grant: `GET /templates/{id}` for an artifact owned by user 1 answers **403 through the resource
  server and 200 through the artifact server**, and `GET /templates` returns every template in the
  datastore. Nothing in the code distinguishes the two callers; only which door they used.

  This is a deliberate architecture rather than a missing check — the artifact server has no ACL data
  to consult — and the defence is topological: the deployment is supposed to make the server
  unreachable except from inside. That holds unevenly. The container stack does not publish 9001 at
  all, so it is closed there. The production nginx blocks the artifact vhost, with a comment saying
  external callers must go through the resource server. The dev host does neither: nginx proxies
  `artifact.metadatacenter.orgx` straight to `127.0.0.1:9001` over public HTTPS, and the process
  binds every interface, so the port answers on the LAN as well.

  The decision to make is which of these the model actually is, because they lead to different work:

  - **Topology is the boundary, and the estate must match it.** Cheapest, and it accepts that the
    datastore API is trusted-network-only forever. Then the dev nginx should block the vhost as
    production does, the application connectors of services that only ever serve other CEDAR services
    should stop binding every interface, and both belong in the runbook as a property of the
    deployment rather than something each environment rediscovers.
  - **The artifact server authorizes for itself.** It either consults the workspace graph — which
    couples it to Neo4j and costs a lookup per request — or it accepts a signed assertion minted by
    the resource server, which keeps the datastore ignorant of the ACL but introduces a trust
    relationship and a key to manage. Either is a design change, not a patch.
  - **Nothing but the resource server may hold a token this server accepts.** A service credential
    rather than a user one, so an ordinary account cannot address it whatever the network allows.

  Worth settling alongside the item above rather than after it: that one asks what the permission
  levels mean, and this one asks which services are entitled to ignore them. A model that is
  specified but only enforced at one of two doors is not yet specified.

- **5. Decide the contract for `title`/`internalName` across the YAML and JSON serializations.** A CEDAR
  artifact carries two names. The JSON has a JSON-Schema `title` (and `description`) alongside
  `schema:name` (and `schema:description`); the YAML has only `name` (and `description`). In the model
  the two are independent — the artifact library calls the JSON-Schema one `internalName` — but the
  YAML has nowhere to put it, so the pair collapses to one name on the way out and must be reconstructed
  on the way back. The convention is that `title` is `"<name> <type> schema"`, derivable from the name,
  and both libraries now rebuild it that way when reading YAML (fixed in `cedar-model-typescript-library`;
  the Java `YamlArtifactReader` composes the identical strings). That keeps a YAML-sourced artifact
  valid — the meta-schema requires a non-empty `title` — but it is a **lossy, normalizing** round-trip,
  and that is the thing to decide on rather than leave implicit:

  - Any artifact whose `title` does *not* follow the derived convention (an author set it independently
    of `schema:name`) loses that title through YAML; it comes back as `"<name> <type> schema"`.
  - `description` carries generator provenance in practice — `"… generated by the CEDAR Template Editor
    2.6.19"` — which the YAML does not store; the reconstruction substitutes a fixed `"… generated by the
    CEDAR Artifact Library"`, so a JSON → YAML → JSON trip rewrites provenance.

  So either `title`/`description` are accepted as *derived* fields that are not authored independently of
  the name (in which case the model could stop storing them separately and always compose them, and this
  should be documented as the contract), or they are first-class and the YAML serialization needs a place
  to carry them. The equivalence is pinned generatively in
  `cedar-embeddable-editor/harness/test/format-independence-generative.spec.ts` and the derivation in the
  library's `YamlTitleDerivation` / `YamlJsonConstraintParity` specs; this item is the design decision
  those tests currently encode by default.

- **6. Decide what a count of zero means, and how "unknown" is written.** Three keys use zero as a
  sentinel where the schema gives zero a quantity, and the answer to any one of them is the answer to
  all three.

  **`maxItems: 0`, meaning unbounded.** The Template Designer emits it for an unbounded multi-instance
  field: its cardinality selector labels the zero "unlimited" (`cardinality-selector.directive.js`,
  `zeros = {'min': 'none', 'max': 'unlimited'}`), `defaultMinMax` in
  `cedar-template-element.directive.js` sets it on every new multi-instance element, and the runtime
  directives guard with `!maxItems || model.length < maxItems`, so zero is falsy and imposes no
  ceiling. Omitting the key would say the same thing better: an absent `maxItems` already means
  unbounded to every consumer, and it is what JSON Schema means, where `maxItems: 0` constrains an
  array to be *empty* — the exact opposite. The current encoding does not merely duplicate the default,
  it inverts the standard reading, so any tool validating a CEDAR template as ordinary JSON Schema
  draws the wrong conclusion. `cedar-artifact-library` rejected `maxItems < 1` outright until
  `ValidationHelper.UNBOUNDED_MAX_ITEMS` was introduced; it now accepts zero and skips the
  `minItems <= maxItems` check when the maximum is unbounded. That is tolerance of the convention
  rather than endorsement, and whichever way this is decided the library has to keep reading zero,
  because templates already stored carry it.

  **A value set's `numTerms: 0`, meaning nobody knew.** Every party to that fact allows absence — the
  Java record holds `Optional<Integer>`, the TypeScript model class `number | null`, the JSON omits
  the key — and the TypeScript value-set builder now takes `number | null` too, where it once
  defaulted to zero. What the builder no longer forces, stored data still carries: `template-023` bound
  a field to the CADSR-VS *Progressive Disease* value set and recorded `numTerms: 0` for it, a set with
  terms in it whose count nobody had. Both libraries write such a zero through faithfully as
  `termCount: 0`, so a reader cannot tell an empty value set from an unmeasured one.

  **An ontology's `numTerms: 0`, which blocks saving outright.** GAZ's count comes back `n/a` from the
  terminology layer, the editor serialises the constraint with zero, and the meta-schema requires
  `minimum: 1` there — so the template cannot be saved at all. That one is tracked with its producer on
  [TEMPLATE-DESIGNER-ROADMAP.md](./TEMPLATE-DESIGNER-ROADMAP.md), and only one of its three fixes is
  the designer's to make alone.

  Two pieces of work follow the decision. The **frontend** stops writing zero where it means something
  else, which belongs to the Template Designer's roadmap; the decision is tracked here because it binds
  the meta-schema and both model libraries. And the **stored artifacts** already carrying a zero have
  to be patched — two preprod captures in the corpus still show one, beside corrected copies naming
  real counts. The production-audit and patch procedure is documented in
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), "Patching stored artifacts".

  Related, and cheap to settle alongside: single-instance fields can carry stray cardinality keys. In
  one working template `publication_doi` is `"type": "object"` yet has `minItems: 0, maxItems: 0`. The
  reader drops both, taking cardinality only from a `{type: array, items: {…}}` envelope. Establish
  whether the frontend writes those or whether they are residue from a field that was once
  multi-instance.

### Infrastructure

- **7. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
  build manifest, while the client libraries have moved on. The
  [Docker roadmap](./DOCKER-ROADMAP.md) owns the shared build and deployment lock; this item owns the
  remaining server upgrades. Order them by risk, lowest first:
  Five are **done** on 2026-08-08, each taken together with containerizing that store: Redis
  6.2.7 → 7.2.7, OpenSearch 1.3.6 → 2.19.1, Mongo 5.0.14 → 5.0.31, Neo4j 5.3.0 → 5.26.0 and MySQL
  8.0.32 → 8.4.11, the last of those also moving off Oracle's abandoned `mysql/mysql-server` base
  onto the Docker Official image. **Keycloak is the exception and is still at 22**, held there by
  CEDAR's own code rather than by this lock: it runs a forward-only Liquibase schema
  migration on the existing user store, and it is the only one of the six where CEDAR's own code, not
  just a pin, decides how far the server can go. What that amounts to is measured below. Rehearse each
  on a copy of production data and gate on the end-to-end smoke.

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

  The four that are done moved in development only, where the pin move and the containerization were
  one piece of work per store. Production is the part this item still owns: the same versions, but
  rehearsed on a copy of production data and gated on the end-to-end smoke. Where the order above and
  the Docker roadmap disagree, the Docker roadmap governs, since it sequences the remaining work.

- **8. Decide whether the schema server should exist.** Its entire HTTP surface is an index page, but
  it still inherits the full microservice bootstrap: a Neo4j user service, Keycloak token
  verification, and the persistent Redis application-log queue. That costs an application process,
  an image, a CI build, a deployment and infrastructure connections in every environment without
  serving a schema API.

  Either retire the service and remove it from the native and Docker estates, or record the role it
  is reserved for and give it a deliberately minimal bootstrap that does not initialize dependencies
  its index page never uses. Whichever route is chosen must update the service inventory, health and
  smoke expectations, build train, Compose projects and deployment documentation together.

- **9. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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

- **10. Move the server framework to Dropwizard 5 / Jetty 12 / Jakarta EE 10.** The current
  Dropwizard 4.0.17 baseline holds every server on Jetty 11.0.26, Jersey 3.0.18 and Hibernate
  6.1.7.Final. Jetty 11 and Hibernate 6.1 are both end-of-life upstream lines, so pinning their last
  releases does not restore community security maintenance. Dropwizard 5 is the coordinated escape:
  its supported bundle moves to Jetty 12, Jersey 3.1, Hibernate 6.6 and the Jakarta EE 10 APIs.

  Treat this as a framework migration, not part of the Java 21 item above. Dropwizard 5 still runs on
  Java 17, while the EE10 move changes servlet artifacts, Jetty handlers, Hibernate behavior and the
  BOM versions currently overridden in `cedar-parent`. Inventory direct Jetty/Jersey/Hibernate and
  Jakarta API usage first; move the parent and shared libraries as one converged set; then rebuild all
  server reactors, boot every shaded application, run the JUnit and REST estates, and compare the
  dependency trees and shaded contents for mixed EE9/EE10 artifacts. Remove parent overrides that
  merely hold the old Dropwizard bundle together rather than carrying them forward by default.

  The acceptance gate is all fifteen servers starting on the new bundle with no split Jakarta API,
  Jetty 11, Jersey 3.0 or Hibernate 6.1 artifacts left in their runtime jars, followed by the real-stack
  smoke. Until this lands, record Jetty 11 and Hibernate 6.1 as explicitly accepted EOL dependencies in
  release review and check upstream/security advisories for each release instead of describing the
  current pins as a maintained baseline.

- **11. Prove secure Keycloak TLS in every deployed environment.** This was a code vulnerability, not
  merely a future truststore configuration task: the bearer-token client disabled certificate and
  hostname checks while fetching signing keys, and the admin client sent the CEDAR administrator
  password through a trust-all manager. Both clients now default to JVM certificate and hostname
  verification, with only an explicit native-development flag able to restore the bypass. The
  remaining deployment gate is to confirm that staging and production leave
  `CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS` absent or `false`, trust the Keycloak issuer CA, and pass both a
  JWKS-backed token verification and a read-only admin operation. Never solve a failed trust check by
  enabling the development flag.

- **12. Rotate the Keycloak providers in every realm the leaked seed reached.** The 2023-07-05
  development realm export carried its RSA token-signing key, HS256 secret and AES secret, and both
  committed copies sat in public repositories, so those providers must be treated as publicly known.
  Stripping the seed (done, with guard tests and a CI workflow in both repositories) protects only
  realms created after it: Keycloak stores providers in MySQL, so every realm that ever imported the
  old seed — production, staging, and long-lived local stacks alike — still signs tokens with the
  exposed key, and a token it "verifies" proves nothing. In each such realm, create fresh signing,
  HMAC and AES providers, delete the imported ones, and only then treat the installation as trusted;
  rotation invalidates outstanding tokens, so users sign in again. The keys also remain recoverable
  from git history, which is why rotation, not the strip, is the fix. Done when every deployed
  realm's providers postdate 2026-08-26 and the production deployment runbook's pre-flight carries
  the check.

- **13. Stop using the hardcoded BioPortal key.** `Constants.BP_PUBLIC_API_KEY` in
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
  because the picker latches its empty cache for the life of the page: the same defect as the
  now-fixed term-picker ontology-list failure.

  The *safety* half of this is now done, on both `develop` and the `versioned-terminology-server`
  branch: a cold or rate-limited fetch that returns a handful of ontologies instead of the full ~1300
  is caught rather than served. `Cache.getOntologies()` treats a list below `MIN_EXPECTED_ONTOLOGIES`
  as a failed load and throws, and `TerminologyServerHealthCheck` now probes the list and reports the
  server unhealthy until it loads fully (it was a `2*2==5` placeholder that always passed). So a
  degraded key no longer silently serves a partial catalogue with names collapsed to acronyms
  ("DOID (DOID)" instead of "Human Disease Ontology (DOID)") behind a green health check. What remains
  here is the code-owned cause: read `CEDAR_BIOPORTAL_API_KEY` from config and delete the constant.

- **14. Separate CEDAR dependency convergence from the Keycloak provider platform lock.** The eleven
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

- **15. Retire routine `CEDAR_VERSION_MODIFIER` cache busting.** Frontend code identity now comes
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

## Testing

Coverage and test-infrastructure work. The active REST integration suites live in
`ops/e2e/rest/suites/`; the JUnit matrices and boot-smoke live in the per-server modules.

- **16. Switch the extracted Workspace and Template Designer over in staging, then production.**
  Local coexistence is complete: the monolith remains on `cedar.metadatacenter.orgx`, Workspace and
  Designer run on their own trusted HTTPS origins, Keycloak SSO spans them, the provenance gate
  passes, and the complete Workspace → Designer → CEE → OpenView authenticated journey passes
  against the same backend data. That proves the separation mechanics; it does not authorize an
  environment cutover.

  **Staging is the acceptance environment. Complete every infrastructure gate before changing a
  canonical route:**

  1. **Names and DNS:** ratify the exact Workspace and Designer HTTPS hostnames; create their DNS
     records to the staging ingress; preserve the staging monolith name; and record the intended
     canonical and compatibility routes. The two new payloads must also be reachable for direct
     pre-cutover health checks.
  2. **TLS certificates:** issue certificates from the environment's approved CA with the exact
     Workspace and Designer DNS names in the SAN extension. Install the full chain and private key on
     every terminating ingress, keep keys out of Git, and verify file ownership, SNI selection, SANs,
     chain trust, expiry, and HTTPS redirects. Add both certificates to the ordinary renewal and
     expiry-monitoring process; do not replace or stop renewing the monolith certificate.
  3. **Nginx and frontend configuration:** staging has no Docker prerequisite. Add independent
     virtual hosts whose roots are the native `cedar-workspace/app` and
     `cedar-template-designer/app` trees, matching the existing monolith pattern; validate the
     complete config with `nginx -t`; configure
     SPA fallback, no-store for entry/config/build-info responses, immutable caching only for
     content-addressed assets, and the temporary 302/307 legacy-route redirects. Supply absolute
     `workspaceFrontend`, `templateDesignerFrontend`, OpenView, monitoring, Keycloak, and REST URLs for
     staging—no localhost or production fallback is acceptable.
  4. **Keycloak:** add each exact HTTPS callback (`https://<host>/*`) and exact Web Origin
     (`https://<host>`, with no path) to the selected staging public client. Preserve the monolith
     entries during coexistence. Decide and document whether staging and production will continue with
     one migration client or use a client per frontend, then verify login, logout, SSO, cold deep links,
     and expired-session recovery from both new origins.
  5. **Backend CORS:** inventory every staging browser origin still in use, including the monolith and
     OpenView, and set the exact comma-separated `CEDAR_CORS_ALLOWED_ORIGINS` on every REST service that
     installs the shared CORS filter. Rebuild and rolling-redeploy those services, then require positive
     credentialed preflights from every approved origin and rejection of a deliberately unlisted origin.
  6. **Payload and CEE identity:** explicitly publish the two npm packages to Nexus with
     `cedarcli publish split-frontends`, check out the approved Git commits on staging, and generate
     clean native static trees with `cedarcli build split-frontends --server-payload`. Deploy those
     provenance-stamped Workspace and Designer payloads beside the monolith.
     `propagate-cee-release.mjs --check <CEE_VERSION>` must pass all seven consumer
     manifests; the Workspace-served CEE sha256 must equal the published package artifact—not merely
     report the same version label. Record npm versions and integrity, source commits, served-tree
     hashes, CEE hash,
     runtime configuration, Keycloak client export, CORS list, certificate fingerprints and expiries,
     and the nginx include checksum.
  7. **Acceptance and rollback:** run cold and expired sessions; exact Designer and CEE `returnTo`;
     folders, search, sharing and permissions with two users; create/edit/save/delete for templates,
     fields and instances; live terminology; JSON/YAML and OpenView; old bookmarks; CORS controls;
     cache headers; and CDN behavior. Rehearse the complete nginx route-table swap and one-step monolith
     restoration without rebuilding or stopping any payload. A rollback must also leave the previous
     monolith certificate, Keycloak entries, CORS origin, and static payload valid.

  **Production repeats the accepted operation rather than inventing a new one. Complete these gates:**

  1. Create the final DNS records and lower any affected canonical-name TTL far enough ahead of the
     window to make rollback timely. Issue, install, verify, monitor, and test-renew the final Workspace
     and Designer certificates before exposing the new routes. Keep every certificate required by the
     monolith and compatibility hostnames valid throughout the rollback soak.
  2. Add the exact production Keycloak callbacks and Web Origins without removing the monolith entries.
     Activate the exact production CORS inventory through a rolling backend deployment, retaining each
     old origin for as long as users or rollback can reach it. Pass login/SSO and positive/negative CORS
     checks before the route switch.
  3. Check out the exact Workspace and Designer release commits accepted in staging and regenerate
     their native server payloads alongside the still-served monolith. Verify them through their final
     SNI hostnames or a controlled host-header probe, and reject any changed npm version/integrity,
     source SHA, served-tree hash, CEE hash, or runtime endpoint. Do not introduce Docker as a cutover
     dependency.
  4. Save the active nginx include and its checksum, install and validate the complete split include,
     then switch only that route table. Use temporary 302/307 compatibility redirects, purge affected
     entry/config/redirect objects from every cache/CDN layer, and run the public authenticated journey,
     old-bookmark checks, direct health probes, and build-identity checks.
  5. Roll back immediately by restoring the saved monolith include on any authentication,
     create/open/save, permission, exact-return, TLS, CORS, or material parity failure. The rollback must
     not require DNS propagation, certificate issuance, a frontend rebuild, a Keycloak edit, or a backend
     redeploy. Keep the monolith process or static payload, bundle, configuration, certificate,
     Keycloak entries, CORS origin, and CEE pin deployable for the agreed soak.
  6. Only after the soak closes and fix-forward ledgers are reconciled may operations raise DNS TTLs,
     remove obsolete monolith callbacks or CORS origins, stop renewing unused certificates, remove
     compatibility redirects, or retire the monolith payload. Capture each removal as a separate,
     reversible cleanup change.

  This item is complete only when staging acceptance and rollback evidence are signed off, production
  has passed the same gates, the soak closes without a rollback trigger, and the ordinary deployment
  and CEE release procedures build Workspace as a first-class target rather than a migration exception.

## Production data

- **17. Repair the production schema artifacts that can reject correctly shaped CEE instances.** The
  permission-scoped production audit found 76 inherently-multiple fields deployed as JSON objects in
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

  Keep the broader legacy population out of this first patch. The same audit found 4,524 artifacts with
  repair-on-save conditions — chiefly missing `@context.required` entries, empty `pav:derivedFrom`, and
  child IDs or property IRIs that the server would mint. Those are not the cause of the instance-save
  failure and should receive separately scoped, field-preserving patch rules rather than hitchhiking on
  this urgent repair. Empty `pav:derivedFrom` is the first candidate because the strict Java reader
  cannot open it even though the compatibility reader and ordinary update can recover it.

  Finally reconcile the inventory boundary. Two search results point at artifacts that the typed
  resource endpoint returns as 404, and two duplicate search rows make the reported row count exceed
  the unique audit set. Determine whether each is a stale search/workspace projection or a missing
  artifact before changing anything; then repair the projection from the authoritative stores and
  rerun the audit to `COMPLETE_FOR_KEY`. Never delete a store artifact merely because its search entry
  is inconsistent.

- **18. Write `sourceSystem` onto the production value constraints, so that its absence means something.**
  A controlled-term constraint may name the system serving its vocabulary, and both model libraries read
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
  display string is separately defective — 497 of those 504 HuBMAP branch constraints record
  `"undefined (HRAVS)"` where BioPortal has the real name — so each wants a rule of its own rather than a
  ride on this one. Background work with no deadline of its own. Its value lands at the terminology
  cutover, which means it has to be finished before a second source system is served, not before
  anything else.

## Documentation consolidation

- **19. Decide whether to retire `cedar-mkdocs-developer`.** Its current release and production
  deployment pages now point to the maintained runbooks in `cedar-development/ops`, and its generated
  `site/` tree is no longer versioned. What remains potentially unique is a small set of Neo4j
  diagnostic and repair recipes, cron-job notes, user/domain/certificate maintenance procedures, and
  the explicitly labelled 2019–2023 archive. That material is useful, but a standalone documentation
  repository is not automatically the right permanent owner for it.

  Start with an ownership and consumer inventory: check repository and Read the Docs settings, inbound
  links, search indexing, release/deployment references, and any team workflow that still edits or
  serves this site. Classify every non-archived page as live, superseded, or historical. Move live
  operational knowledge beside the tooling it describes: cross-cutting runbooks and Neo4j repair
  procedures into `cedar-development/ops`, `cedar-util` cron instructions into `cedar-util`, and public
  user/developer material into `cedar-mkdocs`. Do not copy a live procedure into two repositories.

  Before retirement, decide whether the dated archive has value beyond Git history. If it does, retain
  one clearly non-executable archive in the canonical operations documentation; otherwise rely on the
  repository history. Then replace the repository home page with a short tombstone linking each new
  owner, disable any stale documentation build, update inbound links, and verify that a clean search
  finds no current instructions that still depend on the old location. Archive the GitHub repository
  only after the operations owners approve that inventory and the migrated pages pass their ordinary
  documentation build. If the inventory finds an active audience or a useful publication boundary,
  keep the repository and record that decision instead of retiring it by assumption.
