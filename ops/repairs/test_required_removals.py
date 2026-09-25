"""Reviewed requirement removals cannot touch child obligations, values or context schemas."""
import copy
import unittest
from unittest.mock import patch

import cedar_artifact_repair as r


class RequiredRemovalsTest(unittest.TestCase):
    def setUp(self):
        self.before = {
            "@id": "urn:element", "@type": r.ELEMENT_AT_TYPE,
            "required": ["@context", "schema:name", "child", "gone", "@id"],
            "properties": {
                "child": {"@type": r.FIELD_AT_TYPE, "type": "object", "properties": {"@value": {}}},
                "@context": {"required": ["xsd"]},
            },
        }
        self.after = copy.deepcopy(self.before)
        self.after["required"] = ["@context", "child", "@id"]
        self.plan = {"beforeSha256": r.artifact_fingerprint(self.before),
                     "afterSha256": r.artifact_fingerprint(self.after),
                     "changes": [{"path": "/required", "before": self.before["required"],
                                  "after": self.after["required"]}]}

    def test_exact_reviewed_plan_and_idempotence(self):
        with patch.dict(r.REQUIRED_REMOVALS, {"urn:element": self.plan}, clear=True):
            after, changes = r.drop_reviewed_required_entries(self.before)
            self.assertEqual(after, self.after)
            self.assertEqual(len(changes), 1)
            self.assertIsNone(r.only_dropped_reviewed_required_entries(self.before, after))
            self.assertEqual(r.drop_reviewed_required_entries(after), (after, []))
            self.assertIn("gone", self.before["required"])

    def test_drift_or_bad_plan_refused(self):
        with patch.dict(r.REQUIRED_REMOVALS, {"urn:element": self.plan}, clear=True):
            changed = copy.deepcopy(self.before)
            changed["schema:name"] = "concurrent edit"
            with self.assertRaises(r.TransformRefused):
                r.drop_reviewed_required_entries(changed)
            self.plan["afterSha256"] = "wrong"
            with self.assertRaises(r.TransformRefused):
                r.drop_reviewed_required_entries(self.before)
        with patch.dict(r.REQUIRED_REMOVALS, {}, clear=True):
            with self.assertRaises(r.TransformRefused):
                r.drop_reviewed_required_entries(self.before)

    def test_invariant_rejects_children_base_context_and_values(self):
        for name in ("child", "@id", "@context"):
            after = copy.deepcopy(self.before)
            after["required"].remove(name)
            self.assertIsNotNone(r.only_dropped_reviewed_required_entries(self.before, after))
        for mutate in (
            lambda x: x["properties"]["@context"].update(required=[]),
            lambda x: x.update(required=list(reversed(x["required"]))),
            lambda x: x.update(required=x["required"] + ["invented"]),
            lambda x: x.update(**{"schema:name": "changed"}),
        ):
            after = copy.deepcopy(self.before)
            mutate(after)
            self.assertIsNotNone(r.only_dropped_reviewed_required_entries(self.before, after))
        before = copy.deepcopy(self.before)
        before["@type"] = "https://schema.metadatacenter.org/core/Template"
        after = copy.deepcopy(before)
        after["required"].remove("schema:name")
        self.assertIsNotNone(r.only_dropped_reviewed_required_entries(before, after))


if __name__ == "__main__":
    unittest.main()
