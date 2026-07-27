# Roadmap

Cross-cutting work items for the CEDAR backend: the microservices, the shared libraries, and the
test and ops tooling. Items live here when they span repositories or when the fix belongs to a
shared library rather than to one server.

For how to run and build the system see [RUNBOOK.md](./RUNBOOK.md), whose "Dependency and Framework
State" section records what the stack currently sits on. Library-internal items belong in that
library's own roadmap, for example [cedar-artifact-library](../../cedar-artifact-library/ROADMAP.md).

## Next

- **Separate authentication from authorization in `CedarErrorType`.** The enum maps
  `AUTHORIZATION` to `UNAUTHORIZED`, so a permission denial that travels as a `BackendCallResult`
  error answers 401 where it should answer 403. `PUT /folders/{id}/permissions` is the observed
  case: an authenticated user with no grant on the folder is refused with 401, while every other
  folder endpoint refuses the same user with 403. The exception-based denials are correct because
  `CedarAccessException` subclasses set their status explicitly; only the call-result path falls
  back to the type default. The enum cannot simply be remapped, because the same `AUTHORIZATION`
  type also carries genuine authentication failures, including the missing-header case
  (`AuthorizationNotFoundException`), which must stay 401. The fix is to distinguish the two: add a
  permission error type that maps to `FORBIDDEN` and use it at the validator denial sites
  (`ResourcePermissionRequestValidator`, `CategoryPermissionRequestValidator`), or set the status
  explicitly there. Roughly 41 usages of `AUTHORIZATION` need review. The anomaly is pinned in
  `FoldersAuthorizationMatrixTest`, which will fail and prompt an update once this changes. A 401
  conventionally tells a client to re-authenticate, so today the frontend can bounce a user to the
  login screen when they merely lack rights on someone else's folder.

- **Extend the authorization matrix to artifacts and categories.** `PermissionMatrix` (in
  `cedar-test-support-library`) states, as a table, which status each actor must receive for each
  operation. It covers the group server and a user's home folder. Templates, elements, instances and
  categories are the remaining places real metadata lives, and their grids are unwritten. The folder
  matrix is the model to follow: assert the denial cells, assert the owner's reads so the denials are
  shown to discriminate by identity, and re-read the fixture afterwards to prove a refusal changed
  nothing.

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

- **Cover pagination.** Thirty-one endpoints declare `page` and `pageSize`; one test file exercises
  paging. Off-by-one behaviour, a page past the end, and an unbounded `pageSize` (which is also a
  denial-of-service vector) are all unasserted.

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

- **Retry the ontology-list load in the term picker, and reload the page in the smoke.** The template
  editor loads BioPortal's ontology list once per page load: `controlledTermDataService.init()` fires
  the fetch and sets `initialized = true` synchronously, whether or not the fetch succeeded. If that
  one attempt fails, which is likely just after a redeploy when the terminology server is cold and
  BioPortal adds seconds, the cache stays empty for the life of the page and nothing retries it. A
  user sees an empty "Add ontologies" box, with no error, until they reload. This is the same defect
  class as the `UserSummaryCache` 500: a failed lookup latching permanently instead of retrying or
  degrading. Set `initialized` only on success, or retry with backoff.

  The end-to-end smoke has the matching gap. Its ontology search retries by re-clicking search, which
  re-reads the same permanently-empty cache, so widening that retry budget cannot help; only a page
  reload gives the service a fresh load attempt. The fix is an outer retry around the whole
  create-template-with-constrained-field section rather than an inner retry around the search. Until
  then a smoke run straight after a redeploy may fail at the DOID step and pass on a warm re-run,
  which is the pattern currently observed.

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
