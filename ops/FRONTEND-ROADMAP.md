# CEDAR Frontend — Roadmap

Open work for the Workspace, the Template Designer, the Template Editor, OpenView,
Monitoring, Bridging, the embeddable editor (CEE/CEF), the embeddable designer (CED), and
their TypeScript model library. This roadmap also owns browser workflows whose completion
spans a frontend and its supporting service.

See [FRONTEND-RUNBOOK.md](FRONTEND-RUNBOOK.md) for operating procedures and
[BACKEND-ROADMAP.md](BACKEND-ROADMAP.md) for backend work outside browser workflows.
Term-picker and terminology-versioning work remains in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md), apart from the picker's accessibility work, which
is grouped here with the other components'.

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

<a id="cee"></a>

## Embeddable Editor and Model Library

### 5. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 6. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in the Template Editor's rich-text `Source` mode and
CED's markup input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

## Frontend Dependencies

### 7. Take the Frontend Dependency Upgrades That Need Code Changes

No dependency below can move by a lock update alone. Some wait on an upstream release, some need
code changes, and one needs a design decision. The versions are the newest that `npm outdated`
reported on 2026-10-28, after every in-range update had been taken.

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

- **Vitest 5.** `@angular/build` 22.2.5 already accepts it. CEE's root and its domain harness must
  move together, because the harness runs on the root's worker, and the harness's `oxc` transform
  settings need checking against Vitest 5's Vite, since the previous major broke them. The other
  Vitest projects are CED, CETP, Workspace, OpenView, Bridging, Monitoring and the Angular and
  React demos. OpenView, Bridging and Monitoring also move `@vitest/browser-playwright` with it.
- **ngx-translate 18** in OpenView, Bridging and Monitoring. It removes `TranslateModule`, so each
  application's module-based setup moves to the provider functions.
- **ngx-translate 18.1** in CEE, CED, CETP and Workspace, which hold 18.0.x with a `~18.0.0`
  range. Release 18.1.0 rebuilds the service around signals. Under it, `onTranslationChange`
  fires three times rather than twice when a host names a language map after CEE has its
  template, which fails the late-language specification in the wrapper component's suite. CED's
  bundle also grows by about 4.7 KB raw and 1.7 KB compressed, past all four of its size
  ceilings. Taking it needs a decision on whether the third announcement is acceptable, and on
  whether CED's ceilings rise or something else in the bundle shrinks.
- **A replacement for `ng-alt-snotify`** in OpenView, Bridging and Monitoring. Its last release,
  17.0.0 from January 2024, declares Angular 17 as its peer, and each application forces it onto
  Angular 22 through `overrides`. No newer release exists. Monitoring uses it in 32 source files,
  OpenView in 10 and Bridging in 8. The replacement must keep the notifications' appearance and
  behavior.
- **keycloak-angular 22 and keycloak-js 26** in Bridging and Monitoring, and the adapter that
  Workspace and the Template Designer host load from `app/scripts/keycloak/`. The installed
  keycloak-angular 13.1.0 declares Angular 15 as its peer and is forced onto Angular 22 through
  `overrides`. The Workspace and Designer copy was committed in March 2023 outside npm, so neither
  `npm outdated` nor `npm audit` sees it. The adapter's major follows the Keycloak server, so all
  of these move with "Upgrade Keycloak to a supported release" in
  [BACKEND-ROADMAP.md](BACKEND-ROADMAP.md).

**Needing a design decision.**

- **lucide-static 1.63** in the design tokens, which pin 1.47.0 exactly. A newer release can
  redraw icons that every consumer shows, so the move needs its rendered differences reviewed and
  approved like any other visual change.

<a id="accessibility"></a>

## Accessibility

The [conformance report](FRONTEND-RUNBOOK.md#accessibility-conformance) assesses CED, CEE, the term
picker and Workspace against the 55 success criteria of WCAG 2.2 at levels A and AA. The work it
calls for is grouped by the kind of fix rather than by component, because one decision usually
settles a kind of fix in every component it touches, and the items run roughly from the least
effort to the most. Every piece waits on a decision about a visible change or a design, except the
screen-reader runs, which wait on a person. Agree each piece marked as visible before making it.

Several findings are recorded as exceptions in a component's `accessibility.spec.ts` or
`layout-resilience.spec.ts`. An exception fails once its finding stops, so remove it in the same
change as the fix. When a piece's work is done, remove the piece, and remove an item once it holds
none.

### 8. Settle Where Focus Goes After an Action

Two components leave focus where nobody expects it (2.4.3, 2.4.7).

- **CED: a hidden insertion action.** When Escape hides an insertion action that has keyboard
  focus, focus stays on a control nobody can see, as it already did when a keyboard press on one
  opened the palette. Decide where focus goes, or whether a focused action stays shown.
- **Workspace: menus that stay open.** Visible. The resource menu and the user, actions and New
  menus stay open when Tab moves focus out of them. Decide whether they close when focus leaves.

### 9. Announce Messages and Keep Them Long Enough to Read

Two components show messages a person can miss, one by not announcing them (4.1.3) and one by
removing them (2.2.1).

- **Workspace: messages that arrive already written.** The metadata editor's review panel is a
  live region inserted together with its explanation and comparison table, so a screen reader may
  not announce it. Decide what the panel should announce before giving it a region that is present
  first. A notice identical to the one before it shows and says nothing, because the notice is
  never cleared, and fixing that is visible.
- **CEE: notices that vanish.** Visible. The notices that an entry was cleared or reverted
  disappear after five seconds, and nothing keeps them.

### 10. Give Every Box a Lasting Name in the Right Language

Two components' boxes lose their names, or give them in the wrong language.

- **CED: labels that vanish (3.3.2).** Visible. The field-name and option boxes and the library
  search are labelled only by placeholders, which disappear once the box holds text. They need
  labels that stay.
- **CEE: box names in the wrong language (3.1.2).** The text, email, phone, link, numeric,
  controlled-term and authority boxes, and the read-only temporal and select boxes, take the
  field's label as their `aria-label`, so the label is read in the value's language or CEE's. The
  term link group's name has the same fault. Naming each from a hidden label marked with the
  template's language, as the editable temporal boxes now are, changes nothing visible. Decide
  first whether that fits the rule that a box carries its value's language and never the
  template's.

### 11. Make Every Target at Least 24px

Three components draw targets under WCAG 2.2's minimum of 24px (2.5.8). Growing a target changes
the layout around it, so each piece is a visible change.

- **CEE: the link-out icon.** At 480px a read-only term's 20px link-out icon touches its IRI link.
  It needs a 24px target or a 4px gap. `visual/tests/accessibility.spec.ts` records it as a known
  violation.
- **CED: the field settings toggle.** A field card's settings toggle is 36 by 14px, and the field
  header beside it, which opens the same settings, is 23px tall, a pixel short of 24. The settings
  panel's last control also sits within 12px of the toggle's centre. Either the toggle or the
  header needs 24px. `browser/tests/accessibility.spec.ts` records it under `EXCEPTIONS`.
- **Term picker: the tree and the release history.** The tree's 16px twists, its terms, 14px tall
  on a 16px pitch, and the history's 22px release buttons are under the minimum.
  `browser/tests/accessibility.spec.ts` records each as an exception.

### 12. Measure Colour and Contrast as Drawn

Colour still carries a meaning alone in one component, and part of non-text contrast is measured
only as token values in all four.

- **CEE: severity by colour (1.4.1).** Visible. Range and quality warnings differ from errors only
  by amber against red.
- **All four: icons, the focus ring and selection marks (1.4.11).** Each component's layout check
  measures every field boundary as the browser draws it. Icons, the focus ring and selection marks
  are measured only as pairs of token values, so a framework default or a local override could
  draw one fainter without failing anything. Extend the check to measure each against what lies
  behind it, at 3:1, in the states that show it. Until then 1.4.11 stays Partial in all four.

### 13. Confirm or Undo Removing Access in Workspace

Removing a person's access or a group member saves at once, with no confirmation or undo (3.3.4).
Decide whether it needs either. Either is a visible change.

### 14. Complete the Keyboard Routes

Some actions and information are reached only by a pointer, and one component's keyboard route
does not follow the pattern its roles set (2.1.1, 2.5.7).

- **Workspace: a Save that refuses without saying so.** Visible. While CEE's validation is still
  running, the metadata editor's Save looks enabled, ignores clicks and explains itself only in a
  hover tooltip. Marking it `aria-disabled`, as Save is when errors refuse it, would dim it.
- **CEE: element descriptions on hover only.** Visible. An element's description and property IRI
  marks sit inside its panel header, which is a button, so they cannot take focus, and only a
  pointer shows their tooltips. Either the marks move out of the header or the header shows the
  tooltip when it takes focus.
- **Term picker: the result tabs as one Tab stop.** The scopes above the results, which are Terms,
  Branches, Ontologies and Value sets when an author chooses a constraint, form a `tablist` of
  `tab` buttons. Each button is its own Tab stop, though, and no arrow key moves between them.
  Nothing carries the `tabpanel` role, so the list a tab shows is not tied to it. Follow the ARIA
  tabs pattern: the current tab is the only Tab stop, the arrow keys and Home and End move between
  tabs, and the result list is labelled as the current tab's panel. Showing a tab can fetch more
  results, so decide whether an arrow key shows its tab at once or only moves focus until Enter or
  Space. Pin the order in the browser suite.
- **CED: the sidebar's field list.** Each entry in the sidebar's list of the template's fields
  opens the container that holds its field, selects the field and scrolls to it. Only a click does
  this. The entry, `.draggable-field-item` in `field-library-sidebar.component.html`, has no
  `tabindex` and no key handler, so a keyboard cannot reach it. Dragging an entry reorders the
  fields, and the Overview already offers that by keyboard, but going straight to a field has no
  keyboard route. A keyboard can reach each field on the canvas only by moving through the cards
  before it, which the list lets a pointer skip. A button per entry adds one Tab stop per field,
  which in a long template puts the canvas many stops away. A listbox adds a single Tab stop, and
  the arrow keys move within it. Decide as well whether choosing an entry moves focus to the card
  it selects. Agree the resulting Tab order before changing it, then pin it in
  `keyboard-order.spec.ts` and pin where focus lands in `focus-return.spec.ts`. The entry's line
  disables two of the template accessibility lint rules until this is done, so remove that
  exception in the same change.
- **CED: dragging.** Reordering on the canvas, in the Overview, in the child picker and in the
  sidebar, and resizing the Overview, all need a drag or the arrow keys. WCAG 2.2 asks for a route
  that needs only single clicks, such as Move up and Move down buttons, which is new UI to agree
  first. The sidebar's divider between its field list and the panel below needs a drag alone: it
  has no keyboard route and no `separator` role. The Overview's resize separator is the pattern to
  follow.

### 15. Lay Out Every Component Under Reflow, Zoom and Text Spacing

Each component's layout check finds content cut short, scrolled sideways or drawn over other
content at 320 CSS pixels, at 200% zoom or under WCAG's text spacing (1.4.4, 1.4.10, 1.4.12). Each
piece is a visible change, and each finding is recorded in its component's `layout-resilience.spec`.

- **Workspace: grid cards under text spacing.** A grid card's type and date line, such as
  "Template · 1 day ago", ends in an ellipsis. The line needs to wrap and the card to grow, through
  the token package's resource-card recipe, which also changes cards that are cut today.
- **CEE: instructions cut short.** At 320px the PubMed and RRID boxes' placeholders need about 271
  and 276px and get 264px, so their last letters are cut. They need a shorter instruction, or the
  instruction moved into hint text that wraps.
- **CEE: read-only values cut short.** A long text, email or phone value in a read-only box is cut
  at the box's edge with nothing to show that more follows. At 320px all three are cut, and at 200%
  zoom and under text spacing the text value is. The value needs to wrap onto further lines, as a
  paragraph value does.
- **Term picker: the release history, the selection and the narrowing panel.** At 375px the
  history head's count column has no width, so "3 releases, newest first" overlaps "effective
  date", and a release row clips its tag. At 320px the release history scrolls sideways, where each
  release could take two lines. At 200% zoom the selection's source line loses its acronym to an
  ellipsis, a value set row cuts its matched terms, and the narrowing panel opens with about 96px of
  room, clipping its list and its Clear all, Cancel and Apply buttons until the page is scrolled.
- **CED: narrow widths.** Below 768px of width the designer hides the Overview
  (`app.component.scss`), and with it outline navigation, Expand all and Collapse all, and the only
  keyboard route for reordering, so it is gone at 200% zoom as well (2.1.1). At 320px the
  Preferences field-type list scrolls sideways by 8px, and the Define Presets body scrolls sideways.
  The template's Types row pushes Enter IRI manually past the card's edge and sets "No types
  selected." one letter to a line, already at 375px. Decide how a narrow host lays these out.

CED's sidebar divider also shows a layout defect that fails no WCAG criterion. Its shares leave out
the roughly 72px of insertion actions above the field list, so the sections below can overrun the
sidebar by about 78px, which `.main-content` clips. A pointer then cannot reach the library's last
button. Keyboard focus scrolls it into view, but that puts the Add field and Import row out of
reach above. Adding fields from the sidebar causes this with 15 fields at the default share, before
any drag. Fixing it changes the default layout, so agree it first.

### 16. Give Lists and Rows Semantics a Screen Reader Can Follow

Three components draw rows that act on a click but whose roles do not say so (1.3.1, 4.1.2). Each
fix changes a keyboard model, so each is a design decision.

- **Workspace: selection as a state.** A selected row is described as Selected, because a plain
  table's rows take no `aria-selected`. Stating it as a state needs a grid and its arrow-key model.
- **CED: the child picker's results.** Its result rows act on a click but are plain table rows,
  whose selected state Chromium ignores. A grid needs an arrow-key model, a list of buttons is a
  redesign, and a visually hidden button in each row disturbs the scroller. Decide which. The
  smokes find a row by its name, Select and the artifact's name, which any choice must keep.
- **Term picker: the result list.** The browser suite's axe gate, `browser/tests/accessibility.spec.ts`,
  names two findings as its only exceptions. A result row is an `option` outside any `listbox`,
  carries `aria-expanded`, which an option does not take, and holds buttons of its own. Choose list
  semantics that fit rows with their own actions, such as a grid or a list of rows whose actions are
  reached from the row, and decide how the arrow keys move through them.

### 17. Run CED's Screen-Reader Protocol

Run the [screen-reader protocol](FRONTEND-RUNBOOK.md#ced-screen-reader-protocol) with VoiceOver and
Safari and with NVDA and Firefox, and fix what it finds. The browser suite cannot tell whether a
screen reader speaks the live region's messages, in what order, or whether one interrupts another.

<a id="ced"></a>

## CED

Keep CED responsible for editing, rendering, local validation and host-facing UI
contracts. The embedding host owns storage, authentication, permissions, server
validation requests, publishing, version allocation and provenance.

### 18. Add Host Restrictions and Preferences to the CED Embedding Contract

Add read-only mode, language and allowed field types to the designer element. Host
restrictions bound what the author may edit or select; profile and preference settings can
narrow those choices but must not broaden them. Preserve supplied artifact content when a
restricted profile hides its controls.

Define how the host supplies preference state and how CED reports changes to it; the host
chooses where and how to store that state. CED must never allocate identities or versions when
the host replaces the artifact or supplies an editable draft.

Add conformance and browser tests for these inputs and events, including read-only published
content and the transition to a host-supplied editable document.

### 19. Consider Work Preservation and Bug Reporting for Unexpected Validation Failures

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
