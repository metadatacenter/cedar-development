#!/usr/bin/env python3
"""Unit tests for the inventory rules and the aggregation in cedar_artifact_validation_audit.py.

The bridge and the HTTP client are exercised by running the audit against a server; these tests
cover what can be checked without one: each rule against a minimal artifact, and the summary a
set of records produces.

    python3 -m unittest ops/test_cedar_artifact_validation_audit.py
"""

import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("cedar_artifact_validation_audit.py")
SPEC = importlib.util.spec_from_file_location("cedar_artifact_validation_audit", MODULE_PATH)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = AUDIT
SPEC.loader.exec_module(AUDIT)

TEMPLATE = "https://schema.metadatacenter.org/core/Template"
ELEMENT = "https://schema.metadatacenter.org/core/TemplateElement"
FIELD = "https://schema.metadatacenter.org/core/TemplateField"
DRAFT_04 = "http://json-schema.org/draft-04/schema#"


def field_definition(name: str, input_type: str = "textfield") -> dict:
    return {
        "$schema": DRAFT_04,
        "@id": f"https://repo.metadatacenter.org/template-fields/{name.lower()}",
        "@type": FIELD,
        "type": "object",
        "schema:name": name,
        "schema:schemaVersion": AUDIT.MODEL_VERSION,
        "title": f"{name} field schema",
        "_ui": {"inputType": input_type},
        "_valueConstraints": {"requiredValue": False},
        "properties": {"@value": {"type": ["string", "null"]}},
    }


def template(children: dict) -> dict:
    names = list(children)
    return {
        "$schema": DRAFT_04,
        "@id": "https://repo.metadatacenter.org/templates/t1",
        "@type": TEMPLATE,
        "type": "object",
        "schema:name": "Study",
        "schema:schemaVersion": AUDIT.MODEL_VERSION,
        "title": "Study template schema",
        "_ui": {"order": names},
        "properties": {
            "@context": {
                "properties": {name: {"enum": [f"https://schema.metadatacenter.org/properties/{i}"]}
                               for i, name in enumerate(names)},
                "required": names,
            },
            **children,
        },
    }


def rules(artifact: dict, artifact_type: str = "template") -> dict:
    ref = AUDIT.rest.ArtifactRef(artifact_type, artifact["@id"], artifact.get("schema:name", ""))
    counts: dict = {}
    for condition in AUDIT.inventory_conditions(ref, artifact, None):
        counts.setdefault(condition.rule, []).append(condition)
    return counts


class CleanArtifactTest(unittest.TestCase):

    def test_a_canonical_template_reports_no_new_condition(self):
        found = rules(template({"Name": field_definition("Name")}))
        # The controlled-term source rule needs a constraint entry to fire; a text field has none.
        self.assertEqual(set(found) - {"child-schema-missing"}, set(), found)


class TitleRuleTest(unittest.TestCase):

    def test_root_title_that_differs_only_in_case_is_marked_case_only(self):
        doc = template({"Name": field_definition("Name")})
        doc["title"] = "study template schema"
        found = rules(doc)["title-not-canonical"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].path, "/title")
        self.assertEqual(found[0].value, {"title": "study template schema", "caseOnly": True})

    def test_nested_divergence_is_counted_apart_from_the_root(self):
        child = field_definition("Name")
        child["title"] = "Something else"
        found = rules(template({"Name": child}))
        self.assertNotIn("title-not-canonical", found)
        nested = found["title-not-canonical-nested"]
        self.assertEqual(nested[0].path, "/properties/Name/title")
        self.assertFalse(nested[0].value["caseOnly"])

    def test_an_absent_title_is_a_divergence(self):
        doc = template({"Name": field_definition("Name")})
        del doc["title"]
        self.assertEqual(rules(doc)["title-not-canonical"][0].value, {"title": None, "caseOnly": False})


class CardinalityRuleTest(unittest.TestCase):

    def test_zero_max_items_on_an_array_deployment(self):
        doc = template({"Names": {"type": "array", "minItems": 0, "maxItems": 0,
                                  "items": field_definition("Names")}})
        found = rules(doc)
        self.assertEqual(found["max-items-zero"][0].path, "/properties/Names/maxItems")
        self.assertNotIn("stray-cardinality-keys", found)

    def test_cardinality_keys_on_an_object_deployment_are_stray(self):
        child = field_definition("Name")
        child["minItems"] = 0
        child["maxItems"] = 0
        found = rules(template({"Name": child}))
        self.assertEqual(found["stray-cardinality-keys"][0].value, {"minItems": 0, "maxItems": 0})
        self.assertNotIn("max-items-zero", found)

    def test_a_bounded_array_is_not_reported(self):
        doc = template({"Names": {"type": "array", "minItems": 1, "maxItems": 3,
                                  "items": field_definition("Names")}})
        found = rules(doc)
        self.assertNotIn("max-items-zero", found)
        self.assertNotIn("stray-cardinality-keys", found)


class ValueConstraintRuleTest(unittest.TestCase):

    def constrained(self, entries: dict) -> dict:
        child = field_definition("Disease", "controlled-term")
        child["_valueConstraints"].update(entries)
        return template({"Disease": child})

    def test_zero_term_count_and_absent_source_system(self):
        doc = self.constrained({"ontologies": [{"uri": "u", "acronym": "DOID", "name": "Disease", "numTerms": 0}],
                                "branches": [{"uri": "b", "acronym": "DOID", "source": "Disease (DOID)", "maxDepth": 0}]})
        found = rules(doc)
        self.assertEqual([c.path for c in found["num-terms-zero"]],
                         ["/properties/Disease/_valueConstraints/ontologies/0/numTerms"])
        self.assertEqual([c.value for c in found["source-system-absent"]], ["DOID", "DOID"])

    def test_a_source_explicit_constraint_with_a_real_count_is_not_reported(self):
        doc = self.constrained({"ontologies": [{"uri": "u", "acronym": "DOID", "name": "Disease",
                                                "numTerms": 18055, "sourceSystem": "BioPortal"}]})
        found = rules(doc)
        self.assertNotIn("num-terms-zero", found)
        self.assertNotIn("source-system-absent", found)

    def test_a_branch_has_no_term_count_to_be_zero(self):
        doc = self.constrained({"branches": [{"uri": "b", "acronym": "DOID", "numTerms": 0,
                                              "sourceSystem": "BioPortal"}]})
        self.assertNotIn("num-terms-zero", rules(doc))


class AnnotationRuleTest(unittest.TestCase):

    def test_sole_null_identifier_and_null_identifier_with_payload(self):
        doc = template({"Name": field_definition("Name")})
        doc["_annotations"] = {
            "https://datacite.com/doi": {"@id": None},
            "https://example.org/kept": {"@id": None, "rdfs:label": "keep"},
            "https://example.org/value": {"@value": None},
            "https://example.org/fine": {"@id": "https://doi.org/10.1/x"},
        }
        found = rules(doc)
        self.assertEqual([c.path for c in found["annotation-id-null"]],
                         ["/_annotations/https:~1~1datacite.com~1doi/@id"])
        self.assertEqual([c.value for c in found["annotation-id-null-with-payload"]],
                         ["https://example.org/kept"])

    def test_nested_annotations_are_reached_in_instances_too(self):
        instance = {
            "@id": "https://repo.metadatacenter.org/template-instances/i1",
            "@context": {},
            "schema:isBasedOn": "https://repo.metadatacenter.org/templates/t1",
            "Address": {"@context": {}, "@id": "https://repo.metadatacenter.org/template-element-instances/e1",
                        "_annotations": {"x": {"@id": None}}},
        }
        found = rules(instance, "instance")
        self.assertEqual(found["annotation-id-null"][0].path, "/Address/_annotations/x/@id")


class UiOrderRuleTest(unittest.TestCase):

    def test_missing_child_orphan_entry_and_duplicate(self):
        doc = template({"Name": field_definition("Name"), "Age": field_definition("Age")})
        doc["_ui"]["order"] = ["Name", "Ghost", "Name"]
        found = rules(doc)
        self.assertEqual([c.value for c in found["ui-order-missing-child"]], ["Age"])
        self.assertEqual([c.value for c in found["ui-order-orphan-entry"]], ["Ghost"])
        self.assertEqual([c.value for c in found["ui-order-duplicate-entry"]], ["Name"])

    def test_absent_order_on_a_container_with_children(self):
        doc = template({"Name": field_definition("Name")})
        del doc["_ui"]["order"]
        self.assertEqual(rules(doc)["ui-order-absent"][0].path, "/_ui/order")

    def test_nested_element_order_is_checked_at_its_own_path(self):
        element = {
            "$schema": DRAFT_04,
            "@id": "https://repo.metadatacenter.org/template-elements/e1",
            "@type": ELEMENT,
            "type": "object",
            "schema:name": "Address",
            "schema:schemaVersion": AUDIT.MODEL_VERSION,
            "title": "Address element schema",
            "_ui": {"order": []},
            "properties": {"@context": {"properties": {}, "required": []}, "Street": field_definition("Street")},
        }
        found = rules(template({"Address": element}))
        self.assertEqual(found["ui-order-missing-child"][0].path, "/properties/Address/_ui/order")
        self.assertEqual(found["ui-order-missing-child"][0].value, "Street")


class ModelVersionRuleTest(unittest.TestCase):

    def test_absent_stale_and_unparsable_root_versions(self):
        absent = template({"Name": field_definition("Name")})
        del absent["schema:schemaVersion"]
        stale = template({"Name": field_definition("Name")})
        stale["schema:schemaVersion"] = "1.5.0"
        odd = template({"Name": field_definition("Name")})
        odd["schema:schemaVersion"] = "latest"
        self.assertIn("schema-version-absent", rules(absent))
        self.assertEqual(rules(stale)["schema-version-stale"][0].value, "1.5.0")
        self.assertEqual(rules(odd)["schema-version-unparsable"][0].value, "latest")

    def test_nested_versions_are_counted_apart(self):
        child = field_definition("Name")
        child["schema:schemaVersion"] = "1.4.0"
        other = field_definition("Age")
        del other["schema:schemaVersion"]
        found = rules(template({"Name": child, "Age": other}))
        self.assertNotIn("schema-version-stale", found)
        self.assertEqual(found["schema-version-nested-stale"][0].path, "/properties/Name/schema:schemaVersion")
        self.assertEqual(found["schema-version-nested-absent"][0].path, "/properties/Age/schema:schemaVersion")

    def test_root_version_is_read_for_the_histogram(self):
        doc = template({})
        self.assertEqual(AUDIT.root_schema_version(doc), AUDIT.MODEL_VERSION)
        del doc["schema:schemaVersion"]
        self.assertIsNone(AUDIT.root_schema_version(doc))


class RestRulesTest(unittest.TestCase):

    def test_the_rest_audit_rules_arrive_as_conditions_with_their_risk(self):
        child = field_definition("Name", "list")
        child["_valueConstraints"]["multipleChoice"] = True
        found = rules(template({"Name": child}))
        condition = found["inherently-multiple-child-object"][0]
        self.assertEqual(condition.risk, "instance-save-rejected")
        self.assertEqual(condition.topic, "object-shaped multiple")

    def test_an_unresolved_template_is_not_a_condition_of_the_instance(self):
        instance = {
            "@id": "https://repo.metadatacenter.org/template-instances/i1",
            "@context": {},
            "schema:isBasedOn": "https://repo.metadatacenter.org/templates/missing",
        }
        self.assertEqual(rules(instance, "instance"), {})


class AggregateTest(unittest.TestCase):

    def record(self, artifact_type, status, conditions=(), fetched=True, **validation):
        record = {
            "artifactType": artifact_type,
            "artifactId": f"https://repo.metadatacenter.org/{artifact_type}/{id(conditions)}",
            "artifactName": "x",
            "fetched": fetched,
            "validation": {"status": status, **validation},
            "conditions": [dict(c) for c in conditions],
        }
        if artifact_type != "instance":
            record["schemaVersion"] = validation.get("schemaVersion", AUDIT.MODEL_VERSION)
        return record

    def test_conditions_are_counted_once_per_artifact_and_split_by_verdict(self):
        aggregate = AUDIT.Aggregate()
        two_titles = [{"rule": "title-not-canonical", "path": "/title", "value": {"title": "a", "caseOnly": True}},
                      {"rule": "title-not-canonical", "path": "/title", "value": {"title": "b", "caseOnly": False}}]
        aggregate.add(self.record("template", "valid", two_titles))
        aggregate.add(self.record("template", "invalid", two_titles[:1], errorCount=1,
                                  errors=[{"message": "object has missing required properties (['x'])",
                                           "location": "/"}]))
        aggregate.add(self.record("element", "valid"))
        self.assertEqual(aggregate.condition_artifacts_by_type["title-not-canonical"], {"template": 2})
        self.assertEqual(aggregate.condition_occurrences["title-not-canonical"], 3)
        self.assertEqual(aggregate.condition_by_validation["title-not-canonical"], {"valid": 1, "invalid": 1})
        self.assertEqual(aggregate.title_case_only["title-not-canonical"], 2)
        self.assertEqual(aggregate.with_conditions_by_type, {"template": 2})
        self.assertEqual(aggregate.with_conditions_but_valid_by_type, {"template": 1})
        self.assertEqual(aggregate.validation_totals(), {"valid": 2, "invalid": 1})
        self.assertEqual(list(aggregate.message_artifacts["template"]),
                         ["object has missing required properties (['…'])"])

    def test_fetch_failures_and_unresolved_templates_are_boundary_facts(self):
        aggregate = AUDIT.Aggregate()
        aggregate.add(self.record("element", "skipped", fetched=False, reason="fetch-failed"))
        aggregate.fetch_errors[-1]["error"] = "GET x returned 404: gone"
        aggregate.add(self.record("instance", "skipped", reason="template-unresolved",
                                  templateId="https://repo.metadatacenter.org/templates/t", detail="404"))
        aggregate.add(self.record("instance", "invalid", errorCount=2, errors=[],
                                  templateId="https://repo.metadatacenter.org/templates/t2"))
        self.assertEqual(aggregate.validation_by_type["element"], {"skipped": 1})
        self.assertEqual(aggregate.skip_reasons_by_type["instance"], {"template-unresolved": 1})
        self.assertEqual(aggregate.unresolved_templates["https://repo.metadatacenter.org/templates/t"]["instances"], 1)
        self.assertEqual(aggregate.invalid_instances_by_template, {"https://repo.metadatacenter.org/templates/t2": 1})


class NormalizeMessageTest(unittest.TestCase):

    def test_names_and_numbers_fold_together(self):
        self.assertEqual(AUDIT.normalize_message("object has missing required properties (['Element1'])"),
                         "object has missing required properties (['…'])")
        self.assertEqual(AUDIT.normalize_message("/properties/Page break 1/@type: does not have a value in the "
                                                 "enumeration ['https://x/TemplateField']"),
                         "/properties/Page break N/@type: does not have a value in the enumeration ['…']")


class FetchOrderTest(unittest.TestCase):

    def test_results_come_back_in_enumeration_order(self):
        class Client:
            def get_json(self, path):
                return {"path": path}

        refs = [AUDIT.rest.ArtifactRef("template", f"https://repo.metadatacenter.org/templates/{i}") for i in range(20)]
        ordered = [ref.artifact_id for ref, _artifact, _error in AUDIT.fetch_in_order(Client(), refs, 4)]
        self.assertEqual(ordered, [ref.artifact_id for ref in refs])


if __name__ == "__main__":
    unittest.main()


class RecheckSelectionTest(unittest.TestCase):
    """Both an audit's records and a repair's records name artifacts the same way, so one reader serves
    both: proving a repair means re-validating exactly the artifacts it says it wrote."""

    def write(self, rows):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        for row in rows:
            handle.write(json.dumps(row) + "\n")
        handle.close()
        return pathlib.Path(handle.name)

    def repair_records(self):
        return self.write([
            {"artifactType": "template", "artifactId": "t1", "artifactName": "T1", "outcome": "repaired"},
            {"artifactType": "element", "artifactId": "e1", "artifactName": "E1", "outcome": "repaired"},
            {"artifactType": "field", "artifactId": "f1", "artifactName": "F1", "outcome": "write-failed"},
            {"artifactType": "element", "artifactId": "e2", "artifactName": "E2", "outcome": "already-clean"},
            {"artifactType": "template", "artifactId": "t1", "artifactName": "T1", "outcome": "repaired"},
        ])

    def test_every_named_artifact_is_taken_once_in_file_order(self):
        path = self.repair_records()
        refs = AUDIT.refs_from_named_artifacts([path], None, None, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1", "f1", "e2"])
        self.assertEqual(refs[0].name, "T1")
        path.unlink()

    def test_an_outcome_filter_keeps_only_what_a_repair_changed(self):
        path = self.repair_records()
        refs = AUDIT.refs_from_named_artifacts([path], {"repaired"}, None, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1"])
        path.unlink()

    def test_several_outcomes_may_be_kept_together(self):
        path = self.repair_records()
        refs = AUDIT.refs_from_named_artifacts([path], {"repaired", "already-clean"}, None, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1", "e2"])
        path.unlink()

    def test_a_limit_stops_the_selection_early(self):
        path = self.repair_records()
        refs = AUDIT.refs_from_named_artifacts([path], None, 2, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1"])
        path.unlink()

    def test_an_audit_records_file_is_read_by_the_same_selector(self):
        path = self.write([
            {"artifactType": "instance", "artifactId": "i1", "artifactName": "I",
             "fetched": True, "validation": {"status": "invalid"}, "conditions": []},
        ])
        refs = AUDIT.refs_from_named_artifacts([path], None, None, parser=None)
        self.assertEqual([(r.artifact_type, r.artifact_id) for r in refs], [("instance", "i1")])
        path.unlink()

    def test_a_file_naming_nothing_usable_is_refused_rather_than_run_empty(self):
        path = self.write([{"artifactType": "template", "artifactId": "t1", "outcome": "write-failed"}])
        errors = []

        class Parser:
            def error(self, message):
                errors.append(message)
                raise SystemExit(2)

        with self.assertRaises(SystemExit):
            AUDIT.refs_from_named_artifacts([path], {"repaired"}, None, Parser())
        self.assertIn("names no artifact", errors[0])
        path.unlink()

    def test_several_files_are_read_as_one_set_without_repeating_an_artifact(self):
        first = self.write([
            {"artifactType": "template", "artifactId": "t1", "outcome": "repaired"},
            {"artifactType": "element", "artifactId": "e1", "outcome": "repaired"},
        ])
        second = self.write([
            {"artifactType": "element", "artifactId": "e1", "outcome": "repaired"},
            {"artifactType": "field", "artifactId": "f9", "outcome": "repaired"},
        ])
        refs = AUDIT.refs_from_named_artifacts([first, second], {"repaired"}, None, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1", "e1", "f9"])
        first.unlink(); second.unlink()

    def test_a_limit_applies_across_the_files_together(self):
        first = self.write([{"artifactType": "template", "artifactId": "t1", "outcome": "repaired"}])
        second = self.write([{"artifactType": "field", "artifactId": "f9", "outcome": "repaired"}])
        refs = AUDIT.refs_from_named_artifacts([first, second], None, 1, parser=None)
        self.assertEqual([r.artifact_id for r in refs], ["t1"])
        first.unlink(); second.unlink()
