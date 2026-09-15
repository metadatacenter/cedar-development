# CEDAR Frontend — Roadmap

Open work for the Workspace, Template Editor, Metadata Editor, Profile, embeddable
editor (CEE/CEF), embeddable designer (CED), and their TypeScript model library.
This roadmap also owns browser workflows whose completion spans a frontend and
its supporting service.

See [FRONTEND-RUNBOOK.md](FRONTEND-RUNBOOK.md) for operating procedures and
[BACKEND-ROADMAP.md](BACKEND-ROADMAP.md) for backend work outside browser workflows.
Term-picker and terminology-versioning work remains in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md).

Item numbers are contiguous across the document and change as work leaves it.
Refer to the concrete change by name in commits.

## Workspace and browser workflows

### 1. Retire routine `CEDAR_VERSION_MODIFIER` cache busting

A deployment should not need a hand-edited modifier
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

### 2. Finish the DataCite DOI minting lifecycle

The durable lifecycle is what makes the operation
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

### 3. Provide the category user interface in the Workspace

Add browser workflows for category maintenance, artifact classification, category access and
ownership transfer, using the existing category tree and artifact search.

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

### 4. Complete Workspace validation and save feedback

Extend Workspace's validation display
to render a rejected create/update's structured server `validationReport`, instead of
routing it only through the generic backend-error presenter. Keep the document dirty,
show the problems' paths and messages, and provide navigation to the affected field
across pages and repeated elements where possible. Localize the host summary and
missing-required-field messages.

Establish which CEE findings predict REST rejection and which are advisory before
changing Save behavior. Do not disable Save solely on CEE's `isValid`: the
`requiredValue: true` / `minItems: 0` case in `harness/test/report-shape.spec.ts` is an
explicit reason these verdicts can differ. Treat the server's response as authoritative
when the validators disagree or the template changes between edit and save.

Cover invalid-to-valid and valid-to-invalid transitions, advisory-only reports, rejected
creates and updates, correction followed by a successful save, and differing client
and server reports. Extend the existing Workspace controller tests with rendered host
workflow checks rather than recreating its report subscription.

<a id="cee"></a>

## Embeddable editor and model library

### 5. Whole-component runtime theme overrides

Define host-facing CSS properties for
brand, surface, text, muted and border roles beyond the compact-control API in
`STYLING.md`. Wire them through the M3 adapter to every affected control and overlay,
keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser
tests that set custom role values and check rendered foregrounds, backgrounds and
focus states before documenting the properties as supported.

### 6. Authoring feedback for unsupported markup

Expose CEE's rendering policy to
authors in the Workspace/Template Editor rich-text `Source` mode and CED's markup
input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both
supported formatting and rejected markup.

Decide how authoring tools obtain the policy: a public `TEMPLATE_MARKUP_POLICY`
embedding API or a supported description kept in sync with editor configuration
and tests. Include rules beyond the tag and attribute allowlists, such as forbidden
event handlers and non-raster data images.

### 7. Consistent authority marks

Decide whether all seven authority fields should use
the organisations' genuine marks, then replace the approximations for ORCID, PFAS,
NIH Grant and DOI and the raster PubMed/RRID assets with approved vector assets where
available. Keep assets inline, preserve their accessible labels, and check appearance
at field-icon size. ROR provides the existing inline-vector pattern. Record asset
provenance and usage terms with the assets.

### 8. RDF instance export

Add an RDF serialization to the download contract, using a
JSON-LD processor rather than a handwritten serializer. Decide first whether the
output is N-Quads or Turtle and whether `downloadContentFor` becomes asynchronous or
gains a separate asynchronous producer. Carry that decision through the menu,
filename, media type, failure handling and harness tests.

Install a document loader that rejects remote context fetches: exporting an instance
must not introduce network access beyond CEE's embedding contract. Test type coercion,
nested and repeated elements, attribute-value property IRIs and malformed contexts
against a reference processor. Measure the production bundle with `check:size` before
choosing dependencies; do not use old bundle-headroom estimates. Coordinate with the
font-payload work if the added processor exceeds the packaging budget.

### 9. Reduce embedded font payload

Measure subsetting the Material Icons font to the
ligatures CEE actually uses. Add a build guard that inventories template and descriptor
ligatures and rejects a glyph absent from the shipped font; the menu glyph browser
check alone does not cover every icon source.

Separately decide which Roboto scripts the single-file bundle must carry. Inlining all
seven unicode-range subsets at three weights ships every subset, even for a Latin-only
form. Retain latin-ext for Hungarian; dropping other scripts requires an explicit
fallback-font decision and multilingual rendering checks. Re-measure decoded and gzip
savings on the current production bundle. Preserve namespaced font faces and the
single-artifact embedding contract; serving fonts as extra files changes that contract.

### 10. Localize numeric and temporal validation

Replace the numeric widget's
`describeNumberType` sentence and the temporal widget's validator message / English
required-value fallback with translation keys and parameters. Decide separately
whether data-quality-report messages remain stable diagnostic text or are localized;
preserve each problem's machine-readable `code`. Check Hungarian and English for
required values, numeric type/precision failures and temporal errors, including
language changes while an error is visible.

### 11. Define handling of out-of-range stored UTC offsets

Decide what to show and report
when a host supplies offsets such as `-13:00` or `-13:45`, which
`TimezonePickerComponent.zoneForOffset` accepts but the picker does not offer.
Preserve the stored value until an explicit correction; rejecting it must not silently
blank the control or rewrite the instance. Update the tests that currently document
this leniency once the display and validation behavior is decided.

<a id="ced"></a>

## CED

Design Basic, Semantic and Modular as interfaces suited to their audiences.
Together they must cover its authoring capabilities. Keep CED responsible for
editing, rendering, local validation and host-facing UI contracts. The embedding
host owns storage, authentication, permissions, server validation requests,
publishing, version allocation and provenance.

### 12. Display host-supplied validation findings in CED

Define an input for validation findings supplied by the embedding host. Map artifact
paths to fields and settings, show messages beside the affected controls, and offer
navigation from a summary across nested elements. Keep local draft-validation
findings distinguishable from host-supplied results.

Specify when external findings become stale after an edit or artifact replacement.
Preserve unsaved input and cover correction, clearing and replacement of reports.
The host calls the schema server and decides whether an artifact may be saved.

### 13. Annotation and descriptive metadata authoring

Provide a clear authoring surface for annotations, appropriate
for the Semantic and Modular profiles. Replace the Field details placeholder with focused controls for language, alternate
labels, property name and annotations. Support adding, editing and removing
literal and IRI-valued annotations, with unique names and validation of IRI values.

Preserve imported annotations and property IRIs through unrelated edits, nesting,
and JSON/YAML round trips. Respect host-supplied editing restrictions and preserve values when an edit is
cancelled or invalid.

### 14. A palette entry for a date that carries a time

The palette offers Date and Time, and `xsd:dateTime` has no entry of its own. An
author reaches it by adding a Date and changing its datatype, which works and is
not discoverable: the Basic profile's worked example is a Release Date that
carries both, and nothing in the palette says CED can express one.

Either a third entry, or the datatype control has to be plain enough on a Date card
that nobody needs the palette to find it. The palette already has twenty-six
entries, which is the argument against a third.

### 15. The three profiles, and what each one holds

Basic, Semantic and Modular are the product structure, and CED has their names
already: three presets in the preferences modal, each a bundle of visibility
booleans plus a list of field types to hide. A preset hides controls. A profile is
a different interface — its own field types, its own constraint editors, its own
guidance — so the mechanism is a smaller thing than the plan needs, and the
definitions it currently holds are wrong in both directions.

Basic hides one field type, Controlled Terms, and shows all twenty-five others.
It offers Attribute Value, which asks an author to describe fields whose names a
form-filler will supply later, and all seven external authority types. It hides
Field Help Text and Default Value, both of which the Basic profile's own mockup
shows, and shows the whole parameter surface of every type it does offer.

Two questions, then. What belongs in each profile, decided per field type and per
control rather than by one boolean apiece. And what a profile may change —
visibility alone, or the editors and the guidance with it. Moving between profiles
has to leave the template intact, which is what makes the second question hard: a
template authored in Modular and opened in Basic still contains everything Basic
does not show.

Every control on a card today is a decision this item has to absorb, and there are
now a great many of them.

### 16. Per-type capability rules

Add `primaryField` to the per-type capability rules and authoring surface so an
author can choose what a search result shows for a template.

Mark controlled-term fields with no vocabulary as invalid and expose that finding
to the host. Preserve the draft instead of silently serializing it as plain text.

### 17. Guidance in the interface

Tooltips, help messages and worked examples are part of what makes the Basic
profile usable by someone who has never met a metadata standard, and the Semantic
profile needs more than that: short explanations of what naming an ontology term
buys, and of what a particular constraint will do to the form an author's
colleagues eventually fill in.

Controls need a common way to declare help, let a host reword it, and translate
it. A `title` attribute naming a button does not explain the choice behind it.

The parameter work makes this larger rather than smaller. A datatype menu, a
granularity menu and a regular-expression box are each a place an author needs to
be told what the choice does.

### 18. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 19. Complete the CED embedding contract

Define inputs for read-only mode, language and allowed field types. Host restrictions
bound what the author may edit or select; profile and preference settings can narrow
those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies reusable fields and preference state, and how CED
reports user changes or requests back to it. The host chooses where and how to store
that state. Support replacement of the supplied artifact when the host opens another
artifact or creates an editable draft, without CED allocating identities or versions.

Add conformance and browser tests for these inputs and events, including read-only
published content and transitions to a host-supplied editable document.

### 20. Keyboard and screen-reader access

Verify keyboard focus order across cards, settings, palette actions and nested
elements. Add live-region announcements for constraint changes and accepted or
rejected local Apply actions and host-supplied validation results. Exercise those workflows with a screen reader and
verify that focus returns to a useful control after each action.
