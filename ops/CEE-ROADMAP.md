# CEDAR Embeddable Editor (CEE) — Roadmap

Open work for `cedar-embeddable-editor` and for the TypeScript model library it
consumes. Nothing settled is recorded here: what CEE is and how to build, test and
release it is in [CEE-RUNBOOK.md](./CEE-RUNBOOK.md), where the two model libraries
disagree is in [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md), and why a thing
was done the way it was is in the commit that did it.

Backend and cross-service work belongs in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

## Features

### 1. Settle the host contract's three open decisions

The package ships declarations for the element and its configuration, and a
configuration is checked at runtime where it crosses the boundary. What is left is
behaviour rather than description, and each answer breaks a host relying on today's:

- **Assignment semantics.** Reassigning `config` replaces for `outputSerialization`
  and patches for everything else, so an omitted key can retain old parser, endpoint,
  prefix or language state. Decide initialization-only or dynamic; if dynamic, replace
  completely and apply atomically.
- **Reversibility.** `readOnlyMode` and `hideEmptyFields` can be enabled and not
  cleanly disabled. Decide whether passing `false` turns them back off.
- **Artifact precedence.** Three inputs supply an artifact and nothing says which wins
  when two are set, or what clears one.

Normalizing configuration values waits on the first of these, because what a missing
key normalizes *to* depends on whether omitting one resets it.

One constraint bounds all three, and it is worth stating before anyone reaches for a
runtime schema: the bundle is an IIFE that registers a custom element and exports
nothing, so the declarations can carry types and never values. Publishing the key
names as constants, or a machine-readable schema, waits on the packaging question —
app bundle or library — which belongs to this item.

Done when applying configuration B after A is externally equivalent to creating a
fresh editor with B, with the browser harness covering invalid configuration, omitted
defaults, reversible read-only and empty-field behaviour, JSON/YAML transitions,
endpoint and language resets, and artifact assignment order.

Complete before declaring `1.6.0` stable.

### 2. Decide where CEE is distributed

The eight embedding manifests across six repos depend on the unscoped
`cedar-embeddable-editor@^1.5.2` from npmjs. Dev builds publish to Nexus as the
scoped `@org.metadatacenter/cedar-embeddable-editor`, which is a different package, so
a dev build reaches no consumer by installing. The frontends carry the current build
only because they symlink CEE's `dist-npm/` locally.

`scripts/npm-package.mjs` hardcodes the scoped name and takes its registry from the
root manifest's `publishConfig`, which points at Nexus, so no supported path produces
the unscoped package the consumers name. Closing the gap means either changing that
script or hand-assembling a package — a decision about where CEE is distributed rather
than a command to run.

Done when a consumer that runs `npm install` gets the build the frontends are serving.

### 3. Accept elements and fields, not only templates

CEDAR has three schema artifacts and CEE names one. Most of the work is already done
by accident: an element renders correctly today, because the parser takes an
`AbstractContainerArtifact` and a `TemplateElement` is one. A field renders an empty
form, since its `properties` holds its own value node rather than children, and
wrapping it in a synthetic one-child container is a few lines a host could do itself.

The blocking question is not CEE's. CEE emits `schema:isBasedOn` pointing at the
element, which makes the document a template instance based on something that is not a
template, and CEDAR has nowhere to put it: `CedarResourceType` lists `ELEMENT_INSTANCE`
with a null `@type` and a null id class, and no REST resource answers for it. Decide
whether CEDAR stores element and field instances at all. If it does not, this is a
rendering feature and should say so.

If it does, the inputs are renamed to the words both model libraries use, kind-agnostic
rather than one input per kind:

```js
cee.schemaArtifactObject = artifactJson;          // template, element, or field
cee.instanceArtifactObject = instanceJson;
cee.schemaAndInstanceObject = { schemaArtifact, instanceArtifact };
const doc = cee.currentInstanceArtifact;
```

Kind-agnostic because the artifact's `@type` already says the kind, so a key repeating
it is a second source of truth; because "which input wins" is undefined today and six
inputs make the undefined thing larger; and because a per-kind input advertises a kind
by name, which a field input cannot honestly do while a field root renders nothing.

**Likely 2.0.0.** The rename breaks every host compiling against the declarations, so
it travels with item 1 rather than arriving separately.

Done when the storage question is written down, and either CEE accepts all three kinds
with the renamed inputs and a host can round-trip what it gets back, or the element
path is documented as rendering-only and the field path is closed off deliberately.

## Infrastructure

### 4. The Metadata Editor scroll bug

Scrolling past the end of the form and back makes the bottom of it disappear. The only
open item that costs a user something they can see, and the only one needing a browser
and a reproduction rather than a decision.

It reproduces on Angular 14, so no upgrade caused it and none fixed it. The suspects
are the two nested `height: 100%; overflow-y: auto` containers in
`create-instance.html`, which is in the **Template Designer** rather than CEE — so the
fix probably lands in `cedar-template-editor` even though the symptom is CEE's form.
Confirm which container clips before touching either.

Done when the bottom of a long form survives a scroll to the end and back, in the
Template Designer and in the standalone harness, with a regression test at whichever
layer owns the containers.

### 5. Choose a palette, which means moving to M3

CEE does not render CEDAR's brand. `_cee-tokens.scss` specifies `$cee-brand-primary`
and `$cee-brand-accent` and applies them to nothing but three custom properties; what
ships is Angular's stock teal 600, which accounts for 35 of the colour values in the
bundle, while CEDAR's own #0f7686 appears twice and never inside the theme. Every
build shipping stock teal answers the brand question by default.

The colour and the theme model are one question. The supported way to produce an M3
palette is `ng generate @angular/material:theme-color`, which derives the full set from
source hex colours — so its input *is* the brand decision. M2 offers no such route: its
palettes are hand-authored 50–900 plus A100–A700 with a contrast map, and
`mat.define-theme` then rejects the result outright (`Expected $config.color.primary to
be a valid M3 palette`). The two shapes are not convertible, so any brand palette
authored in M2 is written twice.

Nothing forces the timing. The M2 helpers carry no deprecation marker in Material 22
and are still forwarded from `core/m2`, so the pressure is drift rather than a removal
date. Material 22 offers no `mat.theme()` one-liner either; the route is
`mat.define-theme` feeding the `mat.all-component-themes` already in use, so the
emission points survive.

**Reducing what CEE reaches into is the same job, not a neighbouring one.** Eighteen
distinct `.mat-*` and `.mdc-*` selectors across ten stylesheets, plus fifteen
`!important` declarations in `styles-own.scss` alone, each a bet that Material's
internal DOM will not move. The upgrades collected the receipts: the form-field infix
had to be rewritten for MDC when height moved from padding to `min-height`. They exist
because M2 offers no supported way to change a component's appearance beyond the
palette, and M3's tokens are the sanctioned replacement — so migrating without reducing
them carries the bets forward onto a DOM that has just moved again.

The rule for deciding which to keep: take Material for behaviour — focus management,
overlay positioning, keyboard interaction, the accessibility work that is expensive to
reproduce — and let `_cee-tokens.scss` decide appearance. A selector reached into for a
colour, a font or a spacing should become a token; one reached into to correct a layout
Material computes is worth keeping deliberately.

Done when the palette carries a colour someone chose, the theme is built on
`mat.define-theme`, and the count of Material internals CEE depends on has gone down.

### 6. Finish the appearance contract

Two pieces, one gated and one not.

**The type scale**, which is gated on item 5. It is compiled in, and an application
wanting 16px body text has no route to it. Publishing `--cee-font-size` sounds like a
small favour and is not: the bundle emits **zero** Material token custom properties,
because M2's `all-component-themes` writes px literals. A custom property would move
CEE's own text and leave Material's controls behind — the label-at-14px,
value-at-16px defect, reintroduced from outside and on purpose. The same applies to
`--cee-color-primary` reaching the form's controls. So in M2 the answer is no and the
published appearance page says so; after M3, whose tokens *are* custom properties, the
answer can be yes and costs little.

**A guard on unscoped `::ng-deep`**, which is independent and can land at any time. A
`::ng-deep` with nothing before it is emitted with no scoping attribute, and because
component styles are injected on first instantiation, such a rule appears only once
some template happens to contain the component that carries it. That is how field
height came to depend on whether a template had a timezone-enabled temporal field.
Nine `::ng-deep` selectors remain, each scoped only by convention, and nothing reports
a new one that is not. `visual/tests/material-selectors.spec.ts` already parses the
stylesheets for Material internals, so the check belongs there rather than in a new
harness.

Done when the type scale's status is decided rather than implicit, and a check reports
an unscoped `::ng-deep`.

### 7. Reach the two config flags nothing exercises

The browser suite asserts that every config key changes what renders, because a key
that is silently ignored looks exactly like one that works. Two gate on a second
condition no fixture produces. Both are `test.fixme` with the condition named.

**`showAllMultiInstanceValues`** draws the "All values" summary above a paged field,
and the summary is empty unless the paged component is a field with values in it. The
template side exists — `17-real-flat` pages two fields — but all three companion
instances belong to element-paged templates. One instance file for `17-real-flat`
reaches it.

**`showStaticText`** needs a decision before a fixture. It governs only static content
that `collapseStaticFieldsIntoNextFieldOrElement` has folded into a field, which
happens when `collapseStaticComponents` is on, the static is odd — consecutive statics
are paired and left alone — and it sits immediately before a field. Every static run in
the corpus is a pair, so nothing is ever folded. Establish whether the Template
Designer can author a lone static before a field at all: if it cannot, this is dead
configuration reachable only by hand-written JSON, and the answer is to remove the key.
Either way the name is worth revisiting, since a host would reasonably expect it to
hide all static content, and that belongs with item 1.

Done when each flag either has a fixture that reaches it and a passing assertion, or is
removed with the reason recorded.

## Security

### 8. Tell a template author what their markup will do

The trust boundary is drawn, enforced and tested: rich text is sanitized unless the
host sets `trustTemplateMarkup`, and the strings that are not rich text reach the page
as text or as checked URLs. What remains is on the authoring side, and it is a change
to the Template Designer rather than to CEE.

The rich-text editor has a `Source` button, so an author can type any markup at all and
get no indication that some of it will not render for an embedder. The editor should
say what survives, or refuse what will not. CKEditor 4's `allowedContent` filter is
declared in `rich-text-config-service.conf.json` and applies on paste and on leaving
source mode, so this needs no new interface on either side.

It does mean a second copy of the allowlist. CEE's bundle exports nothing at runtime,
so the Designer cannot read `TEMPLATE_MARKUP_POLICY` from it, and the Designer is
AngularJS on RequireJS with CKEditor as a global, which would need the list translated
on arrival in any case.

Done when a template author is told what their markup will do.

## Model library

Work on `cedar-model-typescript-library` itself. CEE consumes the published package
and carries no fixes for it.

The stable release is not tracked here. One judgement rides along with it whenever it
goes out: whether the version is `0.10.0` rather than `0.9.x`, since `wasSuccessful()`
on an instance parse could only ever return true before and can now return false, and
`adheresToBlueprint()` has stopped being a second name for it.

### 9. Settle the temporal `required` judgement, and the untyped fields under it

Two questions, and only the first is a judgement.

**The split.** 28 templates require `@type` on a temporal value, 27 do not, and 12
require nothing. The blueprint comparison does not check field-level `required`, so it
flags none of them, and `InstanceValidator` requires `@type` always — stricter than
roughly half the corpus, on the grounds that a field declaring a `temporalType` has a
typed literal for a value. That was a judgement and should be an explicit one; it needs
someone who knows CEDAR's version history. The split is also not stable, which was not
known when the judgement was made: `JsonFieldWriterTemporal.expandRequiredNode` writes
`required: ["@value", "@type"]` unconditionally, so the library moves the corpus onto
the strict side as it rewrites it.

**The untyped fields**, which is a defect rather than a judgement. Production carries
temporal fields declaring no `temporalType` at all, with `_valueConstraints` absent,
empty, or holding only `requiredValue`. No test artifact does, which is why nothing
caught it. Such a field is inert in CEE: `CedarTemporalValue.parse` and `serialize`
both branch on the three `xsd` types and return null otherwise, so it can neither show
a stored value nor produce one, and where the same template requires `@type` the
instance cannot be saved. Nothing warns, because `TemporalType.forValue` answers NULL
for an absent value and a misspelled one alike.

Neither question can be answered from the corpus, because production is where the
untyped fields are. Both need a walk over every template, element and field a key can
see on a server, reporting what each temporal field declares, what it requires, and
what the untyped ones carry instead — and counting a template once, or once per
version, changes the answer. Settle the count of fields that require a type and declare
none before the rest: those are broken, where the others are merely lax.

Neither blocks the release.

## Delivery order

1. Keep the production bundle and the browser suite passing throughout.
2. Settle the host contract (item 1) before the stable `1.6.0` release. The stable
   model-library release lands as an aside of that work.
3. Tell template authors what their markup will do (item 8), which is Template Designer
   work and waits on nothing here.
4. Decide the distribution question (item 2) before promising any consumer a release it
   can install.

The kinds beyond templates (item 3) come after stable `1.6.0`. What a host notices is
the rename, and spending a major version on it before the contract's own decisions are
settled buys half an answer. It also waits on something that is not CEE's to decide.

The palette (item 5) is a decision rather than a dependency and nothing else waits on
it, except the type scale in item 6, which follows it because M2 emits no component
tokens for a property to override. The `::ng-deep` guard in that item is independent of
both.

## Out of scope

- Rewriting CEE around standalone components, signals or new template control flow
  solely because the upgraded Angular version supports them.
- Replacing CEE's temporal wrapper with Angular Material's time picker; Material still
  does not cover CEDAR's granularity, decimal-second and timezone rules.
- Backend or cross-service work tracked by the backend roadmap.
- Reconciling the TypeScript library with the Java one beyond what
  [MODEL-LIBRARY-PARITY.md](./MODEL-LIBRARY-PARITY.md) records as a defect on one side.
  Divergence reflecting a genuine CEDAR ambiguity is a corpus question, not a library
  one.
- Validating anything that needs the template at instance-read time. The reader's
  contract is that it reads an instance alone; `InstanceValidator` is where the
  template-aware checks live.
- Widening instance validation to each field's own value-node `required` array. Nearly
  all of what it would add is covered: `validateTypedValue` enforces the
  `["@value", "@type"]` that numeric fields declare, the `@id`-valued kinds declare no
  `required` at all, and the temporal fields declaring less are the split above, where
  `InstanceValidator` is already the stricter of the two. The residue is a literal node
  omitting `@value`, which is `{}` — one of the spellings of an unfilled slot, and
  empty by policy. Revisit only if a consumer asks.
