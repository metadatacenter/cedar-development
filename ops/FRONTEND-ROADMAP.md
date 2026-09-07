# CEDAR Frontend — Roadmap

Cross-cutting work for the main CEDAR browser applications: the Workspace, Template Editor,
Metadata Editor and Profile. This roadmap also owns completion of the user workflows initiated by
those applications when the remaining work spans a frontend and its supporting service.

Work specific to the embeddable editor is in [CEE-ROADMAP.md](./CEE-ROADMAP.md). Work specific to
the embeddable designer is in [DESIGNER-ROADMAP.md](./DESIGNER-ROADMAP.md). Backend work that is not
part of a browser workflow is in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

## Next

- **1. Retire routine `CEDAR_VERSION_MODIFIER` cache busting.** Frontend code identity now comes
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

- **2. Finish the DataCite DOI minting lifecycle.** The durable lifecycle is what makes the operation
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

- **3. Provide the category user interface in the Workspace.** The Workspace currently reads the
  category tree, filters artifacts by category and displays the category paths attached to an
  artifact. Its `CategoryService` exposes only `GET /categories/tree`. Users cannot create or
  maintain categories, classify artifacts, inspect or change category access, or transfer category
  ownership through the browser.

  Add a category browser and inspector without replacing the existing tree or category search.
  Selecting a category must load the category report and its permission report. Show the category's
  name, description, identifier, parent, owner, direct user grants and direct group grants. Show the
  current user's effective role and capability set. Direct grants must remain visibly distinct from
  effective access, which can also come through a group, an ancestor category or ownership. Only
  direct grants can be changed on the selected category.

  Drive every action from the capability set returned by the server. `createChildCategory` enables
  child creation. `updateCategory` enables changes to the name, description and identifier.
  `deleteCategory` enables deletion. `attachCategory` and `detachCategory` govern classification.
  `manageGrants` enables ACL editing. `transferOwnership` enables ownership transfer. Do not infer
  these actions from a role name, ownership flag, administrative status or the capabilities of an
  ancestor retained in client state. Apply the server's root-category restrictions in the same way:
  an unavailable capability produces no enabled control.

  Add classification controls to the artifact information panel. Attaching or detaching a category
  must also require the selected artifact's `updateResource` capability. Show only categories the
  user can read, and disable a visible category that lacks the required classification capability.
  Issue a separate explicit action for each attachment or removal. Do not present several additions
  and removals as one save operation until the server offers an endpoint that applies that complete
  change atomically. Refresh the artifact report, category paths and affected search results after a
  successful change.

  Add create, edit and delete actions to the category inspector. Send the ETag returned with the
  category report in `If-Match` for update and delete. A `412 Precondition Failed` must preserve the
  user's unsaved input, reload the current category and explain that another change won the race.
  A delete conflict must state whether child categories or classified artifacts keep the category
  non-empty. Refresh the category tree and the selected path after every successful mutation.

  Reuse the Workspace's existing user and group selectors for category sharing. Offer exactly the
  Viewer, Classifier, Editor and Manager roles. The Everyone group may receive Viewer and no other
  role. Replace the complete direct ACL through `PUT /categories/{category_id}/permissions`, using
  the permission report's ETag in `If-Match`. Ownership transfer must accept one user, never a group,
  and use that same permission revision. On a stale ACL or transfer, keep the proposed edits visible,
  reload the report and require the user to review the merged result before submitting again.

  Do not provide a Move action until the backend supplies the required access-impact preview and an
  atomic category-branch move operation. Do not emulate a move by deleting and recreating categories.

  Cover the service methods and controls with frontend tests for Viewer, Classifier, Editor, Manager,
  owner and Everyone access. Add a browser smoke that creates a child category, gives another user
  update access to a test artifact, grants that user Classifier on the category, and attaches and
  detaches the category as that user. Change the category grant to Editor and edit the category as
  that user. Transfer ownership and delete the now-empty category as its new owner. The smoke must
  also prove that a stale category ETag and a stale permission ETag are rejected without losing the
  user's proposed input.
