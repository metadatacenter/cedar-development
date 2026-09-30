"""A literal field without a `required` list gains the one both libraries write, and nothing else."""
import copy
import unittest

import cedar_artifact_repair as r

TEMPLATE_AT_TYPE = "https://schema.metadatacenter.org/core/Template"


def field(input_type, properties=("@type", "@value", "rdfs:label"), **extra):
    node = {"@type": r.FIELD_AT_TYPE, "type": "object", "title": "t", "description": "d",
            "_ui": {"inputType": input_type}, "_valueConstraints": {"requiredValue": False},
            "properties": {name: {} for name in properties}, "schema:name": "f"}
    node.update(extra)
    return node


class LiteralRequiredTest(unittest.TestCase):
    def test_literal_and_typed_literal_fields_gain_the_canonical_list(self):
        text, numeric = field("textfield"), field("numeric")
        after, changes = r.complete_literal_required(text)
        self.assertEqual(after["required"], ["@value"])
        self.assertEqual(list(after), ["@type", "type", "title", "description", "required", "_ui",
                                       "_valueConstraints", "properties", "schema:name"])
        self.assertEqual(changes, [{"path": "/required", "replaced": None, "wrote": ["@value"]}])
        self.assertEqual(r.complete_literal_required(numeric)[0]["required"], ["@value", "@type"])
        self.assertIsNone(r.only_completed_literal_required(text, after))
        self.assertNotIn("required", text)

    def test_an_empty_list_is_completed_and_nested_fields_are_reached(self):
        template = {"@type": TEMPLATE_AT_TYPE, "properties": {
            "a/b": {"type": "array", "items": field("temporal", required=[])},
            "list": field("list")}}
        after, changes = r.complete_literal_required(template)
        self.assertEqual(sorted(c["path"] for c in changes),
                         ["/properties/a~1b/items/required", "/properties/list/required"])
        self.assertEqual(after["properties"]["a/b"]["items"]["required"], ["@value", "@type"])
        self.assertIsNone(r.only_completed_literal_required(template, after))
        self.assertEqual(r.complete_literal_required(after), (after, []))

    def test_fields_that_are_not_unambiguously_literal_or_already_demand_something_are_left(self):
        left = [
            field("textfield", _valueConstraints={"ontologies": [{"uri": "urn:o"}]}),
            field("textfield", properties=("@type", "@id", "rdfs:label")),
            field("list", properties=("@type", "@id", "rdfs:label")),
            field("link"),
            field("attribute-value"),
            field("textfield", required=["@value"]),
            field("textfield", required=["rdfs:label"]),
            dict(field("textfield"), **{"@type": r.STATIC_FIELD_AT_TYPE}),
        ]
        for node in left:
            self.assertEqual(r.complete_literal_required(node), (node, []), node)

    def test_invariant_rejects_any_other_change(self):
        text = field("textfield")
        after, _ = r.complete_literal_required(text)
        wrong = copy.deepcopy(after)
        wrong["required"] = ["@value", "@type"]
        self.assertEqual(r.only_completed_literal_required(text, wrong), "/required")
        other = copy.deepcopy(after)
        other["title"] = "changed"
        self.assertEqual(r.only_completed_literal_required(text, other), "/title")
        demanded = field("textfield", required=["rdfs:label"])
        replaced = dict(demanded, required=["@value"])
        self.assertIsNotNone(r.only_completed_literal_required(demanded, replaced))

    def test_registered_under_its_condition(self):
        repair = r.REPAIRS["complete-literal-required"]
        self.assertEqual(repair.conditions, ("literal-required-absent",))
        self.assertIs(repair.transform, r.complete_literal_required)


if __name__ == "__main__":
    unittest.main()
