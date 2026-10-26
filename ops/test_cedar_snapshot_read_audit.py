#!/usr/bin/env python3
"""Tests for how cedar_snapshot_read_audit.py groups refusals into causes.

The bridges are exercised by running the audit over a snapshot. These tests cover what the summary
says about a refusal: its cause must be countable across artifacts and must not repeat stored values.

    python3 -m unittest ops/test_cedar_snapshot_read_audit.py
"""

import importlib.util
import pathlib
import sys
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("cedar_snapshot_read_audit.py")
SPEC = importlib.util.spec_from_file_location("cedar_snapshot_read_audit", MODULE_PATH)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = AUDIT
SPEC.loader.exec_module(AUDIT)


class CauseTest(unittest.TestCase):

    def test_quoted_values_identifiers_and_numbers_are_masked(self):
        message = ("child 'Patient Age' at https://repo.metadatacenter.org/template-fields/"
                   "0f1e2d3c-4b5a-4968-8776-655443322110 has 3 values, \"x\" expected")
        self.assertEqual(AUDIT.cause(message), "child … at … has … values, … expected")

    def test_two_artifacts_refused_for_one_reason_share_a_cause(self):
        first = {"status": "refused", "exception": "org.example.ArtifactParseException",
                 "message": "invalid name 'a' in field 'b'"}
        second = dict(first, message="invalid name 'c' in field 'd'")
        self.assertEqual(AUDIT.reader_cause(first), AUDIT.reader_cause(second))
        self.assertEqual(AUDIT.reader_cause(first), "ArtifactParseException: invalid name … in field …")

    def test_a_typescript_refusal_is_described_by_its_first_error(self):
        verdict = {"status": "refused", "errorCount": 2,
                   "errors": [{"type": "missingKeyInRealObject", "location": "'Name'", "path": "/properties"}]}
        self.assertEqual(AUDIT.reader_cause(verdict), "missingKeyInRealObject at …")


if __name__ == "__main__":
    unittest.main()
