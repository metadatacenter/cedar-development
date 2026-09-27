"""Nullable identifiers and stale order repairs preserve all other schema content."""
import copy
import unittest
from unittest.mock import patch

import cedar_artifact_repair as r


class SchemaShapePlanTest(unittest.TestCase):
    def setUp(self):
        self.before = {
            "@id": "urn:template", "@type": "https://schema.metadatacenter.org/core/Template",
            "properties": {
                "@id": {"type": "string", "format": "uri"},
                "a/b~c": {"type": "array", "items": {
                    "@type": r.ELEMENT_AT_TYPE,
                    "properties": {"@id": {"type": "string"}},
                }},
            },
            "_ui": {"order": ["gone", "a/b~c"], "propertyLabels": {"gone": "Keep label"}},
        }
        self.after = copy.deepcopy(self.before)
        self.after["properties"]["@id"]["type"] = ["string", "null"]
        self.after["properties"]["a/b~c"]["items"]["properties"]["@id"]["type"] = ["string", "null"]
        self.after["_ui"]["order"] = ["a/b~c"]
        paths = ["/properties/@id/type", "/properties/a~1b~0c/items/properties/@id/type", "/_ui/order"]
        self.plan = {"beforeSha256": r.artifact_fingerprint(self.before),
                     "afterSha256": r.artifact_fingerprint(self.after),
                     "changes": [{"path": p, "before": r.value_at(self.before, p),
                                  "after": r.value_at(self.after, p)} for p in paths]}

    def test_reviewed_plan_nested_paths_and_idempotence(self):
        with patch.dict(r.SCHEMA_SHAPE_PLANS, {"urn:template": self.plan}, clear=True):
            actual, changes = r.apply_reviewed_schema_shapes(self.before)
            self.assertEqual(actual, self.after)
            self.assertEqual(len(changes), 3)
            self.assertIsNone(r.only_reviewed_schema_shapes(self.before, actual))
            self.assertEqual(r.apply_reviewed_schema_shapes(actual), (actual, []))
            self.assertEqual(self.before["properties"]["@id"]["type"], "string")

    def test_unreviewed_or_changed_source_refused(self):
        with patch.dict(r.SCHEMA_SHAPE_PLANS, {}, clear=True):
            with self.assertRaises(r.TransformRefused):
                r.apply_reviewed_schema_shapes(self.before)
        with patch.dict(r.SCHEMA_SHAPE_PLANS, {"urn:template": self.plan}, clear=True):
            drift = copy.deepcopy(self.before)
            drift["schema:name"] = "concurrent edit"
            with self.assertRaises(r.TransformRefused):
                r.apply_reviewed_schema_shapes(drift)
            self.plan["afterSha256"] = "wrong"
            with self.assertRaises(r.TransformRefused):
                r.apply_reviewed_schema_shapes(self.before)

    def test_invariant_rejects_other_changes(self):
        mutations = [
            lambda x: x["properties"]["@id"].update(type=["string", "number"]),
            lambda x: x["properties"]["@id"].update(format="other"),
            lambda x: x["_ui"].update(order=[]),
            lambda x: x["_ui"].update(order=["a/b~c", "gone"]),
            lambda x: x["_ui"].update(order=["gone", "a/b~c", "new"]),
            lambda x: x.update(required=["@id"]),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(self.before)
            mutate(candidate)
            self.assertIsNotNone(r.only_reviewed_schema_shapes(self.before, candidate))
        before = copy.deepcopy(self.before)
        before["annotations"] = {"properties": {"@id": {"type": "string"}}}
        after = copy.deepcopy(before)
        after["annotations"]["properties"]["@id"]["type"] = ["string", "null"]
        self.assertIsNotNone(r.only_reviewed_schema_shapes(before, after))


if __name__ == "__main__":
    unittest.main()
