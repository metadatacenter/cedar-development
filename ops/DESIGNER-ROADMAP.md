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

## The Goal, and the Order

Every parameter the model library exposes is reachable from a card, and that is
what makes the cards the problem to solve next. A Basic-profile author meets the
whole surface at once — a datatype menu, a granularity menu, a regular-expression
box, an occurrence range, a property IRI — where that profile's own mockup shows a
name, a requirement and a help line. Adding controls to one card is how the
designer CED replaces became cluttered, and CED has now arrived at the same place
by the same route.

**The goal is the three profiles: Basic, Semantic and Modular, each an interface
its audience can work in rather than one interface with parts hidden.** Capability
equivalence is the bar for the three together; legibility is the bar for each.

The order after that is a decision rather than a grouping. What CED writes wrongly
is settled before it is given more to write, because a malformed constraint can
stop a template being written at all. Then version awareness, which is the
Semantic profile's; then opening and saving, which is what makes the component
usable by anyone outside a demo; then structure beyond a flat template, which is
the Modular profile's and which touches everything else.

Two field-level questions remain, and they are first because they are small and
because both are decisions rather than implementations.

Item numbers are for referring to items in conversation, and they are not stable
handles — an item that is finished leaves the document, and the rest are
renumbered. What was built is recorded in the commits that built it. Name an item
rather than its number.

## The Fields

### 1. A palette entry for a date that carries a time

The palette offers Date and Time, and `xsd:dateTime` has no entry of its own. An
author reaches it by adding a Date and changing its datatype, which works and is
not discoverable: the Basic profile's worked example is a Release Date that
carries both, and nothing in the palette says CED can express one.

Either a third entry, or the datatype control has to be plain enough on a Date card
that nobody needs the palette to find it. The palette already has twenty-six
entries, which is the argument against a third.

### 2. Length and pattern on a paragraph

A text field constrains its values by `minLength`, `maxLength` and a regular
expression. A paragraph carries none of the three in CED, and the reason is that
the two model libraries disagree about whether it should. `TextAreaField` in
`cedar-artifact-library` has `withMinLength` and `withMaxLength` and no
`withRegex`; `TextAreaBuilder` in `cedar-model-typescript-library` has none of the
three. `TextField` has all three in both.

So the libraries' disagreement is the thing to settle, and it is theirs to settle
rather than CED's: whether a paragraph is a text field that renders differently, in
which case it takes the same constraints, or a block whose length nobody bounds. A
template written by the Java library today can carry a paragraph length that the
TypeScript library cannot express, which is the sharper reason to decide.

CED needs no change either way. The descriptor reads the setters a builder
actually has, so a paragraph gains the controls when the library it reads gains
them.

## The Surface Around the Fields

### 3. The three profiles, and what each one holds

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
shows, and shows the whole parameter surface of every type it does offer.

Two questions, then. What belongs in each profile, decided per field type and per
control rather than by one boolean apiece. And what a profile may change —
visibility alone, or the editors and the guidance with it. Moving between profiles
has to leave the template intact, which is what makes the second question hard: a
template authored in Modular and opened in Basic still contains everything Basic
does not show.

Every control on a card today is a decision this item has to absorb, and there are
now a great many of them.

### 4. Per-type capability rules

CED's descriptor is the one place that answers what a type will accept, and the
cards and the writer ask it rather than testing for a type's name.

What the current designer's own table answers and the descriptor does not is
`allowedInElement`, which waits on elements, and `primaryField`, which decides
what a search result shows for a template. Its `allowsValueRecommendation` is not
a gap: value recommendation is being retired, so CED should not grow it.

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

### 5. Header, footer, and property labels

A template carries a header and a footer, and each child carries a label and a
description that a form shows in place of its raw key. CED writes the key and the
field name and nothing else.

### 6. Guidance in the interface

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

### 7. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 8. Freeze on publish

A draft template names a release or names latest; a published one must name a
release, resolved at publish time. CED does not publish anything yet, so this
follows publishing, but the constraint shape has to be right before then.

## Persistence and Lifecycle

### 9. Open from and save to the artifact server

CED reads a file and writes a download. The production designer opens from a
folder, saves back to it, and knows about permissions. For an embeddable
component the host may own that, which makes this a contract question before it
is an implementation one: an event carrying the template a host is expected to
store, or a REST client of CED's own.

### 10. Publish, and make a new version

Implement the artifact server's lifecycle for `bibo:status`, `pav:version`,
`pav:derivedFrom` and `pav:previousVersion`. Define creation and update provenance
for editable drafts: who created an artifact and when, and who last modified it.
Coordinate version allocation and publish operations with the embedding host.

### 11. Edit published fields through an explicit draft workflow

Define an explicit “Edit as draft” action for a published field, coordinated with
its embedding host and the artifact server. Decide whether that action creates a
new field identity or a new version of the existing field, and how the template
replaces its reference. Carry forward provenance and source/version links; assign
draft status and a version according to the server's lifecycle rules.

Keep the published definition immutable. Cover permission failures, cancellation,
saving the draft and publishing it, with tests proving that none of those paths
silently rewrites the source published field.

### 12. Validate before saving

The schema server validates a template and returns what is wrong with it. Nothing
in CED asks. The model library refuses to build some invalid artifacts, which
covers less ground than the validator and is not the same answer.

## The Embedding Contract

### 13. Settle and declare the rest of the contract

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

### 14. Publish the package

Nothing is on either channel. The staging and the channel rule are in place, so
this is a decision rather than work: a dev snapshot to Nexus lets the Workbench
consume CED before it is finished.

## Structure Beyond a Flat Template

### 15. Give the field library somewhere to keep things

An author can save any field they have built — its type, its parameters, its
constraints, the whole definition — into a named library, and drop it into another
template from the sidebar. The capability is worth having: most of what an author
puts in a template is something they or a colleague has described once already.

What it lacks is anywhere to put them. A custom field, a library and every
preference are signals in memory, so all three are gone on reload, and nothing an
author defines reaches a second author or a second browser. CEDAR's own unit of
reuse is an artifact on the server, with an identifier, a version and
permissions, which is what lets reuse outlive the tab it was created in. Whether
a saved field becomes one of those, or stays local to the browser and is stored
there, is the decision to make first.

### 16. Template elements

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

### 17. Keyboard and screen-reader access

The names are right now. Seven controls announced nothing useful — a visible
`label` that labelled no control, a box named only by a placeholder that vanishes
once it holds a value, a select whose accessible name was its own list of options
— and the attribute matrix asserts every control it drives can be found by the
name it shows.

A name is the smallest part of this. Nothing has been driven from the keyboard
alone, no focus order has been checked, no live region announces that a constraint
was added or that an Apply was refused, and the modal the picker opens has not been
tested for focus capture or for what Escape does to an author midway through a
choice. The picker has thought about this and CED has not.
