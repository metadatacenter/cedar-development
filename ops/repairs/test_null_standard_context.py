"""Approved context restoration changes no metadata values or custom field mappings."""
import copy
import unittest

import cedar_artifact_repair as r


class NullStandardContextTest(unittest.TestCase):
    def setUp(self):
        self.template = {"@id": "urn:template", "properties": {"@context": {"properties": {
            name: {"properties": {"@type": {"type": "string", "enum": [datatype]}}}
            for name, datatype in r.CONTEXT_OBJECT_DATATYPES.items()
        }}}}
        self.instance = {"schema:isBasedOn": "urn:template", "schema:name": "keep",
                         "@context": {**dict.fromkeys(r.CONTEXT_OBJECT_DATATYPES),
                                      "xsd": "http://www.w3.org/2001/XMLSchema#", "Language": "urn:language"},
                         "Language": [{"@value": "ae"}]}

    def test_nulls_only_and_idempotence(self):
        after, changes = r.restore_null_standard_context(self.instance, self.template)
        self.assertEqual(len(changes), 10)
        self.assertIsNone(r.only_restored_null_standard_context(self.instance, after, self.template))
        self.assertEqual(after["Language"], self.instance["Language"])
        self.assertEqual(after["schema:name"], "keep")
        self.assertEqual(r.restore_null_standard_context(after, self.template), (after, []))
        self.assertIsNone(self.instance["@context"]["schema:name"])

    def test_noncanonical_template_or_prefix_refused(self):
        self.template["properties"]["@context"]["properties"]["schema:name"] = {}
        with self.assertRaises(r.TransformRefused):
            r.restore_null_standard_context(self.instance, self.template)
        self.instance["@context"]["xsd"] = "urn:wrong"
        with self.assertRaises(r.TransformRefused):
            r.restore_null_standard_context(self.instance, self.template)

    def test_invariant_rejects_metadata_custom_mapping_and_missing_additions(self):
        for mutate in (
            lambda x: x.update(**{"schema:name": "changed"}),
            lambda x: x["@context"].update(Language="urn:other"),
            lambda x: x["@context"].update(**{"schema:name": {"@type": "@id"}}),
        ):
            after = copy.deepcopy(self.instance)
            mutate(after)
            self.assertIsNotNone(r.only_restored_null_standard_context(self.instance, after, self.template))
        before = copy.deepcopy(self.instance)
        del before["@context"]["schema:name"]
        after = copy.deepcopy(before)
        after["@context"]["schema:name"] = {"@type": "xsd:string"}
        self.assertIsNotNone(r.only_restored_null_standard_context(before, after, self.template))


if __name__ == "__main__":
    unittest.main()
