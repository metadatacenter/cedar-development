# CEDAR Embeddable Editor (CEE) — Roadmap

Outstanding work for `cedar-embeddable-editor`. Model-library work belongs in
[TS-MODEL-LIBRARY-ROADMAP.md](./TS-MODEL-LIBRARY-ROADMAP.md); backend and
cross-service work in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md); build
and test instructions in [CEE-RUNBOOK.md](./CEE-RUNBOOK.md).

This roadmap tracks open work only. Item numbers are stable handles, not commit
labels.

> **Commit-message rule:** Never refer to phases or phase numbers in commit or
> check-in messages. Describe the concrete change and affected surface.

## Current position

- CEE is on Angular 14.3, TypeScript 4.8 and RxJS 6.6.
- The package is currently
  `1.6.0-dev.20260804.85b7ccf` on `cee-with-model-library`.
- The model dependency is the Nexus-only prerelease
  `@org.metadatacenter/cedar-model-typescript-library@0.9.2-dev.20260805.4105f7c`.
  That build carries `InstanceValidator`, so item 7 is no longer blocked on the
  library having shipped — only on it having shipped *stably*.
- The safety net consists of 2,125 domain tests, 51 tests across seven focused
  Angular unit-spec files, and 325 bundle-level Playwright checks: 304 full
  Chromium checks plus seven smoke checks on each of Chromium, Firefox and WebKit.
- Nothing checks CEE's own instance output against its template. The `ajv` check
  that used to is gone, and its replacement is blocked — item 7.
- The obsolete datetime-picker dependency has been replaced by CEE's in-house
  time picker, so no dependency currently caps the Angular upgrade.

## Features

### 1. Give the custom element a typed and validated host contract

CEE currently exposes Angular component inputs directly through
`createCustomElement`. Public inputs are mostly `object` or `any`; configuration
uses private string keys; the npm package ships no declarations or runtime
schema.

Configuration reassignment also mixes replacement and patch behavior. Omitted
values can retain old parser, endpoint, prefix or language state, while output
serialization reads the replacement object. Read-only mode and empty-field
hiding can be enabled but not cleanly disabled.

Deliver:

- Export `CeeConfig`, `CeeEventHandler`, `CeeTemplateAndInstance`, output and
  report types, and a `CedarEmbeddableEditorElement` interface.
- Publish TypeScript declarations and the machine-readable runtime schema with
  the npm package.
- Validate and normalize values crossing the custom-element boundary; report
  unknown keys, wrong types and invalid combinations to the host.
- Define configuration assignment as either initialization-only or dynamic.
  If dynamic, use complete replacement semantics and apply changes atomically.
- Define the lifecycle, reversibility and reset behavior of every setting.
- Define precedence and clearing semantics for the three artifact-input paths.

Done when applying configuration B after A is externally equivalent to creating
a fresh editor with B. The browser harness must cover invalid configuration,
omitted defaults, reversible read-only and empty-field behavior, JSON/YAML
transitions, endpoint/prefix/language resets and artifact assignment order.

Complete this before declaring `1.6.0` stable.

### 8. Fix and modernize the datetime field

The date/time/timezone control needs work on three fronts, from the cheap near-term fix
to the deeper rework the Angular upgrade unlocks.

The immediate one is layout. The widget renders with spacing or alignment that looks wrong
next to the other input types. Not a data defect — the value is read and written correctly
(`cedar-input-datetime`, and the temporal value now carries its `@type`) — but a visual one.
Reproduce against the running editor, identify whether it is the component's own
template/styles or how the surrounding field row wraps the three sub-controls, and bring it
into line with the other fields.

The deeper rework waits on the framework. Angular Material 19 added an official `MatTimepicker`
that can share a value with `MatDatepicker`, use locale-driven 12/24-hour display, parse
seconds, and generate options at second intervals. Once the Angular 14→22 upgrade (item 2)
lands, prototype replacing only the in-house `app-time-picker` with it. Do not replace the
CEDAR-level temporal wrapper: Material still does not provide year/month-only values, decimal
seconds, a timezone selector, or CEDAR's XSD serialization and granularity rules (the "Out of
scope" note below). Keep the custom control if matching those rules through Material formats
and options is more complex or less usable than the small component already owned here.

Treat the timezone selector as a separate design correction. It currently offers city-labelled
"timezones" but stores only fixed offsets such as `-08:00`; it also guesses an IANA browser zone
and immediately reduces it to the offset *now*, which can be wrong for the selected date across a
DST boundary. Decide which value the field means. If it means an XSD offset, label choices
neutrally as `UTC−08:00` rather than Pacific Time and derive any default for the selected instant.
If it means a civil timezone, preserve an IANA identifier such as `America/Los_Angeles` separately
and derive the applicable offset from the selected date and time, including ambiguous and
nonexistent DST times. While touching the component, remove the duplicate `valueChanges`
subscriptions in `ngOnInit` and `ngAfterViewInit`, which currently propagate each selection twice.

## Infrastructure

### 2. Upgrade Angular 14 to Angular 22

Run the official migrations one major version at a time and keep the build and
test gates green after every migration. Do not combine this with a standalone
component, signals or control-flow rewrite.

Known work:

- Migrate Angular Material to MDC and repair selectors that depend on Material
  internals.
- Upgrade RxJS, TypeScript, `@ngx-translate`, `@ng-select/ng-select` and
  `ngx-mat-select-search` at their compatible Angular versions.
- Replace obsolete `entryComponents` configuration.
- Adapt the production concatenated-bundle step and Playwright preparation when
  the Angular build pipeline changes.
- Migrate the two custom Material themes to the supported Material 3 APIs.
- Retire the obsolete `e2e/` Protractor project: delete it and its configuration
  and npm command. The five focused Angular unit-spec files remain — they cover
  component configuration and instance-isolation behaviour not redundant with the
  domain or browser suites.

Done when a clean checkout builds the production custom-element bundle, all unit,
domain and browser tests pass on Angular 22, and no Protractor dependency,
configuration or script remains.

## Testing

### 4. Repair and enforce Angular ESLint

`npm run lint` cannot currently start because the Angular ESLint builder is
missing. Adding the Angular 14-compatible builder exposes a baseline of 184
errors, including Angular templates parsed with the TypeScript parser.

Configure Angular ESLint at the Angular 22 target with separate TypeScript and
template overrides. Resolve the baseline without broad suppressions, then add
`npm run lint` to `test:ci`.

Done when lint succeeds from a clean checkout and new TypeScript or template
violations fail CI.

### 7. Land the instance-conformance spec

CEE used to check its own output against each template with `ajv`, which meant
carrying a second validator and restating rules CEDAR already defines. That was
removed. The model library now answers the question through
`InstanceValidator.validate` — so until the library ships, **nothing catches a
dropped `@type` or a missing property in CEE's output**.

The spec is written and proven: 117 tests, taking the domain suite from 2,125 to
2,242. It is parked at `harness/test/instance-conformance.spec.ts.pending`
because it cannot run against the published library. Rename it to `.ts` once the
dependency in `package.json` and `harness/package.json` moves off the prerelease.

Blocked on [TS-MODEL-LIBRARY-ROADMAP.md](./TS-MODEL-LIBRARY-ROADMAP.md) item 1.

Done when the spec runs in `test:ci` against a published library version and CEE
output that drops a required key fails the suite.

## Security

### 6. Define and enforce the trust boundary for template-authored rich text

Instance-authored HTML is sanitized, but template-authored static rich text is
rendered through `bypassSecurityTrustHtml` in `keep-html.pipe.ts`. This is safe
only when the embedding application treats template authors as trusted to run
content in the host application's origin. An embedder that lets arbitrary users
supply templates turns static rich text into an XSS path. The source documents
this boundary, but the public README does not.

Deliver:

- Add an embedding-security section to the README that identifies templates as
  trusted input, explains that Shadow DOM is not a security boundary, and tells
  hosts not to load arbitrary templates under the current behavior.
- Inventory the rich-text markup emitted by the CEDAR Template Editor and define
  the minimum supported allowlist for elements, attributes, URL schemes, inline
  styles and embedded media.
- Decide and document the product contract: either require trusted templates
  explicitly, or sanitize template rich text with a policy that preserves the
  supported formatting while removing executable content.
- If trusted rendering remains available, make it an explicit host policy rather
  than an undocumented consequence of loading a template.
- Add browser tests using malicious template rich text, including event-handler
  attributes and executable URLs, alongside regression fixtures for supported
  formatting.

Done when the README states the trust requirement, the runtime behavior matches
the documented policy, executable template content cannot cross that policy
silently, and tests prove both the security boundary and formatting compatibility.

## Delivery order

1. Land the conformance spec as soon as the library publishes (item 7). It is
   written and waiting, and until it runs CEE has no check on its own output.
2. Start the Angular upgrade, including retiring the obsolete Protractor project
   (item 2).
3. Establish linting at the Angular 22 target before closing the upgrade
   (item 4).
4. Keep the production bundle and Playwright checks working throughout.
5. Complete the public host contract before the stable `1.6.0` release (item 1);
   the stable model-library release lands as an aside of that work.
6. Define and enforce the template-rich-text trust contract before allowing
   untrusted users to supply templates (item 6).

## Out of scope

- Rewriting CEE around standalone components, signals or new template control
  flow solely because the upgraded Angular version supports them.
- Replacing CEE's temporal wrapper with Angular Material's time picker; Material
  still does not cover CEDAR's granularity, decimal-second and timezone rules.
- Backend or cross-service work tracked by the backend roadmap.
- Model-library defects and its release, tracked by
  [TS-MODEL-LIBRARY-ROADMAP.md](./TS-MODEL-LIBRARY-ROADMAP.md). CEE consumes the
  published package; it does not carry fixes for it.
