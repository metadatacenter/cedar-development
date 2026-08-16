# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes.
How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); backend work, including what the two model
libraries still answer differently, is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **Scroll bug.** Scrolling past the end of a long form and back leaves the bottom of it
   blank, most likely in the Template Designer's nested scroll containers rather than in
   CEE.
2. **Keystrokes lost to the calendar's focus restore.** Material hands focus back to the
   toggle when the datepicker closes, and does it asynchronously, so a date picked and a
   time typed straight afterwards can land while focus is still moving: the box takes
   focus, loses it a moment later, and the characters reach nothing — no input event, so
   the picker is never told and the instance keeps the older time while the box looks
   filled. Reproduced under load in all three engines. Turning `restoreFocus` off gives up
   an accessibility behaviour, so the question is what replaces it. The browser suite waits
   for the restore rather than racing it, which keeps the suite honest but leaves the
   window open for a fast user.
3. **M3 theme adapter and palette.** Replace the M2 compatibility theme with M3 inside
   `_cee-material-theme.scss` as a deliberate visual migration, not a mechanical upgrade:
   choose the CEDAR and neutral palettes, preserve CEE-owned layout, typography, status,
   focus and accessibility invariants, use supported theme and component override mixins,
   review incidental Material-chrome diffs separately, and never expose `--mat-*` tokens as
   host API. Cut back the Material internal selectors made unnecessary by the adapter.
4. **Appearance contract, designed rather than accumulated.** CEE publishes nothing now:
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
5. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip.
6. **The authority marks are three different things pretending to be one.** ORCID, PFAS, NIH
   Grant and DOI are not those organisations' logos: they are approximations someone drew — an
   `iD` in a green circle, `NIH` in a navy box — inlined as SVG data URIs. PubMed and RRID are
   the real marks, but rasterised, and PubMed's is a JPEG, which is a lossy format with no
   transparency being used for a logo. ROR is the real mark as vector, and was the only one
   fetched over the network until it was inlined. Decide whether CEE should carry the genuine
   marks for all seven — a trademark and asset-licensing question rather than a technical one,
   though nominative use of a registry's logo to label a field targeting that registry is the
   ordinary case — and if so, obtain them as vectors and inline them the way ROR now is.
7. **Type the config surface end to end, now that the audit is done.** Nine keys remain,
   from forty-odd: `terminologyBaseUrl` and `bridgeBaseUrl`, three language keys, and four
   booleans. `CeeConfig` is closed, so a misspelling is a compile error and the index
   signature that once carried fourteen authority overrides is gone with them. What is left
   is smaller than it was: `showTemplateDescription` is set by nobody and set to `false`
   explicitly by the two hosts that mention it, one of them because it renders the
   description in its own header — decided, for now, to keep.
