# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes.
How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); backend work, including what the two model
libraries still answer differently, is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **General appearance contract.** Extend the compact-control contract in CEE's
   `STYLING.md` with whole-component roles for brand, surface, text, muted and border.
   Keep Material internals private. A runtime role must reach every affected control
   and overlay through the M3 adapter, with browser tests setting a sentinel and checking
   rendered foregrounds, backgrounds and focus states. Define status-color invariants,
   derive related tints from the brand, and document only the properties those tests prove.

2. **Markup discoverability.** Make template authoring state or enforce what CEE will
   render. Align the Workspace rich-text editor's `Source` mode and CED's authoring
   surfaces with `template-markup-policy.ts`; warn when sanitization removes content
   instead of letting a preview silently lose it.

   Decide whether `TEMPLATE_MARKUP_POLICY` becomes public embedding API or remains
   internal with a supported description of the policy. Use that decision to keep editor
   configuration, tests and documentation in step. Account for rules beyond a tag and
   attribute allowlist, including forbidden event handlers and non-raster data images.
   Verify the authoring-to-CEE round trip with supported formatting and rejected markup.

3. **Consistent authority marks.** Decide whether all seven authority fields should use
   the organisations' genuine marks, then replace the approximations for ORCID, PFAS,
   NIH Grant and DOI and the raster PubMed/RRID assets with approved vector assets where
   available. Keep assets inline, preserve their accessible labels, and check appearance
   at field-icon size. ROR provides the existing inline-vector pattern. Record asset
   provenance and usage terms with the assets.

4. **RDF instance export.** Add an RDF serialization to the download contract, using a
   JSON-LD processor rather than a handwritten serializer. Decide first whether the
   output is N-Quads or Turtle and whether `downloadContentFor` becomes asynchronous or
   gains a separate asynchronous producer. Carry that decision through the menu,
   filename, media type, failure handling and harness tests.

   Install a document loader that rejects remote context fetches: exporting an instance
   must not introduce network access beyond CEE's embedding contract. Test type coercion,
   nested and repeated elements, attribute-value property IRIs and malformed contexts
   against a reference processor. Measure the production bundle with `check:size` before
   choosing dependencies; do not use old bundle-headroom estimates. Coordinate with the
   font-payload work if the added processor exceeds the packaging budget.

5. **Reduce embedded font payload.** Measure subsetting the Material Icons font to the
   ligatures CEE actually uses. Add a build guard that inventories template and descriptor
   ligatures and rejects a glyph absent from the shipped font; the menu glyph browser
   check alone does not cover every icon source.

   Separately decide which Roboto scripts the single-file bundle must carry. Inlining all
   seven unicode-range subsets at three weights ships every subset, even for a Latin-only
   form. Retain latin-ext for Hungarian; dropping other scripts requires an explicit
   fallback-font decision and multilingual rendering checks. Re-measure decoded and gzip
   savings on the current production bundle. Preserve namespaced font faces and the
   single-artifact embedding contract; serving fonts as extra files changes that contract.

6. **Complete host validation and save feedback.** Extend Workspace's validation display
   to render a rejected create/update's structured server `validationReport`, instead of
   routing it only through the generic backend-error presenter. Keep the document dirty,
   show the problems' paths and messages, and provide navigation to the affected field
   across pages and repeated elements where possible. Localize the host summary and
   missing-required-field messages.

   Establish which CEE findings predict REST rejection and which are advisory before
   changing Save behavior. Do not disable Save solely on CEE's `isValid`: the
   `requiredValue: true` / `minItems: 0` case in `harness/test/report-shape.spec.ts` is an
   explicit reason these verdicts can differ. Treat the server's response as authoritative
   when the validators disagree or the template changes between edit and save.

   Cover invalid-to-valid and valid-to-invalid transitions, advisory-only reports, rejected
   creates and updates, correction followed by a successful save, and differing client
   and server reports. Extend the existing Workspace controller tests with rendered host
   workflow checks rather than recreating its report subscription.

7. **Localize numeric and temporal validation.** Replace the numeric widget's
   `describeNumberType` sentence and the temporal widget's validator message / English
   required-value fallback with translation keys and parameters. Decide separately
   whether data-quality-report messages remain stable diagnostic text or are localized;
   preserve each problem's machine-readable `code`. Check Hungarian and English for
   required values, numeric type/precision failures and temporal errors, including
   language changes while an error is visible.

8. **Define handling of out-of-range stored UTC offsets.** Decide what to show and report
   when a host supplies offsets such as `-13:00` or `-13:45`, which
   `TimezonePickerComponent.zoneForOffset` accepts but the picker does not offer.
   Preserve the stored value until an explicit correction; rejecting it must not silently
   blank the control or rewrite the instance. Update the tests that currently document
   this leniency once the display and validation behavior is decided.
