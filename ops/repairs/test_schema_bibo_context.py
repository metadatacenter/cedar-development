"""Namespace repair must not change instance constraints or existing predicates."""
import copy
import unittest

import cedar_artifact_repair as r


def schema(kind="TemplateField", context=None):
    return {"@type": "https://schema.metadatacenter.org/core/" + kind,
            "@context": {} if context is None else context}


class SchemaBiboContextTest(unittest.TestCase):
    def test_embedded_arrays_and_static_fields_only(self):
        before = schema("Template", {"bibo": r.BIBO_NAMESPACE})
        before["properties"] = {
            "a/b~c": {"type": "array", "items": schema("TemplateElement")},
            "static": schema("StaticTemplateField"),
            "@context": {"properties": {"bibo": {"enum": ["urn:keep"]}}, "required": ["bibo"]},
        }
        before["properties"]["a/b~c"]["items"]["properties"] = {"field": schema()}
        before["annotations"] = {"example": schema()}
        original = copy.deepcopy(before)
        after, changes = r.complete_schema_bibo_context(before)
        self.assertEqual(before, original)
        self.assertEqual(len(changes), 3)
        self.assertIn("/properties/a~1b~0c/items/@context/bibo", [c["path"] for c in changes])
        self.assertEqual(after["properties"]["@context"], before["properties"]["@context"])
        self.assertEqual(after["annotations"], before["annotations"])
        self.assertIsNone(r.only_added_schema_bibo_context(before, after))
        self.assertEqual(r.complete_schema_bibo_context(after), (after, []))

    def test_existing_and_malformed_contexts_unchanged(self):
        for context in ({"bibo": "urn:custom"}, {"bibo": None}, ["urn:external"], "urn:external"):
            before = schema(context=context)
            self.assertEqual(r.complete_schema_bibo_context(before), (before, []))
        self.assertEqual(r.complete_schema_bibo_context({"@context": {}}), ({"@context": {}}, []))

    def test_invariant_rejects_unrelated_changes(self):
        before = schema()
        before["properties"] = {"@context": {"required": ["xsd"]}}
        after, _ = r.complete_schema_bibo_context(before)
        for bad in ("namespace", "required", "provenance"):
            altered = copy.deepcopy(after)
            if bad == "namespace":
                altered["@context"]["bibo"] = "urn:wrong"
            elif bad == "required":
                altered["properties"]["@context"]["required"].append("bibo")
            else:
                altered["pav:version"] = "2.0.0"
            self.assertIsNotNone(r.only_added_schema_bibo_context(before, altered))
        existing = schema(context={"bibo": "urn:custom"})
        self.assertIsNotNone(r.only_added_schema_bibo_context(existing, after))


if __name__ == "__main__":
    unittest.main()
