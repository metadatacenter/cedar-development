# CEDAR Frontend — Roadmap

Open work for the Workspace, the Template Designer, the Template Editor, the
embeddable editor (CEE/CEF), the embeddable designer (CED), and their TypeScript model library.
This roadmap also owns browser workflows whose completion spans a frontend and
its supporting service.

See [FRONTEND-RUNBOOK.md](FRONTEND-RUNBOOK.md) for operating procedures and
[BACKEND-ROADMAP.md](BACKEND-ROADMAP.md) for backend work outside browser workflows.
Term-picker and terminology-versioning work remains in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md).

Item numbers are contiguous across the document and change as work leaves it.
Refer to the concrete change by name in commits.

## Cool Extensions

Explore features that make CEDAR's templates, elements, fields and instances immediately
useful and understandable, building on the eye preview for demos and everyday use.

### 1. Drop In a Spreadsheet

Let a user drop in a spreadsheet and choose a template. Propose a mapping from columns to
template fields, preview a few resulting instances, and flag missing values and terminology
mismatches before saving. Let the user review and adjust the mapping before creating structured,
validated metadata. This is the larger signature demo feature.

### 2. Show Example Metadata

Add a “Show example” action that fills a template with clearly labeled synthetic example
metadata. Demonstrate controlled terms, repeated elements and required fields so an unfamiliar
template becomes understandable in seconds. Pair this with the preview’s “Try out” action.

### 3. Explore Where an Artifact Is Used

Show which templates reuse a selected element or field, then which instances were created from
those templates. Let users click through these relationships to discover reusable content and
understand how artifacts connect beyond their folder locations.

### 4. Compare Templates Visually

Let users select two templates and inspect their shared structure, differences and reused
elements side by side. Support choosing a template to adopt and understanding what changed
between revisions.

## Workspace and Browser Workflows

### 5. Retire `CEDAR_VERSION_MODIFIER` Cache Busting

A deployment should never need a hand-edited modifier to make a new code revision visible.
Decide whether any cached asset can legitimately differ while its source commit stays fixed. If
none can, remove the variable from Workspace's build tooling, the Template Editor's Gulp build,
the Template Designer's host script, the native build-info writer, the three Docker build entrypoints and the
microservices Compose file. Otherwise keep a narrowly named override and add a test proving the
same-commit case it serves. Remove the step that chooses a modifier from the production
deployment runbook either way.

Extend the cache-delivery smoke to check immutable hashed assets and revalidating fallbacks, to
compare every served build identity against the accepted commit, and to open, modify, save,
reload and save an existing instance, so that the GET ETag and the subsequent `If-Match` update
are exercised. Add the canonical nginx policy for the Workspace and Template Designer origins to
the staging mirror.

Make the production transition once, deliberately. Rehearse it in staging, clear or freeze the
old modifier, rebuild every frontend from recorded commits, deploy the canonical nginx policy,
and purge entry and configuration objects that may carry the former headers. Run the extended
smoke in staging and production from a browser that previously loaded the old payload. The item
is complete after two consecutive code deployments require no manual cache token and rollback
works by restoring payloads and routing without inventing a new modifier.

<a id="doi-minting-recovery"></a>

### 6. Make DOI Minting Recovery-Safe

Keep the DataCite wizard out of Workspace resource menus while this workflow is being
reworked. Before reintroducing an entry point, verify the recovery behavior and review the
wizard's user-facing flow.

A retry after a timeout must be able to tell whether the earlier attempt minted a DOI. Define
durable draft/reserved, published and locally attached states in `cedar-bridge-server`, retain
the DataCite identifier before the fallible write-back, and make a retry resume or reconcile the
same DOI rather than orphan or duplicate one. Give the `reconciliationRequired` response a code
path that resolves it.

Associate an existing draft with its source artifact directly rather than by matching DataCite
records on the OpenView URL. Move orchestration, configuration and error mapping out of
`DataCiteResource`. Add offline tests for create versus update, retry after timeout and repeated
publish. Extend the opt-in `datacite`-tagged test, or add a sandbox smoke beside it, to cover the
full mint and attach contract and the credential check.

Establish how historical document/graph DOI disagreements arose; do not assume they prove a
minting timeout. Extend offline regression coverage to ordinary unchanged-DOI updates after
reconciliation and continued rejection of DOI replacement or deletion through ordinary updates.
The verified recovery procedure is in the [backend runbook](BACKEND-RUNBOOK.md#recovering-an-existing-doi-attachment).

<a id="cee"></a>

## Embeddable Editor and Model Library

### 7. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 8. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in the Template Editor's rich-text `Source` mode and
CED's markup input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

### 9. Reduce Embedded Font Payload

CEE, CED and the term picker all resolve one font source,
`@org.metadatacenter/cedar-design-tokens/fonts`, so the Roboto question is a single edit that
reaches three components. The source defines seven unicode-range subsets at three weights, 21
faces in all. CEE's standalone bundle and the term picker embed all 21, CED embeds the 14 at
weights 400 and 500, and CEE's host-fonts bundle embeds none. Decoded sizes measured on
2026-09-17:

| subset | 300 | 400 | 500 | all three |
| --- | ---: | ---: | ---: | ---: |
| latin | 11,160 | 11,028 | 11,073 | 33,261 |
| cyrillic-ext | 10,413 | 10,353 | 10,353 | 31,119 |
| latin-ext | 7,842 | 7,737 | 7,677 | 23,256 |
| cyrillic | 6,480 | 6,462 | 6,633 | 19,575 |
| greek | 4,929 | 4,866 | 4,797 | 14,592 |
| vietnamese | 3,450 | 3,498 | 3,474 | 10,422 |
| greek-ext | 756 | 750 | 768 | 2,274 |

latin and latin-ext together are 56,517 of the 134,499 bytes, so dropping the other five subsets
would save 77,982 bytes where all three weights ship and 51,954 in CED, about 58% of the font
payload in each case. Decide whether the components must render Cyrillic, Greek and Vietnamese,
remembering that cyrillic-ext is the second-largest subset; latin-ext stays for Hungarian.
Decide the fallback explicitly rather than by accident. The shipped stack is
`CEE Roboto, Helvetica Neue, sans-serif`, so a dropped script would land on the host's
sans-serif. Re-measure gzip on the production bundles rather than assuming the decoded figure.

Make the tokens package's emitted-CSS test assert which subsets or unicode ranges are present,
not only how many faces there are, so a dropped subset cannot return unnoticed. Rename the
shared family from `CEE Roboto` in the same pass, coordinated across the three components'
stylesheets. Preserve namespaced font faces and the single-artifact embedding contract, since
serving fonts as extra files changes that contract.

CEE's RDF downloads added 57,019 gzip bytes to its standard bundle, which dropping the five subsets
would more than offset.

### 10. Retire the Shared Monospace Face

`font-family-monospace` is the only font role without an embedded face. It resolves to SF Mono or
Menlo on a Mac and to the browser's generic monospace elsewhere, so the same string draws
differently on each platform. Monitoring reads it for log lines, configuration values, its matrices
and every `code` element. Outside Monitoring, the uses are scattered:

- the term picker's term IRIs, in its selection bar and its term details, and its release hashes, in
  the release list and the constraint table
- `code` in CED's CEE preview, and CED's development status bar
- the identifier, example and API key on Workspace's profile page
- field values on CEE's demo page

Set these in the body font. The term picker gives its IRI line a 1.5 line height because a monospace
face needed the taller box, so revisit that height with Roboto. Where digits in a column must line
up, `font-variant-numeric: tabular-nums` can align them, provided the embedded faces keep Roboto's
tabular figures.

Monitoring is then the token's only reader, which the two-reader rule refuses. Decide whether its
logs and values also take the body font, or whether Monitoring keeps a monospace stack of its own.
The second needs the source check and the rendered surface check, which accept only the
vocabulary's families, to allow one family a host owns. Either way, retire the token, name its
replacement in `tools/retired-tokens.json`, and reduce the rendered check's `font-family` scale to
the body font.

<a id="ced"></a>

### 11. Clear the Ember Demo's Remaining Advisories

The Ember CEE demo's lock still carries GHSA-vfj7-8cjw-p6xm, a denial of service in `braces`,
which reaches it through ember-cli, stylelint and ember-template-lint, and no released `braces`
fixes. Every other lock outside the legacy Template Editor audits clean, and nothing the demo ships
contains `braces`. When a fixed `braces` is published, refresh the demo's lock, run its lint, tests
and build, and record the baselines. If none is, decide whether the demo needs stylelint and
ember-template-lint, knowing that ember-cli would still bring `braces` without them.

## CED

Design Basic, Semantic and Modular as interfaces suited to their audiences.
Together they must cover its authoring capabilities. Keep CED responsible for
editing, rendering, local validation and host-facing UI contracts. The embedding
host owns storage, authentication, permissions, server validation requests,
publishing, version allocation and provenance.

### 12. Display Host-Supplied Validation Findings in CED

Add an input for findings supplied by the embedding host. Map artifact paths to nodes and
settings, show the messages beside the affected controls and in CED's validation summary, and
give host findings a source of their own so they remain distinguishable from CED's model and
draft findings.

Specify when host findings become stale after an edit or artifact replacement. Preserve unsaved
input and cover correction, clearing and replacement of reports. The host calls the schema
server and decides whether an artifact may be saved.

### 13. Define the Three Profiles

Basic, Semantic and Modular are the product structure, and each should be a distinct interface
with its own field types, constraint editors and guidance. Replace the presets that carry their
names, which only toggle visibility and hide field types, with profile definitions decided per
field type and per control rather than by one boolean apiece.

Decide what belongs in each profile. Reconsider whether Basic should offer Attribute Value,
which asks an author to describe fields whose names a form-filler will supply later, and the
seven external authority types. Reconsider whether it should hide Field Help Text, which the
Basic profile's own mockup shows, and whether it should show the whole parameter surface of
every type it offers. Carry any behavior a profile owns, such as hiding the element and import
insertion actions in Basic, in the profile definition rather than in a check that lapses once a
preference changes. Remove preferences that control nothing.

Decide what a profile may change: visibility alone, or the editors and the guidance with it.
Moving between profiles has to leave the template intact, which is what makes this question
hard. A template authored in Modular and opened in Basic still contains everything Basic does
not show. Every control on a card is a decision this item has to absorb.

### 14. Add Host Restrictions and Preferences to the CED Embedding Contract

Add read-only mode, language and allowed field types to the designer element. Host
restrictions bound what the author may edit or select; profile and preference settings can
narrow those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies preference state and how CED reports changes to it; the host
chooses where and how to store that state. CED must never allocate identities or versions when
the host replaces the artifact or supplies an editable draft.

Add conformance and browser tests for these inputs and events, including read-only published
content and the transition to a host-supplied editable document.

### 15. Keyboard and Screen-Reader Access

Verify keyboard focus order across settings, palette actions and nested elements. Add
live-region announcements for constraint changes, accepted or rejected local Apply actions and
host-supplied validation results. Exercise those workflows with a screen reader and verify that
focus returns to a useful control after each action.

### 16. Complete the Template Designer

Replace the inert surface that the Template Designer shows for an artifact that is not writable
with the designer element's read-only contract, once the embedding contract item provides one, so
that inspection, navigation and preview remain available.

Decide whether Workspace and the Template Designer need Update Bubbling. When an element that
templates include is saved, the Template Editor offers to write the change into each including
draft template, and `inclusion-bubbling-smoke.mjs` covers that offer. Neither Workspace nor the
Template Designer offers it. If they need it, add it to the Template Designer and carry the smoke's
cases, including the refusal of a published target, into `smoke:workspace:modern:full`.

### 17. Enforce CED Authoring Style Contracts

Apply central authoring recipes and rendered contracts across every field and
element settings surface, including metadata labels, select-arrow clearance and
controlled-term default rows. Extend coverage beyond the annotation entry row. Test
the approved font weights and upright labels, compact row spacing, final table
border and empty/populated alignment across standalone fields, nested fields and
elements, all settings tabs, desktop and narrow widths, real CEF and host overrides.
Reuse the field-type matrix rather than relying on one representative text field.

Consolidate CED's overlapping global, shared and component rules around the existing
token recipes, preserving the agreed presentation. Assign ownership for each role
and remove duplicate or unused emitted rules. Reduce the existing adoption baseline
surface by surface and keep resolved entries pruned after review; do not expand allowances
or replace values with semantically unrelated tokens to make the scanner green.

Keep validation timing, save state and default-value isolation in behavior tests;
they cannot be guaranteed by CSS tokens. The measured coverage and source ownership
are documented in the runbook's **CED token coverage audit**.
