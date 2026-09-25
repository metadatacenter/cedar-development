# CEDAR Frontend — Roadmap

Open work for the Workspace, the split Template Designer host, the Template Editor, the
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

### 3. Show Server Validation Findings in Workspace

A rejected create or update should show the user what the server refused. Render the problems
in the server's `validationReport` with their paths and messages in Workspace's metadata editor,
keep the document dirty, and provide navigation to the affected field across pages and repeated
elements where possible. Introduce a localization mechanism for Workspace and use it for the
validation summary and the missing-required-field message.

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

### 6. RDF Instance Export

Add an RDF serialization to the download contract, using a JSON-LD processor rather than a
handwritten serializer. Decide first whether the output is N-Quads or Turtle and whether
`downloadContentFor` becomes asynchronous or gains a separate asynchronous producer. Carry that
decision through the menu, filename, media type, failure handling and harness tests.

Use the TypeScript library's JSON-LD instance output as the input to the conversion. Candidate
dependencies and browser payload estimates measured on 2026-09-15 with esbuild 0.28.2, browser
target ES2022, minification and gzip level 9:

| Conversion | Dependencies | Minified JavaScript | Gzipped addition to CEE |
| --- | --- | ---: | ---: |
| JSON-LD → N-Quads | `jsonld` 9.0.0 | 120,943 bytes | 35,042 bytes |
| N-Quads → Turtle | `n3` 2.7.12 (Parser and Writer) | 80,080 bytes | 22,491 bytes |
| JSON-LD → Turtle | Both libraries | 200,487 bytes | 56,684 bytes |

These are isolated browser bundles with their dependencies and conversion wrappers; each
conversion was smoke-tested in Chromium. The gzip additions were measured by appending each
bundle to the CEE bundle of that date and recompressing the whole payload. CEE's standard bundle
measured 580,104 gzip bytes on 2026-09-23, so N-Quads would total approximately 615,146 bytes
(+6.0%) and Turtle 636,788 bytes (+9.8%), both below the 840,000-byte gzip budget. Treat these
as planning estimates, not final Angular integration measurements; remeasure the production
build with `check:size` before accepting the dependency.

Install a document loader that rejects remote context fetches, so that exporting an instance
introduces no network access beyond CEE's embedding contract. Test type coercion, nested and
repeated elements, attribute-value property IRIs and malformed contexts against a reference
processor. Coordinate with the font-payload work if the added processor exceeds the packaging
budget.

### 7. Reduce Embedded Font Payload

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

The RDF instance export item's Turtle option adds 56,684 gzip bytes to CEE, which dropping the
five subsets would more than offset, so this is worth taking first.

### 8. Localize Numeric and Temporal Validation

Replace the numeric widget's `describeNumberType` sentence and the temporal widget's validator
messages and English required-value fallback with translation keys and parameters. Decide
separately whether data-quality-report messages remain stable diagnostic text or are localized;
preserve each problem's machine-readable `code`. Check Hungarian and English for required
values, numeric type and precision failures and temporal errors, including language changes
while an error is visible.

### 9. Define Handling of Out-of-Range Stored UTC Offsets

Decide what to show and report when a host supplies offsets such as `-13:00` or `-13:45`, which
`TimezonePickerComponent.zoneForOffset` accepts but the picker does not offer. Preserve the
stored value until an explicit correction; rejecting it must not silently blank the control or
rewrite the instance. Update the tests that document the lenient behavior once the display and
validation behavior is decided.

<a id="ced"></a>

## CED

Design Basic, Semantic and Modular as interfaces suited to their audiences.
Together they must cover its authoring capabilities. Keep CED responsible for
editing, rendering, local validation and host-facing UI contracts. The embedding
host owns storage, authentication, permissions, server validation requests,
publishing, version allocation and provenance.

### 10. Display Host-Supplied Validation Findings in CED

Add an input for findings supplied by the embedding host. Map artifact paths to nodes and
settings, show the messages beside the affected controls and in CED's validation summary, and
give host findings a source of their own so they remain distinguishable from CED's model and
draft findings.

Specify when host findings become stale after an edit or artifact replacement. Preserve unsaved
input and cover correction, clearing and replacement of reports. The host calls the schema
server and decides whether an artifact may be saved.

### 11. Define the Three Profiles

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

### 12. Add Host Restrictions and Preferences to the CED Embedding Contract

Add read-only mode, language and allowed field types to the designer element. Host
restrictions bound what the author may edit or select; profile and preference settings can
narrow those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies preference state and how CED reports changes to it; the host
chooses where and how to store that state. CED must never allocate identities or versions when
the host replaces the artifact or supplies an editable draft.

Add conformance and browser tests for these inputs and events, including read-only published
content and the transition to a host-supplied editable document.

### 13. Keyboard and Screen-Reader Access

Verify keyboard focus order across settings, palette actions and nested elements. Add
live-region announcements for constraint changes, accepted or rejected local Apply actions and
host-supplied validation results. Exercise those workflows with a screen reader and verify that
focus returns to a useful control after each action.

### 14. Move the Split Host and Its Smokes onto CED

Replace the inert surface that `cedar-template-designer` shows for an artifact that is not
writable with the designer element's read-only contract, once the embedding contract item
provides one, so that inspection, navigation and preview remain available.

Migrate the full split authoring and lifecycle smoke and the inclusion-bubbling smoke from the
legacy Designer's selectors to CED. Carry over their sharing, population, terminology and
two-user coverage.
