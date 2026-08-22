#!/usr/bin/env python3

import copy
import importlib.util
import pathlib
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("cedar_artifact_patch.py")
SPEC = importlib.util.spec_from_file_location("cedar_artifact_patch", MODULE_PATH)
PATCHER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = PATCHER
SPEC.loader.exec_module(PATCHER)


def broken_multi_select(required: bool = False) -> dict:
    return {
        "type": "object",
        "@type": "https://schema.metadatacenter.org/core/TemplateField",
        "schema:identifier": "stable-identifier",
        "_annotations": {"note": {"@value": "preserve me"}},
        "_ui": {"inputType": "list"},
        "_valueConstraints": {"multipleChoice": True, "requiredValue": required},
        "properties": {"@value": {"type": ["string", "null"]}},
    }


class InherentlyMultipleShapeTest(unittest.TestCase):

    def findings(self, document: dict):
        catalog = PATCHER.Catalog("/path/that/does/not/exist")
        return list(PATCHER.inspect_document(document, "fixture.json", {32}, catalog))

    def test_repairs_direct_and_nested_deployments_losslessly(self):
        template = {
            "@type": "https://schema.metadatacenter.org/core/Template",
            "type": "object",
            "_ui": {"order": ["direct", "element"]},
            "properties": {
                "direct": broken_multi_select(False),
                "element": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "@type": "https://schema.metadatacenter.org/core/TemplateElement",
                        "type": "object",
                        "_ui": {"order": ["nested"]},
                        "properties": {"nested": broken_multi_select(True)},
                    },
                },
            },
        }

        findings = self.findings(template)
        self.assertEqual(2, len(findings))
        self.assertTrue(all(finding.fixable for finding in findings))
        for finding in findings:
            finding.repair()

        direct = template["properties"]["direct"]
        nested = template["properties"]["element"]["items"]["properties"]["nested"]
        self.assertEqual(("array", 0), (direct["type"], direct["minItems"]))
        self.assertEqual(("array", 1), (nested["type"], nested["minItems"]))
        self.assertEqual("stable-identifier", direct["items"]["schema:identifier"])
        self.assertEqual("preserve me", direct["items"]["_annotations"]["note"]["@value"])
        self.assertEqual([], self.findings(template))

    def test_does_not_treat_a_standalone_field_as_a_bad_deployment(self):
        field = broken_multi_select(False)

        self.assertEqual([], self.findings(field))
        self.assertEqual("object", field["type"])

    def test_preserves_settled_bounds_and_reports_contradictory_bounds(self):
        bounded = broken_multi_select(False)
        bounded["minItems"] = 2
        bounded["maxItems"] = 4
        contradictory = copy.deepcopy(bounded)
        contradictory["maxItems"] = 1
        template = {
            "type": "object",
            "_ui": {"order": ["bounded", "contradictory"]},
            "properties": {"bounded": bounded, "contradictory": contradictory},
        }

        findings = self.findings(template)
        self.assertEqual([True, False], [finding.fixable for finding in findings])
        findings[0].repair()
        self.assertEqual(2, bounded["minItems"])
        self.assertEqual(4, bounded["maxItems"])
        self.assertNotIn("minItems", bounded["items"])
        self.assertNotIn("maxItems", bounded["items"])


if __name__ == "__main__":
    unittest.main()
