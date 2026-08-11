# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and the TypeScript model library it consumes,
one line each. How to build, test and release is in
[CEE-RUNBOOK.md](./CEE-RUNBOOK.md); where the two model libraries disagree is in
[MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md); backend work is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The reasoning behind an item is in the
commit that opened it.

1. **Host contract.** Settle whether reassigning `config` replaces or patches, whether
   `readOnlyMode` and `hideEmptyFields` can be turned back off, and which of the three
   artifact inputs wins, before declaring `1.6.0` stable.
2. **Distribution.** Decide where CEE is published, since the eight embedding manifests
   name an unscoped npmjs package the tooling cannot produce and no consumer can install
   what the frontends serve.
3. **Elements and fields.** Decide whether CEDAR stores element and field instances at
   all, which determines whether CEE accepts all three schema artifacts under renamed
   kind-agnostic inputs or documents the element path as rendering-only.
4. **Scroll bug.** Scrolling past the end of a long form and back leaves the bottom of it
   blank, most likely in the Template Designer's nested scroll containers rather than in
   CEE.
5. **Palette.** Choose a brand colour, which means migrating the theme to M3 and cutting
   back the eighteen Material internal selectors that exist only because M2 offers no
   supported way to restyle a component.
6. **Appearance contract.** Decide the type scale's status, which is gated on item 5, and
   add a check that reports an unscoped `::ng-deep`.
7. **Two untested config flags.** `showAllMultiInstanceValues` needs one instance file for
   `17-real-flat`; `showStaticText` needs a decision on whether it is dead configuration.
8. **Markup discoverability.** Have the Template Designer's rich-text editor declare or
   enforce what an embedder will actually render, since its `Source` button accepts markup
   CEE will strip.
9. **Temporal `required`.** Settle whether `InstanceValidator` should require `@type` on
   every temporal value, and fix the production temporal fields that declare no
   `temporalType` and so cannot be filled in at all.

## Order

Item 1 gates stable `1.6.0`, and item 3 follows it because the input rename is the same
breaking change. Item 8 is Template Designer work and waits on nothing here. Item 6's
type scale waits on item 5; its `::ng-deep` guard waits on nothing. Items 2, 4, 7 and 9
are independent, and item 9 blocks no release.

## Out of scope

- Rewriting CEE around standalone components, signals or new control flow just because
  Angular supports them.
- Angular Material's time picker, which does not cover CEDAR's granularity,
  decimal-second and timezone rules.
- Backend and cross-service work.
- TypeScript/Java library divergence that reflects a CEDAR ambiguity rather than a defect
  on one side.
- Validation needing the template at instance-read time, which is `InstanceValidator`'s
  job rather than the reader's.
- Per-field value-node `required` arrays, which would add no check that
  `validateTypedValue` does not already make.
