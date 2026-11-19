#!/usr/bin/env python3
"""Tests for cedar_snapshot_read_audit.py: how it groups refusals into causes, and its verdict.

The bridges themselves are exercised by running the audit over a snapshot. These tests cover what the
summary says about a refusal, whose cause must be countable across artifacts and must not repeat
stored values, and the exit code --fail-on-disagreement gives, which is one of the two gates that
hold the Java and TypeScript libraries to the same verdicts. The verdict is driven through main with
stand-in bridges over a three-artifact snapshot.

    python3 -m unittest ops/test_cedar_snapshot_read_audit.py
"""

import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

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


TEMPLATE = "https://repo.metadatacenter.org/templates/t"
FIELD = "https://repo.metadatacenter.org/template-fields/f"
INSTANCE = "https://repo.metadatacenter.org/template-instances/i"
ENTRIES = [({"type": "template", "id": TEMPLATE}, {"@id": TEMPLATE}),
           ({"type": "field", "id": FIELD}, {"@id": FIELD}),
           ({"type": "instance", "id": INSTANCE, "template": TEMPLATE},
            {"@id": INSTANCE, "schema:isBasedOn": TEMPLATE})]


class StandInSnapshot:
    def __init__(self, path):
        self.path = pathlib.Path(path)

    def header(self):
        return {"deployment": "test", "fetchedAt": "2026-11-16T00:00:00Z", "counts": {}}, {}

    def artifacts(self):
        for entry, body in ENTRIES:
            yield entry, json.dumps(body).encode()


class World:
    """What the stand-in bridges answer: the Java verdict and the TypeScript save decision per
    artifact, and which YAML read-backs a reader refuses."""

    def __init__(self):
        self.java_valid = {TEMPLATE: True, FIELD: True, INSTANCE: True}
        self.ts_saves = {TEMPLATE: True, FIELD: True, INSTANCE: True}
        self.java_refuses_own_yaml: set[str] = set()
        self.java_refuses_ts_yaml: set[str] = set()


WORLD = World()


class StandInBridge:
    """A bridge that answers each request at once, as the real ones do over their pipes."""

    def __init__(self, name, _command, _log, answers):
        self.name = name
        self.answers = answers
        self.templates = AUDIT.collections.OrderedDict()
        self.process = mock.Mock()
        self.process.stdin.close.side_effect = lambda: self.answers.put(
            (self.name, None, {"bridgeEnded": 0, "unanswered": 0}))

    def send(self, header, body, context):
        self.answers.put((self.name, context, self.answer(header, body)))

    def answer(self, header, body):
        java = self.name.startswith("java")
        if header["op"] == "template":
            return {"status": "kept"}
        if header["op"] == "readYaml":
            # The stand-in YAML is the artifact's identifier.
            identifier = body.decode()
            return {"yaml": {"status": "refused" if identifier in WORLD.java_refuses_ts_yaml else "read"}}
        identifier = json.loads(body)["@id"]
        if java:
            valid = WORLD.java_valid[identifier]
            return {"reader": {"status": "read"},
                    "validation": {"status": "valid" if valid else "invalid",
                                   "errors": [] if valid else [{"message": "refused 'x'"}]},
                    "renderer": {"json": "rendered", "yaml": "rendered", "compactYamlRead": "read",
                                 "yamlRead": "refused" if identifier in WORLD.java_refuses_own_yaml else "read"}}
        judged = {"canSave": WORLD.ts_saves[identifier], "blocking": [{"code": "blocked", "message": "no"}]}
        reader = {"status": "read", "validation" if header["kind"] == "instance" else "schemaValidation": judged}
        # The TypeScript library's YAML goes to a Java reader, which answers by the artifact's identifier.
        return {"reader": reader, "renderer": {"yamlText": identifier}}

    def close(self):
        pass


class DisagreementGateTest(unittest.TestCase):
    """--fail-on-disagreement fails the run on any difference between the libraries' verdicts."""

    def setUp(self):
        global WORLD
        WORLD = World()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.library = self.folder / "index.js"
        self.library.write_text("// stand-in")
        for patch in (mock.patch.object(AUDIT, "Bridge", StandInBridge),
                      mock.patch.object(AUDIT, "Snapshot", StandInSnapshot)):
            patch.start()
            self.addCleanup(patch.stop)

    def run_audit(self, *options):
        out = self.folder / f"out-{len(list(self.folder.iterdir()))}"
        argv = ["--snapshot", str(self.folder / "snapshot.tar.zst"), "--java-classpath", "classes",
                "--ts-library", str(self.library), "--out", str(out), "--java-bridges", "2",
                "--ts-bridges", "2", *options]
        with contextlib.redirect_stdout(io.StringIO()):
            code = AUDIT.main(argv)
        return code, json.loads((out / "summary.json").read_text())

    def assert_gate(self, expected_failure: bool):
        lenient, _ = self.run_audit()
        strict, summary = self.run_audit("--fail-on-disagreement")
        self.assertEqual(0, lenient)
        self.assertEqual(1 if expected_failure else 0, strict)
        self.assertEqual(3, summary["artifacts"])
        self.assertEqual([], summary["problems"])
        return summary

    def test_agreement_passes(self):
        summary = self.assert_gate(expected_failure=False)
        self.assertEqual({"agree": 1}, summary["validationParity"]["counts"])
        self.assertEqual({"field": {"agree": 1}, "template": {"agree": 1}},
                         summary["schemaValidationParity"]["byType"])
        self.assertEqual(0, summary["yamlParity"]["validatorAcceptsButYamlRefusedCount"])

    def test_an_instance_java_accepts_and_typescript_blocks_fails(self):
        WORLD.ts_saves[INSTANCE] = False
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual({"javaValid-tsBlocks": 1}, summary["validationParity"]["counts"])

    def test_an_instance_java_refuses_and_typescript_saves_fails(self):
        WORLD.java_valid[INSTANCE] = False
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual({"javaInvalid-tsSaves": 1}, summary["validationParity"]["counts"])

    def test_a_schema_artifact_judged_differently_fails_in_either_direction(self):
        WORLD.ts_saves[FIELD] = False
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual({"javaValid-tsBlocks": 1}, summary["schemaValidationParity"]["byType"]["field"])
        WORLD.ts_saves[FIELD] = True
        WORLD.java_valid[TEMPLATE] = False
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual({"javaInvalid-tsSaves": 1}, summary["schemaValidationParity"]["byType"]["template"])

    def test_a_refused_yaml_form_of_a_valid_artifact_fails(self):
        WORLD.java_refuses_own_yaml.add(FIELD)
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual([{"type": "field", "id": FIELD, "lanes": ["javaReadsJava:full"]}],
                         summary["yamlParity"]["validatorAcceptsButYamlRefused"])
        WORLD.java_refuses_own_yaml.clear()
        WORLD.java_refuses_ts_yaml.add(INSTANCE)
        summary = self.assert_gate(expected_failure=True)
        self.assertEqual([{"type": "instance", "id": INSTANCE, "lanes": ["javaReadsTs:full"]}],
                         summary["yamlParity"]["validatorAcceptsButYamlRefused"])

    def test_a_refused_yaml_form_of_an_invalid_artifact_is_the_data_s_and_passes(self):
        WORLD.java_valid[FIELD] = False
        WORLD.ts_saves[FIELD] = False
        WORLD.java_refuses_own_yaml.add(FIELD)
        summary = self.assert_gate(expected_failure=False)
        self.assertEqual(0, summary["yamlParity"]["validatorAcceptsButYamlRefusedCount"])


if __name__ == "__main__":
    unittest.main()
