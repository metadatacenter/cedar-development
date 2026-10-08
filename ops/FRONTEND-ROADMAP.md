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
`DataCiteResource`. Add offline tests for create versus update, retry after timeout and repeated
publish. Extend the opt-in `datacite`-tagged test, or add a sandbox smoke beside it, to cover the
full mint and attach contract and the credential check.

Establish how historical document/graph DOI disagreements arose; do not assume they prove a
minting timeout. Extend offline regression coverage to ordinary unchanged-DOI updates after
reconciliation and continued rejection of DOI replacement or deletion through ordinary updates.
The verified recovery procedure is in the [backend runbook](BACKEND-RUNBOOK.md#recovering-an-existing-doi-attachment).

<a id="cee"></a>

## Embeddable Editor and Model Library

### 3. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 4. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in the Template Editor's rich-text `Source` mode and
CED's markup input. Configure those surfaces to produce supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

### 5. Reduce Embedded Font Payload

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

### 6. Retire the Shared Monospace Face

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

### 7. Clear the Advisories Waiting on Upstream Releases

Two advisories remain in the frontend locks, and no release of either package fixes them. Both
sit in build, lint and test tooling, and nothing the affected projects ship contains them. Every
other lock outside the legacy Template Editor audits clean.

- `braces` (GHSA-vfj7-8cjw-p6xm, high) affects every release up to 3.0.3, the latest. It reaches
  the Ember CEE demo only through `micromatch` 4.0.8. ember-cli, `@embroider/compat` by way of
  broccoli and findup-sync, `@embroider/vite` by way of fast-glob, stylelint and ember-template-lint
  6 all still require it in their latest releases. ember-template-lint 7 no longer does.
- `sprintf-js` (GHSA-hp3w-g68c-fv3c, moderate) affects every release up to 1.1.3, the latest. It
  reaches the Ember demo through `underscore.string` 3.3.6, which broccoli 4 and `quick-temp`
  require. It reaches the model library through `ts-jest`, `babel-plugin-istanbul` and
  `@istanbuljs/load-nyc-config`, which still loads `js-yaml` 3 and with it `argparse` 1.

No override helps while no fixed version exists. Dropping stylelint and ember-template-lint would
not help either, because ember-cli and Embroider would still bring `braces`, and moving
ember-template-lint to 7 removes one route for each package without clearing either. When
`braces` or `sprintf-js` publishes a fix, or the packages above stop requiring them, refresh the
affected locks, run each project's lint, tests and build, and refresh the train's lock baselines
with `cedarcli publish baselines --refresh`.

<a id="ced"></a>

## CED

Keep CED responsible for editing, rendering, local validation and host-facing UI
contracts. The embedding host owns storage, authentication, permissions, server
validation requests, publishing, version allocation and provenance.

### 8. Display Host-Supplied Validation Findings in CED

Add an input for findings supplied by the embedding host. Map artifact paths to nodes and
settings, show the messages beside the affected controls and in CED's validation summary, and
give host findings a source of their own so they remain distinguishable from CED's model and
draft findings.

Specify when host findings become stale after an edit or artifact replacement. Preserve unsaved
input and cover correction, clearing and replacement of reports. The host calls the schema
server and decides whether an artifact may be saved.

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

### 12. Clear CED's Token Adoption Baseline

CED's source baseline held 23 findings on 2026-10-04. The shared token gate refuses any change to a
repository's recorded exceptions, on a push as on a pull request, so no finding can be accepted
with a written reason. A finding leaves the baseline only when its declaration gives way to a shared
role or recipe, or to a size named for the designer in the tokens package's `spacing` export.
Otherwise it stays as recorded debt. Never widen an allowance or substitute a semantically unrelated
token to pass the scanner.

The remaining findings fall into four groups:

- **Measurements no role describes (13).** The overview's selected-item outline and the invalid
  card's outline (two declarations each) could become shared recipes. The preview toolbar's bar,
  select and close button (three), the checkbox tick and radio dot (two), and the settings toggle,
  panel toggle, display-flag row and library badge (one each) would take designer sizes. None of
  these changes what renders.
- **Stacking order (2).** The settings toggle sits at 11, one above the sticky layer, so that it
  clears the insertion area between cards. The library sidebar sits at 30, below the menu layer.
  Layer recipes in the tokens package would keep that order.
- **Local layout (7).** These are the library sidebar's drag indicator, divider and handle (three),
  the two height bindings of its resizable split, the scrollbar width four CED surfaces share, and
  the designer's 500px minimum height. CED's README treats sidebar resizing and drag handles as
  local rules, but the gate admits no exception for them. Each needs a designer size, the split a
  custom-property binding the scanner can read, or it stays as debt.
- **Hover dimming (1).** The user menu's trigger dims to 80% opacity on hover, which no shared role
  describes.
