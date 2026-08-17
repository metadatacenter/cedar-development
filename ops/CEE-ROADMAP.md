# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes.
How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); backend work, including what the two model
libraries still answer differently, is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **Keystrokes lost after using the calendar — and the mechanism this item named is not it.**
   The symptom stands: a date picked and a time typed straight afterwards can lose the
   characters, reported under load in all three engines. The explanation did not survive being
   measured.

   The reading was that Material takes focus back when the datepicker closes and does it
   unconditionally. Half of that is true and worth reporting upstream: `close()` guards the
   restore with `activeElement === this._document.activeElement`, comparing a variable to the
   expression assigned to it one line earlier, so the condition collapses to `restoreFocus` and
   the guard never guards. It is unchanged in 22.1.2, the latest published, and on `main`.

   It cannot reach CEE, though. `_focusedElementBeforeOpen` is captured from
   `document.activeElement`, which stops at the shadow host: measured in the harness, Material
   captures `CEDAR-EMBEDDABLE-EDITOR` and calls `focus()` on it, which does nothing to the focus
   inside the shadow root. The restore is inert here. Three attempts to race it — `fill`, real
   keystrokes, and a synchronous `focus()` during the closing animation — all pass with the
   datepicker's own restore both on and off, which is what a test says when there is nothing to
   catch.

   So the next step is to find what actually loses the keystrokes rather than to fix this. One
   observation to start from, found while instrumenting: typing digits into the hour box of
   `_decimal_seconds` yields `00` with no calendar involved at all, while the same typing on
   `_to_the_minute` gives `09` correctly. That is a temporal-widget question, not a focus one.

   A patch was written against the old reading — `[restoreFocus]="false"` plus a shadow-aware
   guard of our own — and reverted, because it changed behaviour to fix nothing observable and
   the test written for it could not fail.

2. **M3 theme adapter and palette.** Replace the M2 compatibility theme with M3 inside
   `_cee-material-theme.scss` as a deliberate visual migration, not a mechanical upgrade:
   choose the CEDAR and neutral palettes, preserve CEE-owned layout, typography, status,
   focus and accessibility invariants, use supported theme and component override mixins,
   review incidental Material-chrome diffs separately, and never expose `--mat-*` tokens as
   host API. Cut back the Material internal selectors made unnecessary by the adapter.
3. **Appearance contract, designed rather than accumulated.** CEE publishes nothing now:
   the eight `--cee-*` custom properties are gone, two having been read nowhere and the five
   colours never having reached a Material component, since `_cee-material-theme.scss` is
   compiled from Sass and carries no `var(--cee-…)`. No embedder had set any of them. What
   replaces them is a decision about roles, not a list: name what CEE's interface actually
   has — brand, surface, text, muted, border, and the status colours whose meaning a host
   must not be able to re-point — derive the rest with `color-mix` so a re-pointed brand
   drags its tints along, and keep geometry, density and Material internals CEE's own. Two
   things make it real rather than nominal: the Material theme has to read the properties,
   which is the M3 adapter's work and why these two land together; and the test has to set a
   role to a sentinel and assert it reaches rendered pixels, where the old one asserted only that a
   property was published, which an inert property passes just as well. Expose a font only
   if it can apply consistently to every control — today `$cee-font-family` threads through
   the Material typography config from one token, so it is the cheapest of these and still
   needs the pixel test. Every route re-baselines the visual suite; do the palette decision
   in [THEMING.md](../../cedar-embeddable-editor/THEMING.md) and the mechanism in one change.
4. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip. Three policies decide what survives, and none of them derives from
   another. CEE sanitizes with DOMPurify against an allowlist of 36 tags and 25 attributes,
   refuses `ng-*` and `on*` outright, and admits a `data:` image only as raster. The
   Designer's `rich-text-config-service.conf.json` gives CKEditor a toolbar, a height and a
   UI colour and no content filtering at all, so what constrains authoring is CKEditor's
   automatic ACF, derived from its own enabled plugin set. The Designer's legacy render path
   hands a plain string to `ng-bind-html`, which leaves the decision to `ngSanitize`. An
   author gets no signal from any of the three: nothing objects while they type, and the
   field goes blank in CEE.

   `TEMPLATE_MARKUP_POLICY` in `template-markup-policy.ts` is the obvious single source of
   truth, and nothing reads it — not the spec, which imports only `sanitizeTemplateMarkup`,
   and not the README, although its own comment claims both. So the first decision is whether
   it joins CEE's public API, letting the Designer configure itself from one declaration, or
   stays internal while the allowlist is duplicated in the Designer's JSON, where it will
   drift on the first edit to either side. Enforcing costs a mechanical translation of the
   allowlist into ACF rules plus `disallowedContent` approximations for the two rules ACF
   cannot express; declaring costs help text and a save-time warning and leaves the preview
   lying.

   Measured, so that it need not be re-derived: neither surface executes static content
   today. CEE keeps a payload's `<img>` and drops its `onerror`, confirmed by a probe that saw
   the broken image render with the handler never firing. The `$sce.trustAsHtml` in
   `schema.service.js` and `data-manipulation.service.js` is unreachable, because the only
   expressions that call it name `$root.getUnescapedContent` and nothing puts that function on
   `$rootScope`. The same dead expression leaves the legacy metadata editor rendering a static
   rich-text field as an empty box, tracked as a bug in
   [TEMPLATE-DESIGNER-ROADMAP.md](./TEMPLATE-DESIGNER-ROADMAP.md).
5. **The authority marks are three different things pretending to be one.** ORCID, PFAS, NIH
   Grant and DOI are not those organisations' logos: they are approximations someone drew — an
   `iD` in a green circle, `NIH` in a navy box — inlined as SVG data URIs. PubMed and RRID are
   the real marks, but rasterised, and PubMed's is a JPEG, which is a lossy format with no
   transparency being used for a logo. ROR is the real mark as vector, and was the only one
   fetched over the network until it was inlined. Decide whether CEE should carry the genuine
   marks for all seven — a trademark and asset-licensing question rather than a technical one,
   though nominative use of a registry's logo to label a field targeting that registry is the
   ordinary case — and if so, obtain them as vectors and inline them the way ROR now is.
