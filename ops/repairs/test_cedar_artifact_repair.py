#!/usr/bin/env python3
"""Unit tests for the transform, the invariant and target selection in cedar_artifact_repair.py.

The write path is exercised by running the tool against a server; these cover the parts that decide
what a write would contain, which is where a mistake would be silent.

    python3 -m unittest ops/test_cedar_artifact_repair.py
"""

import copy
import re
import importlib.util
import time
import json
import pathlib
import sys
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("cedar_artifact_repair.py")
SPEC = importlib.util.spec_from_file_location("cedar_artifact_repair", MODULE_PATH)
REPAIR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = REPAIR
SPEC.loader.exec_module(REPAIR)

strip = REPAIR.strip_empty_derived_from


def paths(changes):
    """The change list records the replaced value too; most assertions only care where."""
    return [change["path"] for change in changes]
invariant = REPAIR.only_removed_empty_derived_from


class TransformTest(unittest.TestCase):

    def test_removes_the_key_at_the_root(self):
        after, removed = strip({"@id": "x", "pav:derivedFrom": ""})
        self.assertEqual(after, {"@id": "x"})
        self.assertEqual(removed, [{"path": "/pav:derivedFrom", "replaced": "", "wrote": None}])

    def test_removes_it_at_every_depth_and_reports_each_path(self):
        before = {
            "pav:derivedFrom": "",
            "properties": {
                "Name": {"pav:derivedFrom": "", "_ui": {}},
                "Address": {"properties": {"Street": {"pav:derivedFrom": ""}}},
            },
        }
        after, removed = strip(before)
        self.assertEqual(sorted(paths(removed)), [
            "/pav:derivedFrom",
            "/properties/Address/properties/Street/pav:derivedFrom",
            "/properties/Name/pav:derivedFrom",
        ])
        self.assertNotIn("pav:derivedFrom", after)
        self.assertNotIn("pav:derivedFrom", after["properties"]["Name"])
        self.assertEqual(after["properties"]["Name"]["_ui"], {})

    def test_reaches_inside_arrays(self):
        before = {"items": [{"pav:derivedFrom": ""}, {"pav:derivedFrom": "https://example.org/a"}]}
        after, removed = strip(before)
        self.assertEqual(paths(removed), ["/items/0/pav:derivedFrom"])
        self.assertEqual(after["items"][1]["pav:derivedFrom"], "https://example.org/a")

    def test_leaves_every_non_empty_value_alone(self):
        for value in ("https://example.org/a", "not-a-uri", " ", None, 0, [], {}):
            with self.subTest(value=value):
                after, removed = strip({"pav:derivedFrom": value})
                self.assertEqual(removed, [])
                self.assertEqual(after, {"pav:derivedFrom": value})

    def test_a_second_pass_finds_nothing(self):
        once, first = strip({"pav:derivedFrom": "", "properties": {"A": {"pav:derivedFrom": ""}}})
        twice, second = strip(once)
        self.assertEqual(len(first), 2)
        self.assertEqual(second, [])
        self.assertEqual(twice, once)

    def test_the_input_is_not_mutated(self):
        before = {"pav:derivedFrom": ""}
        strip(before)
        self.assertEqual(before, {"pav:derivedFrom": ""})

    def test_a_pointer_component_is_escaped(self):
        _after, removed = strip({"properties": {"a/b": {"pav:derivedFrom": ""}}})
        self.assertEqual(paths(removed), ["/properties/a~1b/pav:derivedFrom"])


class InvariantTest(unittest.TestCase):

    def accepts(self, before):
        after, _removed = strip(before)
        self.assertIsNone(invariant(before, after))

    def test_accepts_what_the_transform_produces(self):
        self.accepts({"pav:derivedFrom": "", "properties": {"A": {"pav:derivedFrom": "", "x": [1, {"y": None}]}}})

    def test_rejects_a_removed_key_that_was_not_empty(self):
        before = {"pav:derivedFrom": "https://example.org/a", "keep": 1}
        self.assertEqual(invariant(before, {"keep": 1}), "/pav:derivedFrom")

    def test_rejects_any_other_removal(self):
        self.assertEqual(invariant({"a": 1, "b": 2}, {"a": 1}), "/b")

    def test_rejects_an_added_key(self):
        self.assertEqual(invariant({"a": 1}, {"a": 1, "b": 2}), "/b")

    def test_rejects_a_changed_value_however_deep(self):
        before = {"properties": {"A": {"title": "one"}}}
        after = {"properties": {"A": {"title": "two"}}}
        self.assertEqual(invariant(before, after), "/properties/A/title")

    def test_rejects_a_changed_list_length_and_a_changed_element(self):
        self.assertEqual(invariant({"a": [1, 2]}, {"a": [1]}), "/a")
        self.assertEqual(invariant({"a": [1, 2]}, {"a": [1, 3]}), "/a/1")

    def test_rejects_a_changed_type(self):
        self.assertEqual(invariant({"a": {"b": 1}}, {"a": [1]}), "/a")

    def test_ignores_key_order(self):
        self.assertIsNone(invariant({"a": 1, "b": 2}, {"b": 2, "a": 1}))

    def test_distinguishes_false_from_zero_and_from_absent(self):
        self.assertEqual(invariant({"a": False}, {"a": 0}), "/a")
        self.assertEqual(invariant({"a": False}, {}), "/a")


class TargetSelectionTest(unittest.TestCase):

    def records(self, rows):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        for row in rows:
            handle.write(json.dumps(row) + "\n")
        handle.close()
        return pathlib.Path(handle.name)

    def test_selects_only_artifacts_carrying_the_condition_and_deduplicates(self):
        path = self.records([
            {"artifactType": "template", "artifactId": "t1", "artifactName": "T",
             "conditionRules": {"derived-from-empty": 3}},
            {"artifactType": "template", "artifactId": "t1", "artifactName": "T",
             "conditionRules": {"derived-from-empty": 3}},
            {"artifactType": "field", "artifactId": "f1", "artifactName": "F",
             "conditionRules": {"title-not-canonical": 1}},
            {"artifactType": "element", "artifactId": "e1", "artifactName": "E",
             "conditionRules": {"derived-from-empty": 1, "title-not-canonical": 1}},
        ])
        refs = REPAIR.targets_from_records(path, ["derived-from-empty"], [], parser=None)
        self.assertEqual([(r.artifact_type, r.artifact_id) for r in refs],
                         [("template", "t1"), ("element", "e1")])
        path.unlink()

    def test_a_rule_named_only_inside_another_field_is_not_a_match(self):
        # The reader skips lines cheaply by substring, then confirms against conditionRules.
        path = self.records([
            {"artifactType": "template", "artifactId": "t1", "artifactName": "derived-from-empty",
             "conditionRules": {"title-not-canonical": 1}},
        ])
        errors = []
        class Parser:
            def error(self, message):
                errors.append(message)
                raise SystemExit(2)
        with self.assertRaises(SystemExit):
            REPAIR.targets_from_records(path, ["derived-from-empty"], [], parser=Parser())
        self.assertIn("no artifact", errors[0])
        path.unlink()


class PreimageNamingTest(unittest.TestCase):

    def test_the_file_is_named_by_type_and_the_identifier_tail(self):
        ref = REPAIR.rest.ArtifactRef("template", "https://repo.metadatacenter.org/templates/abc-123")
        path = REPAIR.preimage_path(pathlib.Path("/tmp/pre"), ref)
        self.assertEqual(path, pathlib.Path("/tmp/pre/template/abc-123.json"))

    def test_an_awkward_identifier_still_yields_one_safe_file(self):
        ref = REPAIR.rest.ArtifactRef("field", "urn:x:../../etc/passwd")
        path = REPAIR.preimage_path(pathlib.Path("/tmp/pre"), ref)
        self.assertEqual(path.parent, pathlib.Path("/tmp/pre/field"))
        self.assertNotIn("/", path.name[:-5])
        self.assertNotIn("..", path.name.replace(".json", ""))


class ProgressTest(unittest.TestCase):

    def test_only_a_written_or_writable_outcome_counts_paths(self):
        progress = REPAIR.Progress(total=3)
        progress.note("repaired", 2)
        progress.note("would-repair", 1)
        progress.note("still-invalid", 5)
        self.assertEqual(progress.paths_removed, 3)
        self.assertEqual(dict(progress.outcomes),
                         {"repaired": 1, "would-repair": 1, "still-invalid": 1})



def numeric(number_type=None, **extra):
    node = child(**extra)
    node["_ui"] = {"inputType": "numeric"}
    node["required"] = ["@value", "@type"]
    node["properties"] = {"@value": {"type": ["number", "null"]},
                          "@type": {"type": "string", "format": "uri"}}
    node["_valueConstraints"] = {"numberType": number_type} if number_type else {}
    return node


def temporal(temporal_type=None):
    node = child()
    node["_ui"] = {"inputType": "temporal"}
    node["required"] = ["@value", "@type"]
    node["properties"] = {"@value": {"type": ["string", "null"]},
                          "@type": {"type": "string", "format": "uri"}}
    node["_valueConstraints"] = {"temporalType": temporal_type} if temporal_type else {}
    return node


def iri_field():
    node = child()
    node["properties"] = {"@id": {"type": "string", "format": "uri"},
                          "rdfs:label": {"type": ["string", "null"]}}
    return node


def repeating(node, minimum=None):
    wrapper = {"type": "array", "items": node}
    if minimum is not None:
        wrapper["minItems"] = minimum
    return wrapper


class DeclaredValueTypeTest(unittest.TestCase):
    """What datatype a field pins for the value an instance carries."""

    def test_a_numeric_field_names_its_own(self):
        self.assertEqual(REPAIR.declared_value_type(numeric("xsd:int")), "xsd:int")

    def test_a_numeric_field_naming_none_falls_back_to_decimal(self):
        self.assertEqual(REPAIR.declared_value_type(numeric()), "xsd:decimal")

    def test_a_temporal_field_names_its_own(self):
        self.assertEqual(REPAIR.declared_value_type(temporal("xsd:date")), "xsd:date")

    def test_a_temporal_field_naming_none_falls_back_to_datetime(self):
        self.assertEqual(REPAIR.declared_value_type(temporal()), "xsd:dateTime")

    def test_a_plain_field_pins_nothing(self):
        self.assertIsNone(REPAIR.declared_value_type(child()))

    def test_a_field_that_does_not_require_a_type_is_not_stamped(self):
        self.assertFalse(REPAIR.demands_value_type(child()))
        self.assertTrue(REPAIR.demands_value_type(numeric("xsd:int")))


class DifferencesTest(unittest.TestCase):
    """An invariant built on this cannot overlook a change."""

    def test_an_added_key_is_reported_with_its_absence(self):
        found = list(REPAIR.differences({"a": 1}, {"a": 1, "b": 2}))
        self.assertEqual(found, [("/b", REPAIR.ABSENT, 2)])

    def test_a_removed_key_is_reported(self):
        found = list(REPAIR.differences({"a": 1, "b": 2}, {"a": 1}))
        self.assertEqual(found, [("/b", 2, REPAIR.ABSENT)])

    def test_a_change_deep_inside_is_reported_at_its_own_path(self):
        found = list(REPAIR.differences({"a": {"b": [{"c": 1}]}}, {"a": {"b": [{"c": 2}]}}))
        self.assertEqual(found, [("/a/b/0/c", 1, 2)])

    def test_a_list_growing_is_reported_whole(self):
        found = list(REPAIR.differences({"a": [1]}, {"a": [1, 2]}))
        self.assertEqual(found, [("/a", [1], [1, 2])])

    def test_a_name_holding_a_slash_is_escaped(self):
        found = list(REPAIR.differences({}, {"a/b": 1}))
        self.assertEqual(found, [("/a~1b", REPAIR.ABSENT, 1)])

    def test_identical_documents_differ_nowhere(self):
        self.assertEqual(list(REPAIR.differences({"a": [1, {"b": None}]}, {"a": [1, {"b": None}]})), [])

    def test_a_type_change_is_a_difference_even_where_values_compare_equal(self):
        self.assertEqual(list(REPAIR.differences({"a": 1}, {"a": True})), [("/a", 1, True)])


class StampInstanceValueTypeTest(unittest.TestCase):
    """A numeric or temporal field renders with @type among the properties its value must carry."""

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_an_empty_numeric_value_gains_the_declared_datatype(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        before = {"Dose": {"@value": None}}
        after, changes = REPAIR.stamp_instance_value_type(before, tmpl)
        self.assertEqual(after["Dose"], {"@value": None, "@type": "xsd:int"})
        self.assertEqual(changes[0]["path"], "/Dose/@type")
        self.assertIsNone(REPAIR.only_stamped_value_types(before, after, tmpl))

    def test_a_numeric_field_naming_no_type_gets_the_model_default(self):
        tmpl = self.template_with({"Dose": numeric()})
        after, _changes = REPAIR.stamp_instance_value_type({"Dose": {"@value": 3}}, tmpl)
        self.assertEqual(after["Dose"]["@type"], "xsd:decimal")

    def test_a_temporal_field_naming_no_type_gets_the_model_default(self):
        tmpl = self.template_with({"When": temporal()})
        after, _changes = REPAIR.stamp_instance_value_type({"When": {"@value": None}}, tmpl)
        self.assertEqual(after["When"]["@type"], "xsd:dateTime")

    def test_a_type_already_stated_is_never_rewritten(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        before = {"Dose": {"@value": 1, "@type": "xsd:decimal"}}
        after, changes = REPAIR.stamp_instance_value_type(before, tmpl)
        self.assertEqual(after, before)
        self.assertEqual(changes, [])

    def test_a_field_pinning_no_datatype_is_left_alone(self):
        tmpl = self.template_with({"Name": child()})
        after, changes = REPAIR.stamp_instance_value_type({"Name": {"@value": "Ada"}}, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Name"], {"@value": "Ada"})

    def test_every_occurrence_of_a_repeating_field_is_stamped(self):
        tmpl = self.template_with({"Dose": repeating(numeric("xsd:int"))})
        before = {"Dose": [{"@value": 1}, {"@value": 2}]}
        after, _changes = REPAIR.stamp_instance_value_type(before, tmpl)
        self.assertEqual([v["@type"] for v in after["Dose"]], ["xsd:int", "xsd:int"])
        self.assertIsNone(REPAIR.only_stamped_value_types(before, after, tmpl))

    def test_a_value_inside_an_element_is_stamped(self):
        inner = {"Dose": numeric("xsd:float")}
        node = child(ELEMENT_TYPE)
        node["properties"] = {"@context": {"properties": {}, "required": []}, **inner}
        node["_ui"] = {"order": list(inner)}
        tmpl = self.template_with({"Panel": node})
        before = {"Panel": {"Dose": {"@value": None}}}
        after, _changes = REPAIR.stamp_instance_value_type(before, tmpl)
        self.assertEqual(after["Panel"]["Dose"]["@type"], "xsd:float")
        self.assertIsNone(REPAIR.only_stamped_value_types(before, after, tmpl))

    def test_the_invariant_catches_a_datatype_that_is_not_the_declared_one(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        before = {"Dose": {"@value": None}}
        self.assertEqual(
            REPAIR.only_stamped_value_types(before, {"Dose": {"@value": None, "@type": "xsd:long"}}, tmpl),
            "/Dose/@type")

    def test_the_invariant_catches_a_value_altered_alongside(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        before = {"Dose": {"@value": 1}}
        self.assertEqual(
            REPAIR.only_stamped_value_types(before, {"Dose": {"@value": 2, "@type": "xsd:int"}}, tmpl),
            "/Dose/@value")

    def test_the_repair_is_settled_after_one_pass(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        once, first = REPAIR.stamp_instance_value_type({"Dose": {"@value": None}}, tmpl)
        _twice, second = REPAIR.stamp_instance_value_type(once, tmpl)
        self.assertTrue(first)
        self.assertEqual(second, [])


class WrapAndUnwrapOccurrenceTest(unittest.TestCase):
    """A repeating child takes a list whether it holds one occurrence or several."""

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_a_lone_value_is_put_in_the_list_declared_for_it(self):
        tmpl = self.template_with({"Tag": repeating(child())})
        before = {"Tag": {"@value": "one"}}
        after, changes = REPAIR.wrap_instance_occurrence(before, tmpl)
        self.assertEqual(after["Tag"], [{"@value": "one"}])
        self.assertEqual(changes[0]["path"], "/Tag")
        self.assertIsNone(REPAIR.only_wrapped_occurrences(before, after, tmpl))

    def test_a_list_already_there_is_left_alone(self):
        tmpl = self.template_with({"Tag": repeating(child())})
        after, changes = REPAIR.wrap_instance_occurrence({"Tag": [{"@value": "one"}]}, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Tag"], [{"@value": "one"}])

    def test_a_single_child_is_not_wrapped(self):
        tmpl = self.template_with({"Tag": child()})
        after, changes = REPAIR.wrap_instance_occurrence({"Tag": {"@value": "one"}}, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Tag"], {"@value": "one"})

    def test_the_wrap_invariant_catches_a_value_changed_on_the_way_in(self):
        tmpl = self.template_with({"Tag": repeating(child())})
        before = {"Tag": {"@value": "one"}}
        self.assertEqual(REPAIR.only_wrapped_occurrences(before, {"Tag": [{"@value": "two"}]}, tmpl),
                         "/Tag")

    def test_the_wrap_invariant_catches_a_second_occurrence_appearing(self):
        tmpl = self.template_with({"Tag": repeating(child())})
        before = {"Tag": {"@value": "one"}}
        self.assertEqual(
            REPAIR.only_wrapped_occurrences(before, {"Tag": [{"@value": "one"}, {"@value": "x"}]}, tmpl),
            "/Tag")

    def test_a_list_of_one_becomes_the_value_declared_for_it(self):
        tmpl = self.template_with({"Tag": child()})
        before = {"Tag": [{"@value": "one"}]}
        after, changes = REPAIR.unwrap_instance_occurrence(before, tmpl)
        self.assertEqual(after["Tag"], {"@value": "one"})
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_unwrapped_occurrences(before, after, tmpl))

    def test_an_empty_list_becomes_the_form_for_absence(self):
        tmpl = self.template_with({"Tag": child()})
        before = {"Tag": []}
        after, _changes = REPAIR.unwrap_instance_occurrence(before, tmpl)
        self.assertEqual(after["Tag"], {"@value": None})
        self.assertIsNone(REPAIR.only_unwrapped_occurrences(before, after, tmpl))

    def test_a_list_of_several_is_left_for_someone_to_decide(self):
        tmpl = self.template_with({"Tag": child()})
        before = {"Tag": [{"@value": "one"}, {"@value": "two"}]}
        after, changes = REPAIR.unwrap_instance_occurrence(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Tag"], before["Tag"])

    def test_the_unwrap_invariant_catches_a_longer_list_being_cut_down(self):
        tmpl = self.template_with({"Tag": child()})
        before = {"Tag": [{"@value": "one"}, {"@value": "two"}]}
        self.assertEqual(REPAIR.only_unwrapped_occurrences(before, {"Tag": {"@value": "one"}}, tmpl),
                         "/Tag")


class SettleInstanceEmptyShapeTest(unittest.TestCase):
    """The model has two forms for absence and they are not interchangeable."""

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_an_empty_object_on_a_literal_field_becomes_a_null_literal(self):
        tmpl = self.template_with({"Name": child()})
        before = {"Name": {}}
        after, changes = REPAIR.settle_instance_empty_shape(before, tmpl)
        self.assertEqual(after["Name"], {"@value": None})
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_settled_empty_shapes(before, after, tmpl))

    def test_an_empty_numeric_field_also_gains_its_datatype(self):
        tmpl = self.template_with({"Dose": numeric("xsd:int")})
        before = {"Dose": {}}
        after, _changes = REPAIR.settle_instance_empty_shape(before, tmpl)
        self.assertEqual(after["Dose"], {"@value": None, "@type": "xsd:int"})
        self.assertIsNone(REPAIR.only_settled_empty_shapes(before, after, tmpl))

    def test_a_null_literal_on_an_iri_field_becomes_an_empty_object(self):
        tmpl = self.template_with({"Term": iri_field()})
        before = {"Term": {"@value": None}}
        after, _changes = REPAIR.settle_instance_empty_shape(before, tmpl)
        self.assertEqual(after["Term"], {})
        self.assertIsNone(REPAIR.only_settled_empty_shapes(before, after, tmpl))

    def test_a_null_identifier_becomes_an_empty_object(self):
        tmpl = self.template_with({"Term": iri_field()})
        before = {"Term": {"@id": None}}
        after, _changes = REPAIR.settle_instance_empty_shape(before, tmpl)
        self.assertEqual(after["Term"], {})

    def test_a_value_carrying_content_is_never_reshaped(self):
        tmpl = self.template_with({"Term": iri_field()})
        before = {"Term": {"@value": "https://example.org/x"}}
        after, changes = REPAIR.settle_instance_empty_shape(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Term"], before["Term"])

    def test_a_literal_already_in_its_own_form_is_left_alone(self):
        tmpl = self.template_with({"Name": child()})
        after, changes = REPAIR.settle_instance_empty_shape({"Name": {"@value": None}}, tmpl)
        self.assertEqual(changes, [])

    def test_the_invariant_catches_content_being_discarded(self):
        tmpl = self.template_with({"Term": iri_field()})
        before = {"Term": {"@id": "https://example.org/x"}}
        self.assertEqual(REPAIR.only_settled_empty_shapes(before, {"Term": {}}, tmpl), "/Term/@id")


class CompleteInstanceContextTest(unittest.TestCase):
    """A template states what an instance's @context must carry and what each term may be."""

    def template_with(self, children, context=None):
        doc = template(children)
        mapped = {name: {"enum": [GOOD_IRI + name]} for name in children}
        mapped.update(context or {})
        doc["properties"]["@context"] = {"properties": mapped, "required": list(mapped)}
        return doc

    def test_a_missing_property_term_is_written_from_the_template(self):
        tmpl = self.template_with({"Name": child()})
        before = {"@context": {}, "Name": {"@value": "Ada"}}
        after, changes = REPAIR.complete_instance_context(before, tmpl)
        self.assertEqual(after["@context"]["Name"], GOOD_IRI + "Name")
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_added_context_entries(before, after, tmpl))

    def test_a_term_definition_object_is_written_whole(self):
        tmpl = self.template_with(
            {"Name": child()},
            {"skos:notation": {"type": "object",
                               "properties": {"@type": {"enum": ["xsd:string"], "type": "string"}}}})
        before = {"@context": {}}
        after, _changes = REPAIR.complete_instance_context(before, tmpl)
        self.assertEqual(after["@context"]["skos:notation"], {"@type": "xsd:string"})
        self.assertIsNone(REPAIR.only_added_context_entries(before, after, tmpl))

    def test_a_term_the_template_leaves_open_is_not_invented(self):
        tmpl = self.template_with({"Name": child()}, {"loose": {"type": "string"}})
        before = {"@context": {}}
        after, _changes = REPAIR.complete_instance_context(before, tmpl)
        self.assertNotIn("loose", after["@context"])

    def test_a_term_already_there_is_never_rewritten(self):
        tmpl = self.template_with({"Name": child()})
        before = {"@context": {"Name": "https://example.org/other"}}
        after, changes = REPAIR.complete_instance_context(before, tmpl)
        self.assertEqual(after["@context"]["Name"], "https://example.org/other")
        self.assertEqual(changes, [])

    def test_the_invariant_catches_a_term_written_with_the_wrong_value(self):
        tmpl = self.template_with({"Name": child()})
        before = {"@context": {}}
        self.assertEqual(
            REPAIR.only_added_context_entries(before, {"@context": {"Name": "https://example.org/x"}}, tmpl),
            "/@context/Name")


class RestateInstanceLiteralTest(unittest.TestCase):
    """A number and the digits that spell it are the same literal; the schema pins which is stored."""

    def literal_typed(self, types):
        node = child()
        node["properties"] = {"@value": {"type": types}}
        return node

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_a_number_becomes_the_string_the_schema_states(self):
        tmpl = self.template_with({"Count": self.literal_typed(["string", "null"])})
        before = {"Count": {"@value": 826}}
        after, changes = REPAIR.restate_instance_literal(before, tmpl)
        self.assertEqual(after["Count"]["@value"], "826")
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_restated_literals(before, after, tmpl))

    def test_a_numeric_string_becomes_the_number_the_schema_states(self):
        tmpl = self.template_with({"Count": self.literal_typed(["number", "null"])})
        before = {"Count": {"@value": "124351"}}
        after, _changes = REPAIR.restate_instance_literal(before, tmpl)
        self.assertEqual(after["Count"]["@value"], 124351)
        self.assertIsNone(REPAIR.only_restated_literals(before, after, tmpl))

    def test_text_that_is_not_a_number_is_left_exactly_as_it_is(self):
        tmpl = self.template_with({"Count": self.literal_typed(["number", "null"])})
        after, changes = REPAIR.restate_instance_literal({"Count": {"@value": "LSJDK=1213"}}, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Count"]["@value"], "LSJDK=1213")

    def test_a_string_that_would_not_spell_itself_back_is_refused(self):
        tmpl = self.template_with({"Count": self.literal_typed(["number", "null"])})
        for text in ("007", "1e3", " 5", "5 ", "+5"):
            after, changes = REPAIR.restate_instance_literal({"Count": {"@value": text}}, tmpl)
            self.assertEqual(changes, [], text)
            self.assertEqual(after["Count"]["@value"], text)

    def test_a_null_is_not_a_literal_to_restate(self):
        tmpl = self.template_with({"Count": self.literal_typed(["number", "null"])})
        _after, changes = REPAIR.restate_instance_literal({"Count": {"@value": None}}, tmpl)
        self.assertEqual(changes, [])

    def test_a_boolean_is_never_restated_as_a_number(self):
        tmpl = self.template_with({"Count": self.literal_typed(["number", "null"])})
        _after, changes = REPAIR.restate_instance_literal({"Count": {"@value": True}}, tmpl)
        self.assertEqual(changes, [])

    def test_the_invariant_catches_a_literal_that_says_something_else(self):
        tmpl = self.template_with({"Count": self.literal_typed(["string", "null"])})
        before = {"Count": {"@value": 826}}
        self.assertEqual(REPAIR.only_restated_literals(before, {"Count": {"@value": "827"}}, tmpl),
                         "/Count/@value")


class DropStaticFieldFromInstanceTest(unittest.TestCase):
    """A static field renders in the form and holds nothing, so it is not a property of an instance."""

    def static(self):
        node = child(STATIC_TYPE)
        node["_ui"] = {"inputType": "sectionbreak"}
        return node

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_an_empty_static_field_is_removed(self):
        tmpl = self.template_with({"Heading": self.static(), "Name": child()})
        before = {"@context": {"Heading": GOOD_IRI + "Heading"}, "Heading": {},
                  "Name": {"@value": "Ada"}}
        after, changes = REPAIR.drop_static_field_from_instance(before, tmpl)
        self.assertNotIn("Heading", after)
        self.assertNotIn("Heading", after["@context"])
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_dropped_static_fields(before, after, tmpl))

    def test_a_static_field_holding_content_goes_and_the_record_says_what_went(self):
        # A static field has no instance representation, so text under one has nowhere in the model
        # to live; the record names it and the stored body is kept, so the loss is not silent.
        tmpl = self.template_with({"Heading": self.static()})
        before = {"@context": {}, "Heading": {"@value": "typed by someone"}}
        after, changes = REPAIR.drop_static_field_from_instance(before, tmpl)
        self.assertNotIn("Heading", after)
        self.assertIn("typed by someone", changes[0]["discarded"])
        self.assertIsNone(REPAIR.only_dropped_static_fields(before, after, tmpl))

    def test_a_field_that_is_not_static_is_never_removed(self):
        tmpl = self.template_with({"Name": child()})
        after, changes = REPAIR.drop_static_field_from_instance({"@context": {}, "Name": {}}, tmpl)
        self.assertEqual(changes, [])
        self.assertIn("Name", after)

    def test_completion_does_not_put_a_static_field_back(self):
        # The two repairs would otherwise fight: one removes the field, the other writes it again,
        # so the artifact never settles and a read-back can never confirm the write.
        tmpl = self.template_with({"Heading": self.static(), "Name": child()})
        dropped, _changes = REPAIR.drop_static_field_from_instance(
            {"@context": {}, "Heading": {}, "Name": {"@value": "Ada"}}, tmpl)
        completed, _more = REPAIR.complete_instance(dropped, tmpl)
        self.assertNotIn("Heading", completed)

    def test_the_invariant_catches_an_ordinary_field_going_with_it(self):
        tmpl = self.template_with({"Heading": self.static(), "Name": child()})
        before = {"@context": {}, "Heading": {}, "Name": {}}
        self.assertEqual(REPAIR.only_dropped_static_fields(before, {"@context": {}}, tmpl), "/Name")


class ErrorPatternTest(unittest.TestCase):
    """Target selection anchors a pattern at the start of the validator's message."""

    def selects(self, name, message):
        pattern = REPAIR.REPAIRS[name].error_pattern
        return re.match(pattern, message) is not None

    def test_a_complaint_naming_its_location_first_is_still_selected(self):
        self.assertTrue(self.selects("wrap-instance-occurrence",
                                     "/Date: object found, array expected"))
        self.assertTrue(self.selects("unwrap-instance-occurrence",
                                     "/dataType: array found, object expected"))
        self.assertTrue(self.selects("restate-instance-literal",
                                     "/Count/@value: integer found, [string, null] expected"))

    def test_a_context_mismatch_inside_an_element_is_selected(self):
        self.assertTrue(self.selects(
            "align-instance-context-iris",
            "/Person/@context/ORCID: does not have a value in the enumeration [\"x\"]"))
        self.assertTrue(self.selects(
            "align-instance-context-iris",
            "/@context/ORCID: does not have a value in the enumeration [\"x\"]"))

    def test_the_value_shape_repair_selects_both_of_its_complaints(self):
        self.assertTrue(self.selects("settle-instance-empty-shape",
                                     "object has missing required properties (['@value'])"))
        self.assertTrue(self.selects(
            "settle-instance-empty-shape",
            "object instance has properties which are not allowed by the schema: ['@value']"))

    def test_every_repair_naming_a_pattern_can_match_something(self):
        for name, repair in REPAIR.REPAIRS.items():
            if repair.error_pattern:
                re.compile(repair.error_pattern)


class SettleInstanceIriValueTest(unittest.TestCase):
    """A controlled-term field's schema names no @value, so one carried there cannot validate."""

    def iri_field(self, **constraints):
        node = child()
        node["properties"] = {"@id": {"type": "string", "format": "uri"},
                              "rdfs:label": {"type": ["string", "null"]}}
        node["_valueConstraints"] = constraints or {"ontologies": [{"acronym": "X"}]}
        return node

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_an_empty_value_key_simply_goes(self):
        tmpl = self.template_with({"Term": self.iri_field()})
        before = {"Term": {"@value": None, "@type": "urn:t"}}
        after, changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(after["Term"], {"@type": "urn:t"})
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_settled_iri_values(before, after, tmpl))

    def test_an_absolute_iri_is_restated_as_the_identifier(self):
        tmpl = self.template_with({"Link": self.iri_field()})
        before = {"Link": {"@value": "https://example.org/a"}}
        after, _changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(after["Link"], {"@id": "https://example.org/a"})
        self.assertIsNone(REPAIR.only_settled_iri_values(before, after, tmpl))

    def test_an_iri_repeating_the_identifier_already_there_just_goes(self):
        tmpl = self.template_with({"Link": self.iri_field()})
        before = {"Link": {"@id": "https://example.org/a", "@value": "https://example.org/a"}}
        after, _changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(after["Link"], {"@id": "https://example.org/a"})

    def test_a_label_is_left_exactly_as_it_stands(self):
        tmpl = self.template_with({"Term": self.iri_field()})
        before = {"Term": {"@value": "Tatum, J. L."}}
        after, changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Term"], before["Term"])

    def test_text_beside_a_different_identifier_is_left_alone(self):
        tmpl = self.template_with({"Term": self.iri_field()})
        before = {"Term": {"@id": "https://example.org/mit", "rdfs:label": "MIT", "@value": "asd"}}
        after, changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Term"], before["Term"])

    def test_a_literal_field_is_never_touched(self):
        tmpl = self.template_with({"Name": child()})
        before = {"Name": {"@value": None}}
        after, changes = REPAIR.settle_instance_iri_value(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Name"], before["Name"])

    def test_the_invariant_catches_a_label_being_forced_into_the_identifier(self):
        tmpl = self.template_with({"Term": self.iri_field()})
        before = {"Term": {"@value": "Tatum, J. L."}}
        # Two keys differ, so which the walk reaches first is not fixed; that it refuses is the point.
        fault = REPAIR.only_settled_iri_values(before, {"Term": {"@id": "Tatum, J. L."}}, tmpl)
        self.assertIsNotNone(fault)
        self.assertTrue(fault.startswith("/Term"), fault)

    def test_the_repair_is_settled_after_one_pass(self):
        tmpl = self.template_with({"Link": self.iri_field()})
        once, first = REPAIR.settle_instance_iri_value({"Link": {"@value": "https://example.org/a"}}, tmpl)
        _twice, second = REPAIR.settle_instance_iri_value(once, tmpl)
        self.assertTrue(first)
        self.assertEqual(second, [])


class SettleInstanceTermLabelTest(unittest.TestCase):
    """A label names a term; which IRI it names is a fact about the field's own ontology."""

    TERM = {"@id": "http://purl.bioontology.org/ontology/NCBITAXON/9606",
            "rdfs:label": "Homo sapiens"}

    def setUp(self):
        # BASE is defined further down the file, so this is read when the test runs, not at import.
        self.TID = BASE + "templates/t-terms"
        REPAIR.TERMS.clear()

    def tearDown(self):
        REPAIR.TERMS.clear()

    def iri_field(self):
        node = child()
        node["properties"] = {"@id": {"type": "string", "format": "uri"},
                              "rdfs:label": {"type": ["string", "null"]}}
        node["_valueConstraints"] = {"branches": [{"acronym": "NCBITAXON"}]}
        return node

    def tmpl(self, children):
        doc = template(children, root=self.TID)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def instance(self, **values):
        return {"schema:isBasedOn": self.TID, "@context": {}, **values}

    def test_a_label_becomes_the_term_the_table_names(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        before = self.instance(Species={"@value": "homo sapiens"})
        after, changes = REPAIR.settle_instance_term_label(before, tmpl)
        self.assertEqual(after["Species"], self.TERM)
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_settled_term_labels(before, after, tmpl))

    def test_a_label_mapped_to_nothing_empties_the_field(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"NA": None}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        before = self.instance(Species={"@value": "NA"})
        after, _changes = REPAIR.settle_instance_term_label(before, tmpl)
        self.assertEqual(after["Species"], {})
        self.assertIsNone(REPAIR.only_settled_term_labels(before, after, tmpl))

    def test_a_label_the_table_does_not_name_is_left_alone(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        after, changes = REPAIR.settle_instance_term_label(
            self.instance(Species={"@value": "mus musculus"}), tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Species"], {"@value": "mus musculus"})

    def test_a_value_already_pointing_at_a_term_is_never_rewritten(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        held = {"@id": "http://example.org/other", "@value": "homo sapiens"}
        after, changes = REPAIR.settle_instance_term_label(self.instance(Species=held), tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["Species"], held)

    def test_a_repeating_field_is_settled_at_every_occurrence(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        node = {"type": "array", "items": self.iri_field()}
        tmpl = self.tmpl({"Species": node})
        before = self.instance(Species=[{"@value": "homo sapiens"}, {"@value": "homo sapiens"}])
        after, _changes = REPAIR.settle_instance_term_label(before, tmpl)
        self.assertEqual(after["Species"], [self.TERM, self.TERM])
        self.assertIsNone(REPAIR.only_settled_term_labels(before, after, tmpl))

    def test_a_literal_field_is_never_touched(self):
        REPAIR.TERMS[self.TID] = {"/Name": {"Ada": self.TERM}}
        tmpl = self.tmpl({"Name": child()})
        after, changes = REPAIR.settle_instance_term_label(
            self.instance(Name={"@value": "Ada"}), tmpl)
        self.assertEqual(changes, [])

    def test_a_template_the_table_says_nothing_about_changes_nothing(self):
        tmpl = self.tmpl({"Species": self.iri_field()})
        after, changes = REPAIR.settle_instance_term_label(
            self.instance(Species={"@value": "homo sapiens"}), tmpl)
        self.assertEqual(changes, [])

    def test_the_invariant_catches_a_term_the_table_does_not_name(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        before = self.instance(Species={"@value": "homo sapiens"})
        fault = REPAIR.only_settled_term_labels(
            before, self.instance(Species={"@id": "http://example.org/wrong"}), tmpl)
        self.assertIsNotNone(fault)

    def test_the_repair_is_settled_after_one_pass(self):
        REPAIR.TERMS[self.TID] = {"/Species": {"homo sapiens": self.TERM}}
        tmpl = self.tmpl({"Species": self.iri_field()})
        once, first = REPAIR.settle_instance_term_label(
            self.instance(Species={"@value": "homo sapiens"}), tmpl)
        _twice, second = REPAIR.settle_instance_term_label(once, tmpl)
        self.assertTrue(first)
        self.assertEqual(second, [])


class FreeControlledFieldTest(unittest.TestCase):
    """Where the terminology has no term for what people write, the template is what needs changing."""

    def setUp(self):
        REPAIR.FREE_FIELDS.clear()
        self.tid = BASE + "templates/t-free"

    def tearDown(self):
        REPAIR.FREE_FIELDS.clear()

    def controlled(self, multiple=False):
        node = child()
        node["properties"] = {"@id": {"type": "string", "format": "uri"},
                              "@type": {"type": "string"},
                              "rdfs:label": {"type": ["string", "null"]}}
        node["_valueConstraints"] = {"branches": [{"acronym": "BAO"}], "ontologies": [],
                                     "classes": [], "valueSets": [], "requiredValue": False}
        return {"type": "array", "items": node} if multiple else node

    def tmpl(self, children):
        return template(children, root=self.tid)

    def test_the_value_loses_its_identifier_and_gains_a_literal(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled()})
        after, changes = REPAIR.free_controlled_field(before)
        holder = after["properties"]["Mod_type"]
        self.assertNotIn("@id", holder["properties"])
        self.assertEqual(holder["properties"]["@value"], {"type": ["string", "null"]})
        self.assertTrue(changes)
        self.assertIsNone(REPAIR.only_freed_controlled_fields(before, after))

    def test_the_term_constraints_are_emptied(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled()})
        after, _changes = REPAIR.free_controlled_field(before)
        self.assertEqual(after["properties"]["Mod_type"]["_valueConstraints"]["branches"], [])
        self.assertIs(after["properties"]["Mod_type"]["_valueConstraints"]["requiredValue"], False)

    def test_a_repeating_field_is_freed_inside_its_items(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled(multiple=True)})
        after, _changes = REPAIR.free_controlled_field(before)
        holder = after["properties"]["Mod_type"]["items"]
        self.assertIn("@value", holder["properties"])
        self.assertNotIn("@id", holder["properties"])
        self.assertIsNone(REPAIR.only_freed_controlled_fields(before, after))

    def test_a_field_not_named_is_left_exactly_as_it_is(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled(), "Type": self.controlled()})
        after, _changes = REPAIR.free_controlled_field(before)
        self.assertEqual(after["properties"]["Type"], before["properties"]["Type"])

    def test_a_field_already_free_is_not_changed_twice(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Name"]
        before = self.tmpl({"Name": child()})
        after, changes = REPAIR.free_controlled_field(before)
        self.assertEqual(changes, [])
        self.assertEqual(after, before)

    def test_a_template_not_named_changes_nothing(self):
        before = self.tmpl({"Mod_type": self.controlled()})
        after, changes = REPAIR.free_controlled_field(before)
        self.assertEqual(changes, [])
        self.assertEqual(after, before)

    def test_the_invariant_catches_another_field_being_freed(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled(), "Type": self.controlled()})
        after, _changes = REPAIR.free_controlled_field(before)
        after["properties"]["Type"]["properties"].pop("@id")
        self.assertIsNotNone(REPAIR.only_freed_controlled_fields(before, after))

    def test_the_invariant_catches_the_label_being_dropped(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        before = self.tmpl({"Mod_type": self.controlled()})
        after, _changes = REPAIR.free_controlled_field(before)
        after["properties"]["Mod_type"]["properties"].pop("rdfs:label")
        self.assertIsNotNone(REPAIR.only_freed_controlled_fields(before, after))

    def test_the_repair_is_settled_after_one_pass(self):
        REPAIR.FREE_FIELDS[self.tid] = ["Mod_type"]
        once, first = REPAIR.free_controlled_field(self.tmpl({"Mod_type": self.controlled()}))
        _twice, second = REPAIR.free_controlled_field(once)
        self.assertTrue(first)
        self.assertEqual(second, [])


class SchemaKeyDemandTest(unittest.TestCase):
    """A few templates render with pav:version among the properties an instance must carry."""

    def test_a_key_the_template_requires_is_kept(self):
        tmpl = template({"Name": child()})
        tmpl["required"] = ["@context", "@id", "pav:version"]
        before = {"@context": {}, "pav:version": "1.0.0", "bibo:status": "bibo:published"}
        after, _changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        self.assertEqual(after["pav:version"], "1.0.0")
        self.assertNotIn("bibo:status", after)
        self.assertIsNone(REPAIR.only_dropped_schema_keys(before, after, tmpl))

    def test_the_invariant_catches_a_required_key_being_removed(self):
        tmpl = template({"Name": child()})
        tmpl["required"] = ["@context", "pav:version"]
        before = {"@context": {}, "pav:version": "1.0.0"}
        self.assertEqual(REPAIR.only_dropped_schema_keys(before, {"@context": {}}, tmpl),
                         "/pav:version")

if __name__ == "__main__":
    unittest.main()


FIELD_TYPE = "https://schema.metadatacenter.org/core/TemplateField"
ELEMENT_TYPE = "https://schema.metadatacenter.org/core/TemplateElement"
STATIC_TYPE = "https://schema.metadatacenter.org/core/StaticTemplateField"
BASE = "https://repo.metadatacenter.org/"

mint = REPAIR.mint_child_ids
mint_invariant = REPAIR.only_minted_child_ids


def child(at_type=FIELD_TYPE, identifier=None, **extra):
    node = {"@type": at_type, "type": "object", "_ui": {"inputType": "textfield"},
            "schema:schemaVersion": AUDIT_MODEL_VERSION,
            "properties": {"@value": {"type": ["string", "null"]}}}
    if identifier is not None:
        node["@id"] = identifier
    node.update(extra)
    return node


def template(children, root=BASE + "templates/9d1f0b8e-1f3c-4a2b-9f77-2b1a7c3d4e5f"):
    return {"@id": root, "@type": "https://schema.metadatacenter.org/core/Template",
            "schema:name": "Study", "title": "Study template schema",
            "schema:schemaVersion": AUDIT_MODEL_VERSION,
            "type": "object", "_ui": {"order": list(children)},
            "properties": {"@context": {"properties": {}, "required": []}, **children}}


class MintTransformTest(unittest.TestCase):

    def test_a_field_child_with_no_identifier_is_minted_under_template_fields(self):
        after, changes = mint(template({"Name": child()}))
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["path"], "/properties/Name/@id")
        self.assertIsNone(changes[0]["replaced"])
        self.assertEqual(changes[0]["kind"], "field")
        self.assertTrue(after["properties"]["Name"]["@id"].startswith(BASE + "template-fields/"))

    def test_an_element_child_is_minted_under_template_elements(self):
        after, changes = mint(template({"Address": child(ELEMENT_TYPE)}))
        self.assertEqual(changes[0]["kind"], "element")
        self.assertTrue(after["properties"]["Address"]["@id"].startswith(BASE + "template-elements/"))

    def test_a_static_field_is_minted_as_a_field(self):
        _after, changes = mint(template({"Note": child(STATIC_TYPE)}))
        self.assertEqual(changes[0]["kind"], "field")

    def test_an_unusable_value_is_recorded_before_it_is_replaced(self):
        for bad in ("", "   ", "tmp-1234", "/relative/path", None, 42):
            with self.subTest(bad=bad):
                _after, changes = mint(template({"Name": child(identifier=bad)}))
                self.assertEqual(len(changes), 1, bad)
                self.assertEqual(changes[0]["replaced"], bad)

    def test_a_usable_identifier_is_left_exactly_as_stored(self):
        kept = BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        after, changes = mint(template({"Name": child(identifier=kept)}))
        self.assertEqual(changes, [])
        self.assertEqual(after["properties"]["Name"]["@id"], kept)

    def test_it_reaches_a_child_nested_inside_an_element(self):
        inner = child(identifier="")
        outer = child(ELEMENT_TYPE, identifier="")
        outer["properties"] = {"@context": {"properties": {}}, "Street": inner}
        after, changes = mint(template({"Address": outer}))
        self.assertEqual(sorted(c["path"] for c in changes),
                         ["/properties/Address/@id", "/properties/Address/properties/Street/@id"])
        self.assertTrue(after["properties"]["Address"]["properties"]["Street"]["@id"]
                        .startswith(BASE + "template-fields/"))

    def test_it_reaches_a_multi_instance_child_through_its_items(self):
        after, changes = mint(template({"Names": {"type": "array", "minItems": 1,
                                                  "items": child(identifier="")}}))
        self.assertEqual(changes[0]["path"], "/properties/Names/items/@id")
        self.assertTrue(after["properties"]["Names"]["items"]["@id"].startswith(BASE + "template-fields/"))
        self.assertEqual(after["properties"]["Names"]["minItems"], 1)

    def test_the_root_identifier_is_never_touched(self):
        doc = template({"Name": child(identifier="")})
        after, _changes = mint(doc)
        self.assertEqual(after["@id"], doc["@id"])

    def test_a_second_pass_mints_nothing(self):
        once, first = mint(template({"Name": child(), "Address": child(ELEMENT_TYPE)}))
        twice, second = mint(once)
        self.assertEqual(len(first), 2)
        self.assertEqual(second, [])
        self.assertEqual(twice, once)

    def test_the_input_is_not_mutated(self):
        doc = template({"Name": child(identifier="")})
        mint(doc)
        self.assertEqual(doc["properties"]["Name"]["@id"], "")

    def test_it_declines_an_artifact_whose_root_identifier_says_nothing(self):
        for root in (None, "", "not-a-uri", "https://repo.metadatacenter.org/unknown-kind/abc"):
            with self.subTest(root=root):
                doc = template({"Name": child()}, root=root) if root is not None else template({"Name": child()})
                if root is None:
                    del doc["@id"]
                with self.assertRaises(REPAIR.TransformRefused):
                    mint(doc)

    def test_the_base_follows_the_artifact_rather_than_a_hardcoded_host(self):
        other = "https://repo.example.org/"
        after, _changes = mint(template({"Name": child()}, root=other + "templates/x"))
        self.assertTrue(after["properties"]["Name"]["@id"].startswith(other + "template-fields/"))


class MintInvariantTest(unittest.TestCase):

    def test_accepts_what_the_transform_produces(self):
        before = template({"Name": child(identifier=""), "Address": child(ELEMENT_TYPE)})
        after, _changes = mint(before)
        self.assertIsNone(mint_invariant(before, after))

    def test_rejects_a_usable_identifier_that_moved(self):
        kept = BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        before = template({"Name": child(identifier=kept)})
        after = copy.deepcopy(before)
        after["properties"]["Name"]["@id"] = BASE + "template-fields/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.assertEqual(mint_invariant(before, after), "/properties/Name/@id")

    def test_rejects_an_element_minted_under_the_field_prefix(self):
        before = template({"Address": child(ELEMENT_TYPE, identifier="")})
        after = copy.deepcopy(before)
        after["properties"]["Address"]["@id"] = BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.assertEqual(mint_invariant(before, after), "/properties/Address/@id")

    def test_rejects_an_identifier_that_is_not_a_fresh_uuid(self):
        before = template({"Name": child(identifier="")})
        after = copy.deepcopy(before)
        after["properties"]["Name"]["@id"] = BASE + "template-fields/not-a-uuid"
        self.assertEqual(mint_invariant(before, after), "/properties/Name/@id")

    def test_rejects_a_root_identifier_rewritten_as_a_child(self):
        before = template({"Name": child(identifier="")})
        after, _changes = mint(before)
        after["@id"] = BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.assertEqual(mint_invariant(before, after), "/@id")

    def test_rejects_any_other_change_alongside_a_legitimate_mint(self):
        before = template({"Name": child(identifier="")})
        after, _changes = mint(before)
        after["properties"]["Name"]["_ui"]["inputType"] = "numeric"
        self.assertEqual(mint_invariant(before, after), "/properties/Name/_ui/inputType")

    def test_rejects_a_removed_key(self):
        before = template({"Name": child(identifier="")})
        after, _changes = mint(before)
        del after["properties"]["Name"]["_ui"]
        self.assertEqual(mint_invariant(before, after), "/properties/Name/_ui")


class TargetUnionTest(unittest.TestCase):

    def test_several_conditions_select_the_union_once_each(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        for row in [
            {"artifactType": "template", "artifactId": "t1", "artifactName": "",
             "conditionRules": {"derived-from-empty": 1}},
            {"artifactType": "element", "artifactId": "e1", "artifactName": "",
             "conditionRules": {"child-id-unusable": 2}},
            {"artifactType": "element", "artifactId": "e2", "artifactName": "",
             "conditionRules": {"child-id-unusable": 1, "derived-from-empty": 3}},
            {"artifactType": "field", "artifactId": "f1", "artifactName": "",
             "conditionRules": {"title-not-canonical": 1}},
        ]:
            handle.write(json.dumps(row) + "\n")
        handle.close()
        path = pathlib.Path(handle.name)
        refs = REPAIR.targets_from_records(path, ["derived-from-empty", "child-id-unusable"], [], parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1", "e2"])
        path.unlink()


class ChainTest(unittest.TestCase):
    """An artifact carrying both defects: neither repair alone can produce a writable body."""

    def both_defects(self):
        doc = template({"Name": child(identifier="")})
        doc["pav:derivedFrom"] = ""
        doc["properties"]["Name"]["pav:derivedFrom"] = ""
        return doc

    def test_each_repair_alone_leaves_the_other_defect_in_place(self):
        doc = self.both_defects()
        minted, _ = REPAIR.mint_child_ids(doc)
        self.assertEqual(minted["pav:derivedFrom"], "")
        stripped, _ = REPAIR.strip_empty_derived_from(doc)
        self.assertEqual(stripped["properties"]["Name"]["@id"], "")

    def test_the_chain_fixes_both_and_every_stage_is_verified(self):
        doc = self.both_defects()
        chain = [REPAIR.REPAIRS["mint-child-ids"], REPAIR.REPAIRS["empty-derived-from"]]
        after, changes = REPAIR.apply_repairs(chain, doc)
        self.assertNotIn("pav:derivedFrom", after)
        self.assertNotIn("pav:derivedFrom", after["properties"]["Name"])
        self.assertTrue(after["properties"]["Name"]["@id"].startswith(BASE + "template-fields/"))
        self.assertEqual(sorted({c["repair"] for c in changes}),
                         ["empty-derived-from", "mint-child-ids"])

    def test_the_order_of_the_chain_does_not_change_the_result(self):
        forward = REPAIR.apply_repairs([REPAIR.REPAIRS["mint-child-ids"],
                                        REPAIR.REPAIRS["empty-derived-from"]], self.both_defects())[0]
        backward = REPAIR.apply_repairs([REPAIR.REPAIRS["empty-derived-from"],
                                         REPAIR.REPAIRS["mint-child-ids"]], self.both_defects())[0]
        forward["properties"]["Name"]["@id"] = backward["properties"]["Name"]["@id"] = "same"
        self.assertEqual(forward, backward)

    def test_a_stage_that_breaks_its_invariant_stops_the_chain(self):
        def vandal(artifact):
            doc = copy.deepcopy(artifact)
            doc["schema:name"] = "rewritten"
            return doc, [{"path": "/schema:name", "replaced": None, "wrote": "rewritten"}]

        chain = [REPAIR.Repair("vandal", "x", "y", vandal, REPAIR.only_removed_empty_derived_from)]
        with self.assertRaises(REPAIR.InvariantFailed) as caught:
            REPAIR.apply_repairs(chain, template({"Name": child()}))
        self.assertIn("/schema:name", str(caught.exception))

    def test_a_chain_over_a_clean_artifact_reports_no_change(self):
        clean = template({"Name": child(identifier=BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")})
        _after, changes = REPAIR.apply_repairs(
            [REPAIR.REPAIRS["mint-child-ids"], REPAIR.REPAIRS["empty-derived-from"]], clean)
        self.assertEqual(changes, [])


AUDIT_MODEL_VERSION = REPAIR.audit.MODEL_VERSION
mint_iris = REPAIR.mint_property_iris
iri_invariant = REPAIR.only_minted_property_iris
IRI_PREFIX = REPAIR.PROPERTY_IRI_PREFIX
GOOD_IRI = IRI_PREFIX + "11111111-2222-3333-4444-555555555555"


def mapped(children, mappings):
    doc = template(children)
    doc["properties"]["@context"]["properties"] = dict(mappings)
    doc["properties"]["@context"]["required"] = list(mappings)
    return doc


class PropertyIriTransformTest(unittest.TestCase):

    def test_replaces_an_empty_mapping_with_a_minted_iri(self):
        after, changes = mint_iris(mapped({"Name": child()}, {"Name": {"enum": [""]}}))
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["path"], "/properties/@context/properties/Name/enum/0")
        self.assertEqual(changes[0]["replaced"], "")
        self.assertEqual(changes[0]["child"], "Name")
        value = after["properties"]["@context"]["properties"]["Name"]["enum"][0]
        self.assertTrue(value.startswith(IRI_PREFIX))

    def test_leaves_a_usable_mapping_alone(self):
        doc = mapped({"Name": child()}, {"Name": {"enum": [GOOD_IRI]}})
        after, changes = mint_iris(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after["properties"]["@context"]["properties"]["Name"]["enum"], [GOOD_IRI])

    def test_an_absent_mapping_is_deliberately_out_of_scope(self):
        after, changes = mint_iris(mapped({"Name": child()}, {}))
        self.assertEqual(changes, [])
        self.assertNotIn("Name", after["properties"]["@context"]["properties"])

    def test_context_required_is_not_touched(self):
        doc = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        doc["properties"]["@context"]["required"] = []
        after, _changes = mint_iris(doc)
        self.assertEqual(after["properties"]["@context"]["required"], [])

    def test_other_keys_of_the_mapping_survive(self):
        doc = mapped({"Name": child()}, {"Name": {"enum": [""], "@type": "@id"}})
        after, _changes = mint_iris(doc)
        self.assertEqual(after["properties"]["@context"]["properties"]["Name"]["@type"], "@id")

    def test_it_reaches_a_mapping_inside_a_nested_element(self):
        inner = child()
        element = child(ELEMENT_TYPE, identifier=BASE + "template-elements/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        element["_ui"] = {"order": ["Street"]}
        element["properties"] = {"@context": {"properties": {"Street": {"enum": [""]}}, "required": []},
                                 "Street": inner}
        _after, changes = mint_iris(mapped({"Address": element}, {"Address": {"enum": [GOOD_IRI]}}))
        self.assertEqual([c["path"] for c in changes],
                         ["/properties/Address/properties/@context/properties/Street/enum/0"])

    def test_a_second_pass_mints_nothing(self):
        once, first = mint_iris(mapped({"Name": child()}, {"Name": {"enum": [""]}}))
        _twice, second = mint_iris(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_the_input_is_not_mutated(self):
        doc = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        mint_iris(doc)
        self.assertEqual(doc["properties"]["@context"]["properties"]["Name"]["enum"], [""])


class PropertyIriInvariantTest(unittest.TestCase):

    def test_accepts_what_the_transform_produces(self):
        before = mapped({"Name": child(), "Age": child()},
                        {"Name": {"enum": [""]}, "Age": {"enum": [GOOD_IRI]}})
        after, _changes = mint_iris(before)
        self.assertIsNone(iri_invariant(before, after))

    def test_rejects_a_usable_mapping_that_moved(self):
        before = mapped({"Name": child()}, {"Name": {"enum": [GOOD_IRI]}})
        after = copy.deepcopy(before)
        after["properties"]["@context"]["properties"]["Name"]["enum"] = [IRI_PREFIX + "99999999-2222-3333-4444-555555555555"]
        self.assertIsNotNone(iri_invariant(before, after))

    def test_rejects_a_value_minted_outside_the_property_namespace(self):
        before = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        after = copy.deepcopy(before)
        after["properties"]["@context"]["properties"]["Name"]["enum"] = ["https://example.org/whatever"]
        self.assertIsNotNone(iri_invariant(before, after))

    def test_rejects_a_changed_enum_that_is_not_a_property_mapping(self):
        before = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        before["properties"]["Name"]["_valueConstraints"] = {"literals": {"enum": [""]}}
        after = copy.deepcopy(before)
        after["properties"]["Name"]["_valueConstraints"]["literals"]["enum"] = [IRI_PREFIX + "11111111-2222-3333-4444-555555555555"]
        self.assertIsNotNone(iri_invariant(before, after))

    def test_rejects_any_other_change(self):
        before = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        after, _changes = mint_iris(before)
        after["properties"]["Name"]["_ui"]["inputType"] = "numeric"
        self.assertEqual(iri_invariant(before, after), "/properties/Name/_ui/inputType")

    def test_rejects_an_added_or_removed_mapping(self):
        before = mapped({"Name": child()}, {"Name": {"enum": [""]}})
        added = copy.deepcopy(before)
        added["properties"]["@context"]["properties"]["Ghost"] = {"enum": [GOOD_IRI]}
        self.assertIsNotNone(iri_invariant(before, added))
        removed = copy.deepcopy(before)
        del removed["properties"]["@context"]["properties"]["Name"]
        self.assertIsNotNone(iri_invariant(before, removed))


class ForeignIdentifierTest(unittest.TestCase):
    """A valid identifier is left alone whatever namespace it is in.

    Usability is decided by the server's own test, which asks only whether a value is an absolute IRI.
    An artifact may legitimately carry identifiers CEDAR did not mint, and a repair must not tidy them
    into its own namespace.
    """

    FOREIGN = [
        "https://purl.obolibrary.org/obo/OBI_0000070",
        "http://example.org/schemas/my-field",
        "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "doi:10.1234/some.field",
        "https://repo.example.org/template-fields/not-a-uuid-at-all",
        "https://schema.metadatacenter.org/properties/legacy-name-not-a-uuid",
    ]

    def test_a_foreign_child_identifier_is_not_minted_over(self):
        for identifier in self.FOREIGN:
            with self.subTest(identifier=identifier):
                doc = template({"Name": child(identifier=identifier)})
                after, changes = mint(doc)
                self.assertEqual(changes, [])
                self.assertEqual(after["properties"]["Name"]["@id"], identifier)

    def test_the_child_identifier_invariant_refuses_to_let_one_change(self):
        for identifier in self.FOREIGN:
            with self.subTest(identifier=identifier):
                before = template({"Name": child(identifier=identifier)})
                after = copy.deepcopy(before)
                after["properties"]["Name"]["@id"] = BASE + "template-fields/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
                self.assertEqual(mint_invariant(before, after), "/properties/Name/@id")

    def test_a_foreign_property_iri_is_not_minted_over(self):
        for identifier in self.FOREIGN:
            with self.subTest(identifier=identifier):
                doc = mapped({"Name": child()}, {"Name": {"enum": [identifier]}})
                after, changes = mint_iris(doc)
                self.assertEqual(changes, [])
                self.assertEqual(after["properties"]["@context"]["properties"]["Name"]["enum"], [identifier])

    def test_the_property_iri_invariant_refuses_to_let_one_change(self):
        for identifier in self.FOREIGN:
            with self.subTest(identifier=identifier):
                before = mapped({"Name": child()}, {"Name": {"enum": [identifier]}})
                after = copy.deepcopy(before)
                after["properties"]["@context"]["properties"]["Name"]["enum"] = [IRI_PREFIX + "11111111-2222-3333-4444-555555555555"]
                self.assertIsNotNone(iri_invariant(before, after))

    def test_an_artifact_whose_root_is_foreign_still_repairs_its_children(self):
        # The identifier base follows the artifact, so a deployment CEDAR did not mint is served too.
        doc = template({"Name": child(identifier="")}, root="https://repo.example.org/templates/abc")
        after, changes = mint(doc)
        self.assertEqual(len(changes), 1)
        self.assertTrue(after["properties"]["Name"]["@id"].startswith("https://repo.example.org/template-fields/"))

    def test_only_a_genuinely_unusable_value_is_replaced(self):
        for bad in ("", "   ", "not a uri", "relative/path", "#fragment-only"):
            with self.subTest(bad=bad):
                _after, changes = mint(template({"Name": child(identifier=bad)}))
                self.assertEqual(len(changes), 1, bad)


align = REPAIR.align_instance_context_iris
align_invariant = REPAIR.only_aligned_context_iris
WANTED = "https://drugtargetontology.org/property/Sex"
STALE = "https://schema.metadatacenter.org/properties/00000000-1111-2222-3333-444444444444"


def instance(context, **fields):
    doc = {"@id": "https://repo.metadatacenter.org/template-instances/i1",
           "schema:isBasedOn": "https://repo.metadatacenter.org/templates/t1",
           "schema:name": "An instance", "@context": dict(context)}
    doc.update(fields)
    return doc


def element_definition(name, children, mappings):
    node = child(ELEMENT_TYPE, identifier=BASE + "template-elements/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    node["_ui"] = {"order": list(children)}
    node["properties"] = {"@context": {"properties": dict(mappings), "required": list(mappings)}, **children}
    return node


class AlignContextTransformTest(unittest.TestCase):

    def test_a_stale_mapping_is_rewritten_to_the_one_the_template_names(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        after, changes = align(instance({"Sex": STALE}), tmpl)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["path"], "/@context/Sex")
        self.assertEqual(changes[0]["replaced"], STALE)
        self.assertEqual(changes[0]["wrote"], WANTED)
        self.assertEqual(after["@context"]["Sex"], WANTED)

    def test_a_mapping_that_already_agrees_is_untouched(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        _after, changes = align(instance({"Sex": WANTED}), tmpl)
        self.assertEqual(changes, [])

    def test_prefixes_and_system_keys_are_never_touched(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        context = {"Sex": STALE, "schema": "http://schema.org/", "pav": "http://purl.org/pav/",
                   "schema:isBasedOn": {"@type": "@id"}, "rdfs:label": {"@type": "xsd:string"}}
        after, changes = align(instance(context), tmpl)
        self.assertEqual([c["child"] for c in changes], ["Sex"])
        self.assertEqual(after["@context"]["schema"], "http://schema.org/")
        self.assertEqual(after["@context"]["schema:isBasedOn"], {"@type": "@id"})

    def test_a_name_the_template_does_not_map_is_left_alone(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        after, changes = align(instance({"Sex": WANTED, "Ghost": STALE}), tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["@context"]["Ghost"], STALE)

    def test_a_template_mapping_that_is_itself_unusable_is_not_propagated(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [""]}})
        _after, changes = align(instance({"Sex": STALE}), tmpl)
        self.assertEqual(changes, [])

    def test_a_key_the_instance_lacks_is_not_added(self):
        tmpl = mapped({"Sex": child(), "Age": child()},
                      {"Sex": {"enum": [WANTED]}, "Age": {"enum": [WANTED + "2"]}})
        after, changes = align(instance({"Sex": STALE}), tmpl)
        self.assertEqual([c["child"] for c in changes], ["Sex"])
        self.assertNotIn("Age", after["@context"])

    def test_it_reaches_an_element_occurrence_and_a_repeated_one(self):
        element = element_definition("Address", {"Street": child()}, {"Street": {"enum": [WANTED]}})
        tmpl = mapped({"Address": element}, {"Address": {"enum": [WANTED + "addr"]}})
        doc = instance({"Address": WANTED + "addr"},
                       Address=[{"@context": {"Street": STALE}}, {"@context": {"Street": WANTED}}])
        after, changes = align(doc, tmpl)
        self.assertEqual([c["path"] for c in changes], ["/Address/0/@context/Street"])
        self.assertEqual(after["Address"][0]["@context"]["Street"], WANTED)
        self.assertEqual(after["Address"][1]["@context"]["Street"], WANTED)

    def test_a_single_element_occurrence_is_reached_too(self):
        element = element_definition("Address", {"Street": child()}, {"Street": {"enum": [WANTED]}})
        tmpl = mapped({"Address": element}, {"Address": {"enum": [WANTED + "addr"]}})
        doc = instance({"Address": WANTED + "addr"}, Address={"@context": {"Street": STALE}})
        after, changes = align(doc, tmpl)
        self.assertEqual([c["path"] for c in changes], ["/Address/@context/Street"])
        self.assertEqual(after["Address"]["@context"]["Street"], WANTED)

    def test_field_values_are_never_touched(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        doc = instance({"Sex": STALE}, Sex={"@value": "female"})
        after, _changes = align(doc, tmpl)
        self.assertEqual(after["Sex"], {"@value": "female"})

    def test_a_second_pass_changes_nothing(self):
        tmpl = mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})
        once, first = align(instance({"Sex": STALE}), tmpl)
        _twice, second = align(once, tmpl)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_it_declines_when_the_template_could_not_be_read(self):
        with self.assertRaises(REPAIR.TransformRefused):
            align(instance({"Sex": STALE}), None)


class AlignContextInvariantTest(unittest.TestCase):

    def template(self):
        return mapped({"Sex": child()}, {"Sex": {"enum": [WANTED]}})

    def test_accepts_what_the_transform_produces(self):
        tmpl = self.template()
        before = instance({"Sex": STALE, "schema": "http://schema.org/"})
        after, _changes = align(before, tmpl)
        self.assertIsNone(align_invariant(before, after, tmpl))

    def test_rejects_a_mapping_moved_to_anything_but_the_template_value(self):
        tmpl = self.template()
        before = instance({"Sex": STALE})
        after = copy.deepcopy(before)
        after["@context"]["Sex"] = "https://example.org/invented"
        self.assertEqual(align_invariant(before, after, tmpl), "/@context/Sex")

    def test_rejects_a_change_to_a_name_the_template_does_not_map(self):
        tmpl = self.template()
        before = instance({"Sex": WANTED, "schema": "http://schema.org/"})
        after = copy.deepcopy(before)
        after["@context"]["schema"] = "https://schema.org/"
        self.assertEqual(align_invariant(before, after, tmpl), "/@context/schema")

    def test_rejects_an_added_or_removed_context_key(self):
        tmpl = self.template()
        before = instance({"Sex": STALE})
        added = copy.deepcopy(before); added["@context"]["Ghost"] = WANTED
        removed = instance({"Sex": STALE, "Ghost": WANTED})
        self.assertEqual(align_invariant(before, added, tmpl), "/@context")
        self.assertEqual(align_invariant(removed, before, tmpl), "/@context")

    def test_rejects_a_changed_field_value(self):
        tmpl = self.template()
        before = instance({"Sex": STALE}, Sex={"@value": "female"})
        after, _changes = align(before, tmpl)
        after["Sex"] = {"@value": "male"}
        self.assertEqual(align_invariant(before, after, tmpl), "/Sex")

    def test_rejects_a_changed_identifier_or_provenance(self):
        tmpl = self.template()
        before = instance({"Sex": STALE})
        after, _changes = align(before, tmpl)
        after["schema:isBasedOn"] = "https://repo.metadatacenter.org/templates/other"
        self.assertEqual(align_invariant(before, after, tmpl), "/schema:isBasedOn")

    def test_rejects_a_change_inside_an_element_occurrence_that_is_not_a_mapping(self):
        element = element_definition("Address", {"Street": child()}, {"Street": {"enum": [WANTED]}})
        tmpl = mapped({"Address": element}, {"Address": {"enum": [WANTED + "addr"]}})
        before = instance({"Address": WANTED + "addr"},
                          Address={"@context": {"Street": STALE}, "@id": "https://repo.example/e/1"})
        after, _changes = align(before, tmpl)
        after["Address"]["@id"] = "https://repo.example/e/2"
        self.assertEqual(align_invariant(before, after, tmpl), "/Address/@id")

    def test_refuses_outright_without_a_template(self):
        self.assertEqual(align_invariant(instance({}), instance({}), None), "/")


class InclusionListTest(unittest.TestCase):
    """--only-ids exists because a trial that takes whichever targets come first can sample a group
    the repair skips, and prove nothing about the write path."""

    def test_the_two_lists_are_read_the_same_way(self):
        # Both are a JSON array of artifact identifiers; the parser code paths mirror each other.
        self.assertIn("--only-ids", REPAIR.build_parser().format_help())
        self.assertIn("--exclude-ids", REPAIR.build_parser().format_help())


STATIC_TYPE = REPAIR.STATIC_AT_TYPE


def static_child(name="Section"):
    node = child(STATIC_TYPE, identifier=BASE + "template-fields/cccccccc-dddd-eeee-ffff-000000000000")
    node["_ui"] = {"inputType": "section-break"}
    node["schema:name"] = name
    return node


class StaticFieldDemandRepairTest(unittest.TestCase):

    def demanding(self):
        doc = template({"Section": static_child(), "Name": child()})
        doc["required"] = ["@context", "Name", "Section"]
        doc["properties"]["@context"]["required"] = ["Name", "Section"]
        doc["properties"]["@context"]["properties"] = {
            "Name": {"enum": [GOOD_IRI]}, "Section": {"enum": [GOOD_IRI + "s"]}}
        return doc

    def test_the_static_name_is_removed_from_all_three_places(self):
        after, changes = REPAIR.drop_static_field_demands(self.demanding())
        self.assertEqual(sorted(c["where"] for c in changes),
                         ["@context.properties", "@context.required", "required"])
        self.assertEqual(after["required"], ["@context", "Name"])
        self.assertEqual(after["properties"]["@context"]["required"], ["Name"])
        self.assertNotIn("Section", after["properties"]["@context"]["properties"])

    def test_the_ordinary_child_keeps_its_place_everywhere(self):
        after, _changes = REPAIR.drop_static_field_demands(self.demanding())
        self.assertIn("Name", after["required"])
        self.assertIn("Name", after["properties"]["@context"]["properties"])

    def test_the_static_child_itself_is_left_in_the_container(self):
        after, _changes = REPAIR.drop_static_field_demands(self.demanding())
        self.assertIn("Section", after["properties"])
        self.assertEqual(after["properties"]["Section"]["@type"], STATIC_TYPE)

    def test_ui_order_naming_the_static_field_is_untouched(self):
        doc = self.demanding()
        doc["_ui"]["order"] = ["Section", "Name"]
        after, _changes = REPAIR.drop_static_field_demands(doc)
        self.assertEqual(after["_ui"]["order"], ["Section", "Name"])

    def test_a_container_demanding_nothing_static_is_unchanged(self):
        doc = template({"Name": child()})
        doc["required"] = ["Name"]
        after, changes = REPAIR.drop_static_field_demands(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after, doc)

    def test_a_second_pass_changes_nothing(self):
        once, first = REPAIR.drop_static_field_demands(self.demanding())
        _twice, second = REPAIR.drop_static_field_demands(once)
        self.assertEqual(len(first), 3)
        self.assertEqual(second, [])

    def test_the_invariant_accepts_the_transform_and_rejects_a_stray_removal(self):
        before = self.demanding()
        after, _changes = REPAIR.drop_static_field_demands(before)
        self.assertIsNone(REPAIR.only_dropped_static_demands(before, after))
        after["required"].remove("Name")
        self.assertIsNotNone(REPAIR.only_dropped_static_demands(before, after))


class WrapInherentlyMultipleTest(unittest.TestCase):

    def multi(self, input_type="checkbox", **extra):
        node = child()
        node["_ui"] = {"inputType": input_type}
        if input_type == "list":
            node["_valueConstraints"] = {"multipleChoice": True}
        node.update(extra)
        return node

    def test_an_object_shaped_checkbox_becomes_an_array_around_itself(self):
        before = template({"Colours": self.multi()})
        after, changes = REPAIR.wrap_inherently_multiple(before)
        envelope = after["properties"]["Colours"]
        self.assertEqual(envelope["type"], "array")
        self.assertEqual(envelope["minItems"], 0)
        self.assertNotIn("maxItems", envelope)
        self.assertEqual(envelope["items"], before["properties"]["Colours"])
        self.assertEqual(changes[0]["inputType"], "checkbox")

    def test_a_required_value_gives_the_envelope_a_lower_bound_of_one(self):
        node = self.multi()
        node["_valueConstraints"] = {"requiredValue": True}
        after, _changes = REPAIR.wrap_inherently_multiple(template({"Colours": node}))
        self.assertEqual(after["properties"]["Colours"]["minItems"], 1)

    def test_existing_bounds_move_to_the_envelope_and_leave_the_inner_definition(self):
        node = self.multi()
        declared = dict(node, minItems=2, maxItems=5)
        after, _changes = REPAIR.wrap_inherently_multiple(template({"Colours": declared}))
        envelope = after["properties"]["Colours"]
        self.assertEqual((envelope["minItems"], envelope["maxItems"]), (2, 5))
        self.assertNotIn("minItems", envelope["items"])
        self.assertNotIn("maxItems", envelope["items"])

    def test_contradictory_bounds_are_refused_rather_than_guessed(self):
        declared = dict(self.multi(), minItems=3, maxItems=1)
        with self.assertRaises(REPAIR.TransformRefused):
            REPAIR.wrap_inherently_multiple(template({"Colours": declared}))

    def test_a_multiple_choice_list_counts_and_a_single_choice_one_does_not(self):
        after, changes = REPAIR.wrap_inherently_multiple(template({"Pick": self.multi("list")}))
        self.assertEqual(len(changes), 1)
        single = child()
        single["_ui"] = {"inputType": "list"}
        single["_valueConstraints"] = {"multipleChoice": False}
        _after, none = REPAIR.wrap_inherently_multiple(template({"Pick": single}))
        self.assertEqual(none, [])

    def test_a_child_already_deployed_as_an_array_is_left_alone(self):
        doc = template({"Colours": {"type": "array", "minItems": 1, "items": self.multi()}})
        after, changes = REPAIR.wrap_inherently_multiple(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after, doc)

    def test_the_invariant_accepts_the_transform_and_rejects_a_changed_inner_definition(self):
        before = template({"Colours": self.multi()})
        after, _changes = REPAIR.wrap_inherently_multiple(before)
        self.assertIsNone(REPAIR.only_wrapped_inherently_multiple(before, after))
        after["properties"]["Colours"]["items"]["_ui"]["inputType"] = "list"
        self.assertIsNotNone(REPAIR.only_wrapped_inherently_multiple(before, after))


class StampModelVersionTest(unittest.TestCase):

    def test_a_stale_version_is_written_forward(self):
        doc = template({"Name": child()})
        doc["schema:schemaVersion"] = "1.5.0"
        after, changes = REPAIR.stamp_model_version(doc)
        self.assertEqual(after["schema:schemaVersion"], AUDIT_MODEL_VERSION)
        self.assertEqual(changes[0]["replaced"], "1.5.0")

    def test_a_current_version_is_left_alone(self):
        doc = template({"Name": child()})
        doc["schema:schemaVersion"] = AUDIT_MODEL_VERSION
        _after, changes = REPAIR.stamp_model_version(doc)
        self.assertEqual(changes, [])

    def test_an_absent_or_malformed_version_is_refused_as_a_different_decision(self):
        for value in (None, "", "latest", 16):
            with self.subTest(value=value):
                doc = template({"Name": child()})
                if value is None:
                    doc.pop("schema:schemaVersion", None)
                else:
                    doc["schema:schemaVersion"] = value
                with self.assertRaises(REPAIR.TransformRefused):
                    REPAIR.stamp_model_version(doc)

    def test_the_invariant_rejects_any_other_change(self):
        doc = template({"Name": child()})
        doc["schema:schemaVersion"] = "1.5.0"
        after, _changes = REPAIR.stamp_model_version(doc)
        self.assertIsNone(REPAIR.only_stamped_model_version(doc, after))
        after["schema:name"] = "Renamed"
        self.assertEqual(REPAIR.only_stamped_model_version(doc, after), "/schema:name")


    def test_a_nested_stale_version_is_written_forward_with_the_root(self):
        doc = template({"Name": child(), "Address": child(ELEMENT_TYPE)})
        doc["properties"]["Name"]["schema:schemaVersion"] = "1.5.0"
        doc["properties"]["Address"]["schema:schemaVersion"] = "1.5.0"
        after, changes = REPAIR.stamp_model_version(doc)
        self.assertEqual([c["path"] for c in changes],
                         ["/properties/Name/schema:schemaVersion",
                          "/properties/Address/schema:schemaVersion"])
        self.assertEqual(after["properties"]["Name"]["schema:schemaVersion"], AUDIT_MODEL_VERSION)
        self.assertIsNone(REPAIR.only_stamped_model_version(doc, after))

    def test_a_stale_version_inside_a_multi_instance_child_is_reached(self):
        nested = child()
        nested["schema:schemaVersion"] = "1.5.0"
        doc = template({"Names": {"type": "array", "items": nested}})
        after, changes = REPAIR.stamp_model_version(doc)
        self.assertEqual([c["path"] for c in changes], ["/properties/Names/items/schema:schemaVersion"])
        self.assertEqual(after["properties"]["Names"]["items"]["schema:schemaVersion"],
                         AUDIT_MODEL_VERSION)

    def test_an_absent_nested_version_is_left_where_a_stale_one_is_repaired(self):
        doc = template({"Name": child(), "Age": child()})
        doc["properties"]["Name"]["schema:schemaVersion"] = "1.5.0"
        doc["properties"]["Age"].pop("schema:schemaVersion")
        after, changes = REPAIR.stamp_model_version(doc)
        self.assertEqual(len(changes), 1)
        self.assertNotIn("schema:schemaVersion", after["properties"]["Age"])
        self.assertIsNone(REPAIR.only_stamped_model_version(doc, after))

    def test_an_absent_nested_version_alone_refuses_rather_than_reporting_clean(self):
        doc = template({"Name": child()})
        doc["properties"]["Name"].pop("schema:schemaVersion")
        with self.assertRaises(REPAIR.TransformRefused):
            REPAIR.stamp_model_version(doc)

    def test_the_invariant_rejects_a_version_moved_anywhere_but_forward(self):
        doc = template({"Name": child()})
        doc["properties"]["Name"]["schema:schemaVersion"] = "1.5.0"
        after, _changes = REPAIR.stamp_model_version(doc)
        sideways = copy.deepcopy(after)
        sideways["properties"]["Name"]["schema:schemaVersion"] = "9.9.9"
        self.assertEqual(REPAIR.only_stamped_model_version(doc, sideways),
                         "/properties/Name/schema:schemaVersion")


class NestedTitleTest(unittest.TestCase):

    def test_a_nested_child_title_is_composed_from_its_own_name(self):
        stale = child()
        stale["schema:name"] = "Age"
        stale["title"] = "Years field schema"
        doc = template({"Age": stale})
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(after["properties"]["Age"]["title"], "Age field schema")
        self.assertEqual([c["path"] for c in changes], ["/properties/Age/title"])
        self.assertIsNone(REPAIR.only_derived_title(doc, after))

    def test_a_nested_title_is_never_composed_from_an_ancestor_name(self):
        stale = child(ELEMENT_TYPE)
        stale["schema:name"] = "Address"
        stale["title"] = "wrong"
        stale["properties"] = {"@context": {"properties": {}, "required": []}, "Street": child()}
        stale["properties"]["Street"]["schema:name"] = "Street"
        stale["properties"]["Street"]["title"] = "wrong too"
        doc = template({"Address": stale})
        after, _changes = REPAIR.derive_title(doc)
        self.assertEqual(after["properties"]["Address"]["title"], "Address element schema")
        self.assertEqual(after["properties"]["Address"]["properties"]["Street"]["title"],
                         "Street field schema")

    def test_a_child_with_no_usable_name_is_left_where_another_is_repaired(self):
        nameless = child()
        nameless.pop("schema:name", None)
        nameless["title"] = "whatever"
        stale = child()
        stale["schema:name"] = "Age"
        stale["title"] = "stale"
        doc = template({"Nameless": nameless, "Age": stale})
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(len(changes), 1)
        self.assertEqual(after["properties"]["Nameless"]["title"], "whatever")

    def test_an_unusable_root_alone_still_refuses(self):
        doc = template({"Name": child()})
        doc[REPAIR.AT_TYPE] = "Antibody Reagents"
        with self.assertRaises(REPAIR.TransformRefused):
            REPAIR.derive_title(doc)

    def test_an_at_type_that_is_not_a_string_is_read_rather_than_looked_up(self):
        """A field's properties hold an @type constraint object, which is unhashable."""
        node = child()
        node["schema:name"] = "Age"
        node["title"] = "stale"
        node["properties"] = {"@value": {"type": ["string", "null"]},
                              "@type": {"oneOf": [{"type": "string", "format": "uri"}]}}
        doc = template({"Age": node})
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(after["properties"]["Age"]["title"], "Age field schema")
        self.assertIsNone(REPAIR.only_derived_title(doc, after))
        self.assertEqual(len(changes), 1)

    def test_a_child_named_title_is_not_the_title_keyword(self):
        """Production templates declare a child called "title"; only the traversal tells them apart."""
        inner = child()
        inner["schema:name"] = "title"
        inner["title"] = "stale"
        doc = template({"title": inner})
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(after["properties"]["title"]["title"], "title field schema")
        self.assertEqual([c["path"] for c in changes], ["/properties/title/title"])
        self.assertIsNone(REPAIR.only_derived_title(doc, after))

    def test_a_title_inside_a_multi_instance_child_is_reached(self):
        inner = child()
        inner["schema:name"] = "Author"
        inner["title"] = "stale"
        doc = template({"Authors": {"type": "array", "items": inner}})
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(after["properties"]["Authors"]["items"]["title"], "Author field schema")
        self.assertEqual([c["path"] for c in changes], ["/properties/Authors/items/title"])
        self.assertIsNone(REPAIR.only_derived_title(doc, after))

    def test_the_invariant_rejects_a_change_to_an_array_wrapper(self):
        inner = child()
        inner["schema:name"] = "Author"
        inner["title"] = "stale"
        doc = template({"Authors": {"type": "array", "items": inner}})
        after, _changes = REPAIR.derive_title(doc)
        meddled = copy.deepcopy(after)
        meddled["properties"]["Authors"]["minItems"] = 1
        self.assertIsNotNone(REPAIR.only_derived_title(doc, meddled))

    def test_the_invariant_rejects_a_title_composed_from_the_wrong_name(self):
        stale = child()
        stale["schema:name"] = "Age"
        stale["title"] = "stale"
        doc = template({"Age": stale})
        after, _changes = REPAIR.derive_title(doc)
        wrong = copy.deepcopy(after)
        wrong["properties"]["Age"]["title"] = "Study field schema"
        self.assertEqual(REPAIR.only_derived_title(doc, wrong), "/properties/Age/title")


class DropZeroTermCountTest(unittest.TestCase):

    def test_a_zero_term_count_is_deleted(self):
        node = child()
        node["_valueConstraints"] = {"ontologies": [{"acronym": "NCIT", "numTerms": 0}]}
        doc = template({"Term": node})
        after, changes = REPAIR.drop_zero_term_count(doc)
        self.assertNotIn("numTerms", after["properties"]["Term"]["_valueConstraints"]["ontologies"][0])
        self.assertEqual(changes[0]["path"], "/properties/Term/_valueConstraints/ontologies/0/numTerms")
        self.assertIsNone(REPAIR.only_dropped_zero_term_counts(doc, after))

    def test_a_real_count_is_left_alone(self):
        node = child()
        node["_valueConstraints"] = {"ontologies": [{"acronym": "NCIT", "numTerms": 12}]}
        doc = template({"Term": node})
        _after, changes = REPAIR.drop_zero_term_count(doc)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_deleting_anything_else(self):
        node = child()
        node["_valueConstraints"] = {"ontologies": [{"acronym": "NCIT", "numTerms": 0}]}
        doc = template({"Term": node})
        after, _changes = REPAIR.drop_zero_term_count(doc)
        greedy = copy.deepcopy(after)
        del greedy["properties"]["Term"]["_valueConstraints"]["ontologies"][0]["acronym"]
        self.assertIsNotNone(REPAIR.only_dropped_zero_term_counts(doc, greedy))


class DropStrayCardinalityKeysTest(unittest.TestCase):

    def test_bounds_go_from_a_child_deployed_as_an_object(self):
        doc = template({"Name": child()})
        doc["properties"]["Name"]["minItems"] = 0
        doc["properties"]["Name"]["maxItems"] = 1
        after, changes = REPAIR.drop_stray_cardinality_keys(doc)
        self.assertNotIn("minItems", after["properties"]["Name"])
        self.assertNotIn("maxItems", after["properties"]["Name"])
        self.assertEqual(sorted(c["path"] for c in changes),
                         ["/properties/Name/maxItems", "/properties/Name/minItems"])
        self.assertIsNone(REPAIR.only_dropped_stray_cardinality_keys(doc, after))

    def test_bounds_on_a_real_array_child_are_left_alone(self):
        doc = template({"Names": {"type": "array", "minItems": 0, "maxItems": 3, "items": child()}})
        _after, changes = REPAIR.drop_stray_cardinality_keys(doc)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_losing_another_key(self):
        doc = template({"Name": child()})
        doc["properties"]["Name"]["maxItems"] = 1
        after, _changes = REPAIR.drop_stray_cardinality_keys(doc)
        greedy = copy.deepcopy(after)
        del greedy["properties"]["Name"]["_ui"]
        self.assertIsNotNone(REPAIR.only_dropped_stray_cardinality_keys(doc, greedy))


class SettleTemporalTypeTest(unittest.TestCase):

    def temporal(self, granularity, **constraints):
        node = child()
        node["_ui"] = {"inputType": "temporal", "temporalGranularity": granularity}
        node["_valueConstraints"] = dict(constraints)
        return node

    def test_a_day_granularity_settles_the_type_to_a_date(self):
        doc = template({"When": self.temporal("day")})
        after, changes = REPAIR.settle_temporal_type(doc)
        self.assertEqual(after["properties"]["When"]["_valueConstraints"]["temporalType"], "xsd:date")
        self.assertEqual(changes[0]["path"], "/properties/When/_valueConstraints/temporalType")
        self.assertIsNone(REPAIR.only_settled_temporal_types(doc, after))

    def test_a_sub_day_granularity_is_left_for_the_values_to_settle(self):
        doc = template({"When": self.temporal("minute")})
        _after, changes = REPAIR.settle_temporal_type(doc)
        self.assertEqual(changes, [])

    def test_a_stated_type_is_never_moved(self):
        doc = template({"When": self.temporal("day", temporalType="xsd:dateTime")})
        _after, changes = REPAIR.settle_temporal_type(doc)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_a_type_the_granularity_does_not_settle(self):
        doc = template({"When": self.temporal("day")})
        after, _changes = REPAIR.settle_temporal_type(doc)
        wrong = copy.deepcopy(after)
        wrong["properties"]["When"]["_valueConstraints"]["temporalType"] = "xsd:dateTime"
        self.assertIsNotNone(REPAIR.only_settled_temporal_types(doc, wrong))

    def test_a_second_pass_changes_nothing(self):
        doc = template({"When": self.temporal("day")})
        once, first = REPAIR.settle_temporal_type(doc)
        _twice, second = REPAIR.settle_temporal_type(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class DropSchemaKeysFromInstanceTest(unittest.TestCase):
    """A template is drafted, published and versioned; an instance of it simply is."""

    def test_the_artifact_level_keys_are_removed(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t", "Name": {"@value": "Ada"},
                  "pav:version": "0.0.1", "bibo:status": "bibo:draft"}
        after, changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        self.assertNotIn("pav:version", after)
        self.assertNotIn("bibo:status", after)
        self.assertEqual(after["Name"], {"@value": "Ada"})
        self.assertEqual(len(changes), 2)
        self.assertIsNone(REPAIR.only_dropped_schema_keys(before, after, tmpl))

    def test_an_instance_without_them_is_untouched(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t", "Name": {"@value": "Ada"}}
        _after, changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        self.assertEqual(changes, [])

    def test_provenance_an_instance_does_carry_is_kept(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t", "pav:createdOn": "2021-01-01T00:00:00-08:00",
                  "pav:createdBy": "https://example.org/u", "pav:version": "0.0.1"}
        after, _changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        self.assertIn("pav:createdOn", after)
        self.assertIn("pav:createdBy", after)

    def test_the_context_entry_goes_with_the_key(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t",
                  "@context": {"pav": "http://purl.org/pav/", "pav:version": {"@type": "xsd:string"}},
                  "pav:version": "0.0.1"}
        after, _changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        self.assertNotIn("pav:version", after["@context"])
        self.assertIn("pav", after["@context"])

    def test_the_invariant_rejects_removing_anything_else(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t", "Name": {"@value": "Ada"}, "pav:version": "0.0.1"}
        after, _changes = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        greedy = copy.deepcopy(after); del greedy["Name"]
        self.assertEqual(REPAIR.only_dropped_schema_keys(before, greedy, tmpl), "/Name")

    def test_a_second_pass_changes_nothing(self):
        tmpl = template({"Name": child()})
        before = {"schema:isBasedOn": BASE + "t", "pav:version": "0.0.1"}
        once, first = REPAIR.drop_schema_keys_from_instance(before, tmpl)
        _twice, second = REPAIR.drop_schema_keys_from_instance(once, tmpl)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class DropSupersededInstanceKeysTest(unittest.TestCase):
    """A field renamed by copying leaves the old key behind holding a duplicate."""

    TID = BASE + "templates/t-superseded"

    def tmpl(self, children):
        doc = template(children, root=self.TID)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def test_a_duplicate_of_a_declared_value_is_removed(self):
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID, "@context": {},
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "IMPC"}}
        after, changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertNotIn("Repository", after)
        self.assertEqual(after["Data_Repository"], {"@value": "IMPC"})
        self.assertEqual(changes[0]["supersededBy"], "Data_Repository")
        self.assertIsNone(REPAIR.only_dropped_superseded_keys(before, after, tmpl))

    def test_a_key_whose_value_is_carried_nowhere_else_is_kept(self):
        """Removing it would be the only copy of that value going."""
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "Synapse"}}
        _after, changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_an_empty_key_is_left_alone(self):
        """Two fields both saying nothing are not evidence that one supersedes the other."""
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Data_Repository": {"@value": None}, "Repository": {"@value": None}}
        _after, changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_a_declared_key_is_never_removed_even_if_duplicated(self):
        tmpl = self.tmpl({"A": child(), "B": child()})
        before = {"schema:isBasedOn": self.TID, "A": {"@value": "x"}, "B": {"@value": "x"}}
        _after, changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_values_differing_in_type_are_not_the_same_value(self):
        tmpl = self.tmpl({"Count": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Count": {"@value": "1"}, "Number": {"@value": 1}}
        _after, changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_the_context_entry_goes_with_the_key(self):
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "@context": {"Repository": "https://example.org/r",
                               "Data_Repository": GOOD_IRI + "Data_Repository"},
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "IMPC"}}
        after, _changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        self.assertNotIn("Repository", after["@context"])
        self.assertIn("Data_Repository", after["@context"])

    def test_the_invariant_rejects_dropping_the_surviving_copy_too(self):
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "IMPC"}}
        after, _changes = REPAIR.drop_superseded_instance_keys(before, tmpl)
        greedy = copy.deepcopy(after); del greedy["Data_Repository"]
        self.assertIsNotNone(REPAIR.only_dropped_superseded_keys(before, greedy, tmpl))

    def test_the_invariant_rejects_dropping_an_unduplicated_key(self):
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "Synapse"}}
        meddled = {k: v for k, v in before.items() if k != "Repository"}
        self.assertEqual(REPAIR.only_dropped_superseded_keys(before, meddled, tmpl), "/Repository")

    def test_a_second_pass_changes_nothing(self):
        tmpl = self.tmpl({"Data_Repository": child()})
        before = {"schema:isBasedOn": self.TID,
                  "Data_Repository": {"@value": "IMPC"}, "Repository": {"@value": "IMPC"}}
        once, first = REPAIR.drop_superseded_instance_keys(before, tmpl)
        _twice, second = REPAIR.drop_superseded_instance_keys(once, tmpl)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class RenameInstanceKeysTest(unittest.TestCase):
    """Which old name became which new one is a fact about an edit nobody recorded."""

    TID = BASE + "templates/t-rename"

    def setUp(self):
        REPAIR.RENAMES.clear()

    def tearDown(self):
        REPAIR.RENAMES.clear()

    def tmpl(self, children):
        doc = template(children, root=self.TID)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def instance(self, **values):
        return {"schema:isBasedOn": self.TID, "@context": {}, **values}

    def test_a_value_moves_to_the_name_the_template_now_declares(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(Age={"@value": "38"})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["age"], {"@value": "38"})
        self.assertNotIn("Age", after)
        self.assertEqual(changes[0]["replaced"], "Age")
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_the_context_entry_moves_with_it(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(Age={"@value": "38"})
        before["@context"] = {"Age": "https://example.org/stale"}
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertNotIn("Age", after["@context"])
        self.assertEqual(after["@context"]["age"], GOOD_IRI + "age")

    def test_nothing_moves_without_a_mapping(self):
        tmpl = self.tmpl({"age": child()})
        before = self.instance(Age={"@value": "38"})
        _after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_a_name_the_template_still_declares_is_not_moved(self):
        """If both names are declared they are two fields, not one renamed."""
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child(), "Age": child()})
        before = self.instance(Age={"@value": "38"})
        _after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_a_value_already_under_the_new_name_is_never_overwritten(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(Age={"@value": "38"}, age={"@value": "21"})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after["age"], {"@value": "21"})

    def test_a_target_the_template_does_not_declare_is_refused(self):
        REPAIR.RENAMES[self.TID] = {"Age": "invented"}
        tmpl = self.tmpl({"age": child()})
        _after, changes = REPAIR.rename_instance_keys(self.instance(Age={"@value": "38"}), tmpl)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_altering_the_value_on_the_way(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(Age={"@value": "38"})
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        meddled = copy.deepcopy(after); meddled["age"] = {"@value": "39"}
        self.assertEqual(REPAIR.only_renamed_instance_keys(before, meddled, tmpl), "/age")

    def test_the_invariant_rejects_dropping_an_unrelated_key(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child(), "Name": child()})
        before = self.instance(Age={"@value": "38"}, Name={"@value": "Ada"})
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        lost = copy.deepcopy(after); del lost["Name"]
        self.assertIsNotNone(REPAIR.only_renamed_instance_keys(before, lost, tmpl))

    def test_an_instance_of_another_template_is_untouched(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        before = {"schema:isBasedOn": BASE + "templates/other", "Age": {"@value": "38"}}
        _after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])

    def test_a_mapping_to_null_removes_the_key(self):
        """The field was dropped rather than renamed, and the value goes with it."""
        REPAIR.RENAMES[self.TID] = {"pav:version": None}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(**{"pav:version": "0.0.1"})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertNotIn("pav:version", after)
        self.assertEqual(changes[0]["discarded"], ["pav:version"])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_the_invariant_rejects_removing_a_key_the_mapping_does_not_name(self):
        REPAIR.RENAMES[self.TID] = {"pav:version": None}
        tmpl = self.tmpl({"age": child()})
        before = self.instance(**{"pav:version": "0.0.1", "Keep": {"@value": "x"}})
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        greedy = copy.deepcopy(after); del greedy["Keep"]
        self.assertIsNotNone(REPAIR.only_renamed_instance_keys(before, greedy, tmpl))

    def test_a_value_moving_into_a_repeating_field_is_wrapped(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title"}
        tmpl = self.tmpl({"DataCite Title": {"type": "array", "items": child()}})
        before = self.instance(Title={"@value": "A paper"})
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["DataCite Title"], [{"@value": "A paper"}])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_longer_list_moving_into_a_single_valued_field_is_refused(self):
        """Which element survives is not this repair's to decide."""
        REPAIR.RENAMES[self.TID] = {"Titles": "Title"}
        tmpl = self.tmpl({"Title": child()})
        before = self.instance(Titles=[{"@value": "one"}, {"@value": "two"}])
        with self.assertRaises(REPAIR.TransformRefused):
            REPAIR.rename_instance_keys(before, tmpl)

    def test_a_single_element_list_is_unwrapped(self):
        """A field that used to repeat and now holds one value says the same thing either way."""
        REPAIR.RENAMES[self.TID] = {"Titles": "Title"}
        tmpl = self.tmpl({"Title": child()})
        before = self.instance(Titles=[{"@value": "one"}])
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Title"], {"@value": "one"})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_an_empty_list_becomes_the_shape_for_absence(self):
        REPAIR.RENAMES[self.TID] = {"Titles": "Title"}
        tmpl = self.tmpl({"Title": child()})
        before = self.instance(Titles=[])
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Title"], {"@value": None})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_several_keys_consolidate_onto_the_one_that_carries_a_value(self):
        REPAIR.RENAMES[self.TID] = {"Event Date 1": "evento", "Event Date": "evento",
                                    "Event Date1": "evento"}
        tmpl = self.tmpl({"evento": child()})
        before = self.instance(**{"Event Date 1": {"@value": None},
                                  "Event Date": {"@value": "2020-03-01"},
                                  "Event Date1": {"@value": None}})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["evento"], {"@value": "2020-03-01"})
        for gone in ("Event Date 1", "Event Date", "Event Date1"):
            self.assertNotIn(gone, after)
        self.assertEqual(changes[0]["replaced"], "Event Date")
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_consolidation_records_what_it_discarded(self):
        REPAIR.RENAMES[self.TID] = {"Info 1": "Section", "Info 2": "Section"}
        tmpl = self.tmpl({"Section": child()})
        before = self.instance(**{"Info 1": {"@value": "Value 1"}, "Info 2": {"@value": "Value 2"}})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Section"], {"@value": "Value 1"})
        self.assertEqual(changes[0]["discarded"], ["Info 2"])

    def test_an_element_value_moves_whole(self):
        REPAIR.RENAMES[self.TID] = {"SpatialCoverage": "Geospatial"}
        inner = child(ELEMENT_TYPE)
        inner["properties"] = {"@context": {"properties": {}, "required": []}, "east": child()}
        tmpl = self.tmpl({"Geospatial": inner})
        value = {"@id": "https://example.org/e", "@context": {}, "east": {"@value": "12"}}
        before = self.instance(SpatialCoverage=value)
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Geospatial"], value)

    def test_a_second_pass_changes_nothing(self):
        REPAIR.RENAMES[self.TID] = {"Age": "age"}
        tmpl = self.tmpl({"age": child()})
        once, first = REPAIR.rename_instance_keys(self.instance(Age={"@value": "38"}), tmpl)
        _twice, second = REPAIR.rename_instance_keys(once, tmpl)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class MappingPathTest(unittest.TestCase):
    """A mapping key addresses a key inside a container, escaped the way a pointer component is."""

    def test_a_single_segment_names_a_key_at_this_level(self):
        self.assertEqual(REPAIR.path_head("Age"), ("Age", None))

    def test_a_slash_separates_the_container_from_what_is_inside_it(self):
        self.assertEqual(REPAIR.path_head("DataCite Title/titleLanguage"),
                         ("DataCite Title", "titleLanguage"))

    def test_a_slash_in_a_name_is_escaped(self):
        self.assertEqual(REPAIR.path_head("City ~1Region 1"), ("City /Region 1", None))

    def test_a_tilde_in_a_name_is_escaped(self):
        self.assertEqual(REPAIR.path_head("a~0b/c"), ("a~b", "c"))

    def test_only_the_first_separator_is_consumed(self):
        self.assertEqual(REPAIR.path_head("a/b/c"), ("a", "b/c"))

    def test_a_level_is_split_from_what_lies_inside_it(self):
        here, deeper = REPAIR.split_mapping(
            {"Title": "DataCite Title", "DataCite Title/title": "Title",
             "DataCite Title/lang": None, "Age": "age"})
        self.assertEqual(here, {"Title": "DataCite Title", "Age": "age"})
        self.assertEqual(deeper, {"DataCite Title": {"title": "Title", "lang": None}})

    def test_a_container_addressed_only_from_within_is_not_renamed_here(self):
        here, deeper = REPAIR.split_mapping({"Funding/Body": "Funding Body or Agency"})
        self.assertEqual(here, {})
        self.assertEqual(deeper, {"Funding": {"Body": "Funding Body or Agency"}})


class NestedRenameTest(unittest.TestCase):
    """Renaming an element moves the occurrence across, and its children answer to the new name."""

    TID = BASE + "templates/t-nested"

    def setUp(self):
        REPAIR.RENAMES.clear()

    def tearDown(self):
        REPAIR.RENAMES.clear()

    def element(self, inner, multiple=False):
        node = child(ELEMENT_TYPE)
        node["properties"] = {
            "@context": {"properties": {n: {"enum": [GOOD_IRI + n]} for n in inner},
                         "required": list(inner)},
            "@id": {"type": "string", "format": "uri"}, **inner}
        node["_ui"] = {"order": list(inner)}
        if multiple:
            return {"type": "array", "items": node, "minItems": 1}
        return node

    def tmpl(self, children):
        doc = template(children, root=self.TID)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def instance(self, **values):
        return {"schema:isBasedOn": self.TID, "@context": {}, **values}

    def occurrence(self, **values):
        return {"@context": {k: "http://old.example/" + k for k in values},
                "@id": BASE + "template-element-instances/e1", **values}

    def test_a_key_inside_a_renamed_element_moves_with_it(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()})})
        before = self.instance(Title=self.occurrence(title={"@value": "Nanog"}))
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["DataCite Title"]["Title"], {"@value": "Nanog"})
        self.assertNotIn("title", after["DataCite Title"])
        self.assertNotIn("Title", after)
        self.assertIn("/DataCite Title/title", [c["path"] for c in changes])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_the_inner_context_entry_moves_with_the_inner_key(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()})})
        before = self.instance(Title=self.occurrence(title={"@value": "Nanog"}))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["DataCite Title"]["@context"], {"Title": GOOD_IRI + "Title"})

    def test_the_element_keeps_the_identity_it_already_had(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()})})
        before = self.instance(Title=self.occurrence(title={"@value": "Nanog"}))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["DataCite Title"]["@id"], BASE + "template-element-instances/e1")

    def test_a_key_inside_an_element_that_kept_its_name_still_moves(self):
        REPAIR.RENAMES[self.TID] = {"Funding/Funding Body": "Funding Body or Agency"}
        tmpl = self.tmpl({"Funding": self.element({"Funding Body or Agency": child()})})
        before = self.instance(Funding=self.occurrence(**{"Funding Body": {"@value": "NIH"}}))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Funding"]["Funding Body or Agency"], {"@value": "NIH"})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_every_occurrence_of_a_repeating_element_is_settled(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()}, multiple=True)})
        before = self.instance(Title=[self.occurrence(title={"@value": "one"}),
                                      self.occurrence(title={"@value": "two"})])
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual([o["Title"] for o in after["DataCite Title"]],
                         [{"@value": "one"}, {"@value": "two"}])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_single_occurrence_moving_into_a_repeating_element_is_wrapped(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()}, multiple=True)})
        before = self.instance(Title=self.occurrence(title={"@value": "one"}))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["DataCite Title"][0]["Title"], {"@value": "one"})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_an_inner_key_mapped_to_null_is_dropped(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/titleLanguage": None}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title Type": child()})})
        before = self.instance(Title=self.occurrence(titleLanguage={"@id": "urn:en"}))
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertNotIn("titleLanguage", after["DataCite Title"])
        self.assertNotIn("titleLanguage", after["DataCite Title"]["@context"])
        self.assertEqual([c["discarded"] for c in changes if c["path"] == "/DataCite Title/titleLanguage"],
                         [["titleLanguage"]])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_path_through_a_name_the_template_does_not_declare_reaches_nothing(self):
        # Every segment but the last names a declared child, so a path headed by a key the template
        # dropped addresses nowhere, and the drop is all that happens.
        REPAIR.RENAMES[self.TID] = {"Gone": None, "Gone/inner": "Kept"}
        tmpl = self.tmpl({"Kept": child()})
        before = self.instance(Gone=self.occurrence(inner={"@value": "x"}))
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertNotIn("Gone", after)
        self.assertNotIn("Kept", after)
        self.assertEqual([c["path"] for c in changes], ["/Gone"])
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_rename_two_elements_deep_is_carried_out(self):
        REPAIR.RENAMES[self.TID] = {"Outer/Middle/leaf": "Leaf"}
        inner = self.element({"Leaf": child()})
        tmpl = self.tmpl({"Outer": self.element({"Middle": inner})})
        before = self.instance(Outer=self.occurrence(Middle=self.occurrence(leaf={"@value": "v"})))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Outer"]["Middle"]["Leaf"], {"@value": "v"})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_path_the_instance_does_not_hold_changes_nothing(self):
        REPAIR.RENAMES[self.TID] = {"Absent/inner": "Leaf"}
        tmpl = self.tmpl({"Absent": self.element({"Leaf": child()})})
        before = self.instance(Other={"@value": "x"})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after, before)

    def test_a_path_into_a_field_rather_than_an_element_changes_nothing(self):
        REPAIR.RENAMES[self.TID] = {"Age/inner": "Leaf"}
        tmpl = self.tmpl({"Age": child()})
        before = self.instance(Age={"@value": "38"})
        after, changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(changes, [])
        self.assertEqual(after, before)

    def test_a_container_name_holding_a_slash_is_reached_through_the_escape(self):
        REPAIR.RENAMES[self.TID] = {"City ~1Region/old": "new"}
        tmpl = self.tmpl({"City /Region": self.element({"new": child()})})
        before = self.instance(**{"City /Region": self.occurrence(old={"@value": "Turin"})})
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["City /Region"]["new"], {"@value": "Turin"})
        self.assertIsNone(REPAIR.only_renamed_instance_keys(before, after, tmpl))

    def test_a_value_already_inside_the_target_is_never_overwritten(self):
        REPAIR.RENAMES[self.TID] = {"Funding/old": "Body"}
        tmpl = self.tmpl({"Funding": self.element({"Body": child()})})
        before = self.instance(Funding=self.occurrence(old={"@value": "NIH"},
                                                       Body={"@value": "NSF"}))
        after, _changes = REPAIR.rename_instance_keys(before, tmpl)
        self.assertEqual(after["Funding"]["Body"], {"@value": "NSF"})

    def test_the_repair_is_settled_after_one_pass(self):
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        tmpl = self.tmpl({"DataCite Title": self.element({"Title": child()})})
        once, first = REPAIR.rename_instance_keys(
            self.instance(Title=self.occurrence(title={"@value": "Nanog"})), tmpl)
        _twice, second = REPAIR.rename_instance_keys(once, tmpl)
        self.assertTrue(first)
        self.assertEqual(second, [])


class NestedRenameInvariantTest(unittest.TestCase):
    """An invariant that stops at the top would not see a value changed inside an element."""

    TID = BASE + "templates/t-nested-inv"

    def setUp(self):
        REPAIR.RENAMES.clear()
        REPAIR.RENAMES[self.TID] = {"Title": "DataCite Title", "DataCite Title/title": "Title"}
        inner = {"Title": child()}
        node = child(ELEMENT_TYPE)
        node["properties"] = {
            "@context": {"properties": {n: {"enum": [GOOD_IRI + n]} for n in inner},
                         "required": list(inner)},
            "@id": {"type": "string", "format": "uri"}, **inner}
        node["_ui"] = {"order": list(inner)}
        self.template = template({"DataCite Title": node, "Subject": child()}, root=self.TID)
        self.template["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in ("DataCite Title", "Subject")}
        self.before = {"schema:isBasedOn": self.TID, "@context": {},
                       "Subject": {"@value": "biology"},
                       "Title": {"@context": {"title": "http://old.example/title"},
                                 "@id": BASE + "template-element-instances/e1",
                                 "title": {"@value": "Nanog"}}}
        self.after, _changes = REPAIR.rename_instance_keys(self.before, self.template)

    def tearDown(self):
        REPAIR.RENAMES.clear()

    def faulted(self, mutate):
        candidate = copy.deepcopy(self.after)
        mutate(candidate)
        return REPAIR.only_renamed_instance_keys(self.before, candidate, self.template)

    def test_the_repair_as_carried_out_holds(self):
        self.assertIsNone(REPAIR.only_renamed_instance_keys(self.before, self.after, self.template))

    def test_a_value_changed_inside_the_element_is_caught(self):
        self.assertEqual(
            self.faulted(lambda c: c["DataCite Title"]["Title"].__setitem__("@value", "other")),
            "/DataCite Title/Title")

    def test_a_key_added_inside_the_element_is_caught(self):
        self.assertEqual(
            self.faulted(lambda c: c["DataCite Title"].__setitem__("Extra", {"@value": 1})),
            "/DataCite Title/Extra")

    def test_the_element_identity_being_reminted_is_caught(self):
        self.assertEqual(
            self.faulted(lambda c: c["DataCite Title"].__setitem__("@id", "urn:new")),
            "/DataCite Title/@id")

    def test_an_inner_context_left_stale_is_caught(self):
        self.assertEqual(
            self.faulted(lambda c: c["DataCite Title"]["@context"].__setitem__(
                "title", "http://old.example/title")),
            "/DataCite Title/@context")

    def test_an_untouched_sibling_being_altered_is_caught(self):
        self.assertEqual(self.faulted(lambda c: c.__setitem__("Subject", {"@value": "chemistry"})),
                         "/Subject")

    def test_the_inner_key_left_in_place_is_caught(self):
        # Both the old key and the new one are then present, so which of the two differences the
        # walk reaches first is not fixed; that it is caught inside the element is what matters.
        fault = self.faulted(lambda c: c["DataCite Title"].__setitem__("title", {"@value": "Nanog"}))
        self.assertIsNotNone(fault)
        self.assertTrue(fault.startswith("/DataCite Title/"), fault)


class CompleteInstanceTest(unittest.TestCase):
    """A CEDAR instance states every declared field, carrying the model's shape for absence."""

    def template_with(self, children):
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in children}
        return doc

    def element_child(self, name, inner):
        node = child(ELEMENT_TYPE)
        node["schema:name"] = name
        node["properties"] = {"@context": {"properties": {n: {"enum": [GOOD_IRI + n]} for n in inner},
                                           "required": list(inner)}, **inner}
        node["_ui"] = {"order": list(inner)}
        return node

    def test_an_absent_literal_child_gains_the_empty_literal(self):
        tmpl = self.template_with({"Name": child(), "Age": child()})
        after, changes = REPAIR.complete_instance({"Name": {"@value": "Ada"}}, tmpl)
        self.assertEqual(after["Age"], {"@value": None})
        self.assertEqual(after["Name"], {"@value": "Ada"})
        self.assertIn("/Age", [c["path"] for c in changes])
        self.assertIsNone(REPAIR.only_completed_absences({"Name": {"@value": "Ada"}}, after, tmpl))

    def test_an_absent_iri_child_gains_an_empty_object(self):
        """@id: null is not legal JSON-LD, so an IRI field with no value is {}."""
        iri = child()
        iri["properties"] = {"@id": {"type": "string", "format": "uri"}}
        tmpl = self.template_with({"Term": iri})
        after, _changes = REPAIR.complete_instance({}, tmpl)
        self.assertEqual(after["Term"], {})

    def test_an_absent_multiple_child_gains_an_empty_list(self):
        tmpl = self.template_with({"Names": {"type": "array", "items": child()}})
        after, _changes = REPAIR.complete_instance({}, tmpl)
        self.assertEqual(after["Names"], [])

    def test_a_repeating_child_carries_as_many_empties_as_minItems_demands(self):
        """An empty list does not satisfy minItems, however empty the field is."""
        tmpl = self.template_with({"Names": {"type": "array", "minItems": 1, "items": child()}})
        after, _changes = REPAIR.complete_instance({}, tmpl)
        self.assertEqual(after["Names"], [{"@value": None}])

    def test_a_repeating_child_with_no_minimum_stays_an_empty_list(self):
        tmpl = self.template_with({"Names": {"type": "array", "items": child()}})
        after, _changes = REPAIR.complete_instance({}, tmpl)
        self.assertEqual(after["Names"], [])

    def test_an_absent_element_is_built_out_with_its_own_identity_and_context(self):
        tmpl = self.template_with({"Address": self.element_child("Address", {"Street": child()})})
        after, _changes = REPAIR.complete_instance({}, tmpl)
        address = after["Address"]
        self.assertEqual(address["Street"], {"@value": None})
        self.assertTrue(address["@id"].startswith(REPAIR.ELEMENT_INSTANCE_BASE))
        self.assertEqual(address["@context"], {"Street": GOOD_IRI + "Street"})

    def test_an_element_already_present_is_completed_in_place(self):
        tmpl = self.template_with(
            {"Address": self.element_child("Address", {"Street": child(), "City": child()})})
        instance = {"Address": {"@id": "https://example.org/e1", "Street": {"@value": "Main"}}}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual(after["Address"]["@id"], "https://example.org/e1")
        self.assertEqual(after["Address"]["Street"], {"@value": "Main"})
        self.assertEqual(after["Address"]["City"], {"@value": None})

    def test_every_occurrence_of_a_multiple_element_is_completed(self):
        tmpl = self.template_with({"Addresses": {"type": "array",
                                                 "items": self.element_child("Address", {"Street": child()})}})
        instance = {"Addresses": [{"@id": "https://example.org/a"}, {"@id": "https://example.org/b"}]}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual([a["Street"] for a in after["Addresses"]],
                         [{"@value": None}, {"@value": None}])

    def test_an_element_written_as_a_bare_string_is_left_alone(self):
        """Production holds these; building one out would discard the only content there is."""
        tmpl = self.template_with({"Characteristic": {"type": "array",
                                                      "items": self.element_child("C", {"S": child()})}})
        instance = {"Characteristic": ["activity", "repetitions"]}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual(after["Characteristic"], ["activity", "repetitions"])
        self.assertIsNone(REPAIR.only_completed_absences(instance, after, tmpl))

    def test_a_stated_value_is_never_touched_and_no_instance_id_is_minted(self):
        tmpl = self.template_with({"Name": child()})
        instance = {"Name": {"@value": "Ada", "@type": "xsd:string"}}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual(after["Name"], {"@value": "Ada", "@type": "xsd:string"})
        self.assertNotIn("@id", after)

    def test_an_existing_context_entry_is_left_as_it_stands(self):
        tmpl = self.template_with({"Name": child()})
        instance = {"@context": {"Name": "https://example.org/stale"}, "Name": {"@value": None}}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual(after["@context"]["Name"], "https://example.org/stale")

    def test_a_complete_instance_reports_no_change(self):
        tmpl = self.template_with({"Name": child()})
        instance = {"@context": {"Name": GOOD_IRI + "Name"}, "Name": {"@value": "Ada"}}
        _after, changes = REPAIR.complete_instance(instance, tmpl)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_changing_a_stated_value(self):
        tmpl = self.template_with({"Name": child(), "Age": child()})
        instance = {"Name": {"@value": "Ada"}}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        meddled = copy.deepcopy(after)
        meddled["Name"] = {"@value": "Grace"}
        self.assertEqual(REPAIR.only_completed_absences(instance, meddled, tmpl), "/Name/@value")

    def test_the_invariant_rejects_dropping_a_key(self):
        tmpl = self.template_with({"Name": child(), "Age": child()})
        instance = {"Name": {"@value": "Ada"}}
        after, _changes = REPAIR.complete_instance(instance, tmpl)
        lost = copy.deepcopy(after); del lost["Name"]
        self.assertIsNotNone(REPAIR.only_completed_absences(instance, lost, tmpl))

    def test_a_second_pass_changes_nothing(self):
        tmpl = self.template_with({"Name": child(), "Address": self.element_child("Address", {"S": child()})})
        once, first = REPAIR.complete_instance({}, tmpl)
        _twice, second = REPAIR.complete_instance(once, tmpl)
        self.assertTrue(first)
        self.assertEqual(second, [])


class RequireContextTest(unittest.TestCase):
    """A container that does not require @context describes an instance with no context at all."""

    def element(self, required):
        node = child(ELEMENT_TYPE)
        node["properties"] = {"@context": {"properties": {}, "required": []},
                              "@id": {"type": ["string", "null"], "format": "uri"},
                              "Street": child()}
        node["_ui"] = {"order": ["Street"], "propertyLabels": {"Street": "Street"}}
        node["required"] = list(required)
        return template({"Address": node})

    def required_of(self, doc):
        return doc["properties"]["Address"]["required"]

    def test_context_goes_back_at_the_head(self):
        doc = self.element(["@id", "Street"])
        after, changes = REPAIR.require_context(doc)
        self.assertEqual(self.required_of(after), ["@context", "@id", "Street"])
        self.assertEqual(changes[0]["path"], "/properties/Address/required")
        self.assertEqual(changes[0]["wrote"], "@context")
        self.assertIsNone(REPAIR.only_required_context(doc, after))

    def test_a_container_that_already_requires_it_is_left_alone(self):
        doc = self.element(["@context", "@id", "Street"])
        _after, changes = REPAIR.require_context(doc)
        self.assertEqual(changes, [])

    def test_a_field_is_never_touched(self):
        """A field's required array is about its value, and @context has no place in it."""
        doc = template({"Name": child()})
        doc["properties"]["Name"]["required"] = ["@value"]
        _after, changes = REPAIR.require_context(doc)
        self.assertEqual(changes, [])

    def test_the_order_after_the_head_is_kept(self):
        doc = self.element(["@id", "Zebra", "Apple"])
        after, _changes = REPAIR.require_context(doc)
        self.assertEqual(self.required_of(after), ["@context", "@id", "Zebra", "Apple"])

    def test_the_invariant_rejects_appending_instead_of_prepending(self):
        doc = self.element(["@id", "Street"])
        after, _changes = REPAIR.require_context(doc)
        appended = copy.deepcopy(after)
        appended["properties"]["Address"]["required"] = ["@id", "Street", "@context"]
        self.assertIsNotNone(REPAIR.only_required_context(doc, appended))

    def test_the_invariant_rejects_adding_anything_else(self):
        doc = self.element(["@id", "Street"])
        after, _changes = REPAIR.require_context(doc)
        extra = copy.deepcopy(after)
        extra["properties"]["Address"]["required"] = ["@context", "@id", "Street", "Ghost"]
        self.assertIsNotNone(REPAIR.only_required_context(doc, extra))

    def test_an_at_type_that_is_not_a_string_is_read_before_it_is_looked_up(self):
        """A field's properties hold an @type constraint object, which is unhashable."""
        doc = self.element(["@id", "Street"])
        doc["properties"]["Address"]["properties"]["Street"]["properties"] = {
            "@value": {"type": ["string", "null"]},
            "@type": {"oneOf": [{"type": "string", "format": "uri"}]}}
        after, changes = REPAIR.require_context(doc)
        self.assertEqual(len(changes), 1)
        self.assertIsNone(REPAIR.only_required_context(doc, after))

    def test_a_second_pass_changes_nothing(self):
        once, first = REPAIR.require_context(self.element(["@id", "Street"]))
        _twice, second = REPAIR.require_context(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class RenameLegacyTemporalInputTypeTest(unittest.TestCase):
    """`date` named a date field before the model settled on `temporal` for every temporal kind."""

    def date_field(self):
        node = child()
        node["_ui"] = {"inputType": "date"}
        node["properties"] = {"@value": {"type": ["string", "null"]},
                              "rdfs:label": {"type": ["string", "null"]},
                              "@type": {"type": "string", "format": "uri"}}
        node["required"] = ["@value", "@type"]
        return template({"Released": node})

    def test_a_date_field_takes_the_temporal_name(self):
        doc = self.date_field()
        after, changes = REPAIR.rename_legacy_temporal_input_type(doc)
        self.assertEqual(after["properties"]["Released"]["_ui"]["inputType"], "temporal")
        self.assertEqual(changes[0]["path"], "/properties/Released/_ui/inputType")
        self.assertIsNone(REPAIR.only_renamed_legacy_temporal_input_types(doc, after))

    def test_the_designer_shape_around_it_is_left_as_it_stands(self):
        """The bare-URI @type and the @type in required are the Designer's own date branch."""
        doc = self.date_field()
        after, changes = REPAIR.rename_legacy_temporal_input_type(doc)
        self.assertEqual(len(changes), 1)
        self.assertEqual(after["properties"]["Released"]["required"], ["@value", "@type"])
        self.assertEqual(after["properties"]["Released"]["properties"]["@type"],
                         {"type": "string", "format": "uri"})

    def test_no_granularity_or_temporal_type_is_invented(self):
        doc = self.date_field()
        after, _changes = REPAIR.rename_legacy_temporal_input_type(doc)
        ui = after["properties"]["Released"]["_ui"]
        self.assertNotIn("temporalGranularity", ui)
        self.assertNotIn("temporalType",
                         after["properties"]["Released"].get("_valueConstraints") or {})

    def test_an_iri_field_is_not_renamed(self):
        doc = self.date_field()
        node = doc["properties"]["Released"]
        node["properties"] = {"@id": {"type": "string", "format": "uri"}}
        _after, changes = REPAIR.rename_legacy_temporal_input_type(doc)
        self.assertEqual(changes, [])

    def test_another_input_type_is_left_alone(self):
        doc = self.date_field()
        doc["properties"]["Released"]["_ui"]["inputType"] = "textfield"
        _after, changes = REPAIR.rename_legacy_temporal_input_type(doc)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_any_other_target_name(self):
        doc = self.date_field()
        after, _changes = REPAIR.rename_legacy_temporal_input_type(doc)
        wrong = copy.deepcopy(after)
        wrong["properties"]["Released"]["_ui"]["inputType"] = "textfield"
        self.assertEqual(REPAIR.only_renamed_legacy_temporal_input_types(doc, wrong),
                         "/properties/Released/_ui/inputType")

    def test_a_second_pass_changes_nothing(self):
        once, first = REPAIR.rename_legacy_temporal_input_type(self.date_field())
        _twice, second = REPAIR.rename_legacy_temporal_input_type(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class SettleControlledTermFieldTest(unittest.TestCase):
    """A field states its kind three times; the input type is the one an editor rewrites."""

    def term_field(self, input_type="textfield", constraints=None, value_shape=None):
        node = child()
        node["properties"] = value_shape if value_shape is not None else {
            "@id": {"type": "string", "format": "uri"}, "@type": {"type": "string"},
            "rdfs:label": {"type": ["string", "null"]}}
        node["_ui"] = {"inputType": input_type}
        node["_valueConstraints"] = constraints if constraints is not None else {
            "requiredValue": False,
            "classes": [{"uri": "http://semanticscience.org/resource/LastName",
                         "label": "last name", "type": "OntologyClass", "source": "HASCO"}]}
        return template({"name": node})

    def child_of(self, doc):
        return doc["properties"]["name"]

    def test_a_term_constrained_iri_field_declared_as_text_is_settled(self):
        doc = self.term_field()
        after, changes = REPAIR.settle_controlled_term_field(doc)
        self.assertEqual(self.child_of(after)["_ui"]["inputType"], "controlled-term")
        self.assertEqual(changes[0]["replaced"], "textfield")
        self.assertIsNone(REPAIR.only_settled_controlled_term_fields(doc, after))

    def test_text_bounds_go_with_it(self):
        doc = self.term_field(constraints={
            "requiredValue": False, "minLength": 1, "maxLength": 40,
            "valueSets": [{"uri": "http://example.org/vs", "vsCollection": "CADSR-VS"}]})
        after, changes = REPAIR.settle_controlled_term_field(doc)
        vc = self.child_of(after)["_valueConstraints"]
        self.assertNotIn("minLength", vc)
        self.assertNotIn("maxLength", vc)
        self.assertEqual({c["path"].rsplit("/", 1)[-1] for c in changes},
                         {"inputType", "minLength", "maxLength"})
        self.assertIsNone(REPAIR.only_settled_controlled_term_fields(doc, after))

    def test_a_literal_field_is_left_alone(self):
        doc = self.term_field(value_shape={"@value": {"type": ["string", "null"]},
                                           "@type": {"type": "string"}})
        _after, changes = REPAIR.settle_controlled_term_field(doc)
        self.assertEqual(changes, [])

    def test_an_iri_field_naming_no_terms_is_left_alone(self):
        """A link field takes its value from somewhere no constraint names."""
        doc = self.term_field(constraints={"requiredValue": False})
        _after, changes = REPAIR.settle_controlled_term_field(doc)
        self.assertEqual(changes, [])

    def test_an_input_type_the_model_already_allows_is_left_alone(self):
        for input_type in ("controlled-term", "link", "ext-orcid"):
            with self.subTest(input_type=input_type):
                _after, changes = REPAIR.settle_controlled_term_field(self.term_field(input_type))
                self.assertEqual(changes, [])

    def test_the_invariant_rejects_any_other_input_type(self):
        doc = self.term_field()
        after, _changes = REPAIR.settle_controlled_term_field(doc)
        wrong = copy.deepcopy(after)
        wrong["properties"]["name"]["_ui"]["inputType"] = "ext-orcid"
        self.assertEqual(REPAIR.only_settled_controlled_term_fields(doc, wrong),
                         "/properties/name/_ui/inputType")

    def test_the_invariant_rejects_dropping_a_term_constraint(self):
        doc = self.term_field()
        after, _changes = REPAIR.settle_controlled_term_field(doc)
        greedy = copy.deepcopy(after)
        del greedy["properties"]["name"]["_valueConstraints"]["classes"]
        self.assertIsNotNone(REPAIR.only_settled_controlled_term_fields(doc, greedy))

    def test_a_second_pass_changes_nothing(self):
        once, first = REPAIR.settle_controlled_term_field(self.term_field())
        _twice, second = REPAIR.settle_controlled_term_field(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class DropBlankOrphanPropertyLabelTest(unittest.TestCase):
    """A label names a child for a reader, and the model will not hold an empty one."""

    def element_with_labels(self, labels):
        doc = template({"Name": child()})
        doc["_ui"]["propertyLabels"] = dict(labels)
        return doc

    def test_a_blank_label_naming_no_child_is_dropped(self):
        doc = self.element_with_labels({"Name": "Name", "17584714-479c": ""})
        after, changes = REPAIR.drop_blank_orphan_property_labels(doc)
        self.assertEqual(after["_ui"]["propertyLabels"], {"Name": "Name"})
        self.assertEqual(changes[0]["path"], "/_ui/propertyLabels/17584714-479c")
        self.assertIsNone(REPAIR.only_dropped_blank_orphan_property_labels(doc, after))

    def test_a_whitespace_label_counts_as_blank(self):
        doc = self.element_with_labels({"Name": "Name", "ghost": "   "})
        after, _changes = REPAIR.drop_blank_orphan_property_labels(doc)
        self.assertNotIn("ghost", after["_ui"]["propertyLabels"])

    def test_a_blank_label_on_a_child_that_exists_is_left_for_a_different_repair(self):
        """The child's own name is the label to write, and dropping would throw that answer away."""
        doc = self.element_with_labels({"Name": ""})
        _after, changes = REPAIR.drop_blank_orphan_property_labels(doc)
        self.assertEqual(changes, [])

    def test_a_stated_orphan_label_is_evidence_and_stays(self):
        doc = self.element_with_labels({"Name": "Name", "ghost": "Once A Field"})
        _after, changes = REPAIR.drop_blank_orphan_property_labels(doc)
        self.assertEqual(changes, [])

    def test_a_nested_container_is_reached(self):
        inner = child(ELEMENT_TYPE)
        inner["properties"] = {"@context": {"properties": {}, "required": []}, "Street": child()}
        inner["_ui"] = {"order": ["Street"], "propertyLabels": {"Street": "Street", "gone": ""}}
        doc = template({"Address": inner})
        after, changes = REPAIR.drop_blank_orphan_property_labels(doc)
        self.assertEqual(after["properties"]["Address"]["_ui"]["propertyLabels"], {"Street": "Street"})
        self.assertEqual(changes[0]["path"], "/properties/Address/_ui/propertyLabels/gone")

    def test_the_invariant_rejects_dropping_a_stated_label(self):
        doc = self.element_with_labels({"Name": "Name", "ghost": ""})
        after, _changes = REPAIR.drop_blank_orphan_property_labels(doc)
        greedy = copy.deepcopy(after)
        del greedy["_ui"]["propertyLabels"]["Name"]
        self.assertIsNotNone(REPAIR.only_dropped_blank_orphan_property_labels(doc, greedy))

    def test_the_invariant_rejects_rewriting_a_surviving_label(self):
        doc = self.element_with_labels({"Name": "Name", "ghost": ""})
        after, _changes = REPAIR.drop_blank_orphan_property_labels(doc)
        meddled = copy.deepcopy(after)
        meddled["_ui"]["propertyLabels"]["Name"] = "Renamed"
        self.assertIsNotNone(REPAIR.only_dropped_blank_orphan_property_labels(doc, meddled))

    def test_a_second_pass_changes_nothing(self):
        doc = self.element_with_labels({"Name": "Name", "ghost": ""})
        once, first = REPAIR.drop_blank_orphan_property_labels(doc)
        _twice, second = REPAIR.drop_blank_orphan_property_labels(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class SettleConstraintActionsTest(unittest.TestCase):
    """An action records an edit to a controlled-term list: a term moved, or removed."""

    VS = "https://cadsr.nci.nih.gov/metadata/CADSR-VS/VD6409709v1"
    TERM = "https://cadsr.nci.nih.gov/metadata/CADSR-VS/220367bc"
    CLASS = "http://data.bioontology.org/provisional_classes/be890ee0"

    def field(self, actions, value_sets=None, classes=None):
        node = child()
        node["_valueConstraints"] = {"requiredValue": False, "actions": list(actions)}
        if value_sets is not None:
            node["_valueConstraints"]["valueSets"] = value_sets
        if classes is not None:
            node["_valueConstraints"]["classes"] = classes
        return template({"Race": node})

    def actions_of(self, doc):
        return doc["properties"]["Race"]["_valueConstraints"]["actions"]

    def test_a_value_action_takes_the_collection_of_the_value_set_it_names(self):
        doc = self.field(
            [{"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}],
            value_sets=[{"uri": self.VS, "name": "VD6409709v1", "vsCollection": "CADSR-VS"}])
        after, changes = REPAIR.settle_constraint_actions(doc)
        self.assertEqual(self.actions_of(after)[0]["source"], "CADSR-VS")
        self.assertEqual(changes[0]["wrote"], "CADSR-VS")
        self.assertIsNone(REPAIR.only_settled_constraint_actions(doc, after))

    def test_a_class_action_resolves_through_its_term_when_the_source_is_the_template(self):
        doc = self.field(
            [{"termUri": self.CLASS, "sourceUri": "template", "type": "OntologyClass",
              "action": "delete"}],
            classes=[{"uri": self.CLASS, "label": "Prevention", "type": "OntologyClass",
                      "source": "CEDARPC"}])
        after, _changes = REPAIR.settle_constraint_actions(doc)
        self.assertEqual(self.actions_of(after)[0]["source"], "CEDARPC")

    def test_an_action_naming_nothing_the_field_constrains_is_dropped(self):
        doc = self.field(
            [{"termUri": "http://example.org/gone", "sourceUri": "template",
              "type": "OntologyClass", "action": "delete"}],
            classes=[{"uri": self.CLASS, "source": "CEDARPC"}])
        after, changes = REPAIR.settle_constraint_actions(doc)
        self.assertEqual(self.actions_of(after), [])
        self.assertIsNone(changes[0]["wrote"])
        self.assertIsNone(REPAIR.only_settled_constraint_actions(doc, after))

    def test_surviving_actions_keep_their_order_around_a_dropped_one(self):
        keep_one = {"termUri": self.CLASS, "sourceUri": "template", "type": "OntologyClass",
                    "action": "move", "to": 0}
        gone = {"termUri": "http://example.org/gone", "sourceUri": "template",
                "type": "OntologyClass", "action": "delete"}
        keep_two = {"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}
        doc = self.field([keep_one, gone, keep_two],
                         value_sets=[{"uri": self.VS, "vsCollection": "CADSR-VS"}],
                         classes=[{"uri": self.CLASS, "source": "CEDARPC"}])
        after, _changes = REPAIR.settle_constraint_actions(doc)
        surviving = self.actions_of(after)
        self.assertEqual([a["termUri"] for a in surviving], [self.CLASS, self.TERM])
        self.assertEqual([a["source"] for a in surviving], ["CEDARPC", "CADSR-VS"])
        self.assertIsNone(REPAIR.only_settled_constraint_actions(doc, after))

    def test_an_action_that_already_names_a_source_is_untouched(self):
        stated = {"termUri": self.CLASS, "sourceUri": "template", "type": "OntologyClass",
                  "action": "delete", "source": "SOMETHING-ELSE"}
        doc = self.field([stated], classes=[{"uri": self.CLASS, "source": "CEDARPC"}])
        after, changes = REPAIR.settle_constraint_actions(doc)
        self.assertEqual(changes, [])
        self.assertEqual(self.actions_of(after)[0]["source"], "SOMETHING-ELSE")

    def test_the_invariant_rejects_dropping_an_action_that_resolves(self):
        doc = self.field(
            [{"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}],
            value_sets=[{"uri": self.VS, "vsCollection": "CADSR-VS"}])
        emptied = copy.deepcopy(doc)
        emptied["properties"]["Race"]["_valueConstraints"]["actions"] = []
        self.assertIsNotNone(REPAIR.only_settled_constraint_actions(doc, emptied))

    def test_the_invariant_rejects_an_invented_source(self):
        doc = self.field(
            [{"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}],
            value_sets=[{"uri": self.VS, "vsCollection": "CADSR-VS"}])
        after, _changes = REPAIR.settle_constraint_actions(doc)
        invented = copy.deepcopy(after)
        invented["properties"]["Race"]["_valueConstraints"]["actions"][0]["source"] = "NCIT"
        self.assertIsNotNone(REPAIR.only_settled_constraint_actions(doc, invented))

    def test_the_invariant_rejects_reordering(self):
        one = {"termUri": self.CLASS, "sourceUri": "template", "type": "OntologyClass",
               "action": "delete"}
        two = {"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}
        doc = self.field([one, two], value_sets=[{"uri": self.VS, "vsCollection": "CADSR-VS"}],
                         classes=[{"uri": self.CLASS, "source": "CEDARPC"}])
        after, _changes = REPAIR.settle_constraint_actions(doc)
        swapped = copy.deepcopy(after)
        actions = swapped["properties"]["Race"]["_valueConstraints"]["actions"]
        actions.reverse()
        self.assertIsNotNone(REPAIR.only_settled_constraint_actions(doc, swapped))

    def test_a_second_pass_changes_nothing(self):
        doc = self.field(
            [{"termUri": self.TERM, "sourceUri": self.VS, "type": "Value", "action": "delete"}],
            value_sets=[{"uri": self.VS, "vsCollection": "CADSR-VS"}])
        once, first = REPAIR.settle_constraint_actions(doc)
        _twice, second = REPAIR.settle_constraint_actions(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class ReclassifyStaticFieldTest(unittest.TestCase):

    def static_body(self, input_type="richtext"):
        """A standalone field that is static in every respect but its @type."""
        return {"@id": BASE + "template-fields/b65c1029", "@type": FIELD_TYPE,
                "schema:name": "business definition", "title": "Untitled field schema",
                "schema:schemaVersion": AUDIT_MODEL_VERSION, "type": "object",
                "_ui": {"inputType": input_type, "_content": "<p>this is a rule</p>"}}

    def test_a_static_body_carrying_a_field_type_is_reclassified(self):
        doc = self.static_body()
        after, changes = REPAIR.reclassify_static_field(doc)
        self.assertEqual(after["@type"], STATIC_TYPE)
        self.assertEqual(changes[0]["path"], "/@type")
        self.assertEqual(changes[0]["replaced"], FIELD_TYPE)
        self.assertIsNone(REPAIR.only_reclassified_static_fields(doc, after))

    def test_every_static_input_type_is_recognised(self):
        for input_type in ("page-break", "section-break", "richtext", "image", "youtube"):
            with self.subTest(input_type=input_type):
                after, _changes = REPAIR.reclassify_static_field(self.static_body(input_type))
                self.assertEqual(after["@type"], STATIC_TYPE)

    def test_an_attribute_value_field_is_not_static_and_is_left_alone(self):
        """attribute-value does not serialize either, but it is a field that holds a value."""
        _after, changes = REPAIR.reclassify_static_field(self.static_body("attribute-value"))
        self.assertEqual(changes, [])

    def test_a_body_carrying_a_value_shape_is_left_alone(self):
        doc = self.static_body()
        doc["properties"] = {"@value": {"type": ["string", "null"]}}
        _after, changes = REPAIR.reclassify_static_field(doc)
        self.assertEqual(changes, [])

    def test_a_body_carrying_value_constraints_is_left_alone(self):
        doc = self.static_body()
        doc["_valueConstraints"] = {"requiredValue": False}
        _after, changes = REPAIR.reclassify_static_field(doc)
        self.assertEqual(changes, [])

    def test_a_nested_static_child_is_reached(self):
        inner = self.static_body()
        doc = template({"Note": inner, "Name": child()})
        after, changes = REPAIR.reclassify_static_field(doc)
        self.assertEqual(after["properties"]["Note"]["@type"], STATIC_TYPE)
        self.assertEqual(changes[0]["path"], "/properties/Note/@type")
        self.assertIsNone(REPAIR.only_reclassified_static_fields(doc, after))

    def test_an_ordinary_field_is_never_reclassified(self):
        doc = template({"Name": child()})
        _after, changes = REPAIR.reclassify_static_field(doc)
        self.assertEqual(changes, [])

    def test_the_invariant_rejects_reclassifying_an_ordinary_field(self):
        doc = template({"Name": child()})
        meddled = copy.deepcopy(doc)
        meddled["properties"]["Name"]["@type"] = STATIC_TYPE
        self.assertEqual(REPAIR.only_reclassified_static_fields(doc, meddled),
                         "/properties/Name/@type")

    def test_the_invariant_rejects_any_other_change(self):
        doc = self.static_body()
        after, _changes = REPAIR.reclassify_static_field(doc)
        meddled = copy.deepcopy(after)
        meddled["_ui"]["_content"] = "<p>something else</p>"
        self.assertEqual(REPAIR.only_reclassified_static_fields(doc, meddled), "/_ui/_content")

    def test_a_second_pass_changes_nothing(self):
        """The tool reruns every transform over the stored body to confirm a write."""
        once, first = REPAIR.reclassify_static_field(self.static_body())
        _twice, second = REPAIR.reclassify_static_field(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class RepairConditionTest(unittest.TestCase):

    def test_the_model_version_repair_is_named_by_the_root_and_nested_conditions(self):
        repair = REPAIR.REPAIRS["stamp-model-version"]
        self.assertEqual(repair.conditions, ("schema-version-stale", "schema-version-nested-stale"))

    def test_a_repair_with_one_condition_reports_just_that_one(self):
        self.assertEqual(REPAIR.REPAIRS["drop-unusable-order-entries"].conditions,
                         ("ui-order-orphan-entry",))


class DropUnusableOrderEntriesTest(unittest.TestCase):

    def test_an_entry_bearing_a_reserved_name_is_removed(self):
        doc = template({"Name": child()})
        doc["_ui"]["order"] = ["@context", "Name", "@id"]
        after, changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(after["_ui"]["order"], ["Name"])
        self.assertEqual([c["replaced"] for c in changes], ["@context", "@id"])

    def test_a_pre_rename_spelling_is_removed_once_the_renamed_child_is_present(self):
        doc = template({"provider-VendorName": child(), "Name": child()})
        doc["_ui"]["order"] = ["provider/VendorName", "Name", "provider-VendorName"]
        after, _changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(after["_ui"]["order"], ["Name", "provider-VendorName"])

    def test_a_pre_rename_spelling_is_kept_while_no_renamed_child_exists(self):
        doc = template({"Name": child()})
        doc["_ui"]["order"] = ["provider/VendorName", "Name"]
        after, changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after["_ui"]["order"], ["provider/VendorName", "Name"])

    def test_an_entry_naming_a_plausible_removed_child_is_left_alone(self):
        doc = template({"Name": child()})
        doc["_ui"]["order"] = ["Name", "Subject Label", "schemaVersion"]
        after, changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after["_ui"]["order"], ["Name", "Subject Label", "schemaVersion"])

    def test_a_page_break_child_is_not_treated_as_an_unusable_entry(self):
        doc = template({"Name": child(), "_page_break_1": child(STATIC_TYPE)})
        doc["_ui"]["order"] = ["Name", "_page_break_1"]
        _after, changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(changes, [])

    def test_a_nested_container_is_reached(self):
        inner = child(ELEMENT_TYPE)
        inner["properties"] = {"@context": {"properties": {}, "required": []}, "Street": child()}
        inner["_ui"] = {"order": ["Street", "@id"]}
        doc = template({"Address": inner})
        after, changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertEqual(after["properties"]["Address"]["_ui"]["order"], ["Street"])
        self.assertEqual(changes[0]["path"], "/properties/Address/_ui/order")

    def test_the_invariant_rejects_losing_a_usable_entry_or_reordering(self):
        doc = template({"Name": child(), "Age": child()})
        doc["_ui"]["order"] = ["@id", "Name", "Age"]
        after, _changes = REPAIR.drop_unusable_order_entries(doc)
        self.assertIsNone(REPAIR.only_dropped_unusable_order_entries(doc, after))
        lost = copy.deepcopy(after); lost["_ui"]["order"] = ["Name"]
        self.assertIsNotNone(REPAIR.only_dropped_unusable_order_entries(doc, lost))
        reordered = copy.deepcopy(after); reordered["_ui"]["order"] = ["Age", "Name"]
        self.assertIsNotNone(REPAIR.only_dropped_unusable_order_entries(doc, reordered))

    def test_a_second_pass_changes_nothing(self):
        doc = template({"Name": child()})
        doc["_ui"]["order"] = ["@id", "Name"]
        once, first = REPAIR.drop_unusable_order_entries(doc)
        _twice, second = REPAIR.drop_unusable_order_entries(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class CompleteUiOrderTest(unittest.TestCase):

    def test_an_omitted_child_is_appended_after_the_existing_order(self):
        doc = template({"Name": child(), "Age": child()})
        doc["_ui"]["order"] = ["Age"]
        after, changes = REPAIR.complete_ui_order(doc)
        self.assertEqual(after["_ui"]["order"], ["Age", "Name"])
        self.assertEqual([c["wrote"] for c in changes], ["Name"])

    def test_an_order_entry_naming_no_child_is_deliberately_left(self):
        doc = template({"Name": child()})
        doc["_ui"]["order"] = ["Name", "Ghost"]
        after, changes = REPAIR.complete_ui_order(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after["_ui"]["order"], ["Name", "Ghost"])

    def test_a_complete_order_is_unchanged_and_a_second_pass_adds_nothing(self):
        doc = template({"Name": child(), "Age": child()})
        doc["_ui"]["order"] = ["Age"]
        once, first = REPAIR.complete_ui_order(doc)
        _twice, second = REPAIR.complete_ui_order(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_the_invariant_rejects_a_reordering_or_an_undeclared_addition(self):
        doc = template({"Name": child(), "Age": child()})
        doc["_ui"]["order"] = ["Age"]
        after, _changes = REPAIR.complete_ui_order(doc)
        self.assertIsNone(REPAIR.only_appended_ui_order(doc, after))
        reordered = copy.deepcopy(after); reordered["_ui"]["order"] = ["Name", "Age"]
        self.assertIsNotNone(REPAIR.only_appended_ui_order(doc, reordered))
        invented = copy.deepcopy(after); invented["_ui"]["order"] = ["Age", "Name", "Ghost"]
        self.assertIsNotNone(REPAIR.only_appended_ui_order(doc, invented))


class DeriveTitleTest(unittest.TestCase):

    def test_a_stale_title_is_composed_again_from_the_name(self):
        doc = template({"Name": child()})
        doc["title"] = "An older name template schema"
        after, changes = REPAIR.derive_title(doc)
        self.assertEqual(after["title"], "Study template schema")
        self.assertEqual(changes[0]["replaced"], "An older name template schema")

    def test_an_element_and_a_static_field_take_their_own_kind_word(self):
        element = child(ELEMENT_TYPE, identifier=BASE + "template-elements/x")
        element["schema:name"] = "Address"
        element["title"] = "wrong"
        after, _changes = REPAIR.derive_title(element)
        self.assertEqual(after["title"], "Address element schema")
        static = static_child("Note"); static["title"] = "wrong"
        after, _changes = REPAIR.derive_title(static)
        self.assertEqual(after["title"], "Note field schema")

    def test_the_description_is_never_touched(self):
        doc = template({"Name": child()})
        doc["title"] = "wrong"
        doc["schema:description"] = "Study template schema generated by the CEDAR Template Editor 2.8.0"
        after, _changes = REPAIR.derive_title(doc)
        self.assertEqual(after["schema:description"],
                         "Study template schema generated by the CEDAR Template Editor 2.8.0")

    def test_an_artifact_with_no_usable_name_is_refused(self):
        doc = template({"Name": child()})
        doc["schema:name"] = "   "
        with self.assertRaises(REPAIR.TransformRefused):
            REPAIR.derive_title(doc)

    def test_a_second_pass_changes_nothing(self):
        doc = template({"Name": child()})
        doc["title"] = "wrong"
        once, first = REPAIR.derive_title(doc)
        _twice, second = REPAIR.derive_title(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_the_invariant_rejects_a_title_that_is_not_the_composed_one(self):
        doc = template({"Name": child()})
        doc["title"] = "wrong"
        after, _changes = REPAIR.derive_title(doc)
        self.assertIsNone(REPAIR.only_derived_title(doc, after))
        after["title"] = "something else"
        self.assertEqual(REPAIR.only_derived_title(doc, after), "/title")


class EmptyTargetExplanationTest(unittest.TestCase):
    """A records file older than a rule names nothing it measures, which looks exactly like a clean
    deployment. The two are worth telling apart, so the refusal says which rules the file knows."""

    def records(self, rows):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        for row in rows:
            handle.write(json.dumps(row) + "\n")
        handle.close()
        return pathlib.Path(handle.name)

    def test_it_names_the_conditions_the_file_does_measure(self):
        path = self.records([
            {"artifactType": "template", "artifactId": "t1", "conditionRules": {"title-not-canonical": 1}},
            {"artifactType": "element", "artifactId": "e1", "conditionRules": {"ui-order-missing-child": 2}},
        ])
        errors = []

        class Parser:
            def error(self, message):
                errors.append(message)
                raise SystemExit(message)

        with self.assertRaises(SystemExit):
            REPAIR.targets_from_records(path, ["static-field-required"], [], Parser())
        self.assertIn("title-not-canonical", errors[0])
        self.assertIn("ui-order-missing-child", errors[0])
        self.assertIn("predate the rule", errors[0])
        path.unlink()

    def test_a_file_recording_no_conditions_says_so_instead(self):
        path = self.records([{"artifactType": "template", "artifactId": "t1"}])
        errors = []

        class Parser:
            def error(self, message):
                errors.append(message)
                raise SystemExit(message)

        with self.assertRaises(SystemExit):
            REPAIR.targets_from_records(path, ["static-field-required"], [], Parser())
        self.assertIn("records no conditions at all", errors[0])
        path.unlink()

    def test_the_sample_reads_only_the_opening_lines(self):
        rows = [{"artifactType": "template", "artifactId": f"t{i}", "conditionRules": {"early": 1}}
                for i in range(3)]
        rows.append({"artifactType": "template", "artifactId": "late", "conditionRules": {"late": 1}})
        path = self.records(rows)
        self.assertEqual(REPAIR.conditions_named_by(path, sample=3), ["early"])
        self.assertEqual(REPAIR.conditions_named_by(path), ["early", "late"])
        path.unlink()


class CompleteContextRequiredTest(unittest.TestCase):
    """@context.properties says what an instance's entry must equal; @context.required says it must
    exist. A child in the first and not the second leaves the instance free to say nothing about what
    the field means."""

    def container(self, mapped, required, inputs=None):
        inputs = inputs or {}
        children = {name: child() for name in mapped}
        for name, kind in inputs.items():
            children[name] = child()
            children[name]["_ui"] = {"inputType": kind}
        doc = template(children)
        doc["properties"]["@context"]["properties"] = {
            name: {"enum": [GOOD_IRI + name]} for name in mapped}
        doc["properties"]["@context"]["required"] = list(required)
        return doc

    def test_a_mapped_child_absent_from_required_is_added(self):
        doc = self.container(["Name", "Age"], ["Name"])
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(after["properties"]["@context"]["required"], ["Name", "Age"])
        self.assertEqual([c["wrote"] for c in changes], ["Age"])

    def test_an_absent_required_list_is_created(self):
        """The server synchronizes the two lists on any ordinary save, creating the array."""
        doc = self.container(["Name", "Age"], [])
        del doc["properties"]["@context"]["required"]
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(after["properties"]["@context"]["required"], ["Name", "Age"])
        self.assertEqual([c["wrote"] for c in changes], ["Name", "Age"])
        self.assertIsNone(REPAIR.only_completed_context_required(doc, after))

    def test_an_absent_required_list_stays_absent_when_nothing_is_mapped(self):
        doc = self.container([], [])
        del doc["properties"]["@context"]["required"]
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(changes, [])
        self.assertNotIn("required", after["properties"]["@context"])

    def test_a_required_that_is_not_a_list_is_left_alone(self):
        doc = self.container(["Name"], [])
        doc["properties"]["@context"]["required"] = "Name"
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(changes, [])
        self.assertEqual(after["properties"]["@context"]["required"], "Name")

    def test_the_invariant_rejects_a_created_list_holding_an_unmapped_name(self):
        doc = self.container(["Name"], [])
        del doc["properties"]["@context"]["required"]
        after, _changes = REPAIR.complete_context_required(doc)
        invented = copy.deepcopy(after)
        invented["properties"]["@context"]["required"] = ["Name", "Ghost"]
        self.assertIsNotNone(REPAIR.only_completed_context_required(doc, invented))

    def test_the_invariant_rejects_an_empty_list_appearing_from_nowhere(self):
        doc = self.container(["Name"], [])
        del doc["properties"]["@context"]["required"]
        hollow = copy.deepcopy(doc)
        hollow["properties"]["@context"]["required"] = []
        self.assertIsNotNone(REPAIR.only_completed_context_required(doc, hollow))

    def test_a_second_pass_over_a_created_list_changes_nothing(self):
        doc = self.container(["Name", "Age"], [])
        del doc["properties"]["@context"]["required"]
        once, first = REPAIR.complete_context_required(doc)
        _twice, second = REPAIR.complete_context_required(once)
        self.assertEqual(len(first), 2)
        self.assertEqual(second, [])

    def test_an_unmapped_child_is_neither_mapped_nor_required(self):
        doc = self.container(["Name"], ["Name"])
        doc["properties"]["Ghost"] = child()
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(changes, [])
        self.assertNotIn("Ghost", after["properties"]["@context"]["required"])
        self.assertNotIn("Ghost", after["properties"]["@context"]["properties"])

    def test_a_non_serializing_child_is_never_required(self):
        doc = self.container(["Name"], ["Name"], inputs={"Section": "section-break"})
        doc["properties"]["@context"]["properties"]["Section"] = {"enum": [GOOD_IRI + "s"]}
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(changes, [])
        self.assertNotIn("Section", after["properties"]["@context"]["required"])

    def test_a_mapping_that_is_not_a_usable_iri_does_not_compel_anything(self):
        doc = self.container(["Name"], [])
        doc["properties"]["@context"]["properties"]["Name"] = {"enum": [""]}
        _after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual(changes, [])

    def test_existing_order_is_preserved_and_additions_come_after(self):
        doc = self.container(["A", "B", "C"], ["C", "A"])
        after, _changes = REPAIR.complete_context_required(doc)
        self.assertEqual(after["properties"]["@context"]["required"][:2], ["C", "A"])
        self.assertIn("B", after["properties"]["@context"]["required"][2:])

    def test_a_second_pass_adds_nothing(self):
        once, first = REPAIR.complete_context_required(self.container(["Name", "Age"], ["Name"]))
        _twice, second = REPAIR.complete_context_required(once)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_the_invariant_accepts_the_transform(self):
        before = self.container(["Name", "Age"], ["Name"])
        after, _changes = REPAIR.complete_context_required(before)
        self.assertIsNone(REPAIR.only_completed_context_required(before, after))

    def test_the_invariant_rejects_requiring_something_unmapped(self):
        before = self.container(["Name"], ["Name"])
        after = copy.deepcopy(before)
        after["properties"]["@context"]["required"].append("Ghost")
        self.assertIsNotNone(REPAIR.only_completed_context_required(before, after))

    def test_the_invariant_rejects_a_reordering_or_any_other_change(self):
        before = self.container(["Name", "Age"], ["Name"])
        after, _changes = REPAIR.complete_context_required(before)
        reordered = copy.deepcopy(after)
        reordered["properties"]["@context"]["required"] = ["Age", "Name"]
        self.assertIsNotNone(REPAIR.only_completed_context_required(before, reordered))
        touched = copy.deepcopy(after)
        touched["schema:name"] = "Renamed"
        self.assertEqual(REPAIR.only_completed_context_required(before, touched), "/schema:name")

    def test_it_reaches_a_nested_element(self):
        inner = child()
        element = child(ELEMENT_TYPE, identifier=BASE + "template-elements/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        element["_ui"] = {"order": ["Street"]}
        element["properties"] = {"@context": {"properties": {"Street": {"enum": [GOOD_IRI + "st"]}},
                                              "required": []}, "Street": inner}
        doc = template({"Address": element})
        doc["properties"]["@context"]["properties"] = {"Address": {"enum": [GOOD_IRI + "ad"]}}
        doc["properties"]["@context"]["required"] = ["Address"]
        after, changes = REPAIR.complete_context_required(doc)
        self.assertEqual([c["path"] for c in changes],
                         ["/properties/Address/properties/@context/required"])
        self.assertEqual(after["properties"]["Address"]["properties"]["@context"]["required"], ["Street"])


import threading
from concurrent.futures import ThreadPoolExecutor


class GuardedBridgeTest(unittest.TestCase):
    """The JVM answers one request at a time down one pipe. Two workers validating at once would
    interleave on it, so the guard serializes exactly that and nothing else."""

    class FakeBridge:
        def __init__(self, fail_times=0):
            self.process = object()
            self.starts = 1
            self.hello = {"validator": "fake"}
            self.concurrent = 0
            self.max_concurrent = 0
            self.calls = 0
            self._fail_times = fail_times
            self._lock = threading.Lock()

        def validate(self, kind, artifact, template_id=None):
            with self._lock:
                self.concurrent += 1
                self.max_concurrent = max(self.max_concurrent, self.concurrent)
            time.sleep(0.005)
            with self._lock:
                self.concurrent -= 1
                self.calls += 1
            return {"status": "valid", "errors": []}

        def cache_template(self, template_id, template):
            return {"status": "ok"}

        def start(self):
            self.starts += 1
            self.process = object()
            return self.hello

        def close(self):
            self.process = None

    def test_validation_never_overlaps_however_many_workers_call_it(self):
        fake = self.FakeBridge()
        guard = REPAIR.GuardedBridge(fake, max_restarts=5)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: guard.validate("field", {}), range(40)))
        self.assertEqual(fake.calls, 40)
        self.assertEqual(fake.max_concurrent, 1, "two threads were inside the bridge at once")

    def test_a_dead_bridge_is_restarted_once_not_once_per_worker(self):
        fake = self.FakeBridge()
        guard = REPAIR.GuardedBridge(fake, max_restarts=5)
        fake.process = None
        before = fake.starts
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: guard.validate("field", {}), range(12)))
        self.assertEqual(fake.starts - before, 1, "the bridge was restarted more than once")

    def test_restarts_are_bounded_when_the_bridge_keeps_dying(self):
        # A bridge that comes up and dies again on every call. The guard must rebuild it a bounded
        # number of times and then give up, rather than restarting a JVM forever.
        class Flaky(self.FakeBridge):
            def validate(self, kind, artifact, template_id=None):
                self.process = None      # dies as it answers
                return {"status": "valid", "errors": []}
        flaky = Flaky()
        flaky.process = None
        guard = REPAIR.GuardedBridge(flaky, max_restarts=3)
        for _ in range(3):
            guard.validate("field", {})
        self.assertEqual(flaky.starts, 1 + 3)
        with self.assertRaises(REPAIR.audit.BridgeError):
            guard.validate("field", {})

    def test_a_start_that_raises_is_not_swallowed(self):
        class Broken(self.FakeBridge):
            def start(self):
                self.starts += 1
                raise REPAIR.audit.BridgeError("cannot start")
        broken = Broken()
        broken.process = None
        guard = REPAIR.GuardedBridge(broken, max_restarts=2)
        with self.assertRaises(REPAIR.audit.BridgeError):
            guard.validate("field", {})

    def test_it_forwards_the_handshake_and_start_count(self):
        fake = self.FakeBridge()
        guard = REPAIR.GuardedBridge(fake, max_restarts=1)
        self.assertEqual(guard.hello, {"validator": "fake"})
        self.assertEqual(guard.starts, 1)


class GuardedResolverTest(unittest.TestCase):
    """The resolver's caches are ordinary dicts, shared by every worker."""

    class FakeResolver:
        def __init__(self):
            self.unresolved = {}
            self.concurrent = 0
            self.max_concurrent = 0
            self._lock = threading.Lock()

        def fetch_body(self, template_id):
            with self._lock:
                self.concurrent += 1
                self.max_concurrent = max(self.max_concurrent, self.concurrent)
            time.sleep(0.003)
            with self._lock:
                self.concurrent -= 1
            return {"@id": template_id}

        def ensure_cached_in_bridge(self, template_id):
            return True

    def test_cache_access_is_serialized(self):
        fake = self.FakeResolver()
        guard = REPAIR.GuardedResolver(fake)
        with ThreadPoolExecutor(max_workers=8) as pool:
            bodies = list(pool.map(lambda n: guard.fetch_body(f"t{n}"), range(24)))
        self.assertEqual(len(bodies), 24)
        self.assertEqual(fake.max_concurrent, 1)

    def test_the_unresolved_record_is_visible_through_the_guard(self):
        fake = self.FakeResolver()
        fake.unresolved["t1"] = {"error": "gone"}
        self.assertEqual(REPAIR.GuardedResolver(fake).unresolved["t1"], {"error": "gone"})


class WorkerArgumentTest(unittest.TestCase):

    def test_the_flag_exists_and_defaults_above_one(self):
        help_text = REPAIR.build_parser().format_help()
        self.assertIn("--workers", help_text)
        self.assertGreater(REPAIR.DEFAULT_WORKERS, 1)

    def test_the_parser_accepts_an_explicit_worker_count(self):
        args = REPAIR.build_parser().parse_args(["--from-records", "x", "--workers", "8"])
        self.assertEqual(args.workers, 8)
        serial = REPAIR.build_parser().parse_args(["--from-records", "x", "--workers", "1"])
        self.assertEqual(serial.workers, 1)
