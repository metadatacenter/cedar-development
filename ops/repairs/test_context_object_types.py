"""Context type additions require matching source and compatible dependent instances."""
import copy
import unittest
from unittest.mock import patch

import cedar_artifact_repair as r


class ContextObjectTypesTest(unittest.TestCase):
    def setUp(self):
        self.before = {"@id": "urn:template", "@type": "https://schema.metadatacenter.org/core/Template",
                       "properties": {"@context": {"properties": {
                           "schema:name": {"properties": {"@type": {"type": "string", "enum": ["xsd:string"]}}}
                       }}}}
        self.after = copy.deepcopy(self.before)
        self.after["properties"]["@context"]["properties"]["schema:name"]["type"] = "object"
        self.plan = {"beforeSha256": r.artifact_fingerprint(self.before),
                     "afterSha256": r.artifact_fingerprint(self.after),
                     "changes": [{"path": "/properties/@context/properties/schema:name/type", "wrote": "object"}],
                     "instanceCheck": {"indexed": 2, "fetched": 2, "conflicts": []}}

    def test_checked_addition_and_idempotence(self):
        with patch.dict(r.CONTEXT_OBJECT_PLANS, {"urn:template": self.plan}, clear=True):
            after, changes = r.complete_reviewed_context_object_types(self.before)
            self.assertEqual(after, self.after)
            self.assertEqual(len(changes), 1)
            self.assertIsNone(r.only_completed_context_object_types(self.before, after))
            self.assertEqual(r.complete_reviewed_context_object_types(after), (after, []))

    def test_missing_incomplete_or_conflicting_check_refused(self):
        for check in ({}, {"indexed": 2, "fetched": 1, "conflicts": []},
                      {"indexed": 2, "fetched": 2, "conflicts": ["urn:instance"]}):
            plan = {**self.plan, "instanceCheck": check}
            with patch.dict(r.CONTEXT_OBJECT_PLANS, {"urn:template": plan}, clear=True):
                with self.assertRaises(r.TransformRefused):
                    r.complete_reviewed_context_object_types(self.before)
        with patch.dict(r.CONTEXT_OBJECT_PLANS, {"urn:template": self.plan}, clear=True):
            drift = copy.deepcopy(self.before)
            drift["schema:name"] = "edited"
            with self.assertRaises(r.TransformRefused):
                r.complete_reviewed_context_object_types(drift)

    def test_invariant_rejects_overwrite_datatype_and_unrelated_changes(self):
        before = copy.deepcopy(self.before)
        before["properties"]["@context"]["properties"]["schema:name"]["type"] = "string"
        self.assertIsNotNone(r.only_completed_context_object_types(before, self.after))
        for mutate in (
            lambda x: x.update(required=["schema:name"]),
            lambda x: x["properties"]["@context"]["properties"]["schema:name"].update(type="string"),
            lambda x: x["properties"]["@context"]["properties"]["schema:name"]["properties"]["@type"].update(enum=["@id"]),
        ):
            after = copy.deepcopy(self.after)
            mutate(after)
            self.assertIsNotNone(r.only_completed_context_object_types(self.before, after))


if __name__ == "__main__":
    unittest.main()
