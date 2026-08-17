# CEDAR Backend — Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).
Frontend work for the embeddable editor is tracked separately in
[CEE-ROADMAP.md](./CEE-ROADMAP.md).

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
  real counts, and how far that generalizes is the query every item under
  [Production Artifact Patch](#production-artifact-patch) starts with.

  Related, and cheap to settle alongside: single-instance fields can carry stray cardinality keys. In
  one working template `publication_doi` is `"type": "object"` yet has `minItems: 0, maxItems: 0`. The
  reader drops both, taking cardinality only from a `{type: array, items: {…}}` envelope. Establish
  whether the frontend writes those or whether they are residue from a field that was once
  multi-instance.

- **8. Finish the identifier rule where it does not yet reach.** The rule itself is enforced and
  documented — only the repository assigns identity, a client writes `null` where the schema requires
  the key and leaves it out where it does not, and the server fills occurrence identifiers and
  attribute property IRIs on create and update. A template now types an occurrence's `@id` as
  `["string", "null"]`, so a draft carrying one validates before it is sent, which it could not do
  while the same key was typed a bare string. How all of it behaves is in
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), "Identifiers: what a client sends, and what the server
  fills", and it covers a child's property IRI too: the libraries no longer derive one from the
  child's name, and the server assigns it on create and update. What is left is two loose ends,
  neither of which a client can see.

  **Pruning a term when an attribute is renamed or deleted**, which needs the template. The rule that
  looks sufficient is not: dropping a term in the CEDAR properties namespace whose name is no key in
  the document would delete the mappings for children an instance does not fill, and `instances/005`
  carries two. Only the template tells a child from a deleted attribute. The server resolves
  `schema:isBasedOn` during validation, so it can be had — but `LinkedDataUtil` has no artifact
  lookup, so this belongs where the template is already in hand. What is already stored is a patch
  item below.

  **The same three body shapes over YAML.** `ops/e2e/rest/suites/validation.mjs` pins them over JSON:
  `@id: null` validates and creates, an omitted key does neither, a real IRI validates but create
  refuses it. Validate, create and update all negotiate YAML as well, so the same three need
  confirming there rather than assuming they follow.

- **9. Decide whether a child artifact must carry `$schema`.** The Java reader throws
  `ArtifactParseException: No text value present for field $schema` on a template whose nested fields
  omit it; the TypeScript reader records a blueprint departure and carries on. Templates in the wild
  carry the omission — one local template had it on 204 artifact nodes — so this is the difference
  between a template CEE renders and a template no Java-side tool can read at all. Which side is right
  is a model question; that the two answer differently is a portability problem either way, and it is
  the last disagreement between the two model libraries that anyone has to decide.

  Two others are recorded rather than open. A document stating `modelVersion` at its root whose
  children state none is read by the Java library and refused by the TypeScript one, which demands a
  model version of every child; `YamlReaderStrictness.spec.ts` pins that as deliberate, and the
  document is a hybrid nobody should write, since a template being authored is compact throughout and
  a stored one is full throughout. And the two classify an empty array inside an instance
  differently — Java as an empty multi-instance field, TypeScript as an empty list — while agreeing on
  every byte they emit for it. Neither costs anything today.

  Everything else the two once differed on is closed. They write byte-identical YAML for all 81 corpus
  artifacts in the full form and the compact one, their JSON matches over the same set, and each reads
  every document the other writes. How to re-check that is in
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), under "YAML is a native artifact format".

### Infrastructure

- **10. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
  images and nowhere else, while the client libraries have moved on. The record that would say what
  they are pinned *to* does not exist yet; establishing it is part of item 15, and this item is parked
  behind it, since it defers to a lock that currently names six servers and no versions. Order them by
  risk, lowest first:
  Five are **done** on 2026-08-08, each taken together with containerizing that store: Redis
  6.2.7 → 7.2.7, OpenSearch 1.3.6 → 2.19.1, Mongo 5.0.14 → 5.0.31, Neo4j 5.3.0 → 5.26.0 and MySQL
  8.0.32 → 8.4.11, the last of those also moving off Oracle's abandoned `mysql/mysql-server` base
  onto the Docker Official image. **Keycloak is the exception and is still at 22**, held there by
  CEDAR's own code rather than by this lock: it runs a forward-only Liquibase schema
  migration on the existing user store, and it is the only one of the six where CEDAR's own code, not
  just a pin, decides how far the server can go. What that amounts to is measured below. Rehearse each
  on a copy of production data and gate on the end-to-end smoke.

  No longer parked at the end. Containerizing the data stores needs each image pin moved up to the
  version already running, because an older engine cannot open existing data files, so this item is
  what unblocks the last step of item 15 rather than something to take up afterwards. MySQL is the
  real decision left among the data stores; Keycloak is its own piece of work.

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
  item 15's disagree, item 15 governs, since it is what sequences the remaining work.

- **11. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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

- **12. Point the token-verification client at a truststore in production.** Token-signature verification
  fetches the realm's signing keys over HTTPS; on the local stack that client trusts the self-signed
  `.orgx` certificate (`disableTrustManager` in `KeycloakDeploymentProvider`, matching the admin
  client). A real deployment should instead trust a truststore holding the realm CA. Small, and only
  matters outside local dev.

- **13. Stop using the hardcoded BioPortal key, and rotate it.** `Constants.BP_PUBLIC_API_KEY` in
  `cedar-terminology-server` holds a literal BioPortal key, and `Cache` sends it on the four calls
  that populate the ontology and value-set caches (`findOntology` twice, `findAllOntologies`,
  `findAllValueSets`). Those are the server's own calls rather than calls made for a signed-in user,
  so production runs on that key at every start and every cache refresh. The configured path already
  exists and is used elsewhere: `CEDAR_BIOPORTAL_API_KEY` reaches `BioPortal.getApiKey()` through
  `cedar-main.yml`. Read the key from there and delete the constant. `Cache` is static, so the
  configuration has to be threaded in, which is why this belongs to the terminology rewrite rather
  than ahead of it.

  Rotating the key at BioPortal is separate, needs no code change, and should not wait. The
  repository is public and the constant dates from its earliest configuration commits, so the key has
  been readable by anyone for years. BioPortal rate-limits per key, and a burnt quota surfaces to
  users as controlled terms silently not existing, because the picker latches its empty cache for the
  life of the page: the same defect as the term-picker ontology-list item (18).

  The *safety* half of this is now done, on both `develop` and the `versioned-terminology-server`
  branch: a cold or rate-limited fetch that returns a handful of ontologies instead of the full ~1300
  is caught rather than served. `Cache.getOntologies()` treats a list below `MIN_EXPECTED_ONTOLOGIES`
  as a failed load and throws, and `TerminologyServerHealthCheck` now probes the list and reports the
  server unhealthy until it loads fully (it was a `2*2==5` placeholder that always passed). So a
  degraded key no longer silently serves a partial catalogue with names collapsed to acronyms
  ("DOID (DOID)" instead of "Human Disease Ontology (DOID)") behind a green health check. What remains
  here is the *cause*: read `CEDAR_BIOPORTAL_API_KEY` from config, delete the constant, and rotate the
  exposed key so the partial loads stop happening in the first place.

- **14. Identify API keys by a non-secret id, not the secret in the URL.** The API-key management routes
  carry the full secret in the path — `POST /{id}/api-keys/{key}/regenerate` and
  `DELETE /{id}/api-keys/{key}` — so the key lands in nginx access logs, request traces, monitoring and
  browser history. The cheap leaks are already closed (the not-found error no longer echoes the key and
  the valuerecommender reindex logs no longer print the admin key), but the URL itself still carries the
  secret. Give each `CedarUserApiKey` a stable non-secret identifier and address keys by that id
  (`/api-keys/{keyId}`), keeping the secret out of the path. Breaking change: cedar-cli and the profile
  UI call these routes, so it needs a coordinated client update.

- **15. Deploy CEDAR from containers. The stack builds and runs locally; no environment deploys from
  it.** Development runs as native processes brought up by hand — JDK 17 pinned, infra services
  started, fifteen service jars and the frontends launched through `cedar-services.sh` — and a deploy
  to staging or production rebuilds all of it on the target. Both work, and neither is reproducible. A
  containerized path is not missing, though: it is built, complete, released on every version bump, and
  it has run the whole stack locally. What it needs is inputs that are pinned and verified, immutable
  tags published from CI, and a route into staging and production — not a design. Its role is settled
  below: containers become the deployment artifact, starting with the services and following with the
  data stores.

  `cedar-docker-build` holds 34 image definitions and two shell scripts that build every image and push
  it to `cedar-dockerhub.bmir.stanford.edu`. `cedar-docker-deploy` holds four compose files —
  infrastructure (7 services), microservices (17), frontend (6), admin (4) — plus a bundled CA and leaf
  certificates. `cedarcli docker` drives it: `one-time-setup` creates the network and the certificate
  volumes, then `start`/`stop` per stack. The address plan lives in
  `bin/templates/cedar-profile-docker-eval.sh`, which the Docker path requires and the native profile
  cannot substitute for.

  The images layer three deep. `cedar-java` is a Temurin 17 JRE on UBI9; `cedar-microservice` adds the
  Python venv, the `wait-for-*.py` readiness scripts and the entrypoint; each of the fifteen
  `cedar-server-*` images then contributes only a server name, three ports, a log volume and a call to
  `install_deps.sh`. Networking is static: `cedarnet` is a `192.168.17.0/24` bridge with a pinned
  address per container, and those addresses are passed back to the services as environment variables.
  TLS rides on two external volumes, `cedar_cert` for the nginx leaves and `cedar_ca` for the CA, which
  every Java entrypoint imports into the JVM truststore with `keytool`.

  **What has landed.** A jar built from a checkout can now reach an image: each server context and the
  admin tool carries a `local/` staging directory, `bin/stage-local-jar.sh` fills it from the
  checkout's `target/`, and `install_deps.sh` prefers what is staged over `mvn dependency:get`.
  Verified on Docker 29.2.1, arm64, by building `cedar-server-artifact` both ways — the staged build
  skips Maven and the jar inside the image matches the checkout's by hash. Both Docker repos now build
  on push and pull request: `cedar-docker-deploy` validates its compose stacks, and `cedar-docker-build`
  resolves every Nexus coordinate before building the Java chain sequentially and the rest as a matrix.
  The compose files declare `restart` policies throughout and healthchecks on all 28 running services,
  each probe checked against the image that runs it. `cedarcli docker` gained `validate`, `start`/`stop
  admin` and `--detach`. The profile reads the installation's env files rather than the templates, the
  admin stack's three undefined port variables are defined, and nginx serves `shared.<host>`.

  `cedar-infra-nginx` and `cedar-frontend-main` build again. Both installed nginx from nginx.org on
  `debian:bullseye-slim`, fetching the repository signing key from a keyserver by fingerprint; nginx
  rotated that key to `2FD21310B49F6B46`, apt began rejecting the repository as unsigned, and both
  failed in their second layer. They now start from `nginx:1.23.4`, the image upstream builds from the
  same sources and the base the five other frontend images already use — 135 lines down to 41, and 178
  down to 72. None of the four dynamic modules the old block installed were used: nothing in `config/`
  calls `load_module`, and `module-geo.inc.conf` uses the core `geo` directive rather than the geoip
  module. Verified on arm64: the image builds, and `nginx -t` inside it passes across all 49
  `server_name` entries with the real certificates mounted. `cedar-frontend-main` now reaches its
  tarball download and fails there instead, which is the frontend publishing item below.

  `cedar-java` and `cedar-microservice` are no longer declared as services. They were listed only to
  force build order, and both exited as soon as they started — `cedar-java` with no command at all,
  `cedar-microservice` with `Unable to access jarfile` — so every `up` left two dead containers. The
  `depends_on: cedar-microservice` entries that pinned them there went with them; they ordered against
  a container that exits, so they never conferred anything. Building the base images is
  `bin/build-all-images.sh`, which is what the release script and CI already use.

  **Startup ordering: not a compose problem.** Merging the infrastructure and microservice stacks into
  one project, so a `service_healthy` condition could span them, turned out to be the wrong fix. Each
  server already waits for precisely the backends it needs through its `pre-docker-entrypoint.sh`, and
  `wait-for-server.py` covers inter-service HTTP dependencies that a container health condition cannot
  express at all. Fourteen of the fifteen were already correct. The fifteenth was the actual defect:
  `cedar-server-schema` had no `scripts/` directory and waited for nothing, so it raced Mongo, Neo4j
  and Redis on every start. It now waits for all three, like its siblings. Compose 5.3 does support
  `include`, so a one-command combined bring-up remains available if it is ever wanted for its own
  sake, but it should not be adopted as an ordering mechanism.

  **It runs.** Brought up on 2026-08-07: seven infrastructure containers and all fifteen
  microservices healthy, and the whole REST estate green against them — 635 assertions, 0 failures.
  The runbook has the sequence. Three defects only a real bring-up could have found:

  - **Hibernate 6 was generating `tinytext` for every `@Lob String`.** Five columns on the two
    application-log entities. Hibernate 5 gave `longtext` regardless; Hibernate 6 sizes the column
    from its length, and the default 255 makes the MySQL dialect pick `tinytext`. Existing databases
    never showed it — their columns predate the migration and auto-update does not narrow a column —
    so the native stack and production keep working while every schema created from scratch since
    2026-07-26 silently rejects every log entry over 255 bytes. Fixed in
    `cedar-microservice-libraries` with an explicit `Length.LONG32`; no migration is needed anywhere.
  - **Twelve of fifteen servers could not verify a bearer token.** Only user, resource and monitor
    carried the `extra_hosts` entry mapping `auth.<host>` to the nginx container; everywhere else the
    name resolved to the container itself. Every server builds a Keycloak deployment in the shared
    bootstrap, so every server needs it. This alone took the REST run from 126 passed and 51 failed
    to 633 and 1.
  - **The container nginx never served the Swagger UI.** `/api` is aliased to a checkout on four API
    vhosts natively and was simply absent from the container configs — the same drift as the
    `shared.<host>` vhost.

  The OpenSearch pairing that had been the standing worry — a 2.19 client against the pinned 1.3.6
  server — works. The client sends a request, the older server answers, and a structured error comes
  back parsed. The pairing no longer exists in any case: the image moved to 2.19.1 on 2026-08-08.

  **The role is settled. The containerized path is how CEDAR is deployed, not an evaluation
  install.** Staging and production move to containerized services over native data stores, with the
  data stores following later. Development moves to containerized infrastructure under native
  servers. Both converge on a fully containerized stack.

  The two splits are opposites, deliberately. Development wants the edit-compile-run loop on the
  servers and reproducibility underneath them, so the infrastructure goes into containers and the
  fifteen JVMs stay native. Deployment wants the reverse: the services are the artifact that needs an
  immutable tag and a rollback, while the data carries migration risk that containerizing does not
  reduce. Each split containerizes the half that benefits first, and sequences the other half rather
  than abandoning it.

  **What a deploy becomes.** Today it builds on the target: connect over SSH, revert hot-patches,
  pull onto `main`, rebuild all Java in place, migrate by hand, restart. The target is a pull and a
  recreate, with no JDK, Maven or checkout on the box. Two things put it within reach. The
  `cedar-microservices` compose passes every infrastructure host through as a bare environment name,
  so the values come from whichever profile is sourced at `up` time, and `set-env-generic.sh` derives
  all of them from `CEDAR_NET_GATEWAY`. A per-environment Docker profile is therefore the docker-eval
  profile with the seven infrastructure host overrides removed and the gateway pointed at the Docker
  bridge instead of `127.0.0.1`. Server-to-server traffic stays on `cedarnet` at its pinned
  addresses; the `extra_hosts` entry for `auth.<host>`, the healthchecks and the restart policies are
  unchanged. Avoid `network_mode: host`. It would let the existing profile work untouched, at the
  cost of the address plan, the port mapping, and any chance of standing a second version beside the
  first.

  Migrations do not containerize and do not need to. They run against the data stores as they do now,
  as a human gate ordered before the new containers start. The automated part is the pull and the
  recreate. The downtime window shortens anyway, because an image pull completes while the old
  containers are still serving, where today the build must finish before Java stops.

  **Rollback is the real prize, and it rests on tag discipline.** `IMAGE_VERSION` is a mutable
  snapshot tag. Deploy that and neither "what is running" nor "roll back to what" has an answer.
  Every deployable tag has to be immutable: the release version for production, and a
  build-identified tag such as `<version>-<short-sha>`, or a digest, for staging. A floating
  `-SNAPSHOT` tag can stay as a convenience pointer, but nothing deploys it.

  **Containerizing the data stores is wanted too, and it is a separate project.** The performance
  question is not the obstacle. On Linux there is no CPU penalty and no memory penalty, and the
  compose stack already declares a named data volume for every store, so nothing writes through the
  container's writable layer, which is where a real I/O cost would have come from. What is left is
  bridge NAT on the network path, measurable on chatty service-to-database traffic and removable with
  host networking, and cache sizing: WiredTiger, the Neo4j heap and page cache, and the OpenSearch
  heap all size themselves from observed RAM and need explicit limits rather than autodetection. On
  this machine Docker Desktop's VM makes bind mounts slow, which named volumes already avoid. The
  estate can measure its own answer instead of borrowing benchmarks, by running `ops/e2e/rest`
  against containerized and native infrastructure and comparing.

  The obstacle is the pins. The Docker images are older than what runs live, and an older engine
  cannot open existing data files: Mongo and Neo4j stamp storage formats and do not support a
  downgrade. So containerizing a data store means moving its pin up to what is running, then
  migrating that store into a volume. Never both at once.

  Orchestration beyond compose stays out of scope. There is no Kubernetes anywhere in the estate,
  each environment is a single host, and `cedarnet`'s pinned addressing is the opposite of how
  Kubernetes wants services to find each other, so adopting it would be a redesign rather than a
  translation. Revisit on a second node, a hard zero-downtime requirement, or a hosting mandate.

  **What remains,** in the order it should be done. The first five are prerequisites for any
  automated deploy. The frontend and TLS items gate production specifically, and were deferrable only
  while the containerized path was evaluation-only.

  1. **Decide what the version lock actually locks, then move the pins to it.** This is not a
     catch-Docker-up item, which is how it read before it was measured.

     **Built on 2026-08-08.** The six versions are declared in
     `cedar-docker-build/bin/cedar-images-base.sh`; the six Dockerfiles take them as build arguments
     with no default, so a build not given one fails rather than choosing; `cedarcli docker build`
     supplies them and is now the only builder, the 32 `build:` stanzas having been removed from the
     four compose stacks; `renovate.json` watches the manifest through a custom manager keyed on the
     `# renovate:` comments; and `ops/check_version_pairing.py` asserts the client-server pairing in
     `cedar-docker-build` CI, where a bump is checked on the pull request that makes it. Verified by
     building all seven infrastructure images through the CLI and confirming each carries the
     declared version, and by checking that a bare `docker build` and a deliberately mismatched pair
     both fail. What remains is turning the bot on and extending it to the Java repositories, which
     the Renovate item in this section carries.

     The lock is stated in two places and neither records a version. CLAUDE.md and the runbook both
     say Mongo, MySQL, Neo4j, Redis, OpenSearch and Keycloak must not move; nothing in `os-mirror`,
     the install scripts or the production runbook says what they must not move *from*. So it cannot
     be honoured or checked, and the two deployment paths have drifted apart unnoticed. Measured
     against the running native services rather than what Homebrew has installed:

         server       native (live)   Docker pin
         Mongo        5.0.31          5.0.31     (moved 2026-08-08, was 5.0.14)
         MySQL        9.6.0           8.4.11     (moved 2026-08-08, was 8.0.32 on an abandoned base)
         Neo4j        5.26.0          5.26.0     (moved 2026-08-08, was 5.3.0)
         Redis        7.2.7           7.2.7      (moved 2026-08-08, was 6.2.7)
         OpenSearch   2.19.1          2.19.1     (moved 2026-08-08, was 1.3.6)
         Keycloak     22.0.5          22.0.4     (upstream is 26.7.1; see item 10 for what holds it)

     The direction is the surprise. The Docker images are the only place any of these versions is
     written down; the native stack is Homebrew, so `brew upgrade` moves four of the six with nobody
     deciding to. Despite the policy, native is the unpinned side and Docker is merely old.

     The lock is really a pairing constraint, and any single record has to capture both sides.
     `cedar-parent` pins `opensearch.version` at 2.19.2, so the servers ship the OpenSearch 2.19
     high-level REST client, alongside a legacy `org.opensearch.client:transport` at 1.3.20. Docker
     paired that client with a 1.3.6 server, which is not a supported combination; it worked, and the
     2026-08-07 bring-up retired the risk. The mismatch is now gone outright — the image moved to
     2.19.1 on 2026-08-08, so both paths pair the 2.19 client with a 2.19 server. The lesson survives
     it: a client version and a server version are locked to each other, and only the client half is
     written anywhere a check could read.

     **Give the images what `cedar-parent` gives the Java estate.** The rule there is settled and
     worth restating because this is the same rule: a child names the dependency, never the version.
     `cedar-parent` declares the version once and every consumer inherits it, which is why the Java
     half of this pairing is already written somewhere a check could read. The images have no
     equivalent, so each one restates its own number in a `FROM` tag or an `ENV`, and four of them
     were moved this week by hand-editing exactly those lines.

     **A version pin is a build input, not environment configuration.** This is the distinction that
     decides where the declaration goes, and it is easy to get wrong because both end up as
     `KEY=value` shell. `set-env-external.sh`, `set-env-internal.sh` and the Compose `.env` files are
     the per-environment layer: hosts, ports, passwords, `CEDAR_HOST`, the things that are *supposed*
     to differ between development, staging and production. A Mongo version is not one of those.
     Staging and production must run the same Mongo, and putting the version in the environment layer
     makes divergence expressible — which is how native and Docker came apart in the first place.
     `cedar-parent` does not keep `opensearch.version` in an env file. It is a POM property, checked
     in, versioned with the code, and identical everywhere it is consumed.

     The Docker equivalent is therefore a **build manifest in `cedar-docker-build`, versioned beside
     the Dockerfiles it feeds**, and that file already exists. `bin/cedar-images-base.sh` holds
     `IMAGE_VERSION` and the image list, `release-all-images.sh` and `stage-local-jar.sh` source it,
     and `DockerImages.manifest()` parses it. Six more entries — `MONGO_VERSION`, `NEO4J_VERSION`,
     `OPENSEARCH_VERSION`, `REDIS_VERSION`, `MYSQL_VERSION`, `KEYCLOAK_VERSION` — extend an existing
     idiom rather than introducing one. Shell syntax because that file is already shell, not because
     anything needs it in an environment.

     - **No `FROM` tag carries a number.** `ARG NEO4J_VERSION` ahead of
       `FROM neo4j:${NEO4J_VERSION}-community`, and the same for the `ENV MONGO_VERSION` and
       `ENV KEYCLOAK_VERSION` cases. Declare no default, so a build that was not given a version fails
       instead of quietly picking one.
     - **`cedarcli docker build` becomes the only builder,** forwarding each value as `--build-arg`.
       It nearly is already: it alone builds the CEDAR bases an image is built `FROM` first, which a
       bare `docker build` does not, and that is how a stale base silently gets used.
     - **Drop the `build:` stanzas from the Compose stacks.** Every infrastructure and microservice
       service carries `build:` next to `image:`, so a `docker compose up` with the image absent
       builds it — skipping base ordering, and once versions are `ARG`s with no default, either
       failing or, if defaults were added to placate it, producing a differently-built image under the
       same tag. That second builder is a liability whichever way this lands. Removing it also removes
       the only reason the declaration would have had to be readable by Compose.

     **Then let a bot hold it current, because the defect this item names is drift nobody noticed.**
     A record that a human updates has the same failure mode as the one it replaces. That the manifest
     is checked in beside the Dockerfiles is what makes a bot possible at all: it can raise a pull
     request against a file in the repository, and cannot against an environment. The Renovate item
     in this section carries that work and the decisions it needs; the config it describes is already
     committed here.

     The one thing no bot can do is Homebrew, which has no Renovate manager. The native side stays
     unwatched however this is built, which is a further argument for finishing containerization and
     making the Docker pins the only pins.

     **The pairing stays a check, not a record.** "The OpenSearch server must match the 2.19 client
     `cedar-parent` ships" is a project invariant, and no dependency bot can know it. Invariants belong
     in executable form: a CI step that reads the declaration and the POM property and fails when they
     part company. Put it where the static Docker CI already lives, next to `check_docker_env.py`,
     which is the pattern — ask the code what it declares rather than reading a descriptor by eye.
     Prose says only *why* a pairing is locked, in the runbook beside the lock.

     Then move the pins **up** to what is running. This is the direction that matters and the reason
     this item comes first: every later item adopts these pins, and an image older than the live
     server cannot open its data files. The corollary is a rule for everything downstream — never
     containerize and upgrade in the same step. Keycloak is patch-level and a non-event. MySQL is the
     one major-version decision left, and it belongs with the persistence-upgrade item near the top
     of this roadmap, which is parked on this one, since it defers to a lock that records nothing.

     Four are already done — Redis at 7.2.7, OpenSearch at 2.19.1, Mongo at 5.0.31 and Neo4j at
     5.26.0 — each moved to containerize that store below. Every one cost a hand-edited `FROM` or
     `ENV` line, which is precisely what this item exists to stop: those numbers now live in
     Dockerfiles because there is nowhere else to put them. Treat them as placeholders the declaration
     absorbs. Only MySQL and Keycloak are left to move, and all six values are currently known to be
     correct, so the declaration is cheaper to introduce now than it will be again.

     One thing to decide alongside it. The policy states one lock for two paths that cannot pin
     equally. Docker pins exactly. Homebrew mostly cannot: versioned formulae exist for some of the
     six and not others, and `brew pin` only prevents an upgrade rather than installing a chosen
     version. Containerized infrastructure takes Homebrew out of the development path and makes the
     Docker pins the only pins, which is the cleanest resolution and the reason the
     containerized-infrastructure step below follows this one closely.

  2. **Pin every image input, and check it mechanically.** The lock above answers one question: what
     must not move because something else depends on it working. A deployable image raises a second:
     what must not move because rebuilding a tag has to produce the same bytes. An immutable tag on a
     non-reproducible image is half a guarantee, and a rollback is only as good as the weaker half.

     Most of this is already right. Thirty-two of the thirty-four base images carry an exact tag, and
     the JVM is the most precisely pinned thing in the estate: `cedar-java` is
     `eclipse-temurin:17.0.8_7-jre-ubi9-minimal`, a JRE with no compiler, pinned to the build number.
     The pip packages in `cedar-microservice` are pinned too, at `wheel==0.40.0`, `pymongo==3.6.1` and
     `redis==2.10.6`. The habit exists. It stops in four specific places.

     - **The floating bases are done,** on 2026-08-09. `registry.access.redhat.com/ubi9` carried no
       tag at all, `node:20-bookworm` floated within the Node 20 line, and `ubuntu:focal` is a
       rolling alias; all three are now declared in the build manifest at what they already resolved
       to — 9.8, 20.20.2 and 20.04 — and taken as build arguments. nginx went the same way: seven
       images restated `1.23.4` in their own `FROM` lines, and now inherit one declaration. They are
       still tags rather than digests, which is what remains of this bullet.
     - **A pairing no check could have caught, found while doing it.** `cedar-admin-kibana` sat at
       `opensearch-dashboards:1.3.6` while the OpenSearch server moved to 2.19.1, and its compose
       entry points straight at that server. Dashboards has to track its server, so it now takes
       `OPENSEARCH_VERSION` itself rather than carrying a version of its own: the pair is structural
       and cannot drift. Worth generalising — where two images must agree, share the declaration
       rather than add a check.
     - **SNAPSHOT inside the build graph.** Fifteen server images build `FROM
       metadatacenter/cedar-microservice:2.9.2-SNAPSHOT`; that image and the admin tool build `FROM
       cedar-java:2.9.2-SNAPSHOT`; and `CEDAR_VERSION=2.9.2-SNAPSHOT` is baked in, so
       `install_deps.sh` fetches its jar by a coordinate that resolves to the newest timestamped
       build. The mutable tag is not only a deploy-time problem. Two builds of the same image can
       differ in both their base and their jar.
     - **Unpinned OS packages, two of them functional.** Both Java base images run a blanket
       `microdnf -y update` and then install `bsdtar unzip wget jq nc maven gcc python3 python3-devel
       python3-pip` at whatever version the repositories hold that day. `maven` is what
       `install_deps.sh` runs, and `python3` runs every `wait-for-*.py` readiness script, so neither
       is a convenience. The blanket update also defeats the base pin: the base is named exactly and
       then mutated. Maven is now pinned everywhere else — every Java repository carries a wrapper at
       3.9.14 and CI invokes `./mvnw` — so the build images are the one place it still floats.
     - **A third JVM, pinned only to its family.** `cedar-infra-keycloak` installs
       `java-17-openjdk-headless` unpinned, so Keycloak runs a different vendor and a looser pin than
       the servers do. The family is what matters for the crash on newer JDKs, and the image forces it
       with `alternatives --set java`, but the patch level floats. Worth recording that the estate has
       three Java pins — the build JDK, the CEDAR runtime JRE, and this one — and that a move to Java
       21 moves all three.

     The work is mostly a check rather than a rewrite, and it belongs with the static Docker CI
     alongside `check_docker_env.py`: fail on a `FROM` with no tag or a floating one, and fail on any
     SNAPSHOT reference in a release build, whether in a base, in `CEDAR_VERSION`, or in a frontend
     tarball. Then drop the blanket `microdnf -y update` from the images that get deployed and install
     what is needed at explicit versions.

     The Renovate item in this section covers most of this half. A bot pins bases by digest rather
     than by a tag that can be re-pushed, and the two floating bases named above are exactly what it
     flags, so they should be its first pull requests rather than a hand-edit that a check later
     rediscovers. What stays here is the part no bot can supply: the check that fails a build on an
     untagged or floating `FROM`,
     and on a SNAPSHOT in a release.

     The environment wants a floor rather than a pin. Each target needs a minimum Docker engine and
     Compose version, since the stacks use healthcheck conditions and `include` arrived in Compose
     5.3.

  3. **Verify every download, not just pin it.** Audited 2026-08-09 across all 34 images. The
     estate pins versions well and verifies downloads badly, and the two are not the same property:
     a pin says *which* bytes you meant to fetch, a signature or a digest says you got them. The
     step above closes the first half; this one closes the second, and a rollback is only as good as
     the weaker of the two. The first finding below does not wait its turn in this list — it is a
     defect in every image built today, deploy path or not.

     - **A plain-HTTP package repository with signature checking switched off.** `cedar-microservice`'s
       `install_deps.sh` adds `http://repo.mysql.com/...` — not HTTPS — points its `gpgkey` at another
       plain-HTTP URL, and then sets `gpgcheck=0`. So RPMs are installed into the base image of all
       fifteen servers with no verification at all, over a channel anyone on the path can rewrite.
       Fetching the key over HTTP would already be self-defeating; disabling the check makes the key
       moot. This is the one to fix first.

       It exists to compile `mysqlclient` for `MySQLdb`, which one readiness script imports. The
       Keycloak image does the same job with `python3-PyMySQL`, a pure-Python driver needing no
       repository and no compiler. Porting `wait-and-init-mysql.py` to PyMySQL deletes the repository,
       the `mysql-community-devel` install and the build toolchain behind it.

     - **A remote script piped straight into a shell,** in `cedar-frontend-main`:
       `curl -sL https://deb.nodesource.com/setup_16.x | bash -`. Whatever that URL returns runs as root
       at build time, unverified. It also installs **Node 16**, which left support in September 2023, in
       the image that builds the Template Designer.

     - **The Keycloak distribution is fetched by `ADD` from a URL** and never checked. `ADD <url>`
       cannot verify anything, and Keycloak publishes checksums beside the tarball. Fetching with
       `curl` and checking the digest is a three-line change.

     - **js-yaml is downloaded unverified — and is not used.** `cedar-infra-mongo` fetches
       `js-yaml.js` from a raw GitHub URL with a literal `# TODO some sort of download verification
       here` beside it, immediately below a `gosu` download that *is* GPG-verified, so the contrast is
       deliberate rather than accidental. It is loaded only by the entrypoint's `_parse_config`, which
       is reached only when mongod is invoked with `--config`; CEDAR's `run.sh` passes flags and never
       a config file, so the file is dead weight. Delete it rather than verify it.

     - **Two apt/gpg keyservers, which is the failure that already cost a day.** The Mongo image
       fetches keys from `keys.openpgp.org` and `keyserver.ubuntu.com` by fingerprint. That is how
       `cedar-infra-nginx` and `cedar-frontend-main` broke when nginx rotated its signing key: pinning a
       key the upstream rotates is a build that fails on somebody else's schedule.

     - **Python dependencies are pinned but ancient and unhashed.** `pymongo==3.6.1` (2018),
       `redis==2.10.6` (2016), `mysqlclient==2.1.1`, and an unpinned `pip install --upgrade pip` ahead
       of them. Pinning without hashes stops drift but not substitution. Low stakes, since these serve
       only the readiness scripts, but they are the easiest thing on this list to bring current.

     What is already right is worth stating, so the fix does not regress it: `gosu` is GPG-verified
     against a pinned fingerprint, the server jars come from Nexus over HTTPS through Maven, which
     checks the checksums it publishes, and every third-party base image now carries an exact tag.

  4. **Publish immutable image tags from CI.** Building is covered; releasing is not. Tagging and
     pushing to `cedar-dockerhub.bmir.stanford.edu` is `bin/release-all-images.sh`, run by hand: it
     does not build, it loops the image list and tags and pushes whatever is in the local daemon.
     Neither Docker workflow references a registry credential. This was a small chore while the
     containerized path was evaluation-only. An automated deploy makes it a prerequisite, because
     nothing can be deployed that CI has not published.

     Two tag streams, both immutable. A release publishes the release version. Every build of develop
     publishes a build-identified tag for staging, `<version>-<short-sha>` or a digest. The floating
     `-SNAPSHOT` tag may remain as a pointer for local convenience and is never deployed. That is
     what makes "which build is staging running" and "roll back to what" answerable.

     Fold `release-all-images.sh` into `cedarcli docker release` the way `build-all-images.sh` was
     already folded into `cedarcli docker build`, so one behaviour has one implementation. Settle the
     architecture while moving it: the script has no `--platform` and no buildx, so it publishes
     whichever architecture the operator's machine has, and local verification was arm64 while hosted
     runners are amd64. A deploy target's architecture is not something to decide by accident.

     A fourth defect, found 2026-08-09 by standing the whole estate up in Docker: the resource
     server was never given `CEDAR_TERMINOLOGY_SERVER_HOST` or `CEDAR_TERMINOLOGY_HTTP_PORT`, so the
     publish hook had no terminology server to ask and pinned every controlled-term constraint to
     `null` rather than failing. A published artifact then carries unpinned constraints, silently.
     Static checking could not see it, because the code did not declare those variables needed and a
     variable nothing declares is simply held back. That is now fixed at the declaration —
     `CedarConfigEnvironmentDescriptor` adds both to `SERVER_RESOURCE`, which makes the absence fatal
     at startup and visible to `check_docker_env.py`; verified by removing them again and watching
     the checker report `resource MISSING 2`. The lesson generalises: a check that asks the code what
     it needs is only as good as what the code bothers to declare, and the gap shows up as wrong
     behaviour rather than a missing variable.

  5. **Verify the containerized stack on a cadence.** Both Docker CIs verify statically.
     `cedar-docker-build` asks whether the Dockerfiles build: it resolves every Nexus coordinate,
     builds the Java chain sequentially and the rest as matrices, and discards the images.
     `cedar-docker-deploy` asks whether the configuration coheres: `docker compose config` parses all
     four stacks, `check_docker_env.py` asks the code what each server declares rather than reading
     the descriptor by eye, and a third step greps the resolved YAML for duplicate container
     addresses and host ports. Nothing starts a container.

     That is the gap, and the bring-up above measures it. Not one of the three defects it found was
     visible to any static check. The images built, compose parsed, every variable was defined and
     no address collided. Twelve of fifteen servers still could not verify a bearer token. That
     bring-up is also a single measurement dated 2026-08-07, decaying with every jar merged since,
     because nothing connects a jar merge to the Docker repos: `cedar-docker-build` triggers on push
     and pull request to its own develop and on `workflow_dispatch`, and there is no `schedule`,
     `repository_dispatch` or `workflow_run` anywhere in the estate.

     The work is to automate what was done by hand. Bring up infrastructure and microservices, wait
     on the healthchecks already declared on all 28 services, run `ops/e2e/rest`, tear down. Where it
     runs is the open question: seven infrastructure containers and fifteen Dropwizard JVMs alongside
     OpenSearch, Neo4j, Mongo, MySQL and Keycloak may not fit a 4-CPU, 16 GB hosted runner, and the
     alternatives are capping the server heaps, a self-hosted runner (there is none today), or a
     scheduled run on this machine. Cadence follows from cost. It is a schedule either way and not a
     per-push trigger, because the check catches drift rather than gating a commit. Under the settled
     role this stops being hygiene: it is what earns the confidence to deploy an image nobody built
     by hand.

  6. **Adopt containerized infrastructure for development.** Run the `cedar-infrastructure` compose
     stack in place of the Homebrew services, keeping the fifteen servers native. Nothing needs
     reconfiguring, since the hosts and ports already line up: `set-env-generic.sh` derives every
     infrastructure host from `CEDAR_NET_GATEWAY`, the native profile sets it to `127.0.0.1`, and the
     stack publishes every service to the host on those same variables. It remains the cheapest
     rehearsal for the data-store migrations at the end of this list.

     **Redis has moved,** on 2026-08-08, at the pin raised to 7.2.7 in the item above. The bring-up
     and its rollback are in the runbook. Three things it settled:

     - **The mechanism works untouched.** The fifteen native servers reconnected on their own, and
       the `ops/e2e` smoke passed end to end — login, DOID-constrained field, populate, instance
       save and re-edit, anonymous OpenView, teardown. Redis went from 54 to 2,124 commands
       processed across that run, so the traffic genuinely reached the container rather than a
       leftover native service.
     - **The swap costs about ten seconds of queue errors.** The worker's value-recommender reindex
       poll, the messaging server's pool validation and the submission server's NCBI queue consumer
       each log the outage and each recover on their own retry interval. No restart, no manual step.
       That the three retry loops are correct was an assumption before this; it is now measured.
     - **The Redis 6.2 config file is accepted unchanged by 7.2.7** — the deprecated `slave-*` and
       `*-ziplist-*` directives are still live aliases. One latent defect surfaced: `pidfile` pointed
       at `/var/run`, which the `redis` user the image runs as cannot write. Redis 6.2 failed
       silently and 7.0 logs it, so the pin move turned a hidden no-op into a spurious error on every
       start. Now pointed at the `/log` volume.

     What it did not test is migration. Redis moved with an empty keyspace, so no data crossed.

     **OpenSearch has moved too,** on the same day, 1.3.6 → 2.19.1, which is the largest version jump
     of the six and the first one to carry data. What it found:

     - **The 2.x image does not boot on this compose stack without a second switch.** From 2.12 the
       entrypoint runs the security demo installer and exits unless `OPENSEARCH_INITIAL_ADMIN_PASSWORD`
       is set. The stack already passes `plugins.security.disabled=true`, but that is a setting, and
       the installer runs before settings apply and reads `DISABLE_INSTALL_DEMO_CONFIG` instead. The
       image now carries that switch, so the fix travels with it rather than with whoever writes a
       compose file. Nothing static would have caught this: the image built and compose parsed.
     - **An in-place 1.x → 2.x upgrade works,** tested on a copy of the `opensearch_data` volume
       before anything real was touched. The 2.19.1 engine opened the indices the 1.3.6 container had
       written and served queries against them; the index settings show `created` at the 1.3.6 build
       and `upgraded` at 2.19.1. Worth knowing, but not the path taken.
     - **Regenerating from the source of truth is the better migration, and it is also a test.** The
       index is derived from Mongo and Neo4j, so `cedarat search-regenerateIndex` rebuilds it into
       the new store and proves the store works in the same step. It completed in under a second and
       moved the alias.
     - **`IndexUtils` already handles the plugin indices 2.x brings.** The 2.x image ships plugins
       1.3.6 did not, which create `.plugins-ml-config` and a `top_queries-*` index. The regenerate
       log shows it deleting the indices it owns and explicitly not touching those.

     One measurement that is about the estate rather than the container. The native index held 3,206
     documents dated 2025-03-27; the regenerated one holds 208, and both numbers are inflated by
     nested documents. Counting root documents instead gives two, which is exactly the two templates
     Neo4j holds. The old index had drifted from the graph for sixteen months. Read `docs.count` as a
     resource count and this looks like catastrophic loss; it is not.

     Still unset, and it applies to every store from here: the containers have no memory limit. The
     OpenSearch container took the image's default 1 GB heap, which is fine at this size, but nothing
     caps the container itself.

     **Mongo and Neo4j have moved too,** on the same day, at 5.0.31 and 5.26.0. These are the two
     that carry the source of truth, so each was a migration rather than a rebuild, and both came
     across exactly: 62 documents restored with matching collection counts, and a graph of 18 nodes
     and 29 relationships with the same folder and template counts. `mongodump`/`mongorestore` and
     `neo4j-admin database dump`/`load` are the mechanisms; neither needed anything clever, because
     the pins were moved to the running versions first. What they found:

     - **A native store and its container can both hold a port, and nothing warns you.** Native Mongo
       binds `127.0.0.1` while Docker binds the wildcard, so both listen, the more specific bind wins
       every connection, and `docker ps` reports the container healthy the whole time. For a few
       minutes the servers were talking to a native Mongo that a swap was supposed to have replaced.
       This is the one that would quietly invalidate a measurement, and it applies to every store.
     - **The Homebrew rollback path for Mongo is broken, independently of any of this.** Homebrew now
       refuses the `mongodb/brew` tap as untrusted, so `brew services start mongodb-community@5.0`
       cannot read the formula and writes a launch agent with an empty `ProgramArguments`. The
       runbook has the direct `mongod` invocation instead. Worth deciding whether to `brew trust` that
       tap, since until then the native fallback needs a command nobody has memorised.
     - **The Neo4j image hardcoded its APOC jar version,** `apoc-5.3.0-core.jar`, so the version bump
       broke the build until it was matched by glob. A pin that has to be restated in a second place
       is a pin that will drift; the record file should feed both.

     Restore only what the store owns. Mongo's container creates its own users in `admin` and native
     runs without auth, so restoring native's `admin` would remove them; Neo4j 5 keeps authentication
     in `system`, so loading `neo4j` alone leaves credentials intact.

     **The phase-one grouping was wrong, and the runbook now reflects the corrected one.** It read
     as the five data stores together with Keycloak left native, on the grounds that Keycloak holds
     user state. But Keycloak's state *is* a MySQL schema: `cedar-infra-keycloak` creates the
     database through `wait-and-init-mysql.py` and imports the realm on first start. A containerized
     MySQL under a native Keycloak finds an empty schema and the realm is gone. MySQL and Keycloak
     move together, or MySQL moves with a dump of the Keycloak, messaging and log schemas. nginx is
     unaffected and still stays native for the 80/443 collision.

     **MySQL and Keycloak moved together on 2026-08-08, which completes this item.** All six locked
     servers now run as containers under the native JVMs; only nginx is still native, for the 80/443
     collision. What that pair found:

     - **The MySQL pin could not move at all, and that was the real reason it never had.** The image
       was built `FROM mysql/mysql-server`, Oracle's own repository, which was abandoned in January
       2023 with 8.0.32 as its final tag. Moving the pin meant changing repository, to the Docker
       Official `mysql` image. Pinned at **8.4 LTS** rather than the 9.x innovation line the native
       install drifted onto, since an innovation release is superseded roughly quarterly and a locked
       version should not be.
     - **Two things in the compose stack were Oracle-image-specific and would not have been found
       without running it.** The healthcheck invoked `/healthcheck.sh`, which only Oracle's image
       ships, and the CEDAR entrypoint wrapper exec'd `/entrypoint.sh`, which the official image
       installs on PATH as `docker-entrypoint.sh` instead.
     - **Provisioning lives in the container images, so the hybrid has none of it.**
       `cedar-microservice` carries a `wait-and-init-mysql.py` that creates each server's database
       and user from `CEDAR_SERVER_NAME`, and the Keycloak image has its own. Native servers run
       neither, so `cedar_log` and `cedar_messaging` needed their databases, users and grants created
       by hand, at `@'%'` rather than the `@localhost` native uses.
     - **The Keycloak container cannot reach a native resource server.** Its event listener posts to
       `CEDAR_RESOURCE_SERVER_HOST`, a container address that does not exist when the servers are
       native, so the log fills with `NoRouteToHostException`. Login and the whole REST estate are
       unaffected; user lifecycle events are not propagated. It is a property of the hybrid rather
       than a defect, and it disappears once the servers are containers too.

     **And the port trap caught the person who documented it.** `mysqladmin shutdown` does not stop
     native MySQL — launchd restarts `mysqld_safe`, which restarts `mysqld`, in seconds. It rebinds
     `127.0.0.1:3306` while Docker holds only the wildcard, so every client silently went back to
     native. Two full REST runs passed that way, against a native MySQL, while the container sat idle
     and healthy. That is twice this shape of failure has appeared in one day, and it is the argument
     for making it a check rather than a paragraph: nothing in the estate asserts that the server
     answering a port is the one that is supposed to be. Worth adding to the containerized-stack
     verification item, which is the only place that could run it.

     Still open: whether the two-profile split grates enough to smooth. The stack starts under the
     docker-eval profile while the servers run under the native one, which is a second shell rather
     than a re-source. Across a single store it is a minor irritation and not obviously worth a
     third profile.

  7. **Decide which frontends there are, then settle their publishing.** Publishing is the visible
     half and probably not the first question. The estate builds six frontend images — the template
     editor at `cedar.<host>`, plus openview, monitoring, artifacts, bridging and content — and the
     working view is that only three are really needed: the template editor, openview and monitoring.
     If that holds, artifacts, bridging and content are candidates for removal rather than things to
     fix. This was deferrable while the containerized path was evaluation-only. It is now on the
     critical path, because production serves the frontends: either their images publish, or a
     production deploy keeps a native frontend build on the box and is a hybrid.

     `cedar-template-editor` is also badly named. It is not a component but very nearly the whole
     CEDAR frontend, which is why `cedar-frontend-main` is the structural outlier among the images:
     it installs Node and runs `gulp`, where the other five unpack a published tarball into nginx.

     The publishing state: all eighteen Java artifacts resolve at the current snapshot and none of
     the six frontend tarballs do. `npm-cedar` holds `2.9.1-SNAPSHOT` for five of them — all five
     stopped at the same release, which reads as publishing happening at release time rather than any
     one repository falling behind — and has never held `cedar-content-distribution` at any version,
     which release timing does not explain and which is itself evidence about whether that one is
     wanted. Either those repositories publish snapshots the way the Java repositories do, or image
     builds are release-time only and should say so. Until then the frontend half of the estate
     cannot be built from develop and no full bring-up is possible.

     Those build jobs carry `continue-on-error`, which does less than it sounds like: it stops a
     failure blocking dependent jobs, but the run's own conclusion still counts it, so
     `cedar-docker-build` stays red while any frontend fails. With the nginx images fixed these five
     are the only remaining failures, so settling publishing is also what turns that build green.
     One observation for whenever this is picked up. Running the native frontends against the
     containerized backend, everything up to populate passes — login, the REST round-trip, and a
     Disease field constrained to the DOID branch through live BioPortal. The populate-time term
     suggestion does not: the field renders as a plain input instead of a controlled-term picker.
     The backend is not at fault, since the template carries the constraint and the containerized
     terminology server answers the query. It is unresolved whether that is a real defect or an
     artefact of a natively-built frontend against a containerized backend, and the comparison that
     would settle it is the same browser smoke against the native backend.

  8. **Give the frontends a local-build path.** The other half of the Nexus decoupling. The six
     frontend images download a tarball with no local equivalent, so an edit-compile-run loop works
     for the backend and not the UI.

  9. **Decide the TLS story.** The leaves bundled in `cedar-assets` expired 2026-04-20.
     `copy_certificates` prefers `$CEDAR_HOME/CEDAR_CA`, whose 28 hosts run to 2028, so this bites a
     fresh clone rather than this machine. The question is whether the repo should carry certificates
     at all rather than issue them at setup, and a production deploy is what forces it: prod nginx
     serves real certificates that cannot come from a checked-in bundle.

  10. **Deploy containerized services to staging, then production.** The goal the items above serve.
     Services and nginx as containers, data stores native and untouched, on both existing hosts.

     Staging first, as the rehearsal. It is where the per-environment profile gets shaken out, and
     where the piece of work that is not yet anywhere on this roadmap gets done: turning the shell
     profiles into compose env files per environment, including how secrets reach the box. They live
     in `set-env-external.sh` on the host today. Containerizing does not make that worse, and it is
     the natural moment to decide whether it stays that way.

     Keep the mechanism dumb. `cedarcli deploy <env> <tag>` doing a pull and `docker compose up -d`
     over SSH, or a GitHub Actions job with a deploy key. Each environment is a single host, so
     nothing here justifies more machinery than that. Production additionally needs the
     frontend-publishing and TLS steps settled; staging can run with a native frontend build until
     then.

  11. **Containerize the data stores.** The end state, and a separate project from the
     staging-then-production step above — it must not gate it. Each store moves at the version
     already running, per the rule in the first step, and each
     needs its own migration into a volume rehearsed on a copy. The pin move and the
     containerization are the same piece of work per store, so this runs against the
     persistence-upgrade item near the top of this roadmap rather than after it.

     All six are done in development, as of 2026-08-08. What remains here is doing it where the data
     matters. Production still needs each migration rehearsed on a copy of its own data, at its own
     scale; a 42 MB development graph and a 3.2 MB Keycloak schema are not evidence about production
     ones. The MySQL move also carries a decision development could take lightly and production
     cannot: 2.4 GB of request and cypher logging was dropped rather than migrated, which is only
     available where the logs are disposable.

     Two configuration points apply to all of them. Give each container an explicit memory limit and
     size its cache explicitly, since WiredTiger, the Neo4j heap and page cache and the OpenSearch
     heap otherwise size themselves from the host's RAM and can collectively over-commit. And decide
     the network mode: default bridge NAT is measurable on service-to-database traffic, and host
     networking removes it.

  One estate difference is worth a decision rather than a fix. The Docker nginx now serves 24 virtual
  hosts against the native stack's 26; the two that remain are CEE's — `demo.cee` and `demo-dist.cee`.
  CEE itself is not a candidate for a container: it is a web component, built to a single JS file and
  embedded in a host page, with no process to run. `demo-dist.cee` is plain nginx over a built
  directory, the same shape as the six frontend images, so it is one more image if the site is meant to
  be hosted at all — the runbook classes the demos as non-essential and not started by default, and its
  native server block still names `cedar-cee-demo`, the checkout's old directory name, so it serves a
  path that does not exist. `demo.cee` proxies a live `ng serve` and belongs to development only.

  **Only one of the two hybrids is safe, and the other has a latency cliff.** The runbook's supported
  mixture — container nginx stopped, native nginx up, native frontends against containerized services
  — works because the native nginx proxies to `127.0.0.1:900x` and does not care whether a port
  belongs to a JVM or a container. The inverse, leaving `infra-nginx` up in front of native
  frontends, is not equivalent: its `cedar-frontend` upstream is `host.docker.internal:4200`, so every
  request leaves the VM to reach the host. Measured over the Template Designer's 175 script files, six
  concurrent, four rounds: direct to gulp, 17–50 ms in total with the worst single request at 2–19 ms;
  through the container nginx, 48–76 ms on three rounds and **60,104 ms on the fourth, with one
  request stalling 60,059 ms** — nginx's default `proxy_read_timeout`. Median stayed at 2 ms either
  way, which is why this hid: nothing read as slow, and the entire cost sat in a tail that fired
  perhaps one request in a thousand. One in a thousand is frequent enough when a page load asks for
  two hundred of them.

  A tail that long is fatal rather than slow, because of what the page asks for: a dashboard load
  fetches 258 requests, 200 of them scripts, and RequireJS is left at its default seven-second
  `waitSeconds`. One stalled module therefore aborts the bootstrap — `Load timeout for modules:
  cedar/template-editor/service/rich-text-config.service` — and the dashboard renders blank with no
  "New" button; a *blocking* script stalling instead times out the navigation. Neither is CEE's doing
  and neither came from the Angular 14 → 22 march: the bundle the frontends serve today is smaller
  than the one they served earlier the same day. It also is not a test-only fault — a person browsing
  `cedar.metadatacenter.orgx` in that mode gets the same blank dashboard.

  **Confirmed by removing the cause.** `infra-nginx` was stopped and the native nginx started in its
  place on 2026-08-09, leaving the other twenty-one containers up. The same burst over the same URL
  then had a worst single request of **29 ms** against the 60,059 ms before it, and the two whole-stack
  suites went green together: 635 REST checks, and the browser smoke passing three consecutive runs
  where it had been failing almost every run, at a different step each time. Each of those runs also
  reached its own teardown, so it left nothing behind — a partial teardown had been the other visible
  symptom. Cause removed, symptom gone, which is the only test that settles a diagnosis this indirect.

  So this is a reason to finish the frontend images rather than a bug to chase: once the frontends are
  containers, nothing crosses `host.docker.internal` and the cliff is gone. Until then the documented
  swap is the mode to be in, and raising `waitSeconds` would only widen the window that a 60-second
  stall still closes.

  Two things this hunt did not fix, and both are the Template Designer's. RequireJS still sits at its
  default `waitSeconds`, and a dashboard load still refetches two hundred scripts whose `?v=` argument
  is stable per build and could therefore be cached. Neither was a problem before a VM hop existed and
  neither is one now, but together they are why a transport hiccup escalates into a blank page rather
  than a slow one, so they are worth knowing about before the next thing perturbs request latency.

- **16. Adopt Renovate, so a version that falls behind says so.** Every pin in this estate is
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

- **17. Build the MCP servers with everything else.** Four of them live under `$CEDAR_HOME/mcp`:
  `cedar-artifact-mcp`, `cedar-artifact-rest-mcp` and `cedar-cee-mcp` are Maven projects,
  `bioportal-term-mcp` is Python. Each is its own repository, none is part of `cedarcli build java`,
  none has a GitHub Actions workflow, and neither [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) nor
  [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) mentions them. They are built by hand, which means they
  are built when somebody remembers.

  The three Maven servers are currently unbuildable on this machine, and nothing said so. All three
  pin `cedar-artifact-library:2.8.4-SNAPSHOT`; `~/.m2/settings.xml` reaches `oss.sonatype.org` for
  releases, that repository answers `402 Payment Required`, and the hard failure aborts resolution
  before the BMIR Nexus is tried — where the artifact is present and answers 200. Neither `-U` nor
  clearing the `.lastUpdated` markers helps, because the abort happens on the way to the repository
  that has it.

  A stale MCP jar is worse than a stale service jar. **An MCP's tool descriptions are the only
  documentation the calling LLM ever sees, and they ship inside the jar.** `cedar-artifact-rest-mcp`
  was running a 30 July jar while its descriptions were rewritten on 9 August, so a client kept
  reading a surface that no longer described the tools — and a description that disagrees with
  behaviour is worse than no description, since it is followed rather than ignored.

  Deliver:

  - Make the dependency resolvable: pin a version the BMIR Nexus holds, or order the repositories so
    a 402 from one that never holds CEDAR artifacts cannot end the search.
  - Build the three Maven servers with the rest, after `cedar-artifact-library`, so a library change
    that breaks a tool signature fails in the build rather than at a client's first call.
  - Give each repository the workflow every other Java repository already has.
  - Make a running server state which build it is and which CEDAR server it talks to. `ping` reports
    the version and deliberately contacts nothing, so the target is invisible — and it is fixed when
    the process spawns, so editing a client's configuration changes nothing until the server
    restarts. That combination let a server keep writing to whatever it was started against after its
    configuration had been pointed elsewhere, which is a hazard when one of the two is production.
  - Decide whether they join the release or stay outside it, as CEE and the TypeScript model library
    do.

- **18. Manage the transitive artifacts that still split on the test classpath.** Thirty-four
  artifacts that resolved to several versions across the estate are now managed in `cedar-parent`,
  which also repaired six integration classes that had been dying in `oneTimeSetUp` on
  `NoClassDefFound org/eclipse/jetty/http/UriCompliance`, the Neo4j harness's Jetty 9.4.49 beating
  the Jetty 11 the code compiles against. That pass measured the runtime classpath. Measuring the
  test classpath afterwards, on 2026-08-12, found eleven more: `checker-qual` (3.31.0 / 3.53.0), the
  three `apache-mime4j` artifacts (0.8.3 / 0.8.9), `resteasy-jaxb-provider` and
  `resteasy-multipart-provider` (6.0.0.Final / 6.2.4.Final), `jaxb-core` and `txw2` (4.0.2 / 4.0.9),
  `jackson-dataformat-cbor` (2.14.2 / 2.18.2), `jakarta.transaction-api` (2.0.0 / 2.0.1) and
  `commons-collections4` (4.4 / 4.5.0).

  Give them the same treatment, one at a time rather than as a block. Check each against whatever
  wants the older version before pinning it, since the Jetty case cuts both ways: a stale transitive
  can be what breaks a suite, and forcing a newer one on a consumer built against the old can break a
  suite that passes today. The whole estate's suites, 7,814 tests, are the check.

- **19. Upgrade Mockito so byte-buddy converges, and then manage it too.** `byte-buddy` is the one
  artifact deliberately left unmanaged, and the pom says why: `dropwizard-hibernate` 4.0.17 brings
  1.18.4 at compile scope for Hibernate's bytecode enhancer, and Mockito 5.7.0 brings 1.14.9 at test
  scope. That is a scope boundary rather than drift, and forcing either version onto the other side
  is wrong — Hibernate's version under Mockito leaves stubbing silently inert, so mocks return
  defaults and the failures read as logic bugs in whatever was being tested.

  A Mockito built against a 1.18.x byte-buddy closes the gap and lets the artifact join the managed
  set. Move `byte-buddy-agent` with it, since Mockito needs the two to match, and confirm the mock
  matrix still passes rather than trusting a green compile.

- **20. Let the rebuilt search index become searchable before `regenerate-search-index` swaps the
  alias onto it.** `RegenerateSearchIndexTask` orders its steps correctly: it indexes every batch,
  including the final partial one, then points the `cedar-search` alias at the new index, then deletes
  the old one. What it does not do is wait for what it just wrote to become visible. `addBatch` issues
  its bulk request with no refresh policy, so the documents are written but stay invisible to queries
  until OpenSearch's next scheduled refresh, a second by default. The alias moves immediately after
  the last bulk write, and the old index is deleted in the same breath — locally, 35 ms later.

  For about that second, a search through the alias reaches the new index and finds less than is
  there. The window is set by the refresh interval rather than by how much was reindexed, so it stays
  around a second whatever the corpus size, and a caller cannot tell a short answer from a complete
  one. Deleting the old index straight after the swap also gives up the one copy that could have
  answered during the gap, and the only thing to fall back to if the new index turns out wrong.

  Refresh the new index and confirm its document count before swapping the alias, and delete the old
  index once the swap is known good rather than as part of the same step. An alias swap is atomic, so
  the sequence costs nothing beyond the wait. Worth doing before the command is run against
  production, where the fallback matters more than the second does.

## Testing

Coverage and test-infrastructure work. The active REST integration suites live in
`ops/e2e/rest/suites/`; the JUnit matrices and boot-smoke live in the per-server modules.

- **21. Decide whether the build runs the tests, and give the answer a command-line option. Stop the
  output loop busy-polling.** The Java build skips its tests again: every Java repo is built with
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
  `./mvnw clean install -DskipTests` and `DeployShellTaskFactory` hardcodes `./mvnw deploy -DskipTests`, so
  release and deploy builds never run tests whatever the flag says. Extend them deliberately or state
  it; do not leave `--tests` looking as though it covers them.

  Worth doing in the same pass: `CEDAR_DEV_BUILD_FRONTENDS` is the precedent this item invokes, and it
  has the same shape. Promoting it to `--frontends` / `--no-frontends` costs little extra and gives the
  CLI one convention rather than two — the skipped tasks are currently named
  `"… skipped because of CEDAR_DEV_BUILD_FRONTENDS"`, so their titles have to move with it either way.

  **The output loop.** `ShellTaskExecutor.execute_shell_command` sets `O_NONBLOCK` on the subprocess
  pipe and spins on `while proc.poll() is None`, which is the 100% CPU, while Rich redraws under a
  `Live` at ten frames a second, which is what makes progress hard to distinguish from a hang.
  `worker/Worker.py` carries the same three lines for the commands that run outside a plan, so fix both
  or the CPU burn survives in `git`, `dev` and `start`. The cheap fix is a net deletion: drop the `fcntl` call and iterate the pipe, then `proc.wait()` — stderr
  is already merged into stdout, so there is one stream and no deadlock to avoid. `select` with a
  timeout is the alternative if a periodic tick during silence is wanted, and a reader thread only if
  the tick should report how long the silence has lasted. Separately, every line calls both
  `job_progress.print` and `job_progress.update`; teeing full output to a per-repo log file and
  echoing only under `--verbose` would suit a build whose logs already must not be piped through
  `head` or `grep`.

  One more thing belongs in the acceptance criterion. On failure with `fail_on_error` set,
  `PlanExecutor` exits 1 correctly. With it unset the error is disregarded and the run still prints
  "Execution succeeded!" and exits 0. A build that continued past a failure must record it, say so in
  the closing panel, and exit non-zero.

- **22. Deepen the core-workflow tests instead of growing the headline count.** The JUnit matrices and the
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

- **23. Add degradation tests.** Nothing asserts how a service behaves when a dependency it needs is
  unavailable. The cost of that gap is known: reading any folder whose creator could not be resolved
  returned 500 for as long as the defect existed, because `UserSummaryCache` let Guava's
  "loader returned null" signal escape instead of degrading to the no-display-name path the callers
  already handled. A cheap form is one test per server that points a dependency at a dead port and
  asserts the API degrades rather than 500s. Bear in mind that queue writes are already best-effort
  by design (`AppLoggerQueueService`, the worker and NCBI queues), so those are the pattern to match.

- **24. Retry the ontology-list load in the term picker (frontend, `cedar-template-editor`).** This is a
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

## Production Artifact Patch

Defects that live in stored artifacts rather than in code. Each began as something a producer wrote,
and each producer is tracked with its own repository; what is collected here is the other half — what
production already holds, and what has to be rewritten before the model can be held to its own rules.
The shared corpus is the sample every count below is drawn from, and it is a sample: preprod captures
of real templates and instances, kept beside their corrected copies precisely so the defect stays
legible. Every item therefore starts the same way, with a query over stored artifacts that says how
far the sample generalizes. One defect is not listed here but belongs to the same body of work: the
stored constraints recording a term count of zero, whose patch waits on what that zero should have
been — item 7. Property IRIs the editors minted are deliberately absent: an identifier already
assigned is left alone, whoever assigned it, so there is nothing to rewrite — see
[BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), "Identifiers: what a client sends, and what the server fills".

Two of these are now blocking rather than latent. Both model libraries refuse an empty `@id` and an
empty `pav:derivedFrom` on read, so a stored artifact carrying either can no longer be read by the
library at all — it throws where it used to drop the value silently. That is the intended rule, and
it makes the patch a precondition for anything that reads those artifacts through the libraries
rather than an improvement to schedule at leisure.

- **25. Temporal fields that declare no `temporalType`.** Production holds temporal fields that
  declare none, and a field in that state cannot be filled in at all: it sits in the template as a
  slot nobody can complete. No reader refuses it, so nothing surfaces the field until a user reaches
  it. The patch is finding the stored fields and giving each one a `temporalType` that agrees with
  whatever values it already holds.

  The companion question belongs here rather than beside CEE, because it is the same decision about
  the same stored data: whether `InstanceValidator` should require `@type` on every temporal value.
  Requiring it makes an instance written against one of these fields invalid, which is the honest
  answer only once the fields carry a `temporalType` — so the two are ordered, patch first. Settling
  it the other way, and leaving `@type` optional, means a temporal value can be stored with no
  statement of what kind of temporal value it is, which every reader then has to guess at.

- **26. `pav:derivedFrom` written as an empty string.** The key names the artifact a copy was made
  from, and it is optional: an artifact derived from nothing leaves it out. **289** schema artifacts in
  the shared corpus wrote `""` instead, against 41 naming a real IRI — 146 of them in one template,
  133 in another, ten across two more. The corpus is corrected and both libraries now refuse the empty
  string on read, in JSON and in YAML. What remains is the query over stored templates, elements and
  fields, and a rewrite that drops the key wherever it is empty.

- **27. `"@id": ""` on element occurrences in stored instances.** The same disease on the identifier
  itself. Half the element occurrences in the corpus carried it — 59 nodes across four instances,
  since corrected to `null` — and both libraries now refuse it. Whether production holds them, and how
  many, is unmeasured; the rewrite is to `null`, which is what an occurrence with no assigned identity
  says. The rule this serves, and who is allowed to assign an identifier at all, is in
  [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), "Identifiers: what a client sends, and what the server fills".

- **28. `_ui.pages`, a key the meta-schema forbids.** A template's `_ui` may carry `order`,
  `propertyLabels`, `propertyDescriptions`, `header` and `footer`, and nothing else:
  `additionalProperties` is `false`. **120** template documents in the corpus carry `pages` there, 34
  of them preprod captures, and `CedarValidator` rejects every one of them for it. Both model
  libraries drop the key on write, so a template that has been through either validates while the
  stored original does not, and the two disagree about what the template is. Decide whether `pages`
  becomes part of the model or is dropped from stored templates, then patch accordingly — the count
  says this is not a stray.

- **29. Attribute-value fields naming an attribute that has no name.** Two corpus instances,
  `cee-suite/071` and `cee-suite/072`, carry an attribute-value field whose list of names is `[""]` —
  an attribute named by the empty string, with no sibling value and no `@context` term. The server
  skips it when naming attributes, since a property IRI for it would name a property nothing can be
  said about, so these stay unnamed until the data is corrected. How many production instances hold
  one, and what wrote it, are the query and the producer question every item here starts with.

- **30. `@context` terms for attributes nobody can name any more.** The server now assigns a property
  IRI to every attribute an instance names, and leaves an assigned one alone — but nothing removes a
  term when the attribute it named is renamed or deleted, so a stored context accumulates one orphan
  per attribute a user ever changed their mind about. Going forward, pruning is decided and waits on
  where the template can be had; what is already stored is this item. The query needs the template
  too, and for the same reason: a term whose name is no key in the instance may be an orphan, or it may
  be a child the instance does not fill, which `instances/005` carries two of.

- **31. Ontology constraints that carry no canonical `iri`, and `sourceUri` where it is no longer
  authored.** The versioned value-constraint shape names a source with `sourceSystem` and
  `sourceAcronym` and identifies it with a canonical `iri`; the older shape carried `sourceUri` and
  neither of the other two. Stored constraints are readable either way — a tolerant reader defaults an
  absent `sourceSystem` to BioPortal and derives the IRI from the acronym — so this is
  self-description rather than a functional gap, which is why it sits here and not in Features. The
  rewrite walks each stored template's controlled-term constraints, looks up the acronym's canonical
  IRI from the terminology catalog (`ontologyIri(acronym)`, the only place that mapping lives), writes
  it where derivable and leaves the rest to defaults. Dry-run with zero mutations first, reporting
  coverage and the acronyms it cannot derive.

  The code half — making the model's `uri` optional and stopping the editor writing it — is on
  [VERSIONING-ROADMAP.md](./VERSIONING-ROADMAP.md), item 6. Patch the stored artifacts before
  requiring the new shape of anything that reads them.

