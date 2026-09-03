# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes.
How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); backend work, including what the two model
libraries still answer differently, is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **M3 theme adapter and palette.** Replace the M2 compatibility theme with M3 inside
   `_cee-material-theme.scss` as a deliberate visual migration, not a mechanical upgrade:
   choose the CEDAR and neutral palettes, preserve CEE-owned layout, typography, status,
   focus and accessibility invariants, use supported theme and component override mixins,
   review incidental Material-chrome diffs separately, and never expose `--mat-*` tokens as
   host API. Cut back the Material internal selectors made unnecessary by the adapter.
2. **Appearance contract, designed rather than accumulated.** CEE publishes nothing now:
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
3. **Markup discoverability.** Have the CEDAR workspace's template rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip. Three policies decide what survives, and none of them derives from
   another. CEE sanitizes with DOMPurify against an allowlist of 36 tags and 25 attributes,
   refuses `ng-*` and `on*` outright, and admits a `data:` image only as raster. The
   workspace's `rich-text-config-service.conf.json` gives CKEditor a toolbar, a height and a
   UI colour and no content filtering at all, so what constrains authoring is CKEditor's
   automatic ACF, derived from its own enabled plugin set. The workspace's legacy render path
   hands a plain string to `ng-bind-html`, which leaves the decision to `ngSanitize`. An
   author gets no signal from any of the three: nothing objects while they type, and the
   field goes blank in CEE.

   `TEMPLATE_MARKUP_POLICY` in `template-markup-policy.ts` is the obvious single source of
   truth, and nothing reads it — not the spec, which imports only `sanitizeTemplateMarkup`,
   and not the README, although its own comment claims both. So the first decision is whether
   it joins CEE's public API, letting the workspace configure itself from one declaration, or
   stays internal while the allowlist is duplicated in the workspace's JSON, where it will
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
   rich-text field as an empty box.
4. **The authority marks are three different things pretending to be one.** ORCID, PFAS, NIH
   Grant and DOI are not those organisations' logos: they are approximations someone drew — an
   `iD` in a green circle, `NIH` in a navy box — inlined as SVG data URIs. PubMed and RRID are
   the real marks, but rasterised, and PubMed's is a JPEG, which is a lossy format with no
   transparency being used for a logo. ROR is the real mark as vector, and was the only one
   fetched over the network until it was inlined. Decide whether CEE should carry the genuine
   marks for all seven — a trademark and asset-licensing question rather than a technical one,
   though nominative use of a registry's logo to label a field targeting that registry is the
   ordinary case — and if so, obtain them as vectors and inline them the way ROR now is.
5. **Offer the instance as RDF, which the editor CEE replaced already did.** The download menu
   holds seven views — the instance as JSON-LD and as YAML in both shapes, the template as JSON
   Schema and as YAML in both, and the data quality report — and no RDF. The legacy metadata
   editor in the CEDAR workspace has an RDF panel beside its JSON-LD and YAML ones, produced by
   `jsonld.toRDF(form, {format: 'application/nquads'})` in `create-instance.controller.js`, so a
   host that moves to CEE loses a serialization it had. That makes this parity rather than a new
   feature, and it is the argument for doing it at all: nobody has asked for Turtle, and someone
   did once ask for RDF.

   Use a library rather than writing a serializer. A CEDAR instance carries its `@context` inline,
   so the translation is mechanical, but the edge cases are not — `@type` coercion, the nested
   containers an element occurrence produces, and the property IRIs an attribute-value pair mints
   are exactly where a hand-rolled writer would quietly differ from every other JSON-LD consumer.
   `jsonld.js` is the reference implementation and is what the workspace already uses, which also
   means its output is the thing to diff against.

   Four costs to weigh before starting, in the order they will bite.

   **The download producer is synchronous, and a JSON-LD processor is not.** `downloadContentFor`
   returns a `string` from a pure function over a `DataContext`, and its comment says why: the
   harness can ask what a download holds without rendering anything, which is what keeps those
   assertions honest. `jsonld.toRDF` returns a promise. Either the producer becomes
   `Promise<string>` — changing every call site and every harness test that reads one — or the
   descriptor grows a second, asynchronous kind and the menu learns to await it. That decision is
   the whole shape of the change and should be taken first, not discovered.

   **The bundle has room, but not unlimited room.** 219,133 gzip bytes free against the 840,000
   limit, 1,459,465 raw against 3,600,000, measured 2026-08-18. `jsonld.js` pulls `rdf-canonize`
   behind it and is the largest single dependency anyone has proposed adding. Measure it against
   `check:size` before committing to it, and treat the gzip figure as the binding one.

   **A JSON-LD processor fetches remote contexts by default, and CEE must not.** The published
   security contract is that CEE contacts the servers a host configures and nothing else. CEDAR
   instances embed every term inline, so nothing needs fetching; a document loader that refuses
   every fetch must be installed explicitly rather than relied on to be unnecessary, and
   [Embedding Security](../../cedar-mkdocs/docs/cedar-embeddable-editor/security.md) gains a line
   either way.

   **Turtle and N-Quads are different answers.** A JSON-LD processor emits N-Quads natively, which
   is what the workspace shows under the label "RDF"; Turtle is what a person reads, and getting it
   means a second dependency such as N3's writer, or accepting N-Quads and naming the menu entry
   honestly. Decide which before the label, the `.ttl` or `.nq` extension and the `text/turtle` or
   `application/n-quads` media type are written into the descriptor.

6. **A quarter of what an embedder downloads is font payload, and most of those glyphs never
   render.** The shipped bundle measures 632,289 gzip bytes at `2.0.0-dev.20260820.7202334`:
   475,949 of code and 156,340 of inlined assets, the assets being 136,569 for two font families
   and about 19,800 for the authority marks. The code figure is unremarkable for what CEE is, one
   file carrying the Angular runtime, Material and the CDK, the model library and the YAML writer
   behind it, into a host that provides none of them. The asset figure is avoidable, and reducing
   it needs no architectural change, which is why this is worth considering before anything harder.

   Roboto is inlined as 21 faces: seven unicode-range subsets at each of three weights, 134,499
   decoded bytes. Inlining defeats what those ranges are for, since a browser fetches only the
   subsets a page's characters need while base64 in a script ships all seven whatever the page
   says. Material Icons is one face carrying the whole glyph set, 58,005 decoded bytes, against the
   thirteen ligatures CEE names across its templates and its download and field-type descriptors.

   Measured on the shipped file rather than estimated, so it need not be re-derived: removing the
   fifteen non-Latin Roboto faces leaves 553,053 gzip bytes and saves 79,236; subsetting the icon
   font to those thirteen glyphs as well leaves 498,325 and saves 133,964 altogether, a fifth of
   the download. Gzip headroom against the 840,000 limit would go from 207,711 to about 341,700.
   The same headroom bounds whether a JSON-LD processor can be afforded, so the RDF download and
   this item are worth deciding in that order.

   Two costs decide whether to take it, and only one of them is technical. Dropping Cyrillic, Greek
   and Vietnamese means a label in those scripts falls back to the host's system font, which is a
   decision about who CEDAR serves rather than a cleanup; Hungarian is unaffected, because `hu.json`
   needs latin-ext and that subset stays. Subsetting the icon font needs a guard, because an icon
   added later without regenerating the subset renders as a tofu box and nothing fails: a test that
   collects the ligatures named in the templates and the descriptors and rejects any the subset does
   not carry. The authority marks account for the rest of the asset figure, and converting the two
   rasterised ones to vectors would recover part of it as a side effect of settling what those marks
   should be.

   Two things not to do. Serving the fonts as sibling files would recover all 136,569 bytes and cost
   the single-artifact contract that the shadow-boundary isolation and the packaging step are built
   around. Angular and Material are the floor for a component that renders CEDAR forms without help
   from its host, and the remaining code-side candidates are smaller and harder: zoneless rendering
   is about 12,000 gzip bytes and a real migration, and lazy YAML needs the model library to expose
   its writers behind their own entry point, which only becomes cheap if the download path turns
   asynchronous for other reasons.

7. **Make validation actionable before REST refuses the write.** Invalid template instances no
   longer enter the repository through the artifact REST API. Since the persistence-boundary
   hardening in `release-2.9.2`, both create and update validate against the referenced template,
   return HTTP 400 with `INVALID_DATA`, `VALIDATION_ERROR` and the full `validationReport` when that
   validation fails, and do not store the submitted instance. The legacy `skip_validation` query
   parameter remains in the create signature for wire compatibility but is deliberately ignored;
   a regression test pins that it cannot admit an invalid instance. Any older invalid instance
   already in the store is a data-repair concern, not permission for the current UI to create
   another one.

   The remaining defect is the save experience. CEE already calculates `dataQualityReport` — its
   validity, required-field counts and path-addressed problems — and every model-changing `change`
   event carries that report with `validity`, `title` and `description`. The CEDAR workspace's
   listener ignores the event payload and uses the notification only to recompute dirty state.
   Its Save action copies `cee.currentMetadata` and calls create or update without a local
   validation decision. When REST refuses the request, Workspace hands the response to the generic
   backend-error presenter; there is no translation for these validation keys and the structured
   report is available only inside technical response detail. The person learns that the save
   failed after a round trip, but is not shown which field to fix.

   Define the host contract before choosing the button behavior. Prove over the shared instance
   corpus which CEE problems correspond to REST-invalid JSON Schema and which are advisory data
   quality findings; do not disable saving on a stronger client-side notion and silently turn a
   warning into a new server rule. For a state REST will reject, Workspace may disable Save or let
   the click open the same explanation, but it must present the summary, path and message, take the
   author to the affected field where possible, keep the document dirty, and make no claim that an
   invalid draft was stored. A server-side `validationReport` remains authoritative and must be
   rendered through the same presentation if the validators disagree or the template changes
   between edit and save.

   One advisory-only divergence is measured, so it need not be re-derived. A field declaring
   `requiredValue: true` under `minItems: 0` is reported unfilled by CEE when it holds no
   occurrences, while the canonical validator accepts the empty array the template's JSON Schema
   asks for, `requiredValue` being a `_valueConstraints` notion that validator does not enforce.
   Compatibility case 081 is that shape, and it is the only one of the 178 corpus, compatibility
   and HuBMAP fixtures where the two disagree. Disabling Save on `isValid` would therefore refuse
   a document REST would store, which is the failure this item exists to avoid.
   `harness/test/report-shape.spec.ts` pins the behavior.

   Pin the integration with host tests for invalid-to-valid and valid-to-invalid transitions,
   multiple problems across pages and repeated elements, an advisory-only report, a rejected create,
   a rejected update, correction followed by a successful save, and a deliberately divergent server
   report. The item is complete when validation is useful before the request and equally useful when
   the server is the first component to detect the problem.
8. **Move the translation boundary onto the Angular 22-supported line.** CEE deliberately remains
   on `@ngx-translate/core` 14 and `@ngx-translate/http-loader` 7 until this migration lands. Their
   open Angular peer ranges kept the framework march green without making either 2022-era package
   current. As measured 2026-08-26, the stable line is 18 for both packages; core 18 supports Angular
   18–22, TypeScript 6 and RxJS 7, which is CEE's stack, but upgrading it is an API migration rather
   than a lockfile refresh. It removes `TranslateModule`, `USE_STORE` and `USE_DEFAULT_LANG`, and
   replaces the default-language API CEE calls with the fallback-language API. Keep the two present
   major pins visible in `package.json` until the whole boundary can move in one change; do not let a
   framework bump or a broad dependency update imply that the compatibility was reviewed.

   Upgrade core to 18 and remove `@ngx-translate/http-loader` rather than carrying a second package
   for one GET. `FallbackTranslateLoader` already owns the configured prefix, tracing, error recovery
   and built-in maps; have it request `<prefix><language>.json` through `HttpClient` as a
   `TranslationMap`. Replace the root and child `TranslateModule` wiring with the v18 provider and
   standalone pipe/directive APIs, move `setDefaultLang` to `setFallbackLang`, and update the real-
   service tests without renaming CEE's public `defaultLanguage` and `fallbackLanguage` configuration
   keys — those describe CEE's selected and recovery languages and are not ngx-translate API names.

   The migration is complete only when the existing external-map success and unreachable-map fallback
   browser cases pass, two editors retain isolated language stores and prefixes, the built-in English
   and Hungarian maps still render, the source, harness and visual TypeScript programs plus the full
   lint/unit gates pass, and the production bundle remains under both size limits. Remove the pin
   paragraph when those checks are green on the new dependency; leaving it behind would turn this
   item into the same stale workaround it records.

9. **Reconcile the remaining CEE GitHub issue backlog with the product that now ships.**
   The August 2026 audit closed nineteen completed or superseded reports and left twelve open.
   Reproduce every item in the
   [open backlog](https://github.com/metadatacenter/cedar-embeddable-editor/issues) against the current
   stable CEE and classify it as current product work, an upstream terminology or host concern, a
   product decision, or obsolete history. Split mixed reports into independently verifiable issues,
   close superseded ones with the relevant implementation or test evidence, and move real work into
   this roadmap or the owning roadmap with an explicit acceptance test.

   Start with the cases the audit could not resolve from source alone: visually review
   [75](https://github.com/metadatacenter/cedar-embeddable-editor/issues/75) and
   [131](https://github.com/metadatacenter/cedar-embeddable-editor/issues/131); remeasure
   [15](https://github.com/metadatacenter/cedar-embeddable-editor/issues/15) and
   [125](https://github.com/metadatacenter/cedar-embeddable-editor/issues/125) against current builds
   and services; rerun an accessibility audit for
   [14](https://github.com/metadatacenter/cedar-embeddable-editor/issues/14); and split and reproduce
   [12](https://github.com/metadatacenter/cedar-embeddable-editor/issues/12). Keep
   [29](https://github.com/metadatacenter/cedar-embeddable-editor/issues/29) aligned with the
   validation and save-experience work already described above, and confirm the still-current UI and
   model gaps in [22](https://github.com/metadatacenter/cedar-embeddable-editor/issues/22),
   [28](https://github.com/metadatacenter/cedar-embeddable-editor/issues/28),
   [35](https://github.com/metadatacenter/cedar-embeddable-editor/issues/35),
   [36](https://github.com/metadatacenter/cedar-embeddable-editor/issues/36), and
   [99](https://github.com/metadatacenter/cedar-embeddable-editor/issues/99) before assigning
   priority. This item is complete when every open issue names an owning surface and has either a
   current reproduction or an explicit disposition, and GitHub and this roadmap no longer carry
   contradictory backlogs.

10. **Bring the widgets the read-write audit did not reach up to the same footing.**
    The September 2026 audit fixed thirteen defects in the code that presents and reads
    values, and every one of them sat in a layer no test stage was watching. Three stages
    now divide that work explicitly — see "Which stage sees a widget defect" in the
    [runbook](CEE-RUNBOOK.md) — and two table-driven specs state the invariants the widget
    family shares. What is left is the widgets those tables do not yet reach.

    The six external authority subclasses run no specs of their own; their behaviour lives in
    `AbstractAuthorityInputComponent`, which sits at 46% statements and 15% branches, and the
    blur-reconciliation rules that decide whether typed text is discarded are the densest
    untested logic left in the editor. The time picker's segment editing — the draft/blur/
    restore cycle, and arrow stepping — is at 36%. Both are reachable from the root unit
    suite as it stands; neither needs a new tier.

    The audit covered read-write behaviour only. It did not examine the read-only presentation
    path, the download menu, the source panel, or the static widgets, and drew no conclusions
    about them.
