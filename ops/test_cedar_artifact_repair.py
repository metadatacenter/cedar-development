#!/usr/bin/env python3
"""Unit tests for the transform, the invariant and target selection in cedar_artifact_repair.py.

The write path is exercised by running the tool against a server; these cover the parts that decide
what a write would contain, which is where a mistake would be silent.

    python3 -m unittest ops/test_cedar_artifact_repair.py
"""

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
invariant = REPAIR.only_removed_empty_derived_from


class TransformTest(unittest.TestCase):

    def test_removes_the_key_at_the_root(self):
        after, removed = strip({"@id": "x", "pav:derivedFrom": ""})
        self.assertEqual(after, {"@id": "x"})
        self.assertEqual(removed, ["/pav:derivedFrom"])

    def test_removes_it_at_every_depth_and_reports_each_path(self):
        before = {
            "pav:derivedFrom": "",
            "properties": {
                "Name": {"pav:derivedFrom": "", "_ui": {}},
                "Address": {"properties": {"Street": {"pav:derivedFrom": ""}}},
            },
        }
        after, removed = strip(before)
        self.assertEqual(sorted(removed), [
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
        self.assertEqual(removed, ["/items/0/pav:derivedFrom"])
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
        self.assertEqual(removed, ["/properties/a~1b/pav:derivedFrom"])


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
        refs = REPAIR.targets_from_records(path, "derived-from-empty", parser=None)
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
            REPAIR.targets_from_records(path, "derived-from-empty", parser=Parser())
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
