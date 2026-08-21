# CEDAR Template Designer — Roadmap

Outstanding work for the extracted template-authoring frontend,
`cedar-template-designer` (the AngularJS 1.x application that renders the
Template Designer at `/templates/edit/...`). The production
`cedar-template-editor` monolith remains intact during migration. The Designer
is distinct from the embeddable metadata editor, whose work is tracked in
[CEE-ROADMAP.md](./CEE-ROADMAP.md); backend and cross-service work is in
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md).

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

### 2. Saving a template fails validation when GAZ is constrained as a whole ontology

Adding the GAZ (Gazetteer) ontology to a field as an *entire-ontology* controlled-term value
makes the template fail validation on save (`POST /templates` → 400); a branch or specific-class
constraint on the same ontology does not. Reproduced in the editor, root cause confirmed from
the artifact server's validation report — it is **not** the scale/timeout issue first assumed.
The determining error is:

```
/properties/<field>/_valueConstraints/ontologies/0/numTerms: must have a minimum value of 1
```

The chain: GAZ's term count comes back `n/a` (the terminology server reports no count for it — the
picker even shows "Number Terms: n/a" and "Tree browsing not supported for this ontology"), the
editor then serializes the ontology constraint with `numTerms: 0`, and the meta-schema requires
`_valueConstraints.ontologies[].numTerms` to be an integer with `minimum: 1`
(`literal-field-meta-schema.json`, `iri-field-meta-schema.json`). `0 < 1` fails, and the
JSON-Schema `oneOf` over field kinds turns that one failure into a cascade of unrelated-looking
errors in the report. Pick a fix: (a) have the terminology layer return a real `numTerms` for GAZ
(an `iri-field` `numTerms` already allows `minimum: 0` elsewhere, so the count path is the anomaly);
(b) stop the editor emitting `numTerms: 0` when the count is unknown; or (c) relax the `ontologies`
`numTerms` minimum to `0` so a whole-ontology constraint with an unknown count validates. Also worth
a look: the interactive `POST /command/validate` returned 200 while the create 400'd, so the
editor's live check does not exercise the same constraint.

Only option (b) is the designer's to make alone. The other two are backend changes — a real count
from the terminology layer, or a relaxed minimum in the meta-schema — so whichever is chosen needs a
counterpart there. This is one of three places the same mistake shows — the editor using zero as a
sentinel where the schema reads zero as a quantity — and the other two, `maxItems: 0` for unbounded
and a value set whose term count nobody knew, are one item with it on
[BACKEND-ROADMAP.md](./BACKEND-ROADMAP.md). The decision binds the meta-schema and both model
libraries, so it is taken there; only the frontend half is the designer's.
