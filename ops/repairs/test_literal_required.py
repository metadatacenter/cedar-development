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


class LiteralValueSlotTest(unittest.TestCase):
    def test_a_field_declaring_both_slots_becomes_the_literal_field(self):
        both = field("textfield", properties=("@value", "rdfs:label", "@type", "@id"))
        template = {"@type": TEMPLATE_AT_TYPE, "properties": {"f": both}}
        after, changes = r.settle_literal_value_slot(template)
        settled = after["properties"]["f"]
        self.assertEqual(list(settled["properties"]), ["@value", "rdfs:label", "@type"])
        self.assertEqual(settled["required"], ["@value"])
        self.assertEqual([c["path"] for c in changes], ["/properties/f/properties/@id", "/properties/f/required"])
        self.assertIsNone(r.only_settled_literal_value_slot(template, after))
        self.assertEqual(r.settle_literal_value_slot(after), (after, []))
        self.assertIn("@id", both["properties"])

    def test_constrained_iri_or_already_demanding_fields_are_left(self):
        left = [
            field("textfield", properties=("@value", "@id"), _valueConstraints={"classes": [{"uri": "urn:c"}]}),
            field("textfield", properties=("@type", "@id", "rdfs:label")),
            field("link", properties=("@value", "@id")),
            field("textfield", properties=("@value", "@id"), required=["@value", "@id"]),
            field("textfield", properties=("@value", "@id"), required=["@type"]),
        ]
        for node in left:
            self.assertEqual(r.settle_literal_value_slot(node), (node, []), node)

    def test_a_stated_required_is_kept_or_replaced_by_what_it_demands(self):
        both = ("@value", "rdfs:label", "@type", "@id")
        kept = field("numeric", properties=both, required=["@value", "@type"])
        after, changes = r.settle_literal_value_slot(kept)
        self.assertEqual(after["required"], ["@value", "@type"])
        self.assertNotIn("@id", after["properties"])
        self.assertEqual([c["path"] for c in changes], ["/properties/@id"])
        self.assertIsNone(r.only_settled_literal_value_slot(kept, after))
        for stated in (["@id", "rdfs:label"], ["rdfs:label"]):
            node = field("textfield", properties=both, required=stated)
            after, changes = r.settle_literal_value_slot(node)
            self.assertEqual(after["required"], ["@value"], stated)
            self.assertEqual([c["path"] for c in changes], ["/properties/@id", "/required"])
            self.assertIsNone(r.only_settled_literal_value_slot(node, after))
            self.assertEqual(r.settle_literal_value_slot(after), (after, []))

    def test_invariant_rejects_any_other_change(self):
        both = field("textfield", properties=("@value", "@id"))
        after, _ = r.settle_literal_value_slot(both)
        kept = copy.deepcopy(after)
        kept["properties"]["@id"] = {}
        self.assertIsNone(r.only_settled_literal_value_slot(both, kept))
        dropped_value = copy.deepcopy(after)
        del dropped_value["properties"]["@value"]
        self.assertEqual(r.only_settled_literal_value_slot(both, dropped_value), "/properties/@value")
        retitled = dict(after, title="changed")
        self.assertEqual(r.only_settled_literal_value_slot(both, retitled), "/title")


class TermValueSlotTest(unittest.TestCase):
    TEMPLATE_ID = "https://repo.metadatacenter.org/templates/t"

    def setUp(self):
        self.addCleanup(r.TERM_FIELDS.clear)
        r.TERM_FIELDS[self.TEMPLATE_ID] = ["Laterality", "Wrapped"]
        constrained = {"classes": [{"uri": "urn:c", "label": "Left"}]}
        both = ("@value", "rdfs:label", "@type", "@id")
        self.template = {"@id": self.TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
            "Laterality": field("textfield", properties=both, _valueConstraints=constrained),
            "Wrapped": {"type": "array", "items": field("textfield", properties=both, required=["@value"],
                                                        _valueConstraints=constrained)},
            "HR Pos": field("textfield", properties=both, _valueConstraints=constrained),
            "Free": field("textfield", properties=both)}}

    def test_only_the_named_term_fields_lose_their_value_slot(self):
        after, changes = r.settle_term_value_slot(self.template)
        props = after["properties"]
        self.assertEqual(list(props["Laterality"]["properties"]), ["rdfs:label", "@type", "@id"])
        self.assertEqual(props["Wrapped"]["items"]["required"], [])
        self.assertIn("@value", props["HR Pos"]["properties"])
        self.assertIn("@value", props["Free"]["properties"])
        self.assertEqual([c["path"] for c in changes], ["/properties/Laterality/properties/@value",
                                                        "/properties/Wrapped/items/properties/@value",
                                                        "/properties/Wrapped/items/required"])
        self.assertIsNone(r.only_settled_term_value_slot(self.template, after))
        self.assertEqual(r.settle_term_value_slot(after), (after, []))

    def test_nothing_changes_without_a_plan(self):
        r.TERM_FIELDS.clear()
        self.assertEqual(r.settle_term_value_slot(self.template), (self.template, []))

    def test_invariant_rejects_any_other_change(self):
        after, _ = r.settle_term_value_slot(self.template)
        other = copy.deepcopy(after)
        del other["properties"]["HR Pos"]["properties"]["@value"]
        self.assertEqual(r.only_settled_term_value_slot(self.template, other),
                         "/properties/HR Pos/properties/@value")
        kept = copy.deepcopy(after)
        kept["properties"]["Laterality"]["properties"]["@value"] = {"type": "string"}
        self.assertIsNotNone(r.only_settled_term_value_slot(self.template, kept))


class EmptyTermLiteralTest(unittest.TestCase):
    TEMPLATE_ID = "https://repo.metadatacenter.org/templates/t"

    def setUp(self):
        self.addCleanup(r.TERM_FIELDS.clear)
        r.TERM_FIELDS[self.TEMPLATE_ID] = ["ERpos", "PgRpos", "Laterality", "Free"]
        constrained = {"classes": [{"uri": "urn:c", "label": "Positive"}]}
        both = ("@value", "rdfs:label", "@type", "@id")
        self.template = {"@id": self.TEMPLATE_ID, "@type": TEMPLATE_AT_TYPE, "properties": {
            name: field("textfield", properties=both, _valueConstraints=constrained)
            for name in ("ERpos", "PgRpos", "Laterality", "Other")}}
        self.template["properties"]["Free"] = field("textfield", properties=both)
        empty = {"@value": "", "@type": "xsd:string"}
        self.instance = {"schema:isBasedOn": self.TEMPLATE_ID, "ERpos": dict(empty), "PgRpos": {"@value": ""},
                         "Laterality": {"@id": "urn:c", "rdfs:label": "Left"}, "Other": dict(empty),
                         "Free": dict(empty)}

    def test_only_named_term_fields_holding_an_empty_literal_change(self):
        after, changes = r.settle_empty_term_literal(self.instance, self.template)
        self.assertEqual(after["ERpos"], {})
        self.assertEqual(after["PgRpos"], {})
        self.assertEqual(after["Laterality"], self.instance["Laterality"])
        self.assertEqual(after["Other"], self.instance["Other"])
        self.assertEqual(after["Free"], self.instance["Free"])
        self.assertEqual([c["path"] for c in changes], ["/ERpos", "/PgRpos"])
        self.assertIsNone(r.only_settled_empty_term_literals(self.instance, after, self.template))
        self.assertEqual(r.settle_empty_term_literal(after, self.template), (after, []))

    def test_text_is_never_taken_for_emptiness(self):
        self.instance["ERpos"] = {"@value": "1", "@type": "xsd:string"}
        after, changes = r.settle_empty_term_literal(self.instance, self.template)
        self.assertEqual(after["ERpos"], self.instance["ERpos"])
        self.assertEqual([c["path"] for c in changes], ["/PgRpos"])

    def test_invariant_rejects_any_other_change(self):
        after, _ = r.settle_empty_term_literal(self.instance, self.template)
        other = dict(after, Other={})
        self.assertIsNotNone(r.only_settled_empty_term_literals(self.instance, other, self.template))
        relabelled = dict(after, Laterality={"@id": "urn:c", "rdfs:label": "Right"})
        self.assertEqual(r.only_settled_empty_term_literals(self.instance, relabelled, self.template),
                         "/Laterality/rdfs:label")


if __name__ == "__main__":
    unittest.main()
