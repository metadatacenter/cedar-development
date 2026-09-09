#!/usr/bin/env python3
"""Unit tests for the transform, the invariant and target selection in cedar_artifact_repair.py.

The write path is exercised by running the tool against a server; these cover the parts that decide
what a write would contain, which is where a mistake would be silent.

    python3 -m unittest ops/test_cedar_artifact_repair.py
"""

import copy
import importlib.util
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
            "properties": {"@value": {"type": ["string", "null"]}}}
    if identifier is not None:
        node["@id"] = identifier
    node.update(extra)
    return node


def template(children, root=BASE + "templates/9d1f0b8e-1f3c-4a2b-9f77-2b1a7c3d4e5f"):
    return {"@id": root, "@type": "https://schema.metadatacenter.org/core/Template",
            "schema:name": "Study", "title": "Study template schema",
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
