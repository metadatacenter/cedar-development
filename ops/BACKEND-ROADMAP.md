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

- **1. Decide on concurrency control.** There is no `ETag`, `If-Match` or `@Version` anywhere in the
  stack, so two users editing one template is a silent lost update: the second save wins and the
  first user is never told. This is a design item rather than a coverage item, since no test can be
  written until the API offers the conditional-request machinery.

- **2. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee and is
  unaffected either way — that one is enforced.

- **3. Clean up the DataCite DOI minting workflow.** Treat minting as one explicit, auditable lifecycle
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

- **4. Settle the sharing and permission model, then write it down.** This is the umbrella item: the
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

- **5. Decide whether the artifact server is allowed to have no authorization of its own.** The
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

- **6. Decide the contract for `title`/`internalName` across the YAML and JSON serializations.** A CEDAR
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

- **7. Decide what a count of zero means, and how "unknown" is written.** Three keys use zero as a
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

- **8. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
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

- **10. Point the token-verification client at a truststore in production.** Token-signature verification
  fetches the realm's signing keys over HTTPS; on the local stack that client trusts the self-signed
  `.orgx` certificate (`disableTrustManager` in `KeycloakDeploymentProvider`, matching the admin
  client). A real deployment should instead trust a truststore holding the realm CA. Small, and only
  matters outside local dev.

- **11. Stop using the hardcoded BioPortal key.** `Constants.BP_PUBLIC_API_KEY` in
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
  term-picker ontology-list item (18).

  The *safety* half of this is now done, on both `develop` and the `versioned-terminology-server`
  branch: a cold or rate-limited fetch that returns a handful of ontologies instead of the full ~1300
  is caught rather than served. `Cache.getOntologies()` treats a list below `MIN_EXPECTED_ONTOLOGIES`
  as a failed load and throws, and `TerminologyServerHealthCheck` now probes the list and reports the
  server unhealthy until it loads fully (it was a `2*2==5` placeholder that always passed). So a
  degraded key no longer silently serves a partial catalogue with names collapsed to acronyms
  ("DOID (DOID)" instead of "Human Disease Ontology (DOID)") behind a green health check. What remains
  here is the code-owned cause: read `CEDAR_BIOPORTAL_API_KEY` from config and delete the constant.

- **12. Identify API keys by a non-secret id, not the secret in the URL.** The API-key management routes
  carry the full secret in the path — `POST /{id}/api-keys/{key}/regenerate` and
  `DELETE /{id}/api-keys/{key}` — so the key lands in nginx access logs, request traces, monitoring and
  browser history. The cheap leaks are already closed (the not-found error no longer echoes the key and
  the valuerecommender reindex logs no longer print the admin key), but the URL itself still carries the
  secret. Give each `CedarUserApiKey` a stable non-secret identifier and address keys by that id
  (`/api-keys/{keyId}`), keeping the secret out of the path. Breaking change: cedar-cli and the profile
  UI call these routes, so it needs a coordinated client update.

- **13. Adopt Renovate, so a version that falls behind says so.** Every pin in this estate is
  maintained by someone remembering to look at it, and the measurement above is what that produces:
  the Docker OpenSearch image sat at 1.3.6 while the servers shipped the 2.19 client, for about two
  years, and nothing anywhere reported it. Renovate is a bot that reads the files a repository
  already has — `pom.xml`, `Dockerfile`, workflow files — works out what each dependency is pinned
  to, compares that against what upstream has published, and opens a pull request for each one that
  is behind, with the changelog in the body. It decides nothing and merges nothing. The point is
  that drift becomes visible the week it happens rather than whenever somebody next measures.

  **What is in place.** `cedar-docker-build/renovate.json`, committed 2026-08-08 and validated
  against Renovate's own config validator. It watches the six locked server versions in
  `bin/cedar-images-base.sh` through a custom manager keyed on the `# renovate:` comments above each
  one, groups them so they arrive as a single reviewable decision, sets a fourteen-day minimum
  release age, disables automerge everywhere, and holds Keycloak behind dashboard approval because
  what pins Keycloak is CEDAR's own code rather than the lock. It is inert: a config file is read by
  Renovate and does not cause Renovate to run.

  **Decide how it runs.** Two routes, and the difference is who holds write access.

  - The **Mend-hosted GitHub App**, installed on the `metadatacenter` org. Free, since these
    repositories are public. Installing it is a browser flow with an owner's approval — there is no
    API for it — and it grants a third party standing write access to org repositories. The org
    already runs `travis-ci`, `sonarqubecloud` and `gitguardian` on the same terms.
  - **Self-hosted in Actions**: a scheduled workflow running `renovatebot/github-action` with a token
    that can open pull requests. Nobody external gets standing access; the cost is a token to manage
    and some runner minutes.

  Expect a burst on the first run, whichever route: it opens pull requests for everything currently
  behind, and a dependency-dashboard issue. The concurrency limit and release age in the config exist
  to blunt that.

  **Then extend it to the Java repositories, where it is cheaper than it looks.** Renovate reads
  Maven natively — versions declared in `<properties>` and referenced as `${...}` in the same POM —
  so no custom manager and no annotation comments are needed, unlike the shell manifest. And the
  parent-POM rule pays off again: `cedar-parent` holds 93 version properties and is where every
  dependency version in the estate is declared, while the roughly thirty child POMs name
  dependencies without versions and so have nothing for a bot to update. One repository configured,
  the whole Java estate covered.

  Three things to settle before turning it on there, or the first run is worse than useless. The
  framework baseline moves as a set — Dropwizard, Jetty, Jersey and Hibernate hold together, and a
  lone Jetty bump breaks it — so those want grouping. Java 17 is locked and must not be offered.
  And `keycloak.version` would be offered 26.7.1, which cannot build, because
  `keycloak-adapter-core` stops at 25.0.3; it needs the same dashboard approval the Docker side
  already gives it.

  **One gap this opens.** `ops/check_version_pairing.py` runs in `cedar-docker-build` CI, so it
  guards the server half of each pair. A Renovate pull request that moved `opensearch.version` in
  `cedar-parent` would not be checked against the image — the same drift, arriving from the other
  direction. Run the check on `cedar-parent` pull requests as well, as part of configuring the Java
  side.

  **What it does not do,** and what therefore stays elsewhere: it does not know invariants. Nothing
  tells it that an OpenSearch server must match the client `cedar-parent` ships, which is why that
  lives in a check rather than in any bot's configuration.

  Worth recording one consequence of the declaration this item follows. Centralizing the six server
  versions into a shell manifest put them somewhere **Dependabot cannot see**: it reads `pom.xml` and
  `Dockerfile`, and the Dockerfiles now carry `ARG` rather than literal versions. Renovate's custom
  manager is what makes them watchable again. Adopting no bot at all remains a coherent choice — the
  versions are at least in one place now — but it means those six are watched by nobody, as before.

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
  last two are required because the admin tool has only a configuration test and the event listener
  has no tests at all.

## Testing

Coverage and test-infrastructure work. The active REST integration suites live in
`ops/e2e/rest/suites/`; the JUnit matrices and boot-smoke live in the per-server modules.

- **15. Decide whether the build runs the tests, expose the choice, and report continued failures
  honestly.** The Java build skips its tests again: every Java repo is built with
  `./mvnw clean install -DskipTests`, and the `CEDAR_DEV_SKIP_TESTS` escape hatch is gone with the
  default it modified. That restores the behaviour the build had before, and it means a green
  `cedarcli build` says the stack compiles and nothing more. Whichever way it settles reaches every
  Java repo in the generated plan, since `build this`, `build parent`, `build libraries`, `build
  project`, `build clients` and `build java` all expand through `BuildOperator`.

  **The default is the decision.** Running them is defensible: every suite is backend-free — in-memory
  auth and embedded Neo4j, Mongo, MariaDB and Redis — so a build needs nothing up, a full run is 3,749
  tests in under seven minutes, and a green build would then mean what CI means by it. Against it: the
  build is the inner loop, and seven minutes on every rebuild of a repo whose tests were green ten
  minutes ago is the cost that made the switch worth having in the first place. The default has flipped
  four times in the CLI's history, which is the argument for settling it as a documented default with a
  visible flag rather than as an environment variable somebody exports once and forgets.

  One obstacle to running them is already gone. The log flood that made an all-tests build unusable was
  one ~105-line Jedis stack trace per HTTP request: the suites point Redis at a dead port because queue
  writes are best-effort, and every expected failure logged its full cause. A recurring queue failure
  now logs the trace once and thereafter its type, message and a running total, so the drop stays
  visible and countable while the frames are printed once. The resource-server application tests fell
  from 400,192 lines (36 MB) to 13,555, and the queue services carry assertions that an unavailable
  queue drops and counts without failing the caller.

  **The option shape.** Typer offers a paired boolean, which is the right primitive: one option, one
  default, no way to pass both halves.

  ```python
  tests: bool = typer.Option(False, "--tests/--skip-tests",
                             help="Run the Java test suites. Default: skip.")
  ```

  It belongs on the seven `build` commands that can reach a Java repo — `this`, `parent`, `libraries`,
  `project`, `clients`, `java`, `all` — and not on `frontends`, where it would be inert and so a lie in
  `--help`. `BuildOperator.expand` is static and reached through the operator registry, so the value
  travels as a setting rather than a parameter: put `skip_tests` on `CedarCliSettings` beside
  `do_fail_on_error`, marked from the command through a `GlobalContext` classmethod, which is the
  pattern `mark_do_not_fail` already establishes. Carrying it on the plan instead would be cleaner and
  is only worth it if the value ever needs to vary per repo. The plan dump needs no work: the task is
  already named `Maven clean install` or `Maven clean install skip tests`, so `--dump-plan` and the
  saved plan script record which mode ran.

  Two places the flag must not silently reach. `ReleasePrepareShellTaskFactory` hardcodes
  `./mvnw clean install -DskipTests` and `PublishShellTaskFactory` hardcodes `./mvnw deploy -DskipTests`, so
  release and deploy builds never run tests whatever the flag says. Extend them deliberately or state
  it; do not leave `--tests` looking as though it covers them.

  Worth doing in the same pass: `CEDAR_DEV_BUILD_FRONTENDS` is the precedent this item invokes, and it
  has the same shape. Promoting it to `--frontends` / `--no-frontends` costs little extra and gives the
  CLI one convention rather than two — the skipped tasks are currently named
  `"… skipped because of CEDAR_DEV_BUILD_FRONTENDS"`, so their titles have to move with it either way.

  The remaining acceptance criterion is honest failure reporting. On failure with `fail_on_error` set,
  `PlanExecutor` exits 1 correctly. With it unset the error is disregarded and the run still prints
  "Execution succeeded!" and exits 0. A build that continued past a failure must record it, say so in
  the closing panel, and exit non-zero.

- **16. Deepen the core-workflow tests instead of growing the headline count.** The JUnit matrices and the
  REST suites now give the system respectable horizontal coverage: routes boot, authentication and
  permission boundaries are pinned, and create/read/update/delete, sharing, search, versioning and the
  cross-service hop all execute against the real stack. Much of that is deliberately
  characterization-level, though — a representative payload walks the happy path while many assertions
  check only a status or a field or two. The next pass should go vertical: failure semantics and state
  invariants on the resource ↔ artifact path, the one hop every core operation crosses (`contract.mjs`).

  In priority order:

  1. **Partial multi-store failure.** Inject a failure between the artifact-store write and the Neo4j
     graph update, for create, rename, publish, draft and delete. Assert the operation either rolls back
     or leaves a detectable, recoverable state — never a silently orphaned artifact, a stale graph node
     or a half-published version. This is the write-path counterpart to the read-path degradation-tests
     item (17), which asks only that a service not 500 when a dependency is down.
  2. **Retry and idempotency.** Repeat a write after a timeout or an ambiguous response. Publish, draft,
     move, delete, permission change and DOI-set must not produce a duplicate version, a duplicate graph
     node or divergent state.
  3. **Illegal state transitions.** Republish, draft-from-draft, invalid version progressions, mutating
     published content, deleting a published artifact, ownership transfer then versioning, and
     freeze-on-publish when some terminology versions cannot be resolved.
  4. **Payload boundaries.** For template, element, field and instance: malformed and minimally-valid
     bodies around required properties, nested composition, cardinality, identifiers, controlled terms
     and YAML/JSON round-trips. Assert the error body and the persisted post-state, not only the status.
  5. **Projection under an unavailable queue or index.** Grant, revocation, deletion and rename
     propagation through OpenSearch are now pinned in `finding.mjs`. What remains is the failure
     case: assert the projection still converges — or degrades
     safely — when the queue or the index is briefly unavailable, rather than losing the message.
  6. **Repeatability and reporting.** Run the REST estate twice against the same clean stack and fail on
     leaked fixtures; record an expected-check inventory; emit machine-readable results for CI. A change
     that quietly drops a loop, a suite or a conditional assertion should stay visible even when every
     remaining check passes — today the total shifts run-to-run as data-dependent suites (freeze) run or
     skip, which an inventory would render legible rather than noise.

  Not a request for exhaustive combinatorics, load testing or indiscriminate fuzzing. The target is
  depth at the few boundaries where CEDAR can accept a request yet leave its stores, permissions,
  versions or search projection disagreeing. The present suite protects the behavioural skeleton; this
  item protects the integrity of state when operations fail or are repeated.

- **17. Add degradation tests.** Nothing asserts how a service behaves when a dependency it needs is
  unavailable. The cost of that gap is known: reading any folder whose creator could not be resolved
  returned 500 for as long as the defect existed, because `UserSummaryCache` let Guava's
  "loader returned null" signal escape instead of degrading to the no-display-name path the callers
  already handled. A cheap form is one test per server that points a dependency at a dead port and
  asserts the API degrades rather than 500s. Bear in mind that queue writes are already best-effort
  by design (`AppLoggerQueueService`, the worker and NCBI queues), so those are the pattern to match.

- **18. Retry the ontology-list load in the term picker (frontend, `cedar-template-editor`).** This is a
  change to the Angular frontend, not to any microservice or test suite — it lands in
  `cedar-template-editor`, and so needs a frontend owner to review and push it (see the note below).
  It is the last piece of this defect still outstanding, and the fix is already written: it is open as
  PR #1014 (`fix/term-picker-ontology-retry`) on `cedar-template-editor`, awaiting a frontend owner's
  review and merge. The smoke half is done too, so until the PR lands the symptom is worked around
  rather than fixed.

  The template editor loads BioPortal's ontology list once per page load.
  `controlledTermDataService.init()` starts three cache loads and sets `initialized = true` on the
  next line, before any of them has returned, so the flag records that loading *began* rather than
  that it produced anything. When the ontology load fails, which is likeliest just after a redeploy
  while the terminology server is cold and BioPortal adds seconds, the empty cache is latched for the
  life of the page: every later `init()` sees the flag and returns. The user gets a transient warning
  toast from `handleServerError`, after which the "Add ontologies" box simply sits there empty,
  reading as BioPortal having no ontologies. Only a page reload recovers. Same defect class as the
  `UserSummaryCache` 500: a failed lookup latching its failure instead of retrying or degrading.

  Two things make the fix less trivial than "set the flag later", and both need respecting:

  Success cannot be read from the promises. `AuthorizedBackendService.doCall` sends failures to its
  error callback and returns that callback's value, and `handleServerError` returns the error rather
  than rethrowing, so the promise resolves either way and `$q.all` resolves on a total failure. The
  usable signal is whether `ontologiesCache` ended up with entries, which is also the condition that
  produces the visible symptom.

  Un-latching naively would be a request storm. `init()` is called from all ten getters, which is why
  the latch exists at all: leaving the flag `false` after a failure fires three requests per getter
  call. A working shape needs an in-flight guard so concurrent getters share one load, plus a floor
  on how often a failed load may be retried.

  This design is implemented in PR #1014 (`fix/term-picker-ontology-retry`): it replaces the single
  `initialized` boolean in `controlled-term-data.service.js` with a small state machine that retries
  instead of latching, and honours both constraints above — success is read from `ontologiesCache`,
  and an in-flight guard keeps concurrent getters sharing one load. What remains is not writing the fix
  but landing it: a frontend owner needs to review and merge the PR, since committing to
  `cedar-template-editor` needs an owner comfortable with the frontend.

  The end-to-end smoke no longer depends on this being fixed, which is what makes it a roadmap item
  rather than a blocker. Its create-template-and-constrain block retries as a unit, each attempt
  starting from the designer deep link, because that page load is the only thing that gives the
  service a fresh attempt; re-running the ontology search inside the picker reads the same empty cache
  and never could succeed. Nothing is saved server-side until after the block, so a failed attempt
  leaves no orphan template.

- **19. Switch the extracted Workspace and Template Designer over in staging, then production.**
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

- **20. Repair the production schema artifacts that can reject correctly shaped CEE instances.** The
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

- **21. Write `sourceSystem` onto the production value constraints, so that its absence means something.**
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

- **22. Decide whether to retire `cedar-mkdocs-developer`.** Its current release and production
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
