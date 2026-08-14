# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes,
one line each. How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the two model libraries disagree is in
[MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md); backend work is in
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
4. **Appearance contract.** Keep Shadow DOM and CEE ownership of control geometry, layout,
   validation colours and Material internals; give embedders a small versioned API for
   `cedar`/`neutral` theme, `light`/`dark`/`auto` colour scheme and
   `comfortable`/`compact` density, with only a few advanced `--cee-*` overrides. Preserve
   the existing heading properties for compatibility, expose a font only if it can apply
   consistently to every control, deprecate the inert text-primary and accent properties,
   forbid arbitrary CSS and Material selectors, test every preset for contrast, focus,
   narrow layout and edit/read-only rendering, and report any unscoped `::ng-deep`.
5. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip.
6. **Temporal `required`.** Settle whether `InstanceValidator` should require `@type` on
   every temporal value, and fix the production temporal fields that declare no
   `temporalType` and so cannot be filled in at all.
7. **The screenshot budget still hides a small removal.** `maxDiffPixels: 120` is sized for
   a couple of glyphs' worth of rasterisation variance, which on one machine is zero; it
   was already tightened from a ratio after four changes in a day went green against a
   stale baseline. It is still enough to absorb a control disappearing — removing the
   preferences menu left `preset-chrome` depicting a trigger that no longer renders, and
   the suite passed. Decide whether the budget can go to zero, since the baselines are
   keyed to the platform and re-recording is already the stated answer to an OS font
   shift, or whether a budget survives only on the shots whose variance is real.
8. **Audit the configuration surface.** Fifty keys, and several are stranger than their
   names. The four prefixes do three unrelated jobs: `iriPrefix` mints IRIs into the
   instance, `bioPortalPrefix` builds a link out to BioPortal's web UI, and `orcidPrefix`
   and `rorPrefix` are value-recognition patterns interpolated raw into `new RegExp('^' +
   prefix)` — so the `.` in every URL matches any character and the check is looser than it
   reads. Seven authorities have endpoint keys but only two have prefixes. Two panel keys
   are on by default because CEE began as a developer tool. Decide for each key whether it
   is host API, developer chrome or a discriminator wearing a URL's name, then rename,
   scope or retire accordingly. `showTemplateYaml`, `showInstanceYaml` and their `expanded`
   partners are also missing from the documented panel table, which lists seven panels
   where the code renders nine.
9. **`showHeader` and `showFooter` name a position and deliver CEDAR's identity.** Both gate
   CEDAR's own chrome rather than the host's. `showHeader` renders a `mat-toolbar` carrying the
   CEDAR logo and the title "CEDAR Embeddable Editor"; `showFooter` renders the Stanford
   Division of Computational Medicine logo, the maintainer line, and a "Contact CEDAR" link
   pointing at `more.metadatacenter.org`. Every string and every destination is hardcoded, so
   an embedder can take CEDAR's branding or nothing, and the names do not say that.
   `showCedarHeader` and `showCedarFooter` would. Neither key covers the header an embedder is
   most likely to mean: the template card's own title block, holding the avatar, the version
   stamp, the template name, its description and the expand controls, renders whenever a
   template does and no key suppresses it. The sample-template picker is a child of the CEDAR
   toolbar, so `showSampleTemplateLinks` is inert while `showHeader` is false — one key
   silently governing another. Decide whether the pair is host API, developer chrome or
   something to retire, whether a host needs its own way to suppress the card's title block,
   and what an embedder that wants no CEDAR branding at all is supposed to set.
