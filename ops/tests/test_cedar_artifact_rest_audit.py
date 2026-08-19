from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "cedar_artifact_rest_audit.py"
SPEC = importlib.util.spec_from_file_location("cedar_artifact_rest_audit", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = audit
SPEC.loader.exec_module(audit)


def schema_child(at_type, identifier, input_type="text", nested=None):
    child = {
        "$schema": audit.JSON_SCHEMA_DRAFT_04,
        "type": "object",
        "@type": at_type,
        "@id": identifier,
        "_ui": {"inputType": input_type},
        "properties": {"@context": {"type": "object", "properties": {}, "required": []}},
    }
    if nested:
        child["properties"].update(nested)
    return child


def schema_artifact(identifier, children=None, mappings=None, required=None):
    return {
        "$schema": audit.JSON_SCHEMA_DRAFT_04,
        "@id": identifier,
        "@type": "https://schema.metadatacenter.org/core/Template",
        "schema:name": "Schema",
        "properties": {
            "@context": {
                "type": "object",
                "properties": mappings or {},
                "required": required or [],
            },
            **(children or {}),
        },
    }


class RuleTests(unittest.TestCase):
    def ref(self, artifact_type="template", identifier="https://repo.example/templates/t1"):
        return audit.ArtifactRef(artifact_type, identifier, "Example")

    def test_default_progress_interval_is_three_hundred(self):
        arguments = audit.build_parser().parse_args([])
        self.assertEqual(arguments.progress_every, 300)
        self.assertEqual(arguments.types, "template,element")
        self.assertEqual(audit.parse_types("all", audit.build_parser()), list(audit.TYPE_ORDER))

    def test_absolute_iri_rule_rejects_blank_relative_and_whitespace(self):
        self.assertTrue(audit.is_absolute_iri("https://repo.example/templates/t1"))
        self.assertTrue(audit.is_absolute_iri("urn:uuid:abc"))
        self.assertTrue(audit.is_well_formed_uri_reference("relative"))
        for value in (None, "", "   ", "tmp-123", "/relative", " https://repo.example/x", "https://a b"):
            self.assertFalse(audit.is_absolute_iri(value), value)
        self.assertTrue(audit.server_considers_child_id_usable(" https://repo.example/x "))

    def test_common_rules_find_legacy_provenance_and_meta_schema_defects(self):
        artifact = {
            "@id": self.ref().artifact_id,
            "pav:derivedFrom": "",
            "_ui": {"pages": []},
        }
        findings = list(audit.audit_common(self.ref(), artifact))
        self.assertEqual({item.rule for item in findings}, {"derived-from-empty", "ui-pages-forbidden"})
        self.assertEqual(
            {item.risk for item in findings},
            {"repair-on-save", "save-rejected"},
        )

    def test_common_rules_find_nonempty_unusable_provenance(self):
        artifact = {
            "@id": self.ref().artifact_id,
            "pav:derivedFrom": "relative-provenance",
        }
        findings = list(audit.audit_common(self.ref(), artifact))
        self.assertEqual([item.rule for item in findings], ["derived-from-unusable"])
        self.assertEqual(findings[0].risk, "repair-on-save")

    def test_schema_reports_unusable_child_id_mapping_and_required_entry(self):
        child = schema_child(audit.TEMPLATE_FIELD, "tmp-child")
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Study Name": child},
            {"Study Name": {"enum": [""]}},
            [],
        )
        rules = {item.rule for item in audit.audit_schema(self.ref(), artifact)}
        self.assertEqual(
            rules,
            {"child-id-unusable", "child-property-iri-unusable", "child-context-required-missing"},
        )

    def test_schema_reports_nested_prefix_mismatch(self):
        nested = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-elements/wrong-prefix",
        )
        element = schema_child(
            audit.TEMPLATE_ELEMENT,
            "https://repo.metadatacenter.org/template-elements/e1",
            "section",
            {"Nested": nested},
        )
        element["properties"]["@context"]["properties"]["Nested"] = {
            "enum": ["https://repo.metadatacenter.org/properties/p2"]
        }
        element["properties"]["@context"]["required"].append("Nested")
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Element": element},
            {"Element": {"enum": ["https://repo.metadatacenter.org/properties/p1"]}},
            ["Element"],
        )
        findings = list(audit.audit_schema(self.ref(), artifact))
        mismatch = [item for item in findings if item.rule == "child-id-prefix-mismatch"]
        self.assertEqual(len(mismatch), 1)
        self.assertIn("/properties/Element/properties/Nested/@id", mismatch[0].path)
        self.assertEqual(mismatch[0].risk, "manual-review")

    def test_schema_reports_child_id_whitespace_as_a_normalizer_gap(self):
        child = schema_child(audit.TEMPLATE_FIELD, " https://repo.metadatacenter.org/template-fields/f1 ")
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Field": child},
            {"Field": {"enum": ["https://repo.metadatacenter.org/properties/p1"]}},
            ["Field"],
        )

        findings = [
            item for item in audit.audit_schema(self.ref(), artifact)
            if item.rule == "child-id-surrounding-whitespace"
        ]

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].risk, "save-rejected")

    def test_schema_reports_object_shaped_multi_select_deployments_at_every_depth(self):
        direct = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/direct",
            "list",
        )
        direct["_valueConstraints"] = {"multipleChoice": True}
        nested = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/nested",
            "checkbox",
        )
        element = schema_child(
            audit.TEMPLATE_ELEMENT,
            "https://repo.metadatacenter.org/template-elements/e1",
            "section",
            {"Nested": nested},
        )
        for container, name in ((element, "Nested"),):
            container["properties"]["@context"]["properties"][name] = {
                "enum": [f"https://repo.metadatacenter.org/properties/{name.lower()}"]
            }
            container["properties"]["@context"]["required"].append(name)
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Direct": direct, "Element": element},
            {
                "Direct": {"enum": ["https://repo.metadatacenter.org/properties/direct"]},
                "Element": {"enum": ["https://repo.metadatacenter.org/properties/element"]},
            },
            ["Direct", "Element"],
        )

        findings = [
            item for item in audit.audit_schema(self.ref(), artifact)
            if item.rule == "inherently-multiple-child-object"
        ]

        self.assertEqual(
            ["/properties/Direct", "/properties/Element/properties/Nested"],
            [item.path for item in findings],
        )
        self.assertTrue(all(item.risk == "instance-save-rejected" for item in findings))

    def test_schema_does_not_treat_a_standalone_multi_select_field_as_a_bad_deployment(self):
        field = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/f1",
            "list",
        )
        field["_valueConstraints"] = {"multipleChoice": True}

        rules = {
            item.rule for item in audit.audit_schema(self.ref("field", field["@id"]), field)
        }

        self.assertNotIn("inherently-multiple-child-object", rules)

    def test_schema_reports_missing_child_declarations_as_repairable(self):
        child = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/f1",
        )
        child.pop("$schema")
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Study Name": child},
            {"Study Name": {"enum": ["https://repo.metadatacenter.org/properties/p1"]}},
            ["Study Name"],
        )

        findings = list(audit.audit_schema(self.ref(), artifact))

        self.assertEqual([item.rule for item in findings], ["child-schema-missing"])
        self.assertEqual(findings[0].risk, "repair-on-save")
        self.assertEqual(findings[0].path, "/properties/Study Name/$schema")

    def test_schema_reports_missing_root_and_explicit_bad_child_declarations_as_rejected(self):
        child = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/f1",
        )
        child["$schema"] = "not-a-schema"
        artifact = schema_artifact(
            self.ref().artifact_id,
            {"Study Name": child},
            {"Study Name": {"enum": ["https://repo.metadatacenter.org/properties/p1"]}},
            ["Study Name"],
        )
        artifact.pop("$schema")

        findings = list(audit.audit_schema(self.ref(), artifact))

        self.assertEqual(
            [(item.rule, item.risk) for item in findings],
            [("root-schema-missing", "save-rejected"), ("child-schema-invalid", "save-rejected")],
        )

    def test_shape_uses_ui_to_avoid_treating_value_schema_as_a_child(self):
        artifact = schema_artifact(
            self.ref().artifact_id,
            {
                "Real": schema_child(
                    audit.TEMPLATE_FIELD,
                    "https://repo.metadatacenter.org/template-fields/f1",
                ),
                "rdfs:label": {"type": "object", "properties": {"@value": {"type": "string"}}},
            },
        )
        shape = audit.build_schema_shape(artifact)
        self.assertEqual(set(shape.children), {"Real"})

    def test_instance_rules_are_template_aware(self):
        attributes = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/attrs",
            "attribute-value",
        )
        name = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/name",
            "text",
        )
        participant = schema_child(
            audit.TEMPLATE_ELEMENT,
            "https://repo.metadatacenter.org/template-elements/participant",
            "section",
        )
        template_id = "https://repo.example/templates/t1"
        template = schema_artifact(template_id, {
            "Additional": attributes,
            "Name": name,
            "Participant": {"type": "array", "items": participant},
        })
        instance_id = "https://repo.example/template-instances/i1"
        instance = {
            "@id": instance_id,
            "schema:isBasedOn": template_id,
            "@context": {},
            "Additional": ["", "@context", "Name", "Duplicate", "Duplicate"],
            "Duplicate": {"@value": "kept"},
            "Participant": [{"@id": "", "@context": {}}],
            "Link": {"@id": "relative-term"},
        }
        ref = self.ref("instance", instance_id)
        findings = list(audit.audit_instance(ref, instance, audit.build_schema_shape(template)))
        rules = collections_counter(item.rule for item in findings)
        self.assertEqual(rules["attribute-name-blank"], 1)
        self.assertEqual(rules["attribute-name-reserved"], 1)
        self.assertEqual(rules["attribute-name-child-collision"], 1)
        self.assertEqual(rules["attribute-name-duplicate"], 1)
        self.assertEqual(rules["attribute-property-iri-missing"], 1)
        self.assertEqual(rules["occurrence-id-unusable"], 1)
        self.assertEqual(rules["value-id-relative"], 1)

    def test_value_ids_distinguish_reader_failures_relative_iris_and_validation_failures(self):
        ref = self.ref("instance", "https://repo.example/template-instances/i1")
        instance = {
            "@id": ref.artifact_id,
            "@context": {},
            "Blank": {"@id": ""},
            "Relative": {"@id": "0000-0002-1825-0097"},
            "Malformed": {"@id": "https://orcid.org/ 0000-0002-1825-0097"},
            "Null": {"@id": None},
            "Number": {"@id": 7},
            "Contextless element": {"@id": "", "Nested": {"@value": "kept"}},
        }

        findings = list(audit.audit_value_ids(ref, instance))

        self.assertEqual(
            [(item.rule, item.risk) for item in findings],
            [
                ("value-id-empty", "reader-blocking"),
                ("value-id-relative", "manual-review"),
                ("value-id-malformed", "reader-blocking"),
                ("value-id-null", "save-rejected"),
                ("value-id-not-string", "save-rejected"),
            ],
        )
        self.assertFalse(any("Contextless element" in item.path for item in findings))

    def test_structural_occurrence_fallback_works_without_template(self):
        instance_id = "https://repo.example/template-instances/i1"
        template_id = "https://repo.example/templates/missing"
        instance = {
            "@id": instance_id,
            "schema:isBasedOn": template_id,
            "@context": {},
            "Element": {"@id": "", "@context": {}},
        }
        ref = self.ref("instance", instance_id)
        rules = collections_counter(item.rule for item in audit.audit_instance(ref, instance, None))
        self.assertEqual(rules["occurrence-id-unusable"], 1)
        self.assertEqual(rules["template-analysis-unavailable"], 1)

    def test_named_attribute_context_term_is_not_an_orphan_without_a_value_key(self):
        attributes = schema_child(
            audit.TEMPLATE_FIELD,
            "https://repo.metadatacenter.org/template-fields/attrs",
            "attribute-value",
        )
        template_id = "https://repo.example/templates/t1"
        template = schema_artifact(template_id, {"Additional": attributes})
        instance_id = "https://repo.example/template-instances/i1"
        instance = {
            "@id": instance_id,
            "schema:isBasedOn": template_id,
            "@context": {
                "Unfilled": audit.REPOSITORY_PROPERTY_IRI_PREFIX + "p1",
            },
            "Additional": ["Unfilled"],
        }
        ref = self.ref("instance", instance_id)
        rules = [
            item.rule for item in audit.audit_instance(ref, instance, audit.build_schema_shape(template))
        ]
        self.assertNotIn("orphan-property-iri", rules)
        self.assertNotIn("attribute-property-iri-missing", rules)


def collections_counter(values):
    result = {}
    for value in values:
        result[value] = result.get(value, 0) + 1
    return result


class _FakeCedarHandler(BaseHTTPRequestHandler):
    artifacts = {}
    extra_search_rows = []
    unfetchable = set()
    requests = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.requests.append((self.command, self.path, self.headers.get("Authorization")))
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/search-deep":
            query = urllib.parse.parse_qs(parsed.query)
            artifact_type = query["resource_types"][0]
            offset = int(query.get("offset", ["0"])[0])
            limit = int(query.get("limit", ["100"])[0])
            rows = [
                {"@id": identifier, "schema:name": body.get("schema:name", ""),
                 "resourceType": kind}
                for (kind, identifier), body in self.__class__.artifacts.items()
                if kind == artifact_type
            ]
            rows.extend(
                row for row in self.__class__.extra_search_rows
                if row.get("resourceType") == artifact_type
            )
            self.send_json({"resources": rows[offset:offset + limit], "totalCount": len(rows)})
            return
        parts = parsed.path.strip("/").split("/", 1)
        reverse = {value: key for key, value in audit.ARTIFACT_PATHS.items()}
        if len(parts) == 2 and parts[0] in reverse:
            key = (reverse[parts[0]], urllib.parse.unquote(parts[1]))
            if key in self.__class__.unfetchable:
                self.send_response(404)
                self.end_headers()
                return
            if key in self.__class__.artifacts:
                self.send_json(self.__class__.artifacts[key])
                return
        self.send_response(404)
        self.end_headers()

    def send_json(self, value):
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class RestIntegrationTests(unittest.TestCase):
    def setUp(self):
        template_id = "https://repo.example/templates/t1"
        _FakeCedarHandler.artifacts = {
            ("template", template_id): schema_artifact(template_id),
            ("element", "https://repo.example/template-elements/e1"): schema_artifact(
                "https://repo.example/template-elements/e1"
            ),
            ("field", "https://repo.example/template-fields/f1"): {
                "$schema": audit.JSON_SCHEMA_DRAFT_04,
                "@id": "https://repo.example/template-fields/f1", "schema:name": "Field"
            },
            ("instance", "https://repo.example/template-instances/i1"): {
                "@id": "https://repo.example/template-instances/i1",
                "schema:name": "Instance",
                "schema:isBasedOn": template_id,
                "@context": {},
            },
        }
        _FakeCedarHandler.unfetchable = set()
        _FakeCedarHandler.extra_search_rows = []
        _FakeCedarHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeCedarHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_get_only_end_to_end_and_progress_checkpoint(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        with tempfile.TemporaryDirectory() as directory:
            findings = Path(directory) / "findings.jsonl"
            summary = Path(directory) / "summary.json"
            previous = os.environ.get("CEDAR_API_KEY")
            os.environ["CEDAR_API_KEY"] = "test-secret"
            stdout, stderr = io.StringIO(), io.StringIO()
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    result = audit.main([
                        "--server", origin,
                        "--allow-http",
                        "--types", "all",
                        "--page-size", "1",
                        "--progress-every", "3",
                        "--out", str(findings),
                        "--summary", str(summary),
                    ])
            finally:
                if previous is None:
                    os.environ.pop("CEDAR_API_KEY", None)
                else:
                    os.environ["CEDAR_API_KEY"] = previous

            self.assertEqual(result, 0)
            report = json.loads(summary.read_text())
            self.assertEqual(report["status"], "COMPLETE_FOR_KEY")
            self.assertEqual(report["artifactsProcessed"], 4)
            self.assertEqual(report["artifactsFetched"], 4)
            self.assertEqual(report["completion"], {"percent": 100.0, "processed": 4, "target": 4})
            self.assertEqual(report["scope"]["selectedArtifactTotal"], 4)
            self.assertEqual(report["scope"]["httpMethods"], ["GET"])
            self.assertEqual(report["auditRuleset"]["version"], audit.AUDIT_RULESET_VERSION)
            self.assertEqual(len(report["auditRuleset"]["scriptSha256"]), 64)
            self.assertEqual(report["affectedArtifactsByRisk"], {})
            self.assertEqual(findings.read_text(), "")
            self.assertEqual(findings.stat().st_mode & 0o077, 0)
            self.assertEqual(summary.stat().st_mode & 0o077, 0)
            self.assertIn("[checkpoint 3/4 75.0%]", stdout.getvalue())
            self.assertIn("[final 4/4 100.0%]", stdout.getvalue())
            self.assertNotIn("test-secret", stdout.getvalue() + stderr.getvalue())
            self.assertTrue(_FakeCedarHandler.requests)
            self.assertTrue(all(method == "GET" for method, _, _ in _FakeCedarHandler.requests))
            self.assertTrue(all(auth == "apiKey test-secret" for _, _, auth in _FakeCedarHandler.requests))

    def test_fetch_errors_are_persisted_in_jsonl_and_summary(self):
        field_id = "https://repo.example/template-fields/f1"
        _FakeCedarHandler.unfetchable.add(("field", field_id))
        origin = f"http://127.0.0.1:{self.server.server_port}"
        with tempfile.TemporaryDirectory() as directory:
            findings = Path(directory) / "findings.jsonl"
            summary = Path(directory) / "summary.json"
            previous = os.environ.get("CEDAR_API_KEY")
            os.environ["CEDAR_API_KEY"] = "test-secret"
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = audit.main([
                        "--server", origin,
                        "--allow-http",
                        "--types", "field",
                        "--retries", "1",
                        "--out", str(findings),
                        "--summary", str(summary),
                    ])
            finally:
                if previous is None:
                    os.environ.pop("CEDAR_API_KEY", None)
                else:
                    os.environ["CEDAR_API_KEY"] = previous

            self.assertEqual(result, 2)
            records = [json.loads(line) for line in findings.read_text().splitlines()]
            self.assertEqual([record["rule"] for record in records], ["artifact-fetch-failed"])
            self.assertEqual(records[0]["artifact_id"], field_id)
            self.assertEqual(records[0]["risk"], "audit-incomplete")
            report = json.loads(summary.read_text())
            self.assertEqual(report["status"], "PARTIAL_ERRORS")
            self.assertEqual(report["findingsByRule"]["artifact-fetch-failed"], 1)
            self.assertEqual(report["fetchErrorDetails"][0]["artifactId"], field_id)

    def test_progress_total_uses_unique_enumerated_ids_when_search_has_duplicates(self):
        template_id = "https://repo.example/templates/t1"
        _FakeCedarHandler.extra_search_rows = [{
            "@id": template_id,
            "schema:name": "Duplicate search row",
            "resourceType": "template",
        }]
        origin = f"http://127.0.0.1:{self.server.server_port}"
        with tempfile.TemporaryDirectory() as directory:
            findings = Path(directory) / "findings.jsonl"
            summary = Path(directory) / "summary.json"
            previous = os.environ.get("CEDAR_API_KEY")
            os.environ["CEDAR_API_KEY"] = "test-secret"
            stdout, stderr = io.StringIO(), io.StringIO()
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    result = audit.main([
                        "--server", origin,
                        "--allow-http",
                        "--types", "template",
                        "--page-size", "10",
                        "--out", str(findings),
                        "--summary", str(summary),
                    ])
            finally:
                if previous is None:
                    os.environ.pop("CEDAR_API_KEY", None)
                else:
                    os.environ["CEDAR_API_KEY"] = previous

            self.assertEqual(result, 2)
            report = json.loads(summary.read_text())
            self.assertEqual(report["scope"]["searchReportedTotal"], 2)
            self.assertEqual(report["scope"]["selectedArtifactTotal"], 1)
            self.assertEqual(report["completion"], {"percent": 100.0, "processed": 1, "target": 1})
            self.assertEqual(report["duplicateSearchRowsSkipped"], 1)
            self.assertEqual(report["listingErrors"], 1)
            self.assertIn("[final 1/1 100.0%]", stdout.getvalue())

if __name__ == "__main__":
    unittest.main()
