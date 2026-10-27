# CEDAR Frontend — Roadmap

Open work for the Workspace, the Template Designer, the Template Editor, OpenView,
Monitoring, Bridging, the embeddable editor (CEE/CEF), the embeddable designer (CED), and
their TypeScript model library. This roadmap also owns browser workflows whose completion
spans a frontend and its supporting service.

See [FRONTEND-RUNBOOK.md](FRONTEND-RUNBOOK.md) for operating procedures and
[BACKEND-ROADMAP.md](BACKEND-ROADMAP.md) for backend work outside browser workflows.
Term-picker and terminology-versioning work remains in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md).

Item numbers are contiguous across the document and change as work leaves it.
Refer to the concrete change by name in commits.

## Reusable Artifact Versions

<a id="pull-version-management"></a>

### 1. Complete Pull-Based Reusable Artifact Version Management

- **Richer compatibility proofs and impact.** Recognize safe schema widenings beyond
  validation-shape equality. Assess the actual invalidated record count when schemas
  differ, including records the author cannot read, without exposing their content.
  Keep universal compatibility, stored-instance impact and semantic changes distinct.
  Extend final-write protection to permit proven safe widenings without weakening its
  concurrency fence. The existing `check-update-template` delta is not a universal proof.
- **Continuing reusable drafts and recovery across tabs.** Make continuing work on a
  saved reusable draft possible without silently turning the embedded copy into a mutable
  link. Define retrieval of confirmed but unattached results after the original tab closes,
  and deliberate cleanup of reusable artifacts whose parent edits were discarded.
- **Source revisions and descendant identity.** Record which revision of a mutable draft
  was copied, with a retrievable baseline if future comparison requires it. Resolve the
  identity scope of editable inline descendants before changing detachment: retaining
  their identifiers can leave different definitions under the same identifier. Preserve
  published descendant references and parent property IRIs. Do not rewrite stored
  published artifacts or infer provenance for legacy copies.
- **Version families and candidate choice.** Resolve a stable version family across
  releases and deletion so duplicate uses at different versions can be recognized.
  Distinguish the latest readable published release from a globally latest release. Agree
  the interaction for selecting an older or latest compatible release, and for reviewing
  meaningful changes and local divergence, before adding controls.
- **Existing reuse and retirement of bubbling.** Inventory older embedded drafts with
  shared stored identifiers and missing derivation. Agree an honest unknown-origin state
  and a deliberate association workflow. Add a read-permission-filtered usage endpoint;
  retire the legacy editor's bubbling UI and REST mutation/preview endpoints once the
  replacement workflow and its existing-data path are usable.
- **Further journey gates.** Extend real-host matrices to permission-filtered source
  histories, source deletion during assessment, changed drafts during uncertain reusable
  creation and cross-tab outcome retrieval. Verify untouched screens separately from
  failure paths and keep exceptional controls absent without their triggering condition.

## Static Frontend Delivery

### 2. Finish Frontend Cache Delivery

A deployment should make a new code revision visible without a hand-set token, and no browser
should reuse a file that an earlier build served. Neither holds on staging or production yet.

Staging and production serve OpenView, Monitoring and Bridging with no `Cache-Control` header. A
browser then judges from a file's age how long its copy stays fresh, and can reuse an un-hashed
file for weeks without asking the server. OpenView's folder page showed raw translation keys for
this reason, because browsers held the June 2024 `en.json`. Production's Workspace, Designer and
Template Editor already answer their entry pages, deep links and `/config/` with `no-store`, but
their other stable-name files are uneven. The Template Editor's stylesheets revalidate, while the
Designer's scripts and every origin's `favicon.ico` carry no header, and so does the Template
Editor's `/config/build-info.json`.

The canonical policy is in the `os-mirror` vhosts, with
`staging-centos/etc/nginx/sites-enabled/frontend-openview.inc.conf` as the model. Until 2026-10-07
every mirrored copy failed `nginx -t`, so it could not have been installed. The staging mirror has
no vhost for Workspace or the Designer yet; add both.

`CEDAR_VERSION_MODIFIER` exists to tell apart two builds of one source commit, and no cached file
needs it. Every file whose bytes depend on the deployment is written under `app/config/` and served
from `/config/` with `no-store`, and the Template Editor's and Workspace's cache keys already contain
the source commit. Production still sets one. Release 2.9.29 carries `-2026-10-03-1`, the
modifier chosen for 2.9.23. Once every stable-name
file revalidates, remove it from Workspace's build tooling, the Template Editor's Gulp build, the
Designer's host script, the native build-info writer, the three Docker build entrypoints, the
microservices Compose file, the config library's environment descriptor and `CedarBuildInfo`,
Monitoring's deploy matrix, every repository's CI environment block, and the production runbook's
step that chooses a modifier. Workspace's Settings page loses its "Version modifier" row with it,
as agreed on 2026-10-07. Operators read a build's source commit from `/config/build-info.json` and
from Monitoring's deploy matrix.

Apply the policy on staging (`cedr-stg-app-03`) first, then on production (`cedr-prd-app-05`), to
each frontend vhost, as root:

1. Find the vhost with `grep -l -E "openview|monitoring|bridging|workspace|designer|cedar" /etc/nginx/sites-enabled/*`.
   If `grep -il puppet <vhost>` finds Puppet's marker, make the change in Puppet, or the next agent
   run reverts it. alexskr edits these vhosts, so let alexskr know.
2. Back the file up outside `sites-enabled`, for example to `/root/`. nginx may load every file in
   that directory, so a copy there becomes a second server block.
3. List existing headers with `grep -rn add_header /etc/nginx/nginx.conf /etc/nginx/conf.d <vhost>`.
   An `add_header` in a `location` replaces the ones it would inherit, so repeat any `http`- or
   `server`-level header, such as HSTS, inside each new location.
4. In the HTTPS `server` block, add these locations above `location / {`:

   ```nginx
   location = /index.html { add_header Cache-Control "no-store" always; }
   location ^~ /config/ {
       add_header Cache-Control "no-store" always;
       try_files $uri =404;
   }
   # esbuild names a hashed file name-XXXXXXXX.js, the hash being eight upper-case base32 characters.
   location ~ "-[A-Z2-7]{8}\.(js|css)$" {
       add_header Cache-Control "public, max-age=31536000, immutable" always;
       try_files $uri =404;
   }
   ```

   Then add `add_header Cache-Control "no-cache" always;` as the first line of the existing
   `location / {` block, and keep the rest of it. The quotes around the regular expression are
   required. `=404` keeps a request for a deleted bundle from receiving `index.html`, which the
   browser would otherwise cache for a year under the bundle's name. The hashed-bundle location
   matches only files a build names `name-XXXXXXXX.js`, so it changes nothing on an origin that
   has none.
5. Run `nginx -t`, and reload with `systemctl reload nginx` only if it passes.
6. Check the headers. On every origin, the entry page and a deep link must answer `no-store`,
   stable-name files `no-cache`, and hashed bundles `immutable`. For OpenView:

   ```bash
   H=https://openview.staging.metadatacenter.org; for p in /index.html /folders/x /assets/img/logo/cedar-open-view-logo.png /node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js "/$(curl -s $H/index.html | grep -o 'main-[A-Z0-9]*\.js')"; do echo "$p: $(curl -sI "$H$p" | grep -i '^cache-control')"; done
   ```

Production OpenView, Monitoring and Bridging sit behind Cloudflare, which adds `max-age=14400` to
JavaScript and caches static files at its edge. After the reload, purge
`openview.metadatacenter.org`, `monitoring.metadatacenter.org` and `bridging.metadatacenter.org`
there. If the CEE bundle that OpenView and Bridging serve still carries `max-age=14400`, set
Cloudflare's Browser Cache TTL to "Respect Existing Headers".

Extend the cache-delivery smoke to check immutable hashed assets and revalidating fallbacks, to
compare every served build identity against the accepted commit, and to open, modify, save,
reload and save an existing instance, so that the GET ETag and the subsequent `If-Match` update
are exercised. Run it on staging and then production from a browser that previously loaded the
old payload, after rebuilding every frontend from recorded commits.

The item is complete when both hosts pass the header check on every frontend origin, two
consecutive code deployments need no modifier, and a rollback works by restoring payloads and
routing without inventing one.

## Workspace and Browser Workflows

<a id="doi-minting-recovery"></a>

### 3. Make DOI Minting Recovery-Safe

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
`DataCiteResource`. Add offline tests for retry after timeout and repeated publish. The opt-in
`datacite`-tagged test cannot pass as written, because its positive cases name source artifacts
that no resource server holds. Rework it, or replace it with a sandbox smoke, to cover the full
mint and attach contract and the credential check.

Establish how historical document/graph DOI disagreements arose; do not assume they prove a
minting timeout. Extend offline regression coverage to ordinary unchanged-DOI updates after
reconciliation and continued rejection of DOI replacement or deletion through ordinary updates.
The verified recovery procedure is in the [backend runbook](BACKEND-RUNBOOK.md#recovering-an-existing-doi-attachment).

<a id="save-recovery"></a>

### 4. Recover Failed Saves Without Losing Work in Designer and Editor

Complete the recovery routes that still cannot resume saving or create a permitted copy:

Follow the product-design checkpoints in [AGENTS.md](../AGENTS.md#preserve-the-agreed-product-design).
Reliability work does not authorize new permanent controls: recovery actions must be conditional
on an actual failure or retained unfinished work, and new UI requires agreement before implementation.

- **Designer conflicts:** fetch the latest schema separately from the working draft and
  provide review and reconciliation for templates, elements and fields, including unknown
  content, server normalization and intervening writes; never attach its ETag to an
  unreconciled draft.
- **Changed metadata templates:** reconcile retained metadata against a changed template
  through an explicit migration workflow, preserving unfinished input and unsupported values.
- **Permitted copies:** recover retained work to another folder when the original artifact is
  inaccessible or deleted, checking destination permissions without silently recreating the
  original or mistaking a permission refusal for deletion.
- **Recovery validation:** extend live coverage to additional invalid control shapes and newer edits
  during recovery; include schema normalization and unresolved version operations.

Keep status checks, access checks, review and explicit discard distinct. A failed recovery
read must preserve current input. See the [frontend runbook](FRONTEND-RUNBOOK.md) for the
current draft-retention contract and operator verification commands.

### 5. Fix Workspace's WCAG Failures

The [conformance report](FRONTEND-RUNBOOK.md#accessibility-conformance) found three WCAG 2.2
criteria that Workspace fails. Workspace meets four more only in part: 1.3.1, 3.3.4, 4.1.2 and
4.1.3. Agree the fixes marked as visible before making them.

- **A Save that refuses without saying so (2.1.1).** Visible. While CEE's validation is still
  running, the metadata editor's Save looks enabled, ignores clicks and explains itself only in a
  hover tooltip. Marking it `aria-disabled`, as Save is when errors refuse it, would dim it.
- **Text spacing in grid cards (1.4.12).** Visible. Under WCAG's text spacing a grid card's type
  and date line, such as "Template · 1 day ago", ends in an ellipsis. The line needs to wrap and the
  card to grow, through the token package's resource-card recipe, which also changes cards that are
  cut today.
- **Selection as a state (1.3.1, 4.1.2).** A selected row is described as Selected, because a plain
  table's rows take no `aria-selected`. Stating it as a state needs a grid and its arrow-key model,
  which is a keyboard design decision.
- **Menus that stay open (2.4.3).** Visible. The resource menu and the user, actions and New
  menus stay open when Tab moves focus out of them. Decide whether they close when focus leaves.
- **Removing access (3.3.4).** Visible. Removing a person's access or a group member saves at once,
  with no confirmation or undo. Decide whether it needs either.
- **Messages that arrive already written (4.1.3).** The metadata editor's review panel is a live
  region inserted together with its explanation and comparison table, so a screen reader may not
  announce it. Decide what the panel should announce before giving it a region that is present
  first. A notice identical to the one before it shows and says nothing, because the notice is
  never cleared, and fixing that is visible.

<a id="cee"></a>

## Embeddable Editor and Model Library

### 6. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 7. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in the Template Editor's rich-text `Source` mode and
CED's markup input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

### 8. Remove the Temporary Vite Security Override When Angular Catches Up

Remove the `vite: 8.3.4` overrides from the Angular projects once a supported stable
`@angular/build` selects a patched Vite itself. Version 22.2.4 still requires Vite 8.3.0;
the affected 8.3 line is fixed from 8.3.3. Keep CEE's domain harness aligned with the
root project. Re-resolve the locks, inspect the advisory identities and run the frontend
reactor and all three consumer demos before removing the overrides.

### 9. Fix CEE's WCAG Failures

The [conformance report](FRONTEND-RUNBOOK.md#accessibility-conformance) found seven WCAG 2.2
criteria that CEE fails. CEE meets one more, 3.1.2, only in part. Agree the fixes marked as visible
before making them.

- **Element descriptions on hover only (2.1.1).** Visible. An element's description and property
  IRI marks sit inside its panel header, which is a button, so they cannot take focus, and only a
  pointer shows their tooltips. Either the marks move out of the header or the header shows the
  tooltip when it takes focus.
- **Notices that vanish (2.2.1).** Visible. The notices that an entry was cleared or reverted
  disappear after five seconds, and nothing keeps them.
- **Severity by colour (1.4.1).** Visible. Range and quality warnings differ from errors only by
  amber against red.
- **The link-out icon (2.5.8).** Visible. At 480px a read-only term's 20px link-out icon touches its
  IRI link. It needs a 24px target or a 4px gap. `visual/tests/accessibility.spec.ts` records it as
  a known violation.
- **Instructions cut short (1.4.10).** Visible. At 320px the PubMed and RRID boxes' placeholders
  need about 271 and 276px and get 264px, so their last letters are cut. They need a shorter
  instruction, or the instruction moved into hint text that wraps.
  `visual/tests/layout-resilience.spec.ts` records it as an exception.
- **Read-only values cut short (1.4.4, 1.4.10, 1.4.12).** Visible. A long text, email or phone
  value in a read-only box is cut at the box's edge with nothing to show that more follows. At 320px
  all three are cut, and at 200% zoom and under text spacing the text value is. The value needs to
  wrap onto further lines, as a paragraph value does. `visual/tests/layout-resilience.spec.ts`
  records it as an exception.
- **Box names in the wrong language (3.1.2).** The text, email, phone, link, numeric,
  controlled-term and authority boxes, and the read-only temporal and select boxes, take the field's
  label as their `aria-label`, so the label is read in the value's language or CEE's. The term link
  group's name has the same fault. Naming each from a hidden label marked with the template's
  language, as the editable temporal boxes now are, changes nothing visible. Decide first whether
  that fits the rule that a box carries its value's language and never the template's.

## Frontend Dependencies

### 10. Take the Frontend Dependency Upgrades That Need Code Changes

Each dependency below has a newer major release that a lock update cannot take. Some wait on an
upstream release, some need code changes, and one needs a design decision. The versions are the
newest that `npm outdated` reported on 2026-10-19, after every in-range update had been taken.

**Waiting on upstream.**

- **TypeScript 7.** Angular 22's compiler accepts only `>=6.0 <6.1`, so TypeScript moves when an
  Angular release accepts 7.
- **`@types/node` 26.** The types follow the runtime's major, and every project runs Node 24.
- **ESLint 10 and Babel 8 in the Ember demo.** The two move together. The demo's lint
  configuration parses JavaScript with `@babel/eslint-parser`, whose 7.x releases accept nothing
  newer than ESLint 9 and whose 8.x releases require `@babel/core` 8. The newest releases of
  ember-cli-babel (8.3.2), `@rollup/plugin-babel` (7.1.0) and Embroider's core and compat packages
  accept only Babel 7, so both upgrades wait until those accept Babel 8.

**Needing code changes.**

- **Vitest 5.** `@angular/build` 22.2.4 already accepts it. CEE's root and its domain harness must
  move together, because the harness runs on the root's worker, and the harness's `oxc` transform
  settings need checking against Vitest 5's Vite, since the previous major broke them. The other
  Vitest projects are CED, CETP, Workspace, OpenView, Bridging, Monitoring and the Angular and
  React demos. OpenView, Bridging and Monitoring also move `@vitest/browser-playwright` with it.
- **ngx-translate 18** in OpenView, Bridging and Monitoring. It removes `TranslateModule`, so each
  application's module-based setup moves to the provider functions.
- **keycloak-angular 22 and keycloak-js 26** in Bridging and Monitoring. The adapter's major
  follows the Keycloak server, so these move with "Upgrade Keycloak to a supported release" in
  [BACKEND-ROADMAP.md](BACKEND-ROADMAP.md).

**Needing a design decision.**

- **lucide-static 1.59** in the design tokens, which pin 1.47.0 exactly. A newer release can
  redraw icons that every consumer shows, so the move needs its rendered differences reviewed and
  approved like any other visual change.

## Accessibility Across Components

Four items hold the open accessibility work: "Fix Workspace's WCAG Failures", "Fix CEE's WCAG
Failures", and CED's "Keyboard and Screen-Reader Access" and "Fix CED's Remaining WCAG Failures".
The term picker's three are on the
[versioning roadmap](VERSIONING-ROADMAP.md). Every open piece waits on a decision about a visible
change or a design, except the screen-reader runs, which wait on a person. In order of effort,
least first, the pieces are:

- where focus goes when Escape hides a focused insertion action in CED;
- whether Workspace's menus close when focus leaves them;
- marking Workspace's Save `aria-disabled` while CEE validates, which dims it;
- clearing Workspace's notice, so that an identical one is seen and announced;
- what Workspace's metadata review panel announces when it appears;
- 24px targets for CEE's link-out icon and CED's field settings toggle;
- shorter PubMed and RRID instructions in CEE, or hint text that wraps;
- naming CEE's text-like boxes from a hidden label in the template's language;
- keeping CEE's cleared and reverted notices until they are dismissed;
- a cue beyond colour for CEE's warnings;
- labels that stay in CED's field-name, option and library-search boxes;
- a keyboard route to CEE's element descriptions and property IRI marks;
- wrapping CEE's long read-only values;
- wrapping Workspace's grid card lines under text spacing, through the shared card recipe;
- a confirmation or an undo for removing access in Workspace;
- a keyboard route for CED's sidebar divider, after its Tab order is agreed;
- CED's sidebar split, which fails no criterion but hides the library's last button;
- the term picker's result tabs as one Tab stop;
- a keyboard route for CED's sidebar field list, as buttons or a listbox;
- CED's screen-reader runs with VoiceOver and NVDA;
- selection in Workspace's listing as a state, through a grid;
- semantics for CED's child picker results;
- semantics for the term picker's result list, and larger release buttons;
- the term picker's remaining target and layout failures;
- CED's layout below 768px;
- a click-only alternative to dragging in CED's canvas, Overview, child picker and sidebar.

When a piece's work leaves the item that holds it, remove the piece from this list.

<a id="ced"></a>

## CED

Keep CED responsible for editing, rendering, local validation and host-facing UI
contracts. The embedding host owns storage, authentication, permissions, server
validation requests, publishing, version allocation and provenance.

### 11. Add Host Restrictions and Preferences to the CED Embedding Contract

Add read-only mode, language and allowed field types to the designer element. Host
restrictions bound what the author may edit or select; profile and preference settings can
narrow those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies preference state and how CED reports changes to it; the host
chooses where and how to store that state. CED must never allocate identities or versions when
the host replaces the artifact or supplies an editable draft.

Add conformance and browser tests for these inputs and events, including read-only published
content and the transition to a host-supplied editable document.

### 12. Keyboard and Screen-Reader Access

Two parts of CED's keyboard and screen-reader access remain open. One needs a person with a
screen reader, and the other needs a design decision before it can be built.

**Screen readers.** Run the [screen-reader protocol](FRONTEND-RUNBOOK.md#ced-screen-reader-protocol)
with VoiceOver and Safari and with NVDA and Firefox, and fix what it finds. The browser suite
cannot tell whether a screen reader speaks the live region's messages, in what order, or
whether one interrupts another.

**The sidebar's field list.** Each entry in the sidebar's list of the template's fields opens
the container that holds its field, selects the field and scrolls to it. Only a click does
this. The entry, `.draggable-field-item` in `field-library-sidebar.component.html`, has no
`tabindex` and no key handler, so a keyboard cannot reach it. Dragging an entry reorders the fields, and the Overview
already offers that by keyboard. Going straight to a field has no keyboard route. A keyboard can
reach each field on the canvas, but only by moving through the cards before it, which the list
lets a pointer skip.

Two designs fit. A button per entry adds one Tab stop per field, which in a long template puts
the canvas many stops away. A listbox adds a single Tab stop, and the arrow keys move within
it. Decide as well whether choosing an entry moves focus to the card it selects. Agree the
resulting Tab order before changing it, then pin it in `keyboard-order.spec.ts` and pin where
focus lands in `focus-return.spec.ts`. The entry's line disables two of the template
accessibility lint rules until this is done. Remove that exception in the same change.

### 13. Fix CED's Remaining WCAG Failures

The [conformance report](FRONTEND-RUNBOOK.md#accessibility-conformance) found these failures in
CED beyond the ones it shares with the other components. Several need a design decision first.

- **Narrow widths (1.4.4, 1.4.10, 2.1.1).** Visible. Below 768px of width the designer hides the
  Overview (`app.component.scss`), and with it outline navigation, Expand all and Collapse all, and
  the only keyboard route for reordering, so it is gone at 200% zoom as well. At 320px the
  Preferences field-type list scrolls sideways by 8px, and the Define Presets body scrolls sideways.
  The template's Types row pushes Enter IRI manually past the card's edge and sets "No types
  selected." one letter to a line, already at 375px. `browser/tests/layout-resilience.spec.ts`
  records each as an exception. Decide how a narrow host lays these out.
- **Dragging (2.1.1, 2.5.7).** Reordering on the canvas, in the Overview, in the child picker and
  in the sidebar, and resizing the Overview, all need a drag or the arrow keys. WCAG 2.2 asks for a
  route that needs only single clicks, such as Move up and Move down buttons, which is new UI to
  agree first. The sidebar's divider between its field list and the panel below needs a drag alone:
  it has no keyboard route and no `separator` role. The Overview's resize separator is the pattern
  to follow.
- **Focus on a hidden action (2.4.7).** When Escape hides an insertion action that has keyboard
  focus, focus stays on a control nobody can see, as it already did when a keyboard press on one
  opened the palette. Decide where focus goes, or whether a focused action stays shown.
- **Field settings toggles (2.5.8).** Visible. A field card's settings toggle is 36 by 14px, and the
  field header beside it, which opens the same settings, is 23px tall, a pixel short of WCAG's 24.
  The settings panel's last control also sits within 12px of the toggle's centre. Either the toggle
  or the header needs 24px. `browser/tests/accessibility.spec.ts` records it under `EXCEPTIONS`.
- **The child picker's results (1.3.1, 4.1.2).** Its result rows act on a click but are plain table
  rows, whose selected state Chromium ignores. A grid needs an arrow-key model, a list of buttons is
  a redesign, and a visually hidden button in each row disturbs the scroller. Decide which. The
  smokes find a row by its name, Select and the artifact's name, which any choice must keep.
- **Labels that vanish (3.3.2).** Visible. The field-name and option boxes and the library search
  are labelled only by placeholders, which disappear once the box holds text. They need labels
  that stay.

The sidebar's divider also shows a layout defect that fails no WCAG criterion. Its shares leave out
the roughly 72px of insertion actions above the field list, so the sections below can overrun the
sidebar by about 78px, which `.main-content` clips. A pointer then cannot reach the library's last
button. Keyboard focus scrolls it into view, but that puts the Add field and Import row out of
reach above. Adding fields from the sidebar causes this with 15 fields at the default share, before
any drag. Fixing it changes the default layout, so agree it first.

### 14. Consider Work Preservation and Bug Reporting for Unexpected Validation Failures

Evaluate a fallback for a document CED considers saveable but the server rejects for a
structural problem the author cannot repair through Designer controls. Treat this as a possible
generation or validation defect: CED must produce valid artifacts, and server validation must
remain strict. An injected server finding tests the fallback; it does not establish that ordinary
editing produces invalid documents. Keep already-invalid imported artifacts a separate case.

Consider preserving the working state through the shared [save-recovery workflow](#save-recovery)
and offering a user-reviewed diagnostic download or bug report. Include the submitted document,
server validation response, component/build versions and reproduction steps where available.
Exclude credentials and let the user review artifact content before sharing it. Explain that the
failure needs investigation without asking the author to repair internal JSON Schema structures
or implying that a recovery draft has been saved as a valid artifact.

Use a real reproducible case to decide whether this facility is needed and how much to build.
Agree its interaction before implementation; this proposal does not authorize a permanent
diagnostic or recovery button, banner or file picker on ordinary editing screens.
Any confirmed defect should lead to a generation or validation fix and a regression test; verify
that the fallback preserves work while the rejected write remains blocked.
