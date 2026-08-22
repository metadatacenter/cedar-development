# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes.
How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); backend work, including what the two model
libraries still answer differently, is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

The August 2026 structural hardening pass is complete. Host artifact intake now has
one transactional owner, configuration is a separate collaborator, and the inner
editor only renders an already-built model state. Model-to-widget synchronization is
pinned across editable/read-only literal, numeric, temporal, link, authority,
controlled-term and multi-value fields; page-break pagination is checked over every
generated boundary layout through six children. Shared widget subscriptions use
Angular destroy scopes, repeated editor construction/destruction is exercised, and
CI holds focused coverage floors for the artifact boundary, component registry and
page representation while running the browser suite in four shards. The numbered
items below are the remaining product work, not cleanup left by that pass. CEE's
host signal is now model-based as well: every real field or multi-instance mutation
publishes a structured `change` carrying its path and validation report, while DOM
traffic, paging and no-op writes do not. The CEDAR workspace compares the resulting
metadata with its last loaded or successfully saved baseline, so an edit marks dirty,
an exact revert clears it, and a save rebases it. Host and temporal behavior now have
dedicated specs over a typed browser driver: canonical initialization is silent,
storage-changing temporal normalization is explicit, and every runtime detail member
is pinned. Authority and
controlled-term debounce, overlay and hint work is destroy-scoped. The obsolete FooBar
style-order shim, unused RDF identity pipe, external ROR test route and pre-RxJS-7
Vitest dependency workaround are gone; the public custom-element declaration types its
`change` listener, and the never-emitted `eventHandler.message` is deprecated for the
next major release.

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

7. **Nothing stops an instance CEE already knows is invalid from being saved, and nothing tells the
   person saving it.** CEE works out what is wrong before any save happens. `dataQualityReport`
   carries `isValid`, how many required fields the template declares against how many the instance
   fills, and a `problems` list whose entries each name a code, a path, the field, its declared input
   type, a message and the offending value. The CEDAR workspace reads none of that
   when deciding whether to save.
   `saveInstance` in `create-instance.controller.js` takes `cee.currentMetadata` and posts it, and
   the only validation anybody sees arrives afterwards, from the server's `CEDAR-Validation-Status`
   response header. Even that arrives thin: the call passes the header alone while `logValidation`
   takes a report as its second argument, so the branch that would parse errors and warnings never
   runs, and what reaches the header indicator is a bare state.

   CEE now supplies the information at the right boundary: every model-changing `change` event
   carries `validity`, `dataQualityReport`, `title` and `description`. The CEDAR workspace currently
   uses that event only to recompute dirty state, so save behavior and validation presentation are
   still the open product decision here. OpenView also still has an `onFormChange` handler written
   for the editor CEE replaced; its template does not bind that handler to CEE, so the newly restored
   event contract does not by itself revive OpenView's title, description or validity plumbing.

   Decide what saving an invalid instance should mean, which is a product question before a
   technical one. CEDAR stores instances its own server considers invalid, and an author part-way
   through a long form has a good reason to save one, so refusing the save is probably the wrong
   answer. Worth weighing instead: a save that names what is wrong and asks for confirmation, and a
   save that proceeds but reports from CEE's report rather than from the response header, since the
   report knows the path and the message while the header knows only that something failed. Either
   way the remaining fix is host behavior: CEE now supplies a validity signal at the moment of
   change, and the CEDAR workspace must decide how to present and act on it.
