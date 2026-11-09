# CEDAR Frontend — Runbook

Running, building, testing and releasing the embeddable editor (CEE/CEF), designer
(CED), and the TypeScript model library used by them. Commands in each component
section run from that repository unless stated otherwise.

For a development frontend build, run `cedarcli build frontends`. It has Maven-like SNAPSHOT
semantics: build current local sources, including uncommitted edits, supply their packages to every
consumer, verify, redeploy and smoke. The request authorizes that complete local workflow without
follow-up questions. There is no prerequisite to publish, move pins, commit, push or wait for CI.
Use `cedarcli test frontends` when only the source build and checks are requested. Releases and
build trains use their separate captured-source workflows.

Use [FRONTEND-ROADMAP.md](FRONTEND-ROADMAP.md) for open work across these components
and the main browser applications. Shared design values belong in
[`cedar-design-tokens`](../../cedar-design-tokens/README.md).

## Find the Procedure

| Area | Start here |
| --- | --- |
| Development SNAPSHOT build | [The reactor](#the-reactor); `cedarcli build frontends` |
| CEE/CEF setup and development | [Node](#cee-node-versions--read-this-first), [running](#cee-running-the-app), [build](#cee-building-the-web-component) |
| CEE/CEF tests | [Complete gate](#cee-running-the-complete-test-gate), [domain harness](#cee-running-the-domain-test-harness), [visual baselines](#cee-running-the-visual-baseline) |
| Model library | [Build and package](#cee-building-the-model-library), [validate output](#cee-checking-output-against-the-cedar-model) |
| CEE release and host adoption | [Release](#cee-release), [local frontend bundles](#cee-getting-a-local-build-into-the-frontends) |
| CED development | [Requirements](#ced-requirements), [running](#ced-running), [building](#ced-building) |
| CED tests and distribution | [Tests](#ced-testing), [packaging](#ced-packaging-and-release) |
| CED with CEE/CEF and the term picker | [Embedding](#ced-embedding-it), [sibling integration](#ced-running-it-with-its-siblings) |
| Main browser applications and local stack | [Backend runbook](BACKEND-RUNBOOK.md), [production deployment](PROD-DEPLOY-RUNBOOK.md), [Docker operation](DOCKER-RUNBOOK.md) |
| Public npmjs releases | [Npmjs release runbook](NPMJS-RELEASE-RUNBOOK.md) |
| Term-picker operation | [Versioning runbook](VERSIONING-RUNBOOK.md) |
| What a host serves against its components | [Component staleness](#component-staleness) |
| Page load and interaction performance | [Reporting-only performance suite](#reporting-only-performance-suite) |
| How each component measures against WCAG 2.2 | [Accessibility conformance](#accessibility-conformance) |

## Paired standalone performance checks

`cedarcli test frontend-performance-paired` compares prebuilt standalone CEE/CED JavaScript bundles, or two staged
Template Designer `app/` directories with `--component designer`, without backend services, Keycloak, accounts or repository fixtures.
The command does not build, deploy or publish anything. Use the normal reactor/CI production output;
never pass a development-server bundle. Finish builds and other tests before measurement.

```bash
cedarcli test frontend-performance-paired --component cee \
  --baseline /path/to/before/cedar-embeddable-editor.js \
  --candidate /path/to/after/cedar-embeddable-editor.js \
  --output /path/to/new-report --samples 5
# Use --component ced with the standalone cedar-embeddable-designer.js bundle.
```

The runner freezes and hashes both inputs, uses the same fixed 5/100-field fixtures and
readiness/editing checks as the full-stack suite, and records browser, Node, machine, suite
and artifact identities. Five sequential pairs alternate baseline/candidate order and rotate
fixture order. Each version has a fresh browser context, cold then warm cache, with the
constrained profile (4× CPU, 1.6 Mbit/s down, 150 ms latency). The static HTTPS server uses
gzip and browser caching without Playwright routing. Unknown hostnames fail DNS; unexpected
origins are failures. There are no backend writes or cleanup credentials.

Missing assets, failed requests, duplicate script requests, pending requests at the observation
cutoff, broken rendering/editing, uncaught errors or incomplete coverage fail the command.
Reports contain all attempts; failed samples cannot improve a median. Existing output directories
are refused. `report.json`, `summary.md` and screenshots are retained; the local directory also
keeps frozen inputs. CI uploads only reports/screenshots, not ephemeral TLS keys.

Readiness, blocking time over 50 ms and CLS are **advisory**, pending runner calibration.
A timing warning requires the median paired increase to exceed both 10% and 100 ms for
readiness, or both 15% and 50 ms for blocking. CLS uses a provisional 0.02 increase.
These are investigation triggers, not approved budgets. Fewer than five pairs, missing metrics
or median absolute deviation above the tolerance produce an explicit inconclusive assessment.
In CI, a complete but inconclusive comparison gets one further full paired run. Both attempts
are retained, with the second selected; persistent noise stays explicitly inconclusive. Broken
loading or incomplete coverage never retries into a pass. A clear regression does not rerun
to seek a faster result. A complete advisory run still exits zero; load/measurement failures
always exit nonzero.

This measures standalone rendering, not sign-in, production latency, host integration, field
INP or Lighthouse TBT. Bare CED uses fallback summaries; it cannot substitute for the
Designer-equivalent CED+CEF measurement. The existing raw/gzip build budgets remain enforced
independently. Run the full-stack suite below for authenticated hosts and real APIs.

The Designer selection measures both the real host and the equivalent bare page with its
exact shared CEE/CEF/CETP/CED bundle. Both wait for every real CEF summary. Only copied runtime
configuration and the session boundary change; the shipped host JS/CSS/markup and components
remain byte-identical. Fixed HTTP API responses have real deployment-shaped resource origins,
ETags, CORS and no-store caching. Unknown API reads and every write are refused. This excludes
real SSO/API latency; it must not be compared as an application speedup against the full-stack
Designer results. Normal-load checks require recovery controls to remain absent and deferred
RDF/compatibility-validator code to remain unloaded.

The equivalent page's cross-origin fonts now receive CORS headers from the lab server. The
2026-11-07 equivalent-page measurements below predate this correction: font requests failed and
fallback fonts could render. Their within-fixture comparisons remain recorded, but they are not
font-equivalent comparisons with Designer. Host and standalone CEE/CED measurements are
unaffected. Use fresh pairs with this lab for equivalent-renderer comparisons.

A corrected control on 2026-11-08 completed 80/80 Designer/equivalent measurements, with both
inputs pointing to the same staged app. All loading, editing and normal-screen checks passed;
all paired results were within advisory tolerances. Constrained warm medians were approximately
0.62/1.40 s for the equivalent 5/100-field pages and 1.02/1.79 s for the fixture-backed Designer.
These validate the new benchmark and do not represent an optimization to product code.

The CEE and CED `Test` workflows and Designer's `Build and package` workflow call the pinned reusable
`.github/workflows/frontend-performance-paired.yml`. Pull requests compare their base SHA
with the tested merge candidate; pushes compare the previous branch head with the candidate.
The existing candidate build artifact is reused. The comparison also builds the fixed source
reference in `ops/e2e/frontend-perf/references.json`, so small regressions cannot disappear by
merging them one at a time. The reference never advances automatically: changing it requires
an explicit reviewed source change and matching harness-pin updates. Byte-identical reference
and PR-base outputs share measurements while both source revisions remain recorded. All
comparison builds/installations finish before Chromium starts. Both versions are measured
sequentially on the same Ubuntu 24.04 runner with the harness lockfile's Chromium.
No performance job runs inside the development reactor, and no package pins are rewritten.

Loading failures fail the CI job; CEE dev publication also waits for that job. Timing/CLS
warnings and inconclusive assessments appear in the job summary and workflow annotations.
Reports, every retry and screenshots are retained for 30 days. `comparison.json` records the
selected attempts and source references; each attempt retains its complete `report.json`. A baseline that cannot build is a setup
failure, never a passing comparison. To update the harness, update both the reusable-workflow
SHA and its `harness-ref` input together. The release-tooling CI tests measurement/failure
semantics without a CEDAR stack on Linux and macOS.

The initial local control check on 2026-11-08 ran 40 measurements for CEE and 40 for CED,
comparing each production bundle with itself. All loads and editing checks passed; every
paired readiness/blocking/CLS result was within its advisory tolerance. CEE's bundle SHA-256
was `ae1034b229734c180136573898c06c40f05ea1d6e8776ebda1aaa43d909ab485` and CED's was
`cf5f6442c5dd5720f88a0c5f03343f1a6bdfd0fe679a92372d8f6771b6147731`.
This validates the comparison machinery, not a speed improvement or a Linux CI budget.

The daily `Frontend performance calibration` workflow runs at 02:17 UTC on GitHub-hosted
Ubuntu 24.04 runners. It pins the validated harness and source references, builds each input
once, then compares identical bytes for standalone CEE, standalone CED and Designer/equivalent
CEF. Each control retains every observation, including noisy results, without retrying. Reports
and screenshots are retained for 30 days. The workflow must exist on the default branch,
`main`, for GitHub's schedule to run; its identical file also lives on `develop` so release
integration does not lose it. The pinned harness checkout keeps default-branch scheduling
independent of the release source tree.

Collect at least 14 distinct daily controls per stable machine/browser/suite/artifact cohort
before reviewing hard timing limits. Inspect paired differences, noise, false warnings and
host integration results together; a passing control alone does not approve a budget. Keep
reviewed limits and reference updates explicit, with retained evidence. Runner or harness
changes start a new cohort rather than silently mixing distributions.

### Hosted readiness review and notifications

`Frontend performance readiness review` runs entirely on GitHub-hosted Ubuntu runners after
calibration or full-stack measurement workflows complete, daily at 05:47 UTC as a fallback, and on manual dispatch. Its
workflow lives identically on `main` and `develop` and checks out a pinned, tested review
implementation. It never executes downloaded artifact contents as code. Updating the implementation
requires updating that pin on both branches, keeping release integration consistent.

The review counts one earliest complete successful control per UTC date, separately for each
component and comparable CPU/platform, browser, Node, suite, reference artifact and measurement
settings. Failed/missing/expired reports, incomplete coverage and duplicate same-day runs cannot
inflate the count. Noisy successful controls count and remain in the review. CEE, CED and Designer/
equivalent CEF can reach readiness independently; full-stack results are reviewed separately
from these paired component controls.

After 14 dates, a fixed rolling window of the latest 14 daily controls is assessed for readiness,
blocking and CLS. It reports paired median changes, ranges, median absolute deviation, baseline
ranges, false warnings and inconclusive rows. Zero false warnings and zero inconclusive rows in
that window support reviewing the existing provisional thresholds; otherwise the result needs
investigation and collection continues. This is a conservative automated screen, not a statistical
guarantee, human approval or automatic activation of timing gates.

The first eligible cohort opens a GitHub issue assigned to and mentioning `@martinjoconnor`.
Subsequent newly eligible or newly stable cohorts comment on that issue once per milestone;
daily unchanged results do not send duplicate issue notifications. GitHub delivers those through
the account's notification settings. The issue includes the assessment and links to source runs.
Every run also has a job summary and machine-readable `review.json`.

`performance-calibration-history` retains compact measurement reports, exact cohort identities,
source run/artifact IDs and canonical source-report digests for 90 days. Each successful default-
branch review restores the prior archive and carries it forward, preserving collected evidence
beyond raw reports' 30-day retention. Download/API failures fail the review instead of pretending
there is no history. If the review itself stops for longer than artifact retention, missing evidence
must be collected again. Repository code, package pins and gate settings are never modified by the
review. The earlier app-based review is superseded by this hosted workflow.

`full-stack-performance-history` separately retains complete hosted full-stack reports and carries
its archive forward on each successful default-branch review. A usable day requires all 340 samples
(17 scenarios × two profiles × cold/warm × five repetitions), successful setup and verified fixture
cleanup. Train images, standalone package sources, CLI/deployment tooling, suite, CPU, browser, Node
and resource limits define a cohort; newly generated runtime configuration does not split it.
The earliest complete run per UTC day counts, including slow observations. After 14 comparable
dates, the review notifies the same GitHub issue that full-stack variability is ready for human
review. Per-scenario daily medians, ranges, within-run and between-day median absolute deviations
are retained in `full-stack-review.json`. These daily measurements are unpaired: they do not
establish a false-positive rate or automatically approve timing thresholds.

## Reporting-only performance suite

`cedarcli test frontend-performance` runs a separate local performance laboratory. It is not
part of the frontend reactor, whole-stack smoke, train or release gates. No performance budget
fails a run. A broken page, failed/pending asset request, duplicate script request, unexpected external
origin, unavailable account or failed fixture cleanup does produce a nonzero exit and an explicitly
incomplete report; failed measurements never enter medians.
Browser operations have a 90-second availability timeout, and sign-in setup has 60 seconds.
Workspace and Bridging landing pages must keep the standalone editor deferred. Designer and
the equivalent CED+CEF page must keep RDF and compatibility validation code deferred. These
loading contracts cover every modern scenario in the full-stack sweep; they do not impose
machine-dependent timing budgets. The old equivalent-page font CORS defect is fixed by the
shared lab server and now fails the suite if it returns. Chromium marks successful HTTP 204
iframe responses as canceled; these no-content responses are accepted, while interrupted
asset downloads still fail. A 2026-11-08 verification covered all 17 modern scenarios with
normal/constrained profiles and cold/warm loads: 68/68 passed, with no setup or cleanup errors.
This one-repetition run verifies coverage and loading contracts, not timing budgets.

Use the pinned Node version and a running local `.orgx` backend/Keycloak stack. Run it while
builds, smoke tests and other benchmarks are idle. It neither restarts nor redeploys the stack.

```bash
cedarcli test frontend-performance --plan
cedarcli test frontend-performance --check
cedarcli test frontend-performance --samples 5
# A shorter investigation of the standalone components:
cedarcli test frontend-performance --samples 3 --scenarios cee-standalone-small,cee-standalone-large,ced-standalone-small,ced-standalone-large
```

### Hosted full-stack measurements

`Full-stack frontend performance` runs daily at **03:17 UTC** and on manual dispatch. Its
identical workflow lives on `main` (required for GitHub scheduling) and `develop`, with a pinned
harness checkout independent of release source changes. It provisions a fresh Ubuntu 24.04
GitHub-hosted runner and runs all modern scenarios against real Docker-hosted CEDAR APIs and
Keycloak. It consumes the completed immutable train `2.9.33-dev.20261107.2016`; image digests and
standalone CEE/CED/term-picker tarball hashes are verified before measuring. The train’s resource
image omitted its fresh-database
bootstrap admin-tool JAR; CI mounts the matching train JAR read-only, verifies its pinned SHA-256,
and records that dependency separately. New image builds fail if that JAR is missing or corrupt.
CI also mounts the corrected Designer entrypoint from the pinned Docker tooling: it verifies
the published page inventory and only generates runtime configuration, without recompiling UI
assets. The train image’s older entrypoint attempted a build without the source lockfile. Both
bootstrap additions are recorded as calibration inputs; train image tags remain unchanged.
This is a fixed calibration baseline, not a moving develop build. Updating the train or pinned
tooling intentionally starts a new comparable cohort.

The job generates private ephemeral datastore/service credentials and a fresh read-only monitoring
identity, uses only synthetic fixtures, and contacts no production CEDAR deployment. It uses the
existing Nexus image credentials to pull published images. No self-hosted runner, workstation
session, local monitoring account or open application is needed. Fixed text-field scenarios need
no production terminology corpus and do not benchmark external BioPortal searches.

Published application assets are copied from the verified containers into the existing HTTPS
performance lab, with real SSO/API calls still reaching the isolated stack. Standalone bundles come
from the same train's verified npm completion record. `--deployment-manifest` selects these inputs
without a local reactor build; the default developer command continues to use local sources.
All resource ceilings, source identities, image digests, browser/Node versions and machine metadata
are recorded. OpenView, Monitoring and Bridging in this train compile the production domain into
one environment literal rather than reading the container's domain setting. The lab verifies the
captured bytes first, changes only that literal to `.orgx` in its copy, and records before/after
hashes. Chromium blocks production `.org` hostnames before authentication; this DNS guard preserves
HTTP caching, unlike request interception. Java services have 512 MiB heaps / 768 MiB limits,
OpenSearch and Neo4j 512 MiB heaps / 1536 MiB limits, and Keycloak a 512 MiB heap / 1024 MiB limit.
These are CI fixture settings, not production sizing guidance. Shared hosted hardware can be
noisy; timings stay reporting-only.

Reports, CSV, screenshots and immutable input evidence are retained as `full-stack-performance`
for 90 days, sanitized service diagnostics for 14 days. The readiness review archives compact
measurements beyond individual artifact retention. The job stops its stack even after failures;
GitHub disposes of the runner and its temporary volumes. Broken pages, loading contracts and
fixture cleanup still fail the job; timing values alone do not.

Manual dispatch accepts five repetitions for calibration or one for a coverage check. A single-
repetition run has 68 samples and never counts toward the 14-day full-stack review.

The [initial hosted baseline](https://github.com/metadatacenter/cedar-development/actions/runs/42497465804)
on 2026-11-08 passed all 340 samples with verified fixture cleanup. Its
[automatic review](https://github.com/metadatacenter/cedar-development/actions/runs/42499993039)
retained the evidence as the first comparable daily run. Hosted and workstation measurements are
separate cohorts; their timings are not a before/after comparison.

The fixed baseline's executable inputs are retained in place under narrow Nexus cleanup
exceptions: all 27 images of this exact train, its three standalone CEE/CED/term-picker packages,
and its matching admin-tool component. Their URLs and bytes remain unchanged, preserving the
existing calibration cohort. Both the three-day and thirty-day policies exclude these inputs;
the same exceptions retain the fixed isolated CEE control's exact model and design-token
dependencies. The isolated CED and Designer controls already resolve their internal dependencies
from the retained npm registry.
Downloads alone do not extend ordinary artifact retention. The reviewed policy changes and
server-side preview evidence are in [frontend-performance-retention.json](frontend-performance-retention.json).
The previews simulated all artifact ages and proved that every other cleanup selection remained
unchanged. Retire these exceptions explicitly when this baseline is no longer needed; do not
remove them merely because individual reports have been archived. A future baseline requires
equivalent input retention before it begins collecting comparable daily runs.

### Optional workstation scheduling

The unattended sweep uses hosted CI; the former workstation LaunchAgent is removed. The local
CLI remains available for explicitly requested workstation investigations. If deliberately
installed again, its sweep runs at **03:30 Europe/Madrid**, with DST handled
explicitly. Install or inspect it through the CLI:

```bash
cedarcli test frontend-performance-schedule --install
cedarcli test frontend-performance-schedule --status
cedarcli test frontend-performance-schedule --check
# Stop future scheduled runs:
cedarcli test frontend-performance-schedule --remove
```

The macOS user LaunchAgent checks hourly at minute 30 but runs measurements only during the
03:30–03:39 Madrid window. It does not wake the machine or catch up outside that window.
The user must be logged in and the local stack running. No GitHub self-hosted runner is installed.
`--check` only reports the time/activity decision; it does not measure or modify state.

A sweep needs ten minutes without keyboard/mouse input, other processes using at most 60% of
one logical CPU, the local stack lock available, clean relevant source trees, current component
bytes, the existing private monitoring account, and 10 GiB free disk space. It never stashes,
pulls, deploys, publishes, starts the stack or changes permissions. It performs the normal
isolated production preparation and five repetitions of all 17 modern scenarios (340 loads).
Clean trees are an unattended measurement safeguard, not a prerequisite for development builds.

Activity is checked every 15 seconds, excluding this sweep's own descendants. If work resumes,
activity becomes unreadable or measurements reach 45 minutes, the suite is interrupted gracefully:
preparation stops, Chromium closes and temporary fixtures are deleted and verified. Cleanup
is allowed to finish. An unverified completion or cleanup error blocks later sweeps pending
investigation; do not remove that guard without checking `fixtures.json` against the local stack.

Evidence lives under `.cedar/reports/frontend-performance/scheduled/`: `latest.json` records the
latest decision, `last-run.json` preserves the last started run and its cleanup status, and each
`nightly-*` directory holds the report and `scheduled.json`. Skipped hours cannot erase an
unverified run. `latest.log` records the latest sweep; `launchd.log` records scheduler invocations.
Owned reports are retained for 30 days and their frozen lab files for seven days. Cleanup-failure
evidence is retained for investigation. The LaunchAgent contains no credentials; the existing
mode-0600 monitoring account file is read only into the child process environment.

### Measurement coverage and method

The default covers Workspace's dashboard and metadata editor, Template Designer, OpenView
template pages, Bridging and Monitoring dashboards, the content index, standalone CEE and
CED, and the standalone term picker. Editor pages use fixed 5-field and 100-field text
templates. OpenView's root redirects away, so the suite measures useful artifact pages
instead. No legacy application is opened. The term-picker measurement ends when its empty
search control is usable; external terminology searches and DOI submissions are outside
this baseline. Editing measurements type an answer or change a displayed field label;
they do not save to the server.

The suite copies the staged production Workspace and Template Designer into its report
directory. OpenView, Monitoring, Bridging and Content are built there with their production
configuration and existing dependencies. The only source adjustment in those disposable
copies is the deployment domain, from `.org` to `.orgx`. Standalone components come from the
hash-verified packages selected by `.reactor/runtime.json`. If application sources have
changed since the last development build, refresh them with `cedarcli build frontends`
before measuring. `lab/artifacts.json` records checkout revisions/status, the reactor
selection and SHA-256/size of every served file, plus the measurement-suite files.
In the copied Workspace/Designer `config/version.js`, `cedarDevelopmentMode` is set to false
to select server cache behavior; otherwise native development's per-navigation URL cache
busting would invalidate the warm measurement. These lab-only adjustments are recorded.

A Chromium-private host mapping serves those files over an isolated loopback HTTPS/HTTP/1.1 server;
normal local APIs and SSO still go through nginx. HTML uses `no-store`; assets use gzip when
appropriate and a one-hour cache. These are explicit laboratory delivery settings, not a
measurement of production nginx/CDN/TLS latency. Browser request interception is not used,
because it disables the HTTP cache. Sign-in happens before measurement and its credentials
stay in memory. Subsequent silent SSO and redirects count toward page readiness.

Monitoring requires an account with `MONITOR_READ`. The suite never changes roles. To use
an existing authorized local account, provide `CEDAR_PERF_MONITOR_LOGIN` and
`CEDAR_PERF_MONITOR_PASSWORD` in the invocation environment; it gets a separate browser
session. Otherwise Monitoring uses the ordinary test account. A denial is reported as missing
coverage, and the other pages continue. See the backend runbook's read-only Monitor access
procedure before granting access.

The local baseline uses the dedicated `frontend-perf-monitor@test.com` identity with
`normal` plus `monitorViewer`, leaving existing users unchanged. Its generated password is
stored only in `$CEDAR_HOME/.cedar/secrets/frontend-perf-monitor.json` (owner read/write,
mode 0600), with `username` and `password` keys; load those values into the two invocation
environment variables above for subsequent runs. Never commit that file or include its
contents in a report. The local realm required the documented `monitorViewer` role setup;
CEDAR's stored permissions were then updated for this account alone using its existing
permission-expansion/user-service libraries. The added permission was exactly
`permission_monitor_read`, and the protected `/health-check/monitor` endpoint returned 200.

Each repetition starts with a fresh browser context and cleared HTTP cache. It measures a
cold navigation, leaves the page, then measures a warm navigation in the same tab. Interaction
measurements follow the warm load only, so retained editing drafts cannot change the next
load's content. Repetitions rotate scenario/profile order and run sequentially. Temporary
local templates live in a dedicated folder and are deleted, with GET verification, at the
end; `fixtures.json` records their identities and cleanup outcome. An interrupt closes the
browser and still attempts cleanup.
Workspace's dashboard opens that controlled two-template folder rather than a test user's
changing home-folder contents.

The default now includes two `ced-integrated-small` / `ced-integrated-large` scenarios
(17 scenarios, 340 samples at five repetitions). These load the exact hash-verified shared
CEE/CEF, term-picker and CED bundle from Designer's staged component manifest, plus its host
fonts, into a minimal standalone page. They do not authenticate or fetch a repository artifact.
Both integrated CED and Designer wait for every real CEF field summary through the components'
shadow roots. Bare `ced-standalone-*` remains unchanged and exercises CED's lightweight fallback
summaries without CEE. Use the integrated comparison to separate host overhead from richer
field rendering; the bare comparison alone cannot establish wrapper cost. Capture a fresh
before/after pair when changing this readiness predicate, rather than mixing earlier timings.

| Profile | CPU | Network |
| --- | --- | --- |
| Normal | No slowdown | No artificial network limits |
| Constrained | 4× slowdown | 1.6 Mbit/s download, 0.75 Mbit/s upload, 150 ms latency |

The CPU multiplier is relative to the recorded machine, not a calibrated phone model.
Reports include browser/Node versions, viewport, machine identity and load samples.
They report median and min–max, rather than estimating population percentiles from five runs.
Readiness/action probes target the fixture's input elements directly. CPU profiling found
that broad accessible-name queries in the original baseline walked all 100 fields and
contributed their own long tasks. Compare optimization results only against a rerun using
the same direct probes; a lower measurement after changing the probe is not an application
speedup. The original baseline below remains historical evidence, including that overhead.

Workspace dashboard readiness also waits for the two fixture templates' action-report responses.
The listing's `aria-busy` clears before that background enrichment finishes, so listing readiness
alone can truncate real requests on a cold deployment. The probe waits for completed Resource
Timing entries, retaining failures for missing, failed or unfinished requests; it does not add a
fixed delay or suppress loading errors. Do not compare this readiness value with the earlier
listing-only probe as an application speed change. The pinned daily calibration harness remains
unchanged and retains its existing cohort.

Outputs default to `.cedar/reports/frontend-performance/<timestamp>/`: `report.html`,
`report.json`, `samples.csv`, first-run screenshots and build/fixture evidence. `--output`
selects an **empty** directory; earlier measurements are never overwritten. JSON retains
per-request transfer/cache/timing information without URL query strings, layout-shift and
long-task entries, and failures. Paint and layout metrics cover the final top-level document
through one second after controls and fonts are ready. CEDAR readiness includes navigation
and any redirects. LCP can describe an early header rather than an editor becoming usable,
so always read it alongside readiness. `blockingOver50Ms` is the sum of long-task duration
beyond 50 ms in that window, **not Lighthouse TBT**. Scripted action completion and observed
Event Timing entries are **not real-user INP** or proof of Core Web Vitals compliance.
The [Web Vitals reference](https://web.dev/articles/vitals) describes the real-user targets
and their 75th-percentile assessment; these five-run laboratory distributions are diagnostic.
In particular, the lab's HTTP/1.1 connection behavior can differ from a production HTTP/2 or
HTTP/3 delivery. Compare identical lab settings, and verify deployment timings separately.

<a id="frontend-performance-baseline"></a>

### Baseline — 2026-11-07

Across two runs, the baseline contains **300 valid samples covering all 15 scenarios**:
two profiles × two cache states × five repetitions per scenario. All temporary templates
and their folders were deleted and GET-verified absent.

The 12:53–13:08 UTC run collected 280 samples for 14 scenarios. Its original report remains
explicitly incomplete (exit 1): the ordinary test account lacked `MONITOR_READ`, and no denial
page was counted as a fast dashboard. The separate **13:29–13:30 UTC Monitoring supplement**
used the authorized dedicated account described above and collected the remaining 20 samples.
It completed with exit 0, no setup/sample failures and no cleanup errors. Original reports
are preserved separately rather than rewriting the first run's coverage or source identity.

Evidence is under `$CEDAR_HOME/.cedar/reports/frontend-performance/baseline-20261107/`:
`report.html`, `report.json`, `samples.csv`, `fixtures.json` and `lab/artifacts.json`.
Measurement code: `cedar-development@10387aaf`; CLI: `cedar-cli@323f7d0`.
The machine was an Apple M4 Max, 16 logical CPUs, 64 GiB RAM, macOS/Darwin 25.6.0,
Chromium 156.0.8078.4 and Node 24.22.1, at 1440×1000. Desktop applications remained running;
a backup process used roughly one CPU before the run. One-minute load was 4.32 at the start
and 3.35 at the end. No other build or test was launched by this suite during measurement.

Monitoring evidence is under
`$CEDAR_HOME/.cedar/reports/frontend-performance/monitoring-20261107/`, with the same report,
CSV, fixture and artifact files. It used the same machine, browser, Node, viewport and
measurement profiles; one-minute load was 2.99 at the start and 3.77 at the end.
Measurement code: `cedar-development@26fd9500`; CLI: `cedar-cli@323f7d0`.
Monitoring source was clean at `e24c81139f55bd399ef451e1b2e0788e2b8f012c`; the served output
inventory SHA-256 is `71318f25d754d6bf55e8f876ab89f375520f787c25195c3ab298f61d29e9884d`.
All 20 Monitoring samples recorded CLS 0. The dashboard screenshot confirms the useful page,
and the protected Monitor endpoint returned 200 for the dedicated account before measurement.

The selected reactor graph was
`3ac338512087a00bed874724072406fe24f705785a0c5ef2f270fce888bd6771`.
Standalone CEE used package `52517b1ad7f885f4ec7cc5e0b89b3e860ff609737ad7db3e9e86afcc649b3d5b`;
standalone CED used `f5580c287bc35e90a65621ebf3069778309e89c49234986b24df55c9ff97e847`.
Workspace's staged reactor input was base `6a43eede` with source digest `cf092c45c6e8`,
and Designer's was base `040db154` with source digest `0b3b2fa6c43b`; both reactor inputs
included uncommitted edits when built. The retained output inventories identify the measured
bytes, and the report separately records checkout heads at capture. Standalone components
remain the self-contained package variants, including their fonts.

**Page readiness, seconds: median (minimum–maximum).** Small means five text fields;
large means 100. These are full navigations to the page, not an in-app route transition.
Readiness includes useful controls and font readiness, with the exact predicate in the report.

| Page | Normal, cold | Normal, warm | Constrained, cold | Constrained, warm |
| --- | --- | --- | --- | --- |
| Workspace dashboard | 0.32 (0.31–0.34) | 0.26 (0.24–0.27) | 3.67 (3.65–3.73) | 2.14 (2.13–2.21) |
| Monitoring dashboard (supplement) | 0.34 (0.34–0.34) | 0.24 (0.22–0.33) | 3.63 (3.62–3.69) | 2.05 (2.05–2.07) |
| Bridging dashboard | 0.24 (0.24–0.24) | 0.24 (0.21–0.24) | 3.21 (3.20–3.23) | 2.03 (2.03–2.04) |
| Content index | 0.04 (0.04–0.04) | 0.04 (0.04–0.04) | 0.38 (0.37–0.39) | 0.22 (0.21–0.22) |
| Standalone term picker | 0.07 (0.07–0.09) | 0.06 (0.05–0.06) | 1.53 (1.50–1.53) | 0.25 (0.23–0.26) |
| Standalone CEE, small | 0.14 (0.14–0.17) | 0.07 (0.07–0.07) | 3.93 (3.92–3.94) | 0.49 (0.48–0.49) |
| Standalone CEE, large | 0.21 (0.21–0.21) | 0.12 (0.12–0.12) | 4.18 (4.16–4.20) | 0.69 (0.66–0.69) |
| Standalone CED, small | 0.17 (0.17–0.21) | 0.12 (0.11–0.12) | 3.38 (3.35–3.40) | 0.61 (0.58–0.62) |
| Standalone CED, large | 0.51 (0.51–0.52) | 0.42 (0.42–0.44) | 4.73 (4.70–4.76) | 1.90 (1.88–1.93) |
| Template Designer, small | 0.94 (0.94–0.96) | 0.84 (0.84–0.86) | 10.23 (10.09–10.24) | 2.75 (2.71–2.77) |
| Template Designer, large | 1.12 (1.09–1.12) | 0.92 (0.91–0.96) | 12.49 (12.32–13.24) | 4.92 (4.86–4.96) |
| Workspace metadata editor, small | 0.87 (0.82–0.91) | 0.34 (0.34–0.37) | 7.85 (7.80–7.88) | 2.53 (2.51–2.54) |
| Workspace metadata editor, large | 0.96 (0.84–0.98) | 0.84 (0.36–0.86) | 8.11 (8.03–8.14) | 3.17 (3.11–3.22) |
| OpenView template, small | 0.19 (0.17–0.26) | 0.09 (0.09–0.24) | 4.88 (4.85–4.89) | 0.52 (0.51–0.53) |
| OpenView template, large | 0.26 (0.24–0.26) | 0.14 (0.14–0.16) | 5.01 (5.00–5.03) | 0.67 (0.63–0.68) |

The original constrained medians identified these costs (historical findings, addressed below):

- **Designer loading/layout:** small/large readiness is 10.23/12.49 s cold and 2.75/4.92 s
  warm. Recorded CLS is 0.884 for both sizes and cache states. The largest shift happens
  before editing, changing a nearly unstyled 1424×55 rectangle at (8,8) into a 1440×1000
  rectangle at (0,0). The host inserts its stylesheet dynamically and imports further
  stylesheets; late styling is a candidate to trace, not a proved sole cause. An early
  header can become LCP while the editor is still loading.
- **Large-form CPU work:** standalone CED records 1,292 ms of long-task time over 50 ms cold
  and 1,005 ms warm; the Designer host records 2,476/2,148 ms. Standalone CEE records
  380/145 ms. These are the explicitly defined observation-window diagnostics, not TBT.
  Warm scripted action medians are 395 ms for typing and blurring the CEE answer, 543 ms
  for the CED label edit, 613 ms for the hosted Designer label edit and 578 ms for the
  Workspace answer sequence. They cover different whole gestures, not comparable INP values.
- **OpenView layout:** the small/large template records CLS 0.097/0.134 in both cold and
  warm constrained loads. Capture the contributing render transitions before choosing a fix.
- **An avoidable Workspace request:** every metadata-editor sample requests
  `/assets/i18n-cee/en.json`, receives 404 and falls back to CEE's built-in English map.
  This also returns 404 on the normally served local Workspace. The failed request takes
  a median 163 ms under the constrained profile; its contribution to the critical path
  needs tracing. The configured prefix should either name a real override or be omitted
  when built-in translations are intended.

The [measured optimization comparison](#frontend-performance-optimizations) records the fixes
and corrected before/after measurements. None of these figures is a production SLA or a field
Core Web Vitals verdict.

<a id="frontend-performance-optimizations"></a>

### Measured optimizations — 2026-11-07

Four changes preserve the existing completed pages and independent standalone CEE/CED use:

- Workspace uses CEE's built-in translations directly, retaining language selection and
  fallback without requesting the nonexistent external map.
- Designer registers its versioned stylesheet in the document head before the body paints,
  fetches independent startup modules concurrently, and shares one versioned core/state/
  translation module graph. It retains the existing shared-editor delivery arrangement.
- CED creates each field's settings controls when first opened, then retains their DOM and
  unfinished input through collapse/reopen. Validation can reveal an unopened panel;
  standalone field-document mode still starts expanded. Card summaries and previews remain.
- OpenView reveals the footer after content or its existing error state is ready. This
  approved change affects loading presentation only; the final footer layout and content
  stay the same, including error pages.

The corrected **before** run, `2026-11-07T13:35:28.456Z` to `2026-11-07T13:47:04.058Z`,
contains 200 valid samples for the ten editor/form scenarios. The **after** run,
`2026-11-07T14:24:25.041Z` to `2026-11-07T14:38:45.993Z`, contains 300 valid samples for all
15 modern scenarios. Both use five repetitions, both profiles, both cache states, the same
machine/browser/viewport and the same direct probes. No build or test ran alongside either
measurement loop. Both runs completed without sample/setup failures or cleanup errors;
temporary fixtures were deleted and GET-verified absent. Legacy pages are excluded.

Evidence directories under `$CEDAR_HOME/.cedar/reports/frontend-performance/` are
`optimization-before-20261107/` and `optimization-after-20261107/`, each containing
`report.html`, `report.json`, `samples.csv`, screenshots and `lab/artifacts.json`.
The measurement-suite inventory is identical:
`41b21f4e255e8a28a4657fb9469165aeddf861cdffaf6cfadbf4efd8f6158801`
(`cedar-development@dcc395cb`; the before capture recorded its then-uncommitted probe change).
For the five unchanged landing/picker pages, the comparison below uses the original baseline
and Monitoring supplement described above: their probes were unchanged by that correction.
Thus those five rows compare separate earlier captures, not the ten-scenario corrected run.
The report files retain every range and request rather than just the medians below.

| Application | Verified and pushed change |
| --- | --- |
| Workspace | `6bcb6757` |
| Standalone CED and its host consumers | `9f3ad3d` |
| Template Designer host | `aa9173a9` |
| OpenView | `101c676` |

The before reactor graph is `3ac338512087a00bed874724072406fe24f705785a0c5ef2f270fce888bd6771`;
the after graph is `5ac9a38f46b3134d7239e4d9b4fcabdb4242b5f226bc0ed38905a0426ada4e02`.
The standalone CED package changed from
`f5580c287bc35e90a65621ebf3069778309e89c49234986b24df55c9ff97e847` to
`90265f601eb3032b83e8db1d77610acd5576733f1fb842fb45abe181238403b5`.
Standalone CEE is byte-for-byte the same package,
`52517b1ad7f885f4ec7cc5e0b89b3e860ff609737ad7db3e9e86afcc649b3d5b`.
The reactor captured the application edits before their commits; its input/output hashes
identify the tested bytes. The after report records the clean committed application heads.

**Constrained page readiness, seconds: before → after medians.**

| Page | Cold | Warm |
| --- | --- | --- |
| Workspace dashboard | 3.67 → 3.65 | 2.14 → 2.15 |
| Monitoring dashboard | 3.63 → 3.62 | 2.05 → 2.05 |
| Bridging dashboard | 3.21 → 3.20 | 2.03 → 2.03 |
| Content index | 0.38 → 0.37 | 0.22 → 0.22 |
| Standalone term picker | 1.53 → 1.52 | 0.25 → 0.25 |
| Standalone CEE, 5 fields | 3.95 → 3.93 | 0.48 → 0.48 |
| Standalone CEE, 100 fields | 4.18 → 4.19 | 0.68 → 0.68 |
| Standalone CED, 5 fields | 3.39 → 3.29 | 0.60 → 0.51 |
| Standalone CED, 100 fields | 4.50 → 3.68 | 1.66 → 0.85 |
| Template Designer, 5 fields | 10.08 → 8.14 | 2.71 → 2.62 |
| Template Designer, 100 fields | 12.40 → 9.33 | 5.00 → 3.80 |
| Workspace editor, 5 fields | 7.83 → 7.82 | 2.52 → 2.52 |
| Workspace editor, 100 fields | 8.10 → 8.03 | 3.17 → 3.15 |
| OpenView, 5 fields | 4.88 → 4.90 | 0.52 → 0.52 |
| OpenView, 100 fields | 5.06 → 5.08 | 0.68 → 0.68 |

**Normal page readiness, seconds: before → after medians.**

| Page | Cold | Warm |
| --- | --- | --- |
| Workspace dashboard | 0.32 → 0.27 | 0.26 → 0.24 |
| Monitoring dashboard | 0.34 → 0.32 | 0.24 → 0.24 |
| Bridging dashboard | 0.24 → 0.24 | 0.24 → 0.21 |
| Content index | 0.04 → 0.04 | 0.04 → 0.04 |
| Standalone term picker | 0.07 → 0.07 | 0.06 → 0.06 |
| Standalone CEE, 5 fields | 0.14 → 0.16 | 0.07 → 0.07 |
| Standalone CEE, 100 fields | 0.21 → 0.21 | 0.12 → 0.12 |
| Standalone CED, 5 fields | 0.17 → 0.16 | 0.11 → 0.09 |
| Standalone CED, 100 fields | 0.46 → 0.26 | 0.37 → 0.17 |
| Template Designer, 5 fields | 0.93 → 0.89 | 0.36 → 0.34 |
| Template Designer, 100 fields | 1.06 → 0.89 | 0.86 → 0.59 |
| Workspace editor, 5 fields | 0.87 → 0.86 | 0.34 → 0.34 |
| Workspace editor, 100 fields | 0.94 → 0.92 | 0.40 → 0.39 |
| OpenView, 5 fields | 0.19 → 0.19 | 0.09 → 0.09 |
| OpenView, 100 fields | 0.24 → 0.24 | 0.14 → 0.14 |

**Constrained large-form CPU observation, milliseconds over 50 ms: median (minimum–maximum).**

| Page | Cold before | Cold after | Warm before | Warm after |
| --- | --- | --- | --- | --- |
| Standalone CEE, 100 fields | 411 (397–505) | 416 (376–619) | 155 (142–219) | 153 (145–272) |
| Standalone CED, 100 fields | 1360 (1353–1411) | 586 (522–764) | 1054 (1026–1132) | 304 (301–431) |
| Template Designer, 100 fields | 2691 (2525–2797) | 1569 (1473–2087) | 2416 (2294–2884) | 1396 (1212–1793) |

**Constrained CLS medians (the cold and warm values agree).**

| Page | Before | After |
| --- | --- | --- |
| Template Designer, 5 fields | 0.884 | 0.013 |
| Template Designer, 100 fields | 0.884 | 0.013 |
| OpenView, 5 fields | 0.097 | 0.000 |
| OpenView, 100 fields | 0.134 | 0.000 |

Large standalone CED warm readiness fell 49%, with 71% less observed long-task time beyond
50 ms. Large hosted Designer readiness fell 25% cold and 24% warm. Its remaining loading and
preview work is still included in these timings. Standalone CEE has no product change;
variation in its timings is a useful
control when interpreting small differences elsewhere. Workspace's improvement is removal
of the failed request, not a demonstrated general load-time speedup.

All 40 after samples for the Workspace editor omit `/assets/i18n-cee/en.json`; there is no
fallback 404. Designer's real-browser gate verifies one request each for its core, state,
i18n module and both language maps. OpenView records zero CLS in all 40 after samples.
Its readiness timings remain broadly comparable; the intended gain is layout stability.

The authoritative frontend reactor passed build/checks, local redeployment, served-bundle
verification and every whole-stack smoke tier. CED passed 14,454 unit tests, 1,137 browser
tests (one existing skip), and all 25 unchanged visual baselines. Designer passed 633 unit
and 404 browser tests; OpenView passed 283 unit and 186 browser tests. Workspace's existing
unit/browser checks passed too. No screenshot baseline was updated. Comparing the ten
before/after performance screenshots found nine pixel-identical images; standalone CED's
small image differed only at ten antialiased border pixels. Manual review also confirmed
the normal forms and footer retain their appearance. Tests cover retained unfinished input,
validation opening a lazy panel, and OpenView's delayed success and failure presentations.

The suite remains reporting-only. These are local laboratory measurements under the stated
network/CPU profiles, not production load times, Lighthouse TBT or real-user INP.

<a id="designer-equivalent-performance"></a>

### Designer startup and equivalent rendering — 2026-11-07

The bare standalone CED page uses fallback summaries; Designer loads real CEF summaries,
CEE preview and the term picker. The `ced-integrated-*` benchmark uses Designer's exact
shared component bundle and fonts without authentication or repository reads. Comparing
this page with Designer separates host startup from richer field rendering. Both wait for
all five or 100 real summaries, so these results use a fresh matched baseline rather than
reusing the earlier Designer readiness measurements.

| Piece | Pushed source |
| --- | --- |
| Equivalent benchmark and large-only authenticated scenario selection | `cedar-development@0fa20014` |
| Component download alongside SSO; authenticated artifact/permission reads alongside profile | `cedar-template-designer@ac958e8a` |
| One bundled host module and stylesheet, including translations, with content-based cache identities | `cedar-template-designer@f9365046` |
| Independent CEE/CEF translation roots, avoiding sibling language broadcasts | `cedar-embeddable-editor@299265b2` |

The startup overlap preserves the authorization boundary: no private API reads before
sign-in, and the designer stays hidden/inert until access is known. Early rejected work is
observed and still reaches the existing error handling. Bundling preserves stylesheet
order, existing hashed font URLs, deferred validation/RDF loading and host interactions.
No tracked registry pin or release version changes are needed for the local reactor.

The language change also fixes a demonstrated embedding defect. In the frozen before bundle,
creating an English CEF followed by a Hungarian CEF changed the English instance to Hungarian
(`en → hu`). The same probe against the after bundle leaves it English (`en → en`), while
the second instance remains Hungarian. Browser tests also cover independent CEE and CEF
instances together. Their public embedding inputs and standalone packaging remain intact.

Evidence under `$CEDAR_HOME/.cedar/reports/frontend-performance/`:

- `designer-equivalent-before-20261107/`: 160 valid samples, eight editor scenarios,
  `2026-11-07T14:52:25.148Z`–`2026-11-07T15:00:31.714Z`.
- `designer-equivalent-after-20261107/`: 340 valid samples, all 17 modern scenarios,
  `2026-11-07T15:29:35.525Z`–`2026-11-07T15:45:14.003Z`.
- `designer-overlap-after-20261107/`: intermediate diagnostic after startup overlap alone;
  18 samples, three repetitions under the constrained profile, with unchanged component
  bytes. Small/large Designer cold medians were 6.61/7.86 seconds. This shorter capture
  isolates that piece but is not the final five-repetition comparison.
- `designer-equivalent-profile-before-20261107/` and
  `designer-equivalent-profile-after-20261107/`: warm CPU profiles and the language-isolation
  probe against the respective frozen bundles; collected outside timing loops.

Both main runs use five repetitions, normal/constrained profiles and cold/warm cache states,
Chromium 156.0.8078.4 on the same Apple M4 Max, 1440×1000 viewport, and identical measurement
suite `0fa20014` (inventory SHA256
`fd9a3b4ab6d51c02d7bf9879a5fdf7c1dbe9e5fe6fbba2e3a173d6f86d1686ba`).
No builds or tests ran during measurement. All samples passed; both runs completed with no
setup failures or cleanup errors, and temporary fixtures were deleted and GET-verified absent.
Reports retain per-sample ranges, requests, source identities and screenshots. Legacy pages
are excluded from this performance suite.

**Constrained readiness, seconds: before → after medians.**

| Page | Cold | Warm |
| --- | --- | --- |
| Standalone CEE, 5 fields | 3.93 → 3.97 | 0.48 → 0.49 |
| Standalone CEE, 100 fields | 4.15 → 4.18 | 0.68 → 0.68 |
| Bare standalone CED, 5 fields | 3.28 → 3.28 | 0.52 → 0.52 |
| Bare standalone CED, 100 fields | 3.62 → 3.63 | 0.85 → 0.84 |
| Equivalent CED with CEF, 5 fields | 4.56 → 4.56 | 0.63 → 0.62 |
| Equivalent CED with CEF, 100 fields | 5.45 → 5.36 | 1.45 → 1.40 |
| Template Designer, 5 fields | 8.13 → 5.54 | 2.63 → 2.14 |
| Template Designer, 100 fields | 9.29 → 6.65 | 3.62 → 3.18 |

**Normal readiness, seconds: before → after medians.**

| Page | Cold | Warm |
| --- | --- | --- |
| Standalone CEE, 5 fields | 0.14 → 0.14 | 0.07 → 0.07 |
| Standalone CEE, 100 fields | 0.21 → 0.21 | 0.12 → 0.12 |
| Bare standalone CED, 5 fields | 0.16 → 0.16 | 0.09 → 0.09 |
| Bare standalone CED, 100 fields | 0.24 → 0.24 | 0.17 → 0.17 |
| Equivalent CED with CEF, 5 fields | 0.21 → 0.21 | 0.12 → 0.12 |
| Equivalent CED with CEF, 100 fields | 0.42 → 0.41 | 0.32 → 0.31 |
| Template Designer, 5 fields | 0.89 → 0.36 | 0.84 → 0.35 |
| Template Designer, 100 fields | 0.91 → 0.57 | 0.84 → 0.55 |

Designer cold readiness fell 32% for five fields and 28% for 100; warm readiness fell 19%
and 12%. Cold requests fell from 46 to 24 (warm 43 to 21). Large cold transfer fell from
832,293 to 805,670 bytes, so eliminating request chains and overlapping work accounts for
more of the gain than the roughly 27 KB transfer reduction. Cold constrained Designer CLS
is now zero; warm CLS remains approximately 0.013.

For 100 fields, constrained observed blocking time beyond 50 ms fell from 1,579 to 1,462 ms
cold and 1,219 to 1,067 ms warm in Designer. Equivalent CED fell from 1,183 to 1,105 ms cold
and 878 to 824 ms warm. The equivalent renderer's readiness change is small and its sample
ranges overlap (warm before 1,433–1,578 ms; after 1,384–1,618 ms); this is not evidence of a
large rendering speedup. Bare CED and standalone CEE remain essentially unchanged. Real CEF
DOM/style construction still costs more than fallback summaries; the host additionally
performs SSO and repository/permission reads. The page is therefore not just a negligible
wrapper around the bare benchmark.

The other nine modern scenarios were rerun as coverage/control measurements. Their after
constrained cold/warm medians, in seconds, are Workspace dashboard 3.71/2.19, Monitoring
3.67/2.05, Bridging 3.20/2.04, content index 0.39/0.22, term picker 1.53/0.25, Workspace editor
5 fields 7.84/2.52 and 100 fields 8.12/3.20, OpenView 5 fields 4.88/0.52 and 100 fields
5.08/0.68. These have no newly captured matched before run in this comparison. All 40
OpenView samples retain zero CLS. All 40 Workspace editor samples omit the missing external
translation request and record no network failures.

The after reactor graph is
`a7e1b8ce31b1685f4746891131fcff6704f5424cec974b12466fe0bf5f9a08f0`, compared with before
`5ac9a38f46b3134d7239e4d9b4fcabdb4242b5f226bc0ed38905a0426ada4e02`.
CEE package SHA256 changed from
`52517b1ad7f885f4ec7cc5e0b89b3e860ff609737ad7db3e9e86afcc649b3d5b` to
`a405e3844f8a25fe3c7cff33384c7a32106c4dd88630a015d157879d34088265`.
Bare CED remains the identical package
`90265f601eb3032b83e8db1d77610acd5576733f1fb842fb45abe181238403b5`.
The report's artifact inventory identifies the host output and shared component bytes too.

The full reactor passed build/checks, all three CEE framework consumer demos, deployment,
served-bundle verification and every whole-stack smoke tier. Designer passed 634 unit and
406 browser tests; CEE passed 1,265 unit, 5,825 domain, 100 coordinator and 1,600 browser/visual
tests (104 existing skips). CED passed 14,454 unit, 1,137 browser tests (one existing skip) and
25 unchanged visual baselines. The benchmark's eight checks passed, including large-only
authenticated selection. No visual baseline was updated. Five of eight matched performance
screenshots are pixel-identical, including both Designer pages and both standalone CEE pages;
the other three CED images differ only at 2, 10 and 14 border pixels by one colour level.
Manual inspection confirms the same completed layout, controls and summaries. Measurements
remain reporting-only local laboratory results, not production timings or real-user INP.

<a id="cef-summary-performance"></a>

### CEF summary initialization — 2026-11-07

`cedar-embeddable-editor@8797a77e` removes a second model read from single-field
initialization. CEF still strictly reads the supplied field, constructs its one-field
template, and retains the canonical JSON source for validation. It passes the already-read
model through the same model-to-component mapper used by ordinary templates, instead of
reading its own serialized wrapper again. Each field still gets its own model, instance,
validation state and translation service. Public embedding inputs, UI, styles and ordinary
standalone CEE template parsing are unchanged.

This is a small initialization saving, not a major page-load reduction. Five paired
repetitions of frozen before/after builds show the following constrained medians:

| 100-field page | Cold readiness, seconds | Warm readiness, seconds |
| --- | --- | --- |
| Standalone CEE | 4.152 → 4.151 | 0.667 → 0.668 |
| Bare standalone CED | 3.617 → 3.619 | 0.835 → 0.835 |
| Equivalent CED with real CEF summaries | 5.385 → 5.321 | 1.402 → 1.364 |
| Template Designer | 6.619 → 6.584 | 3.183 → 3.114 |

Equivalent CED is about 2.7% faster warm, and Designer about 2.2%. All five pairs favor the
optimized path for both pages, cold and warm. Equivalent CED warm savings per pair are
31–83 ms; Designer's are 16–122 ms. Unchanged standalone controls remain stable. These five
observations do not establish population percentiles or production latency.

Observed constrained blocking time beyond 50 ms also falls:

| 100-field page | Cold, milliseconds | Warm, milliseconds |
| --- | --- | --- |
| Equivalent CED with CEF | 1122 → 1067 | 824 → 789 |
| Template Designer | 1447 → 1406 | 1089 → 1017 |

**Why the paired replay matters.** Fresh ordinary before and after runs each completed 160
valid samples: five repetitions of eight editor scenarios, both profiles and cache states.
Other browser activity coincided with the after capture; unchanged bare CED warm readiness
shifted from 0.83 to 1.00 seconds and standalone CEE from 0.67 to 0.77 seconds. Equivalent CED
shifted 1.39 → 1.56 seconds and Designer 3.17 → 3.22 seconds in those separate runs. Those
comparisons cannot isolate this source change. All original samples are retained; none were
removed as outliers.

The supplemental replay alternates the frozen before/after artifact roots within each
scenario/repetition, reverses version order on alternate repetitions, and rotates scenario
order. It uses the existing suite's HTTPS/gzip server, real SSO/backend fixtures, readiness,
font settling, instrumentation and action probes. Every version gets a fresh browser context,
a cold navigation and then a warm navigation. Four large-form scenarios × five pairs × two
versions × two cache states give 80 valid samples. No build, test or second benchmark ran
alongside either ordinary capture or the paired replay. Paired controls settled near their
original baselines. All three runs completed without sample or cleanup errors; temporary
backend fixtures were deleted and GET-verified absent.

Evidence under `$CEDAR_HOME/.cedar/reports/frontend-performance/`:

- `cef-summary-before-20261107/`: 160 samples,
  `2026-11-07T15:52:23.257Z`–`2026-11-07T15:59:51.553Z`.
- `cef-summary-after-20261107/`: 160 samples,
  `2026-11-07T16:17:12.871Z`–`2026-11-07T16:24:54.552Z`.
- `cef-summary-paired-20261107/`: 80 samples,
  `2026-11-07T16:25:20.084Z`–`2026-11-07T16:31:18.082Z`; `report.json`, `report.html`,
  `samples.csv`, version-specific screenshots, full before/after artifact inventories,
  fixture cleanup ledger, and `replay.mjs` retain the paired method and results.
- `cef-summary-profile-before-20261107/`: stylesheet instrumentation and a diagnostic
  alternating eight-pair clone experiment against the previous frozen integrated bundle.
  Cloning a cached `<style>` node did not help: warm medians were 1,086 ms unchanged and
  1,128 ms with cloning in that probe. No stylesheet change was adopted. This probe omits
  the standard font/frame settling and is not directly comparable to readiness above.
- `cef-summary-profile-after-20261107/`: CPU profiles of frozen bare/equivalent CED and a
  language-isolation probe; English stays English after a Hungarian sibling is created.

The ordinary suite inventory remains
`fd9a3b4ab6d51c02d7bf9879a5fdf7c1dbe9e5fe6fbba2e3a173d6f86d1686ba`
(`cedar-development@4f1ab150`). Both ordinary runs use Chromium 156.0.8078.4, the same M4 Max
and 1440×1000 viewport. The paired replay uses that same browser, viewport and constrained
profile. It adds no performance gate and excludes legacy pages.

The reactor graph changes from
`a7e1b8ce31b1685f4746891131fcff6704f5424cec974b12466fe0bf5f9a08f0` to
`405dcf9e20f5cb6e6a379478913afc914f945b2221dc69cb21426f6060965dc2`.
CEE package SHA256 changes from
`a405e3844f8a25fe3c7cff33384c7a32106c4dd88630a015d157879d34088265` to
`2f490c30da8c290a2922ddc1d0aca04ad526288b6e75d4ad524f8b97d6e48d75`.
CED remains the identical package
`90265f601eb3032b83e8db1d77610acd5576733f1fb842fb45abe181238403b5`;
Designer host source remains `f9365046`. The reactor captured the optimized working-tree
sources before their commit; its hashes identify the actual built and measured bytes.

The full reactor passed build/checks, all three CEE framework consumer demos, deployment,
served-bundle verification and whole-stack smoke. CEE passed 1,265 unit, 5,926 domain,
100 coordinator and 1,600 browser/visual tests (104 existing skips). The 101 new domain
cases compare all 25 field kinds in required/optional and editable/read-only modes, including
rendered metadata, instance data, validation reports and source immutability, plus independent
instances sharing a supplied field object. The targeted single-field suite passes 231 tests.
CED passed 14,454 unit, 1,137 browser tests (one existing skip), and 25 unchanged visual
baselines; Designer passed 634 unit and 406 browser tests. No visual baseline was updated.
Six of eight ordinary before/after screenshots are pixel-identical, including both Designer
pages and all four standalone CEE/CED pages. The two equivalent-CED images differ only at 6 and 10
border pixels by one colour level. Manual review confirms the same controls, field summaries,
labels and layout. The retained cost includes real field rendering and stylesheet insertion;
no further stylesheet optimization was established by this investigation.

## Browser Metadata Editing

Workspace and the combined Template Editor use CEE exclusively for creating and editing
metadata. Settings has no editor-selection toggle; older stored editor-selection preferences
are ignored. The split Template Designer hosts CED/CEFD for template, element and field
authoring, while metadata population is handled by CEE in Workspace. The legacy metadata widgets, pagination, spreadsheet
view and their supporting modules are no longer part of any of these applications.

## Modern Split Workspace

`cedar-workspace` serves a standalone Angular 22 application on `/`, `/dashboard`,
`/instances/create/:templateId`, `/instances/edit/:id`, `/profile`, `/settings`, `/groups`
and `/privacy`. These routes load no AngularJS; logout also runs in Angular without requiring a profile API response. Messaging has been removed;
its retired URL returns to the dashboard.

The Workspace uses shared design tokens, a table-only resource list, search, folder
navigation, collapsible side panels and Info/Version tabs. Category, latest-version and
type filters are intentionally absent. Artifact/folder menus use existing REST operations
and server capabilities; lifecycle actions come from resource reports, not listing summaries.

The Details tab names the artifact a resource was derived from, and an instance's template with its
version and status, and it says when a template has no instances or none the user can read. The
Version tab describes the selected artifact alone, and its Status line marks the latest version.
Below that the tab names the latest version, the next version and the previous versions, each as a
linked name with its version, status and a copy button. Publish and Create Draft check the version
as it is entered. They refuse anything below 0.0.1, and Create Draft also refuses anything not
later than the published version. Both confirm with Ok and close without a discard prompt. Create Draft asks only for the version and the
destination folder, and the draft keeps the published version's sharing. Returning from an editor
reselects the artifact it opened, through a `selected` parameter added to the dashboard address
without re-encoding the rest of it.

The metadata editor lists CEE's findings above the form. Errors refuse Save, and Save says
so when the pointer rests on it. Warnings, which are an unfilled requirement or a list short
of its minimum, leave Save available. Each finding is a link that asks CEE to `reveal` its field, which turns
the page and moves each repeating element to the entry that holds it. A repeated element
or field in the label carries that entry's number, as in "Author 2 · Email". Server
validation findings join that report for the submitted draft, with the original
location and message retained when a location cannot be mapped to a form control.

The selection toolbar exposes the shared bin as an icon-only button in both grid and list views;
its accessible name retains **Delete (N)** for assistive technology.
Dragging items onto that bin opens the same confirmation; the drop itself never deletes them.
The drag hint reads “Drag onto a folder or the trash icon” without a leading icon.
The bin highlights during a drag and previews “Drop to confirm deletion” on hover. Items with
delete permission can use this target even without move permission; folder drops still require
move permission for every dragged item. Cancelling restores focus to the bin and keeps selection.
When no folders are selected, it opens a compact confirmation asking “Do you want to delete these
N items?” with Cancel and Delete. Permission/revision checks still run before Delete is enabled;
failures show their explanation and allow another check. Selections containing folders open the
detailed confirmation with selected names, distinct recursive counts and the complete inventory. Selected descendants are covered by their selected ancestor, so they are counted and
deleted once. Folder operations retain their server-issued inventory tokens; individual artifacts
use freshly read capabilities and content ETags. Any known blocker disables the entire selection.
Each folder remains a separate deletion boundary: template references outside that folder block
it, even if the instances are also selected. Individually selected templates with reported instances
are refused before writes; the backend retains the authoritative reference check.
Execution stops at the first failure and displays confirmed progress, without claiming rollback or
retrying automatically. Refresh prepares only the remaining selection after confirmed successes;
an uncertain result may require closing the dialog and selecting the remaining items afresh.
The combined confirmation uses the existing shared dialog/table recipes and destructive color roles.
`selection-deletion.spec.ts` and `browser/tests/selection-deletion.spec.mjs` cover overlap,
permissions, conditional writes, cancellation/focus, partial failure and desktop/phone presentation.

The eye preview opens artifacts read-only. **Try out**, beside the close button, remounts
CEE/CEF in editable mode with an isolated copy of the artifact. Trial entries are never saved;
**Back to preview** or closing the dialog discards them. Downloads remain disabled. The
Workspace browser preview suite exercises all four artifact kinds with the real editor bundle
in Chromium and WebKit and checks that no artifact writes occur.

The artifact and folder menu's **Permissions…** dialog follows the legacy access layout.
It shows the owner and direct user/group grants to any reader, with searchable principals
and immediately saved Viewer/Editor/Manager roles for callers with `manageGrants`.
The caller's own access is shown separately from those direct assignments, using the resource
report's role, ownership and capabilities. Missing information stays unknown. Role help is
visible to readers as well as managers; removing a direct role is explained without promising
to revoke access supplied by groups or containing folders. Group sharing requires no membership
in the group. The ownership confirmation warns that the former owner may lose access entirely.
Everyone is Viewer-only. Ownership transfer is a separate, confirmed user-only action,
gated by `transferOwnership`. Each write uses the permissions ETag; a stale write displays
the failed change and requires an explicit reload. Capabilities refresh after each successful
write, including self-demotion; a successful ownership transfer closes the dialog and refreshes
the workspace, since the former owner may lose access. The modern Workspace smoke covers
read-only viewing, role changes, Everyone, stale permissions, and two-user revocation.

Profile provides account details and masked API-key create/regenerate/delete operations.
Settings saves the account date preference used by Workspace. Groups has a standalone
legacy-style Manage/Create layout with searchable group and member selectors, using shared
design tokens instead of the account-page navigation. It uses independent
group and membership ETags, restricts administration to group administrators and protects
the last administrator. Privacy retains the existing policy wording in the Angular account
shell. In `ops/e2e`, run `npm run smoke:account:all` for all four pages, or
`npm run smoke:account -- profile` (also `settings`, `groups`, `privacy`) for one page.
The journeys remove their temporary keys/groups and restore the original date preference.
Groups includes a second user's non-member, member and removed-member views and a real stale-write conflict.
The selected group distinguishes “You are not a member” from membership without administrator
access. An authorized roster supplies the caller's own status when available; otherwise Workspace
reads `GET /groups/{id}/membership/me`. Missing endpoints on older servers, failed requests and
malformed responses leave status unknown and show neutral viewing guidance. They never imply
non-membership. Status refreshes on selection/reload and from confirmed membership writes,
including self-removal or self-demotion. Roster visibility and administrative controls retain their
existing restrictions. The Everyone group keeps its built-in membership explanation.

Start it with `cedarcli native start frontend workspace`. With the native profile sourced,
run `npm run build` in `cedar-workspace` after changing `src/`. `npm run build:deployment` configures and assembles the native server payload.
`npm start` performs that preparation and serves the app with a dependency-free Node server
in develop mode; server mode exits after assembly. Workspace no longer uses Gulp or live reload.
`cedarcli build frontends` runs its Angular build in an isolated checkout;
`cedarcli build split-frontends` retains the explicit native deployment path. Angular builds outside the served tree;
assets are copied before the entry document is atomically replaced. The root index loads
`app/workspace-build/index.html` for every route. Unknown routes return to the dashboard.
The AngularJS shell, controllers, services, templates, styles and Karma harness are removed.
Bower vendors, legacy icon fonts, RequireJS and obsolete npm build/test dependencies are
also removed. The Keycloak adapter and bundle are plain JavaScript used by Angular.

The metadata routes use a modern Angular CEE host. It loads the staged CEE bundle
on demand, settles read-only permissions before configuration, saves with content
ETags and preserves the editor across saves. Its dirty guard covers field/name edits,
exact reverts, browser unload and edits made during a pending save. The host's central
coordinator combines CEE findings with the server's structured validation report.
Explicit severity takes precedence; older CEE reports treat missing required values
and minimum counts as warnings, and other problems as errors. Errors block Save;
warnings remain saveable. Server JSON Pointer locations map to CEE paths and nested
occurrences, including escaped property names and controls that show all choices.
Server findings belong to the submitted draft and retire when it changes; late
rejections cannot attach old findings to a newer draft. Unmapped findings retain
both path and message. Failed loads offer Retry. Conflicts and missing revisions
retain edits and require an explicit reload, with confirmation before discarding
changes. An incomplete create acknowledgement blocks another create until its outcome is
settled. Lost replies and server errors report an unconfirmed save for both creates and updates;
they do not claim the server accepted the write. A create is a PUT to an instance identity the
editor minted and journaled before sending, so **Check save status** settles an unconfirmed
create by reading that identity, as [settling a create or version write](#create-outcome-recovery)
explains. For an unconfirmed update to an existing instance, Check save status reads the artifact
and its permission report without replacing CEE. The same opened revision and content permit
another conditional write; a different revision matching the submitted content acknowledges
that snapshot and keeps newer edits. New element IDs are accepted only at template-declared
element positions, then bound through CEE's captured save snapshot. Existing element IDs and
term IRIs must match. A failed read, lost permission, missing revision or unexplained content
change keeps the draft and the write guard.
An existing write refused with 401/403 offers **Recheck access**. Restored permission enables
saving only if the opened content and revision still match; neither a successful permission
check nor a similar-looking submission permits adopting a different revision.
Token-refresh refusal is a session failure, not an uncertain create. The modern Workspace
smoke commits a real instance update before dropping its response and verifies that the form
retains its input and cannot repeat the write without a successful status check. The
`uncertain-create` journey does the same for creates. The host retains the instance
description across field edits, including the description inherited on creation. Sparse save
acknowledgements supplement the submitted snapshot rather than dropping metadata they omit.
CEE's save snapshot binds submitted element occurrences to their working objects. When a save
assigns new element identifiers, Workspace reads the stored document at the write's returned
revision (including equivalent gzip-suffixed ETags) and acknowledges those IDs without remounting
or replacing newer input. Reordered entries
retain their own identities; deleted entries are not restored and new entries are not assigned
another entry's ID. Failed readback, a changed revision or an invalid acknowledgement retains
the draft and blocks further saves with an explicit message that the write succeeded.
For an existing update, Check save status can retry verification after failed identity readback
or a successful reply missing its ETag. It requires the saved content to match the captured
submission before adopting the current revision and acknowledging IDs; an old opened revision
cannot unblock a write already known to have succeeded. Newer input remains in the same form.
Confirmed creates still require reload when their identity acknowledgement cannot complete.
The modern smoke compares complete stored documents after a description edit in CED/CEFD and
a field-value edit in CEE; only the intended change and root update provenance may differ.
Schema fixtures include identifiers and annotations authored outside the description control.
It also imports a library element, checks that later library edits leave the imported snapshot
unchanged, and checks that edits to the imported element leave the library source unchanged.
The reusable-source-failure journey selects a field and an element while the parent has an
unsaved description. Search outages and refused, missing or unreachable element loads retain
the selection and parent draft; a mixed batch cannot partially import its successfully loaded
field. Retrying after recovery imports each definition once, saves the retained description and
reopens both children without changing the library sources. The failures are injected at the
browser request boundary; recovery and writes use the real services. Run
`npm run smoke:journey -- reusable-source-failure`; the checks also run in the modern smoke.
The resulting instance's second save must preserve its nested element identifiers.
`metadata-state-matrix.spec.ts`
and the browser state-coordination suite cover these transitions. First save replaces the create URL through Angular routing; it does
not remount the editor. The combined Template Editor and its AngularJS smoke remain unchanged.

`npm test` runs Angular/Vitest tests and the Node tests for the retained plain-JavaScript
Keycloak adapter, deployment configuration, atomic staging and npm package contents.
`groups.spec.ts`, `permissions-dialog.spec.ts`, `access-views.spec.ts` and the Workspace
action tests carry forward the legacy group/share controller, directive, permission-model
and conditional-request contracts. They exercise rendered controls as well as request
shapes, independent revisions, pending-write guards, failed/cancelled changes, late reads,
last-administrator protection, direct-user ownership transfer and read-only access.
Bootstrap visibility and asynchronous confirmation mechanics are replaced by native-dialog
and confirmation-event tests. Failed writes retain the last saved state and the failed
intent; stale revisions block further writes until an explicit recovery read completes.
Configuration and CEE assets finish writing before the development server starts.
Workspace's operation coordinator owns listing, detail, menu, destination, description
and preview requests by scope. Replacing a selection or closing its owner invalidates
old replies, including failures and component callbacks. Folder navigation retains the
last successful destination until a complete new listing arrives; malformed listings
cannot become selectable. `workspace-state-matrix.spec.ts`,
`preview-state-matrix.spec.ts` and the browser state-coordination suite cover reply
ordering, permission loss, disposal, malformed responses and recovery.
Use `npm run copy:cee` to refresh only the staged editor.
Workspace participates in `cedarcli check design-tokens` and the shared CI adoption gate;
its initial baseline records existing typography and layout debt.
In `cedar-development/ops/e2e`, run
`npm run smoke:workspace:modern:full` against the running native stack. It exercises the
modern Workspace and split CED/CEFD hosts with real login, folder operations, authoring,
sharing between two users, CEE metadata entry, versioning, OpenView and conditional writes.
It runs its journeys in parallel lanes, which the
[backend runbook](BACKEND-RUNBOOK.md#what-the-suites-actually-cover) describes, and
`-- --lanes=1` runs them one after another.
Its two-user access journeys revoke edit permission while Designer and Editor contain unsaved
input, verify that saving is refused and the stored document is unchanged, and cancel the
reload confirmation to verify that the local draft remains intact.
The group-access journey creates a group and changes its membership through the Groups page,
with access to the template and metadata instance granted only through that group. Removing
the member while either editor is open refuses saving and preserves both the local draft and
stored content. Restoring membership does not silently retry the save: **Recheck access**
verifies restored permission and the unchanged stored artifact, then enables saving the same
refused draft without reload. Checking while access is still denied also preserves input.
The journey restores the original artifact permissions and removes its temporary group.
Run `npm run smoke:journey -- access-recheck` for this focused two-user check.
The release smoke's authoring and metadata fixtures use text fields, so live BioPortal selection
and lookup recovery do not hold up a release. Controlled-term interactions and failure handling
remain covered by the components' hermetic browser and unit suites. The full stack still exercises
real artifact writes, permissions, publication, metadata preservation and recovery.
The initial-load journey injects both HTTP 503 and connection failures into Designer's artifact,
permission-report and component-manifest reads, and Editor's metadata, permission-report,
template, configuration and component-script reads. Neither surface enables Save or shows an
editable partial document; its existing retry control opens the intact stored artifact once
the fault is removed. Whole-document comparisons and request observation verify that no write
occurs. Run these focused cases with `npm run smoke:journey -- initial-load`; they also run in
the modern Workspace smoke. Faults are page-scoped and fixtures are removed after the run.
The validation-rejection journey supplies server-only findings at the HTTP response boundary,
then uses real components and conditional server writes for correction and resubmission.
Designer retains the rejected description and links the finding to its control. A nested regex
finding opens the correct field through a repeated element and focuses its pattern setting;
editing clears the obsolete report, and correction saves without changing sibling content.
Editor follows a finding into the second occurrence of a repeated element, focuses its field,
and preserves every other answer and nested identity when the correction is saved and reopened.
Run `npm run smoke:journey -- validation-rejection` for this focused check. It verifies host
handling of a rejection, not the validator that generates it.
The save-status journey interrupts existing template, element, standalone-field and metadata
updates both before a write and after an actual commit. It first fails the status read, then
holds a successful read while more input arrives, checks the appropriate baseline/revision,
and saves and reopens again. Editor adds a repeated element before the lost reply; recovery
and the following save retain its minted identity. Additional Designer and Editor cases commit
the first request after an unchanged status check, proving the stale retry receives 412 and
keeps newer input. Run `npm run smoke:journey -- save-status`; all ten checks also run in the
modern Workspace smoke. These checks cover open-page recovery of existing updates, not
restoration after reload or an authoritative result lookup for a create.
Run `npm run smoke:journey -- confirmed-save-recovery` for successful-update replies with a
missing ETag in Designer's template, element and field editors and in Editor, plus Editor's
failed identity readback. All five cases fail the first status check, retain input typed during
a later check and save and reopen successfully; the metadata cases also preserve assigned
element IDs. They also run in the modern smoke.
The recovery-element-edits journey changes repeated metadata entries while a status read is
held after a real committed save loses its reply. One case removes an earlier occurrence and
copies the submitted one; another removes the submitted occurrence and adds a replacement.
Acknowledgement binds minted IDs to surviving submitted objects, does not resurrect deleted
entries or assign their IDs to replacements, and retains the current values. The next save
mints a distinct replacement ID; whole-document comparison and reopening verify the result.
Run `npm run smoke:journey -- recovery-element-edits`; both cases run in the modern smoke.
The current-template-constraint journey changes a text regex through another REST client while
Editor holds the earlier template. Its save must receive a real server 400 with `/Code/@value`,
retain all local answers and preserve stored content and its ETag. Clicking the finding focuses
Code; correction saves with the existing instance revision and reopens with other content intact.
The reopened Editor enforces the new regex locally before another write can be submitted.
Run `npm run smoke:journey -- current-template-constraint`; it also runs in the modern Workspace
smoke. Unlike the injected report checks above, this exercises deployed server validation.
The duplication journey copies templates, elements, standalone fields and metadata through
Workspace's Copy dialog, then edits and reopens both the copy and the original independently.
It compares content, checks derivation and fresh draft-series identity, and verifies that neither
editing direction changes the other artifact. Copies regenerate name-derived schema text and
creation timestamps, and omit the original's external identifier; those are explicit assertions,
not losses hidden by a normalization save. Untouched typed metadata answers remain intact.
Run `npm run smoke:journey -- duplication` for the focused check.
The template-evolution journey keeps unsaved metadata open in a second tab while Designer
removes a field already used by that record. Cancelling the version dialog retains both drafts
without changing storage; confirming publishes the original schema and creates a revised draft.
The open record can then save and reopen its answer against the original template, while a new
record created from the revised draft has only the remaining field. Run
`npm run smoke:journey -- template-evolution`. This verifies structural changes through the
supported Designer versioning path, not arbitrary in-place template changes by external clients
or conversion between field types.
The draft-sharing journeys check that a new draft is shared as the version it was drafted from.
Workspace's Create Draft and Designer's Create new draft each draft three templates. The second
test user holds no grant on the first, can view the second and can edit the third. As that user,
the journey checks server reads and writes, how Designer opens each draft and what Shared with Me
lists. The editor saves a change, the viewer sees the draft read only, and the user without a
grant can neither read nor open it. Each draft keeps its owner and carries exactly its original's
grants, the original's grants stay unchanged, and the folder grants nothing, so no access comes
from it. Run
`npm run smoke:journey -- draft-sharing-workspace draft-sharing-designer`; both also run in the
modern Workspace smoke. They sign in as the second user, so they belong with the other two-user
journeys rather than alongside single-user ones.
The uncertain-create journeys lose real replies to creates and new versions at the browser's
request boundary and check that each outcome is settled by the identity its client minted, never
by repeating the write. `uncertain-create` creates a template, an element and a standalone field
in Designer and an instance in the metadata editor, each in three series. In the first, the reply
is lost after the server stored the artifact, and a reload and the restored draft's Check save
status open it at its edit address. In the second, the write never reaches the server and an
injected 401 refuses the first check for the session. Sign in again returns through the SSO cookie
or the login form, the restored draft's check finds nothing, and Save sends the same identity
again. In the third, a check in the open tab finds nothing, and the original request then commits
late, modelled by a REST PUT of the body the browser sent. The next Save is refused as occupied,
and the check adopts what was stored. Designer keeps the newer edit on screen but requires a
reload, which discards it, before the next save. The metadata editor keeps it as an unsaved change
that saves conditionally. `uncertain-workspace-create` loses the replies to New folder, Copy,
Create Draft and Publish, committed or not, and settles each through the dialog's Retry. One Copy
is reopened after a reload and takes up the retained identity and values. `uncertain-version`
loses the reply to Designer's Create new draft, committed or not, and settles it after a reload.
Every case ends with exactly one result: one artifact, folder, copy, successor or publication.
Where Designer or the metadata editor created the artifact, a conditional edit follows, and the
reopened page offers neither Restore draft nor Check save status. Run
`npm run smoke:journey -- uncertain-create uncertain-workspace-create uncertain-version`. All three
also run in the modern Workspace smoke, and none signs in as another user.
The partial-version journeys check that Designer's Create new draft stores nothing when the server
refuses it, and that a corrected retry creates exactly one successor. In
`partial-version-definition`, a page-scoped rewrite removes the `oslc:modifiedBy` declaration from
the submitted definition, and the server's validator refuses it with 400 before publication.
Designer lists the findings, and editing the definition retires them. In `partial-version-draft`,
the author owns the template, but the second test user owns its folder and has made the author a
viewer of it, so the server refuses the draft with 403. The refusal survives a reload, a restored
draft and an access recheck, which reads only the template's own permissions. Once the second user
restores the editor grant, the retry succeeds. In both journeys the source stays the draft that was
opened, at the same ETag and with one version, until the corrected retry. `partial-version-draft`
uses the second user by REST token and never signs that user in to a browser. It writes in that
user's home folder, so it belongs with the two-user journeys. Run
`npm run smoke:journey -- partial-version-definition partial-version-draft`. Both also run in the
modern Workspace smoke.
The content-deletion journey uses temporary templates and metadata to check cancellation of
populated-element deletion in Designer, removal of fields/elements and their parent references,
and middle/last occurrence deletion in Editor. It compares whole stored documents apart from
root update provenance, preserving surviving definitions, values, order and element-instance
identities. Reopening and explicitly discarding the retained recovery draft restores unsaved
deletions; reopening after a successful save preserves deletions, including empty optional lists. The stored Designer fixtures are compared
directly, without an initial normalizing save.
Neither surface currently offers deletion Undo; explicitly discarding the recovery draft after
reopening the saved artifact is the recovery tested here, and does not preserve other unsaved work.
Run this check alone with `npm run smoke:journey -- content-deletion`.
The older-artifact journey opens legacy-shaped templates, elements and standalone fields,
edits each description twice, and verifies that unrelated schema shapes, constraints,
annotations and identities survive saving and reopening. Editor also renames and reopens
older metadata without losing typed answers or existing context declarations; its writer
adds the standard `pav:derivedFrom` context declaration if absent. An unsupported historical
field type is injected only into a GET response to verify that Designer refuses to open it,
keeps Save disabled and sends no artifact writes. Repairing arbitrary invalid or unsupported
artifacts is not established by these focused checks.
The partial-selection deletion journey commits two deletes and drops the second response.
It verifies that only the first is reported as confirmed, later items remain untouched, and
the author can finish from a fresh selection without repeating the uncertain request.
Hermetic bulk-delete recovery journeys extend this to a confirmed recursive-folder deletion,
an uncertain individual delete, and an unattempted remaining record. Repeated HTTP 503 or
disconnected inventory/listing reads retain confirmed counts and leave deletion disabled.
Restored inventory reads recheck permissions and revisions; a revoked permission blocks the
whole remaining selection, and recovery requires explicit confirmation using fresh ETags.
If the uncertain item returns 403 or 404, neither response proves deletion: its count stays
unconfirmed and the old selection stays blocked. Close the dialog, refresh Workspace after
service recovery, and review a new selection of remaining items before confirming deletion.
`npm --prefix browser test -- bulk-delete-recovery.spec.mjs` exercises these paths in Chromium
and WebKit against a built Workspace. This is unit and hermetic browser coverage of the
existing workflow; combined deletion outage cases still need live-stack verification.
The partial-move journey refuses one grouped move at the HTTP boundary while two others
commit at the real server. Workspace reports the two successes and the refusal, retains only
the remaining item in its selection, and can move that item after the refusal clears without
repeating successful moves. All stored artifact content is compared before and after. Run
`npm run smoke:journey -- partial-move`.
The uncertain-move journey lets all three moves commit, then drops one response. Workspace
reports only the two confirmed successes alongside the error and refreshes the source listing,
removing the already-moved items from selection. Opening the destination finds all three with
their entire artifact content unchanged, and no move is replayed. Run
`npm run smoke:journey -- uncertain-move`; the full modern smoke includes it too. This covers
recovery through a successful listing refresh, not an outage that prevents checking placement.
Workspace also preserves unresolved move selections through repeated listing failures and shows
the refresh error alongside individual move failures. An explicit retry first checks every
selected resource's current placement, capabilities and revision. A resource already directly
inside the requested destination is confirmed without another move request; selected descendants
stay with their selected ancestor. Unavailable or malformed placement reports prevent all writes.
Hermetic Chromium and WebKit journeys cover lost replies both before and after commit, repeated
listing failures, placement-check failure, and recovery without replaying confirmed moves.
Run `npm --prefix browser test -- bulk-move-recovery.spec.mjs` against a built Workspace.
These outage combinations have unit and hermetic browser coverage; live-stack verification is
still pending. The isolated test build does not redeploy the shared Designer or Editor.
The main smoke registers copies by the collection in their canonical identity, since copy
responses are artifact documents without `resourceType`; this ensures non-template copies
are removed from the correct collection during cleanup.
The Workspace menu omits artifact downloads and clipboard identifier actions; its smoke pins the
current action names and order. JSON/YAML/compact-YAML downloads for all artifact kinds are covered
by the REST download suite, and the main browser smoke exercises CEE download controls.
Each Workspace run removes its fixtures. Its result and failure screenshots, including open
second-user pages, go to a directory of the run's own: under the split tier, the evidence directory
its report names, and otherwise a new `cedar-e2e-evidence-*` directory in the system's temporary
directory, which the smoke prints.
`npm run smoke:workspace:modern` runs just the Workspace journey; the full command also
runs the CED host's stale-save and breaking-template-change scenarios, all account journeys,
and logout/retired-route checks (`npm run smoke:workspace:lifecycle`).
The existing `npm run smoke` remains the AngularJS journey for `cedar.metadatacenter.*`.
Its script and legacy variants are retained unchanged; they are not the modern route's gate.
See the Workspace README for the boundary, request contracts and direct build procedure.

## Bundle Sizes and Duplicated Code

The 2026-11-05 measurements below use the reactor's production output after modular model
packaging, with Angular's `--stats-json` and packaged custom-element scripts measured at gzip
level 9. The host rows count all emitted JavaScript,
including lazy chunks and polyfills, but exclude CSS and separately copied components. They are
not first-navigation transfer measurements. Decimal kB below means 1,000 bytes.

| Surface | JavaScript, kB | gzip-9, kB | Additional component loading |
| --- | ---: | ---: | --- |
| Workspace | 856.4 | 239.7 | CEE loads when metadata editing is opened; the editor route is lazy too |
| OpenView | 578.4 | 163.1 | CEE loads on artifact pages or preview, host-font variant |
| Monitoring | 1,104.6 | 280.7 | None |
| Bridging | 630.5 | 179.6 | CEE loads when a DOI form opens, host-font variant |
| CEE standalone / host fonts | 2,237.8 / 2,115.1 | 607.1 / 514.4 | Includes its Angular runtime and model library |
| CED standalone / host fonts | 1,982.3 / 1,859.6 | 473.5 / 380.3 | Includes its Angular runtime, model library and schema validator |
| Term picker standalone / host fonts | 506.2 / 383.5 | 202.9 / 109.4 | Includes its Angular runtime and narrow policy entry |

Workspace, OpenView, Bridging, Monitoring and the Template Designer register CEDAR Roboto 400/500
through `fonts-hosted.css` from the design-token package. Its content-hashed WOFF2 files contain
exactly the embedded faces; the browser selects the unicode subsets each page uses. Both Latin
weights total 22,100 bytes, with another 15,412 bytes when Latin Extended is needed, instead of
carrying all 89,452 font bytes as base64 in every host stylesheet. The four Angular hosts' initial
CSS falls by 118,368 raw bytes (about 90 kB gzip). External font files stay in the total payload
budget, and missing references fail the size gate. Browser checks cover subset requests and
unchanged visual baselines; standalone CEE and CED scripts remain byte-identical.

Hosts select component host-fonts bundles, which omit embedded fonts, or their coordinated
integration modules. Standalone components retain their existing embedded fonts and require no
additional font requests. Template Designer's staging falls back to embedded `fonts.css` when an
older token package has no hosted-font stylesheet.

The build graphs contain one installation of each contributing npm package per application;
Angular's compiler, Moment and Lodash do not contribute to these seven modern bundles. CEE's
unused grid-list, toolbar, list and clipboard NgModule imports retain only 594 bytes of module
definitions, not the full controls. Removing imports based on their names alone would therefore
overstate the savings. Its RDF processors and sanitizer are used by export and rich-text rendering.

The model package exposes a modular ESM tree through `module: esm/index-namespace.js`, with browser
mappings for `/policy` and `/schema` into the same tree. A minified esbuild consumer exposing only
`TextPolicy` retains 661 bytes (385 gzip), compared with 527,102 bytes through the old single-file
entry under the same esbuild options. The separate modules let a consumer discard unrelated readers,
writers, YAML and validation code. YAML's browser modules are vendored with their license; the generated AJV
validators retain their rules and share the ESM policy classes. CommonJS, UMD and the copyable
single-file `*.esm.js` outputs remain available at their established paths. The ESM entry wrappers
preserve the default namespace export as well as named exports, including Vite's CommonJS interop.

`npm run test:package` builds consumers from the actual tarball, checks narrow-import size
ceilings and browser subpath resolution, and compares readers, writers, validation and exact-number
handling across CommonJS, native ESM, bundled ESM and UMD. `npm run build:watch` rebuilds all
formats together so an incremental change cannot leave the modular tree stale.

Separate self-contained elements each carry their own Angular and shared-library code. The
Template Designer builds CEE, the term picker and CED into one coordinated runtime graph,
3,443,265 raw bytes in the 2026-11-06 source build. Each keeps its own application injector.
Its extra schema script is a fallback for old CED bundles without `validateArtifact`, so it is
not another normal-path download. See the CED integration section for the identity checks.

The legacy Template Editor requests CEE through RequireJS when an instance editor opens. Its
full model UMD loads only for a YAML preview or copy; validation keeps using the narrow policy
entry. CKEditor and its original AngularJS adapter load when a rich-text field is opened, with
the same toolbar and model handling. A failed load can retry when reopened; YAML copying starts
the clipboard operation within the click so its first library download does not lose user
activation. Against the installed model package, these optional tools total 1,034,573 raw /
268,386 gzip-9 bytes; their initial loaders add 5,199 / 1,808 bytes. The thin `ng-flow` adapter
uses the single Flow.js dependency. Retired RDF preview processing is absent; JSON Schema
preview and YAML actions remain available.

OpenView folder listings and Bridging's landing page defer CEE too; loading failures use their
existing error states, and a later OpenView preview can retry. The Template Designer uses CEE
for ordinary field summaries and default editors as well as previews.

Workspace loads profile, settings, groups, privacy and logout as route chunks; Monitoring loads
its diagnostic screens as a lazy module. Dashboard navigation therefore avoids those downloads,
while direct links keep their existing guards and behavior. The 2026-11-06 production comparison
reduced Workspace's initial graph by 63,764 raw / 13,369 gzip-9 bytes and Monitoring's by
204,100 / 41,363 bytes. Browser tests assert that the deferred chunks are absent on the dashboard
and requested when their routes open; the existing account and diagnostic journeys still apply.

Files merely present on disk, such as Moment's tests, source maps and superseded hashed bundles,
are not evidence of browser downloads.

`cedarcli check frontend-sizes` checks the built Workspace, OpenView, Bridging and Monitoring
payloads. Use `--surface openview --root /path/to/cedar-openview-src --report /tmp/payload.json`
for an isolated build. The same gate runs after each host's build and browser verification in
both the frontend reactor and immutable trains. Limits live in `ops/frontend-train.json`.

The initial count follows script/stylesheet tags and static imports in `browser-stats.json`;
dynamic imports and copied component scripts also count toward the total emitted JavaScript/CSS.
Workspace's separately served config, authentication scripts and copied components are mounted
into this inventory. Assets are counted once per URL, with raw bytes, gzip-9 bytes and SHA-256 in
the report. The total is a deployment inventory, not a claim that a visitor downloads every file:
Workspace stages both CEE variants, for example. Missing assets, external script/style URLs and
exceeded limits fail the command. Fonts embedded in scripts or CSS count with those files.

Measured complete payloads for those same builds, in decimal kB:

| Host | Initial, raw / gzip-9 | Total inventory, raw / gzip-9 |
| --- | ---: | ---: |
| Workspace | 1,016.6 / 339.9 | 5,419.9 / 1,474.8 |
| OpenView | 725.8 / 257.9 | 2,840.9 / 772.3 |
| Bridging | 783.4 / 275.1 | 2,898.5 / 789.5 |
| Monitoring | 1,273.1 / 377.7 | 1,273.1 / 377.7 |

| Host | Initial limit, raw / gzip-9 bytes | Total limit, raw / gzip-9 bytes |
| --- | ---: | ---: |
| Workspace | 1,200,000 / 360,000 | 6,200,000 / 1,700,000 |
| OpenView | 850,000 / 320,000 | 3,200,000 / 900,000 |
| Bridging | 930,000 / 350,000 | 3,300,000 / 950,000 |
| Monitoring | 1,400,000 / 450,000 | 1,400,000 / 450,000 |

CEE's packaged limits are separate: standalone 2,400,000 raw / 660,000 gzip bytes and host-fonts
2,280,000 / 560,000. Its Angular initial budget is 2.3 MB warning / 2.4 MB failure; OpenView's
is 800 / 850 kB, and Bridging's is 900 / 930 kB. These limits must not be raised to accommodate
unexplained growth.

To repeat the analysis, build isolated source copies with the normal production prerequisites
and add `--stats-json` to their Angular build invocation. Angular 22 writes `browser-stats.json`;
sum `outputs[*].inputs[*].bytesInOutput` by package, not the original input-file sizes. Measure
packaged custom elements separately and trace script tags and runtime loaders, since Angular's
`initial` budget excludes copied assets. The local audit evidence is under
`$CEDAR_HOME/.cedar/audits/frontend-bundles-20261105/`, including production graphs, packed-package
measurements, the narrow-import probe and host-font rendering comparisons. These diagnostics do
not deploy a frontend or replace the reactor's source/runtime acceptance evidence.

The full reactor, all three consumer demos, local deployment, served-byte verification and
whole-stack smoke passed for this source composition on 2026-11-05. Its immutable build record is
`01e070e087da8c3fbe8469cf0821f5de487b7eef56522b5f65abe642bc090303`; selected package SHA-256 prefixes
are model `a3ce971ab7af`, CEE `4b30e2d83ab8`, CED `185e277ba3eb` and term picker `dc2f855979a2`.
The full identities and source fingerprints are in `$CEDAR_HOME/.reactor/builds/<build>.json`.
Frontend builds and native start/restart resolve the pinned Node and Java toolchain before
invoking their workers. The native controller preserves that PATH and passes it, with JAVA_HOME,
into launchd children. A native frontend launched on 2026-11-06 was verified against its actual
executable at Node 24.22.1, even though the shell's unversioned Node was 26.

<a id="component-staleness"></a>

## Component Staleness

A component change reaches a host only after the host resolves and serves the new package.
A passing host suite alone does not prove that its component is current.

```shell
cedarcli check components            # report findings
cedarcli check components --strict   # also fail on advisory freshness findings
cedarcli check components --all      # show every comparison
```

The check compares source commits, locked package bytes and the custom elements the host creates.

| Finding | Default result |
| --- | --- |
| Served bytes inconsistent with the lock, an element absent from locked bundles, or a pin unexplained by source history | Failure |
| Host behind a published component, explicit local bundle override, or version without a recoverable source commit | Advisory; fails with `--strict` |

Train and release preflights use the default severity. They exclude local staged overrides because
both build isolated copies from locks. Use strict checks for a served payload, and the reactor's
source/package/runtime evidence for current-development acceptance.

### Advancing a Pin

For a local snapshot build, run `cedarcli build frontends` directly (or `cedarcli test frontends`
for the source build and checks). Both use current working-tree components automatically,
including uncommitted changes. They require no commit, push, CI publication or manual pin update.
The registry workflow below is for recording dependencies that standalone installs will use.

npm consumers keep exact immutable versions in manifests and lockfiles; `npm ci` does not follow a
moving dist-tag. To advance tracked registry pins, use [Recording a Pin](#recording-a-pin).
The local reactor instead wires packages built from current sources into isolated consumers,
leaving tracked pins unchanged. Both routes must verify the installed and served bytes.

### The Reactor

**Mandatory: a frontend reactor build and every development E2E acceptance run must use packages
built from the current development sources of ALL CEDAR components in every consumer. No component is exempt.**
This includes the TypeScript model library, design tokens, CEE/CEF, CED/CEFD and CETP, their
transitive CEDAR dependencies, and any components added later. It applies to all hosts, including
the combined editor, Workspace, Designer, OpenView, Bridging and the component demos.

“Latest development” means the current development sources, including the edits under test,
built together in dependency order. Ordinary local builds do not fetch or switch branches. If the
request explicitly includes updating from remote development heads, do that while preserving local
work before the build; do not make it a prerequisite for testing local edits. A registry
`dev` tag, a version containing `dev`, a matching pair of displayed versions, or a healthy process
does not prove freshness. The selected package must match the current source fingerprint, and
every installed and served copy must match that selected artifact.

The local reactor selects immutable local artifact hashes and records resolved dependency locks,
leaving tracked registry pins unchanged. **Every** consumer must resolve and serve that fresh
selection. Registry publication is a separate delivery workflow. An old
checked-in pin must never determine the component used by a development E2E run.

**Fail closed on stale, missing or unverified components.** Do not restore old pins or an old
`.reactor/runtime.json`, remove the active selection, substitute a stable release, disable a
freshness/integration gate, or skip a failing component to obtain a green build or smoke result.
After a failure, the previous runtime may remain available for diagnosis; it cannot be accepted
as the latest development build. Fix the failure, rebuild affected consumers, redeploy and verify
the complete selection before rerunning all smoke tiers.

`cedarcli test e2e` does not itself rebuild the frontend dependency graph or establish that all
components came from the latest sources. A standalone passing smoke result is therefore
insufficient. First complete `cedarcli build frontends`, which includes deployment and smoke,
or reuse its verified runtime only while all relevant source fingerprints, resolved pins and
served artifacts still match. If sources change, rebuild before accepting another E2E run.
Retain the reactor build record and runtime selection alongside the smoke report so freshness
and test success can both be checked. These requirements also apply to direct `ops/e2e` commands.

**“Full frontend reactor” means `cedarcli build frontends`.** The agreed completion contract is:

1. Build all frontend libraries, embeddable components and browser applications from their
   current local sources in dependency order, including the working-tree changes being tested.
2. Make every downstream consumer use the components produced by that build. This is the
   development equivalent of Maven SNAPSHOT resolution. The CLI builds and wires local packages
   automatically, including for narrow frontend targets. No registry publication, manual pin
   change, Git action or follow-up approval is needed.
3. Run the applicable component, integration and visual regression checks, or reuse a result
   that passed for exactly the same inputs. Review intentional visual changes before updating
   baselines; do not accept failed screenshots automatically.
4. Redeploy all local frontends, verify the bundles actually served match the selected build,
   and run the whole-stack smoke tests. Preserve that selection across restarts and dependency
   reinstalls so old pins cannot silently restore an earlier component.
5. Report completion only when the full sequence passes. Identify any unfinished stage precisely;
   compilation alone does not fulfill a request for a full frontend reactor.

The frontend build guard checks the frontend source repositories and CLI tooling. Within
`cedar-development`, it checks `bin/`, `ops/frontend-train.json`, `ops/cedar-services.sh`
and `ops/frontend_reactor_runtime.py`:
profiles and frontend build/runtime configuration. Concurrent edits or commits to backend audits,
repairs and documentation do not invalidate a frontend build. A guard failure means tracked inputs
changed during the run; it does not establish that the build itself changed them.

This contract does not require a release, a production deployment, or a Git commit/push.
Registry delivery and release-version changes have their own workflows. Commit/push remains
subject to the user’s instruction.

Before it builds anything, the command runs the strict design-token style policy over every
token consumer's checkout. Consumers in the reactor resolve the vocabulary from the local token
source: a token added there need not be published and pinned before consumers can build with it.
The report retains registry-pin findings separately; standalone `cedarcli check design-tokens --strict`
and CI still validate those pins. Missing declarations, mismatched locks, style violations and
missing/stale baselines still fail. Vendored copies such as MCP keep their byte and pin checks.
The subsequent producer/consumer build and runtime verification prove the selected package bytes.
`cedarcli build all` runs the same source-aware preflight unless `--skip-tests` is given.

Deployment refreshes a live frontend's dependencies when they are absent or older than its
lockfile, then installs the selected local reactor components. Isolated verification does not
populate those live `node_modules` trees, so this also handles a first deployment without a
separate npm command or approval. Unchanged installed dependencies are retained.

A repository whose inputs match an earlier passing result is not verified again. Each passing
repository leaves a record in `.reactor/results/`, keyed by source contents, exact commands,
resolved CEDAR package bytes, integration bundles, Node/npm/platform, installed Playwright
container image identities, relevant environment and reactor tooling. CLI runtime sources and
frontend inputs in `cedar-development` count; CLI tests, documentation and separately executed
smoke/search gates do not. Ignored local `.env*` and `.npmrc` configuration also counts.
Worker allocations, scratch paths and time do not. Environment values are stored as hashes.
The hit is checked before copying source or installing dependencies. A component package must
still exist and match its SHA-256. Reused build evidence retains the manifests and resolved locks
from the actual earlier install, including sibling browser packages; it does not substitute the
checkout's development lock.

Task records under `.reactor/task-results/` handle edits within a repository. CEE, CED, the model,
Workspace, Monitoring, Bridging and OpenView have explicit build/check boundaries. Their keys
include applicable source groups, actual resolved locks, runtime/tooling and, for browser checks,
the built bundles they consume. Builds retain their declared outputs in checksummed archives;
a hit verifies and restores those outputs into the disposable copy before dependent checks run.
Missing or malformed records, missing outputs and damaged archives cause execution again.
Successful stage logs are retained beside the records. Reports print each reused task or gate
stage, its key and original pass time.

A unit specification edit in Workspace reuses its production build and browser result. A browser
specification edit keeps the build and unit result, then runs the browser suite. Shared fixtures,
configuration, scripts and ordinary production sources remain conservative inputs. CED's own
build-provenance rules still apply. Source edits that affect runtime behavior rerun relevant
verification; this is not individual-test selection. Other frontend repositories retain whole
repository reuse until their outputs and task boundaries are declared. Installs still use private
`node_modules` with the shared npm download cache. Workspace's disposable copies omit old staged
hashed bundles, leaving the live checkout intact. CEE's second identical packaging step reuses the
first verified package when its inputs have not changed.

A browser success that required retries is not saved as reusable task or repository evidence.
Completed tasks stay private until the repository source guard passes, so editing a checkout while
it builds cannot publish new stage results from the invalidated run. A failed later check can still
leave earlier clean stages reusable when the source guard passes. Stage candidates from a cancelled
build are discarded with its workspace. `.reactor/stage-results/` is the older, conservative
failure-resume store; new declared tasks use `.reactor/task-results/`.

For the edit/test loop, use `cedarcli test frontends`. It builds current local sources, runs the
same component/application checks and conditional consumer-demo gate, and reuses matching evidence.
It does not activate a runtime, restart applications or record a whole-stack smoke pass.
`cedarcli build frontends` retains the full deployment and acceptance contract. A compilation
failure leaves the previous runtime selection intact; a deployment or smoke failure leaves the
new selection available for diagnosis and does not report completion.

Both commands accept `--no-reuse` to execute every repository and stage again. To discard local
verification evidence, remove `.reactor/results/`, `.reactor/task-results/` and
`.reactor/stage-results/`; missing evidence is rebuilt automatically. Concurrency options follow
`test frontends` and precede `frontends` under `build`. Development still consumes the latest local
sources automatically; caching does not change SNAPSHOT resolution or release requirements.

CEE and Workspace trace only the first existing retry, instead of recording every passing browser
test. The retry count and test matrix are unchanged. For first-attempt diagnosis, run
`CEDAR_TEST_TRACE=on cedarcli test frontends` or set that variable on the owning npm visual command.
Screenshots retain zero allowed differing pixels and a 0.02 color threshold.
Workspace's Chromium project disables partial rasterization (`--disable-partial-raster`): each
changed tile is painted completely. Reusing partially painted tiles can retain stray pixels after
selection clears the information panel, even when the DOM and consecutive screenshots are stable.
Keep this browser setting when updating Playwright; it requires no application CSS or baseline change.

Whole-command timing reports live under `.cedar/build-reports/frontend-runs/`, separately from
the dependency graph reports. They record preflight, build/checks, consumer demos, deployment,
served-bundle verification and whole-stack smoke, including a failing phase. Gate stage timings
also record granted workers and seconds waiting once a stage is queued, so worker
contention is visible separately from execution. A graph-only timing is not a complete reactor time.

An isolated build runs an install once more when npm drops an optional dependency. npm drops
one whose download or install fails, records the drop only in its debug log, and leaves the
partial package on disk until the install scripts have run. A platform binary truncated by a
failed download then fails esbuild's postinstall with `Unknown system error -88`, or rolldown
reports `Cannot find native binding` once the build loads it. A second drop fails the install
and names the package, even when npm itself reports success. The debug log names the dropped
package but not the error behind the drop. In the build report, each install run in which npm
dropped a package carries `droppedOptionalDependencies`, and the run after it shows whether
installing again recovered.

Before a failed isolated frontend build is cleaned up, the CLI retains its command log,
npm's debug logs, and available `test-results`, `playwright-report`, `surefire-reports`,
`failsafe-reports`, and `coverage` files under
`$CEDAR_HOME/.cedar/build-reports/failures/`. The failure prints the exact directory.
npm writes its debug logs into a directory the build owns, outside the copied repository, and a
bundle keeps them under `npm-logs/`. Each bundle is capped at 250 MiB of copied files;
`manifest.json` lists retained files and files omitted for size. Dependencies, Git metadata
and symlinks are excluded.
Successful builds do not retain these diagnostic copies. Remove old bundles when no
longer needed; the cap is per failure, not a total retention quota.

`cedarcli build diagnostics` previews age/size retention (14 days and 1024 MiB by
default). Set `--days` and `--max-mib` to choose a policy; add `--apply` to delete
the selected bundles. Only completed bundles carrying the CLI's diagnostic marker
are eligible. Older unmarked reports, interrupted captures, unrelated directories and
symlinks are preserved. A preview does not delete anything or alter release evidence.

For a compile-only estate build, `cedarcli build all --skip-tests` skips both Java
and frontend verification suites while retaining dependency-ordered frontend builds.
It does not claim full reactor verification or run the frontend deployment/smoke sequence.
`cedarcli build frontends` always retains its verification and completion contract.

The TypeScript model's reactor checks read the corpus vendored inside its isolated
checkout. Their child-process `CEDAR_HOME` points there, so a server's `/srv/cedar`
does not redirect those checks to an absent or stale sibling `cedar-test-artifacts`.

#### Bounded parallel builds and test gates

The Angular, React and Ember CEE consumer demos are a separate conditional gate,
not ordinary reactor applications. `cedarcli build frontends` (and test-enabled
`build all`) omits their installs/builds from the main graph, then checks all three
against the exact CEE tarball just built when their embedding inputs have changed.
The first run also checks them. A successful fingerprint under `.cedar/cee-demos/`
covers CEE's public declarations, custom-element registration/bootstrap, host wrappers
and configuration, packaging scripts/manifests, every declared CEE consumer manifest
and lock, and demo sources/tooling. Internal field-rendering changes alone do not
invalidate it. Missing, corrupt or failed evidence never suppresses a check.
Failures stop completion before runtime activation. Deployment, served-byte checks
and whole-stack smoke remain required.

Force all three demos with `cedarcli test cee-demos`. By default this verifies their
checked-out pins. To test a release candidate, use
`cedarcli test cee-demos --cee-package /absolute/path/to/staged-package-or.tgz`.
Both modes lint, integration-test and production-build all three in disposable copies;
candidate pins/locks are rewritten only in those copies. The explicit command always
runs, even when a matching local check exists. Consumer-demo CI checks its pins on
push/PR; CEE CI checks every newly staged candidate, including release-preparation
PRs, before dev publication. Build trains and platform release verification retain
all three demo surfaces. Before publishing a public CEE release, explicitly test
the final staged package as described in the npmjs release runbook.

On hosts with at least 16 logical cores, `cedarcli build frontends` defaults to three
repository jobs and twelve workers per repository, the same as
`cedarcli build --jobs 3 --workers 12 frontends`. The shared pool still bounds total workers
to the host CPU count. Smaller hosts retain two jobs and half their cores (up to eight)
per repository. The full reactor uses four REST smoke workers with the twelve-worker budget. With reuse, most builds run only the
repositories that changed, and a repository running on its own gains most from more workers.
Measured on 2026-10-24 UTC on the 16-core M4 Max with 64 GB RAM, using the 3/12 defaults
and a warm npm download cache. These are whole `test frontends` command timings, including
input guards and the conditional demo gate; deployment and whole-stack smoke are outside this scope.

| Edit/run | Before or control | Task/output caching | Savings |
| --- | --- | --- | --- |
| Nothing changed | 32.8 s | 21.8 s | 34% |
| Workspace unit specification only | 101.9 s | 36.4 s | 64% |
| Workspace browser specification only | 101.9 s | 88.9 s | 13% |
| Workspace production source | 101.9 s | 98.9 s | All checks correctly rerun; normal timing variation |

The Workspace control disables only its task cache; the unchanged comparison uses the earlier cache
implementation. Unit edits rerun units while reusing the build and browser checks; browser edits
rerun browser checks; production edits rerun all three. These are
single workstation measurements, not a deployment/E2E speedup claim. Full cold verification in the
same investigation took roughly 8–10 minutes. Evidence is retained under
`.cedar/build-reports/frontend-runs/`, including `20261024T084129Z-0092f32b.json` (control),
`20261024T084246Z-8c35726e.json` (unit), `20261024T084443Z-f945dcd8.json` (browser), and
`20261024T084730Z-3ddd3320.json` (production source). Use the current command's timing report for
capacity planning; older scheduling and pre-cache measurements used different verification inputs.

`cedarcli build --jobs 2 --workers 2 frontends` runs at most two isolated frontend
repositories at once, with two workers per repository. The defaults above choose 3/12 on
the 16-core workstation; 2/2 is an explicit lower-resource override. Put
build options before the target; `--jobs 1 --workers 1` provides a serial comparison.
The scheduler reads dependencies from nested package manifests (including npm aliases)
and the inventory's integration bundle inputs. A consumer waits for its current-source
producers' immutable local artifacts. Other build commands remain exclusive barriers, and
deployment and the smoke tiers run after all frontend checks pass. A failed producer blocks
its consumers, including in continue mode.

Every frontend build on the machine shares one pool of workers, as many as the host has cores, so
concurrent builds started by different sessions share it as well. `--workers` caps what one
repository uses, and the pool caps what every build uses together, so a third job or a second
build fills idle cores without oversubscribing busy ones. A command takes its workers from the pool
when it starts and returns them when it ends. An npm script asks for the repository's whole budget,
and an install or a browser download asks for one. The model library's, CEE's and CED's gate
scripts take workers stage by stage instead. Requests are served in the order they arrive, and
each starts once at least half of what it asked for is free, so a stage that needs several workers
is never overtaken by smaller ones. The log names any command or stage that started with fewer
workers than it asked for.

The pool is the directory `$CEDAR_HOME/.cedar/worker-pool`, named to each command in
`CEDAR_WORKER_POOL`. It holds a `size`, one `slot-<n>` subdirectory per worker in use and a `queue`
of waiting requests. Each slot and request records its process and the boot that process started
in. It is taken back once that process has exited, once the machine has restarted, or after twelve
hours, longer than any command holds a slot. A pool found idle with another size, as after moving
an estate to a new machine, takes the host's core count. Removing the directory while no build
runs resets it.

A surface in `frontend-train.json` may declare a `package` phase between `setup` and
`verify`: the commands that build and stage what it publishes. The model library and CEE
declare one. When that phase passes, the reactor stores the artifact and starts the
consumers waiting for it, while the producer's own checks continue in the same job slot.
Such an artifact is offered only to the consumers in this build. When the producer's checks
pass, its package is packed again and must match the stored artifact byte for byte. Only
then is it advertised in `.reactor/refs/`, and a consumer built on it is advertised only
after that. If the producer's checks fail, its waiting consumers are blocked, any already
running finish, the build fails, and nothing built on that artifact is advertised. Trains
and every other runner of a surface's commands run setup, the package phase and verify in
that order. Each task in the build report carries a `timeline`: the seconds into the build
at which it started, packaged and passed or failed.

The CEE gate overlaps independent build, domain, unit, lint and type-check stages within
`CEDAR_TEST_WORKERS`. The Angular build and coordinator tests remain ordered because they
share a cache. The domain harness has its own Vite cache and `harness/coverage/`
reports, so it cannot clear another tier's output. Visual checks follow those stages; packaging follows the visual gate.
The reactor builds, bundles and stages CEE's package first, as its package phase, and then
runs `test:ci:prebuilt` against those built bytes.
`test:ci`, `test:ci:prebuilt` and `test:ci:nonvisual:prebuilt` retain their original checks.
Direct npm gate invocations use the same CPU-based worker default. Each stage prints its elapsed time.

The model's `test:ci` gate overlaps lint, types, coverage, YAML parity, JSON parity
and the packaged-consumer smoke. Jest receives most of the worker budget rather
than being forced into `--runInBand`; pretest fixture generation still completes
once before any of the checks start (parity reads the same generated module). Each parity invocation owns its temporary output tree,
and only packaging writes `dist/`. In the reactor, `npm run build` first produces the package
its consumers receive. The gate's packaging stage rebuilds `dist/`, and that rebuild must
match the package already given out byte for byte.

The designer's `test:ci` overlaps unit, lint, types, import-boundary and packaging
checks. Its Angular unit tests and distribution build remain ordered because they
share a cache. The browser checks and the container visual baselines both wait for the
distribution and then run together: the baselines take two workers when the budget is at
least six, one otherwise, and the browser checks the rest. CEE gives
its domain/unit tiers two workers each when the budget permits, and fixture
opening waits for finite animations instead of an unconditional 300 ms delay.
No screenshot tolerance, baseline, browser project or integration input is removed.

The designer's complete gate enables its WebKit interaction project alongside Chromium;
both engines are installed by the shared recipe. Workspace builds before running its
whole browser suite (including WebKit and visual baselines) in the pinned container.
OpenView builds before its hermetic Chromium surface checks. These checks run in the
reactor and train as well as each application's CI. CED, CETP and Workspace use the
same 0.02 per-pixel colour threshold as CEE, with zero differing pixels allowed.

The CLI passes the worker budget into Angular builds and the component browser suites.
CEE's Vitest suites also honor it. The component gates pass `VITEST_MAX_WORKERS`
explicitly into Angular's Vitest runner as well as bounding Angular build workers.
Container browser dependencies use private anonymous volumes removed with
`--rm`, so concurrent reactor copies cannot race through `npm ci`. Reports and generated
fixtures stay in each isolated copy. This does not make two runs against the same checkout
safe: use separate reactor copies for concurrent runs. The browser image, architecture,
snapshot tolerances and baseline files are unchanged.

Every actual CLI build writes command durations, task dependency edges and exit codes to
`.cedar/build-reports/<timestamp>-<id>.json`, including failed/interrupted runs. Independent
running jobs drain after a test failure; Ctrl-C cancels owned subprocess groups. Increase
one concurrency setting at a time and compare elapsed times and failures before increasing
both. The shared pool bounds the workers running at once, so a larger `--jobs` no longer
multiplies them.

On a 16-core M4 with 64 GB RAM (2026-09-24), `--jobs 2 --workers 8` completed the
full frontend build and test gates in 320.8 seconds, before deployment and whole-stack
smoke. CEE's gate took 123.2 seconds, including 645 passing visual/browser checks.
These are measured elapsed times; no serial frontend comparison was recorded.

A subsequent component comparison on that machine used isolated copies with
installed dependencies, the same source/dependency inputs on both sides, and no
baseline updates. Before used eight workers and the older gate scheduling:

| Complete component gate | Before | New gate, 8 workers | New gate, 12 workers |
| --- | ---: | ---: | ---: |
| TypeScript model (all six checks) | 39.2 s | 20.0 s | 21.4 s |
| CEE (including visual and packaging) | 130.5 s | 103.3 s | 88.2 s |
| Designer (including browser integration) | 88.0 s | 78.4 s | 59.4 s |

The model comparison used committed source because unrelated working-tree model
changes failed the initial baseline. Its unchanged 3,529-test coverage suite also
passed with Jest's cache disabled: 26.2 s serial, 11.0 s at four workers, 10.3 s at
eight. CEE retained all 645 browser/visual checks; the designer retained 368 browser
checks and its existing one skip, with its separate 15-baseline visual gate passing.
The designer browser stage alone measured 64.5 s at eight workers, 45.6 s at twelve,
and 42.7 s at sixteen, so twelve captured most of the available gain.

These are component timings, not a full-reactor before/after result: dependency
installation, deployment and whole-stack smoke are outside the comparison, and
build/transform caches were warm except in the explicitly uncached Jest sweep.
Twelve is therefore the setting for this M4, and eight remains the portable default.
Preserve all gates when comparing.

After aligning designer expectations with the model's derived-title policy, the
current-source reactor at two jobs and twelve workers passed in 332.2 seconds for
builds and test gates, or 612.1 seconds including local deployment, served-component
verification and both smoke tiers. REST smoke passed 1,063 assertions in 81.4 seconds;
browser smoke also passed. This successful total uses newer sources than the component
comparison above and is not a controlled end-to-end speedup measurement.

#### Current artifact transport

`cedarcli build java` never consults a pin: it builds the repositories in dependency order,
installing each into `~/.m2`, so every consumer compiles against the sibling that came out of the
working tree a moment earlier. `cedarcli build frontends` now does the same, with no flag to ask
for it, because the pinned build belongs to the train rather than to a developer command.

npm has no moving coordinate to borrow, so each CEDAR dependency is rewritten to a local path in
the copy being built. That path is the sibling's published package, which is not its checkout: the
model library builds a `dist/` whose package.json is `package-dist.json`, CEE and the two Web
Components stage under `dist-npm/`, and the design tokens publish their root. Each repository
declares which it is. After it builds, `npm pack --ignore-scripts` packages that output using
npm's published file selection. The tarball is stored under its SHA-256 in
`$CEDAR_HOME/.reactor/artifacts`, with an atomically updated reference under `refs/`.
Consumers install the immutable tarball; they do not link to a shared directory or rerun a
producer's `prepare` script. Missing or invalid package output and packing or storage failures
fail the producer task.

`npm ci` becomes `npm install` for the same build, since a rewritten manifest no longer matches the
lock, and the resolved manifests and locks are retained as evidence before the copy is discarded. A development build is therefore not
lockfile-reproducible, which is why the pinned build stays the release path.

Every development frontend plan starts with an empty package selection and supplies its own
producers' outputs, including results reused for identical source and dependency fingerprints.
Narrow selectors (`build this`, `split-frontends` and `server-frontends` without `--server-payload`)
automatically include their transitive local producers. Missing source, an unregistered CEDAR
producer or a failed producer stops the build; neither an older local reference nor a registry pin
is a fallback. There is no development option to select registry pins instead. Third-party
dependencies retain their declared constraints. Concurrent builds cannot change another build's
selection or installed bytes. Old directory entries from the earlier store format are
ignored; rebuilding the producers populates the tarball store. Keep immutable artifacts while
builds are active; removing the whole `.reactor` cache is safe when no build is using it.

`ops/frontend-train.json` owns the shared `surfaces` inventory: source directories,
reactor identities, setup and verification commands, release build commands, and
integration bundle inputs. The reactor, npm train and release preparation read those
recipes. Every declared producer and consumer must have verification commands or an
explicit `verificationExemption`; missing coverage fails preflight. Add new surfaces
there alongside their dependency wiring, rather than editing separate gate lists.

A successful `cedarcli build frontends` records its exact component selection in
`.reactor/runtime.json`. Local `cedarcli native start|restart` in the develop profile installs
those tarballs with `npm install --no-save` before starting each frontend, retaining the
application lock for other dependencies. Existing verified installs are reused. A failed full
build leaves the previous selection intact, and concurrent producer refs cannot change a
completed selection. The runtime checker verifies the selected tarball hash, install provenance
and served bytes, so no publication is needed for local smoke tests.

An npm hidden lock can name the selected tarball while installed package bytes still belong to
an older build. The runtime installer compares the actual package files and removes only a
selected package proved stale before reinstalling it; otherwise npm can report an up-to-date
installation and retain the mismatch. Verification remains read-only and refuses that state.

The compilation stage leaves running frontends alone; after compilation and component checks,
`build frontends` restarts them to serve the selected build. Its local-tarball transport
does not publish to a registry or modify tracked manifests or locks: the build rewrite happens
in the throwaway copy. Registry publication and tracked pin updates are separate delivery work.
An explicitly selected server payload builds in place
and still installs its locks, and the train resolves exact Nexus aliases in its own checkouts, so
neither sees the reactor.

Because development no longer exercises the locks, the pinned composition is checked elsewhere:
each repository's CI runs `npm ci` on every push, and `cedarcli check components` with the release
and train preflights judge the composition. The isolated compilation stage proves the sources compose. Completing the local reactor
contract also requires runtime verification and smoke; release and train gates still verify
the separately pinned shipping composition.

#### Reading reactor evidence

`.reactor/runtime.json` names the selected package hashes and its `build` record under
`.reactor/builds/<SHA256>.json`. That immutable record contains each built source's Git revision,
fingerprint of tracked and nonignored source files (including uncommitted changes), executed
commands, local dependency edges, integration-test sibling hashes, and resolved manifests and locks.
All source fingerprints are captured before the first task, checked before each copy is built, and
checked again when the graph is recorded. Package version labels are
not source identities: a package compiled today can retain an older development version string.
Use the source fingerprint and artifact hash to identify what was built.

The train never searches this machine for a previous reactor. It captures committed sources and
builds its own graph, publishing immutable packages before wiring their consumers. A local reactor
can therefore test uncommitted work, but a train requires committed, pushed sources and smoke
evidence for those commits. Finish controller changes and runbook updates before the final smoke
and train capture; moving a captured head invalidates release eligibility.

A fresh model can expose failures hidden by an older checked-in pin. In particular, the model's
empty-string description default requires new designer child deployments to use the built
child's effective schema description rather than assuming an absent value is always null. Otherwise YAML restores `""` where JSON omitted the override, and the
designer's loss-detection guard refuses valid exports. Preserve the loss-detection guard and align
the producer/consumer default; do not bypass the gate or restore an older library to make it green.

The designer's browser suite conditionally enables real-sibling tests through `CEF_BUNDLE` and
`PICKER_BUNDLE`. The reactor supplies both from its selected immutable packages and records their
hashes. A test suite passing with these inputs absent does not prove the CEE/picker/designer
integration, because those cases are ignored or skipped.
Keep the extracted test bundles beside the isolated checkout, outside its source tree. Tailwind
scans local JavaScript: placing them inside the designer added 1,772 bytes of sibling-only CSS and
tripped its raw bundle limit. Moving the test inputs out restored the original output without
raising either size budget.

CEE's container visual gate mounts the local reactor artifact directory read-only at its original
absolute path. Without that mount, the host can install a `file:` dependency while the container
cannot resolve the same generated lock. The mount exposes only immutable tarballs.

### Recording a Pin

This updates checked-in registry dependencies. It is not a prerequisite for a local snapshot build.
The commit/CI requirements in this section apply to this publication command only.

```shell
cedarcli publish components                # report what would move
cedarcli publish components --apply        # publish, repoint, re-stage
cedarcli publish components --component ced
```

Each component is declared in `cedar-development/ops/frontend-train.json` under `components`. A
declaration names the repository, the published package, the package it stages, the command that
builds it, and every consumer whose pin follows it. The design tokens publish from their checkout
root and declare `"."`; the term picker and the designer stage under `dist-npm/`. A published
component is built from its checkout and named after its pushed `develop` head, so the checkout must
stand at that head. One left on another branch, or whose `develop` is not pushed, is held back with
the reason in the report.

A component that something else publishes is followed instead: `publish components` never builds
or publishes it, and only its declared pins move. The model library and CEE are the two. Each one's
CI publishes a development package from every push to `develop` and names it
`<base>-dev.<date>.<sha7>` after the commit it built, so the command derives that name from the
component's `develop` head and asks Nexus whether it holds the package. The model library is
declared under `components` with `publishedBy` and `followsHead`, and its consumers are CEE and the
designer. A run that repoints CEE's model pin also repoints its visual suite's, which the
configuration records under `cee.additionalModelConsumers`. CEE's consumers are not declared under
`components`: they are the inventory a release pins the public CEE into, each frontend's
`ceeConsumer` and the `additionalCeeConsumers`, so the two lists cannot disagree. A declaration can
instead name a `reference` consumer whose pin gives the version to follow, and nothing uses that form
now.

A followed component's consumers take the package CI built from its pushed `origin/develop` head,
fetched when the command runs, as a Maven build takes the newest snapshot. Unpushed commits and
uncommitted edits in the local checkout do not hold them back, because a development build takes
those from the checkout. They stay where they are, and the plan says why, only while that head is a
release-preparation commit or names a package Nexus does not hold yet. A run that moves one of
the component's own pins, such as CEE's design tokens, skips
it, because its CI package predates that change: commit and push it, let its CI publish, and run the
command again. After a release, this is the only command that moves the consumers from the public
CEE to the newest development package. The build train publishes and wires its own model, CEE and
shared-component versions in disposable checkouts and changes no source checkout, so do not use this
command as evidence that a reactor's complete dependency graph was published.

Applying it derives the component's development version from its pushed `develop` head,
`<base>-dev.<commit date>.<head>`, and publishes it unless the registry already holds that version.
It writes the version into the component's manifest and lock only while it runs the dist command and
publishes the staged package under the `dev` tag, then restores both files. Nothing is left to
commit in the component itself: a committed stamp would be a new head, which the next run would
publish again. It then repoints each consumer's manifest, moves its lock, and re-stages its served
bundles. A component whose pins moved earlier in the same run is not published from a head that
lacks them: commit and push it, then run the command again. A consumer that names the published
package itself gets a plain version. One that knows the package by another name gets npm's alias
form, as every CEE consumer does: it names `cedar-embeddable-editor`, and the development package is
scoped.

When a development reactor is active, pin updates only change manifests and locks
(`npm install --package-lock-only --ignore-scripts`): they leave installed packages and served
bundles intact and skip consumer restaging. Publishing must not roll a running local frontend back
to its older registry pins. Component publication itself starts with `npm ci`, so it builds against
the declared dependencies even when a local reactor installation differs. Use `cedarcli build frontends` and the native frontend restart to activate a new development
composition; verify served
bundle identities again after any packaging or publication work.

Reporting is the default because an npm version once taken cannot be republished. Every repository it would write to must be clean in its tracked
files first, so the diffs left behind are its own, and nothing is committed.

Run the consumers' suites before committing what a run moved. A library change that passes its own
CI can still fail a consumer whose fixtures or size budgets it tightens, because a consumer's CI runs
only when the consumer is pushed. On 2026-10-26 a run moved every consumer to a model library that
refuses a field written on its own that says it is required, and CEE and the designer stayed red on
`develop` until their fixtures and size ceilings followed. `cedarcli test frontends` builds and tests
every consumer against the local sources, which are the commits the new pins name, so it settles
the question before anything is pushed.

The train captures the term picker and the designer, so a train's recorded source names their
`develop` heads and its preflight asks the same questions of them as of every other source
repository.

`cedarcli build frontends` builds both components with `npm ci && npm run dist`, which is what
makes it produce a bundle and a staged package rather than only installed dependencies. Measured on
a development workstation with the stack running, the dist runs cost 4s for the term picker and 6s
for the designer, against 5s each for the `npm ci` that precedes them either way. A cold
`.angular/cache` made no appreciable difference: these are web components of 435 kB and 1.37 MB, and
Angular's own build reports 1.6s and 3.2s.

The check reads the workspace rather than the repository registry, so a component counts
as one as soon as a sibling installs it.

## Seeded history tests

The ordinary test gates include bounded, repeatable generated histories in CED,
CEE, Workspace, the term picker and the TypeScript model library. These complement example and matrix tests:
they explore combinations and operation order, while explicit regressions retain
the small cases discovered by a failing history.

| Repository | Generated histories and their independent checks |
|---|---|
| `cedar-embeddable-designer` | Tree edits, moves, copies, deletes, defaults and serialization; compare against a plain adjacency model and check old snapshots remain unchanged. Deferred terminology replies check field intent ownership, recovery, dirty state and save blocking through edits, moves, reloads and read-only transitions. |
| `cedar-embeddable-editor` | Nested occurrence and attribute operations; compare values, counts and pager positions against plain data. Host assignments check claims, atomic rejection, owned input snapshots and isolation between editors. Controlled-term and external-authority lookup histories combine timed queries, out-of-order replies, nested paging, template replacement, selection and destruction. |
| `cedar-model-typescript-library` | Nested schema and instance serialization; compare authored content and JSON/YAML stability. Instance YAML deliberately omits context and unfilled field slots, so that lane checks the documented payload rather than exact JSON equality. |
| `cedar-workspace` | Metadata create/edit histories compare the current draft, acknowledged baseline, revision and recovery requirements with a plain reference model. Saves, further edits, delayed responses, remote changes, discard confirmations and host recreation must preserve unsaved input and prevent duplicate uncertain creates. |
| `cedar-embeddable-term-picker` | Search and hierarchy histories mix response ordering, paging, release selection, source/endpoint changes, constraint replacement, selection and component recreation. Plain result lists, tree pages and constraint identities check ownership, duplicate prevention, pinned-term verification and immutable host inputs. |

Run larger explorations from the respective repository, after loading the native
profile as for other direct npm commands:

```bash
# CED: 2,000 editing histories
CEDAR_FUZZ_RUNS=2000 npm test -- --watch=false --include='**/editing-history.fuzz.spec.ts'

# CED: 2,000 histories with manually scheduled terminology responses
CEDAR_FUZZ_RUNS=2000 npm test -- --watch=false --include='**/terminology-history.fuzz.spec.ts'

# CEE: occurrence, attribute and host-assignment histories
CEDAR_FUZZ_RUNS=2000 npm test -- src/app/modules/shared/util/occurrence-history.fuzz.spec.ts src/app/modules/shared/util/host-input-history.fuzz.spec.ts

# CEE: 2,000 histories each for controlled terms and external authorities
CEDAR_FUZZ_RUNS=2000 npm test -- src/app/modules/input-types/components/lookup-history.fuzz.spec.ts

# Workspace: 2,000 histories each for metadata creation and editing
CEDAR_FUZZ_RUNS=2000 npx ng test --watch=false --include='**/metadata-history.fuzz.spec.ts'

# Term picker: 2,000 versioned search, hierarchy and selection histories
CEDAR_FUZZ_RUNS=2000 npx ng test --watch=false --include='**/picker-history.fuzz.spec.ts'

# Model library: 1,000 instance cases and 1,000 schema cases
CEDAR_FUZZ_RUNS=1000 npm test -- --runInBand SerializationFuzz
```

`CEDAR_FUZZ_SEED=1214` selects one seed instead of the run count. A failure prints
its seed and a reduced command list: the test deletes commands while retaining
the original assertion-message signature. This is a debugging aid, not a proof
of the smallest possible reproduction. Each replay starts with fresh state.
The asynchronous histories use deferred promises (CED) and a fake clock with
controlled response streams (CEE), so response order and debounce boundaries are
repeatable without network calls or sleeps. CED's async shrinker awaits each replay
and also preserves the assertion site. Both suites use two editors to check
isolation. CEE exercises real handlers, nested pager state, registry updates and
autocomplete subscriptions; actual browser rendering and live network behavior
remain the browser/integration suites' responsibility.

Workspace's metadata histories exercise the real host with CEE's public boundary,
HTTP and confirmation replies simulated; they do not replace CEE's own instance
tests. The picker histories exercise the real component and replace only its
terminology client. Both use fake clocks and awaited shrinking. Explicit histories
pin save/edit acknowledgement and release-switching races alongside the generated
cases. The default gates run 100 metadata histories per mode and 100 picker
histories; extended counts apply to each mode independently.

The preview-answer carry tests have their own existing `CARRY_FUZZ_RUNS` and
`CARRY_FUZZ_RUN` controls; they do not use the history-test variables above.

<a id="cee"></a>

## Embeddable Editor (CEE/CEF)

Build, run and test **CEE** (`cedar-embeddable-editor`) locally. Check the repository's CI
configuration for its toolchain and consumer manifests/lockfiles for installed versions.
Verify deployed identity by the served bundle's SHA-256; a displayed version is insufficient.

Sibling runbooks:
- [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee) — where CEE currently is, and the open
  work.
- [BACKEND-RUNBOOK.md](./BACKEND-RUNBOOK.md) — running the full CEDAR
  stack locally.

> CEE is a standalone Angular web component. It does **not** need the CEDAR
> stack running — none of the commands below depend on the microservices.

---

<a id="cee-node-versions--read-this-first"></a>

<a id="node-versions--read-this-first"></a>

### Node Version

CEE builds, runs and tests on one Node version, and `.github/workflows/test.yml`
is the source of truth for which.

| What | Node | Why |
|---|---|---|
| Everything in CEE — `ng serve`, `npm run test:ci`, `harness/` and `visual/` alone | **24.22.1** | Angular 22 requires `^22.22.3 \|\| ^24.15.0 \|\| >=26`. 24 is the active LTS where 22 is in maintenance. Pinned by CI. |
| `cedar-model-typescript-library` | 24.22.1 | Uses the same Node version as CEE. |

CEE and the model library use the same Node version for development, builds and tests.

Install it with Homebrew, keg-only so it does not displace the Node the other
CEDAR frontends use:

```bash
brew install node@24
```

Then put it in front for CEE work:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

Verify with `node -v` before blaming anything else: a version outside Angular's
range fails in ways that read as unrelated breakage.

Nothing here needs Java. The one exception is the canonical validator, which
needs **JDK 17** specifically — see
[Checking output against the CEDAR model](#cee-checking-output-against-the-cedar-model).

---

<a id="cee-running-the-app"></a>

### Running the App

CEE's standalone dev mode serves everything it needs from this repository, so
one command runs it.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install && npx ng serve
```

Then open `http://localhost:4400/`.

The developer app fetches its demo template and instance from CEE's own assets,
`src/assets/cee-demo/demo/template.json` and `metadata.json`, and hands both to
the component together so the form is built with the instance already read. The
template is the nested fixture the visual suite renders as `18-real-nested`: 23
field types over two pages, every temporal granularity, both choice and both
list cardinalities, the static widgets, the authority fields, and single and
multi-instance elements inside two wrappers.

Until 2026-08-15 it instead pulled samples over the network from a second
repository, `cedar-component-distribution`, cloned and served in a terminal of
its own and located by a `sampleTemplateLocationPrefix` key. That was the only
path on which CEE reached the network for an artifact. A host fetches its own
artifacts, and the developer app is a host like any other, so the key, the
second repository and the second terminal are all gone.

Below the form the same page renders the `cedar-embeddable-field` element on its
own, with a picker for the field it shows and a readout of what it reports. The
fields are `src/assets/cee-demo/demo/fields.json`, one artifact per input type,
extracted from the demo template beside it. It is the only place a widget can be
looked at without a form around it, and it exercises reassigning `fieldObject`,
which is what a designer does as an author changes a field's type.

The rest of dev-mode configuration remains in `src/app/app.component.dev.ts` —
the terminology and bridge base URLs, the offered languages, the read-only flag.
It is TypeScript, not JSON, and is compiled in.

<a id="cee-the-two-elements"></a>

### The Two Elements

The bundle registers two custom elements from one bootstrap.
`cedar-embeddable-editor` renders a template as a form, and `cedar-embeddable-field`
renders one field from its artifact. Editable CEF supplies the bare value control
for hosts such as CED's default-value editor. Read-only CEF owns the complete field
presentation: label, type, description and applicable constraints, choices, sources
and declared defaults. A supplied value remains visible and read-only.

`CedarFieldPresentationComponent` owns the shared label, description and content
layout for CEE fields and read-only CEF. CEE projects its occurrence pager into the
same presentation. `CedarFieldWidgetComponent` owns the control/static-content routing
and the read-only choice between a value and its specification; editable CEF uses
that bare widget directly. Empty specifications do not draw empty boxes. Workspace
preview dialogs supply artifacts and dialog controls, not field descriptions.

Registering them together is deliberate. `defineCustomElementOnce` takes a name and
`bootstrap-once.ts` still claims one page-wide slot, so two copies of the bundle
cannot both start Angular and a page cannot take the editor from one version and
the field element from another — they describe values in the same model classes.

A field artifact is not a template, so the element wraps it in a synthetic one-field
template before CEE builds anything from it (`util/single-field-template.ts`). The
wrapping states no cardinality, so the value the element acquires is single. A field
written on its own states no requirement either, because only a template or an element
requires the field it places. The strict reader refuses a field that says otherwise. A host
that places the field as required sets the element's `required` configuration key, and
the wrapping states it on the field's deployment. The field is then marked, and an empty
value reported as missing, exactly as in a form, unless the host sets
`suppressEmptyFieldErrors`. The wrapper template carries the
URN `urn:cedar:cee:single-field-template` as its `@id` — a template with none is
reported, and no repository holds this one.

The value crosses the boundary as a discriminated union rather than as text
(`CedarEmbeddableFieldValue` in `cee-public-api.ts`): a literal, a number, an ISO
temporal literal, an IRI with a label, a list of literals, or an attribute-value
field's named slots. An attribute-value field is read but not written — its slots are named
by the control that creates them. A standalone page break is described by its label
and type without creating form pagination.

<a id="cee-where-the-design-values-come-from"></a>

### Where the Design Values Come From

CEDAR's font stack, type scale, brand palettes and neutrals are published from
`cedar-design-tokens` as `@org.metadatacenter/cedar-design-tokens`, and its README is the reference
for them. Import the values with `@use '@org.metadatacenter/cedar-design-tokens/tokens' as tokens`.
Keep `node_modules` on the Sass load path, which `stylePreprocessorOptions.includePaths` declares beside
`src`. What stays in `src/_cee-layout.scss` is CEE's own — the trailing slot in a title row, the
card's inline gutter, and the size and gap of a toolbar control — because those measure a card no
other component draws.

The package must stay a `devDependency` that the published manifest never names. The reason is in
[NPMJS-RELEASE-RUNBOOK.md](NPMJS-RELEASE-RUNBOOK.md), under the release contract: the scope resolves
only from Nexus, which an embedding application installing public CEE from npmjs cannot reach.

The Material adapter uses M3 `mat.theme()` with explicit light color roles from
the package: primary 500, secondary primary 700, tertiary rust 500, pale brand
containers and shared neutrals. All typography roles use the shared px scale and
namespaced font stack. Supported component override mixins preserve 36px compact
controls, 48px comfortable fields and 28px editable choice rows with hit areas
contained within each row. Attribute name/value inputs have 16px of padding above
their form so floating labels clear the occurrence pager.
The system is emitted at each CEE/CEF shadow host so overlays inherit it too.
`THEMING.md` records the visual contract and `STYLING.md` the public compact-control
properties; Material's `--mat-*` variables remain private. The M3 browser suite
checks sentinel host overrides and overlays under a host root-font reset.

<a id="cee-building-the-web-component"></a>

### Building the Web Component

This is the real deliverable — a single JS file embeddable in any page.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run build:production
npm --prefix visual run bundle
```

The second step writes `visual/public/cedar-embeddable-editor.js` and a sidecar
manifest recording its sha256 and byte count, which the freshness guard and the
size gate both read rather than re-deriving.

The editor and the single field render into shadow roots that take the same
stylesheet, `src/app/modules/shared/directives/shadow-root.scss`. Declared as each
component's own style, it reached the bundle twice, because Angular keeps a
component's styles in that component's definition. `build:production`, `build`,
`start` and `test:coordinator` therefore first run
`scripts/compile-shadow-root-styles.mjs`, which compiles it once into
`dist-styles/shadow-root-css.ts`. The compilation repeats the one Angular's builder
gives a component stylesheet, so the text is what Angular embedded. `build` and `start`
pass `--development`, which leaves it unminified with an inline source map, as
Angular's development build leaves a component stylesheet. Every build
configuration in `angular.json` substitutes that module for an empty placeholder, and
the `ShadowRootStyles` host directive inserts it into each root, where Angular put a
component's own styles. Build through the npm scripts. A bare `ng build` uses whatever
an earlier run left in `dist-styles/`, and stops when nothing is there.

Do not join the build's output by hand. This used to read
`cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js`, and those are
Angular 14's filenames: the esbuild builder that arrived at Angular 17 stopped
emitting that set, so the command silently produced a truncated or empty bundle
rather than failing. `visual/resolve-build-output.mjs` decides what the build
actually emitted, and whether joining is even the right operation for it.

`cedarcli build this --wd "$PWD"` and `cedarcli build frontends` run this same pipeline, plus
the two installs and the staging step, from `build_command_list` on CEE's entry in
`cedar-cli/org/metadatacenter/config/ReposFactory.py`. Until August 2026 the CLI
instead reassembled the output itself with that hardcoded `cat`, which by then
truncated `dist-npm/cedar-embeddable-editor/cedar-embeddable-editor.js` to zero
bytes on every run — the redirection emptied the staged file before `cat` failed
on the missing inputs. The CLI has no separate copy of the packaging rules now,
so that class of drift cannot recur.

`cedarcli` selects the shared Node toolchain and verifies the actual interpreter against
the repository requirement before installing or compiling. The current baseline is 24.22.1.

`resolve-build-output.mjs` decides between two operations, and the difference is
scope rather than filenames. Webpack wraps each chunk in an IIFE, so joining them
shares nothing — note that `polyfills.js` alone carries a `"use strict"` prologue
ahead of its wrapper, which a self-containment test has to skip. The
`application` builder emits ES modules whose top-level names are only kept apart
by module scope; concatenating those into one classic script makes them global,
where they collide, and the file loads, runs, and fails inside Angular with
`Cannot read properties of undefined (reading 'lFrame')`. So `concat` requires
proof that every input wraps itself, and everything else is flattened through
esbuild instead.

<a id="cee-running-the-complete-test-gate"></a>

### Running the Complete Test Gate

The canonical, non-interactive verification command is run from the CEE
repository root:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:ci
```

It runs these stages in order and stops at the first failure:

1. Lint and all three TypeScript programs — source, domain harness and visual suite
   (`lint`, `typecheck`).
2. Fast Vitest unit specs under `src/`, in jsdom (`test:unit:ci`).
3. Angular's native Vitest/TestBed coordinator tier, compiling the real wrapper,
   editor and renderer templates with coverage thresholds (`test:coordinator`).
4. The Vitest domain harness with V8 coverage (`test:domain:coverage`).
5. A production build of the web component, fixture preparation and the Playwright
   browser suite at desktop and narrow viewport sizes (`test:visual`).
6. The npm package, staged from the bundle stage 5 just built and then verified
   byte-for-byte against the source each file came from
   (`package:npm:prebuilt`).

Stage 6 leaves `dist-npm/` present and current. That directory is what a consumer
can be pointed at to try an unpublished build, by symlinking its
`node_modules/cedar-embeddable-editor` at it — described under "Getting a Local
Build Into the Frontends". A fresh clone has no `dist-npm/` until something stages
it, so **run the gate, or `npm run package:npm:prebuilt` alone, before expecting a
symlinked consumer to serve CEE.** Use `cedarcli check components` and the reactor selection
to identify each consumer's installed source; do not infer it from a historical release label.

`dist-npm/` used to be committed, and the stage used to be a drift check
(`check:staged`) rather than a staging step. That arrangement cost more than it
paid: the committed copy went stale the moment source changed and only caught up
when somebody deployed — three commits behind before one deploy, two before the
next — and once the label was bumped without a rebuild, one version named two
different bundles. Since the files are generated and the build is reproducible,
the copy in git was a second source of truth that could disagree with the first.
It is now ignored, and staging is what the gate runs.

Verification is still a byte comparison, which needs the build to be
reproducible: two clean builds of the same source were verified byte-identical
before this was wired in. It also needed the manifest to stop carrying a build
timestamp — that field made every rebuild differ even when the bundle did not,
which is precisely what let the old drift hide.

The domain fixtures are vendored under `harness/fixtures/`. Neither
`cedar-artifact-library` nor `cedar-test-artifacts` needs to be cloned or
checked out.

<a id="cee-getting-a-local-build-into-the-frontends"></a>

#### Getting a Local Build into the Frontends

For a complete current-source build, use [the reactor](#the-reactor). The symlink procedure below
is a focused edit loop; it does not replace reactor acceptance and must not overwrite an active
reactor selection. To publish an installable package, see
[Releasing a dev snapshot locally](#cee-releasing-a-dev-snapshot-locally).

Point the consumer at `dist-npm/cedar-embeddable-editor` — `ln -s` over its
`node_modules/cedar-embeddable-editor` — and staging is then necessary but not
sufficient. The symlink means a consumer *resolves* the freshly staged bundle, but
every consumer **copies** it into its own served output, so each needs a second
step:

```bash
# Angular Workspace — copy the installed CEE bundle
cd $CEDAR_HOME/cedar-workspace && npm run copy:cee

# Production monolith while migration is in progress
cd $CEDAR_HOME/cedar-template-editor && npx gulp copy:cee

# OpenView and Bridging — the copy happens during the Angular build
cd $CEDAR_HOME/cedar-openview/cedar-openview-src && npx ng build
```

**Verify the served bytes after changing a package or symlink.** A running development server
may retain an earlier copied asset. Restart it after staging; if it still serves stale bytes,
clear its Angular build cache and restart:

```bash
cd $CEDAR_HOME/cedar-openview/cedar-openview-src && rm -rf .angular/cache
cedarcli native restart ui-openview
```

The cache is gitignored and rebuilds itself, so deleting it costs a slower first
compile and nothing else. Do not trust the restart on its own: check the hash.

A stale bundle can look like a styling defect: an older OpenView-served CEE once lacked the font,
type scale and field icons present in Workspace. Compare served hashes before changing styles.

Ask what each host actually serves before believing anything about appearance:

```bash
curl -s http://localhost:4220/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.host-fonts.js | shasum -a 256
shasum -a 256 $CEDAR_HOME/cedar-openview/cedar-openview-src/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.host-fonts.js
curl -s http://localhost:4200/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://localhost:4201/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
shasum -a 256 $CEDAR_HOME/cedar-embeddable-editor/dist-npm/cedar-embeddable-editor/cedar-embeddable-editor.js
```

Compare each response with the same bundle variant in its installed package. The standalone and
host-font scripts intentionally have different hashes; Workspace's loader may select host fonts too.

Matching each served hash to its selected package proves which CEE build the host runs.
For the same component source, appearance can still differ with host configuration. OpenView sets
`readOnlyMode: true`, for instance, so it legitimately shows no bound hints and no
clear buttons. `window.cedarEmbeddableEditorVersion` names the build in a page
that is already open, but it reports the label rather than the contents: a staged
bundle keeps the version from its last release until one is cut, so two different
builds can both call themselves the same dev version. The hash is what
distinguishes them.

<a id="cee-releasing-a-dev-snapshot-locally"></a>

#### Publishing a Registry Dev Package

This procedure publishes a package for other installations to consume. Ordinary development
uses `cedarcli build frontends` (or `cedarcli test frontends` for checks only), which automatically
uses current local source without publication, version changes or pin updates. A development
build request requires no follow-up approval. Use the procedure below only for registry delivery.

Publish snapshots scoped to `@org.metadatacenter` on Nexus, never unscoped: Nexus's old unscoped
CEE lineage can outrank current releases in semver ranges. `scripts/npm-package.mjs` selects the
channel from `-dev.` in the version. Pass `--tag dev` explicitly because npm 11 ignores
`publishConfig.tag`; dry-run the same command first and verify the registry's dist-tags afterwards.

A snapshot is a real published version, so every frontend can name it and install
it, and anyone can fetch it later. Reads from Nexus are anonymous; only publishing
needs the credential already in `~/.npmrc`.

Version it `<next>-dev.<date>.<sha>`, where the commit is the one whose content
ships and the date is *that commit's*. Bump `package.json` and the two root
entries in `package-lock.json` — take care, since a dependency may legitimately
also be at the version being replaced — and set the load-trace stamp to
`'<YYYY-MM-DD HH:MM> <sha>'` naming the same commit. `check:npm-package` compares
the two and fails if they disagree. Then run the gate, stage, and publish with the
tag stated explicitly:

```bash
npm run test:visual && npm run package:npm:prebuilt
cd dist-npm/cedar-embeddable-editor && npm publish --tag dev
```

Each frontend then names the snapshot through an npm alias, because npm routes by
scope and this is the only package taken from Nexus:

```json
"cedar-embeddable-editor": "npm:@org.metadatacenter/cedar-embeddable-editor@<next>-dev.<date>.<sha>"
```

All seven manifests already carry the `@org.metadatacenter:registry` line an alias
needs. Install, then get the bundle into what each host serves:

| Host | Install | Then |
|---|---|---|
| `cedar-workspace` | plain | `npm run copy:cee` |
| `cedar-template-editor` | plain | `npx gulp copy:cee` (needs the profile sourced) |
| `cedar-bridging` | plain | restart the server |
| `cedar-openview` | plain | restart the server; publication alone materializes `cedar-openview-dist` |
| `cedar-component-demo` (Angular) | plain | nothing to deploy — it is not served here |
| `cedar-component-demo` (Ember, React) | plain | nothing — they run from source |

The three framework demos verify that `showDownloadMenu` reaches CEE by finding its
accessible Download button. Assert the control rather than a Material icon ligature:
CEE uses SVG icons, whose `mat-icon` text is empty. A correct rendered control can
therefore fail an old assertion for `file_download`. Run each demo's own tests after
advancing its public CEE pin; component checks and compilation do not cover those assertions.

The install is what places the new bytes for openview and bridging. Neither imports
CEE: each declares an asset glob that copies `cedar-embeddable-editor.js` out of
`node_modules`, and loads it through a script tag in `index.html`. A **running `ng
serve` still serves what it started with**, because a `node_modules` swap is not a
source change, so `ui-openview` and `ui-bridging` need restarting and the restart is
the deploy; the same `.angular/cache` caveat above applies to openview. The native
Workspace server and the monolith's Gulp server need no restart — each serves the file
`copy:cee` wrote, so there the copy is the deploy. A Workspace preview image must
instead be rebuilt and recreated because its CEE bundle was copied into the image.

`cedarcli build this` deploys nothing to any of them. It builds in an isolated
workspace and leaves the repository's own `dist/` untouched, so reach for it to prove
a host still compiles against the new bundle, not to put one in front of a server.

```bash
cedarcli native restart ui-openview ui-bridging
```

Compilation is seconds, not minutes: `ng serve` reports `Compiled successfully` in
the frontend log — `$CEDAR_HOME/log/frontend-<name>.log` — and 400ms is typical for
an incremental rebuild. If a check still shows the old bundle after that, the
build is not what is behind; look at what is being fetched.

Then confirm, and **ask each host at the path it actually serves** — they differ,
and checking the wrong file reads exactly like a failed deploy:

| Host | Where the bundle is |
|---|---|
| Extracted Workspace (`cedar-workspace`) | `/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| Production monolith (`cedar-template-editor`) | `/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| openview | `/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js` |
| bridging | `/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js` |

Every host serves the bundle as a file, so compare sha256 against the staged one in
each case. That holds for the distributions too: a build copies the same file to the
same path rather than folding it into `main.<hash>.js`.

Compare the hash rather than the version, because a dev snapshot's two versions
differ by design. CEE stamps the bundle with the commit it was last versioned at, so
the snapshot published as `2.0.12-dev.20260913.96b2097` carries the stamp
`2.0.12-dev.20260911.448b9d2e`, and a check reading the stamp against the version
npm resolved fails a correct deploy. A bare semver is weaker still: the bundle holds
every dependency's version, so a `2.0.3` in it may belong to something else entirely.

```bash
# The four running servers. All four answer with the staged bundle's hash.
curl -s http://127.0.0.1:4220/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -s http://127.0.0.1:4340/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://cedar.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
curl -sk https://workspace.metadatacenter.orgx/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js | shasum -a 256
```

The committed distribution directories are a separate question, and asking them this
after a local deploy invites the false alarm this section exists to prevent. A train
or a publication writes `cedar-bridging-dist` and `cedar-openview-dist`; nothing done
locally does, so each keeps the CEE of the last one until then and answers with an
older hash while every running server is correct.

```bash
shasum -a 256 $CEDAR_HOME/cedar-bridging/cedar-bridging-dist/node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js
```

<a id="cee-first-time-setup"></a>

#### First-Time Setup

CEE resolves the model library from
`@org.metadatacenter/cedar-model-typescript-library` on the BMIR Nexus, so no
sibling checkout is needed. Only that one package comes from Nexus; everything
else resolves from npmjs.org, and reads need no credentials.

```bash
cd ../cedar-embeddable-editor
npm ci
npm --prefix harness ci
```

The visual suite needs no install of its own: it runs in Playwright's container,
which carries the browsers, and installs its dependencies there against a named
volume. It does need Docker running.

The gate should report 0 lint problems and, on 26 August 2026, at least 223 unit tests,
2,897 domain tests and 473 Playwright tests.

Read those as floors rather than as targets. Their only use is catching a suite that
silently ran nothing — a filter matching no file, a project that failed to start —
so what matters is the order of magnitude, and a count well below one of these is
worth explaining before it is written down as the new figure. A count *above* it
needs no explanation and is not a reason to edit this line.

The Git history already carries three warnings about doing that anyway. It
once carried a Karma figure years after the move to Vitest; the numbers above
replaced a set that had drifted in both directions at once, low on unit and
Playwright and high on domain, because removing four snapshot recordings that
compared minted identifiers took the domain count *down*; and the Playwright figure
disagreed with the one in
[Running the visual baseline](#cee-running-the-visual-baseline) by 42. Prefer citing a date
and a floor to maintaining an exact number in more than one place.

Use the complete gate before pushing or opening a pull request. The focused
commands below are faster feedback while working on one layer.

<a id="cee-auditing-what-ships"></a>

#### Auditing What Ships

```bash
npm run audit:prod
```

`npm audit --omit=dev --audit-level=high`, and CI runs it as its own step after the
gate. `--omit=dev` because only runtime dependencies reach the bundle an embedder
downloads — the Angular CLI's tree is a hazard to a developer's machine, not to a
consumer. `--audit-level=high` because a moderate advisory against build tooling is
not worth stopping a release for, and the value of the step is that a failure means
something.

Deliberately **not** part of `test:ci`. It is the one check that can start failing
without anyone having changed anything, because it fails on a disclosure rather than
on a commit. Inside the gate it would break an unrelated pull request with an error
its author cannot fix there, and would teach people to expect a red gate for reasons
that are not theirs.

The supported frontend toolchain uses Node **24.22.1**, Angular CLI and build **22.2.6**,
Angular CDK and Material **22.2.6**, and Angular core **22.2.4**. Angular's 22.2.6 builder
selects Vite 8.3.5. The development-server advisories against the Vite 8.3 line are fixed from
8.3.3, so no project overrides Vite.

CEE, CED, CETP and Workspace hold `@ngx-translate/core` at 18.0.x with a `~18.0.0` range.
Release 18.1.0 changes how often the service announces a translation change, which fails
CEE's late-language specification, and it enlarges CED's bundle past its size ceilings.
The upgrade is tracked in [FRONTEND-ROADMAP.md](FRONTEND-ROADMAP.md). OpenView, Bridging and
Monitoring take 18.1 with a `^18.1.0` range and register it through its provider functions; none of
them selects a language at run time.

A fresh audit of the eight changed modern frontend locks on 2026-11-06 reports zero moderate,
high or critical findings, including development dependencies. Seven report no findings; the
TypeScript model library retains the six low findings described below. Every one of the 24
registered frontend locks matches its reviewed baseline. The registered locks include the
Playwright test packages in the `browser/` directories of
Workspace, the Template Designer host, OpenView, Monitoring, Bridging, CETP and CED. Each
declares an empty `allowScripts` policy, because none of them locks a package with an
install script, and the train holds them to it as it holds every other registered lock.
The TypeScript model library's lock reports six low findings, all from one advisory,
GHSA-gcqx-w48m-w2h4, which reports prototype poisoning in `deepmerge` 4.3.1. The package
reaches the library through `jest-config`, and Jest runs only the library's tests. No
patched `deepmerge` exists, and the fix `npm audit` offers is Jest 25, a downgrade. The
train baseline records the six findings. The legacy Template Editor is separate from that
result.

The affected modern tool trees override only `minimatch@>=7 <11.0.1` to 11.0.5; the model
library and Ember demo also override `glob@>=9 <14.0.2` to 14.0.4. These remove
GHSA-g3hv-75wg-m249 and GHSA-3g3m-2fjr-6pw4 while leaving unaffected older API majors in place.
The full frontend checks and all three consumer demos passed with these selections. Remove
the overrides when their upstream consumers select patched versions themselves.

This toolchain passed the full frontend reactor, all three framework consumer demos,
local deployment, served-bundle verification and whole-stack smoke on 2026-10-29.
The existing visual baselines, test skips and declared search-coverage gaps were unchanged.

The security lock refresh selects `fast-uri` 3.1.9 throughout the modern frontend and
E2E tooling, `body-parser` 2.4.0 in the Ember demo, and a patched Zod 4.6.x in the React
demo. Review fresh audit details, including advisory identifiers and affected paths; a
matching severity count does not prove that the same advisories were reviewed. After
changing locks, run `cedarcli publish baselines --refresh` and review the resulting
`ops/frontend-train.json` diff. This updates train evidence; it does not publish packages.

The reactor, the in-place server-payload builds and the CEE demo gate install with
`NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true`, as the train and every frontend CI workflow do. npm
then refuses a locked package with an install script that the package's `allowScripts` policy
does not cover. Each approval names an exact version, so a lock refresh that moves such a
package fails the next reactor run until its approval moves too. Compare the new release's
install script with the approved one (`npm view <package>@<version> scripts`) before moving
the approval. When the reactor substitutes a locally packed CEDAR package, it also denies that
package's scripts in the rewritten manifest. npm counts the design tokens' `prepare` script as an
install script of a file dependency, though a registry install never runs it.

Dependency rounds and lock refreshes leave the legacy Template Editor's npm tooling as it
is until the Workbench retires. On 2026-11-04 its lock reported 9 critical and 32 high
advisories, all in its Gulp and Karma build and test tooling, and a plain `npm update`
would have downgraded some of its packages, among them `request` and `tough-cookie`. The
CEDAR development packages it consumes still move with the other consumers. No npm audit
covers its vendored Bower assets.

**Never run `npm audit fix --force` here.** npm's idea of fixing the Angular
tooling is to walk it backwards: it proposed `@angular/cli@21.0.4` and
`@angular-devkit/build-angular@0.1002.1`, which is the *Angular 10* numbering —
adding 1,253 packages, removing 302, and undoing the upgrade march to silence
warnings about build tooling an embedder never downloads.

**Time a dependency bump against the release calendar, not against the advisory.**
A CEDAR platform release proves the CEE its train built byte-equivalent to the public
npmjs package. Until 2.0.30 the browser bundle embedded the root `package.json`, so a
changed range reached the shipped bytes even for a test-time dependency that never
runs in a host page, and the proof read it as an undeclared difference. Patching
vitest between a CEE release and the train that would consume it cost a second
public release, 2.0.9, carrying no code change at all. The bundle now embeds CEE's
version alone, so a range change alone no longer reaches it. A bump that changes
code the bundle compiles still does. Land such a patch after a release rather than
before one, or expect to cut the package again.

`npm audit fix` also declines a patch it could take. The advisory against vitest was
fixed in 4.1.11, inside the declared `^4.1.10`, and `npm audit fix` reported "fix
available" while changing nothing, because the newest candidate it saw was the 5.0.0
major and `--force` is forbidden here. Install the patched version by name when that
happens.

That is also why a failure here is not automatically a release blocker. Read the
advisory and ask whether CEE reaches the vulnerable path — when `lodash-es` 4.17.21
was flagged for `_.template`, `_.unset` and `_.omit`, CEE called only `cloneDeep`
and no advisory described anything it could reach. Upgrade anyway if a fix exists,
because a flagged package is one every embedder would otherwise have to reason about
alone; but the reasoning belongs in the commit message, not in a version bump made
on reflex.

<a id="cee-what-ci-runs"></a>

#### What CI Runs

`.github/workflows/test.yml` runs the same release gate on every pull request and
on pushes to `main`, `develop` and the `cee-angular-**` branches. It is split for
latency, not semantics: the `prepare` job builds once, runs lint, type checking,
unit, coordinator and domain coverage, verifies the staged npm package, audits the
runtime tree and uploads `dist`; four `visual` jobs restore that exact build and run
Playwright with `--shard=1/4` through `--shard=4/4`. A shard failure fails the gate,
and `fail-fast` is off so one failure does not hide results from the other three.
The local `npm run test:ci` runs the same checks with a bounded stage scheduler;
`CEDAR_TEST_WORKERS=1` serializes it. Two of CI's
choices are deliberate and expensive to rediscover.

**The runner is `ubuntu-24.04-arm`, and the visual suite runs in a container.**
Screenshot baselines record a machine's text rasterisation as much as the
application's rendering, so recording on a laptop and checking on a runner
compares two things that were never going to agree. Measured on 2026-08-16, that
boundary moved 7 of 106 baselines by 124 to 393 pixels, and a `maxDiffPixels`
budget of 120 had been papering over it. `visual/run-in-container.sh` puts both
sides in Playwright's own image, so the baselines are `-linux`, the budget is
zero, and a diff can only mean CEE draws something different.

Two consequences worth knowing before changing either. The runner must be arm64,
because the script asks for `linux/arm64` and an x86_64 runner would rasterise
differently and put the problem back without saying so. And the image tag in that
script can move every baseline at once, so treat a bump the way an OS upgrade used to
be treated. Run every container suite on the new image first, and re-record only what
it moves, deliberately. The move from `v1.63.0-noble` to `v1.64.1-noble` on 19 October
2026 moved none of the 247 CEE, CED, CETP and Workspace baselines.

This was `macos-15`, pinned so a runner bump would not move the macOS baselines,
and specifically not `macos-14`, where Playwright served a WebKit frozen at v2251
against a driver expecting v2336 — `Page.overrideSetting: PushAPIEnabled` is
unimplemented there and every `newPage()` in the webkit-smoke project failed.
Linux builds are current, so that constraint left with the runner. macOS runners
cannot host a Linux container either way.

**One Node version, 24.22.1, for the whole job.** It used to change midway —
build on 16.20.2, switch to 20.20.2, reinstall, then test the already-built
`dist` — because Angular 14's toolchain and the Playwright the suite needs did
not accept the same version. Angular 15 onwards do, so the split went at that
hop, and the dist that ships is now produced on the same Node that exercised it.

Lint runs first, as the opening stage of `test:ci` rather than as a separate CI
step, so the gate has one definition locally and in CI. Warnings do not fail the
build. Lint covers source and visual TypeScript; `typecheck` runs strict, no-emit
programs for source, the domain harness and the visual suite. Playwright transpilation
is not the visual suite's type checker.
The toolchain matches the framework — `angular-eslint` 22, `typescript-eslint` 8,
ESLint 10, flat config in `eslint.config.mjs`.

**Four Angular rules are off, and three of them are decisions rather than debt.**
Angular 22's rule set reported 413 errors, of which 411 were `prefer-control-flow`
(203), `prefer-inject` (118), `prefer-standalone` (47) and
`prefer-on-push-component-change-detection` (43). Each asks for an architectural
rewrite that is tracked elsewhere or placed out of scope, and a gate nobody can
pass gets ignored rather than fixed. The OnPush one is not deferred but wrong for
CEE: the coordinator mutates model objects in place and the component tree reads
them under eager change detection, so OnPush would stop parts of the view updating.
Obeying it would undo by hand the Angular 22 migration that stamped `Eager` onto all
46 components. Moving to OnPush means moving to immutable updates or signals first.

**A lint upgrade proves nothing until the gate is shown to still fail.** Before the
toolchain moved, deliberate violations of `eqeqeq`, `banana-in-box`,
`no-unused-vars` and `prettier/prettier` were each confirmed caught under the old
`@angular-eslint` 14 — which was enforcing Angular 14's rules correctly on a
TypeScript three majors past what its parser declared support for. The same four
probes pass now. Re-run them after any future toolchain move.

Nothing is published from CI. Releasing the npm package is a separate, manual
procedure — see [Release](#cee-release) below.

<a id="cee-running-the-domain-test-harness"></a>

### Running the Domain Test Harness

The harness depends on the published model library, resolved from Nexus like
CEE's own dependency, so no local build of it is needed.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:domain
```

Expect **over 5,800 passing** on `develop`, 5,821 on 28 October 2026. For watch
mode, run `npm --prefix harness run test:watch`.

A green run here means CEE agrees with itself. For whether its output is
actually a valid CEDAR instance, see
[Checking output against the CEDAR model](#cee-checking-output-against-the-cedar-model).

<a id="cee-coverage"></a>

#### Coverage

```bash
npm run test:domain:coverage
```

Over `shared/factory`, `shared/handler`, `shared/util` and `shared/validation` —
the domain layer the harness actually targets — expect roughly **95%
statements**. The rest of `shared/` is Angular services, REST response models
and pipes, which the harness does not load and should not, so the headline
number for all of `shared/` is meaningless.

Coverage is enforced by directory rather than against that misleading
aggregate. All four carry a 90% statement and 85% branch floor. These grouped
thresholds are part of `npm run test:ci`, so a domain regression fails CI even
when every test assertion still passes.

The broad floors are backed by focused tripwires where churn is most dangerous.
The domain harness holds `ActiveComponentRegistryService` at 75% statements / 65%
branches and `TemplateRepresentationFactory` at 95% / 95%. The root unit suite
holds the artifact-input coordinator at 90% statements / 85% branches, the config
coordinator at 95% / 95%, and the wrapper at 70% / 60%. Do not replace those with
one global percentage: a heavily covered serializer can otherwise conceal an
untested artifact transition or widget-sync branch.

Branches sit below statements because Vitest has counted them differently since
version 4, not because the suite is weaker. Version 4 replaced the old V8 mapping
with AST-aware remapping and offers no way back, and source that cleared 90%
everywhere under Vitest 1 measured 86.6 to 91.5 under 4. No test was removed and no branch
stopped being exercised — branches the old mapping never counted are now in the
denominator.

Read the *never-called-function* list rather than the percentage. That is what
found the attribute-value hole in August 2026 — three functions no test had ever
entered, one of them the widget's delete button — and, right after it, a bug
that had been losing everything inside an element on reload.

To run one file (note: paths are relative to the repo root, not `harness/`,
because `vitest.config.ts` sets `root` to the repo):

```bash
npm --prefix harness run test -- harness/test/controlled-terms.spec.ts
```

<a id="cee-reading-a-template-from-yaml"></a>

#### Reading a Template from YAML

CEE parses templates through the CEDAR Model TypeScript Library, which reads
YAML into the same model it reads JSON into — so a template written either way
produces the same form. `harness/test/format-independence.spec.ts` checks that
over all 37 corpus templates, and `harness/test/instance-output.spec.ts` checks
the same for the instance CEE emits.

If either starts failing after a change to the parser or the emitter, the
question to ask is which of the two formats the new code is quietly assuming.

<a id="cee-opening-a-legacy-production-instance"></a>

#### Opening a Legacy Production Instance

Some stored instances predate repository minting for element occurrences and
carry `"@id": ""` on an occurrence. CEE deliberately gives only that legacy
shape a compatibility path. At its input boundary it clones the host's object,
uses the model reader's node classification to distinguish occurrence
containers from link and controlled-term values, and changes a blank occurrence
identifier to `null`. It never mutates the object supplied by the host. The
ordinary server PUT then recognizes the defect in the stored instance and mints
the repository identifier; the same blank introduced against a clean stored
instance is rejected.

Do not widen this exception. A blank root artifact identifier, a blank link or
term identifier, and a blank value in a new instance remain errors. Strict model
readers also continue to reject a blank occurrence identifier. The February
2024 TypeScript compatibility reader is the matching library path: it opens the
legacy occurrence with a warning and writes `null`. The regression contract is
in `harness/test/occurrence-identity.spec.ts`.

Deserialization failure at the custom-element boundary is fail-closed. CEE sends
an actionable error through `eventHandler`, renders no replacement empty form,
and does not spend the instance's set-once claim; the host may correct the value
through the same input. This applies to both `instanceObject` and the instance
inside `templateAndInstanceObject`. The browser regression is in
`visual/tests/render.spec.ts`, beside the other set-once input tests.

A successful first form render calls `eventHandler.ready()` exactly once for the
element. A rejected artifact calls no readiness callback, and attaching a handler
after rendering does not replay one; hosts that use it register the handler before
the artifact. The visual host still waits for fonts and layout after that signal,
because screenshot stability is a stronger condition than editor readiness.

Artifact intake has one owner: `ArtifactInputCoordinator` in the wrapper. It parses
an instance and builds a candidate `DataContext` / `HandlerContext` before publishing
anything, then advances one artifact revision. A rejected candidate changes neither
the live state nor the set-once claims. The inner editor receives those completed
contexts plus the revision and must not deserialize the raw host inputs again.
`WrapperConfigCoordinator` owns the independent configuration lifecycle and reapplies
the one accepted config whenever artifact intake publishes a replacement context.
Keep those responsibilities separate: artifact arrival order must not become config
state, and the renderer must not become a second parser.

Model-to-widget synchronization has one owner: the wrapper-scoped
`RenderSchedulerService`. Artifact input, multi-instance paging and mutation, and
page-break navigation update model state synchronously and schedule their registry
push with Angular's `afterNextRender`. Each schedule advances a generation and
cancels the previous one, so rapid inputs cannot apply stale state to a newer
component tree. Destroying the editor scope cancels pending work. Do not introduce a
local `setTimeout` to wait for a widget; schedule the whole post-render transition
through this service instead.

Model-to-host mutation reporting also has one owner: `HandlerContext` reports a
successful field or multi-instance operation to the wrapper, and the wrapper compares
the serialized instance and quality report with the last state it published before emitting a
composed, bubbling `change`. This is a model contract, not forwarded browser traffic:
focus, blur, paging, read-only controls and a no-op write emit nothing. The detail is
`CeeChangeDetail` and carries the operation, component path, value, validity, full
data-quality report, title and description. Field mutations also invoke the optional
`eventHandler.valueChanged(path, value)` callback. Unfinished edits can change validity without
changing serialized metadata, and must also notify the host. Keep the state comparison
at the wrapper boundary; reporting directly from widgets will miss non-native controls
and will duplicate events when control implementations change.

CEE deliberately does not own a dirty flag. The CEDAR workspace knows when persistence
succeeded, so `CeeDirtyTrackerService` in `cedar-template-editor` snapshots
`cee.currentMetadata` after load and after a successful create/update, then structurally
compares that baseline after every CEE model-change event. An edit therefore marks the
workspace dirty, an exact revert clears it, and a successful save establishes the new
baseline. The service's unit spec pins those three transitions and defensive copying;
the CEE browser suite's `host change notifications` group pins text, Material choice,
controlled-term, temporal, multi-instance, paging and read-only behavior in both viewport
projects. It lives in `visual/tests/host-change.spec.ts`, separate from the broad rendering
matrix, and uses the typed driver in `visual/tests/support/host.ts`; extend it whenever a
new mutation path is added rather than putting host API assertions back into
`render.spec.ts`.

Initialization is part of that contract. A canonical loaded instance emits no change.
If rendering has to normalize an existing temporal value to the field's declared storage
granularity, the serialized instance really did change, so CEE emits the corresponding
`valueChanged` event during initialization. A host that wants to observe that must install
its listener before assigning the artifact. The runtime assertion covers every required
`CeeChangeDetail` member, while the shipped custom-element declaration gives
`addEventListener('change', ...)` a `CustomEvent<CeeChangeDetail>` parameter. The legacy
`eventHandler.message` member has never been emitted and is deprecated until the next
major version removes it.

Shared Angular subscriptions use `takeUntilDestroyed` with the component's
`DestroyRef`; do not add component-local `Subscription.EMPTY` or `destroy$`
variants. The coordinator tier creates and destroys the real editor repeatedly and
requires its scoped widget registry to return to zero on every cycle. Add equivalent
teardown assertions when a new scoped registry, overlay owner or scheduler is added.
This rule includes delayed widget work: external-authority and controlled-term lookup
debounces, autocomplete panel-closing subscriptions, deferred panel opens and transient
revert/clear hints all terminate with the field. Their direct unit specs destroy the
injection scope while each kind of work is pending.

`harness/test/view-sync.spec.ts` is the model-to-widget contract. Its table covers
editable and read-only rendering for text, numeric, temporal, link, external
authority, controlled-term and checkbox values across a multi-element occurrence
whose next child is missing. `harness/test/pagination-invariants.spec.ts` enumerates
every content/page-break sequence through six children, including leading, trailing
and consecutive breaks. Extend those matrices when adding a new value shape or
navigation state; a one-off happy-path spec is not a replacement.

Multi-instance navigation state also has one owner:
`HandlerContext.multiInstanceObjectService`. `DataContext` owns the template and the
instance document; it does not keep a second reference to the navigation tree. The
tree alternates deliberately between two typed shapes: a `MultiInstanceInfo`
container maps child component names to their state, and each
`MultiInstanceObjectInfo` holds that component's cursor plus one child container per
element occurrence. Containers use an internal `Map`; component names are not
dynamic properties on a class. Occurrence counts remain derived from the live
instance, while cursors remain UI state. Rebuilding records the exact
template/instance pair so the inner editor does not reconstruct the same tree after
`DataContext.setInputTemplate` has already done so.

The data quality report never reads those cursors. It walks the instance itself,
entry by entry, so the page and the entries on screen cannot change what it reports,
and each problem records the entry taken at each repeating field or element along its
path, outermost first, as `occurrences`. That is the location `reveal` consumes, and
the same bad value in two entries is two problems. Each existing containing element
must satisfy a required field; one filled element cannot satisfy an empty sibling.
The counters count declarations, with a declaration complete only when all its
containing elements satisfy it. A repeating field needs at least one answer within
each containing element. An omitted optional repeatable list can represent an empty answer;
an absent property required by the artifact structure is a `missingProperty` error. Raw input is
checked before export completion can supply empty slots. The location contract is in
`harness/test/report-locations.spec.ts`.

`HandlerContext.validation` owns validation coordination. Loads and mutations rebuild
the report before notifying the host. Stored data is checked by the pure report walk
and `FieldValueValidator`; unfinished date/time and attribute-name drafts are keyed
by their actual occurrence node, so paging cannot relocate them, copying duplicates
them independently, and deleting a branch removes its issues. Attribute deletion
uses the accepted name and removes its sibling value before publishing a change.
Required answers, minimum counts, provisional unnamed attribute rows and well-formed values outside
their constraints carry `severity: warning`. Malformed typed values, malformed stored attribute names,
missing structural properties and inconsistent template constraints carry `severity: error`.
Both affect `isValid`; the common instance policy supplies `canSave`, `structurallyValid` and
`blocksSave` for hosts, while the template policy blocks inconsistent defaults.

JSON input recovery preserves malformed field IRIs and well-shaped numeric,
temporal and IRI defaults for correction instead of rejecting the entire form.
Malformed element atoms are reported at their occurrence and replaced only when a
user edits a child field. Envelope identifiers still use the model reader's strict
boundary; unsupported shapes can require a corrected input. An instance naming a
different template remains invalid. The YAML parser retains the model library's
strict default validation.

`harness/test/validation-state-matrix.spec.ts` crosses depth 0/1/3/6, read-only/editable
loads, all seven numeric types, bounds, malformed identifiers/defaults and repair/reload.
`validation-state.coordinator.spec.ts` uses real Angular widgets for draft navigation,
copy/delete and recovery; the browser matrix checks the shipped bundle and host events.

<a id="cee-running-against-the-old-template-parser"></a>

#### Running Against the Old Template Parser

**Historical.** The hand-written JSON walk was kept alongside the
library-backed parser during the migration so the whole suite could be run
against either, which is what caught most of the defects. Both walks were
deleted once the swap had settled, and `CEE_TEMPLATE_PARSER` /
`CEE_INSTANCE_READER` no longer exist. On `develop` — before the migration —
the walk is the only implementation:

```bash
CEE_TEMPLATE_PARSER=json-walk npm test
```

Expect the same count either way. Four rendered list fields across the corpus
genuinely differ — `multipleChoice` normalised against the property's
cardinality rather than copied verbatim — and `harness/test/corpus.spec.ts`
names them one by one, so a difference that stops happening fails as loudly as a
new one. Run this before and after anything that touches
`factory/model-library-template-parser.ts`.

<a id="cee-checking-output-against-the-cedar-model"></a>

### Checking Output Against the CEDAR Model

Everything above checks CEE against itself. This checks it against the model.

The distinction is not academic. In August 2026 the harness had 1,488 passing
tests, including a pair that compare CEE's JSON output against its YAML output
and find them equivalent — and **zero** of the 37 instances CEE produced
validated against the template it built them from. The tests all agreed with
each other. None of them asked the model.

<a id="cee-why-a-template-can-validate-its-own-instances"></a>

#### Why a Template Can Validate Its Own Instances

A CEDAR template *is* a JSON Schema (draft-04) for its instances. Not a
description of one — the document itself, `properties` and `required` and all.
That is exactly how `cedar-model-validation-library` validates an instance:
`CedarValidator.validateTemplateInstance(instanceNode, schemaNode)` hands the
template to a JSON Schema validator as the schema.

So there is nothing to derive and no mapping to trust. Any draft-04 validator
can answer the question.

<a id="cee-the-canonical-check--cedar-model-validation-library"></a>

#### The Canonical Check — cedar-model-validation-library

`cedar-model-validation-library` is the arbiter. When it and anything else
disagree, it wins.

It needs **JDK 17** — the POM enforces `[17,18)` and will refuse 21 or 23 with
`RequireJavaVersion` — and its parent POM `org.metadatacenter:cedar-parent`,
which resolves only against the CEDAR nexus. Clone and `./mvnw install`
`cedar-parent` first if you have not; the public repos return 402 for it.

```bash
cd ../cedar-model-validation-library && export JAVA_HOME=$(/usr/libexec/java_home -v 17) && ./mvnw test
```

Expect **220 passing, 7 skipped**.

Its own fixtures are the thing to read: `src/test/resources/instances/*.jsonld`
paired with `src/test/resources/templates/*.json`, and
`TemplateInstanceValidationTest`, which is nine `shouldFail` cases each deleting
one required key. That list is the definition of the instance envelope.

The `scripts/validate-*.sh` wrappers do not currently run — they call `python`
rather than `python3`, want a `jsonschema` module that is not installed, and
point at a `template-schema.json` that is generated rather than committed.

<a id="cee-running-the-gate-on-one-artifact"></a>

#### Running the Gate on One Artifact

**This is the gate production artifacts have to pass**, so being able to point it
at an arbitrary file matters more than the test suite passing. You do not need to
add a fixture to the Java suite to do that: the library already ships runnable
entry points under `org.metadatacenter.model.validation.exec`, and
`ops/cedar_validate.sh` wraps them.

```bash
ops/cedar_validate.sh instance path/to/template.json path/to/instance.jsonld
```

```bash
ops/cedar_validate.sh template path/to/template.json
```

`element` and `field` take one file the same way. The first run resolves and caches
the dependency classpath under `target/`; after that a check is about 0.3s, fast
enough to loop over a directory of artifacts.

**Exit status is the point:** `0` valid, `1` invalid, `2` could not run. The
library's own mains print `Instance is invalid` and still exit `0`, which is
useless in a pipeline, so the script re-derives the verdict from the output. Check
the status rather than grepping the text.

It locates `cedar-model-validation-library` via `$CEDAR_HOME`, then
`CEDAR_VALIDATION_LIB`, then the sibling checkout, and needs the same JDK 17 as
above — which it will find itself if `JAVA_HOME` is unset.

What a real rejection looks like. The location is a JSON pointer into the
instance, which is what makes it actionable:

```
Instance is invalid. Found 1 error(s)
[ERROR]: object has missing required properties (['@id']), location: /
```

<a id="cee-the-same-check-in-the-harness"></a>

#### The Same Check, in the Harness

Running Maven is not something to do per-edit, so the domain harness runs the
corresponding checks on every `npm run test:domain` and `npm run test:ci`.
`harness/src/instance-conformance.ts` keeps the two validators explicit and
independent:

- `validateWithModel` parses the template and instance through the TypeScript
  model library and runs `InstanceValidator` over the result.
- `validateWithRawSchema` runs the exact emitted JSON-LD against the untouched
  Draft-04 template with `ajv-draft-04`, before a model reader can normalize a
  legacy shape or repair a contradiction.

The two specs that exercise those adapters are:

```bash
npm --prefix harness run test -- \
  harness/test/instance-conformance.spec.ts \
  harness/test/instance-schema-population.spec.ts
```

`instance-conformance.spec.ts` builds fresh and populated instances across the
field/cardinality matrix and builds an empty instance for each of the **37 corpus
templates**. Every corpus template must report **zero model errors**. There is no
exception list and no partial-pass corpus contract; the populated matrix separately
pins the expected incomplete-state errors for part-filled choice fields.

`instance-schema-population.spec.ts` is the complementary saveability gate. It
populates every value-bearing field through the real CEE handler, crosses
single/multiple field cardinality with all seven root and one-/two-level element
placements, and requires **zero errors from both validators**. Both verdicts are
needed: in August 2026 the model-only path hid stored multi-select fields whose
widget semantics emitted arrays while their raw JSON Schema still required an
object; the resource server rejected those instances on save. The exact captured
nested template and all five placements from that incident are permanent
regressions in the same file. `template-consistency.spec.ts` separately scans
the independent, HuBMAP, and visual corpora for any checkbox, attribute-value,
or `multipleChoice: true` list field not declared as an array.

<a id="cee-where-the-java-tie-break-is-recorded"></a>

#### Where the Java Tie-Break Is Recorded

The harness does not mirror the Java library's fixtures or maintain an ajv/Java
agreement suite. When the two TypeScript-side checks leave a model question in
doubt, run the canonical library through `ops/cedar_validate.sh` and record the
measured verdict in the focused regression whose behavior depends on it. The
comments and paired cases in `harness/test/cardinality.spec.ts` are the current
examples: they name the artifact mutation, the Java command and the distinct
verdicts for an omitted element and an empty array.

That keeps the Java decision beside the CEE behavior it settles without vendoring
another repository's conformance fixtures into this one. `ajv-draft-04` remains
an independent server-facing check, not a substitute for the canonical validator.

<a id="cee-when-to-run-which"></a>

#### When to Run Which

Change the emitter, the envelope, or `data-object-builder.handler.ts` →
run both conformance specs above, which the domain and unified gates run anyway.

Upgrade the model library, take a new CEDAR release, or find yourself arguing
with the harness about what the model requires → run Maven. Use
`ops/cedar_validate.sh` for the disputed artifact and write the Java verdict into
the focused regression it settles.

About to put an artifact into production, or holding one artifact whose verdict you
actually need → `ops/cedar_validate.sh`. This is the gate itself rather than an
approximation of it, so when the question is "will this be accepted", it is the
only answer that counts. Reach for it in preference to reasoning from the schema:
a draft-04 validator agreeing with it is evidence, not proof, and the two have
diverged before.

<a id="cee-running-the-visual-baseline"></a>

### Running the Visual Baseline

Screenshot and browser-behaviour regression against the production bundle. The
focused root command builds a fresh `dist/`, prepares the visual fixtures and
runs Playwright:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:visual
```

For first-time installation, including the Chromium browser binary, use the
[complete gate setup](#cee-first-time-setup). If running from `visual/` directly,
the equivalent commands after a production build are:

```bash
cd visual
npm run prepare:all && npm test
```

Expect **over 770 passing** in about a minute and a half — 774 on 2 October 2026,
497 on 3 September. The count grows as tests are added; treat a *fall* as something to
explain. `prepare:all` re-concatenates the
bundle from `../dist` and regenerates the template fixtures; run it after any
rebuild.

The browser files are divided by contract. `render.spec.ts` owns the broad visual,
layout and remaining integration matrix; `temporal.spec.ts` owns the time-picker and
temporal-normalization behavior; `host-change.spec.ts` owns the public mutation event.
Shared host operations belong in the typed `tests/support/host.ts` driver. Keep new tests
with the contract they extend instead of growing `render.spec.ts` back into the only suite.

`npm test` refuses to run when `../dist` is newer than the prepared bundle in `public/`.
External-authority and BioPortal tests also check each widget's typing, blur and selection
behavior, which screenshots and the domain harness cannot establish.

To accept an intentional visual change:

```bash
npm run update:visual
```

That re-records inside the container, which is the only place a baseline means
anything. `npm --prefix visual run update` still exists and writes baselines for
whatever machine you are sitting at — on a laptop that is a `-darwin` file no CI
run will ever read.

Review every changed PNG before committing — a baseline update asserts the new
rendering is correct.

<a id="cee-when-a-baseline-passes-and-is-still-wrong"></a>

<a id="when-a-baseline-passes-and-is-still-wrong"></a>

#### Reviewing Visual Baselines

The containerized screenshot suite permits **zero differing pixels**. Do not restore a percentage
budget: on a 1280×4418 page, 1% permits about 56,000 changed pixels and can hide localized defects.
When the suite switched to an absolute budget, fourteen stale baselines differed by 557–8,837
pixels, including typography, occurrence-chip sizing and UTC-offset alignment.

A matching screenshot proves agreement with the baseline, not approval of the design. Review every
changed image against the requested behavior before accepting it. If a legacy tolerance lets an
old baseline pass, Playwright may leave it untouched during an update. Remove the specific baseline
and regenerate through the container command:

```bash
rm visual/tests/render.spec.ts-snapshots/07-timezone-*.png
npm run update:visual
npm run test:visual:prebuilt
```

A shared change, such as a token value, can re-record a hundred images at once, and a small
unrelated difference among them is easy to miss by eye. After re-recording, and before committing,
run the review tool from the repository root:

```bash
node $CEDAR_HOME/cedar-development/ops/review-visual-baselines.mjs --crops /tmp/baseline-crops .
```

It works the same way in CEE, CED, CETP and Workspace. The tool compares every changed PNG in the
working tree with the committed version, or with the revision that `--base` names, and sorts the
images into groups. A tone shift is a change in which neutral pixels are only drawn darker, or only
drawn lighter. Images with any other change come first, as mixed changes, each listed with the
region that holds most of its colour changes. Images whose only change is a tone shift follow. A
colour change found in more than one image is listed once at the top. A token change that darkens
an outline therefore appears as a few colour changes at the top and a long list of tone shifts
below, and an image it does not explain appears among the mixed changes.

With `--crops`, the tool writes an enlarged crop of the first three regions of each image. Each
crop shows the region three ways: as committed, as re-recorded, and faded with the changed pixels in
magenta. `--json` prints the
same findings for a script. The tool narrows the review without replacing it. Look at every mixed
change and at one image of each tone shift, and do not accept an unrelated difference merely
because regeneration produced a passing comparison.

A dependency patch can move baselines too. Angular Material 22.2.3 doubled the block margin of
every chip in a chip set and gave each chip a 48px touch target, which made each occurrence pager
8px taller and failed fourteen screenshots. CEE keeps its layout instead: `src/_cee-material-theme.scss`
switches the touch target off and `src/styles-own.scss` restores the 4px margin. Adopting
Material's spacing would be a design change, and it also breaks the narrow-header layout test, so
it needs a decision of its own. The same upgrade moved the select panel's right edge by one pixel.
Material 22.2.1 made the panel's opening animation fill `forwards`, which keeps the open panel on
its own compositing layer. That baseline was re-recorded, because only the rasterisation changed.

<a id="cee-running-the-angular-unit-tests"></a>

### Running the Angular Unit Tests

```bash
npm run test:unit:ci
```

This is the headless, single-run form included in `npm run test:ci`. The root
`npm test` runs the same specs through Vitest, and `test:watch` is the
interactive form. It enforces the focused artifact/config/wrapper thresholds named
under domain coverage above, plus the input-widget floors, per source file. A widget
with no covered code fails even when other widgets keep the pooled total high.
The coverage-policy tests exercise that refusal through the installed provider.
The unit layer is small; do not treat it as a substitute
for the domain and browser stages.

The coordination layer has a separate Angular-aware tier:

```bash
npm run test:coordinator
```

This is Angular's native Vitest builder, not the root hand-written Vitest config.
It initializes `TestBed`, compiles component templates and styles, and renders the
real wrapper → editor → renderer tree. It also tests scheduler supersession,
pending-work cancellation, and repeated wrapper teardown with an empty scoped
registry after every cycle. Coverage is deliberately limited to those coordinator
files and fails below 45% statements, 35% branches, 55% functions, or 45% lines. The
root runner excludes `*.coordinator.spec.ts`; adding a TestBed spec anywhere else is therefore
a configuration error rather than an accidentally half-working test.

<a id="cee-which-stage-sees-a-widget-defect"></a>

#### Which Stage Sees a Widget Defect

The stages divide by what they can observe, and a defect is only caught by a
stage that can see the layer it lives in. A read-write audit in September 2026
found thirteen defects in the widgets, every one of them in a layer no stage was
watching, so the division is worth stating.

The domain harness sees pure functions and model shapes, and sees them
thoroughly — `ClockTime`, `CedarTemporalValue`, `narrowByQuery`, what an
unanswered field records. What it cannot see is the widget that calls them.
`clock-time.spec.ts` proved the arithmetic of a 12-hour face while the picker
above it recorded midnight for a field nobody had entered a time into.

The root unit suite sees a widget's own decisions, constructing it directly with
stub collaborators. This is where a widget belongs, and where most of the
thirteen were caught once asked. It sees nothing of the template.

The coordinator tier sees rendered Angular markup and bindings. It can answer
whether a widget projects its feedback — a required checkbox group had a validator
deciding its fate and no `mat-error` to state the verdict, which every other
stage reports as working. A widget check that is genuinely about markup goes
here, as `checkbox-required-notice.coordinator.spec.ts` does.

The browser tier exercises the production bundle, including read-only specification
boxes, declared defaults versus supplied values, repeated-field paging, authority links,
accessible temporal names, read-only event suppression, and runtime configuration.
`harness/test/field-spec.spec.ts` and `harness/test/read-only.spec.ts` cover the pure
specification and read-only decisions; `component-render-decision.spec.ts` covers the
render choice. Use browser or coordinator checks for template behavior and the
harness for pure decisions.

The source panels have been replaced by downloads. `harness/test/download-content.spec.ts`
checks serialization; the browser suite checks menu contents, template-only read-only
exports, actual downloaded JSON/YAML bodies and filenames. Extend these contracts
when adding an export.

Three rules follow, each of them written after a defect that ignored it.

**Drive the widget the way the browser does.** Angular and Material semantics are
where these hid: `FormGroup.get` splits a name on `.`, so a `Dr.` option
registered a control that could never be looked up again; `addControl` keeps the
control already registered rather than replacing it; a form control bound to a
text input coerces an array through `String`; Material's checkbox writes its own
value during `click`, before the `input` handler overwrites it. None of that is
reachable by calling a method and asserting on a field. Send the event.

**A stub has to be a stub of what production builds.** The clearest failure in
the set was a green test: `widget-validators.spec.ts` handed `atLeastOneChecked`
a `{ Alpha: false, Beta: true }` that no widget produces, and passed for years
over a required field that could never be satisfied. Coverage does not help
here — the validator was covered.

**State an invariant once, across the family.** The widgets are copies of each
other, and a fix reaching one of them is the recurring shape: `performItemAdd`
was hardened and its two siblings kept the assertion it was hardened against;
`narrowByQuery` was written for seven authority fields and the eighth kept the
rule it replaced; seven widgets built a form group around a control they then
replaced. Five specs under `input-types/components/` are table-driven for that
reason, one invariant each: the group a widget binds holds the control it
validates (`input-control-binding.spec.ts`); emptying a field records nothing,
never an empty string (`emptying-a-field.spec.ts`); a required field emptied by
the user reports the requirement (`required-field-emptied.spec.ts`); an event a
read-only widget can still receive writes nothing (`read-only-events.spec.ts`);
and a widget shown two occurrences in turn shows only the second
(`paging-between-occurrences.spec.ts`). A new widget joins each table rather
than copying a spec. A second audit the next day found seven more defects in the
same layer. The three newer tables pin three of them — the authority clear
action wiping the requirement it had just raised, the attribute-value field
writing on a read-only blur, and the text field carrying one occurrence's ORCID
link onto the next — and the specs of the widgets they sat in pin the rest, with
two coordinator specs for the two that were claims about markup: the numeric
field's verdict reaching a `mat-error`, and the text field's link giving way to
an input.

A value that breaks a constraint shows its error as soon as the widget holds it,
whether the user typed it or a stored instance supplied it. `holdsConstraintError`,
in `edited-field-error-state-matcher.ts`, is the rule every widget's error-state
matcher shares. An empty required field waits until the user edits it or a host
reveals it, and a reveal marks the controls a widget names in `revealedControls()` as
touched. The problems no control can find are stated under the field by
`app-cedar-field-problems`, from the report: a stored choice outside the options, a
term missing its label or IRI, an authority identifier that is not an IRI, a list
longer than its maximum, and, once the user has been taken to it, a list shorter than
its minimum. A new problem code needs a widget's `mat-error` or an entry among that
component's notices; with neither, the report lists the problem and the field says
nothing. `visual/tests/stored-problems.spec.ts` loads a fixture holding a bad value of
every kind, and a new code belongs in it.

---

<a id="cee-troubleshooting"></a>

### Troubleshooting

**`ng` refuses to run, or `npm install` fails with engine errors**
Check your Node version first — CEE is on 24.22.1 throughout, and a version
outside Angular 22's range fails in ways that look like something else.

**Harness: `SyntaxError: Invalid or unexpected token` pointing at line 1 of a
CEE source file**
The transform left `@Injectable()` in place, or the file was externalized and
never transformed at all. Both are handled in `harness/vitest.config.ts` — the
`oxc` block and the `TRANSFORM` patterns respectively. CEE sets
`experimentalDecorators` in `tsconfig.base.json`, but the transform reads the
nearest `tsconfig.json`, where it is absent.

Since Vitest 4 the settings live under `oxc`, not `esbuild`: Vite 8 transforms
with oxc and ignores an `esbuild` block, announcing that it has done so and then
failing every spec that imports a decorated class. `decorator.legacy` is
`experimentalDecorators`; `useDefineForClassFields: false` needs both
`assumptions.setPublicClassFields` and
`typescript.removeClassFieldsWithoutInitializer`.

**Harness: `No handler function exported from …/vitest/dist/worker.js`**
The root and the harness are on different Vitest versions. `harness/vitest.config.ts`
sets `root` to the repository, so the harness resolves the root's worker. Upgrade
both together.

The root `vitest.config.mts` intentionally has no `server.deps.inline` compatibility
list. That block existed for RxJS 6's package shape and named dependencies removed from
CEE years ago; RxJS 7 and the current Angular packages resolve without it. Do not restore
the block unless a current package demonstrates a concrete resolver failure.

**Harness: a suite reports "no tests" but exits green**
`deps.inline` is matching too broadly and has inlined `vitest` itself, giving
the spec files a second copy of `describe`/`it` that the runner never sees. Keep
the `TRANSFORM` patterns narrow. This failure mode looks exactly like success —
check the test count, not the exit code.

**Harness: `Failed to load url lodash-es`**
Resolution from `../src` walks up to a repo root with no `node_modules`. The
`ceeStubs` plugin in `vitest.config.ts` maps bare deps to the harness's copy;
add any new one there.

**A model library change reaches the harness but not the built app**
The harness consumes `dist/` through Node's CommonJS entry; the Angular build takes
the modular `esm/index-namespace.js` entry. Both come out of `npm run build` in the library.
The separate copyable `index.esm.js` still needs webpack's named library exports.
The packed-consumer gate checks each format, browser mappings and shared policy identities;
the browser and visual gates prove the application using the modular output runs correctly.

**Model library changes aren't visible to the harness**
Running a harness directly from an existing checkout uses that checkout's installed package.
For development against current model sources, use the reactor:

```bash
cedarcli test frontends
```

It builds the model and supplies the exact package to CEE's root, harness and visual checks in
isolated copies. Use `cedarcli build frontends` to deploy and smoke the same source composition.
No publication, version bump, pin update or symlink is required. Registry publication belongs to
the [package release procedure](NPMJS-RELEASE-RUNBOOK.md).

**A test asserts something that looks wrong**
Check whether it sits in a "known defects (characterized, not endorsed)" block.
Those assert what CEE *does*, deliberately. [FRONTEND-ROADMAP.md](./FRONTEND-ROADMAP.md#cee) carries what is open.

---

<a id="cee-building-the-model-library"></a>

### Building the Model Library

CEE consumes `@org.metadatacenter/cedar-model-typescript-library` as a published
package, so this is only needed when working on the library itself.

The library builds on **Node 24.22.1**, the same version CEE uses: `.nvmrc` names
it, `engines` declares `^24.15.0`, and CI pins it. It sat on Node 20 until
2026-08-16 — declared `>=20.19.0`, CI pinned 20.20.2, and the runbook called the
split deliberate on the grounds that the library is a separate build with its own
toolchain. That reasoning outlived its subject: Node 20 left maintenance in April
2026, so snapshots were being published from a runtime no longer receiving
security patches, and the whole gate turned out to pass on 24 unchanged — 86
suites, 932 tests, and the packed-consumer smoke test that imports the real
tarball. Nothing needs a sibling checkout: the test corpus is vendored under
`cedar-test-artifacts/`, along with the reference templates it compares against.

```bash
npm ci
npm run lint          # eslint over src, the eslint config and the smoke test
npm run typecheck     # tsc --noEmit
npm run test:coverage # jest with coverage thresholds enforced
npm run test:package  # build the tarball and install it as a consumer would
```

`test:package` is the one worth knowing about. It builds the real tarball,
installs it into a throwaway project outside the repository, and imports it
through CommonJS, through ESM, and against the shipped declarations. Unit tests
import from `src/` and so cannot catch a broken `dist/` — a missing export map
entry, a declaration that does not resolve, a dependency that was only ever a
devDependency.

`npm run build` synchronizes the version into `package-dist.json` before webpack
runs. That file is also where the published *name* comes from, and the name
selects the channel — scoped for a dev snapshot on Nexus, unscoped for a release
on npmjs. The repository itself is always `cedar-model-typescript-library`; see
the channel table below.

`.github/workflows/test.yml` runs exactly that sequence on `ubuntu-latest` with
a fifteen-minute ceiling, on every push and pull request to `develop`. Nothing
renders or screenshots, so it needs no macOS runner and no browser install,
unlike the CEE gate.

The model repository's ordinary test workflow publishes nothing. An immutable CEDAR build train is
the deliberate exception: it reruns this complete gate against the captured commit, stamps a
train-owned version and publishes the scoped package before building CEE. CEE resolves that exact
artifact from the BMIR Nexus npm registry
(`https://nexus.bmir.stanford.edu/repository/npm-cedar/`) through its own `.npmrc`.

<a id="cee-the-two-channels-and-the-name-that-selects-them"></a>

#### The Two Channels, and the Name That Selects Them

The library publishes to two places, and **the package name is what decides
which**. npm routes by scope, so this is not a flag or a registry setting on the
command line:

| Channel | Name in `package-dist.json` | Goes to |
|---|---|---|
| Release | `cedar-model-typescript-library` | public npmjs, where `latest` is currently 0.8.0 |
| Dev snapshot | `@org.metadatacenter/cedar-model-typescript-library` | Stanford Nexus, `@org.metadatacenter:registry` in `~/.npmrc` |

**A dev release to Nexus is scoped; a release to npmjs is not.** The name is held
by hand in `package-dist.json`, which `npm run build` copies to
`dist/package.json` — the manifest that publishes. Nothing derives the channel
from the version, so cutting a release leaves the manifest unscoped and the next
dev publish will aim at npmjs unless the name is put back. That has happened:
"Prepare release 1.0.0" dropped the scope, and the dev publish after it was
caught only by reading the dry run.

So read the **last line** of `npm publish --dry-run --tag dev` every time. It
names the registry, and it is the only check between a snapshot and public npmjs:

```
npm notice Publishing to https://nexus.bmir.stanford.edu/repository/npm-cedar/ with tag dev
```

`npm run test:package` takes the expected name from `package-dist.json` for the
same reason, so it exercises whichever tarball the build is set to ship.

<a id="cee-publishing-a-model-library-dev-build"></a>

#### Publishing a Model Library Dev Build

For local development, run `cedarcli build frontends` or `cedarcli test frontends`: the model's
current source, including uncommitted edits, automatically flows into CEE and every other
consumer. No publication or pin update is required. A narrow `cedarcli build this` also brings
in its local component producers. The procedure below is only for explicitly publishing a
registry package. For an immutable cross-machine build train, `cedarcli publish train` publishes
and records the captured model source and wires that exact artifact into CEE.

Version is `<next>-dev.<YYYYMMDD>.<sha>`, naming the commit whose content is
published and *that commit's* date — so the bump commit carries a version naming
its parent, as CEE's own dev versions do. Three files hold it by hand:
`package.json`, `package-lock.json` (two spots) and `package-dist.json`.
`package-dist.json` is also synchronised from `package.json` by
`scripts/sync-package-version.js`, which `npm run build` runs first, so editing it is
belt and braces rather than required.

From the library repository, on the Node its `.nvmrc` names:

```bash
npm run lint && npm run typecheck && npm run test:coverage
npm run test:package   # builds dist/ and installs the real tarball as a consumer
cd dist && npm publish --tag dev
```

Check the name before the version: a dev publish needs the scoped one, per the
channel table above.

`npm publish` is run **from `dist/`**, not the repository root: `npm run build`
writes `package-dist.json` to `dist/package.json`, and that is the manifest
carrying the published name — the scoped one for a dev snapshot. The root
manifest is always named `cedar-model-typescript-library` and is not what
publishes, so its name says nothing about where a build is going.

Neither manifest declares a registry. The target comes from the **scope**:
`@org.metadatacenter:registry` in `~/.npmrc` points at Nexus, so npm routes the
scoped name there. Confirm it before publishing, and check the dry run names the
registry you expect:

```bash
npm config get @org.metadatacenter:registry
cd dist && npm publish --dry-run --tag dev
```

`--tag dev` matters. Without it npm would move `latest`, and the dev tag is what
identifies the current dev build; consumers pin exact versions regardless, so a
tag move reaches nobody by itself. What is on Nexus can be read without
authentication, which is the quickest way to confirm a publish landed —
`npm view` against this registry returns nothing useful, so query it directly:

```bash
curl -s "https://nexus.bmir.stanford.edu/repository/npm-cedar/@org.metadatacenter%2Fcedar-model-typescript-library" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d['versions'])); print(d['dist-tags'])"
```

A published version cannot be replaced, so the dry run is the check that matters.
Then bump the dependency in **both** CEE manifests that declare it — `package.json`
and `visual/package.json` — and run the full gate. A skew between them means the
domain tests and the bundle disagree about what the model is. The harness declares
none of its own: it imports `cedar-model-typescript-library` and resolves it from
the root install, so the root manifest is what it reads.

Both spell the dependency as an alias, `cedar-model-typescript-library:
npm:@org.metadatacenter/cedar-model-typescript-library@<version>`, which is how the
imports keep the unscoped name while the install comes from Nexus. A bare
`"cedar-model-typescript-library": "<version>"` resolves against public npmjs
instead, where the dev versions do not exist.

<a id="cee-release"></a>

<a id="cee-prerequisites--registry-auth"></a>
<a id="cee-1--bump-the-version"></a>
<a id="cee-2--test-and-stage-the-package"></a>
<a id="cee-3--publish"></a>
<a id="cee-4--commit-tag-the-release-and-draft-its-notes"></a>
<a id="cee-5--advance-development"></a>
<a id="cee-6--propagate"></a>
<a id="cee-gotchas"></a>

### Release

The [npmjs release runbook](NPMJS-RELEASE-RUNBOOK.md) owns stable model-library, CEE, CED and CETP
releases, which `cedarcli release npm` carries out. It prepares and gates each package on `develop`,
merges it through green CI, publishes the gated tarball from `main`, tags the merge commit, and
returns `develop` to development. Never publish by hand.

| Task | Authoritative procedure |
| --- | --- |
| Credentials and toolchain | [Prerequisites](NPMJS-RELEASE-RUNBOOK.md#prerequisites) |
| Versions, model pin and release notes | [Choosing the inputs](NPMJS-RELEASE-RUNBOOK.md#choosing-the-inputs) |
| What a release does, stage by stage | [The route](NPMJS-RELEASE-RUNBOOK.md#the-route) |
| A release that waits or fails | [Where the route stops](NPMJS-RELEASE-RUNBOOK.md#where-the-route-stops) |
| Update consumer pins and train baselines | [Propagate CEE](NPMJS-RELEASE-RUNBOOK.md#propagate-a-stable-cee-release) |
| Adopt public CEE, CED and CETP in a CEDAR release | [Train-backed release](NPMJS-RELEASE-RUNBOOK.md#use-the-public-packages-in-a-train-backed-cedar-release) |
| Write the announcement | [Release notes](NPMJS-RELEASE-RUNBOOK.md#release-notes) |
| Publish a registry development package | [Registry dev packages](#cee-releasing-a-dev-snapshot-locally) |



Publishing alone changes no running frontend. Rebuild each served host, verify bundle hashes,
and invalidate its caches using [production deployment](PROD-DEPLOY-RUNBOOK.md#6--verify-and-rebuild-every-cee-host-to-the-intended-version).
For local bundle staging, see [Getting a Local Build into the Frontends](#cee-getting-a-local-build-into-the-frontends).

<a id="ced"></a>

## Embeddable Designer (CED)

CED is a UI component. The embedding host owns artifact persistence, authentication,
permissions, server validation requests, publishing, version allocation and provenance.
CED edits supplied documents, reports changes and local validation, and renders the
editing state supplied by its host. Reusable-field and preference storage also belongs
to the host. Keep future integrations within that boundary.

Running, building, testing and packaging `cedar-embeddable-designer` (CED), the
Web Component for authoring CEDAR templates and elements.

CED is the authoring half of a pair. The [CEDAR Embeddable Editor](FRONTEND-RUNBOOK.md#cee)
renders a template as a form and produces instances; CED produces the templates
CEE renders. It is a different component from the AngularJS Template Designer
that serves `/templates/edit/...` in production, which it is meant to replace.
What CED still needs before it can stand in for that designer is in
[FRONTEND-ROADMAP.md](FRONTEND-ROADMAP.md#ced).

<a id="ced-where-the-design-values-come-from"></a>

### Where the Design Values Come From

The designer imports `@org.metadatacenter/cedar-design-tokens/custom-properties.css` in
`src/styles.css`. Tailwind's `@theme` reads those custom properties, so this consumer uses the
compiled stylesheet rather than the Sass partial. Keep shared scales and colors in the token
package; its [README](../../cedar-design-tokens/README.md) defines the vocabulary.

<a id="ced-requirements"></a>

### Requirements

Node 24.22.1, which `.nvmrc` pins and CI runs — the same version CEE and
`cedar-embeddable-term-picker` use. Nothing here needs Java or a running CEDAR stack, except
controlled-term search, which needs a terminology server.

```shell
nvm use
npm install
```

`npm install` reaches the CEDAR Nexus for one dependency,
`@org.metadatacenter/cedar-model-typescript-library`. Nexus being down is
therefore a broken install and a red CI run, with everything after the install
step unaffected.

<a id="ced-running"></a>

### Running

```shell
npm start
```

For the full debugging fixture, open `http://localhost:4200/?example=all-fields`
(or the port selected with `npm start -- --port <port>`). The development host
loads `public/examples/all-fields-nested.json`, a snapshot of the local template
`https://repo.metadatacenter.orgx/templates/5e68d921-fd5d-4d05-9a6d-a81714cbd2c5`.
It includes every palette type, numeric and temporal variants, and NIH Grant ID
and DOI in the single and repeated nested collections. The host does not save
edits back to that server template. Its status bar links to the fixture.

Serves a development host on port 4200. That page is a host page: it embeds
`<cedar-embeddable-designer>` and configures it, rather than rendering the editor
directly, so `ng serve` exercises the same contract an embedder uses. A
regression in the element shows up during development rather than in someone
else's page.

For the standalone bundle demo, run `npm run demo:prepare`, then serve
`dist-bundle/` with a static HTTP server. This stages the versioned
`demo/index.html` and the current CETP and CEE bundles together; rerun it after
rebuilding either sibling.

<a id="ced-building"></a>

### Building

There are two builds, because there are two things to produce.

| Command | What it produces |
|---|---|
| `npm run build` | the element: `main.js` and `polyfills.js`, no `index.html`, no global stylesheet |
| `npm run build:app` | the standalone host page `npm start` serves |
| `npm run dist` | the distribution: one script, its declaration, and a staged npm package |

`npm run build` compiles `src/main.ts`, which registers the custom element and
bootstraps nothing. The element carries its own styles into its shadow root,
which is why they are listed on the element component rather than in
`angular.json` — a stylesheet in the document head does not cross into a shadow
root.

`npm run dist` flattens Angular's module output into one classic script with
esbuild, holds it to a size ceiling, and stages the package from those exact
bytes. Concatenating the module output instead would produce a file that loads
and then fails inside Angular, because two modules that never shared a scope
would suddenly be sharing one.

<a id="ced-internal-boundaries"></a>

### Internal Boundaries

`EditorSession` owns the authoring document, active container and `EditorAccess`
policy. Access distinguishes definition edits from parent-owned placement edits;
host read-only and root publication block both. Commands and controls share that
policy. Tabs, expansion, outline selection and read-only preview remain available.
Permission changes close editing dialogs and cancel outstanding edits without
reviving them when access returns; existing unsaved input is retained. The host
reserves `inert` for loading, failed loads and saving. See the designer README's
read-only access table and its access, command and browser matrices.

Every document
update passes synchronously through `ValidationCoordinator`, which owns pending
settings edits, syntax errors, asynchronous checks, error visibility and the public
validation report. It validates edits against their own node, retries related drafts
together, and drops drafts whose node or setting no longer exists. Controls retain
input buffers and read shared verdicts instead of caching model errors. Rejected
default buffers and malformed settings groups survive control recreation in the
coordinator. Native number controls hide malformed text from JavaScript, so the
coordinator retains the invalid control's identity and the rest of its settings group;
an unrelated edit or remount cannot silently accept the resulting empty value.
Asynchronous checks and recovery actions belong to the current node, editing intent
and editability revision. A newer rejected edit also invalidates an old recovery.
Cancellation aborts the lookup, and terminology requests have a 30-second deadline.
Pending-only edits count as dirty; read-only sessions cannot save.
Saveable documents must also pass structural validation of the actual JSON emitted by the adapter,
including standalone field roots. The shared TypeScript library compiles those rules from the six
canonical Java meta-schemas; its vendored schema hashes identify the rules in use. Occurrence limits
must fit Java's nonnegative 32-bit integer range. The settings probes retain their existing precise
feedback, and structural findings use the same summary and nested setting paths.

`npm run test:conformance`, included in CED's mandatory gate and CI, drives real coordinator edits,
all field types, standalone roots, nested and repeated elements, and deterministic edit histories.
Every saveable output must pass the real Java validator, Java artifact reader and TypeScript strict
reader/value checks. Negative controls prove invalid inputs are refused. Java 17 and Maven are
required, and the gate fails if Java's loaded schema hashes differ from the browser library's.
CED and the host declare `cedarJavaConformance` in their manifests. Their reactor result keys include
the Java runtime and every resolved oracle JAR, so a Java-only or transitive dependency change reruns
their checks even if no frontend source or meta-schema changed. Missing dependency evidence permits
no cached success.

`TemplateService` coordinates commands and UI navigation;
`core/model/document-validation.ts` validates a document snapshot and pending
settings drafts without Angular state. Reconciliation compares structured validation
rules, independent of translated wording. `TerminologyEditCommands` owns membership,
recovery and atomic default/constraint changes; views display their outcomes.
Field settings are probed independently so
one imported defect cannot hide another; container annotations use the same rules
as field annotations. The JSON authoring reader retains numeric and temporal
defaults that the model's strict reader would otherwise reject before editing.
The default/constraint matrices cover template and element roots, single and
repeated children, depths 0/1/3/6, relocation, repair order and serialization.
Ownership/lifecycle matrices cover host mutation, editability changes, late success,
denial and failure after cancellation or replacement, and control recreation.
Public artifact snapshots are isolated from the live document and other event channels.
Cards, the outline, the library sidebar and
the save gate use the same report. An unserializable document clears the preview
until repaired.
`core/model/cedar-template.ts` is the public facade of the model adapter. Its
implementation under `core/model/cedar-model/` separates capabilities, metadata,
terminology, reading and field/container writing. Import checks enforce the boundary
and reject cycles, including cycles through local dependencies. Presentation
colors come from CSS tokens, never from the document service.

The shared package README describes design ownership and host styling. CED's
native compact controls retain the API in CEE's `STYLING.md`.

### Reused Artifact Versions

CED's Version tab reports each field or element as local, linked to a published
artifact, copied from an origin, or contained in a linked element. Publication status,
version, derivation and previous-version metadata are on that tab; the template and
element headers display versions read-only. Importing a draft creates an editable copy
with a new identity. Upgrades and replacements select published releases only; a newer
draft is never a replacement target. Parent placement survives replacement.

The host supplies optional `childSource.versions`, `compatibility`, `save` and `open`
methods; their contract and example are in the designer's README, **Versions of Reused
Children**. Each compatibility assessment belongs to the complete document snapshot.
Editing a child, sibling or placement retires it, and an active Version tab checks again.
A refresh reloads the candidate, and replacement uses the exact assessed content. A
breaking assessment needs an explicit nonnegative integer instance count; missing,
malformed or contradictory answers cannot authorize replacement. An explicit zero
permits a breaking replacement; a positive count requires a new template version.
Hosts without a compatibility method can offer manual replacements without a verdict,
but those replacements never enter Upgrade all compatible. Server writes must enforce
the instance policy independently of these component checks.

`browser/tests/version-upgrade-journeys.spec.ts` crosses field/element and linked/copy
states with assessment outcomes, verifies parent and sibling preservation through
replacement and reopen, and exercises draft exclusion, edited copies and late replies.
The split Designer host supplies authenticated history, compatibility, reusable saves and
opening originals. Compatibility receives the complete before/after parent and applies the
same preservation rules as Save. Identical validation shapes prove compatibility conservatively;
otherwise the result is unknown, and only an explicit zero stored-instance count permits manual
replacement. Unknown changes with existing records are withheld, never labelled compatible or
reported as an invented invalidated count. Unknown replacements never enter Upgrade all compatible.

Reusable saves journal a stable identity before creation and track publication separately in
the tab's account/deployment-scoped session storage. Retry reads that identity and resumes the
same operation. A confirmed child survives a discarded parent edit; the parent still needs its
own Save. Draft results are editable derived copies, and published results are links. No recovery
control is added to ordinary screens. A failed operation uses the Version tab's existing error
and action. Original versions open in another Designer tab.

`npm run smoke:journey -- pull-versions reusable-publication` in `ops/e2e` exercises published
selection, copied/linked fields and elements, nested/repeated placement, creation/publication,
lost creation/publication replies and parent save/reopen against real REST.
`npm run smoke:journey -- version-source-access version-source-deletion reusable-changed-draft`
adds sources the author cannot read, sources deleted during assessment and parents changed while
a reusable save is uncertain. Each journey first opens an untouched fixture of its own, which must
show no failure and no exceptional control and write nothing. `npm run smoke:rest -- pull-versions`
directly exercises the final write guard, skipped assessments, records arriving after assessment,
unchanged revisions on refusal and published immutability. The artifact server's embedded race
tests also pause actual instance creation across a replacement. Broader compatibility proofs,
legacy provenance and remaining lifecycle work are in the
[pull version-management work](FRONTEND-ROADMAP.md#pull-version-management).

<a id="ced-testing"></a>

### Testing

| Command | What it covers |
|---|---|
| `npm test` | unit tests, through the Angular CLI's Vitest builder |
| `npm run test:boundaries` | properties of the source no type can express: its import rules, and `autocomplete="off"` on every text box |
| `npm run test:packaging` | the publish-channel rule, under `node --test` |
| `npm run test:browser` | builds the distribution, then drives it in a real browser |
| `npm run test:browser:prebuilt` | the browser suite, refusing a bundle that is not the code |
| `npm run test:browser:flake-hunt` | that suite twenty times over, or `RUNS=n` |
| `npm run test:visual` | the screenshot baselines, in the container they are taken in |
| `npm run check:readme` | the README's examples, against the package that ships |
| `npm run test:ci` | the gate, cheapest check first |
| `npm run audit:prod` | advisories against what an embedder downloads |

The browser suite is the one that matters most, and it is the only one that can
see the failures this component has actually had: an element that never
registered on a page without `<app-root>`, a lookup that searched the document
instead of the shadow tree, menus that closed on their own opening click, a view
that silently stopped updating under OnPush, an image the package does not carry.

It drives the built single-file bundle in a host page whose own CSS is chosen to
be as intrusive as possible, and it is hermetic: no test reaches a terminology
server, and the one covering `<cedar-embeddable-term-picker>` registers a stub element in
the page.

`accessibility.spec.ts` runs axe-core over each state the suite can reach: fresh,
nested, published, read-only, narrow, showing host findings, both settings dialogs,
and every field type's settings tabs. Any violation of axe's rules for WCAG 2.2
levels A and AA fails it, and the same rules gate Workspace, the term picker and CEE.
axe-core's rule for WCAG 2.1's Label in Name is experimental, and a tag selection leaves it
out, so each of the four gates runs it by name. CED and CEE enable it beside the tags in a
single scan and assert that it ran. Workspace and the term picker run it in a second scan. CEE
checks every rule at desktop width and, at 480 px, only contrast, target size and scrollable
regions, the rules that read the layout. Audited at both widths on 2026-10-20, 239 states
agreed on every other rule.
Axe cannot judge focus order, focus return or announcements, so three specs cover
them:

- `keyboard-order.spec.ts` pins the Tab order of each surface, naming every stop by
  role and accessible name.
- `focus-return.spec.ts` checks where focus lands after each action. A deleted
  card gives focus to its next sibling, else its previous one, else its container's
  Add field. A closed dialog or menu returns focus to the control that opened it.
- `announcements.spec.ts` reads the designer's one polite live region after each
  announced event: an applied constraint set, a cleared default, a chosen default
  term, a new or cleared set of host findings, and a move in the Overview. The
  validation summary speaks through the same region, but only for an issue that no
  visible alert or host announcement has already said, and
  `error-announcements.spec.ts` asserts that each error is said once.

None of the three can say what a screen reader actually speaks, so a release that
changes these surfaces also gets the [screen-reader protocol](#ced-screen-reader-protocol).
`semantics.spec.ts` asserts the roles, names and states axe accepts without
checking, such as the Preferences radio group and its pressed presets, and
`layout-resilience.spec.ts` runs the layout check every component shares.

Axe leaves some contrast and target-size checks undecided. The spec's `SETTLED`
list names each one, with the value measured, and measures it again on every scan,
so an undecided result the list does not name fails the gate. The native dropdowns
draw their chevron as a background gradient, which hides their text's contrast from
axe. The text is 87% black on white, about 16:1. The template and element settings
toggles are 36 by 14px, under WCAG 2.2's 24px minimum, but the header beside each
opens the same settings and is the larger equivalent target criterion 2.5.8 allows.
A field card's toggle has no such equivalent. The field header is 23px tall, and the
settings panel's last control sits within 12px of the toggle's centre. The spec
records it under `EXCEPTIONS` as a failure that waits on a visible change.

`test:browser:prebuilt` serves `dist-bundle/`, so a source change that has not
been through `npm run dist` is not the thing under test. That used to be a
sentence here and nothing more; `check:fresh` now refuses the run, comparing the
bundle against the build beside it by timestamp, by the files it was made from,
and by hash. A checkout that never built is not what it refuses — testing a
distribution someone handed you is legitimate — only a bundle a build contradicts.

The two source properties are the ones a compiler cannot state: `ced-public-api.ts`
must stay import-free, or the declaration the package ships names paths that are
not in it, and the CEDAR model library must be reached through
the `core/model/cedar-model/` adapter module, exposed through
`core/model/cedar-template.ts`, which keeps its vocabulary out of the components.
The adapter's local dependency graph must also remain acyclic.

`check:readme` compiles the README's TypeScript examples against the staged
declaration, and checks that every `npm run` a reader is told to type is a script
this project has. The second half exists because documentation here has named a
command that did not exist.

<a id="ced-what-the-machine-decides"></a>

#### What the Machine Decides

Two kinds of check measure the rendered page rather than the model, and both
depend on the machine that rendered it. `browser/run-in-container.sh` runs them
inside the Playwright image matching the version this repository resolves —
`visual` for the baselines, `behaviour` for everything else — and CI runs the same
image on an arm64 Linux runner so that neither side emulates the other.

The screenshot baselines are the obvious case: a baseline records a machine's
glyph rasterisation as much as the application's rendering, and CEE measured 7 of
its 106 differing by antialiasing alone across the laptop-to-CI boundary. Because
the container removes that boundary, the budget for a difference here is zero
pixels rather than a tolerance wide enough to hide a real change.

The layout invariants are the case that is easy to miss. They measure real boxes,
and a box's width depends on the fonts available — so a row with no slack fits on
a developer's Mac and overflows on the runner. An option row's delete button sat
31 pixels outside its card on CI and nowhere else, and the suite was red for three
commits before anyone ran it where CI runs it.

<a id="ced-screen-reader-protocol"></a>

#### Screen-Reader Protocol

The browser suite shows that focus lands where it should and that the live region
holds the right text. It cannot show that a screen reader speaks either, or in what
order. This protocol checks that by hand, with VoiceOver and Safari on macOS and with
NVDA and Firefox on Windows.

Build the distribution and serve the fixture pages:

```sh
cd "$CEDAR_HOME/cedar-embeddable-designer"
npm run dist
node browser/serve.mjs
```

Open `http://localhost:4598/host.html?picker=stub`. The stub term picker applies a
fixed term, so the constraint steps need no terminology server. Start the screen
reader (Command-F5 for VoiceOver, Control-Alt-N for NVDA) and work through each
step from the keyboard alone. Each step says what should be heard.

1. Tab into the designer. The toolbar, the Overview, the template header and each
   field card follow in that order, and each card is read as a group named after
   its field.
2. On a card, press the down arrow. Focus moves to the next card, which is read by
   name.
3. Open a field's settings, move between its tabs with the arrow keys, and Tab
   through a panel. Each control is read with its label.
4. Delete a field with its Delete button. The next card is read, or the previous
   one when the field was last.
5. Press Add field, Tab into the palette and press Escape. The palette closes and
   Add field is read again. Open it again and choose Text. The new field's name box
   is read.
6. Press Import fields and elements. The picker's search box is read. Press Escape,
   and Import is read again.
7. Add a Controlled Terms field, open its constraint dialog with Edit and pick the
   term. After the Edit button, "Disease now has 1 constraint." is heard, with the
   field's own name in place of Disease.
8. Open the constraint dialog again and press Escape. It closes and Edit is read.
9. Open Edit default term and pick the term. After the Edit default term button,
   "Default set to cancer." is heard, then "Validation issues (1)", because the
   stub picker's term cannot be verified.
10. In the browser console, set
    `document.querySelector('cedar-embeddable-designer').validationFindings` to
    `[{ location: '/schema:description', message: 'Explain this study', severity: 'error' }]`.
    "The host reported 1 error." is heard and focus does not move. Set it to `[]`,
    and "The host's reported issues are cleared." is heard.
11. In the Overview, focus a Reorder button and press the down arrow. "Title moved
    to position 2 of 3." is heard.
12. Open Preferences from the user menu. The dialog is read by its title, Tab stays
    inside it, and Escape returns focus to User Menu, which is read.
13. Open the user menu and press Escape. The menu closes and User Menu is read.
14. Set `document.querySelector('cedar-embeddable-designer').language = 'hu'` and
    repeat step 11. The message is read in Hungarian.

Record the screen reader's and the browser's versions, the date and every step that
fails. A failure becomes an item on the [frontend roadmap](FRONTEND-ROADMAP.md).

<a id="ced-packaging-and-release"></a>

### Packaging and Release

Which registry a package belongs to is derived from its version rather than
passed at publish time. A version carrying `-dev.` is a snapshot and names the
CEDAR Nexus under `@org.metadatacenter`; anything else is a release for public
npmjs, unscoped. A snapshot therefore cannot reach npmjs by forgetting a flag,
and the rule has tests of its own because publishing to npmjs is not an action
anyone can take back.

The first Nexus snapshot was
`@org.metadatacenter/cedar-embeddable-designer@0.1.0-dev.20260916.2593d382`. CED's
CI publishes nothing. `cedarcli publish components --apply` builds and publishes a
development package from each pushed `develop` head, and each build train publishes
the one it tests. A release reaches npmjs through `cedarcli release npm`, which
gates the package, publishes it from `main` and tags it, as the
[npmjs release runbook](NPMJS-RELEASE-RUNBOOK.md) describes. CETP is published the
same way. Publish neither channel by hand.

The published declaration is emitted from `src/app/ced-public-api.ts` alone,
which is written without imports so its declarations stand alone. Adding an
import to that file breaks the declaration build rather than shipping a `.d.ts`
that names paths only the repository has.

<a id="ced-embedding-it"></a>

### Embedding It

A host loads one script and then has the element. Two properties and one event
are the whole contract today.

```html
<cedar-embeddable-designer id="designer"></cedar-embeddable-designer>
<script src="cedar-embeddable-designer.js"></script>
<script>
  const designer = document.getElementById('designer');
  designer.config = { terminologyBaseUrl: 'http://localhost:9004/' };
  designer.addEventListener('templateChange', (event) => console.log(event.detail));
</script>
```

`templateChange` carries the template as CEDAR JSON-LD — the same document the
artifact server accepts, written by the CEDAR model library rather than by CED.
`currentTemplate` offers the same value as a property, for a host that would
rather read than listen. Assigning `template` opens one, as JSON or YAML.

There is no default terminology endpoint. Unset, controlled-term search is off
and the panel says which key is missing, because an embedder should reach a CEDAR
service because it asked to rather than because a component it loaded had an
address compiled into it.

`language` selects the interface language, `en` (the default) or `hu`, as a property
or an attribute, and can change at any time; any other value falls back to `en`.
Each designer element keeps its own language, and both translation maps are compiled
into the bundle. CED passes the language on to the term picker and to the CEE and CEF
elements it embeds. The Template Designer host sets it from the browser's preferred
language. `npm test` runs a guard that fails on a user-visible string written outside
the maps; deliberate exceptions go in `src/app/i18n/i18n-allowlist.json` with a reason.

### CED in the Split Designer Host

Workspace's template and element links open `cedar-template-designer` on the
Designer hostname. That repository is a thin authenticated CED host; the combined
`cedar-template-editor` retains its separate authoring implementation.

For development and E2E, run `cedarcli build frontends` to build and activate the latest
development pins of CED, CEE/CEF, CETP and their dependencies under
[the reactor contract](#the-reactor). A standalone `npm ci` uses the host's registry lock;
that installation alone does not satisfy the development freshness requirement. With a verified
reactor selection active, `cedarcli native restart frontend designer` reinstalls that selection
and prepares the served bundles. Server payloads use their separately captured package locks.

The host verifies each installed bundle against its published SHA-256, and
`app/components/manifest.json` records each package's name, version and digest.
`npm run prepare:components` refreshes the served copies; `npm pack` includes
them through its prepack hook. Explicit local bundle-path overrides remain
available for development, but server payloads reject them. See the host README
for the override names. [`cedarcli check components`](#component-staleness) measures
what is served against what is pinned. The frontend train updates Designer's CEE pin alongside
its other CEE consumers; CED and CETP remain explicit immutable package pins.

`npm start` runs `scripts/designer.mjs`, which writes `app/config`, stages the bundles, and in
develop mode serves `app/`, answering a route with `index.html` and a missing asset with 404. In
server mode it stops after staging, and the native payload build and the Docker image run it that
way. The host has no Gulp build.

The host owns SSO, repository child search, permission checks, dirty navigation,
ETag saves and the instance-aware template version confirmation. Its central
`DesignerCoordinator` combines readiness, permissions, CED validation, the submitted
snapshot and server findings in one save report. Create checks the destination folder's
capabilities; edit checks the loaded artifact and its report. Invalid or unnamed nested
drafts block Save even before CED discloses their errors. Failed startup and loads offer
Reload; script loading and asynchronous element registration both have bounded waits.
Malformed repository child lists and update assessments cannot authorize an operation.

For an existing artifact, the coordinator retains both the loaded document and the
component's initial JSON projection. Saving applies changes relative to that projection
to the loaded document, so normalization by the component does not rewrite untouched older
schema branches. When a child key changes, a unique definition identity carries its stored
branch to the new key; property IRIs distinguish reused definitions that share an identity.
Key swaps follow the same correspondence, while a newly added copy does not inherit hidden
content from another placement. Changing a field between single and repeated cardinality moves
its stored definition into or out of the array wrapper without replacing it with the normalized
projection; simultaneous definition edits still apply. Explicit deletions and changes still reach
storage; changed JSON arrays use the component's complete authored value. The stored and projected
snapshots advance together only after a confirmed save, while newer edits remain dirty. The write still uses the ETag
from the loaded representation; this preservation step does not reconcile concurrent edits.

`npm run smoke:journey -- older-key-rename` verifies a real key rename on a legacy-shaped
field, comparing its full stored definition, annotations, identifiers, provenance and sibling
content after save and reopen. The server also follows unambiguous child identities when
preserving provenance, so changing a placement key does not turn an existing field into a new creation.

The host validates the final merge, including untouched retained branches, with the shared raw-schema
and value checker before enabling Save. Local blocking findings use the existing validation disclosure;
advisory semantic findings remain with the component. Immediately before a create, update or new-version
write, `saveArtifact` prepares storage metadata and identity, then sends that exact body to
`POST /command/validate?resource_type=...`. The server's verdict includes its mandatory Java reader.
Missing, malformed, negative, timed-out and stale responses cannot authorize a write. The immutable
attempt binds both the CED projection and merged body; only a successful current verdict permits
journaling and sending the write. A failed preflight has not sent a write and cannot create uncertain
creation recovery. The write endpoint still validates again after its own normalization.

The host's mandatory browser suite loads the real packaged designer and checks the final submitted
bodies with the same Java oracle and TypeScript reader. Its partial-artifact orchestration fixtures
explicitly stub those external verdicts; the payload and conformance suites exercise the real checks.

Designer freezes editing and disables Save while a write is pending. Unlike Editor's
continued-typing workflow, its controls cannot receive focus or keyboard input until the
request settles. `npm run smoke:journey -- designer-pending-save` delays real successful
PUT replies for templates, elements and standalone fields, verifies that freeze, then checks
that acknowledgement retains the open component and enables editing. A second conditional
save and reopening prove adoption of the new revision and preservation of the complete stored
document apart from the authored description and root update provenance. These checks concern
existing identities; first-create and version-creation recovery have separate contracts.

Structured server findings retain their nested location and message, belong to the
submitted snapshot and retire when it changes. Errors block Save, while server warnings
remain advisory. The host forwards them through CED/CEFD's `validationFindings` input as
`{location, message, severity}` rows. CED gives them `source: 'host'`, maps recognized JSON
Pointers through nested and repeated definitions to settings, and joins them to its existing
summary and inline errors. Both the component summary and host disclosure can navigate to
the affected control; `revealValidationFinding(location)` reports whether a path is mapped.
Unknown paths remain visible as text. Warnings neither mark controls invalid nor block Save.
An accepted document edit or replacement retires the supplied snapshot; invalid pending
settings remain intact. Hosts must discard late reports about an older submitted snapshot.
Conflicts and missing revision tokens preserve edits and block another write. Workspace's metadata
editor provides no version comparison or merge. **Reload metadata** opens the latest saved record
after confirmation to discard unsaved edits; cancelling preserves the draft and the save guard.
Designer also requires a confirmed reload to discard working changes after a conflict.
A refused existing-artifact save (401/403), including
an update assessment refused before writing, offers **Recheck access**. Both hosts read the
artifact and permissions separately from the working draft; only restored update permission
and unchanged opened content/revision enable saving again. A different revision remains blocked
even if its values resemble the attempted submission. Failed checks keep the draft and can
be repeated. Clean read-only openings and denied create destinations also offer an access recheck,
as described below. A lost response, server error, timeout or acknowledgement without an artifact identifier blocks another write and reports
that saving could not be confirmed. An uncertain create or publish/create-draft operation
also hides Reload, so it cannot repeat the write. Its outcome is settled by the identity the
write carried, as [settling a create or version write](#create-outcome-recovery) explains.
An unconfirmed existing-identity update offers **Check save status** separately from Reload.
The host reads the artifact and its permission report without calling `loadArtifact`. Matching
the opened content and revision permits a conditional retry; matching the submitted content
at a new revision advances the saved baseline and ETag while keeping newer edits. The
comparison ignores only root update provenance: child identities and provenance, values,
annotations, order and unknown content still count. Server normalization that cannot be
reconciled exactly leaves Save blocked. Failed reads and denied access preserve the draft and
allow another check; they do not claim the artifact was deleted. A late first commit after an
unchanged read makes the retry stale, so the server refuses it rather than overwriting it.
A successful existing-identity update whose reply omits its ETag also offers Check save status.
The retained opened revision and exact submitted body allow a matching newer stored snapshot
to restore saving without replacing CED or CEFD, losing newer input or repeating the write.
Because the update is known to have succeeded, an old opened revision cannot release this
guard. A missing revision, changed content or denied permission keeps Save blocked and the
check retryable.
A failed update assessment can be retried because it has not written an artifact. The CED
host smoke commits real updates before dropping their replies to verify this distinction.
Retained drafts never authorize overwriting a changed record or adopting its newer revision.
Both hosts retain unfinished work in the tab's `sessionStorage`, scoped to the deployment,
signed-in account, artifact kind and identity, or the destination folder for a new artifact.
The component APIs `captureDraft()` and `restoreDraft()` preserve unfinished control input,
validation gates and accepted content separately from a server-saveable artifact. Reload offers
**Restore draft** after fresh artifact, template and permission reads. It never silently replaces
the latest document or grants the retained draft's former permissions. Neither host displays
recovery-file download or import controls. Server errors and
warnings retain their submitted-content key in that envelope: restoring the same rejected content
retains its findings and save gate, while changing the content retires the report.
Closing the tab ends automatic retention.

A clean read-only opening, or an initial 401/403 refusal, offers **Recheck access** and
**Sign in again**. Recheck reloads content and permissions together; it cannot replace local
work or attach a fresh revision to an older draft. Create routes recheck their destination
folder. Retry after a failed opening preserves retained work. Once deployment and account are
known, existing-record and explicit-destination drafts can be offered even if
profile loading fails. Restore stays disabled until the component/configuration prerequisites
are available. A create route using an unresolved default home folder waits for profile recovery
before selecting its draft scope. If Designer configuration fails before authentication identifies
the account, the host retains browser storage but cannot expose a scoped draft yet; Reload after
configuration recovery offers it. Editor configuration failures occur after scope selection;
restoration waits for its prerequisites. Unavailable and malformed JSON
configuration responses follow the same recovery path.


The hosts journal before dispatching a write. Pending submissions and unresolved create/version
outcomes survive reload, and an uncertain creation cannot be discarded to enable
a second create. Existing-update status checks restore saving only after comparing authoritative
content and revisions. **Sign in again**, offered with access recovery, persists the draft before
redirecting; a storage failure keeps the author on the page. A restored form
whose access is later granted becomes editable after the fresh access check. Explicit ordinary
discard and a clean acknowledged save remove the retained draft. Storage failures are visible.

<a id="create-outcome-recovery"></a>

A create or version write carries an identity its client chose, so a lost reply can be settled
by reading that identity rather than by inspecting Workspace. Before the first attempt, the host
mints `https://repo.<domain>/<collection>/<random UUID>` on the deployment base it already uses
for short addresses, and records the identity in the tab's journal. Every attempt reuses it
until the outcome is settled. A create is `PUT /<collection>/<identity>?folder_id=<folder>`
without `If-Match`. Designer's **Create new draft** sends the draft's identity as the `draft_id`
query parameter, and its journal also keeps the submitted definition, the source identity and the
opened ETag. A create attempt answered 412 or 428 means only that the identity is occupied. The
outcome stays unresolved until a check settles it, and is reported as neither success nor failure.

After an uncertain create or version write, the alert names **Check save status**, and that
control appears in this state as well as for existing-identity updates. The check reads the
identity and settles the outcome as one of three:

- Committed: the identity exists. A new draft must also name the source as `pav:previousVersion`
  and hold the submitted definition. The host opens the artifact at its edit address and keeps
  later edits as unsaved changes.
- Not committed: the identity answers 404. For a new draft, the source must also still be the
  draft that was opened. The alert says the work was not saved, and Save is enabled again with
  the same identity.
- Unresolved: any other answer. Save stays blocked and the check can be repeated. A check refused
  for the session offers **Sign in again**.

Discard stays refused until the outcome is settled. A journal written before hosts recorded an
identity carries none, so its uncertain create stays blocked without Check save status.

Workspace's resource dialogs settle their writes the same way. New folder creates by
`PUT /folders/<identity>`. Copy sends the copy's identity as `copyId`, and Create Draft sends the
draft's as `draftId`. Publish creates no artifact, so its outcome is read from the source. In a
dialog's uncertain state, **Retry** checks the outcome instead of resending the request. A folder
is committed when it exists in the requested parent, a copy when it exists with `pav:derivedFrom`
naming the source, a draft when it exists with `pav:previousVersion` naming the source, and a
publication when the source is published at the requested version. A committed outcome completes
the dialog as a success would. When the identity answers 404, or the source of a publication is
still the draft that was opened, the dialog enables submit again with the same identity and
values. Any other answer leaves the dialog uncertain, and Retry can be repeated. The tab's
`sessionStorage` keeps the identity and values per deployment, account, action, item and
destination, so reopening the same action on the same item and destination after a reload reuses
them.

A lookup cannot tell an identity that was never created from one that was created and then
deleted. If the artifact is deleted while its author's tab still holds the unresolved outcome,
the check reports it as not saved, and a retried create recreates it under the same identity.

`npm run smoke:journey -- draft-recovery metadata-conflict` exercises the deployed component
APIs and real stored artifacts: reload after an outage or lost committed reply, full sign-in,
restoration, authoritative status checks, subsequent conditional saves and readback, plus a real
metadata conflict that retains the draft through reload and restoration, keeps stale saves blocked,
and opens the newer record only after confirmed discard. It also verifies that normal, edited and
conflicted metadata screens have no comparison controls. The regular Workspace stack smoke includes
these journeys too. Fixtures are removed when the run ends.

Additional focused checks, also included in the regular modern smoke:

- `opening-permissions`: real viewer-to-editor grants for clean existing records and denied
  create destinations in both hosts, including fresh content and a subsequent conditional save.
- `signin-permissions`: retain a refused draft through full sign-in while real permissions are
  reduced to viewer; restoration and rechecks do not write, and saving resumes only after a new
  edit grant and explicit save.
- `startup-recovery`: inject profile, component, artifact and destination-folder outages while
  drafts exist; retain work during failure, Retry, restore and save without losing input,
  with no recovery-file controls in the opening, failed or restored form.
- `tab-isolation`: separate tabs keep independent drafts; another account with the prior account's
  retained storage cannot discover or restore the draft.
- `numeric-constraint`: tighten both numeric bounds through another REST client; the real server
  retains well-formed answers with quality findings, the warnings locate both controls, and exact
  boundaries clear the warnings after save and reopen while preserving all unrelated content.
- `mixed-move`: combine a permission refusal, a pre-commit disconnect and a lost committed reply;
  fresh listing keeps only unmoved items selected and retry never repeats completed moves.
- `restored-validation`: inject a server-only finding for templates, elements, fields and metadata;
  reload and restore, verify the save gate and finding navigation, then correct, conditionally save
  and compare the complete stored document on reopening.
- `repeated-schema`: wrap older field definitions in arrays, change their occurrence bounds and
  unwrap them again in templates and elements; compare all content except update provenance on
  the edited field and root, including legacy constraints, annotations, identities and siblings.
- `configuration-draft`: fail configuration with 503 and malformed JSON while Designer has an
  inverted occurrence range or Editor has a fractional value typed as an integer; retain the exact input,
  recover configuration, restore, correct and explicitly save.
- `scalar-roundtrip`: preserve exact decimal text, integers beyond JavaScript's safe integer range,
  signed zero, leap dates and fractional/offset timestamps through unrelated edits; numeric edits
  also retain their lexical value after saving and reopening.
- `account-switch`: perform real logout and alternate two accounts in the same tab; each keeps its
  own draft, reduced permissions are freshly enforced on return, and saving resumes only after a
  new access grant and explicit save.
- `combined-delete`: combine a confirmed recursive deletion and an uncertain artifact deletion
  with 503/disconnected listing and inventory reads; retain confirmed counts, prevent automatic
  retries, and delete only remaining resources using refreshed revisions after recovery.
- `uncertain-create`: lose the reply to Designer and metadata creates that committed, did not
  commit, or committed late, across reload, sign-in and the open tab. Check save status adopts the
  artifact or re-enables Save under the same identity, and each create series leaves exactly one
  artifact.
- `uncertain-workspace-create`: lose the reply to New folder, Copy, Create Draft and Publish.
  Retry settles each by the identity it created, or Publish by the state of its source, and no
  action takes effect twice. One Copy is reopened after a reload and settled there.
- `uncertain-version`: lose the reply to Designer's Create new draft. After a reload, Check save
  status adopts the committed draft or re-enables Save with the same draft identity.
- `partial-version-definition`: a definition the real validator refuses is rejected before
  publication. The source stays the opened draft, and the corrected retry creates one successor.
- `partial-version-draft`: a parent folder the author may no longer create in refuses Create new
  draft before publication, through reload and access rechecks, until the grant returns. It uses
  the second test account by REST token only.
- `unresolved-version`: lose the reply to Designer's Create new draft. Discard is refused until a status
  check settles the version. When another client has edited the committed draft, or published the
  source of an uncommitted one, the check keeps the edit and the save guard, adopts nothing and
  sends no second version command.
- `version-source-access`: the second test account, acting by REST token only, owns the sources.
  The Version tab never offers or attaches a release the author cannot read. It reports an
  unreadable origin and offers only Detach, and the parent still saves its own edit with the link.
- `version-source-deletion`: delete a source through REST while the Version tab's request for it
  is held. A release deleted after the history listed it is answered 404 and offered for no
  upgrade, and an origin deleted while its history is read is reported as unreadable.
- `reusable-changed-draft`: edit the parent while Save as reusable draft is pending, after a lost
  reply whose readback also fails, and after a create that never reached the server, for a field
  and an element. The result is never attached to the changed parent. Repeating the action
  attaches one stored artifact under the identity first sent.
- `restored-control-shapes`: restore an inverted text-length range in a Designer template, an
  incomplete regular expression in a Designer element and a malformed IRI in a metadata link
  field. Each returns exactly, blocks Save with its own explanation and writes nothing until it
  is corrected.
- `restored-newer-edits`: lose the reply to a committed save, reload, restore and type while the
  status check is held, for templates, elements, fields and metadata. The check accepts the
  server's normalization of the lost save, and the next conditional save stores the newer input.

Run any subset with `npm run smoke:journey -- <names>`. Failure injection tests the hosts' handling
of the specified HTTP outcome; fixture creation, successful writes, readback and permission
changes use the running services. Every journey removes its isolated fixtures.


Changes while an update assessment or version confirmation is pending cancel
the write. A successful save stays in Designer. After a create or a new draft, the host
reads the stored artifact back, opens it and moves to its edit address, so the next
update starts from the identity and version metadata the server assigned. Saving an
existing artifact keeps the open document. Only Designer's Workspace control returns to
Workspace. Changes arriving after the write starts remain open after acknowledgement;
the next update uses the returned ETag. If the write created a new artifact identity,
Reload is required to adopt its server-owned version metadata before another save.
The version confirmation's Discard choice restores the last saved baseline and keeps
the designer open. Standalone
field-document routes use CEFD from the same CED bundle; fields inside templates
and elements use the same field controls. During development, explicitly stage
the local CED bundle with `CEDAR_CED_BUNDLE` until a CEFD-containing Nexus snapshot
is pinned. The host fails clearly if the pinned bundle lacks CEFD, and
[`cedarcli check components`](#component-staleness) reports the same condition before a build.

Version creation requires the original ETag in `If-Match`, and the host sends the draft's
minted identity as `draft_id`. The resource server conditionally publishes that exact source
snapshot, creates the draft and applies the submitted definition as one operation, which
either does all three or changes nothing. A missing validator returns 428. A concurrent change
or an occupied draft identity returns 412, a parent folder the author may not create in returns
403, and a definition the validator refuses returns 400 with the validator's report. Each of
these is refused before publication, so the opened ETag stays valid and a corrected retry
creates exactly one draft. A step that still fails after publication, through an outage or a
race, is undone, and the command answers with that step's status, or 503 when none came.

Run `npm test` in the host repository for the host contract suite, including
`test/host-state-matrix.test.mjs`. `npm run test:browser` covers create/edit across
template, element and field routes, nested reports, delayed saves, reload recovery and
the existing visual surface contracts. Run
`npm run smoke:ced-host` in `ops/e2e` for real browser create and update without leaving
Designer, stale-save rejection, instance-aware versioning and the return to Workspace.
The older `login-smoke-test.mjs` still targets
the combined editor's authoring UI; its legacy selectors do not exercise CED.

<a id="ced-running-it-with-its-siblings"></a>

### Running It with Its Siblings

The designer uses sibling web components the host loads, and none is bundled.
A field's constraint set is assembled with
[`<cedar-embeddable-term-picker>`](VERSIONING-RUNBOOK.md), and Preview renders the template
with [`<cedar-embeddable-editor>`](FRONTEND-RUNBOOK.md#cee), the same renderer that will
show the form to whoever fills it in.

```shell
npm --prefix ../cedar-embeddable-term-picker run dist
npm --prefix ../cedar-embeddable-editor run build:production
npm --prefix ../cedar-embeddable-editor/visual run bundle
npm run dist
cp ../cedar-embeddable-term-picker/dist-bundle/cedar-embeddable-term-picker.js dist-bundle/
cp ../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js dist-bundle/
```

CEE's single-file bundle is built in two steps and lands under `visual/`, which is
where its own visual suite serves it from; `dist-npm/` holds a staged copy that
only a package build refreshes.

Serve `dist-bundle/` and load a page that pulls in all three scripts. Each
absence is reported where it would have been used: without the picker the
constraint panel reports editing unavailable and retains the saved set, and without CEE the
preview panel says so.

`npm start` stages both siblings into `public/` and the development host loads
them, so the served designer offers the same two surfaces an embedder gets. A
sibling that has not been built is named and skipped rather than failing the
start, and the copies are the neighbouring repositories' build output rather than
this one's, so they are not committed. The host names a terminology server on
`localhost:9004` for the reason below.

Reuse `<cedar-embeddable-field>` (CEF) for field rendering and value acquisition
whenever its public API supports the workflow. This applies to editable values,
defaults, and read-only field specifications. Prefer extending a missing CEF
capability in CEE over duplicating its rendering or input controls in CED. Keep
authoring commands such as Edit alongside the component, and keep serialization
in the TypeScript model library.

CEF's `readOnlyMode: true` renders a supplied value, or the field's accepted-value
specification when `value` is `{ kind: 'none' }`. CED uses this for the compact
controlled-term summary; the term picker remains the constraint authoring surface.

CED starts with the **Modular** profile. To test reusable artifact search as local
`test1@test.com`, run `npm run demo:prepare` followed by `npm run demo:serve` in CED,
then open `http://localhost:4599/`. This loopback-only host reads Keycloak on 8080
and the resource server on 9007; credentials and renewable access tokens stay in
the demo server. Its API exposes reads only. The published component has no default
repository or account. The opt-in browser check is
`CED_LOCAL_REPOSITORY=1 npm --prefix browser test -- --grep 'local test1'`.

**Add Child** keeps the standard field palette and adds **Select existing fields and elements**.
Its dialog stages multiple first-class artifacts above a searchable, paginated results table,
with name, type, creation/modification dates, version and status. Bins remove staged rows;
Done inserts the complete batch at the selected position and Cancel discards it.
The embedding host supplies `childSource.search` and `childSource.load`; see CED's README
and `CedChildSource` public type for the callback contract. The host owns authentication
and permission filtering. Without that input, repository search reports unavailable.
Imported definitions retain their identifiers, provenance and descendants. Each imported
child takes its name as its key and its name and description as its display name and
description. A key that clashes with a sibling's or is reserved is reported at once, and
the child keeps a usable key until the author chooses one.

Field settings start collapsed behind the grey chevron centered at the bottom of each card.
Expanding it reveals underline tabs: Configuration, Presentation, Constraints or Content
where the type takes them, Annotations and Metadata. An element's settings have
Configuration, Presentation, Annotations and Metadata. Configuration opens first. It
holds how the child's parent places it, in rows. The display name and a wider display
description come first. The requirement select follows with Hidden and Continue previous
line. Allow multiple sits above the minimum and maximum, which share a row with the key, and
the property IRI comes last. The display name and description are the parent's
`_ui.propertyLabels` and `_ui.propertyDescriptions` entries, and the card header shows and
edits the display name. A nested element's header gives its name input the accessible name
Element display name. Each control appears only on a child that can carry it. A static field
has no requirement, multiplicity or Continue previous line, and an element has no
requirement, Hidden or Continue previous line. The bounds stay visible and disabled until
Allow multiple is on. A profile that hides Required or Allow multiple hides that control
here, and a field that is already multiple then still shows its bounds. A field edited in
the Field Designer has no parent and so no Configuration tab. Its header edits its own name.

**Presentation** edits the child's own name and description, its `schema:name` and
`schema:description`, under the labels Field name and Field description or Element name and
Element description. CEE shows a field's own description as its help. Every profile offers
both. While the author first names a new child, its display name and its name are one value,
so an edit from the header, Configuration or Presentation writes both. Once the name first
loses focus, an edit to the display name changes only the display name, and the child's name
and key stay as they are. Its display description and description are one value in the same
way, until the description first loses focus. An imported or library child takes its display
name and display description from its own once and keeps each pair apart from the start. A
label repeating the child's name or key is the writers' filler, not a different display name,
as CEE and the Java library read it. A parent that shows a child as itself therefore shows it
by its own name, and an edit from Presentation changes what the parent shows too. A named
child's display name cannot be cleared. While its input is blank, the header reports that a
display name is required, as it reports a blank name, and the template keeps the previous
display name. A parent that already shows the child differently keeps doing so, and each side
then edits its own value. The designer does not write
`skos:prefLabel`, except that one only repeating the name moves with a rename, so CEE does
not go on showing the old name.

A new child's key is its name as written. It follows the name until the name first loses
focus and is the author's after that. A key must be unique among its siblings and must not
be a reserved name; an invalid key shows its error below the input and is not saved, and
the child keeps a usable key in the meantime. Switching tabs or collapsing the panel retains
incomplete input; valid settings update immediately without Apply buttons. Identity and
provenance appear under Metadata. Imported labels, identifiers, annotations and
property IRIs remain preserved in the model.

A published field or element keeps its own definition: its Presentation, value, Annotations
and metadata controls are disabled, and its card says so. Its parent still places it, so its
header name and description, its Configuration, its position and its removal stay available.
Everything inside a published element is part of its published content and is locked,
placement included, and the element offers no place to add a child.
**Presentation** includes a Language selector for templates, standalone and nested elements,
and all fields (including static fields). Its default, **Not specified**, leaves language
unset; clearing a choice removes the explicit language. The bundled fixed list uses
ISO 639-1 codes and English names from the [Library of Congress](https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt),
retrieved 2026-09-15. Imported tags outside the list remain available as the current
value, without rewriting them. Published field controls remain disabled.

The bottom of **Presentation** on non-static fields contains **Alternate questions**.
Enter a question and select **Add question** to save it as an alternate label.
Blank or whitespace-only questions and duplicates (ignoring surrounding whitespace)
are rejected only on Add. The table is read-only;
its bin actions remove questions. Published field controls are disabled, and questions
are preserved in JSON/YAML round trips.

The **Annotations** tab is available on templates, standalone and nested elements,
and fields. An entry row above the shared table accepts an annotation name, value
type and value; **Add annotation** validates and inserts the entry, then clears the
form. Partial entry shows no error until Add is selected. The table displays saved annotations as read-only text with a bin action to
remove an entry; replace a value by removing it and adding the replacement.
Names must be nonempty and unique, values must contain non-whitespace text,
and IRI values must be absolute identifiers.
Invalid additions remain in the entry form without changing the artifact;
valid additions and removals update the artifact immediately. Published field annotation controls
are disabled. Annotation value types and other metadata survive unrelated edits
and artifact round trips.

The card-level Save field to library action has been removed; import and reuse
remain available through Field Designer.

The root template header has a settings chevron. **Presentation** offers full-width
Header and Footer controls. **Metadata** lists identity and provenance, ending with
**Types**. An element's **Metadata** also offers Types, including a standalone element. Types uses CEF's read-only controlled-term summary and CETP with
`termTypes = ['class']`, without `maximumTerms`. Done writes the allowed instance
class IRIs into both `properties.@type.oneOf` enum branches; cancellation retains
the saved set. These are allowed alternatives, not a requirement to assign all
selected types. The serialized model retains the IRIs; picker labels and pins are
session selection details.

CED uses the model library for multi-type and paragraph length constraints. Local reactor builds
supply the current model source automatically; standalone installs use CED's declared lock.
New child placements explicitly
carry their effective display labels and descriptions so JSON and the model's YAML
reconstruction agree; absent imported overrides remain absent. Java's artifact
library also preserves the full set of instance types through JSON and YAML; its
`instanceJsonLdTypes()` API returns the list, while `instanceJsonLdType()` retains
the single-type compatibility view.

Paragraph Values settings expose minimum and maximum character lengths, including
zero; clearing either control removes that bound. Invalid limits or defaults remain
unsaved drafts with local validation feedback. JSON and YAML preserve the limits
through nested and repeated fields. Regular expressions are available only for text
fields.

The Overview shows each field's type icon and a right-aligned reorder handle.
Dragging reorders siblings within the Overview; the document and main editor update
only when the field is dropped. Focused handles also support Arrow Up/Down.
Element chevrons and the Overview's Expand all/Collapse all icon buttons share
collapse state with the central designer. Selecting an element scrolls its header
below the toolbar with clearance. Field type icons are labels only: changing an
existing field to another type or replacing it with a library field is not offered.

All default-capable fields use `<cedar-embeddable-field>` from the same CEE bundle.
Choose **semantic** in Preferences to expose Default Value. CED and CEE take typed
defaults and JSON/YAML serialization from the model library each of them pins.
Imported numeric constraints and temporal settings are retained;
temporal values are converted between the default's declared precision and CEF's
complete instance literal without shifting timezones. Choices are stored with
`selectedByDefault` on options, including multiple checkbox/list selections.

Numeric authoring validates minimum, maximum and defaults against the datatype,
finite-number limits, bound ordering and decimal precision. Integer datatypes accept
only whole numbers and zero or unspecified decimal places. Byte, short and int use
their datatype ranges, including the full signed 64-bit range for long. Exact numeric
text and shared decimal comparison preserve bounds and defaults beyond native-number precision.
Float checks overflow and nonzero underflow. Invalid
and incomplete numeric input stays in the panel until corrected and does not replace
the saved settings.

Rebuild CEE and refresh the sibling copy when testing defaults: an older CEE
bundle may omit email, phone, link and authority defaults from its preview even
when CED's output contains them. `npm start` refreshes the development host's
copies; a manually served `dist-bundle/` needs the copy commands above again.

The display name and description apply to the child's deployment in this template. CEE
gives them precedence over the child's own labels and description, and falls back to the
artifact when the parent states no override. The preferred label remains part of the
reusable field's metadata. Annotation authoring is tracked in the designer roadmap.

Configuration (for dynamic fields and elements) holds a compact Property IRI box and **Edit**.
They invoke CETP with `termTypes = ['property']` and `maximumTerms = 1`. Done
applies the selected property IRI to the child placement in its parent JSON-LD
context; cancellation preserves the existing IRI. The picker starts an empty
replacement selection because an imported property IRI has no ontology/version
provenance. The placement stores the IRI only; the ontology release chosen while
browsing is not a versioned value constraint. The property IRI is the parent's, so a
published child keeps it editable; inside a published element it is locked.

Controlled defaults use the current `<cedar-embeddable-term-picker>` bundle's term-only mode,
then verify membership through the configured terminology server's
`bioportal/integrated-search`. A vocabulary constraint is required first. Several sources or version pins appear
in a vocabulary/release selector; membership checks still receive the entire field
constraint set and its actions. Constraint edits retain a permitted default and
require explicit clearing before an invalid default's replacement set is applied.

CED uses the picker's `selectionMode = 'constraints'`, `termTypes = ['ontology', 'class', 'branch', 'valueSet']`, `constraintSet` input and
`constraintsSelected` event. The picker owns draft assembly, individual entry
removal and branch depth. To change a selection, remove it and add the desired one. Exclusion and reordering authoring controls
are deferred; imported term actions remain intact. Done returns the entire set; cancellation leaves the original intact.
Constraint arrays and actions retain their order within each model array. A
constraint's service URI, canonical IRI, source system and version pin remain
separate identities.

The host supplies `bridgeBaseUrl` for the seven external authority lookups; the development
host names the local bridge. Missing sibling controls are reported as unavailable,
and saved defaults remain intact.

CI also runs the `CED with real CEE and CEF` job on every push and pull request.
It builds both distributions and supplies `CEF_BUNDLE` to the complete browser
suite, including default editing, CEE preview, style parity and delayed CEF
registration. The CEE checkout is pinned to a full commit in CED's
`.github/workflows/test.yml`; update that pin when adopting a new CEE/CEF revision.
The job prints both source revisions and bundle hashes and retains failure traces.
The combined real term-picker test still needs `PICKER_BUNDLE` separately.

Each designer element owns one `EditorSession`, preferences and endpoint
configuration; the field library remains shared. The session contains one immutable
`ContainerDraft` tree and a selected container ID. Fields and elements are child
nodes with separate reusable definitions and parent placements. Editor IDs are
session identities, independent of artifact IRIs. Navigation changes no artifact and
does not mark it dirty. The root document drives serialization and host events.

`ContainerEditorComponent` renders the root and recursively renders each nested
container inline, using the same header and field layout. Field mutations resolve
the owning container from the node ID, so simultaneous root and nested editors do
not depend on the last selected container. The selected container still determines
the target of the shared field sidebar. `ContainerOutlineComponent` scrolls to a
field or element and expands its ancestors. All CEDAR model reads, builds and writes
remain in `core/model/cedar-template.ts`.

The embedding host supplies standalone elements through the public artifact input.
CED offers no file import/export controls or separate Add Element/Import Element buttons.
Existing nested content remains visible under every profile. Elements start expanded;
the chevron in their template-style header collapses or expands their children without
discarding input or changing the artifact. **Element settings** edits the placement's
property name, display labels, property IRI, requirement, cardinality and layout, and
contains duplicate, remove and move actions. The reusable-child selector within each element
targets that container. The Element settings move selector transfers whole element subtrees;
cycles, duplicate property names and page breaks inside elements are refused. On
narrow screens the outline is hidden; nested sections remain editable inline.

Selecting a reusable element creates an independent local copy retaining source artifact
identity. Its destination is captured when the selector opens, so later navigation
cannot redirect it. **Duplicate Element** creates new draft identities throughout
the subtree, records each source with `pav:derivedFrom`, and clears publication and
creation/update provenance. Neither operation creates a live server reference.

The `artifact` input accepts JSON objects, JSON strings and full YAML for templates
or elements. `currentArtifact` and `artifactChange` expose the complete root artifact.
`template`, `currentTemplate` and `templateChange` remain compatible aliases.
Imports preserve lifecycle, annotations, container metadata, ordering and descendants;
failed imports leave the current document intact. JSON and YAML share the model
codec. YAML export is refused when the model's round trip cannot retain every property.

CEE preview receives the root template, or a temporary template wrapping a root
element. The wrapper never reaches exports or host events. Leaf default controls
continue to use CEF. Field views retain identity while their nodes are unchanged,
so asynchronous terminology checks survive unrelated rendering and reject replies
for fields that were actually replaced.

The default browser suite uses a CEF contract stub. To include the real widgets
and the combined controlled-term picker test, after building all siblings:

```shell
CEF_BUNDLE="$PWD/../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js" \
PICKER_BUNDLE="$PWD/../cedar-embeddable-term-picker/dist-bundle/cedar-embeddable-term-picker.js" \
npm --prefix browser test
```

The preview mode selector offers Read-only (the default) and Editable, one at a
time. Read-only shows what each field accepts; Editable lets an author try filling
in the form. Preview answers do not change the template. Changing preview mode or
loading a different template identifier resets them. Edits retaining the identifier
carry compatible answers, unfinished widget drafts and occurrence cursors into the
new form. Defaults follow the edited template until the reader changes them;
explicit clearing and deletion survive subsequent edits. Occurrence history follows
insertions and copies, so a coincidental default change does not take ownership of
a reader's answer. Rejected values are repaired individually. A new configuration
defect in an optional added element removes the smallest removable occurrence rather
than clearing unrelated answers. Temporal conversion never promotes storage padding
to precision the reader did not supply. The recursive operation and conversion
matrices live in `carried-answers.matrix.spec.ts`; the actual datetime widget and
original audit regressions live in `carried-answers.audit.spec.ts`. The domain gate
also runs the framework-free migration suites and their seeded fuzz checks.
CEE applies configuration once, so a mode change replaces
the preview element; ordinary template updates reuse it. It also asks CEE to drop
its Expand All and Collapse All buttons, through
`showExpandCollapseAll`, because the designer has its own controls over the same
template beside the preview; each section still opens and closes on its own
header. That key arrived in CEE 2.0.4-dev. An older bundle reports it as one it
does not know and drops that key alone, so the preview still renders read-only and
still shows the two buttons.

CEE accepts a new template while no instance is loaded, so the designer reassigns
the one preview element once the template settles; a burst of typing costs one
rebuild, not one per keystroke.

The preview follows the designer's selection, one way. Selecting a field or element
asks CEE to `reveal` it by the property keys the written template holds it under
(`TemplateService.previewPath`), with `focus: false`, so the author keeps typing in
the designer. It asks again after each rebuild, so a field just added is found in the
first form that contains it. CEE gained `reveal` in `2.0.19-dev.20261002.84b6c0ea`,
and an older bundle leaves the preview where it is. The CI job's CEE pin has to be
`d9b5347a` or later for the same reason: against an older CEE, the test that follows
a field onto the second page fails.

**The picker needs a local terminology server.** It reads the version-aware
`/search`, which production does not serve — `POST
https://terminology.metadatacenter.org/search` answers 404. Point
`terminologyBaseUrl` at a local store, which answers on port 9004 and already
sends the right CORS headers. Bringing that store up is in
[VERSIONING-RUNBOOK.md](VERSIONING-RUNBOOK.md).

<a id="ced-ports"></a>

### Ports

| Port | What |
|---|---|
| 4200 | `npm start`, the development host page |
| 4598 | the browser suite's static server, over `dist-bundle/` |
| 9004 | the terminology server the picker reads, when run locally |

<a id="ced-the-things-that-bite"></a>

<a id="the-things-that-bite"></a>

### Troubleshooting CED

**Nexus is a hard dependency of `npm install`.** One package comes from it. An
outage is a broken install and a red CI run at the install step; nothing after it
is implicated.

**A stale bundle looks like a passing test.** The browser suite serves
`dist-bundle/`, not `dist/`. `npm run bundle` after `npm run build`, or use the
commands that chain them.

**jsdom cannot parse the stylesheet the element ships.** Tailwind 4 uses
`@layer`, `oklch()` and `@property`, none of which jsdom's parser knows.
`src/test-setup.ts` filters that one message so it cannot bury a real failure;
anything else jsdom says still reaches the console.

**A template's top-level `required` is JSON Schema's**, naming every property an
instance must carry, including the provenance keys. The author's required flag is
`_valueConstraints.requiredValue` on the field. Reading the first as the second is
a mistake worth remembering.

### Shared Component Defaults and Configuration

Every modern frontend consumes `cedar-design-tokens` at build time: CEE/CEF, CED/CEFD,
CETP, Workspace, OpenView, Monitoring, Bridging and the Template Designer host. Two
further consumers sit outside that set. The MCP session page in `mcp/cedar-cee-mcp`
vendors compiled stylesheets under a checksum manifest, which the adoption check
verifies. The legacy Template Editor loads compiled stylesheets and the icon sprite
outside the adoption check. The package owns the whole vocabulary of 54 tokens. They
cover the font stack, four type sizes and two weights, the theme colour, three text
colours, two rules, three surfaces, the status pairs, the two control densities, the
4/8/12/16/24px spacing scale, one corner radius and a pill, one shadow, motion and
layers. The package also owns the embedded Roboto sources. Its README lists the tokens, and
`tools/retired-tokens.json` names the replacement for every retired name. Material remains inside CEE's adapter; CED uses CSS
properties and its native-control adapter. Geometry unique to one component stays
local.

CEE/CEF default to 36px compact controls. `density="authoring"` selects 32px height,
12px text, 18px line height and the shared 4px corner. CED/CEFD native settings and embedded
CEF use that authoring profile. Both profiles consult public `--cedar-control-*`
host overrides first. Components must not assign those public properties internally;
token defaults use separate names such as `--cedar-control-height-authoring`.
The tokens package tests that its generated CSS cannot shadow the override names.

Error text and borders use `status-error-text` (#b42318), advisory text uses
`status-warning-text`, and advisory backgrounds use `status-warning-surface`. Material's
red is no longer a CEDAR colour anywhere. The shared `fonts` Sass export
contains 14 embedded font faces, Roboto 400 and 500, and no selectors or external font requests.
Font registrars import it outside shadow DOM. Sharing the source preserves
self-contained bundles rather than introducing a runtime font download.

Modern Workspace, CEE/CEF, CED/CEFD, CETP, OpenView, Monitoring and Bridging use the
tokens package's `icons` export: curated Lucide SVGs behind CEDAR semantic names, shared 16/20/24px sizes
and a 2-unit stroke. Thin Angular adapters render that registry; CEE uses a
`cedarIcon` directive on Material hosts and no longer ships an icon font.
Icon-only controls retain accessible names while SVGs are decorative.
Brand assets and authored content are separate. The legacy AngularJS shells
are excluded. `cedarcli check design-tokens --strict` also rejects local icon
geometry, icon-font markup and unknown static names; icon findings cannot be
waived with baseline allowances. Consumer unit tests exercise the registry
adapters, browser tests check meanings and dimensions, and CEE/CED screenshot
baselines use their pinned Linux ARM containers with zero pixel tolerance.

Interface typography uses regular 400 and medium 500, with a 12px minimum for
small labels and count badges. Every page, artifact and dialog title, OpenView's
included, takes the shared artifact-title role. Material's per-level letter spacing
is not used. Local builds adopt current token sources automatically. For registry consumers,
advance pins after publishing a new immutable snapshot; a consumer that
references a retired token fails `cedarcli check design-tokens --strict`, which names
the replacement.

CEE's production build also emits `cedar-embeddable-editor.host-fonts.js` and
`bundle-manifest.host-fonts.json`. This entry point uses the shared Lucide registry and
expects the host to register `CEDAR Roboto` 400/500 globally. CEE 2.0.21 and earlier
name those faces `CEE Roboto`, so their host-font variant draws its text in the system
stack beside a host that registers the shared faces. The default bundle
continues to embed its fonts for standalone CEE/CEF use. Workspace copies and
selects the host-font variant when its installed CEE package includes it, falling
back to the default entry point for older package pins. The shared token source
exports `fonts/regular` and `fonts/medium`; Workspace's existing snapshot uses the
same partials via Sass's configured include path. Verify both bundle variants and
publish CEE before advancing Workspace's pin; source changes alone do not change
what an older installed CEE package contains.

CED and CETP ship the same pair: `cedar-embeddable-designer.host-fonts.js` and
`cedar-embeddable-term-picker.host-fonts.js`, each beside a `bundle-manifest.host-fonts.json`
and held to its own size ceiling, which is the default bundle's less the embedded faces. The
tokens package also publishes the faces as compiled `fonts.css`, for a host without Sass. The
Template Designer page prefers `fonts-hosted.css` with hashed WOFF2 subsets and falls back
to embedded `fonts.css` for older token packages. When staging separate component scripts,
`stage-components.mjs` chooses each host-fonts bundle under the component's usual file name.
A package without a host-fonts bundle, or a tokens package without `fonts.css`, is staged
self-contained. Sharing the faces saves about 180 kB of compressed transfer.

### Template Designer Shared Runtime

CEE, CED and CETP also package `integration.mjs`, an AOT-compiled host-fonts module whose
Angular, RxJS, translation and model dependencies remain external. CEE also names its exact
`jsonld` and `n3` runtimes and imports them only when exporting RDF. This is an explicit host-build
input; the default package entry and standalone scripts remain self-contained. The component
production builds generate both standalone variants and the integration module. Packaging verifies
the module's source fingerprint, bytes and runtime identities against `integration-manifest.json`.

The Template Designer combines a complete integration cohort with Angular's production linker,
then flattens the eager module graph into `cedar-editors.js`. It bundles just the RDF processor
exports CEE uses into two hashed `cedar-rdf-*.js` modules, loaded on the first RDF download.
Older CEE integration packages with embedded processors retain their original single-script path.
Standalone CEE still includes its processors in one script; its embedding contract is unchanged.
Each component keeps its application
injector, per-element state and configuration. Registration waits for CEE, then CETP, then CED;
the host downloads the shared script once. Exact dependency versions must match the component
manifests. The model may cross public and development package identities only when its ESM files
and package metadata match after removing `name`, `version` and `publishConfig`. The manifest's
`runtimeSha256` records that comparison; its original `sha256` still records the exact build input.
Older manifests without `runtimeSha256` retain the exact-version and exact-content rule.
A code, resolver-metadata or other dependency mismatch fails staging.
The build checks its module graph for duplicate runtime copies.

`cedarcli build frontends` supplies these modules from current source automatically. No registry
pin changes or publication are required. Older registry cohorts without integration modules and
explicit local standalone overrides retain the separate-script path. Runtime upgrades require
rebuilding the coordinated cohort. The manifests record both compiled input identities and the
combined script's digest and deferred asset hashes and sizes; `cedarcli check components` verifies
the installed input modules and every served delivery file. Cached builds also verify those files
before reuse. The hash in the script URL
changes whenever its bytes change. Third-party notices travel beside the shared output.

The host's `npm run check:size` runs during preparation and native startup. It counts each
manifest delivery once, host JavaScript, imported CSS, deferred font subsets and RDF processors,
and the deferred schema-validator fallback.
`app/components/page-size.json` records raw and gzip sizes by file and phase. Browser coverage
checks that observed JavaScript/CSS/font requests belong to that inventory. Shared delivery limits
are 4,000,000 raw / 1,000,000 gzip initially and 4,500,000 / 1,150,000 including the fallback.
Older standalone cohorts have separate 5,200,000 / 1,300,000 and 5,700,000 / 1,450,000 limits.
`dist/editors/browser-stats.json` contains the build graph for investigating growth.

Measured on 2026-11-07 against the same sources before RDF deferral, the shared script falls
from 3,443,265 to 3,263,429 raw bytes. The whole page's initial JavaScript/CSS falls from
3,652,610 raw / 813,417 gzip to 3,472,774 / 762,665: 179,836 raw / 50,752 gzip bytes deferred.
Including all deferred assets, the page is 4,260,507 raw / 946,714 gzip, against 4,261,173 /
946,429 before. Both RDF formats are covered by a real shared-host download test, alongside
the assertion that normal summaries, editing and preview do not fetch the processors.
Standalone CEE is 2,237,932 raw / 607,133 gzip, only 147 raw / 65 gzip bytes above that baseline;
its host-font variant is 2,115,274 / 514,514. Neither requires additional processor files.

Workspace, OpenView and Bridging retain separate on-demand CEE scripts. Sharing their runtime
would increase their initial dashboard or landing-page transfer, so their delivery prioritizes
the smaller initial page. The Template Designer already loads all three components on opening.

The host checks every save payload with the meta-schema validator CED carries, through
`designer.validateArtifact`, rather than importing its own copy. Against a CED built before that
method, the host imports its staged `cedar-schema-validation.mjs` instead, so that file is still
staged.

CED and CEFD use one set-once configuration coordinator per component. It diagnoses
unknown keys and wrong types, normalizes both service bases, and hands the same
accepted configuration to terminology and embedded CEF. Malformed non-object
configurations do not consume the first assignment. CEE/CEF's existing direct-host
contract still requires trailing slashes; the designer coordinator supplies them.
Read-only and document lifecycle contracts remain component-specific.

#### Shared interaction and layout roles

The tokens package also owns keyboard focus geometry, enabled hover/pressed and
disabled states, paired semantic status colors, dialog/menu surfaces, form rhythm,
table density, motion durations and overlay layers. Use its opt-in Sass recipes
through thin adapters; keep component behavior, host override contracts and unique
layout local. Semantic status text/surface pairs have automated contrast checks.
Default table rows accommodate 36px controls with 8px vertical gutters; authoring
rows accommodate 32px controls with 4px gutters. Row heights can grow for content.

Include the shared reduced-motion recipe once per document or shadow root.
JavaScript-driven animation must honor the preference separately. Layer roles
are ordered within the host stacking context; they do not supersede native dialog
top layers. CED browser checks exercise menu/modal layers and both motion modes.
The read-only live `ops/e2e` command `npm run smoke:ui-unification` checks Groups
keyboard focus and disabled, hover and pressed states, plus the CEE-derived white
surfaces and title roles across Workspace, account pages and resource dialogs at
desktop and phone widths. `CEDAR_UI_SCREENSHOTS=/tmp/cedar-ui` saves review captures.
The full `npm run smoke:workspace:modern` journey also checks editable and read-only
Permissions dialogs, including visible role/ownership controls on phones; it accepts
the same screenshot directory. These live checks need the authenticated local stack.
CETP's `npm run test:visual` compares two zero-tolerance desktop/phone baselines in
Playwright 1.64.1's ARM Linux container, matching its CI runner. Build first; update
with `npm run test:visual -- --update-snapshots` only after reviewing the render.
CEE's existing read-only and editable visual baselines remain the design reference.

#### Local Verification of Unpublished Token Changes

Run `cedarcli test frontends` for current-source verification, or `cedarcli build frontends` for
deployment and whole-stack smoke as well. Both build the token package and wire all consumers
automatically. Their preflight uses the local token vocabulary; a new token or export needs no
registry publication or pin update first.

The manual procedure below is only for diagnosing a single consumer in an isolated scratch copy.
It is not a prerequisite for either development command and must not replace a running reactor's
selected packages. Registry CI still requires published dependencies before consumers are pushed.

CEE and CED install the shared control, spacing and font exports from their
exact Nexus snapshot pins when installed standalone. In that separate registry workflow, before pushing consumers that need
new exports, publish a new immutable token snapshot, update their package and
lockfile pins, and prove a clean `npm ci` build. Never overwrite a published
version. With the native profile sourced, the scratch-copy diagnostic is:

```sh
cd "$CEDAR_HOME/cedar-design-tokens"
npm test
npm pack --pack-destination /tmp
mkdir -p /tmp/cedar-tokens && tar -xzf /tmp/<token-tarball>.tgz -C /tmp/cedar-tokens
# In each consumer, install its lock, then replace only the token package:
cd "$CEDAR_HOME/cedar-embeddable-editor"
npm ci
rm -rf node_modules/@org.metadatacenter/cedar-design-tokens
cp -R /tmp/cedar-tokens/package node_modules/@org.metadatacenter/cedar-design-tokens
```

Replace the package rather than installing the tarball. `npm install --no-save
--package-lock=false` resolves every dependency again from its range, so a consumer
silently builds against newer packages than its lock names. On 2026-09-30 it moved
CEE from Angular 22.2.0 to 22.2.1, which shifted overlay text by a fraction of a pixel
and changed a screenshot the source change had not touched. The token package has no
dependencies, so replacing it leaves the rest of the locked graph exact, as the
consumer CI does.

Build CEE/CEF first, then use its built bundle as `CEF_BUNDLE` for the CED browser
gate. Tests cover both profiles, inherited host overrides in all four elements,
CEF nested in CED/CEFD, invalid/focused controls, narrow hosts, configuration
normalization and malformed inputs. CEE screenshot checks use the pinned Linux
container; macOS screenshots must not replace those baselines. Reinstalling with
`npm ci` restores the published token pin. Local-tarball success is not a clean
CI result: verify again after publishing and pinning the snapshot. CED's real-CEF
integration workflow must pin a CEE source revision that implements the profiles
its tests exercise.

#### Monitoring token adoption

Run `cedarcli check design-tokens` for Workspace, CEE/CEF, CED/CEFD, CETP,
OpenView, Monitoring, Bridging, the Template Designer host and the MCP session page,
`--strict` to gate new color/typography, spacing, control geometry, layers and
motion drift, `--json` for an archived report, and `--repo <name> --prune-baseline`
after removing existing findings. Policy 2 includes Angular styles, inline templates,
style bindings and utility classes. Unknown shared properties cannot be baselined.
CI rejects increased allowances against the trusted base revision, and `--strict` fails
while a baseline keeps allowances its code no longer needs. Policy 3 adds focus outlines,
single-corner radii, opacity, easing, `color-mix()` and negative lengths; policy 4 adds
Material's theme inputs and the routes around the template scan, such as host metadata,
Tailwind's arbitrary properties and SVG text attributes. The offline
scanner reads versioned sources and needs no npm build. It compares each pin with the
version the local token checkout's head publishes under, not with the latest Nexus
publication, and fails when the pinned package lacks a token the repository reads. This complements `cedarcli check components`;
it does not prove which bundle a host serves. The token repository's README owns
the scanner scope, exact-declaration exceptions, CI base-revision comparison and
rollout order. Review baseline changes as code; do not regenerate debt to pass CI.
The reactor applies the same style policy against the local token source for consumers in its
build graph. Registry-pin findings remain visible without blocking adoption of that source.

The tokens package exports opt-in `patterns` Sass recipes for titles, menus, dialogs,
forms, required marks, tabs, breadcrumbs, resource cards, table cells and empty states.
Its `UI-CONTRACTS.md` records required behavior and the suites that verify it. Workspace,
Groups and Permissions consume these recipes, OpenView's folders share Workspace's
breadcrumb and card recipes, and every tab row in Workspace, CED and CETP uses the tab
recipe. A component in its own shadow root declares the shared properties on its host with
`custom-properties.declare`; CETP does, and re-points the shared roles at its `--cetp-*`
host properties. The strict adoption check rejects a consumer that redefines a shared token
and fails when a token has no consumer.

Token pull requests and develop pushes run `Consumer contracts` across all eight
consumers. Each job records both source SHAs and the packed candidate hash, installs
the consumer's locked graph, and replaces only the dependency-free token package.
Every packed file is compared byte for byte. All eight consumers build; CEE, CED,
CETP and Workspace run their existing pinned Linux ARM64 visual suites without
updating baselines. OpenView, Monitoring, Bridging and the Template Designer host
run their browser contracts against the candidate as well. Monitoring and
Bridging's reactor verification installs their locked browser test packages and
Chromium, builds the application before the browser suite, and honors
`CEDAR_TEST_WORKERS`. Their final build step remains in place for release output
recording. Isolated nested applications retain their repository layout, including
the sibling `browser/` package and surface registry; the source fingerprint covers
that whole repository so changes to those checks invalidate reused results.
Failed-build diagnostics retain the sibling browser reports before cleanup.
This complements each consumer's own CI and catches shared
changes before publication. It does not install repository approval rules.

Workspace imports the token package's scoped `native-choices.css` at its application
root. The same stylesheet draws native single-select chevrons and date picker
indicators from the icon registry. The source adoption gate verifies both the import
and the root class, and browser contracts compare checkbox/radio colours with the live
token roles in Groups, Permissions, filters and draft sharing. These checks include disabled
states, keyboard focus and host colour overrides. The legacy Groups page keeps
its own local brand palette; it does not participate in this token contract.

Workspace's remaining adoption baseline preserves local layout dimensions: avatar
and checkbox sizes, header/viewport calculations, screen-reader clipping, and the
existing Groups/Permissions offsets and padding. Privacy prose keeps its existing
line spacing. Review these in context rather than substituting a same-valued token
with a different meaning or changing approved geometry just to reduce the count.
Exact shared control-height and standard-spacing matches use tokens instead.

Workspace's `npm run test:visual` runs its built Angular application in the pinned
Playwright container, covering desktop/375px screenshots, Axe accessibility, keyboard
menus, modal focus/return, nested Escape handling, stale/duplicate saves, field errors,
unsaved edits, destructive cancellation and URL navigation state. Fixtures mock HTTP,
authentication and the CEE SDK boundary; the real-component and live-stack suites
remain necessary. `npm run smoke:workspace:modern` in `ops/e2e` exercises the live
services and actual CEE/CED components. See `cedar-workspace/browser/README.md`.

For a side-by-side manual comparison, build CEE and CED using the procedures above,
stage the current CEE bundle beside CED's bundle, then start CED's fixture server
with the native profile sourced:

```sh
cd "$CEDAR_HOME/cedar-embeddable-designer"
cp ../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js dist-bundle/
node browser/serve.mjs
```

Open `http://localhost:4598/style-comparison.html`. It renders all four real
components, displays the shared semantic status pairs, and supports
compact/authoring entry density, narrow hosts, inherited
overrides and the supported read-only modes. Use keyboard focus and invalid
field values to inspect those states. The page shows a missing-bundle message
instead of substituting mock components. Its browser test joins the existing
real-CEE/CEF gate when `CEF_BUNDLE` is supplied.

#### CED token coverage audit (2026-10-04)

Passing the new-drift gate does not mean that CED's presentation is centrally
enforced. `cedarcli check design-tokens --strict --all --repo cedar-embeddable-designer`
lists the existing findings that remain. They are source findings, development
surfaces included, not demonstrated visual defects. Resolved baseline allowances are
pruned rather than retained as permission for drift to return.

The same check counts CED's registered surfaces and rendered contracts, and reports
any recorded difference. The authoring label, control and table-cell contracts run at
desktop and 375px widths on representative surfaces: the annotation entry row, a
field's metadata, a field's constraint select, an element's metadata, a nested
field's constraints, a default-value label beside real CEF, and a field's metadata
under a host override of the shared type size. CED's own browser suites cover the
field-type matrix, every field type in every settings tab. A central contract
compares each property with a single token, so it cannot express select-arrow
clearance, which is a sum of two tokens, or controlled-term default-row alignment,
which is a relation between boxes. CED's browser tests check both. The dialog
contract checks only surface color and corner radius.

Shared values live in `cedar-design-tokens/scss/_tokens.scss`; native authoring recipes
live in `scss/_authoring.scss`, alongside general `_patterns.scss` and `_controls.scss`.
CED imports authoring recipes directly. `src/authoring.scss` selects the applicable
surfaces for both designer elements without copying recipe declarations. Component
styles own content-specific layout. Preferences and Presets use the central
settings-dialog structure; field cards, the palette and sidebar use semantic
text, surface, border and theme roles rather than independent gray/green palettes.
Do not reintroduce local control/table recipe
copies or corrective authoring geometry in `src/styles.css`.

This is not complete adoption: utility styling and component overrides remain,
including the field-settings stylesheet that the element card also loads. Token references
do not prevent an omitted recipe or cascade override from changing presentation.

For this class of regression, review the computed properties on the actual
standalone and nested authoring surfaces, with real CEF loaded, at desktop and
375px widths and with supported host overrides. Check label weight/style,
control/value weight, row density, the final table rule, select trailing space and
empty/populated default-row alignment. A same-valued token substitution is not
proof that the correct semantic role or shared recipe is used. Baselines must
remain tied to approved presentation, not regenerated to accept unexpected output.

CEE's existing findings are legacy debt, not approved exceptions.
`cedarcli check design-tokens --strict --all --repo cedar-embeddable-editor` lists them.
CEE's `STYLING.md` records ownership by surface; CED's README
records the corresponding boundary. Read-only specification boxes, separators and
links share central recipes, including standalone defaults and supported host
overrides. The CED property, type and default-term dialogs use the central surface
recipe rather than documented radius deviations.

The gate admits no exceptions. It refuses any change to a repository's recorded
exceptions, on a push as on a pull request, and no frontend records one. Local
content geometry, framework-adapter arithmetic and deliberate host fixtures
therefore leave the baseline only through a shared role or recipe, or a size named
for their component in the `spacing` export. Otherwise they remain recorded debt.
Ordinary labels, controls, state colors and dialog surfaces remain shared design
work. Prune resolved baseline entries.

Tokens also cannot enforce validation timing, save-state terminology or separation
of selected values from defaults. Those require application-state tests. Finally,
source adoption, installed package pins and served component bytes are separate
checks: retain all three alongside the reactor and smoke evidence. By decision, CED's
baseline keeps the field library's two section heights, which its divider sets as it
is dragged. No stylesheet can name a value that exists only at runtime, so both stay
as recorded debt.

#### Cross-consumer token audit (2026-10-23)

The local audit found no new source-adoption violations or rendered-contract drift
in the eight modern frontends. `cedarcli check design-tokens --strict --all --json`
passed across those frontends and the MCP session page: 853 source files, 105
existing findings, no stale allowances, missing token references or unused tokens.
The eight modern consumers pin `0.1.0-dev.20261021.c0dd06d3`. Their installed
Sass, compiled assets and icon files match the central checkout byte for byte,
including installations whose package version labels are older reactor labels.

| Consumer | Existing source findings | Passing browser checks |
| --- | ---: | ---: |
| CED / CEFD | 2 | 83 |
| CEE / CEF | 33 | 8 |
| CETP | 14 | 12 |
| Workspace | 18 | 125 |
| OpenView | 6 | 26 |
| Monitoring | 31 | 40 |
| Bridging | 1 | 10 |
| Template Designer host | 0 | 11 |
| MCP session page | 0 | Not run |

All **315 browser checks passed**, including registered surfaces at 1440px and
375px, CED authoring under host overrides and its default-value surface with real
CEF. The runs used the existing `surfaces.spec` suites, plus CED's
`shared-surfaces.spec`; no screenshot or allowance was updated. CED, CETP,
Workspace and Monitoring test outputs were rebuilt. This is computed-style and
fixture evidence, not a production audit, a complete pixel-baseline run or a
whole-stack smoke run. Legacy AngularJS Template Editor remains outside these
adoption and rendered-contract gates.

The findings distinguish existing local values from new drift. CED's two are the
runtime-resized library sections retained by decision. CEE keeps comfortable-mode
Material sizing/outline values, a local time-picker line height and other geometry;
CETP keeps its host-derived selection tint, local line heights, a 22px constraint
action height and 0.4 disabled opacity. Workspace and the other applications also
retain layout or categorical-color debt. Comparing recorded source allowances
with the end of 2026-10-04 found no increases in the eight modern frontends; CED
fell from 23 to 2 and the Template Designer host from 1 to 0. These counts do not
justify substituting same-valued tokens with different meanings or changing
approved geometry.

The audit also exposed limits in the evidence:

- Monitoring's old local `dist` failed 20 checks for a retired monospace font and
  two for an outdated health-check fixture state. Rebuilding current source made
  all 40 pass without a source change. A passing source scan cannot certify an
  arbitrary existing build directory.
- The original adoption report counted only contract `debt`, omitting
  `scaleDebt`. The report now counts both and shows their breakdown: two CETP
  selection-tint allowances and five Monitoring categorical-color/toast
  allowances. The retained audit JSON predates this reporting correction; browser
  enforcement and the registries are unchanged.
- The audit found Monitoring and Bridging browser suites missing from the central
  token workflow and reactor verification. Both now install and run those suites
  against built output, as their own CI already did. A new build precedes the
  browser checks so an old local distribution cannot stand in for current source.
- The MCP manifest is nine token commits behind, but all three vendored
  stylesheets match current compiled bytes. This is version lag without observed
  stylesheet drift. `check components --all --strict` separately reports the
  Template Designer host's CED and CETP pins one commit behind, both for a model
  library pin update; that is not a token-style difference.

The follow-up fixes passed both exact verification recipes in isolated repository
copies: dependency installation, unit tests, fresh application builds and all 191
Monitoring / 42 Bridging browser tests. The strict adoption check still passes and
now reports the seven recorded color allowances. Checker, inventory, isolation,
cache-invalidation and diagnostic-retention regressions pass. These targeted runs
do not constitute a full frontend reactor or a GitHub Actions run.

Local raw evidence is retained under
`$CEDAR_HOME/.cedar/audits/2026-10-23-design-tokens/`: `summary.json`,
`source-adoption.json`, `component-freshness.txt`, build logs and browser logs,
including both Monitoring runs. Source styling, shared values, package pins and
baselines were unchanged by this audit.

<a id="accessibility-conformance"></a>

## Accessibility Conformance

Each component's axe gate reports whether axe's rules pass in the states its suite scans. Those
rules settle only part of WCAG, so a passing gate cannot say how accessible a component is. A
conformance report measures that instead. It takes every WCAG 2.2 success criterion at levels A
and AA, 55 in all, and records for each component what evidence settles it.

CED, CEE, the term picker and Workspace were assessed on 2026-10-19, from their source and tests,
and reassessed on 2026-10-20 after three rounds of fixes, at CED `7bf2a79`, CEE `313d7ceb`, the
term picker `8ed2d81` and Workspace `0323655a`. On 2026-10-21 the criteria a fourth round touched
were reassessed at CED `7317f29`, CEE `2c882afa`, the term picker `ef5fac9` and Workspace
`bc2401e8`. On 2026-10-27 the criteria a fifth round touched, 1.4.1 and 1.4.11, were reassessed at
CED `dd034da`, CEE `fed2441c`, the term picker `1c4a4e9` and Workspace `69d64fe9`. On 2026-10-28
1.4.11 was reassessed twice more, after a sixth and a seventh round, last at CED `0bb2eb7`, CEE
`1461488f`, the term picker `ee2d479` and Workspace `eaa99ea2`. On 2026-11-04 the criteria an
eighth round touched, 1.4.1, 2.2.1 and 2.5.8 in CEE and 2.4.3 in Workspace, were reassessed at CEE
`d394026f` and Workspace `c6cb1227`. The assessment read code and tests. Nobody ran a
screen reader, and only the English text was judged, not the Hungarian translations. Zoom, reflow
and text spacing are measured by each suite's layout check rather than by a person.

A criterion counts as met only when every part of it is evidenced. Three kinds of evidence count:

- an automated gate that passes in CI;
- a spec that asserts the behaviour;
- a review of all the source the criterion concerns, used only where source can settle it, such as
  the absence of time limits, flashing or an orientation lock.

Each criterion takes one of six statuses:

- **Met:** every part is evidenced.
- **Partial:** some parts are evidenced, and the rest need a test or a person.
- **Fails:** the component has a known failure, whether a gate exception, a roadmap finding or a
  defect the assessment found.
- **Unverified:** nothing in the tests or the source settles it.
- **Host:** the criterion belongs to the page that embeds the component, such as its title, its
  language or its sign-in.
- **N/A:** the component has none of the content the criterion governs, such as audio or links.

### Scores

A component's score is the share of the criteria that apply to it which are met. Host and N/A
criteria do not apply.

| Component | Met | Partial | Fails | Unverified | Host or N/A | Score |
| --- | --- | --- | --- | --- | --- | --- |
| CED | 22 | 10 | 7 | 0 | 16 | 22 of 39, 56% |
| CEE | 25 | 12 | 4 | 6 | 8 | 25 of 47, 53% |
| Term picker | 25 | 9 | 5 | 0 | 16 | 25 of 39, 64% |
| Workspace | 30 | 15 | 2 | 0 | 8 | 30 of 47, 64% |

CEE's unverified count includes the five media criteria. A template can embed a YouTube video, and
its captions and descriptions are the template author's.

On 2026-10-19 the four scored 41%, 34%, 51% and 43%, with 39 failures between them. The first round
of fixes cut the failures to 26. Most of the criteria it touched moved from Fails to Partial rather
than to Met, because a criterion is met only when every part of it is evidenced. The second and
third rounds moved more to Met, but the failures stood at 27 after them, because the layout check
and the wider scans found new ones as fast as others were fixed. The fourth round moved CED's 1.4.13
from Fails to Met and Workspace's 3.1.2 from Partial to Met. CEE's wider layout check then found
long read-only values cut short at 200% zoom and under text spacing, and CED was found to leave
focus on a hidden control, so the failures stood at 29. The fifth round darkened the shared control
outline to 3.2:1 and gave every state that a tint alone had marked a second cue. That moved 1.4.11
in all four components, and 1.4.1 in CED, the term picker and Workspace, from Fails to Partial
rather than to Met, because no test covers every boundary and every use of colour. CEE's 1.4.1
still fails on its warnings, which differ from errors only by colour. The sixth round added a check
of every field boundary as the browser draws it. A white field keeps its fill under its border, so
on a panel its outline was drawn over white and seen against the panel, at 2.99:1, in CED's
settings and the term picker's constraint details. The term picker's depth field also drew its
border in the rule colour, at 1.24:1. The outline darkened to 0.45 and the depth field took it, so
every boundary now measures at least 3:1 as drawn. A seventh round measured icons, focus indicators
and selection marks as drawn too. It found that a selected CED field card showed no focus ring, that
CEE's current page chip was marked by a tint alone, and that the term picker drew its tree's twists
and its close button white on white. With each fixed, 1.4.11 moved from Partial to Met in all four
components. The failures stood at 22 after it. An eighth round marked every CEE warning with the
word Warning, gave CEE's link-out icon a 4px gap and kept its cleared and reverted notices until
the next edit. In Workspace it asked before removing access and closed menus when focus leaves
them. That moved CEE's 1.4.1 from Fails to Partial, its 2.2.1 and 2.5.8 from Fails to Met, and
Workspace's 2.4.3 from Fails to Partial. Workspace's 3.3.4 stays Partial, because no assessment
has covered its other irreversible actions. The failures now stand at 18, and most of them need a
visible change.

The gates now scan hover and focus states, open menus, overlays and dialogs, and they settle each
of axe's undecided contrast and target-size results by measurement, so an undecided result nobody
has measured fails the gate. Each suite also runs `layout-resilience.spec`, one method in all four:
reflow at 320 CSS pixels, a 640 by 400 viewport for 200% zoom, WCAG's text spacing at 1280 pixels,
the contrast of every placeholder, and the contrast of every field boundary, icon, focus indicator
and selection mark against what it is drawn on. A finding that needs a visible change is recorded in the
spec as a named exception, and an exception that stops occurring fails it.

### Failures Several Components Share

One failure still recurs across components: targets under 24px. CED's field settings toggle and
the term picker's tree twists, tree terms and history releases fall under WCAG 2.2's minimum
target (2.5.8).

Two others had shared causes, and each was fixed where its cause lives. Text inputs draw their
boundary in `control-border-default`, which now measures 3.35:1 on white and 3.09:1 where a white
field sits on a panel. A selection tint of about
1.2:1 is never a selection's only mark. A selected item takes `patterns.selected-outline` or, where
the focus ring needs the outline, `patterns.selected-frame`. CEE's calendar gives the focused date
the focus ring, and CED's errored settings tab carries the warning icon.

The layout check's failures are each a component's own: CED's narrow layouts, CEE's PubMed and
RRID instructions cut short at 320 pixels and its long read-only values cut short at 320 pixels, at
200% zoom and under text spacing, the term picker's release history at 320 pixels and its truncated
lines and narrowing panel at 200% zoom, and Workspace's grid card under text spacing. The fixes are
open work in the
[frontend roadmap's accessibility item](FRONTEND-ROADMAP.md#accessibility), the term picker's
included.

### By Criterion

The table gives each component's status for every criterion. Reassess a criterion after a change
that touches it, and update the assessment date and commits with it.

| Criterion | Level | CED | CEE | Term picker | Workspace |
| --- | --- | --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | Met | Met | Met | Met |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | N/A | Unverified | N/A | N/A |
| 1.2.2 Captions (Prerecorded) | A | N/A | Unverified | N/A | N/A |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | N/A | Unverified | N/A | N/A |
| 1.2.4 Captions (Live) | AA | N/A | Unverified | N/A | N/A |
| 1.2.5 Audio Description (Prerecorded) | AA | N/A | Unverified | N/A | N/A |
| 1.3.1 Info and Relationships | A | Partial | Met | Fails | Partial |
| 1.3.2 Meaningful Sequence | A | Met | Partial | Met | Met |
| 1.3.3 Sensory Characteristics | A | Met | Met | Met | Partial |
| 1.3.4 Orientation | AA | Met | Met | Met | Met |
| 1.3.5 Identify Input Purpose | AA | N/A | Unverified | N/A | N/A |
| 1.4.1 Use of Color | A | Partial | Partial | Partial | Partial |
| 1.4.2 Audio Control | A | N/A | Met | N/A | N/A |
| 1.4.3 Contrast (Minimum) | AA | Met | Met | Met | Met |
| 1.4.4 Resize Text | AA | Fails | Fails | Fails | Met |
| 1.4.5 Images of Text | AA | Met | Met | Met | Met |
| 1.4.10 Reflow | AA | Fails | Fails | Fails | Met |
| 1.4.11 Non-text Contrast | AA | Met | Met | Met | Met |
| 1.4.12 Text Spacing | AA | Met | Fails | Met | Fails |
| 1.4.13 Content on Hover or Focus | AA | Met | Partial | Met | Met |
| 2.1.1 Keyboard | A | Fails | Fails | Partial | Fails |
| 2.1.2 No Keyboard Trap | A | Partial | Partial | Met | Met |
| 2.1.4 Character Key Shortcuts | A | Met | Met | Met | Met |
| 2.2.1 Timing Adjustable | A | Met | Met | Met | Partial |
| 2.2.2 Pause, Stop, Hide | A | Met | Met | Met | Partial |
| 2.3.1 Three Flashes or Below Threshold | A | Met | Met | Met | Met |
| 2.4.1 Bypass Blocks | A | Host | Host | Host | Met |
| 2.4.2 Page Titled | A | Host | Host | Host | Met |
| 2.4.3 Focus Order | A | Partial | Partial | Partial | Partial |
| 2.4.4 Link Purpose (In Context) | A | N/A | Met | N/A | Met |
| 2.4.5 Multiple Ways | AA | Host | Host | Host | Partial |
| 2.4.6 Headings and Labels | AA | Met | Partial | Partial | Met |
| 2.4.7 Focus Visible | AA | Fails | Partial | Partial | Partial |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Partial | Partial | Partial | Partial |
| 2.5.1 Pointer Gestures | A | Met | Met | Met | Met |
| 2.5.2 Pointer Cancellation | A | Met | Met | Met | Met |
| 2.5.3 Label in Name | A | Met | Met | Met | Met |
| 2.5.4 Motion Actuation | A | Met | Met | Met | Met |
| 2.5.7 Dragging Movements | AA | Fails | Met | Met | Partial |
| 2.5.8 Target Size (Minimum) | AA | Fails | Met | Fails | Met |
| 3.1.1 Language of Page | A | Host | Host | Host | Met |
| 3.1.2 Language of Parts | AA | Partial | Partial | Met | Met |
| 3.2.1 On Focus | A | Partial | Met | Met | Met |
| 3.2.2 On Input | A | Met | Met | Met | Met |
| 3.2.3 Consistent Navigation | AA | Host | Host | Host | Met |
| 3.2.4 Consistent Identification | AA | Met | Met | Partial | Partial |
| 3.2.6 Consistent Help | A | Host | Host | Host | Met |
| 3.3.1 Error Identification | A | Met | Met | Met | Met |
| 3.3.2 Labels or Instructions | A | Partial | Partial | Met | Met |
| 3.3.3 Error Suggestion | AA | Partial | Partial | Partial | Partial |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Host | Host | Host | Partial |
| 3.3.7 Redundant Entry | A | Met | Met | Met | Met |
| 3.3.8 Accessible Authentication (Minimum) | AA | Host | Host | Host | N/A |
| 4.1.2 Name, Role, Value | A | Fails | Partial | Fails | Partial |
| 4.1.3 Status Messages | AA | Partial | Met | Partial | Partial |

## Surface inventory and token coverage

The modern UI hierarchy is generated from `.ui-surfaces.json` in Workspace, CED,
CEE, the Template Designer host and OpenView. These registries own surface names, stable
IDs, hierarchy and the links to source and rendered contracts; the Markdown preview
is generated output. Keep CEE/CEF as opaque entries and register their exposed
menus/dialogs separately.

OpenView's registry is at `cedar-openview/.ui-surfaces.json`; its application source
is under `cedar-openview-src`. CI checks that nested source for unregistered
menus/dialogs and literal Angular routes, and checks registered source anchors.
`browser/` is a Playwright suite that serves the built application and answers the
open API from fixtures. It checks every page as rendered: the folder and the empty
folder, the template, element, field and instance pages, and the not-found, not-open
and template-not-open error cards. Run it with `npm ci && npm test` in `browser/`
after `npm run build` in `cedar-openview-src`. CEE stays opaque and shares CEE's
existing registrations.

`cedarcli check design-tokens --strict` checks registration coverage alongside
source-style adoption. `--sync-surfaces` refreshes generated browser helpers from
`cedar-design-tokens`; `--surface-inventory <path.md>` generates the hierarchy.
Each owning repository's ordinary browser suite includes `surfaces.spec.*`, which
opens registered surfaces at desktop/narrow widths and attaches measured style
values. The offline CLI check does not run those browser cases.

Add/change/remove registrations with the source change. Existing measured visual
debt is exact and cannot grow in a feature PR; resolved debt must be removed.
See `cedar-design-tokens/README.md`, “Maintained surface registry”, for the schema,
central contracts, discovery limitations, generated helpers and maintenance steps.

### Give a user or LLM the current surface hierarchy

For requests such as “Show me the modern UI surface hierarchy”, use the registries
to regenerate the list; do not reconstruct it from memory or hand-edit the output.
From `$CEDAR_HOME`, run:

```bash
cedarcli check design-tokens --surface-inventory "$CEDAR_HOME/output/modern-workspace-ui-inventory.md"
```

If the shell has no `cedarcli` alias, use
`bash "$CEDAR_HOME/cedar-cli/cli.sh"` in its place. The command needs the sibling
`cedar-design-tokens`, `cedar-workspace`, `cedar-embeddable-designer`,
`cedar-embeddable-editor`, `cedar-template-designer` and `cedar-openview` checkouts. It validates the
registries before generating the hierarchy and does not require a running stack.
Resolve reported registration errors before presenting the list as current.

Read the generated Markdown and, in Codex, open that file with `open_in_codex` for
in-app preview. Return names and nesting only unless the user asks for detail.
Keep the registered category order and opaque embedded-component entries; menus
and dialogs exposed by those components appear in their registered shared sections.
Change names or hierarchy in the owning `.ui-surfaces.json`, then regenerate.
The output file is a disposable local view; the committed registries are the
maintained source of truth.

### Printable surface checklist (PDF)

When asked for a surface summary, surface checklist or full surface inventory as a
PDF, produce the **complete checklist on one landscape page**, with **one separate,
initially unchecked checkbox for every entry** in the freshly generated hierarchy.
This is a sheet for checking each surface individually, not a condensed summary.
Use the inventory command above first and resolve registration errors before
rendering. Include all registered sections across Workspace, CED, CEE, the Template
Designer host and OpenView unless the user explicitly requests a narrower scope.

Preserve the generated names, category order and nesting. Do not merge entries
(for example, Copy and Move), replace children with a parent checkbox, remove
repeated names in different contexts, or omit entries to fit the page. Keep opaque
component entries and their separately registered exposed menus/dialogs. Retain
labels that are already combined in the maintained registry; do not invent a
different hierarchy in the PDF.

Use landscape US Letter, four columns, readable text of at least 9 points and
checkboxes large enough to tick on paper. Wrap full labels, keep headings with
their first entries, and mark continued sections at column breaks. The checkboxes
should also be interactive PDF fields. Include the generation date, reviewer line
and total checkbox count. If future inventory growth prevents a readable one-page
Letter layout, use a larger landscape sheet and state its paper size; never silently
drop or collapse entries.

Save the PDF on the user's Desktop as `CEDAR-Workspace-Surface-Checklist.pdf`,
unless another destination is requested. Before delivery, verify that it has
exactly one landscape page, that every generated inventory entry appears in order
with its own checkbox, and that the PDF field/widget counts match the inventory
entry count with every checkbox unchecked. Render and visually inspect the final
page for clipping, overlaps, orphan headings and legibility. Deliver the full PDF;
a Markdown hierarchy or an abbreviated checklist does not satisfy this request.


## Shared text policies in browser consumers

CEE/CEF and CED import `TextPolicy`, `IdentifierPolicy` and display helpers from the main
model package they already use, so a second policy bundle is not included. CETP imports the
lightweight `cedar-model-typescript-library/policy` entry. The legacy template editor copies
`policy.umd.js` and the full `index.umd.js` bundle from its pinned dependency with
`gulp copy:model`. It exposes them as the AMD modules `CedarValidationPolicy` and
`CedarModelTypescriptLibrary`, and loads the full bundle only when an author opens or copies a
YAML representation. The reactor inventories all of these model consumers in
`ops/frontend-train.json`.

The position-specific rules and corpus update procedure are in the backend runbook's
“Shared text and identifier contract”. Keep display grapheme counts separate from JSON Schema
code-point lengths. Searching and highlighting may derive folded text, while selection,
attribute keys, labels and identifiers retain the original strings. Manual input padding is
an explicit ASCII-only affordance; it is not a reader or writer normalization step.

CETP's `npm run test:unicode` loads the actual packaged UMD policies in Chromium, Firefox
and WebKit, under English and Turkish browser locales. Its normal CI gate includes this
check and installs all three engines. The model package gate also checks CJS, ESM, UMD and
TypeScript consumption of the lightweight entry and caps that bundle at 23 KB, including the shared finding/save-policy contract.

The 2026-10-18 Unicode adoption passed the full frontend reactor, consumer demos, local
redeployment, served-component verification and whole-stack smoke (source digest
`8c87abdf5e294c08`). REST smoke passed 2,076 checks with eight declared skips; the search tier
passed its implemented cases with its declared gaps. CED's browser gate ran 747 cases and
CEE's visual gate passed 1,035 with 104 existing skips. An independent rendered review covered
the fresh legacy designer, fresh CED, and ordinary CED editing; existing layout and controls
were retained. This evidence covers text-policy adoption, not later parser or numeric changes.


### Exact values and bounded validation in browser hosts

Workspace, the authenticated designer host, OpenView and Bridging use the lightweight policy entry
at their artifact HTTP boundaries. Workspace and the designer host also use it for saved drafts and
uncertain-save comparisons; an exact numeric atom is a scalar during comparison.
OpenView preserves it when cloning artifact previews. The designer host stages the pinned ESM policy
with a separate version/hash manifest in `app/components`; the legacy editor stages the UMD policy.
All direct consumers are recorded in `ops/frontend-train.json`, so the reactor supplies current model
sources and retained artifacts to them together. No registry publication is required for this loop.

CEE/CEF preserve exact input text for numeric values and CED preserves raw bound/default input until
it is valid. The shared decimal grammar is broader than CEE's established instance input grammar:
instance widgets still reject exponent spelling and redundant leading zeroes and count typed trailing
fractional zeroes toward decimal places. That compatibility rule is explicit. Datatype bounds and
comparison use exact decimal/integer operations. Invalid precision configuration is a template error;
it cannot construct an arbitrarily large browser regex.

Regex checks are asynchronous worker operations shared through `RegexChecks`. CEE, CEF and CED
report pending validation through their existing reports/events; hosts keep Save unavailable until
the current draft settles. Timeout, unavailable worker, invalid pattern and mismatch remain distinct.
Draft changes cancel obsolete checks, and the final result belongs only to the current state. No
permanent controls or new recovery panels are introduced. Validate normal unchanged screens as well
as failure paths, using the existing visual baselines and whole-stack journeys.

The backend runbook's shared policy section defines source parsing, explicit provenance timestamps,
regex semantics, exact-number ownership and offline replay. Run `cedarcli build java`, redeploy the
microservices, and run `cedarcli build frontends` for the complete consumer/package/browser/reactor,
served-bundle and whole-stack verification contract. Focused unit gates do not replace that final run.

### Instance quality and template consistency

The TypeScript model library's main entry exposes `FieldValuePolicy`, `TemplateValueValidator`, and
`InstanceValidator.validateReport`. The lightweight `/policy` entry also exposes `ValidationPolicy`
and the finding/report types. The common categories and JSON Pointer paths are defined in the backend
runbook's validation contract. Editor adapters supply field metadata and map locations into the
existing controls; hosts consume the resulting `blocksSave`, `canSave` and `structurallyValid` facts.
Legacy severity-only reports remain supported; modern Workspace also uses the common policy when a
legacy report omits severity.

The legacy Workbench removes its established `$$` transport bookkeeping at the exact-JSON boundary
before presenting an artifact to CEE. The host retains its original ETag for conditional writes;
genuine undeclared artifact properties remain visible to structural validation.

CEE/CEF report malformed structure as errors and well-formed constraint/completeness failures as
quality warnings. `isValid` remains stricter than `canSave`: an out-of-range answer can be saved while
its quality report is invalid. Required structural properties must exist even when an answer is empty.
Reading `currentMetadata` must not repair the live model or clear a structural finding. Validate loaded
and imported data before export completion, and clear a retained source defect only after its actual
node is corrected. Existing field diagnostics, report rows and host Save controls display the results.
CEE uses its existing amber styling for saveable constraint findings. Standalone CEF retains its
existing invalid-value styling because CED also uses it to edit template defaults; the host applies
the appropriate save policy to the common facts.

CED applies the template policy to defaults and definitions. It checks imported defaults as well as
interactive selections. Controlled-term verification submits the exact identifier and complete
version-aware constraints; label search is not membership evidence. Authority verification uses the
existing bridge authority routes. Async results belong to the current field, identifier and constraint
snapshot, so stale results cannot validate a later edit. Passed, failed, not checked and unavailable
checks remain distinct. Known failures block defaults. Unverified defaults permit saving with the
existing verification warning, consistently for interactive selection, loaded/imported definitions
and server writes. An unknown result never counts as successful verification.

Semantic evidence is cached by identifier and the complete constraint snapshot. Passed/failed results
expire after five minutes; unavailable/not-checked results expire after thirty seconds. A subsequent
validation or host report/save check refreshes expired evidence, without background polling or new
controls. Pending work is shared, and changing the field cancels obsolete work.

The full frontend reactor is the final gate for library, CEE/CEF, CED, legacy Workbench and modern
Workspace changes. Run their targeted suites first, then `cedarcli build frontends` after the Java
reactor and local backend redeployment. It verifies packages, applicable browser/visual gates, served
component bytes and whole-stack behavior. No new interface controls or visual baselines are implied
by adopting these validation facts.

CED's shipped-bundle ceilings are 1,550,000 bytes raw and 443,000 bytes gzip. The shared validation
integration measures 1,545,424 and 441,188 bytes respectively. This adds the common
default/configuration rules and document verification through the existing
model adapter, without another runtime dependency or a duplicate main/`policy` import.
The standalone host's initial JavaScript measures 1,530,588 bytes against a 1,535,000-byte
Angular budget; `npm run build:app` checks that separate entry point in CI.

CED document checks block while a semantic lookup is pending. A settled unavailable/not-checked
default is a warning (`valid: false`, `canSave: true`). Interactive controlled-term selection uses
the same shared template save policy; document checks retain the warning after selection and reload.
CEF authority edits also accept unknown-only results when all local problems are verification
findings. Structural defects and confirmed default constraint failures remain blocking.
