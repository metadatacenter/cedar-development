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
handles — an item that is finished leaves the list and joins the paragraph above,
and the rest are renumbered. Name an item rather than its number.

## What Is Built

The element registers itself without bootstrapping anything onto the page and
renders in shadow DOM, so neither its styles nor a host page's cross the
boundary. It takes a template as CEDAR JSON or CEDAR YAML, publishes every change
as CEDAR JSON-LD, and offers the same document as a property. Serialization is
the CEDAR model library's throughout, so a template written in one form and
reopened from the other is the same artifact, and identifiers are stable across
edits rather than minted on each read.

Twenty-six field types author to the model — every type the production designer
offers, plus the two the production designer cannot render. Which of them may be
required, take several values, carry a list of options or hold static content is
one table, read by the builder and by the card that draws the controls, so a
control is offered only where the artifact can carry the setting behind it.

A field's constraint is chosen with the term picker where a host has loaded it,
against a terminology server the host names. There is no hardcoded endpoint and
no invented result: a search that fails says so. The vocabulary snapshot an author
pinned reaches all four kinds of entry and survives both serializations, so a
constraint names the release it meant rather than resolving against whatever is
served on the day it is read.

Preview renders the template with CEE, the renderer that will show the form to
whoever fills it in, rather than with a drawing of a form of the designer's own.
It is a third sibling web component the host loads: read-only, and with no
instance behind it, which is how CEE reads a template as a statement of what each
field will accept. CEE takes one assignment to its template, so an edit replaces
the element once typing stops.

It looks like CEDAR. The palette is the teal and rust the Workbench and CEE use,
the type scale is stated in pixels because a rem would resolve against whatever
root size the host page happens to set, and Roboto travels in the bundle at three
weights — registered from an unencapsulated component, because a shadow root
ignores an `@font-face` declared inside it.

The distribution is one script, its declaration and a staged npm package, held to
a size ceiling and verified byte for byte. 220 unit tests, 5 packaging tests and
41 browser tests run against it, the last of them driving the built bundle in a
hostile host page.

## The Authoring Surface

### 1. Per-type capability rules

CED has a table now, and it answers what a type will accept: whether it can be
required, whether its author chooses the cardinality, whether it carries options,
and what its static content is. The card asks that table rather than testing for
type names, so Required, Allow multiple, Default Value and the options list are
each offered only where the artifact can carry them.

What the production designer's table has and CED's does not is
`allowedInElement`, which waits on elements, `primaryField`, which decides what a
search result shows for a template, `allowsValueRecommendation`, and
`hasControlledTerms` — CED offers the controlled-term panel on the controlled-term
type alone, where the production designer offers it on several.

### 2. Cardinality bounds

`minItems` and `maxItems` on a multi-valued child. The model library carries
both; CED sets neither, so a field that should take between one and five values
takes any number.

### 3. Value recommendation, hidden fields, and continue-previous-line

Three per-field settings the designer offers and CED does not. All three are
deployment settings the model library already writes.

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
