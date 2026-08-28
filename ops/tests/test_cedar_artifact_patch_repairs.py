import copy
import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).parents[1] / "cedar_artifact_patch.py"
SPEC = importlib.util.spec_from_file_location("cedar_artifact_patch_repairs", SCRIPT)
PATCHER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = PATCHER
SPEC.loader.exec_module(PATCHER)


class Catalog:
    def __init__(self, iris=None):
        self.iris = iris or {}
        self.unresolved = set()

    def iri_for(self, acronym):
        found = self.iris.get(acronym)
        if found is None:
            self.unresolved.add(acronym)
        return found


class ArtifactPatchRepairRoundTripTest(unittest.TestCase):
    def assert_round_trip(self, item, defective, repaired, *, catalog=None, declared=None,
                          temporal_values=None):
        catalog = catalog or Catalog()
        findings = list(PATCHER.inspect_document(
            defective, "fixture.json", {item}, catalog, declared, temporal_values
        ))
        self.assertEqual(1, len(findings), f"item {item}: {findings}")
        self.assertTrue(findings[0].fixable, f"item {item} was not repairable")
        findings[0].repair()
        self.assertEqual(repaired, defective)

        after_first_pass = copy.deepcopy(defective)
        second_pass = list(PATCHER.inspect_document(
            defective, "fixture.json", {item}, catalog, declared, temporal_values
        ))
        self.assertEqual([], second_pass, f"item {item} was not clean on its second pass")
        self.assertEqual(after_first_pass, defective, f"item {item} changed on its second pass")

    def test_item_25_temporal_type_round_trip(self):
        defective = {
            "_ui": {"inputType": "temporal", "temporalGranularity": "day"},
        }
        repaired = {
            "_ui": {"inputType": "temporal", "temporalGranularity": "day"},
            "_valueConstraints": {"temporalType": "xsd:date"},
        }
        self.assert_round_trip(25, defective, repaired)

    def test_item_26_derived_from_round_trip(self):
        defective = {"pav:derivedFrom": "", "schema:name": "keep"}
        repaired = {"schema:name": "keep"}
        self.assert_round_trip(26, defective, repaired)

    def test_item_27_empty_occurrence_id_round_trip(self):
        defective = {
            "@id": "https://repo.metadatacenter.orgx/templates/root",
            "properties": {"child": {"@id": "", "type": "object"}},
        }
        repaired = {
            "@id": "https://repo.metadatacenter.orgx/templates/root",
            "properties": {"child": {"@id": None, "type": "object"}},
        }
        self.assert_round_trip(27, defective, repaired)

    def test_item_28_empty_ui_pages_round_trip(self):
        defective = {"_ui": {"order": ["field"], "pages": []}}
        repaired = {"_ui": {"order": ["field"]}}
        self.assert_round_trip(28, defective, repaired)

    def test_item_29_empty_attribute_name_round_trip(self):
        defective = {"attributeNames": ["height", "", "weight", ""]}
        repaired = {"attributeNames": ["height", "weight"]}
        self.assert_round_trip(29, defective, repaired)

    def test_item_30_orphan_context_term_round_trip(self):
        defective = {
            "@context": {
                "schema": "http://schema.org/",
                "unfilledChild": "https://example.org/properties/unfilledChild",
                "orphan": "https://example.org/properties/orphan",
            },
        }
        repaired = {
            "@context": {
                "schema": "http://schema.org/",
                "unfilledChild": "https://example.org/properties/unfilledChild",
            },
        }
        self.assert_round_trip(30, defective, repaired, declared={"unfilledChild"})

    def test_item_31_constraint_iri_round_trip(self):
        iri = "http://purl.obolibrary.org/obo/doid.owl"
        defective = {
            "_valueConstraints": {
                "ontologies": [{"acronym": "DOID", "name": "Human Disease Ontology"}],
            },
        }
        repaired = {
            "_valueConstraints": {
                "ontologies": [{
                    "acronym": "DOID",
                    "name": "Human Disease Ontology",
                    "iri": iri,
                }],
            },
        }
        self.assert_round_trip(31, defective, repaired, catalog=Catalog({"DOID": iri}))

    def test_item_32_inherently_multiple_shape_round_trip(self):
        field = {
            "type": "object",
            "@type": "https://schema.metadatacenter.org/core/TemplateField",
            "schema:identifier": "stable-identifier",
            "_ui": {"inputType": "list"},
            "_valueConstraints": {"multipleChoice": True, "requiredValue": True},
            "properties": {"@value": {"type": ["string", "null"]}},
        }
        defective = {"type": "object", "properties": {"choice": field}}
        repaired = {
            "type": "object",
            "properties": {
                "choice": {
                    "type": "array",
                    "minItems": 1,
                    "items": copy.deepcopy(field),
                },
            },
        }
        self.assert_round_trip(32, defective, repaired)

    def test_item_33_static_field_required_round_trip(self):
        static = {
            "@type": PATCHER.STATIC_TEMPLATE_FIELD,
            "_ui": {"inputType": "static"},
        }
        defective = {
            "required": ["ordinary", "static"],
            "properties": {
                "@context": {
                    "required": ["ordinary", "static"],
                    "properties": {
                        "ordinary": {"type": "string"},
                        "static": {"type": "string"},
                    },
                },
                "ordinary": {"type": "string"},
                "static": static,
            },
            "_ui": {"order": ["ordinary", "static"]},
        }
        repaired = {
            "required": ["ordinary"],
            "properties": {
                "@context": {
                    "required": ["ordinary"],
                    "properties": {"ordinary": {"type": "string"}},
                },
                "ordinary": {"type": "string"},
                "static": static,
            },
            "_ui": {"order": ["ordinary", "static"]},
        }
        self.assert_round_trip(33, defective, repaired)


if __name__ == "__main__":
    unittest.main()
