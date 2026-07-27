# REST smoke fixtures

Copied from where each is maintained against the meta-schema:

| fixture | source |
|---|---|
| `minimal-template.json` | `cedar-artifact-server/.../test/resources/rest/minimal-template.json` |
| `minimal-element.json` | `cedar-artifact-server/.../test/resources/rest/minimal-element-no-id.json` |
| `minimal-instance.json` | `cedar-artifact-server/.../test/resources/rest/minimal-instance.json` |
| `element-with-id.json` | `cedar-artifact-server/.../test/resources/rest/minimal-element-with-id.json`, for validation, which requires `@id` where create forbids it |
| `minimal-field.json` | `cedar-model-validation-library/.../test/resources/fields/text-field.json` |
 They are duplicated rather than referenced so
`ops/e2e` does not depend on another repository's test tree.

If the meta-schema gains a required property, the artifact server's own suite fails first and
these copies need refreshing. A hand-written template was tried and rejected — the meta-schema
requires a `properties` block naming `@context`, `@id`, `oslc:modifiedBy` and others — so start
from these rather than from scratch.
