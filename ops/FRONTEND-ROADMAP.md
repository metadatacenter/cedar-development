# CEDAR Frontend — Roadmap

Open work for the Workspace, the Template Designer, OpenView, Monitoring, Bridging, the
embeddable editor (CEE/CEF), the embeddable designer (CED), and their TypeScript model library.
This roadmap also owns browser workflows whose completion spans a frontend and its supporting
service. The legacy Template Editor will be retired, so no item here plans work on it.

See [FRONTEND-RUNBOOK.md](FRONTEND-RUNBOOK.md) for operating procedures and
[BACKEND-ROADMAP.md](BACKEND-ROADMAP.md) for backend work outside browser workflows.
Term-picker and terminology-versioning work remains in
[VERSIONING-ROADMAP.md](VERSIONING-ROADMAP.md).

Item numbers are contiguous across the document and change as work leaves it.
Refer to the concrete change by name in commits.

## Browser Automation

<a id="chrome-automation-authentication"></a>

### 1. Restore Automated Staging Sign-In in Chrome

Resolve the **unfixed** staging sign-in failure when Browser Use controls Chrome navigation from
the start. Workspace reports “Sign-in failed. Please reload.” Normal Chrome navigation followed
by attaching automation after initialization is a workaround, not a fix.

The 2026-11-08 fresh-chat reproduction receives HTTP 200 for the public Keycloak
`3p-cookies/step1.html` and `step2.html` child documents, then leaves them at `about:blank` after
`Fetch.requestPaused`, without their load events or expected messages. Local controls finish.
`Page.getFrameTree` is refused while Browser Use is resolving a paused document response. A
same-origin staging child also stalls, so the failure is not specifically cross-origin. Workspace's
message follows from the stall. The stalled `step1.html` never posts its message, so keycloak-js
rejects initialization after its default 10-second wait. The identical probe finishes within 677 ms
in the built-in browser, which also reaches staging's normal sign-in form. Authenticated dashboard
use there remains unverified.

Chrome handles Browser Use's interception correctly. The installed Chrome 157.0.8103.39, headless
with a clean profile, loads both frames and the same-origin child when a direct DevTools connection
applies that interception: Document responses paused at the response stage and continued unchanged,
with iframes auto-attached in flattened mode. The same interception sent through `chrome.debugger`
by a test extension also loads every frame. That test ran in Chrome for Testing 156.0.8078.4,
because branded Chrome no longer loads an unpacked extension from the command line.

That leaves the ChatGPT extension. Version 1.26.1102.11740 is installed, and the Chrome Web Store
serves nothing newer. The extension's document-response interceptor releases a paused response only
after `Fetch.continueResponse` succeeds, and it discards any failure of that call without retrying
or failing the request. One failed or hung continuation therefore leaves its frame at `about:blank`
and keeps raw CDP refused for the tab, which matches the reproduction.

Why the continuation fails is not established. Every recorded stall involves a response that
arrives late or a frame that a later command inserted. Local frames load within about 45 ms, and the
local stack's own Keycloak check within 65 ms, while staging frames, whose responses take about
500 ms to arrive, stall. One mechanism in the extension fits. A command the extension sends while no tool call is
active carries cached session details, and its background refuses those unless their turn is still
the current one. Whether the late continuations fail that way has not been demonstrated, and profile
state has not been tested.

- **Obtain a repair from OpenAI.** Whatever makes the continuation fail, the extension's silent
  discard of the failure makes the stall permanent, so the repair has to come from OpenAI. Submit
  the vendor report and its 2026-11-09 addendum only with the user's authorization. A fresh chat,
  the explicit authentication-host allowance and initializing the built-in browser do not resolve
  the stall. Do not repeat speculative permission changes, bypass interception, disable cookie
  checks or weaken CEDAR authentication.
- **Settle what makes the continuation fail.** Under Browser Use in Chrome, load a local child frame
  whose server waits about two seconds before answering, beside an immediate one. If the delayed
  local frame also stalls, timing rather than the remote host triggers the failure. Then repeat the
  probe in a fresh Chrome profile with the extension connected, which only the user can set up. Add
  both results to the vendor report.
- **Retest when a newer extension build arrives.** On 2026-11-09 the Web Store served nothing newer
  than 1.26.1102.11740. The installed Chrome 157.0.8103.39 was the fully rolled-out Mac stable
  release, and Chrome 158.0.8127.18 was serving 0.5% of Macs as an early stable release. Neither an
  available upgrade nor a fix for this failure should be assumed. Coordinate any browser/app restart
  to preserve existing sessions.
- **Verify the repair in the original Chrome profile.** First require both remote frames to load
  and send their expected messages in the public probe, then require staging Workspace to
  initialize successfully in a new tab controlled by automation from the start. Preserve normal
  sign-in behavior. Attaching after initialization or reaching the built-in browser's login form
  does not meet this completion criterion.

Local evidence and the unsent escalation package are under
`$CEDAR_HOME/.cedar/reports/signin-automation-20261108/fresh-chat/`: `support-report.txt`,
`addendum-20261109.txt`, `vendor-escalation.zip` and `probe/README.txt`. The probe needs no CEDAR
bundles or credential entry. Keep cookies, tokens and unrelated session data out of any additional
capture. Stop the probe's temporary server and close diagnostic tabs afterward.

## Modern Frontend Performance Gates

### 2. Calibrate Browser Performance Gates

- Investigate the Designer host's warm small-document layout shift against the fixed reference:
  the 2026-11-13 paired report measures median CLS 0.5083 versus 0.0127, with all five candidate
  samples at 0.5083 in the latest run. The immediate before/after bundles are identical and both show the shift.
  Attribute the shifted elements and distinguish application behavior from harness/navigation
  effects before changing layout or calibration. Retain the warning until the cause is established;
  see the [browser audit evidence](FRONTEND-RUNBOOK.md#default-three-engine-coverage).
- Collect at least 14 distinct daily identical-input controls per stable runner/browser/suite/artifact
  cohort before reviewing readiness, blocking or CLS budgets. Review reference changes and budget
  increases against retained evidence. Keep machine-dependent timings outside the local reactor.
- Characterize backend and authentication variability in the hosted CI 17-scenario
  full-stack sweep before considering timing enforcement. Exclude legacy applications.

## Browser Test Reliability

### 3. Resolve the Remaining Intermittent Browser Timing Failures

- Capture correlated browser responsiveness, server request/event-loop timings, and host/container
  CPU and memory pressure when CEE readiness/navigation or Workspace navigation next stalls.
  The historical traces do not establish which layer delayed execution; do not attribute them to
  competing Java builds from coincidence alone.
- Investigate CED's read-only settings-tab inspection separately from startup. Its failure occurs
  after the application is interactive and outline navigation has selected a field. Retain the
  complete trace and click/scroll/settings-state sequence on recurrence.
- Before attributing a stall of about 900 seconds, read `pmset -g log`. Idle maintenance sleep
  freezes every process for 900 seconds at a time while the workstation is unattended.

Preserve the existing deadlines, zero-retry policy and assertions. Controlled resource-starvation
experiments can validate diagnostic signals but cannot establish the cause of an earlier failure.
The frontend runbook links the retained evidence and the instrumented reproduction fixtures.

## CED Validation Failures

### 4. Consider Work Preservation and Bug Reporting for Unexpected Validation Failures

Evaluate a fallback for a document CED considers saveable but the server rejects for a
structural problem the author cannot repair through Designer controls. Treat this as a possible
generation or validation defect: CED must produce valid artifacts, and server validation must
remain strict. An injected server finding tests the fallback; it does not establish that ordinary
editing produces invalid documents. Keep already-invalid imported artifacts a separate case.

Consider preserving the working state through the hosts' existing [draft
retention](FRONTEND-RUNBOOK.md#ced-in-the-split-designer-host) and offering a user-reviewed
diagnostic download or bug report. Include the submitted document, server validation response,
component/build versions and reproduction steps where available. Exclude credentials and let the
user review artifact content before sharing it. Explain that the failure needs investigation without
asking the author to repair internal JSON Schema structures or implying that a recovery draft has
been saved as a valid artifact.

Use a real reproducible case to decide whether this facility is needed and how much to build.
Agree its interaction before implementation; this proposal does not authorize a permanent
diagnostic or recovery button, banner or file picker on ordinary editing screens.
Any confirmed defect should lead to a generation or validation fix and a regression test; verify
that the fallback preserves work while the rejected write remains blocked.

## Reusable Artifact Versions

<a id="pull-version-management"></a>

### 5. Complete Pull-Based Reusable Artifact Version Management

- **Richer compatibility proofs and impact.** Recognize safe schema widenings beyond
  validation-shape equality. Assess the actual invalidated record count when schemas
  differ, including records the author cannot read, without exposing their content.
  Keep universal compatibility, stored-instance impact and semantic changes distinct.
  Extend final-write protection to permit proven safe widenings without weakening its
  concurrency fence. The existing `check-update-template` delta is not a universal proof.
- **Continuing reusable drafts and recovery across tabs.** Make continuing work on a
  saved reusable draft possible without silently turning the embedded copy into a mutable
  link. Define retrieval of confirmed but unattached results after the original tab closes,
  and deliberate cleanup of reusable artifacts whose parent edits were discarded. Once a
  reusable creation is unconfirmed, editing the child refuses every further Save as reusable
  draft, although the message asks the author to retry. A retry should settle the identity
  first sent.
- **Source revisions and descendant identity.** Record which revision of a mutable draft
  was copied, with a retrievable baseline if future comparison requires it. Resolve the
  identity scope of editable inline descendants before changing detachment: retaining
  their identifiers can leave different definitions under the same identifier. Preserve
  published descendant references and parent property IRIs. Do not rewrite stored
  published artifacts or infer provenance for legacy copies.
- **Version families and candidate choice.** Resolve a stable version family across
  releases and deletion so duplicate uses at different versions can be recognized. The
  resource server's version history lists every release to anyone who can read the version
  asked about, so the Version tab names a newer release the author cannot read and offers no
  readable release between the two. List only readable releases, and offer the latest of
  them. Agree what Upgrade does with a release deleted after its assessment. Today it attaches
  the assessed content, and Save stores a link to the deleted artifact. Agree the
  interaction for selecting an older or latest compatible release, and for reviewing
  meaningful changes and local divergence, before adding controls.
- **Existing reuse and retirement of bubbling.** Inventory older embedded drafts with
  shared stored identifiers and missing derivation. Agree an honest unknown-origin state
  and a deliberate association workflow. Add a read-permission-filtered usage endpoint.
  Retire bubbling's REST mutation and preview endpoints once the replacement workflow and its
  existing-data path are usable.
- **Further journey gates.** Add a journey for cross-tab outcome retrieval once retrieval of
  confirmed but unattached results is defined. Once version histories list only readable
  releases, extend `version-source-access` to a readable release between the author's and an
  unreadable newest one, which the tab should then offer. Verify untouched screens separately
  from failure paths and keep exceptional controls absent without their triggering condition.

## Static Frontend Delivery

### 6. Finish Frontend Cache Delivery

A deployment should make a new code revision visible without a hand-set token, and no browser
should reuse a file that an earlier build served. Neither holds on staging or production yet.

Staging and production serve OpenView, Monitoring and Bridging with no `Cache-Control` header. A
browser then judges from a file's age how long its copy stays fresh, and can reuse an un-hashed
file for weeks without asking the server. OpenView's folder page showed raw translation keys for
this reason, because browsers held the June 2024 `en.json`. Production's Workspace and Designer
already answer their entry pages, deep links and `/config/` with `no-store`, but their other
stable-name files are uneven. The Designer's scripts and every origin's `favicon.ico` carry no
header.

The canonical policy is in the `os-mirror` vhosts, with
`staging-centos/etc/nginx/sites-enabled/frontend-openview.inc.conf` as the model. Until 2026-10-07
every mirrored copy failed `nginx -t`, so it could not have been installed. The staging mirror has
no vhost for Workspace or the Designer yet; add both.

`CEDAR_VERSION_MODIFIER` exists to tell apart two builds of one source commit, and no cached file
needs it. Every file whose bytes depend on the deployment is written under `app/config/` and served
from `/config/` with `no-store`, and Workspace's cache keys already contain the source commit.
Production still sets one. Release 2.9.29 carries `-2026-10-03-1`, the modifier chosen for 2.9.23.
Once every stable-name file revalidates, remove it from Workspace's build tooling, the Designer's
host script, the native build-info writer, the three Docker build entrypoints, the microservices
Compose file, the config library's environment descriptor and `CedarBuildInfo`, Monitoring's deploy
matrix, every repository's CI environment block, and the production runbook's step that chooses a
modifier. Workspace's Settings page loses its "Version modifier" row with it, as agreed on
2026-10-07. The legacy Template Editor's build refuses to start without the variable, so the
variable can leave the deployment only after that editor is retired. Operators read a build's source
commit from `/config/build-info.json` and from Monitoring's deploy matrix.

Apply the policy on staging (`cedr-stg-app-07`) first, then on production (`cedr-prd-app-05`), to
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

Run the cache-delivery smoke, `npm run smoke:frontend-cache` in `ops/e2e`, on staging and then
production after rebuilding every frontend from recorded commits. Name the host in `CEDAR_HOST`, the
recorded commits in `CEDAR_ACCEPTED_COMMITS`, and a browser profile in `CEDAR_CACHE_SMOKE_PROFILE`
that loaded the old payload before the deployment.

The item is complete when both hosts pass the header check on every frontend origin, two
consecutive code deployments need no modifier, and a rollback works by restoring payloads and
routing without inventing one.

## Workspace and Browser Workflows

<a id="doi-minting-recovery"></a>

### 7. Make DOI Minting Recovery-Safe

The backend runbook's [DOI Records](BACKEND-RUNBOOK.md#doi-records) describes the bridge's
recovery behavior, which the work below verifies and completes.

Keep the DataCite wizard out of Workspace resource menus until its user-facing flow has been
reviewed against that recovery behavior. Before reintroducing an entry point, verify the behavior
end to end on a deployed stack, against DataCite's test API with the deployment's credentials.

Establish how historical document/graph DOI disagreements arose; do not assume they prove a
minting timeout. Find the DOIs published at DataCite before the bridge kept records that no artifact
carries, and attach or report each, since nothing reconciles them automatically. Extend the resource
server's offline regression coverage to an ordinary unchanged-DOI update after reconciliation, and to
continued rejection of DOI replacement or deletion through ordinary updates after it. The admin
tool's schema rebuild drops the bridge's uniqueness constraint on DOI records without recreating it,
so teach it the constraint or restart the bridge after every rebuild. The verified recovery
procedure is in the [backend runbook](BACKEND-RUNBOOK.md#recovering-an-existing-doi-attachment).

<a id="cee"></a>

## Embeddable Editor and Model Library

### 8. Whole-Component Runtime Theme Overrides

Define host-facing CSS properties for brand, surface, text, muted and border roles beyond the
compact-control API in `STYLING.md`. Wire them through the M3 adapter to every affected control
and overlay, keeping Material internals private. Specify how related tints respond to a host's
brand override and which semantic status colors must remain invariant. Add browser tests that
set custom role values and check rendered foregrounds, backgrounds and focus states before
documenting the properties as supported.

### 9. Authoring Feedback for Unsupported Markup

Expose CEE's rendering policy to authors in CED's markup input. Configure the input to produce
supported markup and warn when CEE's
sanitization would remove content. Verify the authoring-to-CEE round trip for both supported
formatting and rejected markup.

Decide whether authoring tools obtain the policy from a public embedding API, built from CEE's
internal `TEMPLATE_MARKUP_POLICY`, or from a supported description kept in sync with editor
configuration and tests. Either form must carry every rule the sanitizer enforces, including
those beyond the tag and attribute allowlists, such as forbidden event handlers and non-raster
data images.

## Frontend Dependencies

### 10. Take the Held Frontend Dependency Upgrades

Apart from the legacy Template Editor, whose npm dependencies are frozen, every frontend
dependency is at its newest release except the ones below. Most of them wait on an upstream
release, one needs browser authentication integration, one is held by a design decision and one failed its
trial. The figures were measured on 2026-11-25.

**Waiting on upstream.**

- **TypeScript 7.** TypeScript 7.0 ships without the JavaScript compiler API, and Angular's
  compiler, ts-jest and typescript-eslint are all built on that API. None accepted TypeScript 7 on
  2026-11-25.
  - Angular's compiler, `@angular/build` and ng-packagr 22.3.0 accept only `>=6.0 <6.1`. Every
    Angular project builds with them.
  - ts-jest 29.4.15, the newest release, accepts only `>=4.3 <7`. The model library, which has no
    Angular, runs its tests through it.
  - typescript-eslint 8.74.0 accepts only `>=4.8.4 <6.1.0`. CEE, CED, CETP, Workspace, the Angular
    demo and the model library lint with it.

  TypeScript 7.1 is expected to ship a new API. Its
  [iteration plan](https://github.com/microsoft/TypeScript/issues/63703) set the stable release for
  2026-11-24. That date has passed with the 7.1 beta published and no revised stable date.
  Angular closed the request to widen the 22.x range as not planned. The team is
  [writing a compiler front end](https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a)
  that uses the 7.1 API for type-checking, and has named no release for it. The post expects
  breaking changes, so the likely release is Angular 23, listed for about June 2027. The model
  library can move once ts-jest and typescript-eslint each release against the 7.1 API, and neither
  has announced one. Measure the three ranges again before acting on any of these dates.
- **`@types/node` 26.** The types follow the supported runtime's major, and the projects target Node 24.
- **ESLint 10 and Babel 8 in the Ember demo.** The two move together. The demo's lint
  configuration parses JavaScript with `@babel/eslint-parser`, whose 7.x releases accept nothing
  newer than ESLint 9 and whose 8.x releases require `@babel/core` 8. The newest releases of
  ember-cli-babel (8.3.2), `@rollup/plugin-babel` (7.1.0) and Embroider's core and compat packages
  accept only Babel 7, so both upgrades wait until those accept Babel 8. `@eslint/js` 10 moves with
  ESLint, and `@babel/plugin-proposal-decorators` and `@babel/plugin-transform-runtime` 8 move with
  Babel.
- **Playwright 1.65** in the browser and visual suites of every application, which pin 1.64.1, in
  the container image their run scripts name, and in the vitest browser runners of Bridging,
  Monitoring and OpenView. WebKit in 1.65.1 delivers pointer events on CETP's controls to the
  document element, so clicks and hovers time out. Under it, 30 of CETP's 33 WebKit accessibility
  tests fail and Monitoring's column-help tooltip never opens. Under 1.64.1 all of them pass. The
  npm pins and the image tag move together once a later release passes those suites.

**Held by design.**

- **lucide-static past 1.69.0** in the design tokens, which pin 1.69.0 exactly. Of the 99 icons
  the registry draws, only `help` (`circle-help`) changed between 1.69.0 and 1.80.0. Release 1.72.0
  redrew its question mark as a wider, flatter arc whose tail drops more steeply into the stem. The
  release notes do not mention the change, which arrived with
  [lucide-icons/lucide#5184](https://github.com/lucide-icons/lucide/pull/5184), a pull request that
  adds new question-mark icons. The redraw rewrites 49 of CEE's pixel baselines, and on 2026-11-25
  the icon was kept as it is. Compare each new Lucide release's drawings of the registry's icons
  with 1.69.0, since the release notes cannot be relied on to list a redrawn icon. Move the pin
  when a release brings an icon CEDAR needs or the redrawn question mark is accepted, and review
  every changed baseline as a design change.

**Held after a trial.**

- **`@axe-core/playwright` 4.14** in the browser and visual suites of every application, which pin
  4.13.0 exactly. Under 4.14.1, axe no longer measures the colour contrast of text inside the
  shadow roots of the term picker and CEE. It reports the text's background as covered by another
  element and leaves the check undecided, and the suites fail on an undecided result. The term
  picker fails twelve Chromium scans at 375 and 1280 px, and CEE fails its open calendar in
  Firefox. Under 4.13.0 the same elements measure and pass. Find out whether 4.14 detects a real
  overlap or misreads shadow-root layering before the pin moves, rather than recording the
  undecided checks as exceptions. Monitoring's exception for its user menu no longer reproduces
  under 4.14.1, so it leaves with the move, and any new finding goes in the
  [Accessibility](#accessibility) item.

**Retire the legacy Keycloak browser adapters.**

- **keycloak-angular 22 and keycloak-js 26** in Bridging and Monitoring, and the adapter that
  Workspace, the Template Designer host and the legacy Template Editor load from
  `app/scripts/keycloak/`. The installed keycloak-angular 13.1.0 declares Angular 15 as its peer
  and is forced onto Angular 22 through `overrides`, the only override either application still
  carries. The other three load one identical copy of keycloak-js 21, committed in March 2023
  outside npm, so neither `npm outdated` nor `npm audit` sees it. Replace the vendored UMD integration
  with the supported module build and update Bridging and Monitoring's initialization. Remove the
  nonce/session-state compatibility mappers and `exclude.issuer.from.auth.response` from the realm
  seeds and existing clients once every consumer handles the modern protocol, then verify silent
  sign-in, login, logout and refresh in Chromium, Firefox and WebKit. The issuer-response exclusion
  is deprecated in Keycloak 26.8.2 and must not become a permanent dependency. Coordinate its removal
  with the server rollout in [BACKEND-ROADMAP.md](BACKEND-ROADMAP.md).

<a id="accessibility"></a>

## Accessibility

### 11. Complete Accessibility Verification

Close the remaining Fails, Partial and Unverified ratings in the
[conformance report](FRONTEND-RUNBOOK.md#accessibility-conformance), against all 55 WCAG 2.2 A/AA
criteria for CED, CEE, the term picker, Workspace, OpenView, Bridging, Monitoring and the Template
Designer host. Keep legacy Template Editor and legacy code outside this work. Verify complete
host/component journeys: a component's Host rating assigns responsibility to its embedding page,
and does not exempt that page. Keep justified N/A ratings distinct from missing evidence.

- Run the [screen-reader protocol](FRONTEND-RUNBOOK.md#ced-screen-reader-protocol) and
  [Monitoring protocol](FRONTEND-RUNBOOK.md#monitoring-screen-reader-protocol) with VoiceOver/Safari
  and NVDA/Firefox, and fix what they find. Cover editing, validation, saving, dialogs, query results
  and failures, row/cell names, trace entry and focus return, and quiet unchanged polling. Verify
  actual speech, order and interruption; DOM semantics and separate green component suites do not
  establish the integrated experience.
- Add an explicit CEE author/host declaration of personal input purpose, with scoped autocomplete
  tokens for covered current-user fields. Preserve the existing default for generic metadata and
  fields about other people; verify repeated/nested instances and browser autofill before enabling
  it. Verify the fix in CEE and its three affected hosts; these ratings share one underlying defect.
- Complete the [native zoom protocol](FRONTEND-RUNBOOK.md#browser-coverage-and-native-zoom)
  across all eight frontends and supported browsers: intermediate levels through 200%, text-only
  zoom where supported, and 400% page zoom for reflow. Check ordinary editing, long values, nested
  content, menus and errors. Reduced viewports and one checked screen do not settle whole workflows.
- Verify each host's real sign-in, password-manager/paste use, session expiry and work-preserving
  recovery. Identity-provider fixtures and functional smoke do not settle accessible authentication
  or timing; record the real journey and its accessibility outcome.
- Review actual template-authored media, including caption accuracy, transcripts or alternatives,
  audio description, live captions and player keyboard operation. Record the video, language,
  alternatives and deployed player outcome; stubbed iframe checks cannot settle the five media
  criteria. Include the wider content surface when a host permits trusted rich text.
- Close the remaining Partial ratings with criterion-level evidence across components and hosts:
  complete keyboard paths, integrated focus order, visible and unobscured focus, programmatic names
  and states, color-independent cues, headings, instructions and error suggestions. Review error
  prevention for DOI creation, Designer saves and Workspace destructive actions, and finish
  Workspace timing, moving-content and drag-alternative verification.
- Have a competent Hungarian reviewer assess translated labels, instructions, errors and spoken
  announcements in real journeys. Layout coverage does not establish translation quality or speech.

For each closure, record the affected criterion and surface, source/build identity, browser and
assistive-technology versions where relevant, journey/state, expected and observed outcome, and
retained evidence in the runbook. Add reproducible regressions to the appropriate existing browser
projects, preserving measured thresholds and the guard against new unreviewed exceptions. Leave a
rating Partial or Unverified wherever evidence is incomplete; green automated checks alone do not
justify a complete conformance claim. Remove finished sub-parts from this item as they close.


<a id="ced"></a>

## CED

Keep CED responsible for editing, rendering, local validation and host-facing UI
contracts. The embedding host owns storage, authentication, permissions, server
validation requests, publishing, version allocation and provenance.

### 12. Add Host Restrictions to the CED Embedding Contract

A host cannot bound the field types an author may add. Only the author's own preference filters
the field types on offer, and the author can lift that filter.

Add an allowed-field-types input to the designer and field designer elements. The type picker, the
field library sidebar and the field designer's type chooser should then offer only the allowed
types that the author's preference also shows. Profile and preference settings can narrow the
host's bound but must not broaden it. Preserve supplied artifact content of a type the host does
not allow.

Agree these before implementing:

- whether an existing field of a disallowed type stays editable, becomes read-only or appears in
  the validation report
- how the Preferences dialog presents a disallowed type
- whether CED keeps reporting the author's own preference once a bound applies, or reports the
  state the bound leaves

Add conformance and browser tests for the new input. Cover the bounded pickers and content
preserved under a bound. CED must never allocate identities or versions when the host replaces the
artifact or supplies an editable draft. Add a test for the move from read-only published content
to a host-supplied editable document that asserts this.

## Independent UI Review

### 13. Agree the Remaining Presentation Choices

The independent reviews left these product choices open. They are not permission to add controls,
hide information or rearrange the interface. Any approved change needs rendered review, relevant
regression checks and current-source acceptance.

**Workspace.**

- Develop and agree a more legible tablet arrangement for very long ancestor paths with both panels
  explicitly open. The center column is about 238 pixels and requires extra scrolling. Preserve
  full ancestor names and explicit panel control; do not automatically hide information or panels.

The sealed review evidence and this proposal are linked from the frontend runbook.

**Designer.**

- Agree whether expandable term rows need a visible disclosure cue and whether release-count labels
  should explicitly name releases instead of saying “of 2”.
- Decide whether ontology names should remain visible while their release histories scroll, through
  a retained or repeated heading. Preserve the current scrolling behavior until agreed.
- Decide whether Term details should retain the last inspected term with clearer context or follow
  the active tab and selection. This changes displayed information or selection behavior.
- Agree whether missing Image and YouTube notices should include each complete authored field name.

The frontend runbook links the complete calibrated Designer review and focused follow-up evidence.

**OpenView.**

- The frontend runbook records no agreed layout behavior for OpenView. Agree it from the answers
  given to the findings of its coordinated reviews, and record it there.

### 14. Extend Meaningful State Coverage and Reviewer Calibration

- Add a collector for the standalone field-designer host. Inventory its distinct pages, dialogs
  and significant states first; the four-application catalog is not a denominator for the whole
  frontend estate.
- Add state-specific visibility checks where an image could be captured without its intended
  subject being visible. Verify the actual named target and retain diagnostic evidence when it is
  absent; screenshot existence alone does not establish the intended state was reached.
- Diagnose the isolated controlled-term lookup failure in the November 26 packet
  `rich-states-metadata-touch-20261126-b`: `terminology lookup failed for "null"` followed by a
  minified error. The logged null is the empty control value; the search sends an empty string.
  Six pending-search/navigation cancellation probes completed without that error,
  so cancellation alone does not explain it. Use the timestamped console/error-object and network
  diagnostics in further captures to identify the failed request before changing CEE or suppressing
  the message. Preserve the original packet.
- Add semantic change selection for review prioritization. Raw image-byte changes include dynamic
  fixture text and do not establish meaningful layout changes. Any assessment reuse must identify
  the exact evidence, reviewer/model and prompt version, and keep unreviewed states explicit.
- Maintain a held-out reviewer benchmark with acceptable controls and known defects, track misses
  and false positives across reviewer/model versions, and periodically review an unchanged sample.
  Improved model scores must not silently turn historical or partial evidence into acceptance.
