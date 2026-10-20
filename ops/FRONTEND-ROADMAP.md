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

## Static Frontend Delivery

### 1. Finish Frontend Cache Delivery

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
the source commit. Production still sets one, `-2026-10-03-1` for 2.9.23. Once every stable-name
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

Production OpenView sits behind Cloudflare, which adds `max-age=14400` to JavaScript and caches
static files at its edge. After the reload, purge `openview.metadatacenter.org` there. If the CEE
bundle still carries `max-age=14400`, set Cloudflare's Browser Cache TTL to "Respect Existing
Headers".

Extend the cache-delivery smoke to check immutable hashed assets and revalidating fallbacks, to
compare every served build identity against the accepted commit, and to open, modify, save,
reload and save an existing instance, so that the GET ETag and the subsequent `If-Match` update
are exercised. Run it on staging and then production from a browser that previously loaded the
old payload, after rebuilding every frontend from recorded commits.

Headers reach a browser only when it next asks the server. A browser that holds the 2024 `en.json`
keeps it until its copy expires, up to about 80 days after it fetched it. Only the new OpenView
build fixes those visitors, because it reads no translation or configuration file at runtime. That
build is on `develop` from `452c09f`, and production deploys from `main`, so decide whether it waits
for the next release or a release is cut sooner.

The item is complete when both hosts pass the header check on every frontend origin, production
serves OpenView from `452c09f` or later, two consecutive code deployments need no modifier, and a
rollback works by restoring payloads and routing without inventing one.

## Workspace and Browser Workflows

<a id="doi-minting-recovery"></a>

### 2. Make DOI Minting Recovery-Safe

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

### 3. Recover Failed Saves Without Losing Work in Designer and Editor

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

### 6. Clear the Advisories Waiting on Upstream

Two advisories remain in the frontend locks, and no release of either package fixes them. Both
sit in build, lint and test tooling, and nothing the affected projects ship contains them. Each is
a denial of service that needs an attacker to supply the glob pattern or the format string, and
here those come only from the projects' own configuration. Nothing waits on this item. The train's
lock baselines record the current counts as reviewed, so trains and releases pass. Every other
lock outside the legacy Template Editor audits clean.

- `braces` (GHSA-vfj7-8cjw-p6xm, high) affects every release up to 3.0.3, the latest. It reaches
  the Ember CEE demo only through `micromatch` 4.0.8. ember-cli, `@embroider/compat` by way of
  broccoli and findup-sync, `@embroider/vite` by way of fast-glob, stylelint and ember-template-lint
  6 all still require it in their latest releases. ember-template-lint 7 no longer does.
- `sprintf-js` (GHSA-hp3w-g68c-fv3c, moderate) affects every release up to 1.1.3, the latest. It
  reaches the Ember demo through `underscore.string` 3.3.6, which broccoli 4 and `quick-temp`
  require. It reaches the model library through `ts-jest`, `babel-plugin-istanbul` and
  `@istanbuljs/load-nyc-config`, which still loads `js-yaml` 3 and with it `argparse` 1.

The likeliest way out is withdrawal rather than a fix. Both maintainers dispute their advisory,
and neither has merged any of the fix pull requests opened since it was published. On 2026-10-05 a
contributor asked the authority that issued the `braces` advisory to withdraw it. A withdrawn
advisory drops out of `npm audit` with no change on CEDAR's side. stylelint's maintainers say its
unreleased 18.0.0 drops its glob dependencies, which removes one route for `braces` and leaves the
others.

No override helps while no fixed version exists. Dropping stylelint and ember-template-lint would
not help either, because ember-cli and Embroider would still bring `braces`, and moving
ember-template-lint to 7 removes one route for each package without clearing either.

When an advisory is withdrawn, lower the counts recorded for the affected locks in
`ops/frontend-train.json` by hand. The locks themselves do not change, and
`cedarcli publish baselines --refresh` refreshes only a lock whose digest has moved. When a package
publishes a fix instead, or the packages above stop requiring it, refresh the affected locks, run
each project's lint, tests and build, and run `cedarcli publish baselines --refresh`.

### 7. Extend CEE's Accessibility Gate to the Rest of Its States

CEE's visual suite runs axe-core over every fixture, empty, filled with each of its instances and
read only, at both widths. It does not yet cover states other specs already build: the field
element under each combination of presentation settings, compact density in editable and
read-only modes, and an authority search under way. Add them to `visual/tests/accessibility.spec.ts`,
fix the defects whose fix changes nothing on screen, and agree any visible change before making it.

## Frontend Dependencies

### 8. Take the Frontend Dependency Upgrades That Need Code Changes

Each dependency below has a newer major release that a lock update cannot take. Some wait on an
upstream release, most need code changes, and one needs a design decision. The versions are the
newest that `npm outdated` reported on 2026-10-19, after every in-range update had been taken.

**Waiting on upstream.**

- **TypeScript 7.** Angular 22's compiler accepts only `>=6.0 <6.1`, so TypeScript moves when an
  Angular release accepts 7.
- **`@types/node` 26.** The types follow the runtime's major, and every project runs Node 24.

**Needing code changes.**

- **Vitest 5.** `@angular/build` 22.2.3 already accepts it. CEE's root and its domain harness must
  move together, because the harness runs on the root's worker, and the harness's `oxc` transform
  settings need checking against Vitest 5's Vite, since the previous major broke them. The other
  Vitest projects are CED, CETP, Workspace, OpenView, Bridging, Monitoring and the Angular and
  React demos. OpenView, Bridging and Monitoring also move `@vitest/browser-playwright` with it.
- **ngx-translate 18** in OpenView, Bridging and Monitoring. It removes `TranslateModule`, so each
  application's module-based setup moves to the provider functions.
- **keycloak-angular 22 and keycloak-js 26** in Bridging and Monitoring. The adapter's major
  follows the Keycloak server, so these move with "Upgrade Keycloak to a supported release" in
  [BACKEND-ROADMAP.md](BACKEND-ROADMAP.md).
- **ng-alt-snotify 17** in OpenView, Bridging and Monitoring, which run 16, 15 and 14. Each pins an
  exact Angular major as a peer, which an npm `overrides` entry satisfies today. Check whether 17
  changes the API the applications call before moving.
- **TypeScript 6 in the model library.** The library builds with TypeScript 5.9, while every
  Angular project and CEE's harness use 6.0.
- **The demos' tooling.** ESLint 10 in all three demos; zone.js 0.16 and jsdom 30 in the Angular
  demo; Babel 8, QUnit 3, ember-template-lint 7 and eslint-plugin-ember 13 in the Ember demo.
  Moving ember-template-lint to 7 also removes one route for each advisory that "Clear the
  Advisories Waiting on Upstream" tracks.

**Needing a design decision.**

- **lucide-static 1.59** in the design tokens, which pin 1.47.0 exactly. A newer release can
  redraw icons that every consumer shows, so the move needs its rendered differences reviewed and
  approved like any other visual change.

<a id="ced"></a>

## CED

Keep CED responsible for editing, rendering, local validation and host-facing UI
contracts. The embedding host owns storage, authentication, permissions, server
validation requests, publishing, version allocation and provenance.

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

Run the [screen-reader protocol](FRONTEND-RUNBOOK.md#ced-screen-reader-protocol) with
VoiceOver and Safari and with NVDA and Firefox, and fix what it finds. The browser suite
cannot tell whether a screen reader speaks the live region's messages, in what order, or
whether one interrupts another.

### 11. Give the Sidebar's Field List a Keyboard Route

Each entry in the sidebar's list of the template's fields opens the container that holds its
field, selects the field and scrolls to it. Only a click does this. The entry,
`.draggable-field-item` in `field-library-sidebar.component.html`, has no `tabindex` and no key
handler, so a keyboard cannot reach it. Dragging an entry reorders the fields, and the Overview
already offers that by keyboard. Going straight to a field has no keyboard route. A keyboard can
reach each field on the canvas, but only by moving through the cards before it, which the list
lets a pointer skip.

Two designs fit. A button per entry adds one Tab stop per field, which in a long template puts
the canvas many stops away. A listbox adds a single Tab stop, and the arrow keys move within
it. Decide as well whether choosing an entry moves focus to the card it selects. Agree the
resulting Tab order before changing it, then pin it in `keyboard-order.spec.ts` and pin where
focus lands in `focus-return.spec.ts`. The entry's line disables two of the template
accessibility lint rules until this is done. Remove that exception in the same change.

### 12. Consider Work Preservation and Bug Reporting for Unexpected Validation Failures

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
