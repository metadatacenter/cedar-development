# CEDAR Backend — Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).
Frontend work for the embeddable editor is tracked separately in
[CEE-ROADMAP.md](./CEE-ROADMAP.md). Parity between the Java and TypeScript
model libraries — where their JSON and YAML serializations diverge — is in
[MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md).

## Next

### Features

- **1. Decide whether create should require `@id: null` rather than accept an omitted `@id`.** The
  meta-schema types `@id` as `{"type": ["string", "null"]}` and marks it required — deliberately: a
  stored artifact carries its IRI, one not yet created carries `@id: null`, and both are the model's
  idea of a valid artifact. Validation honours this exactly: the key must be present, its value may be
  null. So the body a client is about to POST validates clean as long as it carries `@id: null`, and
  the `validate` then `create` workflow composes with no placeholder IRI at all. This corrects an
  earlier reading of this item, which had validation as too strict; it is faithful to the model.

  The looser of the two is create. It accepts an omitted `@id` as well as a null one — both create a
  201 — and rejects only a real client-supplied IRI. So the one body shape that creates but does not
  validate is the one that leaves `@id` out entirely, which is the natural thing a client does. The
  mismatch is create's leniency, not validation's strictness: if create required the `@id` key the way
  the meta-schema and validation do, every createable body would also validate.

  The question is which way to close it, and it is small. Either make create reject a body that omits
  `@id`, pointing the client at `@id: null` — aligning the two contracts at the cost of refusing a body
  that works today; or leave create lenient and document `@id: null` as the canonical pre-create shape,
  so a client never omits the key and never meets validation's "missing required property `@id`". The
  three shapes are pinned in `ops/e2e/rest/suites/validation.mjs`: `@id: null` validates and creates,
  an omitted `@id` creates but does not validate, and a real IRI validates but is refused by create.

  Checked over JSON only. The validate, create and update paths also negotiate YAML, so the same @id
  behaviour needs confirming there: a body that validates as YAML should create as YAML, and the
  null / omitted / IRI distinction should hold across both media types rather than only over JSON.

  Instance validation is also not purely syntactic: it resolves `schema:isBasedOn` and answers 400 when
  the template cannot be found, so an instance cannot be validated against a template that does not yet
  exist. Reasonable, and worth stating.

- **2. Decide on concurrency control.** There is no `ETag`, `If-Match` or `@Version` anywhere in the
  stack, so two users editing one template is a silent lost update: the second save wins and the
  first user is never told. This is a design item rather than a coverage item, since no test can be
  written until the API offers the conditional-request machinery.

- **3. A published artifact can be deleted, contradicting the docs.** The docs say a published
  artifact is permanent, but `DELETE` on one succeeds. The guard in
  `AbstractResourceServerResource.executeArtifactDelete` was briefly re-enabled and then **reverted by
  deliberate decision**: blocking deletion strands published artifacts and the folders holding them with
  no ordinary cleanup path, and commit `3f26ee7` (2021, "Allow users to delete published resources") had
  disabled the guard on purpose. So deletability stays for now; the discrepancy with the documentation
  is the open question. Deciding it means choosing between amending the docs (published is deletable) or
  re-enabling the guard together with a supported cleanup path (e.g. an admin-only delete, or cascading
  through folder deletion). Immutability of published content is a separate guarantee and is
  unaffected either way — that one is enforced.

- **4. Clean up the DataCite DOI minting workflow.** Treat minting as one explicit, auditable lifecycle
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

- **5. Settle the sharing and permission model, then write it down.** This is the umbrella item: the
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

- **7. Saving a template fails validation when GAZ is constrained as a whole ontology.** Adding the GAZ
  (Gazetteer) ontology to a field as an *entire-ontology* controlled-term value makes the template
  fail validation on save (`POST /templates` → 400); a branch or specific-class constraint on the
  same ontology does not. Reproduced in the editor, root cause confirmed from the artifact server's
  validation report — it is **not** the scale/timeout issue first assumed. The determining error is:

  ```
  /properties/<field>/_valueConstraints/ontologies/0/numTerms: must have a minimum value of 1
  ```

  The chain: GAZ's term count comes back `n/a` (the terminology server reports no count for it — the
  picker even shows "Number Terms: n/a" and "Tree browsing not supported for this ontology"), the
  editor then serializes the ontology constraint with `numTerms: 0`, and the meta-schema requires
  `_valueConstraints.ontologies[].numTerms` to be an integer with `minimum: 1`
  (`literal-field-meta-schema.json`, `iri-field-meta-schema.json`). `0 < 1` fails, and the
  JSON-Schema `oneOf` over field kinds turns that one failure into a cascade of unrelated-looking
  errors in the report. Pick a fix: (a) have the terminology layer return a real `numTerms` for GAZ
  (an `iri-field` `numTerms` already allows `minimum: 0` elsewhere, so the count path is the anomaly);
  (b) stop the editor emitting `numTerms: 0` when the count is unknown; or (c) relax the `ontologies`
  `numTerms` minimum to `0` so a whole-ontology constraint with an unknown count validates. Also worth
  a look: the interactive `POST /command/validate` returned 200 while the create 400'd, so the
  editor's live check does not exercise the same constraint.

- **8. Decide whether `maxItems: 0` should mean unlimited, or the key should simply be absent.** The
  Template Designer emits `maxItems: 0` for an unbounded multi-instance field. Its cardinality
  selector labels the zero "unlimited" (`cardinality-selector.directive.js`, `zeros = {'min': 'none',
  'max': 'unlimited'}`), `defaultMinMax` in `cedar-template-element.directive.js` sets it on every new
  multi-instance element, and the runtime directives guard with `!maxItems || model.length < maxItems`,
  so zero is falsy and imposes no ceiling.

  Omitting the key would say the same thing better. An absent `maxItems` already means unbounded to
  every consumer, and it is what JSON Schema means: there, `maxItems: 0` constrains an array to be
  *empty*, the exact opposite of unlimited. So the current encoding does not merely duplicate the
  default, it inverts the standard reading, and any tool validating a CEDAR template as ordinary JSON
  Schema draws the wrong conclusion from it.

  `cedar-artifact-library` rejected `maxItems < 1` outright until `ValidationHelper.UNBOUNDED_MAX_ITEMS`
  was introduced. It now accepts zero and skips the `minItems <= maxItems` check when the maximum is
  unbounded. That is tolerance of the convention, not endorsement of it. Whichever way this is decided,
  the library has to keep reading zero: templates already stored carry it.

  Related, and worth settling at the same time: single-instance fields can carry stray cardinality keys.
  In one working template `publication_doi` is `"type": "object"` yet has `minItems: 0, maxItems: 0`. The
  reader drops both, taking cardinality only from a `{type: array, items: {…}}` envelope. Establish
  whether the frontend writes those or whether they are residue from a field that was once
  multi-instance.

  This is the same shape as the GAZ `numTerms: 0` item (7) — the editor using zero as a sentinel where
  the schema gives zero a different meaning — so the two are worth deciding together. The frontend change
  belongs to [TEMPLATE-DESIGNER-ROADMAP.md](./TEMPLATE-DESIGNER-ROADMAP.md); it is tracked here because
  the decision binds the meta-schema and both model libraries as well.

### Infrastructure

- **9. Upgrade the persistence and infrastructure servers.** These versions are currently pinned (see the
  runbook's version locks) while the client libraries have moved on. Order them by risk, lowest first:
  Redis, then MySQL, then OpenSearch, then MongoDB, then Neo4j. Take **Keycloak separately and last**:
  it runs a forward-only Liquibase schema migration on the existing user store, the custom themes will
  need re-porting, the `keycloak-admin-client-jakarta` coordinate it uses was discontinued after
  21.1.2, and `cedar-keycloak-event-listener` is compiled against the current SPI. Rehearse each on a
  copy of production data and gate on the end-to-end smoke. Locked for now, so parked at the end.

- **10. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
  and the build enforces it. 21 is the next LTS and the natural target, but the lock exists for a
  reason: newer JDKs (23/25) crash Keycloak (`getSubject … security manager`) and OpenSearch will not
  start under them. So this is not a blind bump — verify Keycloak and OpenSearch run on 21 first, then
  move the toolchain, the profile pins, and the build enforcement together, gated on the end-to-end
  smoke. Low urgency while 17 is supported; parked at the end of the list for that reason.

- **11. Point the token-verification client at a truststore in production.** Token-signature verification
  fetches the realm's signing keys over HTTPS; on the local stack that client trusts the self-signed
  `.orgx` certificate (`disableTrustManager` in `KeycloakDeploymentProvider`, matching the admin
  client). A real deployment should instead trust a truststore holding the realm CA. Small, and only
  matters outside local dev.

- **12. Stop using the hardcoded BioPortal key, and rotate it.** `Constants.BP_PUBLIC_API_KEY` in
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

- **13. Identify API keys by a non-secret id, not the secret in the URL.** The API-key management routes
  carry the full secret in the path — `POST /{id}/api-keys/{key}/regenerate` and
  `DELETE /{id}/api-keys/{key}` — so the key lands in nginx access logs, request traces, monitoring and
  browser history. The cheap leaks are already closed (the not-found error no longer echoes the key and
  the valuerecommender reindex logs no longer print the admin key), but the URL itself still carries the
  secret. Give each `CedarUserApiKey` a stable non-secret identifier and address keys by that id
  (`/api-keys/{keyId}`), keeping the secret out of the path. Breaking change: cedar-cli and the profile
  UI call these routes, so it needs a coordinated client update.

- **14. Modernize the Docker deployment that already exists, and decide what it is for.** The local stack
  runs as native processes brought up by hand — JDK 17 pinned, infra services started, fifteen service
  jars and the frontends launched through `cedar-services.sh`. It works but it is assembled, not
  reproducible, and it does not resemble how staging or production would run. A containerized path is
  not missing, though: it is built, complete, and released on every version bump. What it needs is
  modernization and a decision about its role, not a design.

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

  **What remains.**

  1. **Bring the stack up.** Everything so far is static verification: no CEDAR container has been run.
     The estate publishes the same host ports as the native stack — 3306, 27017, 6379, 9200, 7474/7687,
     8080/8443, 80/443 and 9001–9015 with their admin and stop ports — so the two cannot run side by
     side, and a bring-up means stopping the native stack or remapping. Nothing else on this list is
     well-ordered until this has been tried once.
  2. **Settle frontend publishing.** All eighteen Java artifacts resolve at the current snapshot; none
     of the six frontend npm tarballs do. `npm-cedar` holds `2.9.1-SNAPSHOT` for five of them and has
     never held `cedar-content-distribution` at any version. Either the frontend repositories publish
     snapshots the way the Java repositories do, or image builds are release-time only and should say
     so. Until then the frontend half of the estate cannot be built from develop and no full bring-up
     is possible.

     Those build jobs carry `continue-on-error`, which does less than it sounds like: it stops a
     failure blocking dependent jobs, but the run's own conclusion still counts it, so
     `cedar-docker-build` stays red while any frontend fails. With the nginx images fixed these five
     are the only remaining failures, so settling publishing is also what turns that build green.
  3. **Give the frontends a local-build path.** The other half of the Nexus decoupling. The six
     frontend images download a tarball with no local equivalent, so an edit-compile-run loop works for
     the backend and not the UI.
  4. **Publish images from CI.** Building is covered; releasing is not. Tagging and pushing to
     `cedar-dockerhub.bmir.stanford.edu` is still `bin/release-all-images.sh`, run by hand. The open
     question is whether a merge to develop publishes snapshot tags or publishing stays explicit.
  5. **Decide what the version lock actually locks, then hold both paths to it.** This is not a
     catch-Docker-up item, which is how it read before it was measured.

     The lock is stated in two places and neither records a version. CLAUDE.md and the runbook both
     say Mongo, MySQL, Neo4j, Redis, OpenSearch and Keycloak must not move; nothing in `os-mirror`,
     the install scripts or the production runbook says what they must not move *from*. So it cannot
     be honoured or checked, and the two deployment paths have drifted apart unnoticed. Measured
     against the running native services rather than what Homebrew has installed:

         server       native (live)   Docker pin
         Mongo        5.0.31          5.0.14
         MySQL        9.6.0           8.0.32
         Neo4j        5.26.0          5.3.0
         Redis        7.2.7           6.2.7
         OpenSearch   2.19.1          1.3.6
         Keycloak     22.0.5          22.0.4

     The direction is the surprise. The Docker images are the only place any of these versions is
     written down; the native stack is Homebrew, so `brew upgrade` moves four of the six with nobody
     deciding to. Despite the policy, native is the unpinned side and Docker is merely old.

     One pairing needs checking before it is treated as cosmetic. `cedar-parent` pins
     `opensearch.version` at 2.19.2, so the servers ship the OpenSearch 2.19 high-level REST client.
     Native pairs that with server 2.19.1 and is coherent; Docker pairs it with server 1.3.6, which is
     not a supported combination. There is also a legacy `org.opensearch.client:transport` artifact at
     1.3.20, so this is a prediction rather than a fact — but if search or indexing fails at the first
     Docker bring-up, look here first.

     The work: record one table of locked versions somewhere single and authoritative, pin the native
     stack to it so Homebrew stops drifting, and move the Docker pins to it. Mongo and Keycloak are
     already close enough to be a non-event. MySQL, Redis and OpenSearch are major-version decisions
     and belong with the persistence-upgrade item (9) above.
  6. **Decide the TLS story.** The leaves bundled in `cedar-assets` expired 2026-04-20.
     `copy_certificates` prefers `$CEDAR_HOME/CEDAR_CA`, whose 28 hosts run to 2028, so this bites a
     fresh clone rather than this machine. The question is whether the repo should carry certificates
     at all rather than issue them at setup.
  7. **Derive the wait coverage instead of maintaining it by hand.** The audit came out better than
     expected and is worth recording, because the reasoning is not obvious. `cedar-main.yml` is one
     shared file naming about 120 variables, and the substitutor runs non-strict: a variable a
     container is not given stays a literal `${VAR}` and only matters if that component is used. So
     each compose `environment:` list is a curated per-server subset, not a statement of what the
     server opens, and comparing the two overstates the gaps. What the servers actually do at startup:
     Neo4j is initialised eagerly for every one of them, and all fifteen waited for it; the persistent
     Redis pool is constructed for every one of them by `AppLoggerQueueService`, but `JedisPool` is
     lazy and `enqueueEvent` catches and counts failures, so an absent Redis drops log events rather
     than failing startup. Five servers were not waiting for Redis and now do — cheap insurance
     against a silent hole. The apparent Mongo gap on bridge is not one: bridge references Mongo
     nowhere. The MySQL gaps on impex and monitor are not either: they log through the Redis queue
     that worker drains, and never open MySQL themselves.

     So no server was missing a wait for something it opens eagerly, and the one real hole was schema.

     The waits are now one script in the base image, `wait-for-dependencies.sh`, driven by the
     environment: a container waits for a backend when it is handed that backend's coordinates.
     Fourteen of the fifteen derive byte-identical behaviour to what they had; only bridge changes,
     gaining a Mongo wait because it is given Mongo coordinates it does not use — harmless, and a sign
     the compose entry is what is wrong. Two things stay explicit because no host variable implies
     them: the MySQL step creates databases and users, so `wait-and-init-mysql.py` keeps deciding for
     itself from `CEDAR_SERVER_NAME`, and waiting on another CEDAR server is declared per image as
     `CEDAR_WAIT_FOR_SERVERS`.

     `pre-docker-entrypoint.sh` survives as an optional per-server hook for work that is not a
     dependency wait, and exactly one server still has one. The resource server's carried the
     first-run bootstrap of the whole system — Neo4j indices, global and caDSR objects, the initial
     users — behind a flag on the `resource_state` volume, buried under six lines of waits. Anything
     folding those scripts together has to keep it.

     That bootstrap has a latent problem worth its own look. The `cedarat.sh` calls are not checked
     and the flag is written unconditionally, so a first run against a half-ready Neo4j marks the
     system initialised without having initialised it, and never retries; recovering means deleting
     the flag from the volume by hand. Observed while testing the split, not introduced by it.

     The entrypoint now also honours the pre-entrypoint's exit status. It did not before, which never
     mattered because every wait script blocks until its backend answers rather than giving up — but
     it meant a misconfigured server would have started anyway. A server asked to wait for a peer
     whose admin port is not set now exits 1 instead of starting into a failure it cannot explain.

     What remains is bridge's surplus Mongo coordinates, and the same treatment for the frontends,
     which have no waits at all.

  One estate difference is worth a decision rather than a fix. The Docker nginx now serves 24 virtual
  hosts against the native stack's 28; the four that remain are CEE's — `demo.cee`, `demo-dist.cee`,
  `docs.cee`, `docs-dist.cee`. CEE itself is not a candidate for a container: it is a web component,
  built to a single JS file and embedded in a host page, with no process to run. The `-dist` pair is
  plain nginx over a built directory, the same shape as the six frontend images, so those two are one
  more image if the sites are meant to be hosted at all — the runbook classes the demos as
  non-essential and not started by default, and the `cedar-component-demo` checkout they are built from
  is absent from this machine, so the native server blocks point at directories that do not exist. The
  other two proxy a live `ng serve` and belong to development only.

  The decision that frames all of it: the containerized path is currently evaluation-only. Staging,
  preprod and production profiles all set `CEDAR_NET_GATEWAY=127.0.0.1` and the production runbook never
  mentions Docker. Settle whether it stays an eval install, becomes the local development environment,
  or becomes the deployment shape for staging and prod — the four items above are worth different
  amounts depending on the answer.

## Testing

Coverage and test-infrastructure work. The active REST integration suites live in
`ops/e2e/rest/suites/`; the JUnit matrices and boot-smoke live in the per-server modules.

- **15. Make test execution an explicit, usable option in `cedarcli build`.** The Java build currently
  uses `mvn clean install -DskipTests`; this restores the historically fast and predictable developer
  build after briefly enabling every JUnit suite made `cedarcli build java` appear to run forever.
  Investigate whether tests should eventually become the default again, but at minimum give `build
  this`, `build parent`, `build libraries`, `build project`, `build clients` and `build java` clear
  `--tests` / `--skip-tests` options with one documented default. The selected policy must apply
  consistently to every Maven task in the generated plan and preserve Maven's failure status.

  Enabling tests is not only a command-line switch. The backend-free suites deliberately point Redis
  at dead port 1 because queue writes are best-effort; each expected failed write currently emits a
  full Jedis connection stack trace. In one captured `cedarcli build java` run this produced 1.17
  million lines (49 MB) in 1 minute 39 seconds while the tests were still advancing. Give tests a
  quiet queue substitute or suppress the expected queue/Jedis exceptions in test logging, while
  retaining a focused assertion that an unavailable queue does not fail the request. Also replace
  cedar-cli's nonblocking `while proc.poll() is None` output loop: it busy-polls at 100% CPU and Rich
  continually redraws the terminal, magnifying the log flood and making progress hard to distinguish
  from a hang. Acceptance means the default build remains monitorable, the opt-in full test build has
  bounded useful output, and both modes finish with a trustworthy non-zero exit code on failure.

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
