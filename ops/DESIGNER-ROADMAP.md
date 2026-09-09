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

Every field type CEDAR defines is already in CED's palette — 26 entries, three
more than the 23 the current designer's own configuration declares in
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
because malformed constraints can stop a template being written at all.
Parameter coverage comes next, type by type.
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

## Full Parameter Coverage, One Field Type at a Time

The two shared items come first, because they apply to every type and because
thirteen of those types have no parameters of their own — finishing the shared
surface finishes them outright. The types with the most missing follow, in the
order a template author is most likely to miss them.

### 1. The parameters every field type shares

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

### 2. The deployment parameters every child carries

These are what the template decides about a field, as against what the field
itself is. Five are missing: the recommended flag, the two cardinality bounds,
`hidden` and `continuePreviousLine`.

`recommendedValue`: CEDAR marks a field required, recommended or neither, and
both designer state and the serializer carry all three, but the card has a single
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

### 3. Text and Paragraph

A text field constrains its values by `minLength`, `maxLength` and a regular
expression, and CED offers none of the three as authoring controls. Paragraph
needs the shared field parameters.

The custom-field designer already offers a Validation Rules panel — a regular
expression, a minimum length, a maximum length and a numeric range — which is this
same set of constraints attached to a custom type rather than to a field, and read
by nothing. CEDAR states them on the field, so that is where the control belongs,
and the panel should either drive it or go.

### 4. Number

Five authoring parameters remain: the datatype, where seven `xsd` types are
available and CED always writes `xsd:decimal`; `minValue` and `maxValue`;
`decimalPlaces`; and `unitOfMeasure`.

These are the Basic profile's defining feature rather than an addition to it.
That profile promises predefined, configurable fields whose permissible values an
author bounds from dropdown menus and checkboxes, without having to learn a schema
or an ontology. A number that must be a positive integer of milligrams is the
plainest case of it, and CED cannot express any part of that.

Datatype and bound controls must account for the existing default: changing
a decimal field with a default of 2.5 to `xsd:int` needs an explanation and a
resolution before the field can be updated.

### 5. Date and Time

Date and time are the whole of what CED offers. `xsd:dateTime` has no entry in
the palette, granularity is fixed at day for a date and minute for a time where
the model offers seven values, and neither `timezoneEnabled` nor the
12-hour/24-hour input format can be set.

The Basic profile's worked example is precisely this field: a Release Date whose
author picks the date format, picks the time format, and says whether a timezone
is offered. All three are unreachable, and the type CED writes for it is not the
one that example uses.

Granularity and type constrain each other — a time cannot be granular to the
year — so this type, like Number, needs coordinated authoring controls. Their
changes must account for existing defaults.

### 6. Image, YouTube and Rich Text

An image carries a URL and a display width and height; an embedded video carries
a video id and the same pair. CED writes the first of each and neither size. The
sizes are written into the child's `configuration` when the field is a child of a
template, which is where CED always puts it.

Rich text carries only its markup, and CED collects that in a single-line text
input. The parameter is covered; the control is not usable for what it holds.

### 7. The thirteen types with no parameters of their own

Email, Link and Phone, the seven external authorities — ORCID, ROR, PFAS, RRID,
PubMed, NIH Grant ID and DOI — and Attribute Value, Section Break and Page Break.
None of them constrains its values beyond what every field does, so none has a
per-type parameter to cover.

They are named so the coverage claim can be made about the whole palette rather
than about the types with parameters. The shared field parameters still need to
land, and an attribute-value field's cardinality bounds need authoring controls.

### 8. Prove the coverage, per type

The gate on the first goal, and the thing that keeps it from decaying. A spec that
walks every type, sets every parameter that type's builder and value constraints
expose, writes the template as JSON and as YAML, reads each back, writes again,
and asserts the second write matches the first. The checks must cover the entire
parameter surface as authoring controls grow.

It needs a source of truth for what each type's parameters are. Deriving that list
from the model library rather than restating it in the test is what makes the spec
fail when the library grows a parameter CED has not adopted.

## The Surface Around the Fields

### 9. The three profiles, and what each one holds

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

### 10. Per-type capability rules

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

### 11. Header, footer, and property labels

A template carries a header and a footer, and each child carries a label and a
description that a form shows in place of its raw key. CED writes the key and the
field name and nothing else.

### 12. Guidance in the interface

Tooltips, help messages and worked examples are part of what makes the Basic
profile usable by someone who has never met a metadata standard, and the Semantic
profile needs more than that: short explanations of what naming an ontology term
buys, and of what a particular constraint will do to the form an author's
colleagues eventually fill in.

Controls need a common way to declare help, let a host reword it, and translate
it. A `title` attribute naming a button does not explain the choice behind it.

The parameter work makes this larger rather than smaller. A datatype menu, a
granularity menu and a regular-expression box are each a place an author needs to
be told what the choice does.

## Version Awareness

### 13. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 14. Freeze on publish

A draft template names a release or names latest; a published one must name a
release, resolved at publish time. CED does not publish anything yet, so this
follows publishing, but the constraint shape has to be right before then.

## Persistence and Lifecycle

### 15. Open from and save to the artifact server

CED reads a file and writes a download. The production designer opens from a
folder, saves back to it, and knows about permissions. For an embeddable
component the host may own that, which makes this a contract question before it
is an implementation one: an event carrying the template a host is expected to
store, or a REST client of CED's own.

### 16. Publish, and make a new version

`bibo:status`, `pav:version`, `pav:derivedFrom` and `pav:previousVersion` are the
lifecycle the artifact server enforces. CED writes a fixed `0.0.1` draft, and
writes the same fixed draft status on every field. Provenance — who created an
artifact and when, who last modified it — is part of the same item and is written
nowhere today.

### 17. Validate before saving

The schema server validates a template and returns what is wrong with it. Nothing
in CED asks. The model library refuses to build some invalid artifacts, which
covers less ground than the validator and is not the same answer.

## The Embedding Contract

### 18. Settle and declare the rest of the contract

`CedConfig` currently names terminology and bridge endpoints. A host embedding a designer will want at least a
read-only mode, a language, and somewhere to say which field types to offer.
That last one overlaps the profiles, and the overlap is the unsettled part: which
types appear is a user setting today, chosen in a preferences modal, and a host
embedding the designer for a particular purpose has no say in it. Both readings
are legitimate — the host bounds what its authors may use, the author narrows a
long palette down to what they are working with — so the contract has to say
which one wins where they disagree. What each profile contains is settled with
the profiles, not here. Every key added needs the conformance test that already
asserts the contract and the implementation cannot drift apart.

### 19. Publish the package

Nothing is on either channel. The staging and the channel rule are in place, so
this is a decision rather than work: a dev snapshot to Nexus lets the Workbench
consume CED before it is finished.

## Structure Beyond a Flat Template

### 20. Give the field library somewhere to keep things

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

### 21. Template elements

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

### 22. Keyboard and screen-reader access

Untested and unclaimed. The picker has thought about this and CED has not.

### 23. A corpus test

CEE checks itself against 37 real templates in both serializations. CED has no
equivalent — nothing proves it can open the templates production already holds,
which is the first thing anyone will try.
