# CEDAR Embeddable Designer — Roadmap

Open work for `cedar-embeddable-designer` (CED), the Web Component for authoring
CEDAR templates. Running, building and packaging it is in
[DESIGNER-RUNBOOK.md](DESIGNER-RUNBOOK.md).

CED replaces the AngularJS Template Designer — `cedar-template-designer` holds
that designer's code, extracted from the `cedar-template-editor` monolith that
still serves it in production. Replacing it means being easier to use rather than
resembling it: the existing designer is cluttered and hard to work in, and
reproducing its interface would carry that forward. CED is delivered as three
tiered profiles — Basic, Semantic and Modular — each showing one audience what it
needs and hiding what it does not, and each building on the one before. CED also
does two things the old designer cannot: it embeds in any page, and it authors
constraints that name the ontology version an author chose, through
[`<cedar-term-picker>`](VERSIONING-ROADMAP.md).

Capability equivalence with the old designer is the bar for the three profiles
together, because a designer that authors most of a template is not a designer
anyone can switch to. It is deliberately not the bar for any one profile: the
Basic profile excludes everything that needs semantic-technology expertise, and
the Semantic profile everything modular. Once a control has to exist, which
profile shows it is the design question, and "put it on the card" is usually the
wrong answer to it.

## The First Goal, and the Order

Every field type CEDAR defines is already in CED's palette — 25 types, two more
than the 23 the current designer's own configuration declares in
`app/config/field-type-service.conf.json`. Completing the palette is not the work.
The support behind it is: a text field and a radio field carry what an author
gives them, and the rest either lack the parameters that make the type worth
choosing over a text box, or drop what the author enters.

**The first goal is complete coverage of the model library's field parameters,
reached one field type at a time.** A type is done when every setter on its
builder in `cedar-model-typescript-library`, and every field on its
value-constraints class, is reachable from the card, survives a write, a read and
a second write unchanged, and has a spec that says so. A type nobody has finished
is worse than a type nobody has added: the palette promises it works.

Everything else waits on that, and the order is a decision rather than a
grouping. What CED writes wrongly is settled before it is given more to write,
because two of those faults destroy an author's work and one of them stops a
template being written at all. Parameter coverage comes next, type by type.
Then the surface around the fields, then the rest, in roughly profile order:
version awareness is the Semantic profile's, and structure beyond a flat template
the Modular profile's.

One risk is worth naming rather than discovering. Parameter coverage adds a great
many controls, and adding them to one card is how the designer CED replaces
became cluttered. The profiles are the answer to that, and they are sequenced
after the coverage work, so each control added before then needs a decision about
where it eventually belongs — recorded with the control, not deferred to a
redesign.

Item numbers are for referring to items in conversation, and they are not stable
handles — an item that is finished leaves the document, and the rest are
renumbered. What was built is recorded in the commits that built it. Name an item
rather than its number.

## Stop Losing What the Author Enters

Three faults sit in the path from the card to the artifact. They come before every
parameter item, because the parameters are written through the same path, and
because a field type cannot be called complete while the values it already
collects are being dropped.

### 1. Checkbox and list options never reach the artifact

`buildOptions` in `cedar-template.ts` tries `addRadioOption` and then
`addOption`. The setter is `addCheckboxOption` on a checkbox builder and
`addListOption` on both list builders, and no builder has `addOption` — so for
three of the four option-bearing types the loop calls nothing and the field is
written with no `literals` key at all. The readers do parse `literals`, so
opening a template shows its checkbox and list options and saving it destroys
them.

The one spec that asserts options asserts them on a radio field, the single type
the code path works for. What replaces the search for a method should name the
setter per type in the descriptor table, alongside the rest of the per-type
differences.

### 2. Every default value is typed as a string

Editor state holds one `defaultValue: string` for all 25 types and hands it to
whichever `withDefaultValue` the builder happens to have. A numeric field's takes
a number and validates it, so a Number field with a default fails with `Numeric
default must be finite.` The throw surfaces from the memoized `template` signal,
which means the JSON panel, the YAML panel, the file menu and the CEE preview all
fail together. A date or time field fails the same way for any default that is not
already in the exact ISO shape its granularity demands. A paragraph has the slot
in the model and no setter for it; an email, a link, a phone number, an
attribute-value field and the seven authority types have neither, so for eleven of
the 25 types the box discards what is typed in silence.

The model carries a number for a numeric field, an ISO literal for a temporal
one, an option label for a list, a term URI with a label for a controlled term,
and nothing for the types that take no default. The editor should carry the same
distinctions, and the card should show the box only where one exists. This is the
precondition for the default value in every per-type item.

The box is closed in the default preferences and open in both the semantic and
the modular preset, so choosing a preset is enough to reach the crash.

### 3. The controlled-term panel on its own writes no constraint

Filled in by hand, the panel collects fields the serializer does not read. Its
ontology mode sets `ontologyName` and never `ontologyId`; its branch mode sets
`ontologyName` and `branchRootName` and never `branchRootId` or `sourceId`. Both
produce a controlled-term field with four empty constraint lists, which is the
decay described under the per-type capability rules. Value Set is worse: it
collects nothing the value-set constraint accepts as a collection, so the
constraint builder throws and the template cannot be written at all. Only
`<cedar-term-picker>` fills what the serializer reads, and the picker is a
sibling component the embedding page may not have loaded.

Three smaller faults sit in the same panel. A default value on a controlled-term
field is passed as a raw string where a term URI and a label are expected, and
comes out as `"defaultValue": {"termUri": null}`. The four Advanced Options
checkboxes have no binding and no handler. `restrictedOntologies` and
`allowMultipleOntologies` are collected and never serialized.

Either the panel collects what the serializer reads, or the panel goes and the
picker becomes the only way to constrain a field. The second is the smaller
surface and the honest one, and it makes the picker a dependency rather than an
enhancement.

## Full Parameter Coverage, One Field Type at a Time

The two shared items come first, because they apply to all 25 types and because
thirteen of those types have no parameters of their own — finishing the shared
surface finishes them outright. The types with the most missing follow, in the
order a template author is most likely to miss them.

### 4. The parameters every field type shares

`skos:prefLabel` and `skos:altLabel` are on every field builder and CED sets
neither. The preferred label is not an advanced control: it sits in the Basic
profile's mockup directly beneath the field name, and a set of synonyms is
exactly what the author of a controlled-term field has to hand.
`schema:identifier` and `language` are never written. The JSON Schema `title` and
`description` are composed from the field name and cannot be set apart from it,
which is right for a default and wrong as the only option. Each field's
`bibo:status` is a fixed draft and its `pav:version` is never set, which belongs
with publishing rather than here.

Annotations are the model library's gap before they are CED's: the model holds
them on every artifact and no builder sets them.

### 5. The deployment parameters every child carries

These are what the template decides about a field, as against what the field
itself is. Five are missing: the recommended flag, the two cardinality bounds,
`hidden` and `continuePreviousLine`.

`recommendedValue`: CEDAR marks a field required, recommended or neither, and
both editor state and the serializer carry all three, but the card has a single
Required checkbox that toggles required against optional. Recommended can only
reach a template by being read from one, and it is lost the first time anyone
touches the checkbox. The current designer offers all three.

`minItems` and `maxItems` on a multi-valued child, so that a field which should
take between one and five values does not take any number. The always-multiple
builder has its own pair, which a checkbox, a multi-select list and an
attribute-value field need, and which is where an attribute-value field's
cardinality is set at all.

`hidden`, which every child can carry — static fields and elements included — and
`continuePreviousLine`. Both are settings the current designer offers and the
model library already writes.

### 6. Text and Paragraph

A text field constrains its values by `minLength`, `maxLength` and a regular
expression, and CED offers none of the three. Its default value works, and is the
only per-type parameter that does.

A paragraph holds a default value in the model with no builder method that sets
it, so this one starts in `cedar-model-typescript-library` — its item belongs with
the library's own in [CEE-ROADMAP.md](CEE-ROADMAP.md). Nothing else distinguishes
a paragraph from a text field in the model, so the type is done once that setter
exists and the shared parameters land.

The custom-field designer already offers a Validation Rules panel — a regular
expression, a minimum length, a maximum length and a numeric range — which is this
same set of constraints attached to a custom type rather than to a field, and read
by nothing. CEDAR states them on the field, so that is where the control belongs,
and the panel should either drive it or go.

### 7. Number

Six parameters, none of them reachable: the datatype, where seven `xsd` types are
available and CED always writes `xsd:decimal`; `minValue` and `maxValue`;
`decimalPlaces`; `unitOfMeasure`; and the default value, which throws today.

These are the Basic profile's defining feature rather than an addition to it.
That profile promises predefined, configurable fields whose permissible values an
author bounds from dropdown menus and checkboxes, without having to learn a schema
or an ontology. A number that must be a positive integer of milligrams is the
plainest case of it, and CED cannot express any part of that.

The library validates a numeric default against the datatype and the bounds, so
the controls have to be built as one thing: a default of 2.5 is legal for a
decimal and refused for an `xsd:int`, and the card should say so rather than
letting the build throw.

### 8. Date and Time

Date and time are the whole of what CED offers. `xsd:dateTime` has no entry in
the palette, granularity is fixed at day for a date and minute for a time where
the model offers seven values, and neither `timezoneEnabled` nor the
12-hour/24-hour input format can be set.

The Basic profile's worked example is precisely this field: a Release Date whose
author picks the date format, picks the time format, and says whether a timezone
is offered. All three are unreachable, and the type CED writes for it is not the
one that example uses.

Reading is lossy in the same place. Anything that is not `xsd:time` is read back
as a date, so a datetime field in an opened template is written out as a date and
any granularity other than day becomes a day: a template loses precision by being
opened and saved, whether or not the author touched the field. Granularity and
type constrain each other — a time cannot be granular to the year — so this type,
like Number, has to be built as one control rather than four.

### 9. Multiple Choice, Checkboxes, List and Multi-select List

The four option-bearing types. Getting their options written at all is the first
item on this roadmap; what remains after that is `selectedByDefault`, which each
of the four option classes carries and CED never sets, so an author can name the
options but not which one a form starts on. Radio and single-select list allow one
selection and the library enforces it by keeping the last one marked; checkbox and
multi-select list allow several.

Both list types also hold a `defaultValue` on their value constraints with no
builder setter, which is the same library gap as the paragraph's and belongs in
the same place.

### 10. Controlled Terms

The largest surface of the 25. One field may carry any number of ontology, branch,
class and value-set entries plus the actions that reorder or drop them, and each
entry carries its own parameters: a URI and an acronym or collection, a name, a
term count, a maximum depth for a branch, a source system, a canonical `iri`, and
the version that pins it to a snapshot. CED writes one entry of one kind, with
whatever the picker filled in.

Its default value is a term URI with a label rather than a string, which is the
malformed case the controlled-term panel fault names. Two further items already
track the constraint surface itself: what the panel does with a second
constraint, and saying what a constraint resolves to.

This type is the one place where full parameter coverage is not obviously the
goal — `numTerms` is a cache of something the terminology server knows, and
`sourceSystem` is null for BioPortal. Coverage here means an author can express
any constraint CEDAR supports, not that every field of every entry gets a box.

### 11. Image, YouTube and Rich Text

An image carries a URL and a display width and height; an embedded video carries
a video id and the same pair. CED writes the first of each and neither size. The
sizes are written into the child's `configuration` when the field is a child of a
template, which is where CED always puts it.

Rich text carries only its markup, and CED collects that in a single-line text
input. The parameter is covered; the control is not usable for what it holds.

### 12. The thirteen types with no parameters of their own

Email, Link and Phone, the seven external authorities — ORCID, ROR, PFAS, RRID,
PubMed, NIH Grant ID and DOI — and Attribute Value, Section Break and Page Break.
Each uses the base value constraints and adds nothing to them, so none has a
per-type parameter to cover.

They are named so the coverage claim can be made about all 25 types rather than
about the ones with parameters. Three things still have to be true of them: the
shared field parameters land, an attribute-value field's cardinality bounds become
settable, and the default-value box stops appearing on the eleven types that take
no default and today discard one in silence.

### 13. Prove the coverage, per type

The gate on the first goal, and the thing that keeps it from decaying. A spec that
walks every type, sets every parameter that type's builder and value constraints
expose, writes the template as JSON and as YAML, reads each back, writes again,
and asserts the second write matches the first. Options silently absent, a
default value discarded, a datetime downgraded to a date — every fault this
roadmap names is one the spec would have caught.

It needs a source of truth for what each type's parameters are. Deriving that list
from the model library rather than restating it in the test is what makes the spec
fail when the library grows a parameter CED has not adopted.

## The Surface Around the Fields

### 14. The three profiles, and what each one holds

Basic, Semantic and Modular are the product structure, and CED has their names
already: three presets in the preferences modal, each a bundle of visibility
booleans plus a list of field types to hide. A preset hides controls. A profile is
a different interface — its own field types, its own constraint editors, its own
guidance — so the mechanism is a smaller thing than the plan needs, and the
definitions it currently holds are wrong in both directions.

Basic hides one field type, Controlled Terms, and shows all twenty-five others.
It offers Attribute Value, which asks an author to describe fields whose names a
form-filler will supply later, and all seven external authority types. It hides
Field Help Text and Default Value, both of which the Basic profile's own mockup
shows. That mockup also shows a preferred label and a full set of temporal
constraints, none of which CED can set in any profile.

Two questions, then. What belongs in each profile, decided per field type and per
control rather than by one boolean apiece. And what a profile may change —
visibility alone, or the editors and the guidance with it. Moving between profiles
has to leave the template intact, which is what makes the second question hard: a
template authored in Modular and opened in Basic still contains everything Basic
does not show.

Every control the coverage work adds is a decision this item has to absorb, which
is the argument for not leaving it to the end of that work.

### 15. Per-type capability rules

CED has a table now, and it answers what a type will accept: whether it can be
required, whether its author chooses the cardinality, whether it carries options,
and what its static content is. The card asks that table rather than testing for
type names, so Required, Allow multiple, Default Value and the options list are
each offered only where the artifact can carry them.

The table is also where the per-type parameter work should land. Each type's
setters differ, and the coverage items are a list of differences that
belong in one descriptor rather than in a chain of type-name tests — which is how
the option setters came to be probed for by name.

What the current designer's table has and CED's does not is `allowedInElement`,
which waits on elements, and `primaryField`, which decides what a search result
shows for a template. Its `allowsValueRecommendation` is not a gap: value
recommendation is being retired, so CED should not grow it.

Its `hasControlledTerms` is not a gap, and will not become one. Production marks
it on one type, `textfield`, and treats controlled terms as something an author
switches on for a text field. CED makes Controlled Terms a type of its own and
offers the constraint panel there and nowhere else. That divergence is deliberate:
the coupling in production is a design mistake, and a field whose values are IRIs
drawn from a named vocabulary is not a text field with an attribute set. Both
still write `_ui.inputType: "textfield"`, so the artifacts agree and a template
crosses between the two designers either way.

One consequence is open. A controlled-term field with no vocabulary chosen
describes nothing, and cannot be written as itself: it goes out IRI-shaped with
empty constraint lists and comes back a text field, so the field decays on an
open-and-save. It is written as a text field today to stop the decay, which trades
one surprise for a smaller one. Refusing to save an unfinished field, and saying
which field is unfinished, is the better answer and belongs with validation.

### 16. Header, footer, and property labels

A template carries a header and a footer, and each child carries a label and a
description that a form shows in place of its raw key. CED writes the key and the
field name and nothing else.

### 17. Guidance in the interface

Tooltips, help messages and worked examples are part of what makes the Basic
profile usable by someone who has never met a metadata standard, and the Semantic
profile needs more than that: short explanations of what naming an ontology term
buys, and of what a particular constraint will do to the form an author's
colleagues eventually fill in.

CED has two explanatory tooltips, both in the controlled-term panel, and one of
them describes a control that does nothing. Everything else is a `title` attribute
naming a button. There is no mechanism behind any of it — no place a control
declares its own help, no way for a host to reword it, and nothing translated.

The parameter work makes this larger rather than smaller. A datatype menu, a
granularity menu and a regular-expression box are each a place an author needs to
be told what the choice does.

## Version Awareness

### 18. Several constraints on one field, and the actions between them

CEDAR allows any number of ontologies, branches, classes and value sets on one
field, plus actions that move or delete entries. CED's panel collects exactly
one, because that is all its free-text form ever collected. The picker returns
one at a time, so this is a question of what the panel does with the second.

### 19. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 20. Freeze on publish

A draft template names a release or names latest; a published one must name a
release, resolved at publish time. CED does not publish anything yet, so this
follows publishing, but the constraint shape has to be right before then.

## Persistence and Lifecycle

### 21. Open from and save to the artifact server

CED reads a file and writes a download. The production designer opens from a
folder, saves back to it, and knows about permissions. For an embeddable
component the host may own that, which makes this a contract question before it
is an implementation one: an event carrying the template a host is expected to
store, or a REST client of CED's own.

### 22. Publish, and make a new version

`bibo:status`, `pav:version`, `pav:derivedFrom` and `pav:previousVersion` are the
lifecycle the artifact server enforces. CED writes a fixed `0.0.1` draft, and
writes the same fixed draft status on every field. Provenance — who created an
artifact and when, who last modified it — is part of the same item and is written
nowhere today.

### 23. Validate before saving

The schema server validates a template and returns what is wrong with it. Nothing
in CED asks. The model library refuses to build some invalid artifacts, which
covers less ground than the validator and is not the same answer.

## The Embedding Contract

### 24. Settle and declare the rest of the contract

`CedConfig` has one key. A host embedding a designer will want at least a
read-only mode, a language, and somewhere to say which field types to offer.
That last one overlaps the profiles, and the overlap is the unsettled part: which
types appear is a user setting today, chosen in a preferences modal, and a host
embedding the designer for a particular purpose has no say in it. Both readings
are legitimate — the host bounds what its authors may use, the author narrows a
long palette down to what they are working with — so the contract has to say
which one wins where they disagree. What each profile contains is settled with
the profiles, not here. Every key added needs the conformance test that already
asserts the contract and the implementation cannot drift apart.

### 25. Publish the package

Nothing is on either channel. The staging and the channel rule are in place, so
this is a decision rather than work: a dev snapshot to Nexus lets the Workbench
consume CED before it is finished.

## Structure Beyond a Flat Template

### 26. Give the field library somewhere to keep things

An author can define a field type of their own — a name, an icon, one of the
built-in types underneath, a placeholder and a list of validation rules — keep it
in a named library, and drop it into any template from the sidebar. The
capability is worth having: most of what an author puts in a template is
something they or a colleague has described once already.

What it lacks is anywhere to put them. A custom field, a library and every
preference are signals in memory, so all three are gone on reload, and nothing an
author defines reaches a second author or a second browser. CEDAR's own unit of
reuse is an artifact on the server, with an identifier, a version and
permissions, which is what lets reuse outlive the tab it was created in. Whether
a saved field becomes one of those, or stays local to the browser and is stored
there, is the decision to make first.

Its placeholder is a second, smaller confusion of the same kind: a custom type's
placeholder is copied into the field's default value, so a hint about what to
type becomes the value a form starts with — and on a numeric type it is the
string that makes the template unwritable.

### 27. Template elements

Elements are the Modular profile, and they are deferred by decision until fields
work properly.

CED has no notion of an element. The production designer nests them, reuses them
across templates, allows multiple cardinality on them, and treats "may this type
appear inside an element" as a property of each field type. A template of any
real size is mostly elements, so a designer without them is not finished.

A preferences toggle called Show elements exists and controls nothing, which is
worse than the capability being absent: it tells an author the designer has
elements.

Elements are last on purpose. They are the largest single item on this list and
they touch every other one — the palette, the capability rules, cardinality, the
save shape — so building them onto a core that is still moving would mean
building them twice. The flat-template core comes first.

Done when an author can add an element to a template, nest one inside another,
give it a cardinality, and have the model library write it — and when opening a
template that contains elements renders them rather than dropping them.

## Quality

### 28. Keyboard and screen-reader access

Untested and unclaimed. The picker has thought about this and CED has not.

### 29. A corpus test

CEE checks itself against 37 real templates in both serializations. CED has no
equivalent — nothing proves it can open the templates production already holds,
which is the first thing anyone will try.
