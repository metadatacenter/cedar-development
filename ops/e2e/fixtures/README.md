# REST smoke fixtures

Copied from `cedar-artifact-server/.../src/test/resources/rest/`, which is where they are
maintained against the template meta-schema. They are duplicated rather than referenced so
`ops/e2e` does not depend on another repository's test tree.

If the meta-schema gains a required property, the artifact server's own suite fails first and
these copies need refreshing. A hand-written template was tried and rejected — the meta-schema
requires a `properties` block naming `@context`, `@id`, `oslc:modifiedBy` and others — so start
from these rather than from scratch.
