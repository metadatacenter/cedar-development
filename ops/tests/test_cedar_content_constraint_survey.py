"""Cover for the content-constraint survey's reading of an artifact.

The survey's value is that its expectations are legible and wrong ones are visible, so what is
tested here is which occurrences it counts and which it judges — not the HTTP walk around it.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "cedar_content_constraint_survey.py"
SPEC = importlib.util.spec_from_file_location("cedar_content_constraint_survey", SCRIPT)
survey = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = survey
SPEC.loader.exec_module(survey)


def ref(kind="template", identifier="https://example.org/t/1"):
    return survey.rest.ArtifactRef(kind, identifier)


class WhatTheSurveyCounts(unittest.TestCase):
    def test_a_version_that_is_not_semver_is_reported(self):
        s = survey.Survey()
        s.add(ref(), {"pav:version": "0.1", "properties": {"child": {"pav:version": "1.0.0"}}})
        self.assertEqual(2, s.occurrences["pav:version"])
        self.assertEqual({"0.1": 1}, dict(s.offending["pav:version"]))

    def test_json_schemas_own_type_keyword_is_not_judged_as_a_term_kind(self):
        """`type` names a JSON Schema keyword as well, and only the constraint one is the survey's."""
        s = survey.Survey()
        s.add(ref(), {
            "type": "object",
            "properties": {"disease": {"type": "string", "items": {"type": "array"}}},
            "_valueConstraints": {"classes": [{"type": "OntologyClass"}, {"type": "Value"}]},
        })
        self.assertEqual(2, s.occurrences["type"])
        self.assertEqual({"Value": 1}, dict(s.offending["type"]))

    def test_the_previous_version_is_an_iri_rather_than_a_version(self):
        s = survey.Survey()
        s.add(ref(), {"pav:previousVersion": "https://repo.metadatacenter.org/templates/abc"})
        self.assertEqual(0, len(s.offending["pav:previousVersion"]))
        s.add(ref(identifier="https://example.org/t/2"), {"pav:previousVersion": "1.0.0"})
        self.assertEqual({"1.0.0": 1}, dict(s.offending["pav:previousVersion"]))

    def test_a_property_the_artifact_does_not_carry_is_not_counted(self):
        s = survey.Survey()
        s.add(ref(), {"schema:name": "Study"})
        self.assertEqual(0, s.occurrences["unitOfMeasure"])
        self.assertEqual(1, sum(s.artifacts.values()))

    def test_an_offending_artifact_is_counted_once_however_many_values_it_holds(self):
        s = survey.Survey()
        s.add(ref(), {"properties": {"a": {"pav:version": "0.1"}, "b": {"pav:version": "0.9"}}})
        self.assertEqual(1, len(s.offending_artifacts["pav:version"]))
        self.assertEqual(2, sum(s.offending["pav:version"].values()))


class TheExpectationsThemselves(unittest.TestCase):
    def test_a_regular_expression_that_does_not_compile_is_reported(self):
        _, acceptable = survey.EXPECTATIONS["regex"]
        self.assertTrue(acceptable(r"^[A-Z]\d+$"))
        self.assertFalse(acceptable("[unclosed"))

    def test_an_absolute_iri_is_told_from_a_bare_string(self):
        self.assertTrue(survey.is_absolute_iri("https://example.org/x"))
        self.assertTrue(survey.is_absolute_iri("urn:uuid:1234"))
        self.assertFalse(survey.is_absolute_iri("/templates/abc"))
        self.assertFalse(survey.is_absolute_iri("NCIT"))

    def test_free_text_is_not_surveyed_at_all(self):
        """Nothing is wrong with any string a description or a label may hold."""
        for name in ("schema:description", "title", "label", "prefLabel", "header", "footer"):
            self.assertNotIn(name, survey.EXPECTATIONS)
            self.assertNotIn(name, survey.ENUMERATED)


if __name__ == "__main__":
    unittest.main()
