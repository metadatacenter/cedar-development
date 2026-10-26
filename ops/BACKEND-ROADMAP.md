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

## Features

- **1. Complete instance-reader and rendering checks on artifact writes.** Add the Java
  artifact-library instance reader alongside validation against the instance's actual template,
  and verify that templates, elements, fields and instances can be rendered as JSON and YAML
  before storing them. Model readability must not replace template-dependent instance validation.

  Check the exact candidate that would be stored after ordinary completion and metadata handling;
  for a verbatim write, check the supplied body unchanged. Run model checks on a copy and discard
  the rendered output: verification must not replace the submitted document with a canonical
  rendering. A repair must remain possible when its candidate passes even if the old stored body
  cannot be read or rendered. Reject reader or renderer failures with actionable diagnostics,
  retaining field paths where available.

  Refresh the existing instance and conversion audit findings against the current libraries to
  identify writes these additional checks would refuse, distinguish source defects from converter
  defects, and plan any required repairs before rollout. Measure the incremental reader and
  renderer cost on representative artifacts, including large and nested instances.

  Cover JSON and YAML creates, ordinary updates, verbatim repairs, template-dependent instance
  failures and reader/renderer diagnostics, then verify the deployed paths through whole-stack
  smoke. Done when every accepted write passes the applicable schema validation and the artifact
  library's read-and-render checks without the checks changing its stored content.

- **2. Give the public npm releases a CLI route.** Four packages publish outside the platform
  release: `cedar-model-typescript-library`, `cedar-embeddable-editor` (CEE),
  `cedar-embeddable-designer` (CED) and `cedar-embeddable-term-picker` (CETP). The model library and
  CEE reach npmjs through the npmjs runbook. CEE's procedure alone is about twenty-five commands
  across `develop`, a pull request, `main`, the registry, a tag, the development-state restore and
  the train baseline refresh. CEE release 2.0.6 took an hour of operator attention for two minutes of
  gate time, and CEE has shipped four public versions in a week. CED and CETP have no public release
  yet, and CED's manifest still marks it private, so npm would refuse to publish it.

  Build `cedarcli release npm <package>` as one resumable, ledger-backed route for all four, like the
  platform release. For each package it pins the chosen public versions of the packages it builds
  against, writes the changelog entry, runs the package's gate, and publishes from `main` after
  merging the pull request. It then verifies the registry with a retry for the seconds npm's read
  replicas lag behind a publish, tags the release, restores the next development version, refreshes
  the lock baselines, and stops at each remote step it cannot prove. The route orders dependent
  releases. CEE and CED both build against a pinned model library, so a model release comes first.
  CETP builds against none of the other three, and a host page loads CED, CEE and CETP as separate
  scripts, so none of those three waits for another. CEE, CED and CETP all compile in the design
  tokens, so a token change reaches Nexus before any of them is built. The provenance comparison the
  platform release already performs verifies the published CEE tarball, and the route applies the
  same comparison to the other three. Once the command exists, rewrite the npmjs runbook into a
  description of what it does and where it stops.

- **3. Decide what happens to existing instances when a draft template changes.** An instance
  names its template by identifier rather than by version, and is validated against whatever that
  template says now. A template's schema lists every child in its top-level `required` and sets
  `additionalProperties` to false, so most edits to a draft invalidate the instances already stored
  against it. Adding a field leaves every instance without a property it now requires. Removing or
  renaming one leaves every instance carrying a key the template rejects. Published templates are
  frozen, and Update Bubbling refuses a published target, so only drafts are affected. Nothing
  decides today what should happen to those instances, and nothing tells the author.

  A save with no edit can have the same effect on a template stored in an older shape, because the
  library writes it as the current model renders it. Every numeric and temporal value must then
  state `@type`, every child is required, a container left open without an attribute-value child is
  closed, and `@context` admits only terms for declared children. Instances on 12 production
  templates still depend on the older shape, 93 in all. 91 hold entered values under names their
  template does not declare, which its legacy open schema admits and the written template rejects.
  None of the names resembles a renamed field, so each owner decides whether to declare the fields,
  which `declare-instance-field` can do from a reviewed plan. The other 2 keep a context term
  because a value in them spells the term's name. Saving any of the 12 templates, even unchanged,
  invalidates these instances, and only the impact check below would tell the author.

  **Choose a policy for each kind of edit.** Three answers are available, and different edits may
  deserve different ones:
  - **Warn only.** The author sees which instances the edit invalidates and saves anyway.
  - **Migrate dependents.** An added field is mechanical to supply: an empty entry, `{"@value":
    null}` for a literal or `{}` for an IRI, and the child's `@context` mapping. The server or a
    repair job can write it on save. A removal or rename is not mechanical, because the instance
    holds data under the old key; `ops/repairs/rename_sheet.py` drafts mappings for an owner to
    confirm, and without one only a warning is honest.
  - **Complete on read.** Accept that stored instances lag their template, and have every reader
    and editor complete an instance against its current template. The server already completes a
    YAML instance against its template before a write.

  **Build the impact check into authoring.** Every policy needs to know which instances an edit
  affects. `ops/cedar_template_impact.py` makes that comparison GET-only, under the exact body a
  save would store, including save-time normalization. Choose warning versus blocking, and define
  what to do for unreadable dependencies, a template changed during the check, large populations and
  instances the caller cannot see. A permission-scoped result cannot certify the whole dependent
  population; an incomplete check must not mean “no impact.” Surface the affected instance
  identifiers and validation errors without treating already-invalid instances as damage done by
  this edit.

  **Keep the save-time changes that remain, and say why.** Ordinary saves supply identifiers that
  authoring clients ask for, discard unfinished editor state and maintain derived metadata. Removing
  any of them needs a replacement contract for clients rather than treatment as a legacy repair.
  The changes that remain are these:

  | Remaining behavior | Why it remains |
  | --- | --- |
  | Mint missing element-instance IDs and property IRIs | Clients rely on the repository to assign stable identities when an occurrence ID is absent/null or a property mapping is absent; existing identifiers remain unchanged. |
  | Remove blank unnamed attribute rows | These rows represent unfinished editor input and cannot name a stored property. |
  | Prune unused repository-generated attribute context mappings | Deleting an attribute can leave its generated mapping behind; template-declared mappings and author-supplied vocabulary IRIs must remain. |
  | Derive schema `title` and `description` from the artifact name | Renames must keep generated schema metadata consistent while preserving generator attribution. |
  | Add ordinary child mappings to `@context.required` | The save path follows the canonical renderer's declaration. It invalidates instances on its own only where a legacy template never declared a child it already requires, which the repair in the production-data item closes. |

  Verbatim writes bypass these changes and remain strictly validated.

  **Roll out the strict write path.** Release and deploy the compatibility-retirement change once
  the shared Java build and whole-stack smoke gates are green, so an inherited malformed submission
  is refused rather than repaired on save.

  Done when each kind of draft-template edit has a stated policy for the instances it affects, and
  an author sees that effect before the save lands.

- **4. Let an author renumber a draft.** A draft's version is the number its publication will
  carry. The Workspace asks for it when the draft is created, starting at the next patch and
  accepting anything higher, and asks again at publication, where it accepts anything no lower.
  Between the two, nothing can change it. An ordinary update refuses any change to `pav:version`,
  `bibo:status` or `pav:previousVersion`, which lifecycle commands maintain. A verbatim write replaces
  the document but updates only the name, description and identifier on the graph node, so it
  leaves the graph's copy of the version behind. An author who decides partway through a draft that
  the change is a major one can wait for publication, delete the draft and lose its edits, or have an
  administrator follow [Renumbering a Draft by Hand](BACKEND-RUNBOOK.md#renumbering-a-draft-by-hand).

  Add a lifecycle command that renumbers the head draft of a series. Under the version lock it
  refuses anything but a draft with no successor, and requires the new version to exceed the
  published predecessor's, as creating the draft did. It writes the document's `pav:version`
  conditionally on the stored body's ETag, keeping a pre-image, then sets the graph node's
  `pav_version`, restores the document if the graph update fails, and queues the version
  projection so that search follows. Offer it on a draft in the Workspace, with the version
  validation its draft and publish dialogs already apply, and as a tool in the artifact REST MCP.

  Close the gap that makes the manual procedure necessary. A verbatim write that changes
  `pav:version`, `bibo:status` or `pav:previousVersion` should either carry the change to the graph
  or be refused, so that no route can leave the document and the graph disagreeing about an
  artifact's lifecycle. Extend `cedarcli check artifact-versioning`, which reads only the graph, to
  compare each schema artifact's document with its node on those three properties.

  Done when an author can renumber a draft from the Workspace, the document, graph and search
  agree afterwards, and the command refuses a published artifact, a draft with a successor and a
  version not above its predecessor's.

- **5. Validate and encode the DOI the DataCite metadata route resolves.** **Production
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

## Security

- **6. Upgrade Keycloak to a supported release.** CEDAR runs Keycloak 22, at 22.0.5 natively and
  22.0.4 in the image, and `cedar-parent` sets `keycloak.version` to 22.0.4. The community 22 line
  ended at 22.0.5. On 2026-09-30 Dependabot reported 93 open advisories against the Keycloak
  artifacts `cedar-parent` manages, 25 of them high. No community 22 release fixes any of them, and
  every release from 26.7.5 fixes all 93. The current release is 26.8.1. The fixed 22.0.x versions
  some advisories name belong to Red Hat's subscription build rather than to the community line.

  The advisories concern the server rather than CEDAR's code. The microservices ship only
  `keycloak-core`, `keycloak-common` and the adapter, to verify bearer tokens, and none of the
  advisories against those artifacts involves token verification. `keycloak-services` and
  `keycloak-server-spi-private`, which carry the rest, are compiled against by the event listener as
  `provided` and never packaged. The exposure lies in the deployed server, and only upgrading it
  closes the advisories.

  Many of them apply to CEDAR as its 2023 development realm seed configures it. Five concern
  redirect-URI validation, and CVE-2026-7504 specifically affects clients with wildcard redirect URIs,
  which every CEDAR client has. CVE-2026-7507 allows session fixation in the OIDC login flow,
  CVE-2026-4282 allows forged authorization codes, and CVE-2024-3656 lets a plain realm user reach
  admin functions, in a realm where anyone can register. Others need SAML, an external identity
  provider, UMA authorization or mTLS, none of which the seed configures. Production's realm has not
  been checked against either group.

  **One dependency holds Keycloak at 22.** The findings below were measured on 2026-08-08 against
  Maven Central, the code and 26.7.1, then the current release. Recheck them against the current
  release before choosing a route.

  - **The blocker is `keycloak-adapter-core`,** the legacy Java OIDC adapter, whose last release is
    **25.0.3 in August 2024**. CEDAR uses it in exactly three files in
    `cedar-auth-operations-keycloak-library`: `KeycloakDeploymentProvider` builds an `AdapterConfig`
    into a `KeycloakDeployment`, `KeycloakUtils` makes a single
    `AdapterTokenVerifier.verifyToken(token, deployment)` call, and
    `AuthorizationKeycloakAndApiKeyResolver` passes the deployment along. Every server builds one of
    these in the shared bootstrap, so this is the bearer-token path for all twelve.

    The replacement stays inside Keycloak's own supported artifacts: `TokenVerifier`,
    `RSATokenVerifier` and `JWKSUtils` are all present in `keycloak-core` 26.7.1. What the adapter
    supplied for free, and what would have to be written, is the rotating public-key locator and the
    HTTP client that fetches the realm's JWKS. That is the whole of the work, and it is small.

  - **`keycloak-admin-client-jakarta` is not a blocker.** It stopped at 21.1.2 because it was a
    transitional variant, not because it was abandoned. From Keycloak 22 the main
    `keycloak-admin-client` is itself Jakarta-based, and it is published at 26.0.12, so moving to it
    is a coordinate change.

  - **The event listener is not a blocker either.** `EventListenerProvider.onEvent(AdminEvent,
    boolean)`, the signature `cedar-keycloak-event-listener` overrides, still exists verbatim in
    26.7.1, and `keycloak-server-spi`, `keycloak-server-spi-private` and `keycloak-services` all
    publish at that version. Its imports are the stable event and model SPI throughout.

  - **The theme needs two templates re-ported.** `cedar-03` is a login theme with `parent=keycloak`
    that overrides two FreeMarker templates, `login.ftl` and `template.ftl`, plus a stylesheet and
    three images. The stock login theme was superseded by `keycloak.v2` in 24, so those two templates
    need re-porting against the new base. The stylesheet and images carry over.

  Two routes are open. The clean one moves the server to the current 26.x release and replaces the
  adapter usage in the same step. The other moves the server first and keeps the 25.0.3 adapter,
  betting that token verification is plain OIDC over JWKS and will keep working against a 26 realm.
  It probably would. It is also exactly the shape of the 2.19-client-against-1.3.6-server pairing
  this estate carried in Docker for years and was right to be uneasy about, on a library that has had
  no release since 2024.

  **Confirm the Java floor of the 26.x server distribution.** The question concerns the server
  alone, since `keycloak-core` 26.7.1 is Java 8 bytecode and imposes nothing on a client, and the
  Keycloak image installs `java-17-openjdk-headless` unpinned. Settle it alongside the upgrade. The
  estate pins Java 17 only because newer JDKs crash Keycloak 22 on the removed security manager, so
  moving Keycloak forward is the change most likely to retire that constraint.

  Rehearse the upgrade on a copy of the production user store, since Keycloak's Liquibase migration
  of that store runs forward only, and gate it on the end-to-end smoke. The Docker build manifest
  pins the server image as well, and the [Docker roadmap](./DOCKER-ROADMAP.md) owns that lock.

  **Narrow the exposure while the server stays on 22.** Roughly a third of the advisories can be
  closed or reduced without the upgrade, by configuration at the edge and in the realm and by two
  changes to CEDAR's own code. The evidence comes from the 2023 development realm seed and the
  staging nginx mirror, so read production's realm and nginx configuration first and adjust the
  changes to what they hold.

  Staging's nginx passes every Keycloak path to the internet under a single `location /`, so four
  restrictions belong at the edge:

  - Restrict `/admin/` to CEDAR's own hosts and the operators' network. Ten advisories concern the
    admin console or the admin API, among them CVE-2024-3656, which lets a plain realm user reach
    admin functions. Self-registration is open, so that user can be anyone. The user server, the
    monitor server and the admin tool call the admin API through `KeycloakUtils.buildKeycloak`, and
    the allow-list has to admit them.
  - Block `/realms/CEDAR/clients-registrations/`. CEDAR registers no clients dynamically, and the
    endpoint carries CVE-2026-1180, CVE-2026-9803 and CVE-2023-6544.
  - Block the SAML protocol and identity-broker endpoints. CEDAR has no SAML client and no external
    identity provider, and CVE-2026-2575 lets an unauthenticated caller exhaust the server's memory
    through the SAML redirect binding regardless.
  - Cap the request size on the token endpoint, and rate limit it and the login endpoints on the
    terms item 9 sets for the edge. The cap stops CVE-2026-4634, a denial of service through an
    oversized `scope` parameter, and the limit slows the parallel guessing CVE-2024-4629 describes.

  Four changes belong in the realm and server configuration:

  - Disable the features CEDAR does not use with `features-disabled`. They are `authorization`,
    which no client enables and which carries seven UMA advisories, `par`, `ciba`,
    `step-up-authentication`, and `web-authn` if production holds no WebAuthn credentials. Between
    them they carry fourteen advisories.
  - Remove the `http://` and `localhost` redirect URIs from the production clients, which closes
    CVE-2024-8883. Replacing the wildcard redirect URIs with exact ones would cover six more
    advisories, three of them high. `keycloak-js` returns the user to the page they started from,
    though, so each application first needs a fixed callback that restores the deep link itself.
  - Disable the password grant on the public browser clients `cedar-angular-app`,
    `cedar-frontend-bridging` and `cedar-frontend-monitoring` in staging and production. The REST
    smoke tier signs in through it, but only against a local stack.
  - Turn on brute-force detection, which the seed leaves off, with a temporary lockout. A permanent
    lockout would let anyone lock out a user whose username is an email address (CVE-2024-1722).
    With the password grant closed as well, the token endpoint no longer accepts unlimited guesses.

  Two changes belong in CEDAR's code:

  - Turn off `checkLoginIframe` where every application initializes `keycloak-js`, then block the
    login-status iframe at the edge, which closes CVE-2024-1249. The Template Editor leaves the
    option at its default, which loads the iframe.
  - Replace the adapter now. `TokenVerifier`, `RSATokenVerifier`, `JWKSUtils` and `JWKParser` are all
    in `keycloak-core` 22.0.4, the version the services already ship, so the replacement described
    above needs no server change. It retires the adapter's advisory and removes the one blocker,
    which leaves the upgrade a server change and two theme templates.

  Configuration cannot reach the rest. At least six high-severity advisories have no mitigation on
  22: CVE-2026-4282, which lets an unauthenticated attacker forge authorization codes into
  admin-capable tokens, CVE-2026-7507, CVE-2026-7571, CVE-2023-6291, CVE-2024-2419 and
  CVE-2023-6841. They keep the upgrade itself urgent. Red Hat's subscription build carries fixes on
  the 22 line through 22.0.13, and it is the only way to patch Keycloak without leaving that line.

- **7. Protect `main` in every repository, and give the release an identity of its own.** `main` is
  unprotected in all forty-two repositories, so a commit can land there without ever reaching a
  train, which captures `develop`. The next release then replaces it: the work leaves the branch
  that held it and nothing says so afterwards. A hotfix and the unit test guarding it came within
  one reading of an advisory line of going that way. The release gate refuses such a source now, and
  `cedarcli check main` answers the same question between releases, but neither prevents the push.

  **The goal is that no ordinary push lands on `main`.** How the release lands its own commit is a
  second decision, and the two are worth keeping apart, because a protection rule written around
  whoever runs the release protects nothing against the case that prompted this. `cedarcli release
  start` pushes to `main` in thirty-nine repositories as that person, so granting them the bypass
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
  operator who is already there for the twenty-five commands item 2 exists to remove. Automating
  that route puts the identity question back.

  Prove whichever ruleset is chosen against one repository before it reaches all forty-two. Until
  the release has an identity, run `cedarcli check main` on a schedule, so divergence is found the
  next morning rather than mid-release.

- **8. Complete the remaining backend trust-boundary, transport and credential security work.**

  **Four terminology routes answer an anonymous caller, and that stays.** `GET /bioportal/search`,
  the class-descendants route, `POST /bioportal/integrated-search` and `POST
  /bioportal/integrated-retrieve` resolve no user, and the spec marks a credential as optional on
  each. All four reach BioPortal on the server's own key, so an anonymous caller spends the
  deployment's BioPortal quota.

  The reasons differ by route. The embeddable editor calls integrated search, and the embeddable
  designer calls search and integrated search, from a browser with nothing to send, and third-party
  deployments of the editor do the same, so a gate would break every host that embeds them.
  Descendants was opened for OpenView in 2019. No CEDAR client calls integrated retrieve without a
  key; it stays anonymous because every release since 2024 has served it so, and a gate could break
  callers outside CEDAR. Requiring a credential is therefore not the remedy. What bounds the cost is
  the edge rate limit in item 9, which covers `/ext-auth/*` and should cover these four on the same
  terms.

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

- **9. Rate limit the edge in every environment, and turn the authenticated user quotas on.** An
  anonymous caller can spend the deployment's third-party quota, and only the development host
  bounds how fast. The `/ext-auth/*` routes are the clearest case: they proxy seven registries,
  three of them on credentials the deployment holds, and they carry none of their own. The four
  anonymous BioPortal routes item 8 lists belong in the same limit, since each spends the
  deployment's BioPortal key.

  A limit rather than a credential is deliberate. The embeddable editor calls integrated search from a
  browser with nothing to send and nowhere in `CeeConfig` to keep a key, so a gate would break every
  host that embeds it, and a key shipped to a browser is not a secret and would stop nobody who
  wanted to relay through CEDAR.

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

- **10. Put the MySQL connections on TLS, and make the timezone a setting rather than a constant.**
  **Production consequence:** server certificates and client trust have to exist before rollout, and
  messaging, monitor and worker restart into the change. No schema migration.

  Both shipped connection blocks hardcode the same three properties: `useSSL: "false"`,
  `allowPublicKeyRetrieval: "true"` and `serverTimezone: "America/Los_Angeles"`
  (`cedar-main.yml:82` for messaging, `:104` for the log store). The first two together permit
  public-key substitution on an unencrypted authentication channel, which is the part to fix.

  The timezone is a different matter. The comment beside it says that the aggregator is
  self-consistent under the connection timezone, and that forcing UTC would make the connection
  misread the years of existing rows in `log_request`, `log_cypher` and their `_pre284`
  predecessors. The first claim no longer holds. Hibernate 6 writes each `Instant` as UTC wall-clock
  time whatever the connection timezone is. On the local stack on 2026-10-20 the newest `log_request`
  row read 04:24 while the server clock read 21:54 PDT. The logging library's native SQL reads and
  binds `DATETIME` values in the connection timezone, so it places every row written since the
  Hibernate 6 upgrade 7 or 8 hours after it happened. The aggregator still folds each row exactly
  once, so its counts are right. But each day it settles runs from 17:00 to 17:00 UTC (16:00 in
  winter), and the hourly rollups and the log explorer read 7 or 8 hours ahead.
  `LogQueryDAO.normalize` records the shift in the explorer. An embedded MariaDB under the servers'
  settings shows it in the aggregator, where a request logged at 10:01 UTC reads back as 17:01.

  The second claim still holds for rows stored before the upgrade in Los Angeles time, so the tables
  can hold both forms, and no single setting reads all of them correctly. Converting those rows is
  its own piece of work with its own evidence, starting with where the UTC rows begin, so this item
  only moves the value out of the constant and into the profile.

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
  hosted by third parties and calls `POST /bioportal/integrated-search` from origins CEDAR does not
  know, which is one reason item 8 keeps that route anonymous. A deny-by-default list closes it
  unless the policy names it.

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

## Maintenance

- **13. Rename the legacy role relationships in production Neo4j.** The application currently
  interprets `CANREAD` as Viewer and `CANWRITE` as Manager, so the new permission model can be
  deployed without changing the stored graph. The category permission model follows the same initial
  approach: `CANATTACHCATEGORY` stores Classifier grants and `CANWRITECATEGORY` stores Manager grants.
  Category Viewer and Editor grants already use the canonical `VIEWER_ROLE` and `EDITOR_ROLE` names.

  Neither family writes the canonical names yet. `RelationLabel` resolves four roles to legacy names:
  Viewer to `CANREAD` and Manager to `CANWRITE` for resources, Classifier to `CANATTACHCATEGORY` and
  Manager to `CANWRITECATEGORY` for categories. Both `replacePermissions` builders also create the
  legacy types directly. Before migrating, add `CLASSIFIER_ROLE` as the canonical Classifier
  relationship. Make the application read both the legacy and the canonical name of each role, and
  write only the canonical names. Deploy that compatibility code to every environment before changing
  stored relationships, or a patched graph collects legacy grants again.

  Patch the production graph to rename artifact and folder `CANREAD` relationships to `VIEWER_ROLE`
  and `CANWRITE` relationships to `MANAGER_ROLE`. In the same migration, rename category
  `CANATTACHCATEGORY` relationships to `CLASSIFIER_ROLE` and `CANWRITECATEGORY` relationships to
  `MANAGER_ROLE`. `EDITOR_ROLE` requires no migration for either resource family. Neo4j cannot change
  a relationship's type, so the patch merges the canonical relationship between the same two nodes
  and deletes the legacy one. The patch must preserve each grant's endpoints, make no access changes,
  and be safe to run again. Merging rather than creating keeps a second run from duplicating a grant
  the application has since written under its canonical name.

  On 2026-10-03 production held 5,220 legacy grants: 1,755 `CANREAD`, 3,464 `CANWRITE`, one
  `CANWRITECATEGORY` and no `CANATTACHCATEGORY`. That is few enough for one short transaction. The
  builders create grants without properties, so a grant's type and the `_id` of its two endpoints
  describe it completely.

  The patch needs no full dump. Production runs Neo4j 5.23.0 Community, which dumps a database only
  while it is stopped, so a dump would take the graph away from every server for as long as it ran.
  The patch matches only the four legacy types and touches no node, so a read-only export of every
  legacy grant, taken immediately before it runs, records everything it can delete. If a committed
  patch proves wrong, the export says exactly which grants to recreate. Write the export to `/srv`,
  not to the 4 GB `/var` volume on `cedr-prd-app-05`.

  Apply the patch in a single transaction. In `cypher-shell`, open it with `:begin`, run the patch,
  compare the relationship counts with those recorded beforehand, and finish with `:commit` or
  `:rollback`. A failure rolls back the whole patch, and nothing becomes durable until the counts
  agree. The open transaction locks every endpoint node and blocks writes to them, so keep it to
  seconds. Ending the same transaction with `:rollback` rehearses the patch against current
  production data without a copy.

  After applying the patch, regenerate the search index from Neo4j. The rebuild reads every
  filesystem resource from the folder server, 310,463 of them on 2026-10-03, at a rate nobody has
  measured, so time a rebuild on staging before choosing a window. Users do not wait for it, because
  search keeps serving the old index until the new one is complete. Then verify the role counts and
  representative direct, group and inherited access paths for artifacts, folders and categories.
  Remove the compatibility interpretation of `CANREAD`, `CANWRITE`, `CANATTACHCATEGORY` and
  `CANWRITECATEGORY` only after every deployed environment has been patched and verified.

- **14. Upgrade the persistence and infrastructure servers.** These versions are pinned in the Docker
  build manifest, while the client libraries have moved on. The
  [Docker roadmap](./DOCKER-ROADMAP.md) owns the shared build and deployment lock. This item owns the
  remaining server upgrades except Keycloak's, which item 6 owns. Order them by risk, lowest first.
  Rehearse each upgrade on a copy of production data and gate on the end-to-end smoke.

  Containerizing the production data stores needs each image pin moved up to the version already
  running, because an older engine cannot open existing data files, so this item unblocks the
  persistence migration tracked in the Docker roadmap. MySQL is the real decision left among the
  data stores.

  For MySQL the choice is between the 8.4 LTS line the images pin, supported until about 2032, and
  9.7, the first 9.x LTS, released in April 2026. Every 9.x release before it was an Innovation
  release, supported only until the next one, and after 9.7 MySQL numbers releases by year and
  month, so 26.7 is the July 2026 Innovation release. Keycloak settles it for now. Its realm lives
  in this MySQL, and Keycloak's supported configurations list only MySQL 8.0 and 8.4, so stay on 8.4
  until a Keycloak release CEDAR runs supports a 9.x LTS. The client is ready either way, since
  Connector/J 9.7.0 supports MySQL 8.0 and later.

  The development workstation is off the lock. Its native MySQL comes from Homebrew's unpinned
  `mysql` formula and ran 9.6.0 on 2026-10-19, an Innovation release nothing deployed runs, so local
  end-to-end runs have exercised 9.6 since April. Pin the formula, then move the workstation to
  `mysql@8.4` by dump and restore, because an 8.4 server cannot open a 9.x data directory. These
  documents do not record production's MySQL version. Confirm it with `SELECT VERSION()` before
  planning its move.

  Production is the part this item owns for every store: each version rehearsed on a copy of
  production data and gated on the end-to-end smoke. Where the order above and the Docker roadmap
  disagree, the Docker roadmap governs, since it sequences the remaining work.

- **15. Make database schema evolution an explicit, privileged release operation.** Application
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

- **16. Move the build and runtime to Java 21.** The stack is locked to Java 17 — the zsh profile pins it
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
  - the **CEDAR runtime JRE**, `eclipse-temurin:17.0.20_8-jre-ubi9-minimal` — exact, to the build
    number, and the most precisely pinned thing in the estate;
  - **Keycloak's own JVM**, `dnf install java-17-openjdk-headless` in its image — major only, and a
    different vendor from everything else.

  So the thing that runs the servers is pinned harder than the thing that compiles them, which is
  backwards. Measured 2026-10-19: the build JVM on the development workstation is **Oracle
  17.0.14** against a runtime image on **Temurin 17.0.20_8** — a different vendor, six patches
  apart, and both are "17" as far as every check in the estate is concerned.

  Moving to 21 touches all four, so it is the natural moment to make them agree rather than merely
  move together: pin the enforcer and CI to the same exact version the runtime image ships, and give
  Keycloak's JVM the same treatment when its own upgrade lands. Maven is not part of this problem:
  repository builds use the wrapper, while container jar-fetch stages use a separately pinned Maven
  builder image that never enters the runtime.

- **17. Bound the application-log queue, and let its consumer keep up.** Application logging can
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
  - Establish a bounded replay horizon and receipt-retention policy before expiring durable log
    receipts. Inventory and reconcile pre-upgrade rollup discrepancies before enabling raw pruning;
    a missing receipt cannot prove whether an old message's database write already committed.
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

- **18. Ship INFO as the default log level, and bound what a log file can grow to.** **Production
  consequence:** diagnostic detail drops after rollout, so choose the size limits against production
  capacity before deploying. Nothing migrates.

  Twelve shipped `config.yml` files set `org.metadatacenter: DEBUG`, and the artifact server sets
  `org.metadatacenter.config: DEBUG` beside it. Every console appender takes `threshold: ALL`, and
  every file appender archives by day with no size limit: `maxFileSize` and `totalSizeCap` appear in
  no configuration in the estate. A busy day therefore writes one file that nothing bounds, and
  request-path DEBUG buys I/O that nobody reads. Archive depth already disagrees, measured
  2026-09-10: nine services keep `archivedFileCount: 30`, and messaging, monitor and worker keep
  5.

  Nothing connects these files to the Redis queue of item 17. `AppLogger` hands every message to
  `AppLoggerQueueService.enqueueEvent`, which pushes it to Redis without consulting a log level, so
  shipping INFO takes nothing off that queue and a ceiling on the queue takes nothing off these
  files. What bounds each differs as well: a queue is bounded by what its consumer can keep up with,
  a file by what the disk can hold.

  Ship INFO with an environment-controlled override for a service under investigation, put
  `maxFileSize` and `totalSizeCap` on every file appender, and use one retention policy across
  services rather than one per configuration file. Done when no shipped configuration sets DEBUG for
  a whole package, every file appender carries both limits, and the retention policy is recorded
  where the deployment is documented.

- **19. Finish converging on the body paging envelope.** Every route that pages by offset answers
  CEDAR's body envelope: `limit` and `offset` in the request, and `request`, `totalCount`,
  `currentOffset` and a `paging` block of links in the body, built on `PagedListResponse` and
  `LinkHeaderUtil`. Two kinds of work remain: withdrawing the page-number forms that some routes
  still accept beside the envelope, and settling what the estate has not yet made uniform.

  **Withdraw the page-number forms once their clients move.** The terminology server still accepts a
  one-based `page` with `pageSize` or `page_size`, and still answers BioPortal's flat `page`,
  `pageCount`, `pageSize`, `prevPage` and `nextPage` beside the envelope, on its GET routes, on
  integrated search and retrieve, on the versioned `POST /search` and on the property search. Four
  clients still use them: the Template Editor, whose controlled-term autocomplete pages by `nextPage`
  (`autocomplete.service.js:303`); CEE, which asks integrated search for page 1 and reads only
  `collection` (`controlled-field-data.service.ts:47`); cadsr-tools, which walks integrated search by
  page number (`TemplateFieldsHandler.java:122`); and the artifact library's
  `TerminologyServerClient`, which walks integrated retrieve the same way. The bridge's
  `search-by-name` still accepts a zero-based `page` and `pageSize` and still answers `found`,
  `page` and `pageSize`; no client in the estate sends or reads the paging pair, though CEE reads
  `found`. CEE is published, so moving it costs a public release; price that against the release
  calendar before choosing when. Record a withdrawal date for each form once its last client has
  moved.

  **Make the rest uniform.** Defaults and maxima are still set per surface: 100/500 on the resource
  server, the monitor's log explorer and messaging, 50/500 on the monitor's usage breakdowns, 20/500
  on the artifact server and on categories (`cedar-main.yml:360`), 100/500 on the bridge, the
  configured default up to 1,000 on the terminology server's BioPortal routes, 20/200 on its
  versioned and property searches, and 50/500 on a hierarchy's children. Choose one default and one
  maximum. The terminology server's `page_size`/`pageSize` alias still resolves by argument position,
  and its route families pass the arguments in opposite orders (`AbstractTerminologyServerResource.java`,
  `resolvePageSize`), so a request sending both spellings gets a route-dependent answer; resolve it
  centrally, or let it go with the page-number forms. Three variations on the envelope are worth
  documenting where the API is described rather than removing: a POST route carries no `paging`
  links, since it has no URL to link to, and a client asks for the next page by sending the offset;
  a listing that cannot afford or cannot know an exact total answers `countCapped` and leaves out the
  `last` link, as the monitor's raw logs, the bridge's ROR and NIH RePORTER, integrated search past
  its 1,000-result window and the property hierarchies do; and the bridge keys its rows by term IRI
  rather than listing them, which is what CEE reads.

  **Document the two cursor walks as the exception.** `?continuation=` on `/search-deep`, and the
  monitor's log query with its `"<iso>,<id>"` keyset `cursor` (`SearchContinuation.java`,
  `LogQuerySpec.java:29`), page a whole result set at one request per page, which an offset cannot.
  They are two cursor encodings rather than one, and the API documentation should say both are the
  stated exception to the envelope.

  Done when every page-number form is withdrawn or carries a recorded withdrawal date, one default and
  one maximum page size apply everywhere, and the variations and cursor walks are documented. The REST smoke has to assert the envelope on a route from each application
  that serves one; today it covers only the resource server (`rest/suites/pagination.mjs`).

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

  The gate also records a run against services it cannot vouch for. When a Docker container owns a
  service's port, the native controller reports that service's health as `docker`
  (`inspect_status` in `cedar-services.sh`), and `smoke_gate.HEALTHY` counts it as healthy,
  although the controller never assesses a container's health. The same row reads `-` in the
  binary column, so the check that each jar is newer than its repository's `develop` head skips it
  too. A run against a hybrid or Docker stack is therefore recorded as evidence for the `develop`
  heads, and nothing shows that the containers run them. Refuse a Docker-owned row until the gate
  can establish which source its image was built from.

  Add a scheduled and manually dispatchable whole-stack workflow that brings up a known source, runs
  every tier through `cedarcli test e2e`, and retains its report as an artifact. Make the workflow
  train call the same gate implementation the CLI calls rather than a second preflight path. Done
  when every tier runs unattended on a cadence, their reports are retained, a train dispatched
  through Actions is refused on the same evidence that refuses one dispatched from `cedarcli`, and
  no run is recorded against a service whose source the gate cannot establish.

- **22. Take the dependency upgrades that need code changes.** The versions that could move without
  consequence have moved, or arrive through Renovate once they pass its fourteen-day release age.
  What stayed behind stayed deliberately, and it separates into work to do, versions that follow
  something else, and versions whose newest release is not a final.

  **The upgrades that need code or test changes.** Each of these is a change to make rather than a
  version to raise, which is why none of them rode along with a sweep.

  - **json-schema-validator 1.5.9 to 3.0.8.** Two major lines on the library that decides which
    stored artifacts CEDAR accepts. A change in validation behaviour is a change to the product, so
    this one is settled by differential testing against production artifacts, not by a green build.
  - **OWLAPI 4.5.9 to 5.5.1.** Ontology semantics, where a behavioural difference does not show up
    in a compile. Even 4.5.29, the newest release on the current line, is more than a patch. It
    replaces the Sesame 2.7.16, Semargl and `jsonld-java-sesame` parsers under all three users with
    RDF4J 3.7.7. It needs the same testing against ingested ontologies as the major.
  - **Jedis 5.2.0 to 8.0.2.** Every release from 6.0 supports Redis 7.2 and later, so the deployed
    server can stay. The majors since 5.x removed deprecated APIs, and 7.0 also dropped
    `JedisSharding` and renamed the pipeline and transaction base classes. CEDAR uses only `Jedis`,
    `JedisPool`, `JedisPoolConfig` and two exception types, in ten main source files across the
    queue, logging, search, rate-limit and monitor code. On 2026-10-20 the four libraries holding
    them and the monitor server compiled against 8.0.2 unchanged, main and test sources alike. The
    embedded Redis the queue and quota suites start is 6.2, below what Jedis 6 and later
    support, so those suites stop being evidence for this change and the real-stack smoke against
    Redis 7.2 decides it.

  - **Apache POI 5.5.1 to 6.0.0.** The Java 17 minimum fits the estate, but removed APIs and
    changed formula-cell formatting defaults need the Excel and TSV renderers checked against
    representative workbooks before the major moves.

  **Versions that follow a locked server or framework.** Five sit here: the Neo4j driver 5.28.15 to
  6.3.0, MySQL Connector/J 9.7.0 to 26.10.0, the OpenSearch client 2.19.6 to 3.9.0, the Lucene pin
  9.12.3 to 10.5.2, and the Neo4j test harness 5.3.0 to 2026.10.1.
  Client libraries are free to move in general, but a driver crossing a major has to be proven
  against the pinned server it talks to, so these are sequenced behind item 14 rather than taken on
  their own. Keycloak 22.0.4 to 25.0.3 is item 6's own, and RESTEasy 6.2.19 to 7.0.5 is held by the
  Keycloak client stack, which item 6 owns.

  Maven 3.9.16 to 3.10.0 is a sweep rather than a version. Each of the 26 repositories carries its
  own wrapper, so the move is one change across all of them, gated on the full build and a train
  dry run and made just after a release.

  Embedded Mongo 4.22.0 to 4.33.0 and 5.0.0 belongs here too, and it is the deployed Mongo it
  follows rather than a framework. The obstacle is the binary. MongoDB published no macOS ARM build
  before 6.0, and flapdoodle 4.22.0 and earlier resolve the x86-64 build there instead. From 4.23.0,
  5.0.0 included, flapdoodle offers no mongod 5.0 package for macOS on ARM, so every suite that
  starts the embedded store dies at `could not resolve package for
  V5_0:Platform{operatingSystem=OS_X, architecture=ARM_64}`, while 6.0, 7.0 and 8.0 all start. Linux
  CI does not see the failure; every Apple silicon workstation does. Taking the upgrade therefore
  means running the suites against a different major from the deployed 5.0.31, which is the one
  thing `EmbeddedCedarMongo` exists to avoid. It moves with item 14. Version 5.0.0 also costs one
  import, since flapdoodle moved `de.flapdoodle.reverse` to `de.flapdoodle.commons.reverse`, and
  `EmbeddedCedarMongo` is the estate's only consumer.

  Logback 1.6 belongs here rather than among the upgrades to make, and SLF4J is not what holds it:
  every 1.6 release builds against slf4j 2.0.18, which the estate already carries. Dropwizard does.
  Raising logback to 1.6 fails before a test runs — `LogbackAccessRequestLayout` reads
  `DEFAULT_CONVERTER_MAP`, which logback 1.6 removed, so every Dropwizard-booting suite dies in a
  class initializer. `mvn test -Dlogback.version=1.6.3` in a server module reproduces it, and an
  enforcer rule in `cedar-parent` now fails the build there rather than inside a test JVM, where
  the error names a logback-access class for a field that lives in logback-classic.

  Upstream now calls the 1.5 line legacy. Track the fixes arriving on 1.6 while resolving the
  Dropwizard API incompatibility; raising the version ceiling alone does not resolve it.
  logback-access is held by its own builds rather than by that rule. Its 2.0.13 release is the last
  built against logback-core 1.5, and 2.0.14 is the first built against 1.6. Both wait on Dropwizard
  shipping a line built against 1.6.

  Dropwizard also holds the Jakarta EE 11 generation. Hibernate 6.6.59 to 7.4.14 and Jersey 3.1.12
  to 4.0.3 have finals, as do the Jakarta Persistence 3.2.0, Servlet 6.1.0, Validation 3.1.1,
  RESTful Web Services 4.0.0 and Annotations 3.0.0 APIs, against the 3.1.0, 6.0.0, 3.0.2, 3.1.0 and
  2.1.1 the parent manages. Dropwizard 5.0.2 pins the Jakarta EE 10 line of every one of them, so
  they move together when Dropwizard ships a line built on EE 11. Raising one alone would put two
  generations on one classpath.

  **Versions that follow whatever pulls them in.** The transitive block exists so that every module
  resolves one version of an artifact nothing here depends on directly, which makes these four
  nobody's choice to raise: HK2 locator 3.0.6 to 4.0.3, which follows Jersey; Jandex 2.4.5 to 3.3.1,
  which follows RESTEasy; protobuf-java 4.31.1 to 4.36.2, which follows Connector/J, the newer of
  its two users; and Reactor Core 3.7.19 to 3.8.7, which follows OpenSearch with the Lucene pin.
  Each moves to the version its owner's POM names when that owner moves. Raising one on its own
  would pin a version its owner does not expect, and the Renovate config offers none of them.

  Netty, 4.1.139 to 4.2.19, is held for a different reason. The Neo4j driver 5.28.15 is built
  against Netty 4.2.17, and the 4.1 pin exists for neo4j-harness 5.3.0, which declares 4.1.84 and
  runs its embedded Bolt server on it. A test dependency therefore sets the Netty every production
  server runs the driver on. Ending the hold needs the harness proved on 4.2, or replaced as the
  parent POM's harness note anticipates.

  **Versions whose newest release is not a final.** These have no final to move to: HttpCore
  5.5-beta4 and HttpClient 5.7-alpha1, SLF4J 2.1.0-alpha1, Log4j 3.0.0-beta3, Angus Activation
  2.1.0-M1, and the Jakarta activation and XML binding milestones. The old javax jaxb-api's only
  newer version is a 2018 build that was never finalized, so it stays too.

  Read that list with suspicion, because the report it came from hides releases.
  `versions:display-property-updates` names only the newest version an artifact has, so a
  pre-release at the head conceals every stable release behind it. Seven Maven plugins sat in this
  group behind 4.0.0 betas, and Site behind a milestone, until each was checked against the
  published metadata and turned out to have a current stable release — which is how the compiler
  plugin reached 3.16.0 from a 2018 build, and Site 3.22.0. Every version this item names was
  rechecked against the published metadata on 2026-10-24, with pre-releases set aside. Read an
  artifact's `maven-metadata.xml`, or `versions:display-plugin-updates`, which reports the newest
  release a given Maven version can actually use, before concluding that something cannot move.

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

- **23. Resolve the remaining production artifact defects and review semantic migrations.**
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
  | TypeScript strict-reader diagnostics on Java-validator-valid source schemas; conversions still succeed | 46: 42 context additional-properties declarations and 4 missing-child requirements; full audit on 2026-09-25, targeted rechecks through 2026-09-27 |

  Reconcile the unavailable search/graph entries with the store; the legacy `.net` template also
  returns 404 under the corresponding `.org` ID.

  Reconcile instance-context `additionalProperties` declarations in 42 remaining templates.
  Their 195 dependent instances block tightening:
  62 currently valid instances contain populated undeclared fields, while 133 already fail
  validation. Keep the 62 extra-field cases unresolved; do not delete values or mappings, invent
  declarations, or infer renames to satisfy the canonical rule.
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
  findings and checked repairs leave 27 affected instances under the latest libraries.
  Consistent reader rejection of an invalid source still requires a source repair.

  | Remaining issue | Instances |
  | --- | ---: |
  | Stored multiple-datatype literals; narrow repairs blocked by other template errors | 3 |
  | Stored mixed `@id`/`@value` fields | 5 |
  | Malformed/empty stored URI is the first Java rejection | 10 |
  | Malformed annotation objects | 7 |
  | Numeric JSON literals | 2 |

  Verify Unicode field-IRI support in remaining browser/editor consumers. Resolve the production
  terminology HTTP 403 access restriction before claiming live lookup compatibility. Preserve
  Unicode term identifiers verbatim; percent-encoded spellings and different vocabulary versions
  are not interchangeable. Library and production migration evidence is under
  `$CEDAR_HOME/.cedar/repairs/2026-09-26-unicode-iri-library/` and
  `$CEDAR_HOME/.cedar/repairs/2026-09-27-repeatable-source-hyperlink/`.

  Reconcile the remaining library behavior without silently discarding data.
  Thirteen instances have narrow source corrections prepared but still fail validation for other
  reasons; resolve those blockers before writing. Preserve conflicting populated values and ambiguous
  URI spellings until the intended replacement is established. The GeoExposure CASTNET link fields
  can lose their exact duplicate `@value`, but unrelated template errors block the complete write.
  Plans, validation errors, backups and readbacks are under
  `$CEDAR_HOME/.cedar/repairs/2026-09-25-instance-values/REPORT.md`.
  All seven remaining malformed-annotation instances retain other validation defects. Recheck
  their narrow proposals after those blockers are resolved. Retained proposals and conversion
  evidence are in `$CEDAR_HOME/.cedar/repairs/2026-09-26-annotation-instance-cleanup/`.

  Obtain the actual codebook and measurement-scale URLs for CA-CORD
  `1835f14f-1894-4f41-ae0f-df2507b2ae02`. Both fields remain empty despite the template's
  `requiredValue: true` authoring constraints. This is a missing-content follow-up, separate from
  the remaining pipeline failures; do not invent URLs to satisfy the authoring requirement.

  The four unresolved index entries return 404 even after retry; reconcile the index and store
  rather than declaring them converted. Investigate already-invalid sources without a pipeline
  discrepancy separately from library disagreements. Revalidate against actual templates before
  any source repair. Retained replay evidence is under
  `$CEDAR_HOME/.cedar/audits/2026-09-25-instance-strict-shapes-replay/`; the
  [instance pipeline runbook](./BACKEND-RUNBOOK.md#full-production-instance-matrix) describes coverage.

  Deploy the JSON writers that preserve explicit attribute-value group property IRIs as optional
  schema context mappings. Check JSON and YAML conversions of an affected template on the deployed
  resource path; keep these group mappings out of instance context requirements and inflation.

  **Verify deployment adoption of the updated annotation writers.** Check that backend and editor
  model renders retain the optional `_annotations` declaration and `@nest` context mapping.
  Keep malformed annotation values rejected. The unavailable `.net` template remains part of the
  indexed-404 group above.

  **Prioritize the largest remaining groups.** These retained measurements need a fresh check
  before planning more repairs; they are not a current census. Repeated names identify distinct
  templates; ID prefixes distinguish them.

  | Template | Invalid instances |
  | --- | ---: |
  | Migrant-Interviews (`ad459f36…`) | 34 |
  | LINCS DSGC Dataset Submission (`70b010f2…`) | 26 |
  | Adverse Events V2 | 25 |
  | VODAN-COVID-Migrants-Tunisia (`1988902f…`) | 22 |
  | causal pathway | 21 |
  | PGHD_BP_template | 15 |
  | Expression | 14 |
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
  of the field disagree about what an instance may hold. Production has not been counted for the
  fields of this shape that require nothing. Settling one means choosing which half is wrong, and
  rewriting `properties` invalidates any instance already holding the other shape, so neither is a
  repair a lookup answers. `apply-canonical-term-fields` writes a field as the controlled-term field
  the libraries read it as, where no instance holds a literal.

  **Require every literal field's value.** `literal-field-meta-schema.json` lets a literal field omit
  `required`, so an instance of the field may leave its value out. It also lets the field's
  `properties` omit `@value`, so an instance has no slot for one. Both libraries write `["@value"]`,
  adding `@type` for a numeric or temporal field, and restore the list when they read a field without
  it.
  The walk of 2026-09-29 found 77,006 literal fields without the list, and the
  `complete-literal-required` repair writes it wherever a field is unambiguously literal. Tighten the
  meta-schema to demand both the list and the `@value` slot of every literal field once three things
  hold:

  - Each remaining field has a decision. Two templates cannot take the list without invalidating
    instances that omit a value: in one, 72 of 893 instances leave `@value` out, and in the other, 3
    of 7 omit `@type` in a numeric field. Two csv2caDSR fields, HR Pos and race_id, declare both
    `@value` and `@id` in nine export templates, and their instances hold both. HR Pos lists only a
    "Negative" term, so 528 of its 888 values are literal codes, and 8 of race_id's values are codes
    with no term.
  - The validator sends a controlled-term field to the IRI meta-schema. `CedarValidator.isIRIField`
    chooses by `_ui.inputType` alone, and a controlled-term field is a `textfield`, so today it is
    checked against the literal meta-schema. That meta-schema therefore admits `@id` beside `@value`,
    and it cannot demand `@value` without refusing every canonical controlled-term field. Three
    changes settle it. `isIRIField` adopts the rule `cedar-artifact-library` reads fields by: a
    `textfield` carrying an ontology, value-set, class or branch constraint, or declaring `@id` and
    not `@value`, is a controlled-term field. `iri-field-meta-schema.json` accepts `textfield`, since
    its input-type enum names only `link` and the `ext-*` types. And before the changed validator
    ships, a validation audit run with it finds the stored controlled-term fields the IRI meta-schema
    refuses: HR Pos and race_id among them, and any legacy shape the literal meta-schema has let
    through. The literal meta-schema can then drop `@id` from the slots it admits.
  - The writers that still omit the list produce it. A generator of openMINDS-derived templates and
    elements wrote 67 affected artifacts in 2025 and 2026, and the RADx CSV2CEDAR generator was still
    in use in 2025. Neither lives in the estate, so their maintainers have to change them.

  `cedar-model-validation-library` already holds a test of each rule for a standalone field, a field
  in an element and a field in a template, six in all, disabled as known gaps:
  `shouldFailMissingRequired` and `shouldFailMissingProperties_Value` in
  `TemplateFieldValidationTest`, and `shouldFailMissingProperties_Field_Required` and
  `shouldFailMissingProperties_Field_Properties_Value` in both `TemplateElementValidationTest` and
  `TemplateValidationTest`. `cedarcli build java` reports them as its six skipped tests. The
  tightening is done when all six run enabled and pass.

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

  **Close the legacy context-requirement gap before any save closes it for you.** Some templates
  require a child in their top-level `required` but not in `@context.required`, and some of their
  instances lack the child's `@context` mapping. Any ordinary save of such a template adds the
  requirement and invalidates those instances, although the author changed nothing about them.
  Supplying a missing mapping is mechanical: the template states the property IRI. Measure first
  with `ops/repairs/ctxreq_at_risk.py`, which lists, per template, the instances completing its
  `@context.required` would invalidate. Then add the missing mappings to those instances with a new
  transform, and complete the templates with the existing `complete_context_required` transform.
  An instance that maps the child to a different IRI is a conflict, not a gap, and needs its
  owner. Measured 2026-09-27: 34 templates still have the gap and no elements do. Completing them
  would newly invalidate 1,139 of the 6,334 key-visible instances checked, 890 of them under *Cell*
  and 217 under *Chemical Tool*; 14 templates can be completed now without invalidating anything.
  Every one of the 4,689 failures is a missing `@context` mapping, none a conflicting one. The
  evidence is under `$CEDAR_HOME/.cedar/audits/2026-09-27-ctxreq-at-risk/`.

  **Possible approach: update eligible artifacts through the canonical Java model.** For artifacts
  whose meaning can be preserved, consider reading them with `cedar-artifact-library` and writing
  its canonical rendering back to the store. This could normalize contexts, complete empty fields
  and align stored representations with the Java/TypeScript libraries. Treat it as an optional
  update strategy within this repair work, not a commitment to rewrite the entire corpus or a
  prerequisite for narrow repairs such as supplying missing context mappings.

  Evaluate the approach with a dry run against fresh sources. Compare each rendering with its
  source, classify every difference and fix any library loss before selecting artifacts for a
  rewrite. Cross-library agreement does not prove preservation. Use RDF-graph equivalence where
  applicable, together with explicit checks of schema constraints, field and array order, labels,
  language tags, identifiers, provenance and other content that RDF equality alone may not protect.
  Validate each complete candidate against its actual template or meta-schema and check dependent
  instances before changing a schema. Artifacts requiring an owner's semantic decision stay out
  of the automatic rewrite population.

  If the evidence supports canonical updates, approve the permitted difference categories and
  proceed in bounded batches through `repairs/cedar_artifact_repair.py`, using conditional verbatim
  writes, saved preimages and exact readbacks. Refresh the scope and operational cost first: a full
  corpus rewrite would involve roughly 300,000 writes, each with a new revision and indexing work.
  Record exceptions explicitly and retain targeted transforms wherever their narrower invariant
  provides a clearer preservation guarantee.

  Done when every enumerable artifact is valid or recorded as a named exception, the rename sheet is
  answered or explicitly abandoned for its tail, and no constraint lacks a `sourceSystem` the sweep
  could have written.

- **24. Raise branch coverage where the branches decide what CEDAR stores, and gate branches as
  lines are gated.** Each module sets `cedar.coverage.line.minimum` a little below its measured line
  figure, and `cedar-parent`'s coverage check fails a build whose module falls under it by its own
  tests. Nothing gates branches, so a change can stop exercising the decisions a module makes
  without failing anything. The full build of 2026-10-21 measured 68.6% of branches by each
  module's own tests, 74.3% by each repository's own tests and 77.1% by any test.

  The libraries whose branches decide what a write stores and what it refuses carry the most risk.
  `cedar-model-validation-library` reaches 72.4% of its branches by its own tests. Raise it to 80%.
  `cedar-artifact-library`'s path that reads, validates and renders artifacts reaches 78.7%, apart
  from the standalone exporters and command-line tools. Raise that path to 80% too. Hold each
  server's application module to at least 70%. The terminology server (65.1%), the monitor (65.2%),
  the messaging server (67.5%) and the worker (68.5%) are below it.

  Add a branch counter beside the line counter in the coverage check, through a
  `cedar.coverage.branch.minimum` property that defaults to zero and that each module sets a little
  below its measured figure, as it sets the line floor. Measure every floor from a clean build,
  because a figure read after an earlier run without `clean` overstates it. A module tested from a
  sibling module, such as `cedar-workspace-operations-library`, which its repository tests through
  `cedar-test-support-library`, can be held only to what its own tests reach: 38.8% of its branches,
  against 69.9% by its repository's tests.

  Done when every module declares a branch floor, `cedar-model-validation-library` and the artifact
  library's core path hold at least 80% of their branches by their own tests, and no server's
  application module is below 70%.
