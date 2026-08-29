# CEDAR Embeddable Designer — Roadmap

Open work for `cedar-embeddable-designer` (CED), the Web Component for authoring
CEDAR templates. Running, building and packaging it is in
[DESIGNER-RUNBOOK.md](DESIGNER-RUNBOOK.md).

The goal is a designer that does everything the AngularJS Template Designer does
— the one serving `/templates/edit/...` in production, whose own extraction is
tracked in [TEMPLATE-DESIGNER-ROADMAP.md](TEMPLATE-DESIGNER-ROADMAP.md) — and two
things it does not: it embeds in any page, and it authors constraints that name
the ontology version an author chose, through
[`<cedar-term-picker>`](VERSIONING-ROADMAP.md).

Functional equivalence is the bar because a designer that authors most of a
template is not a designer anyone can switch to. The gap is measured against the
production designer's own palette configuration, `app/config/field-type-service.conf.json`
in `cedar-template-editor`, which declares 21 field types and, for each, whether
it may appear in an element, take multiple values, be required, carry controlled
terms, or offer value recommendation.

Item numbers are for referring to items in conversation. They are not stable
handles: an item that is finished leaves the list and joins the paragraph below,
and the rest are renumbered.

## What Is Built

The element registers itself without bootstrapping anything onto the page and
renders in shadow DOM, so neither its styles nor a host page's cross the
boundary. It takes a template as CEDAR JSON or CEDAR YAML, publishes every change
as CEDAR JSON-LD, and offers the same document as a property. Serialization is
the CEDAR model library's throughout, so a template written in one form and
reopened from the other is the same artifact, and identifiers are stable across
edits rather than minted on each read.

Thirteen field types author to the model. A field's constraint is chosen with the
term picker where a host has loaded it, against a terminology server the host
names. There is no hardcoded endpoint and no invented result: a search that fails
says so.

The distribution is one script, its declaration and a staged npm package, held to
a size ceiling and verified byte for byte. 115 unit tests, 5 packaging tests and
37 browser tests run against it, the last of them driving the built bundle in a
hostile host page.

## The Authoring Surface

### 1. Template elements

CED has no notion of an element. The production designer nests them, reuses them
across templates, allows multiple cardinality on them, and treats "may this type
appear inside an element" as a property of each field type. A template of any
real size is mostly elements, so nothing else on this list matters as much.

Done when an author can add an element to a template, nest one inside another,
give it a cardinality, and have the model library write it — and when opening a
template that contains elements renders them rather than dropping them.

### 2. The rest of the field palette

Thirteen of the designer's twenty-one types are offered. Missing: the
single-choice and multiple-choice **list** types, **attribute-value**, the four
static types (**page break**, **section break**, **rich text**, **YouTube**), and
five of the six external-authority types — only ORCID is present, leaving
**ROR**, **PFAS**, **RRID**, **PubMed**, and the two the production designer
cannot render either, **NIH Grant ID** and **DOI**.

CED's `image` is also not the designer's. The palette calls it a file upload;
CEDAR has no such field, so it maps to the static image field, which displays an
image. Either the label is wrong or the mapping is.

### 3. Per-type capability rules

The production designer drives its palette from a table declaring, per type,
`allowedInElement`, `primaryField`, `staticField`, `allowsMultiple`,
`allowsValueRecommendation`, `allowsRequired` and `hasControlledTerms`. CED has
no such table and offers Required and Allow multiple on every field, including
the types that cannot take either — a radio is single by its type and a checkbox
is multiple by its, and the model library models that by giving them different
deployment builders rather than by ignoring the call.

Done when the palette is data rather than markup, and a control that cannot apply
to a type is not offered for it.

### 4. Cardinality bounds

`minItems` and `maxItems` on a multi-valued child. The model library carries
both; CED sets neither, so a field that should take between one and five values
takes any number.

### 5. Value recommendation, hidden fields, and continue-previous-line

Three per-field settings the designer offers and CED does not. All three are
deployment settings the model library already writes.

### 6. Header, footer, and property labels

A template carries a header and a footer, and each child carries a label and a
description that a form shows in place of its raw key. CED writes the key and the
field name and nothing else.

## Version Awareness

### 7. Keep the version an author pinned

This is the reason the picker exists, and CED currently drops it on the floor.
`SelectedConstraint` carries a `version` when an author pinned one, and the
mapper into CED's constraint ignores it. A constraint that names a release is the
difference between a template that means the same thing next year and one that
does not.

Done when a pinned version reaches `_valueConstraints` and survives a round trip
through both serializations.

### 8. Several constraints on one field, and the actions between them

CEDAR allows any number of ontologies, branches, classes and value sets on one
field, plus actions that move or delete entries. CED's panel collects exactly
one, because that is all its free-text form ever collected. The picker returns
one at a time, so this is a question of what the panel does with the second.

### 9. Say what a constraint resolves to

An author who has pinned DOID 2026-06-30 to a branch of 4,000 terms cannot see
that from the panel. The terminology server can answer it and the picker already
shows counts while choosing; the constraint, once chosen, shows a label.

### 10. Freeze on publish

A draft template names a release or names latest; a published one must name a
release, resolved at publish time. CED does not publish anything yet, so this
follows item 12, but the constraint shape has to be right before then.

## Persistence and Lifecycle

### 11. Open from and save to the artifact server

CED reads a file and writes a download. The production designer opens from a
folder, saves back to it, and knows about permissions. For an embeddable
component the host may own that, which makes this a contract question before it
is an implementation one: an event carrying the template a host is expected to
store, or a REST client of CED's own.

### 12. Publish, and make a new version

`bibo:status`, `pav:version`, `pav:derivedFrom` and `pav:previousVersion` are the
lifecycle the artifact server enforces. CED writes a fixed `0.0.1` draft.

### 13. Validate before saving

The schema server validates a template and returns what is wrong with it. Nothing
in CED asks. The model library refuses to build some invalid artifacts, which
covers less ground than the validator and is not the same answer.

## The Embedding Contract

### 14. Settle and declare the rest of the contract

`CedConfig` has one key. A host embedding a designer will want at least a
read-only mode, a language, and somewhere to say which field types to offer —
the preferences the designer keeps in a modal today are host policy, not user
preference. Every key added needs the conformance test that already asserts the
contract and the implementation cannot drift apart.

### 15. Publish the package

Nothing is on either channel. The staging and the channel rule are in place, so
this is a decision rather than work: a dev snapshot to Nexus lets the Workbench
consume CED before it is finished.

## Quality

### 16. Preview a template as CEE renders it

CED's preview panel is its own approximation of a form. CEE is the thing that
actually renders CEDAR templates, and it is a web component, so the preview could
be the real renderer rather than a second implementation of one that will drift.

### 17. Keyboard and screen-reader access

Untested and unclaimed. The picker has thought about this and CED has not.

### 18. A corpus test

CEE checks itself against 37 real templates in both serializations. CED has no
equivalent — nothing proves it can open the templates production already holds,
which is the first thing anyone will try.
