"""Deleting orphan actions must preserve literal rules and active vocabulary selections."""
import copy
import unittest

import cedar_artifact_repair as r


class OrphanLiteralActionsTest(unittest.TestCase):
    def setUp(self):
        self.field = {"@type": r.FIELD_AT_TYPE, "_ui": {"inputType": "textfield"},
                      "properties": {"@value": {"type": ["string", "null"]}},
                      "_valueConstraints": {"actions": [{"action": "delete", "termUri": "urn:term"}],
                                            "regex": "[A-Z]+", "defaultValue": "ABC",
                                            **{group: [] for group in r.TERM_CONSTRAINT_GROUPS}}}

    def test_nested_literal_only_and_idempotence(self):
        before = {"@type": "https://schema.metadatacenter.org/core/Template", "properties": {
            "a/b": {"type": "array", "items": self.field}}}
        after, changes = r.drop_orphan_literal_actions(before)
        self.assertEqual([c["path"] for c in changes], ["/properties/a~1b/items/_valueConstraints/actions"])
        self.assertEqual(after["properties"]["a/b"]["items"]["_valueConstraints"]["regex"], "[A-Z]+")
        self.assertIsNone(r.only_dropped_orphan_literal_actions(before, after))
        self.assertEqual(r.drop_orphan_literal_actions(after), (after, []))
        self.assertIn("actions", self.field["_valueConstraints"])

    def test_active_or_ambiguous_fields_are_preserved(self):
        for group in r.TERM_CONSTRAINT_GROUPS:
            field = copy.deepcopy(self.field)
            field["_valueConstraints"][group] = [{"uri": "urn:active"}]
            self.assertEqual(r.drop_orphan_literal_actions(field), (field, []))
        for shape in ({"@id": {}}, {"@id": {}, "@value": {}}, {}):
            field = copy.deepcopy(self.field)
            field["properties"] = shape
            self.assertEqual(r.drop_orphan_literal_actions(field), (field, []))

    def test_invariant_rejects_constraint_or_value_changes(self):
        after, _ = r.drop_orphan_literal_actions(self.field)
        after["_valueConstraints"]["regex"] = "different"
        self.assertIsNotNone(r.only_dropped_orphan_literal_actions(self.field, after))
        after = copy.deepcopy(self.field)
        after["properties"] = {"@id": {}}
        self.assertIsNotNone(r.only_dropped_orphan_literal_actions(self.field, after))


if __name__ == "__main__":
    unittest.main()
