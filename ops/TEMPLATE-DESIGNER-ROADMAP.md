# CEDAR Template Designer — Roadmap

Outstanding work for the template-authoring frontend, `cedar-template-editor`
(the AngularJS 1.x application that renders the Template Designer at
`/templates/edit/...`). Distinct from the embeddable metadata editor, whose work
is tracked in [CEE-ROADMAP.md](./CEE-ROADMAP.md); backend and cross-service work
is in [DEVELOPMENT-ROADMAP.md](./DEVELOPMENT-ROADMAP.md).

This roadmap tracks open work only. Item numbers are stable handles.

## Bugs

### 1. The designer cannot render `ext-nih-grant-id-field` or `ext-doi-field`

The designer has no field renderer for the two newest external-authority field
types, **NIH Grant ID** (`ext-nih-grant-id-field`) and **DOI** (`ext-doi-field`).
Its coverage stops after the earlier external-authority types — ROR, ORCID,
PFAS, RRID and PubMed all render. These two are model-valid and create cleanly
through the REST API (same validator), so this is purely a designer UI gap, not
a data problem.

The failure is not silent-and-local: when the designer hits one of these fields
while linking the form, the field simply does not appear, **and the abort leaves
later-linked bindings uncompiled** — most visibly the top-bar title, which
renders as the literal string `{{hc.formatDocumentTitle()}}` instead of the
template name. The header controller is fine (calling `hc.formatDocumentTitle()`
directly returns the correct title); the interpolation node was never compiled
because rendering aborted on the unsupported field. Any template containing
either type shows the broken header; a template without them renders normally.

Reproduced on a template carrying one of every field type: 23 of 25 field labels
render, and exactly NIH Grant ID and DOI are missing, with the header left as raw
`{{...}}`.

Add designer renderer support for `ext-nih-grant-id-field` and `ext-doi-field`,
mirroring the existing external-authority field renderers (ROR/ORCID/PFAS/RRID/
PubMed). Done when a template containing both types renders every field and the
header title interpolates.

## Performance

### 2. The designer stalls on large templates

Opening a large template (~130+ children across nested elements, exercising every
field type at single and multiple cardinality) pegs the main thread long enough
that the page never finishes its first render — the header stays on the literal
`{{...}}` binding and interactions block. The template is model-valid and saves
through the REST API; the designer's per-node watch/digest cost appears to grow
past a usable bound at this size. Characterize where the cost concentrates
(watch count, repeated digests, per-field terminology or lookup calls) and set a
target size the designer must handle without stalling. A natural benchmark to
retest against is the Angular upgrade tracked in
[CEE-ROADMAP.md](./CEE-ROADMAP.md) item 2 (that upgrade is for the embeddable
editor, but the designer shares much of the same rendering pressure).
