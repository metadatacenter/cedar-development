# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes,
one line each. How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the two model libraries disagree is in
[MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md); backend work is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **Distribution.** Decide where CEE is published, since the eight embedding manifests
   name an unscoped npmjs package the tooling cannot produce and no consumer can install
   what the frontends serve.
2. **Wiring into OpenView and the Template Designer.** A new build reaches either host only
   through the symlink into `dist-npm/`, a copy step run by hand — `gulp copy:cee` for the
   Template Designer, the Angular asset copy for OpenView — a cleared build cache, and a
   sha256 comparison to prove which bytes are served. Give them a dependency that resolves
   the published package, so a release propagates by installing it; gated on item 1.
3. **Scroll bug.** Scrolling past the end of a long form and back leaves the bottom of it
   blank, most likely in the Template Designer's nested scroll containers rather than in
   CEE.
4. **Keystrokes lost to the calendar's focus restore.** Material hands focus back to the
   toggle when the datepicker closes, and does it asynchronously, so a date picked and a
   time typed straight afterwards can land while focus is still moving: the box takes
   focus, loses it a moment later, and the characters reach nothing — no input event, so
   the picker is never told and the instance keeps the older time while the box looks
   filled. Reproduced under load in all three engines. Turning `restoreFocus` off gives up
   an accessibility behaviour, so the question is what replaces it. The browser suite waits
   for the restore rather than racing it, which keeps the suite honest but leaves the
   window open for a fast user.
5. **M3 theme adapter and palette.** Replace the M2 compatibility theme with M3 inside
   `_cee-material-theme.scss` as a deliberate visual migration, not a mechanical upgrade:
   choose the CEDAR and neutral palettes, preserve CEE-owned layout, typography, status,
   focus and accessibility invariants, use supported theme and component override mixins,
   review incidental Material-chrome diffs separately, and never expose `--mat-*` tokens as
   host API. Cut back the Material internal selectors made unnecessary by the adapter.
6. **Appearance contract.** Keep Shadow DOM and CEE ownership of control geometry, layout,
   validation colours and Material internals; give embedders a small versioned API for
   `cedar`/`neutral` theme, `light`/`dark`/`auto` colour scheme and
   `comfortable`/`compact` density, with only a few advanced `--cee-*` overrides. Preserve
   the existing heading properties for compatibility, expose a font only if it can apply
   consistently to every control, deprecate the inert text-primary and accent properties,
   forbid arbitrary CSS and Material selectors, test every preset for contrast, focus,
   narrow layout and edit/read-only rendering, and report any unscoped `::ng-deep`.
7. **Two untested config flags.** `showAllMultiInstanceValues` needs one instance file for
   `17-real-flat`; `showStaticText` needs a decision on whether it is dead configuration.
8. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip.
9. **Temporal `required`.** Settle whether `InstanceValidator` should require `@type` on
   every temporal value, and fix the production temporal fields that declare no
   `temporalType` and so cannot be filled in at all.
10. **`hideEmptyFields` on the separate artifact inputs.** The key is honoured only when the
   template and the instance arrive on `templateAndInstanceObject`: the form is built when
   the template lands, and on the two-input route nothing has read the instance by then, so
   no field is known to be empty. Three of the six consumers use the two-input route, where
   the key silently does nothing. Asserted in the visual suite as it stands, and documented.
11. **The screenshot budget still hides a small removal.** `maxDiffPixels: 120` is sized for
   a couple of glyphs' worth of rasterisation variance, which on one machine is zero; it
   was already tightened from a ratio after four changes in a day went green against a
   stale baseline. It is still enough to absorb a control disappearing — removing the
   preferences menu left `preset-chrome` depicting a trigger that no longer renders, and
   the suite passed. Decide whether the budget can go to zero, since the baselines are
   keyed to the platform and re-recording is already the stated answer to an OS font
   shift, or whether a budget survives only on the shots whose variance is real.
