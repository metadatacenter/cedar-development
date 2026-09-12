#!/usr/bin/env python3
"""Unit tests for the transform, the invariant and target selection in cedar_artifact_repair.py.

The write path is exercised by running the tool against a server; these cover the parts that decide
what a write would contain, which is where a mistake would be silent.

    python3 -m unittest ops/test_cedar_artifact_repair.py
"""

import copy
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
