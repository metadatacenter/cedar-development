# Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [RUNBOOK.md](./RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).

## Next

- **Done: the token signature is now verified.** This was the most serious finding in the estate.
  `KeycloakUtils` used to base64-decode the JWT payload and check only expiry and that the subject
  resolved to a real user; the signature was never checked, so a token with any signature — or one
  hand-built with no key material — authenticated as whoever its payload named. Fixed by building a
  real `KeycloakDeployment` through `KeycloakDeploymentBuilder` (which installs a rotating
  `JWKPublicKeyLocator` and the client that fetches the realm's signing keys) and routing token
  resolution through `AdapterTokenVerifier.verifyToken`, which checks the signature, the issuer, and
  that the token is active. An expired token still reports `TOKEN_EXPIRED`/`REFRESH_TOKEN` so the
  frontend refreshes rather than logging out; every other failure is a 401. This also closed the
  malformed-Bearer-500: an unparseable token is now rejected cleanly rather than faulting. Verified end
  to end — every forgery in `ops/e2e/rest/suites/authentication.mjs` is refused, genuine tokens still
  work across the whole REST smoke and the browser login. The one loose end left for production: the
  key-fetching client currently trusts the local self-signed `.orgx` certificate
  (`disableTrustManager`), matching the admin client; a real deployment should point it at a truststore
  holding the realm CA (see the comment in `KeycloakDeploymentProvider`).

- **Restrict who may change a group to its administrators.** Every ordinary CEDAR user is given the
  `groupAdministrator` role (`cedar-main.yml` `defaultRoles.normal`), and that role carries
  `UPDATE_NOT_ADMINISTERED_GROUP` (`CedarUserRolePermissionUtil`) — the override that skips the "only
  administrators may change this group" check in `GroupsResource`. Because everyone holds the override,
  the check never applies to anyone: any logged-in user can rename, re-staff, or delete any other
  user's group without being a member of it. Making yourself administrator of a group then confers
  everything shared with that group; deleting it revokes everyone else's access through it. The fix is
  to move `UPDATE_NOT_ADMINISTERED_GROUP` out of the default role into a privileged administrator role,
  exactly as `WRITE_NOT_WRITABLE_CATEGORY` is already separated into `categoryPrivilegedAdministrator`.
  Pinned by `ops/e2e/rest/suites/groups.mjs` ("who may write a group they do not administer").

- **Make a permission change reach the search index.** A grant is written to the graph immediately —
  every graph-backed view (`shared-with-me`, `shared-with-everybody`, id lookup, `view-all`) reflects
  it at once — but it never reaches the OpenSearch document that term search filters on. The worker
  logs processing the `RESOURCE_PERMISSION_CHANGED` event, yet the indexed document's materialized
  `users` list is byte-for-byte identical before and after the grant (verified directly against the
  index, and over a two-minute poll). The effect: someone you share with can open the artifact and see
  it under "shared with me", but a search by name never finds it; a shared folder's contents are
  unsearchable by the person you shared them with. Only the everybody grant reaches term search,
  because it is denormalized onto the node as `everybodyPermission` rather than carried per-user. This
  is the same subsystem as the revocation-reaching-the-index item below; both are the graph and the
  index disagreeing. Pinned by `ops/e2e/rest/suites/finding.mjs`.

- **Reject an invalid `limit` or `offset` instead of faulting.** `/folders/{id}/contents` and `/search`
  share a paging validator that lets a bad argument through to code that throws: a limit of zero, a
  negative limit or offset, a non-numeric limit (`limit=abc` reaches a `NumberFormatException`), and an
  excessive limit all answer 500 where 400 belongs. The excessive-limit case is also a denial-of-service
  vector — an unbounded page size — and is the same one the search item pins. The fix is to validate the
  paging arguments once, in the shared validator, and refuse a bad one with 400 (or clamp an excessive
  limit). Pinned by `ops/e2e/rest/suites/pagination.mjs` across both endpoints.

- **Guard the `@id` in the four open commands.** `CommandOpenResource`'s `make-artifact-open`,
  `make-artifact-not-open`, `make-folder-open` and `make-folder-not-open` read `@id` from the body
  without asserting it is present, so a request omitting it becomes a lookup for the artifact whose id
  is null and answers 404 — telling the caller the artifact does not exist rather than that their
  request was malformed. This is the same unguarded read already fixed in `CommandFileSystemResource`;
  apply the same `c.must(param).be(NonEmpty)` guard. Pinned by `ops/e2e/rest/suites/openness.mjs`.

- **Settle the sharing and permission model, then write it down.** This is the umbrella item: the
  pieces below are each small, and separately each looks like a quirk, but together they say the model
  was never specified in one place, so every surface decided for itself. Controlled sharing is what
  CEDAR is for, which makes this the part most worth being deliberate about. All of it is now pinned by
  tests, so the behaviour cannot drift further while the decisions are made — and each test named here
  will fail and demand attention when a decision lands.

  What was found, in the order it bites a reader:

  - **Six declared permission levels, two enforced.** `READ` and `WRITE` are checked;
    `CHANGEPERMISSIONS`, `CHANGEOWNER`, `PUBLISH` and `CREATE_DRAFT` are consulted nowhere, yet can be
    granted and stored. Detailed in its own item below.
  - **`WRITE` confers re-sharing, but not versioning.** The ACL update asks only for write access, so
    editing implies re-sharing; versioning asks for ownership, so it does not. Two different answers to
    "what does write let me do", and neither is written down.
  - **Reading an ACL costs a different permission per resource kind.** A folder's permissions need read
    access; a category's need *write*. Same operation, different bar.
  - **Categories are world-readable, folders are not.** A category is readable by any authenticated
    user holding the role, with no per-category check, because it is a shared vocabulary. Defensible,
    and the opposite of every other resource, and undocumented.
  - **Group membership confers no read.** A member cannot fetch the group or its member list, so a user
    can reach resources through a group they cannot see and cannot discover who else can reach them.
  - **Denials answer 401 or 403 depending on which code path refuses.** Detailed in its own item below.
  - **Authority checks live in different layers per subsystem**, so one of them is bypassable by a
    non-HTTP caller. Detailed in its own item below.
  - **Transferring ownership does not transfer control.** The owner field moves, but a resource inside
    the donor's own tree is still reachable by the donor, because permissions inherit from the parent
    they still own. So handing something over leaves the donor with read and write on it, and the
    recipient is unlikely to expect that. Pinned in `SharingRoundTripTest`.
  - **Ownership is the one thing a WRITE grantee cannot take**, which is the model working: the owner
    check in `validateOwnerSetPermission` holds across folders and all four artifact types. Noted here
    because it is the boundary the rest of the model leans on, and because it is the only place
    `CHANGEOWNER` would be consulted if it were consulted at all.

  One of the original findings is already fixed rather than listed: a permissions response containing a
  group grant could not be deserialized by the shared model, because `CedarGroupExtract` had no
  no-argument constructor while `CedarUserExtract` did. That is now a one-line constructor in
  `cedar-core-library`, with the typed read in `SharingRoundTripTest` as its regression test.

  The deliverable is **a permissions document** — there is none today, and its absence is the root of
  everything above. It should state the tiers, what each confers, how inheritance interacts with
  ownership, and which of the listed behaviours are intentional. Only then is it worth making the code
  and the enum agree with it.

  Pinned by `FolderPermissionLevelMatrixTest`, `ArtifactPermissionLevelMatrixTest`,
  `SharingRoundTripTest`, `ArtifactsAndCategoriesAuthorizationMatrixTest`,
  `GroupMembershipAuthorizationMatrixTest`, `GroupSharingRevocationIntegrationTest` and
  `ArtifactLifecycleMatrixTest`.

- **Separate authentication from authorization in `CedarErrorType`.** The enum maps
  `AUTHORIZATION` to `UNAUTHORIZED`, so a permission denial that travels as a `BackendCallResult`
  error answers 401 where it should answer 403. `PUT /folders/{id}/permissions` is the observed
  case: an authenticated user with no grant on the folder is refused with 401, while every other
  folder endpoint refuses the same user with 403. The exception-based denials are correct because
  `CedarAccessException` subclasses set their status explicitly; only the call-result path falls
  back to the type default. The enum cannot simply be remapped, because the same `AUTHORIZATION`
  type also carries genuine authentication failures, including the missing-header case
  (`AuthorizationNotFoundException`), which must stay 401. The fix is to distinguish the two: add a
  permission error type that maps to `FORBIDDEN` and use it at the resource permission denial sites,
  or set the status explicitly there. Roughly 41 usages of `AUTHORIZATION` need review.

  The scope is narrower than it first appeared, and categories show what the fix should look like.
  `PUT /categories/{id}/permissions` already answers 403, because it gates on
  `userMustHaveWriteAccessToCategory`, which raises an exception carrying an explicit status and so
  never reaches the call-result path. Only the resource path — folders and artifacts, both via
  `ResourcePermissionRequestValidator` — is affected. So the category validator is the reference
  rather than a second instance to fix.

  Both affected cases are pinned, in `FoldersAuthorizationMatrixTest` and
  `ArtifactsAndCategoriesAuthorizationMatrixTest`, which will fail and prompt an update once this
  changes. A 401 conventionally tells a client to re-authenticate, so today the frontend can bounce a
  user to the login screen when they merely lack rights on someone else's folder.

- **Cover the artifact content routes in the authorization matrix.** `PermissionMatrix` now covers
  the group server, a user's home folder, all four artifact types and a category
  (`ArtifactsAndCategoriesAuthorizationMatrixTest`). One gap remains, and it is blocked rather than
  merely unwritten.

  `GET /templates/{id}` and the write paths proxy to the artifact server, which the resource-server
  suite does not run, so a row for them would assert the proxy failing rather than the authorization
  decision. The security contract is already covered, because the permission check precedes the proxy
  in every case; what is missing is the owner's happy path on those routes. That needs the
  cross-service contract tests described below, not another table here.

- **Decide what the unenforced permission levels are for.** `FilesystemResourcePermission` declares
  six: `READ`, `WRITE`, `CHANGEOWNER`, `CHANGEPERMISSIONS`, `PUBLISH`, `CREATE_DRAFT`. Outside the
  enum declaration and tests, `CHANGEPERMISSIONS` and `CHANGEOWNER` appear nowhere in the codebase —
  nothing ever consults them. Only read and write are enforced.

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

- **Put the authority checks in one layer.** The same class of operation is protected at different
  layers depending on the subsystem, which is the kind of asymmetry that yields a bypass the first
  time someone adds a caller.

  For filesystem resources the check lives in the session layer:
  `ResourcePermissionRequestValidator.validateWritePermission` refuses the ACL update, and
  `AbstractResourceServerResource.updateResourcePermissions` carries no authority check of its own.
  For groups it is inverted: `GroupUsersRequestValidator` validates only that the group exists and the
  users are real, and the administrator check sits solely in the HTTP resource
  (`GroupsResource.updateGroupMembers`, gating on `userAdministersGroup(gid) || <system permission>`).

  So any non-HTTP caller of `GroupServiceSession.updateGroupUsers` changes a membership with no
  administrator check at all. Nothing does today — the only caller is the endpoint, and the tests —
  but membership is the widest lever in the sharing model, so a future in-process caller (a migration,
  an admin tool, another service) would silently skip the boundary
  `GroupMembershipAuthorizationMatrixTest` pins. Move the group check down into the validator, matching
  resources, or state deliberately that session-layer callers are trusted.

- **Check that revocation reaches the search index.** Listings and search are served from OpenSearch,
  not from the graph, and permission changes reach it asynchronously through
  `SearchPermissionEnqueueService`. Revocation is the fail-dangerous direction: if the index lags or
  the message is lost, a user whose access was withdrawn keeps seeing the resource in their listings
  and search results, and may still be able to open it from there depending on which reads are
  index-backed.

  `GroupSharingRevocationIntegrationTest` establishes that the graph stops granting access
  immediately, on both membership removal and group deletion, so the model is right. What is unverified
  is the projection of it. This cannot be tested in the current suites: they run
  `NoOpNodeIndexingService` precisely so they need no OpenSearch, so the enqueue path is a no-op there.
  It needs either a test with a real index, or an assertion at the smoke level that a revoked user's
  listing no longer shows the resource. The REST smoke now reaches the real index and has found the
  companion bug on the *grant* side — a grant never reaches term search at all (see "Make a permission
  change reach the search index" above) — so the projection is demonstrably broken in both directions
  and the two are almost certainly one fix. Related to the cross-service contract tests below, and to the
  folder-listing staleness already documented in `deleteRow` in the smoke.

- **Give the shared test JVM room, or stop sharing it.** The resource server's suite runs every test
  class in one JVM, and each class that boots a server creates a Neo4j driver whose Netty event-loop
  threads are never reclaimed. Nine such classes exhaust it: the ninth fails to start with Netty's
  "failed to create a child event loop". Eight currently pass, so the module is at its limit, and the
  next class added will hit this.

  The failure is nastier than it sounds. It appears only in the full run, never when the class is run
  alone, and it names whichever class happened to boot last rather than the one responsible — so it
  reads as a flaky new test rather than as exhaustion. Capping Jetty's pools was tried and does not
  help; the threads are the driver's, not the server's.

  Either close the drivers when a class finishes, or give each class its own fork
  (`reuseForks=false`), which also removes the `CedarConfig` singleton contamination that made the
  environment-override machinery necessary in the first place. Forking costs JVM and embedded-Neo4j
  startup per class, which is why the JVM is shared today, so this is a trade to make deliberately.
  Until then, new REST-level tests should merge into an existing class, as sharing and ownership
  transfer share one.

- **Stop a published artifact being re-published.** `POST /command/publish-artifact` succeeds on an
  artifact that is already published, bumping it to the new version and overwriting content the model
  treats as immutable and citable. Reproducible on demand and not a timing window: it behaves the same
  immediately after the first publish and six seconds later.

  The rule exists and is tested — `resourceCanBePublished` refuses a non-draft with
  `PUBLISH_ONLY_DRAFT`, which `ArtifactLifecycleMatrixTest` pins — but it is unreachable from the REST
  layer, because the status check sits inside a type test:

  ```java
  if (resource instanceof FilesystemResourceWithCurrentUserPermissionsAndPublicationStatus res) {
    if (res.getPublicationStatus() != BiboStatus.DRAFT) return negative(PUBLISH_ONLY_DRAFT);
  }
  ```

  The endpoint passes a `FolderServerSchemaArtifactCurrentUserReport`, which implements
  `ResourceWithVersionData`, `ResourceWithPreviousVersionData` and `ResourceWithOpenFlag` — not the
  publication-status interface. So the `instanceof` never matches, the check is skipped silently, the
  method falls through to the superseded test, a freshly published artifact has no successor, and
  `canPublish` comes back true. The unit test passes because it constructs a type that does implement
  the interface; production constructs one that does not.

  Decide first whether re-publishing should be allowed at all — it may be wanted, in which case the
  graph predicate and the lifecycle test are what should change. If it should not be, the fix is to
  make the check unconditional rather than dependent on the caller's choice of type, since a guard
  that silently does not run is worse than no guard. Pinned in `ops/e2e/rest-smoke.mjs`, which will
  fail when this changes.

- **Remove deleted resources from the search index.** Deletion never reaches the index. After a run of
  `ops/e2e/rest-smoke.mjs`, `GET /search` returned 28 hits of which all 28 answered 404 on a direct
  read, with entries persisting well beyond ten minutes and accumulating across runs. A user who
  deletes a folder or template keeps finding it in search.

  This is the concrete form of the question above about revocation reaching the index, and the answer
  is worse than lag: nothing is removed at all. The dashboard listing does clear, so the defect is in
  the search projection specifically, not in the graph. It is also what the UI smoke's delete-retry
  loop was quietly absorbing, and why that loop was long misread as index lag. `rest-smoke.mjs` reports
  the count without failing on it, since failing a gate on a pre-existing stale index would only make
  the gate unusable.

- **Classify the errors that still answer 500.** Two client mistakes remain reported as server faults,
  and each has its own cause — neither is the error-pack default, which is now fixed (see below).

  `POST /template-fields` with a body missing `pav:version` answers 500 with `"errorType": null` and
  the message "You need to provide a non-null value for the parameter:version from InPlace". The pack
  carries no error type at all, so nothing can derive a status from it: the throwing code needs to
  classify the failure as invalid input. The other artifact kinds answer 400 for the same omission.

  `GET /search?limit=100000` answers 500. `AbstractSearchResource` already calls
  `pagedSearchQuery.validate()`, so a cap belongs there — but which behaviour is a decision worth
  making once and applying to all thirty-one paged endpoints: refuse an excessive `limit` with 400, or
  clamp it to a maximum and serve fewer rows than asked. Refusing is more honest; clamping is friendlier.
  An unbounded page size is also the denial-of-service vector the pagination item mentions.

  Both are pinned in `ops/e2e/rest/suites/` as current behaviour and will fail when fixed.

  **Fixed already, recorded for the reader:** `CedarErrorPack` initialised `status` to
  `INTERNAL_SERVER_ERROR` and its `errorType(...)` setter did not derive it, though `CedarErrorType`
  already declared the right mapping. `errorType(...)` now adopts the type's status unless one was
  chosen explicitly — the flag matters, because `CedarAssertionResult` offers `forbidden()` and
  `errorType()` as separate builder steps and deriving unconditionally would have turned a deliberate
  403 into a 401. `CedarErrorType.NONE` maps to 200 and is the initial value, so it is deliberately not
  derived from. That fixed the unknown and missing `resource_type` cases and the unknown convert
  `format`. Separately, `move-resource-to-folder`, `copy-artifact-to-folder` and `rename-resource` read
  their required fields unguarded off the `JsonNode`; they now use `must(...).be(NonEmpty)` like the
  sibling `CommandCategoriesResource`, so a missing field is a 400.

- **Decide whether a home folder may be renamed.** It can be, over REST: `PUT /folders/{home}` with a
  new `schema:name` succeeds and the folder stays flagged `isUserHome`. Deleting it is correctly
  refused. The Java folder matrix's comment assumes rename is refused too, so either the comment is
  wrong or the endpoint is.

  Discovered by a test that renamed a real home folder and had to be corrected by hand, which is why
  `ops/e2e/rest/suites/folders.mjs` deliberately no longer attempts it: a suite that runs against a
  live stack should not mutate the one folder a user cannot recreate. If rename should be refused, the
  check belongs beside the delete-refusal assertion already there.

- **Decide whether users can classify their own artifacts.** Attaching a category to an artifact
  requires a grant on the *category*, not merely on the artifact: `ATTACH` (or `WRITE`, which implies
  it) must be held on the category being attached. The category tree is writable only by someone with
  write on the root, which is an administrator, so out of the box a normal user can read the vocabulary
  and attach nothing to anything — including to templates they own.

  This is the design working as built, and `ATTACH` is one of the few permission levels that *is*
  enforced. But it means the category picker is inert for ordinary users until an administrator grants
  `ATTACH` on each category, and nothing in the product surfaces that. Either grant `ATTACH` broadly
  when a category is created, or make the requirement visible. `ops/e2e/rest/suites/categories.mjs`
  pins the whole sequence: refused without the grant, allowed with it.

- **Reconcile validate with create.** Validation requires `@id`; a create refuses it. So the exact
  body a client is about to POST does not validate, and anyone wanting to check first has to invent a
  placeholder identifier. Both halves are pinned in `ops/e2e/rest/suites/validation.mjs`, including the
  error naming `@id` so the cause is at least discoverable.

  Either let validation accept an artifact with no identifier, or document that a pre-create check
  needs a placeholder. As it stands the natural client workflow — validate, then create — cannot be
  followed literally.

  Instance validation is also not purely syntactic: it resolves `schema:isBasedOn` and answers 400 when
  the template cannot be found, so an instance cannot be validated against a template that does not yet
  exist. Reasonable, and worth stating.

- **Add degradation tests.** Nothing asserts how a service behaves when a dependency it needs is
  unavailable. The cost of that gap is known: reading any folder whose creator could not be resolved
  returned 500 for as long as the defect existed, because `UserSummaryCache` let Guava's
  "loader returned null" signal escape instead of degrading to the no-display-name path the callers
  already handled. A cheap form is one test per server that points a dependency at a dead port and
  asserts the API degrades rather than 500s. Bear in mind that queue writes are already best-effort
  by design (`AppLoggerQueueService`, the worker and NCBI queues), so those are the pattern to match.

- **Decide on concurrency control.** There is no `ETag`, `If-Match` or `@Version` anywhere in the
  stack, so two users editing one template is a silent lost update: the second save wins and the
  first user is never told. This is a design item rather than a coverage item, since no test can be
  written until the API offers the conditional-request machinery.

- **Cover pagination.** Largely done. `ops/e2e/rest/suites/pagination.mjs` now walks both a folder's
  contents and search two rows at a time and reassembles each listing exactly once, asserts a stable
  `totalCount` and a page past the end, and checks the first/last paging links. The remaining product
  question — whether an invalid or excessive `limit`/`offset` should be a 400 or a clamped 200 rather
  than the 500 they all answer today — is pinned there and carried as its own item above ("Reject an
  invalid limit or offset"). Still uncovered: the other paged listings beyond contents and search
  (categories, and the several `*-extract` variants).

- **Add cross-service contract tests.** The resource server proxies to the artifact, terminology and
  value-recommender servers. Per-service suites stop at the hop and the end-to-end smoke covers only
  the happy path, so a request or response drift between two services is invisible until runtime.
  Both inter-layer bugs found recently, the media-type status and the empty ontology picker, were
  found by chance rather than by a test.

- **Cache the CompTox substance registry locally.** On every start the bridge server rebuilds its
  registry by fetching roughly 14,700 substances from the external CompTox API in batches of a
  thousand, holding the result in a `ConcurrentHashMap` that dies with the process
  (`SubstanceRegistry`, driven by the `Managed` `SubstanceRegistryLoader`). Three costs follow: the
  load takes around ninety seconds, during which `/healthcheck` returns 500 and every redeploy shows
  the service as UNHEALTHY; startup depends on a third party being reachable and on the API key being
  valid at that moment; and each restart re-fetches a slowly-changing reference dataset that has not
  meaningfully changed since the last one.

  Persist it instead, and refresh on a schedule or when the local copy is stale rather than on every
  boot, so the server serves from the cache immediately. SQLite fits and is already in the stack:
  `org.xerial:sqlite-jdbc` is pinned in `cedar-parent` for the terminology local store, so there is
  both precedent and an existing dependency to follow.

  Splitting readiness from liveness in the health check is worth doing alongside, so that a server
  which is up but still warming reports as such rather than as failed. On its own it only relabels
  the ninety seconds; caching removes them.

- **Upgrade the persistence and infrastructure servers.** These versions are currently pinned (see
  the runbook's version locks) while the client libraries have moved on. Order them by risk, lowest
  first: Redis, then MySQL, then OpenSearch, then MongoDB, then Neo4j. Take **Keycloak separately and
  last**: it runs a forward-only Liquibase schema migration on the existing user store, the custom
  themes will need re-porting, the `keycloak-admin-client-jakarta` coordinate it uses was
  discontinued after 21.1.2, and `cedar-keycloak-event-listener` is compiled against the current SPI.
  Rehearse each on a copy of production data and gate on the end-to-end smoke.

- **Regenerate the tutorial screenshots against production.** The controlled-term tutorial runner in
  `cedar-mkdocs` is hardened for the current picker and for BioPortal latency, but the published
  images are still older. Regeneration needs an interactive login to production
  (`node auth.mjs`, then `node term-run.mjs`), and it creates and deletes a scratch folder there.

- **Move `commons-fileupload2` off the milestone build.** The parent pins `2.0.0-M5` because no
  stable release existed when the jakarta migration needed it. Move to the stable line once it is
  published.

- **Retry the ontology-list load in the term picker.** Frontend work, in
  `cedar-template-editor`, and the last piece of this defect still outstanding: the smoke half is
  done, so the symptom is now worked around rather than fixed.

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

  A patch along these lines was written and verified live against the local stack, but is deliberately
  not committed: pushing frontend code needs an owner who is comfortable with it.

  The end-to-end smoke no longer depends on this being fixed, which is what makes it a roadmap item
  rather than a blocker. Its create-template-and-constrain block retries as a unit, each attempt
  starting from the designer deep link, because that page load is the only thing that gives the
  service a fresh attempt; re-running the ontology search inside the picker reads the same empty cache
  and never could succeed. Nothing is saved server-side until after the block, so a failed attempt
  leaves no orphan template.

- **Stop using the hardcoded BioPortal key, and rotate it.** `Constants.BP_PUBLIC_API_KEY` in
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
  life of the page: the same defect described in the term-picker item above.

- **Remove the vestigial published-delete guard.** `AbstractResourceServerResource.executeArtifactDelete`
  carries the `PUBLISHED_ARTIFACT_CAN_NOT_BE_DELETED` check as a commented-out block, disabled
  deliberately by commit `3f26ee7` (2021-02-08, "Allow users to delete published resources"). The
  block left `isSchemaArtifact` and `schemaArtifact` computed but unused, and the error key is now
  unreachable. Delete the block, the dead locals and the key. The commented code reads as an
  accidental omission rather than a decision, which costs a reader time and invites someone to
  "restore" behaviour that was removed on purpose. `PUBLISHED_ARTIFACT_CAN_NOT_BE_CHANGED` stays: it
  is still enforced, and `ArtifactLifecycleMatrixTest` records the asymmetry.

## Out of Scope

These are deliberate decisions, recorded so they are not rediscovered as gaps.

- **A load or performance suite.** The end-to-end smoke plus real usage covers the shape, and the
  yield is low next to the items above.

- **Fuzzing and injection suites.** Jersey and Jackson absorb most malformed input, and no endpoint
  builds queries by string concatenation.

- **Modernizing `cedar-keycloak-event-listener`.** It stays on Java 8 and HttpClient 4 on purpose: it
  is an SPI plugin loaded inside the Keycloak runtime, whose version is locked, so it must match what
  Keycloak provides rather than what the rest of the stack uses.

- **Annotation-gating the bridge server's live tests.** They currently pass, so marking them
  `@Disabled` in the name of consistency with the terminology suite would remove real coverage.

- **Aligning the Jackson pins in the `mcp/*` subprojects.** Those poms deliberately pair
  `jackson-annotations` 3.0-rc5 with 2.x `jackson-databind` to work around a missing constant, and
  they say so in comments. Revisit when Jackson 3 is released.
