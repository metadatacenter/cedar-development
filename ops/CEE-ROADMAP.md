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
3. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
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
   editor in the Template Designer has an RDF panel beside its JSON-LD and YAML ones, produced by
   `jsonld.toRDF(form, {format: 'application/nquads'})` in `create-instance.controller.js`, so a
   host that moves to CEE loses a serialization it had. That makes this parity rather than a new
   feature, and it is the argument for doing it at all: nobody has asked for Turtle, and someone
   did once ask for RDF.

   Use a library rather than writing a serializer. A CEDAR instance carries its `@context` inline,
   so the translation is mechanical, but the edge cases are not — `@type` coercion, the nested
   containers an element occurrence produces, and the property IRIs an attribute-value pair mints
   are exactly where a hand-rolled writer would quietly differ from every other JSON-LD consumer.
   `jsonld.js` is the reference implementation and is what the Designer already uses, which also
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
   is what the Designer shows under the label "RDF"; Turtle is what a person reads, and getting it
   means a second dependency such as N3's writer, or accepting N-Quads and naming the menu entry
   honestly. Decide which before the label, the `.ttl` or `.nq` extension and the `text/turtle` or
   `application/n-quads` media type are written into the descriptor.

6. **A declared default reaches the form only when the field is an enumeration.** `_valueConstraints`
   may name a default on any field, and CEE seeds one into the empty instance it builds from a
   template only where the field carries choices: `DataObjectBuilderHandler` sets the empty slot for
   every field, then fills a value only inside `if (component?.choiceInfo?.choices?.length > 0)`. So a
   radio, checkbox or list arrives pre-selected, while a text, numeric, temporal or controlled-term
   default is read from the template, exposed on the model, rendered in the read-only specification —
   and never offered to somebody filling the form in, who has to type what the template already
   said. Decide whether seeding is the intended behaviour for the rest, then either seed them or say
   in the host documentation that CEE presents a non-enumerated default rather than applying it.

   Two things follow. The literal case is a one-line change (the branch above already knows the empty
   slot and the XSD type), but the controlled-term case is not: `getSingleValueWrapper` deliberately
   returns an empty slot for a controlled field, and a term default carries an IRI and a label that
   the instance has to record as a pair.

   The test harness cannot currently express either. Its four choice kinds — radio, checkbox, and the
   two list flavours — are built with no options at all, so no generated template has a default
   option to seed, and `view-sync.spec.ts` pins the clearing rule that read-only rendering depends on
   only from the other side: that a value pushed into a read-only form survives. Give `ChildSpec`
   options and a default, and the seeded path becomes testable in both modes.
