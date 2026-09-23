"""Tests for the comparison the stored-JSON matrix rests on.

What counts as a difference decides everything the audit reports, so the arrays treated as sets
and the arrays treated as sequences are pinned here rather than left to the reader of the source.
"""
import importlib.util
import pathlib
import sys
import unittest

OPS = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("cedar_stored_json_matrix_audit",
                                               OPS / "cedar_stored_json_matrix_audit.py")
audit = importlib.util.module_from_spec(_spec)
sys.modules["cedar_stored_json_matrix_audit"] = audit
_spec.loader.exec_module(audit)


class DifferenceTests(unittest.TestCase):
    def diff(self, before, after):
        return list(audit.differences(before, after))

    def test_an_identical_document_has_no_differences(self):
        document = {"a": 1, "b": [1, 2], "c": {"d": "e"}}
        self.assertEqual([], self.diff(document, document))

    def test_a_dropped_key_is_reported(self):
        self.assertEqual(["dropped /b"], self.diff({"a": 1, "b": 2}, {"a": 1}))

    def test_an_added_key_is_reported(self):
        self.assertEqual(["added /b"], self.diff({"a": 1}, {"a": 1, "b": 2}))

    def test_a_changed_value_is_reported(self):
        self.assertEqual(["value /a"], self.diff({"a": 1}, {"a": 2}))

    def test_required_is_compared_as_a_set(self):
        """`required` is a set by definition, and both libraries build it from unordered maps."""
        self.assertEqual([], self.diff({"required": ["a", "b", "c"]},
                                       {"required": ["c", "a", "b"]}))

    def test_a_genuinely_missing_required_entry_is_still_reported(self):
        self.assertEqual(["dropped /required/b"],
                         self.diff({"required": ["a", "b"]}, {"required": ["a"]}))

    def test_a_nested_required_is_also_a_set(self):
        self.assertEqual([], self.diff({"properties": {"@context": {"required": ["x", "y"]}}},
                                       {"properties": {"@context": {"required": ["y", "x"]}}}))

    def test_every_other_array_is_compared_in_order(self):
        """`_ui.order` is the one array whose order is the meaning, so order must matter."""
        found = self.diff({"_ui": {"order": ["a", "b"]}}, {"_ui": {"order": ["b", "a"]}})
        self.assertEqual(["value /_ui/order[0]", "value /_ui/order[1]"], found)

    def test_a_shortened_array_reports_its_length(self):
        self.assertEqual(["length /_ui/order 2->1"],
                         self.diff({"_ui": {"order": ["a", "b"]}}, {"_ui": {"order": ["a"]}}))

    def test_a_difference_deep_in_a_sequence_names_its_index(self):
        self.assertEqual(["value /items[1]/name"],
                         self.diff({"items": [{"name": "a"}, {"name": "b"}]},
                                   {"items": [{"name": "a"}, {"name": "c"}]}))


class UnorderedArrayTests(unittest.TestCase):
    def test_only_the_named_arrays_are_unordered(self):
        self.assertTrue(audit.unordered("/required"))
        self.assertTrue(audit.unordered("/properties/@context/required"))
        self.assertFalse(audit.unordered("/_ui/order"))
        self.assertFalse(audit.unordered("/oneOf"))
        self.assertFalse(audit.unordered("/_valueConstraints/literals"))


class LaneTests(unittest.TestCase):
    def test_the_matrix_is_both_writers_against_both_readers(self):
        self.assertEqual(("java", "typescript"), audit.LANES)
        self.assertEqual(4, len(audit.LANES) ** 2)
