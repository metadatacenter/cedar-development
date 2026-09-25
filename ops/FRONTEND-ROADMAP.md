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

## Workspace and Browser Workflows

### 1. Retire `CEDAR_VERSION_MODIFIER` Cache Busting

A deployment should never need a hand-edited modifier to make a new code revision visible.
Decide whether any cached asset can legitimately differ while its source commit stays fixed. If
none can, remove the variable from Workspace's build tooling, the Template Editor and Template
Designer Gulp builds, the native build-info writer, the three Docker build entrypoints and the
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

### 2. Make DOI Minting Recovery-Safe

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

Reconcile existing document/graph DOI disagreement that blocks unrelated artifact updates.
Two production templates and one instance need this recovery before their pending repairs
can be written:

| Artifact | UUID | Existing DOI |
| --- | --- | --- |
| Human Cognitive Neuroscience Data | `0e0e551b-c465-41e6-9392-75803b1b95de` | `10.60745/k2wv-x835` |
| FAIR-EuMon metadata template | `b530b495-bd45-4ba7-946c-f726b3066ba9` | `10.60745/ng90-tp91` |
| HEAL study instance, 10453929 – Development of therapeutic antibodies | `44685302-6d30-41fa-b129-6875fb887912` | `10.82658/aqdn-5e14` |

Their `PUT ?verbatim=true` requests preserve the stored document's DOI but receive HTTP 400
`doiCanNotBeAltered`, with that DOI in `doiInRequest` and `storedDoi: null`.
`AbstractResourceServerResource` compares the request against `folderServerOldResource.getDOI()`,
so the document and folder/graph metadata disagree. Establish how that disagreement arose;
do not assume it proves a minting timeout. Provide a verified reconciliation path that preserves
the existing DOI, restores its attachment consistently, and makes an unrelated update succeed.
Do not remove the DOI or bypass DOI immutability to unblock the repair.

Add regression coverage for a document DOI with missing graph metadata, interrupted attachment
and retry, successful unchanged-DOI updates after reconciliation, and continued rejection of DOI
replacement or deletion through ordinary updates. Recheck the two templates and their dependent
instances before retrying the pending schema patches. The HEAL instance needs only its stray
`_annotations/@id` removed while retaining the DOI annotation; the attempted conditional write
was rejected with the same unchanged-DOI error. Its template also needs to permit optional instance
annotations. Evidence is in `.cedar/repairs/2026-09-25-stray-annotation-id/`. The write-rejection evidence is retained in
`.cedar/repairs/2026-09-25-context-additional/apply-summary.json` under the local CEDAR root.

### 3. Show Server Validation Findings in Workspace

A rejected create or update should show the user what the server refused. Render the problems
in the server's `validationReport` with their paths and messages in Workspace's metadata editor,
keep the document dirty, and provide navigation to the affected field across pages and repeated
elements where possible. State the validation summary and the missing-required-field message
through Workspace's language files, in English and Hungarian.

Establish which CEE findings predict REST rejection and which are advisory, and gate Save only on
the former. The `requiredValue: true` / `minItems: 0` case in CEE's
`harness/test/report-shape.spec.ts` shows that the two verdicts can differ. Treat the server's
response as authoritative when the validators disagree or the template changes between edit and
save.

Cover invalid-to-valid and valid-to-invalid transitions, advisory-only reports, rejected
creates and updates, correction followed by a successful save, and differing client and server
reports, in `src/app/metadata-editor.spec.ts` and the Playwright interaction suite.

<a id="cee"></a>

## Embeddable Editor and Model Library

### 4. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 5. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in the Template Editor's rich-text `Source` mode and
CED's markup input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

### 6. Reduce Embedded Font Payload

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

<a id="ced"></a>

## CED

Design Basic, Semantic and Modular as interfaces suited to their audiences.
Together they must cover its authoring capabilities. Keep CED responsible for
editing, rendering, local validation and host-facing UI contracts. The embedding
host owns storage, authentication, permissions, server validation requests,
publishing, version allocation and provenance.

### 7. Display Host-Supplied Validation Findings in CED

Add an input for findings supplied by the embedding host. Map artifact paths to nodes and
settings, show the messages beside the affected controls and in CED's validation summary, and
give host findings a source of their own so they remain distinguishable from CED's model and
draft findings.

Specify when host findings become stale after an edit or artifact replacement. Preserve unsaved
input and cover correction, clearing and replacement of reports. The host calls the schema
server and decides whether an artifact may be saved.

### 8. Define the Three Profiles

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

### 9. Add Host Restrictions and Preferences to the CED Embedding Contract

Add read-only mode, language and allowed field types to the designer element. Host
restrictions bound what the author may edit or select; profile and preference settings can
narrow those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies preference state and how CED reports changes to it; the host
chooses where and how to store that state. CED must never allocate identities or versions when
the host replaces the artifact or supplies an editable draft.

Add conformance and browser tests for these inputs and events, including read-only published
content and the transition to a host-supplied editable document.

### 10. Keyboard and Screen-Reader Access

Verify keyboard focus order across settings, palette actions and nested elements. Add
live-region announcements for constraint changes, accepted or rejected local Apply actions and
host-supplied validation results. Exercise those workflows with a screen reader and verify that
focus returns to a useful control after each action.

### 11. Complete the Template Designer

Replace the inert surface that the Template Designer shows for an artifact that is not writable
with the designer element's read-only contract, once the embedding contract item provides one, so
that inspection, navigation and preview remain available.

Decide whether Workspace and the Template Designer need Update Bubbling. When an element that
templates include is saved, the Template Editor offers to write the change into each including
draft template, and `inclusion-bubbling-smoke.mjs` covers that offer. Neither Workspace nor the
Template Designer offers it. If they need it, add it to the Template Designer and carry the smoke's
cases, including the refusal of a published target, into `smoke:workspace:modern:full`.
