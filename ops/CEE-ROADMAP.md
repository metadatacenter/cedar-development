# CEDAR Embeddable Editor (CEE) — Roadmap

Outstanding work for `cedar-embeddable-editor`. Backend and cross-service work
belongs in [DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md); build and test
instructions belong in [CEE-RUNBOOK.md](./CEE-RUNBOOK.md).

This roadmap tracks open work only. Item numbers are stable handles, not commit
labels.

> **Commit-message rule:** Never refer to phases or phase numbers in commit or
> check-in messages. Describe the concrete change and affected surface.

## Current position

- CEE is on Angular 14.3, TypeScript 4.8 and RxJS 6.6.
- The package is currently
  `1.6.0-dev.20260804.85b7ccf` on `cee-with-model-library`.
- The model dependency is the Nexus-only prerelease
  `@org.metadatacenter/cedar-model-typescript-library@0.9.2-dev.20260804.f1a3784`.
- The safety net consists of 2,270 domain tests, five focused Angular unit-spec
  files and 325 bundle-level Playwright checks: 304 full Chromium checks plus
  seven smoke checks on each of Chromium, Firefox and WebKit.
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

Done when a clean checkout builds the production custom-element bundle and all
unit, domain and browser tests pass on Angular 22.

### 3. Replace the model-library prerelease with a stable release

Publish `@org.metadatacenter/cedar-model-typescript-library@0.9.2`, update the
root, `harness/` and `visual/` manifests together, and regenerate all three
lockfiles.

Decide whether the scoped package must also be published to npmjs.org. Keeping
it Nexus-only means an otherwise public CEE build depends on BMIR infrastructure
remaining anonymously reachable.

Done when clean installs use the stable version in all three package trees and
CI verifies that the manifests cannot drift.

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

### 5. Retire Protractor

Delete the obsolete `e2e/` Protractor project and remove its configuration and
npm command. The five focused Angular unit-spec files remain; they cover
component configuration and instance-isolation behavior that is not redundant
with the domain or browser suites.

Done when no Protractor dependency, configuration or script remains and the
unified test command is green.

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

1. Start the Angular upgrade (item 2).
2. Establish linting at the Angular 22 target before closing the upgrade
   (item 4).
3. Keep the production bundle and Playwright checks working throughout.
4. Complete the public host contract and stable model dependency before the
   stable `1.6.0` release (items 1 and 3).
5. Remove Protractor independently when convenient (item 5).
6. Define and enforce the template-rich-text trust contract before allowing
   untrusted users to supply templates (item 6).

## Out of scope

- Rewriting CEE around standalone components, signals or new template control
  flow solely because the upgraded Angular version supports them.
- Replacing CEE's temporal wrapper with Angular Material's time picker; Material
  still does not cover CEDAR's granularity, decimal-second and timezone rules.
- Backend or cross-service work tracked by the development roadmap.
