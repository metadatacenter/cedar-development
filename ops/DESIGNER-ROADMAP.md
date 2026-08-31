# CEDAR Embeddable Designer — Roadmap

Open work for `cedar-embeddable-designer` (CED), the Web Component for authoring
CEDAR templates. Running, building and packaging it is in
[DESIGNER-RUNBOOK.md](DESIGNER-RUNBOOK.md).

The goal is a designer that does everything the AngularJS Template Designer does
— the one serving `/templates/edit/...` in production, across the
`cedar-template-editor` monolith and the `cedar-template-designer` extraction of
it — and two things it does not: it embeds in any page, and it authors
constraints that name the ontology version an author chose, through
[`<cedar-term-picker>`](VERSIONING-ROADMAP.md).

Functional equivalence is the bar because a designer that authors most of a
template is not a designer anyone can switch to. The gap is measured against the
production designer's own palette configuration,
`app/config/field-type-service.conf.json` in `cedar-template-editor`, which
declares 23 field types and, for each, whether it may appear in an element, take
multiple values, be required, carry controlled terms, or offer value
recommendation.

The order is the order to do them in, and it is a decision rather than a
grouping: the flat-template core is finished before anything structural, so that
the larger work is built once on something settled rather than twice on something
moving.

Item numbers are for referring to items in conversation, and they are not stable
handles — an item that is finished leaves the document, and the rest are
renumbered. What was built is recorded in the commits that built it. Name an item
rather than its number.

## The Authoring Surface

### 1. Per-type capability rules

CED has a table now, and it answers what a type will accept: whether it can be
required, whether its author chooses the cardinality, whether it carries options,
and what its static content is. The card asks that table rather than testing for
type names, so Required, Allow multiple, Default Value and the options list are
each offered only where the artifact can carry them.

What the production designer's table has and CED's does not is
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

### 2. Cardinality bounds

`minItems` and `maxItems` on a multi-valued child. The model library carries
both; CED sets neither, so a field that should take between one and five values
takes any number.

### 3. Hidden fields and continue-previous-line

Two per-field settings the designer offers and CED does not. Both are deployment
settings the model library already writes.

### 4. Header, footer, and property labels

A template carries a header and a footer, and each child carries a label and a
description that a form shows in place of its raw key. CED writes the key and the
field name and nothing else.

## Version Awareness

### 5. Several constraints on one field, and the actions between them

CEDAR allows any number of ontologies, branches, classes and value sets on one
field, plus actions that move or delete entries. CED's panel collects exactly
one, because that is all its free-text form ever collected. The picker returns
one at a time, so this is a question of what the panel does with the second.

### 6. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 7. Freeze on publish

A draft template names a release or names latest; a published one must name a
release, resolved at publish time. CED does not publish anything yet, so this
follows publishing below, but the constraint shape has to be right before then.

## Persistence and Lifecycle

### 8. Open from and save to the artifact server

CED reads a file and writes a download. The production designer opens from a
folder, saves back to it, and knows about permissions. For an embeddable
component the host may own that, which makes this a contract question before it
is an implementation one: an event carrying the template a host is expected to
store, or a REST client of CED's own.

### 9. Publish, and make a new version

`bibo:status`, `pav:version`, `pav:derivedFrom` and `pav:previousVersion` are the
lifecycle the artifact server enforces. CED writes a fixed `0.0.1` draft.

### 10. Validate before saving

The schema server validates a template and returns what is wrong with it. Nothing
in CED asks. The model library refuses to build some invalid artifacts, which
covers less ground than the validator and is not the same answer.

## The Embedding Contract

### 11. Settle and declare the rest of the contract

`CedConfig` has one key. A host embedding a designer will want at least a
read-only mode, a language, and somewhere to say which field types to offer.
That last one has an answer already, but the wrong shape of one: which types
appear is a user setting, chosen in a preferences modal and its three presets,
and a host that embeds the designer for a particular purpose has no say in it.
Both readings are legitimate — the host bounds what its authors may use, the
author narrows a long palette down to what they are working with — so the
contract has to say which one wins where they disagree. Every key added needs
the conformance test that already asserts the contract and the implementation
cannot drift apart.

### 12. Publish the package

Nothing is on either channel. The staging and the channel rule are in place, so
this is a decision rather than work: a dev snapshot to Nexus lets the Workbench
consume CED before it is finished.

## Structure Beyond a Flat Template

### 13. Give the field library somewhere to keep things

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

The validation rules ask the same question in a smaller form. They are held on
the custom type and read by nothing, where CEDAR states a regular expression and
a value range on the field itself.

### 14. Template elements

CED has no notion of an element. The production designer nests them, reuses them
across templates, allows multiple cardinality on them, and treats "may this type
appear inside an element" as a property of each field type. A template of any
real size is mostly elements, so a designer without them is not finished.

It sits here rather than first on purpose. Elements are the largest single item
on this list and they touch everything above — the palette, the capability rules,
cardinality, the save shape — so building them onto a core that is still moving
would mean building them twice. The flat-template core comes first.

Done when an author can add an element to a template, nest one inside another,
give it a cardinality, and have the model library write it — and when opening a
template that contains elements renders them rather than dropping them.

## Quality

### 15. Keyboard and screen-reader access

Untested and unclaimed. The picker has thought about this and CED has not.

### 16. A corpus test

CEE checks itself against 37 real templates in both serializations. CED has no
equivalent — nothing proves it can open the templates production already holds,
which is the first thing anyone will try.
