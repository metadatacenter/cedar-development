# CEDAR Template Designer — Roadmap

Outstanding work for the template-authoring frontend, `cedar-template-editor`
(the AngularJS 1.x application that renders the Template Designer at
`/templates/edit/...`). Distinct from the embeddable metadata editor, whose work
is tracked in [CEE-ROADMAP.md](./CEE-ROADMAP.md); backend and cross-service work
is in [BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

This roadmap tracks open work only.

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
`{{...}}`. Removing those two types renders everything — including a 123-child,
two-level-nested template exercising every other field type at single and multiple
cardinality, which comes up clean with the header intact.

This also accounts for what looked like a separate performance problem. A
~133-child template that failed to render was first recorded as a size or digest
cliff; it is not one. That template carried both types in every field group, about
ten copies in all, so the render-abort fired repeatedly and looked like a hang.
A 123-child, two-level-nested template with every *other* field type renders
cleanly. Treat a stall as a size problem only if it is shown on a template free of
these two types.

Add designer renderer support for `ext-nih-grant-id-field` and `ext-doi-field`,
mirroring the existing external-authority field renderers (ROR/ORCID/PFAS/RRID/
PubMed). Done when a template containing both types renders every field and the
header title interpolates.
