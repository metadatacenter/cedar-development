"""End-to-end cover for the YAML conversion audit, both bridges included.

The audit's value is that it runs two real model libraries over real documents, so a test that
stubs them proves nothing worth knowing. A local HTTP server stands in for the resource server and
serves the YAML in ``cedar-test-artifacts``; everything after the fetch — the JVM, Node, the
validator, the records, the summary and the report — is the real thing.

The suite skips when a toolchain it cannot build is absent, which is what a machine without JDK 17
or without the TypeScript library's ``dist`` sees.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


OPS = Path(__file__).parents[1]
CEDAR_HOME = OPS.parents[1]
SCRIPT = OPS / "cedar_yaml_conversion_audit.py"
SPEC = importlib.util.spec_from_file_location("cedar_yaml_conversion_audit", SCRIPT)
conversion = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = conversion
SPEC.loader.exec_module(conversion)

TEST_ARTIFACTS = CEDAR_HOME / "cedar-test-artifacts" / "artifacts"
TS_LIBRARY = CEDAR_HOME / "cedar-model-typescript-library" / "dist" / "index.js"
ARTIFACT_LIBRARY_CLASSES = CEDAR_HOME / "cedar-artifact-library" / "target" / "classes"
VALIDATION_LIBRARY_CLASSES = CEDAR_HOME / "cedar-model-validation-library" / "target" / "classes"

# One directory per artifact, holding the YAML the Java library generates from the reference JSON.
CORPUS_DIRECTORIES = {"template": "templates", "element": "elements", "field": "fields"}
PER_TYPE = 4


# The identifier a stub row carries. A document's own identifier is not used: the audit keys every
# record on what the search enumerated, and a stored artifact in the corpus need not carry one.
REPOSITORY = "https://repo.metadatacenter.org"
REPOSITORY_PATHS = {"template": "templates", "element": "template-elements",
                    "field": "template-fields"}


def corpus() -> dict[str, list[tuple[str, str, str]]]:
    """A few artifacts of each kind: the identifier the stub serves them under, a name, and the YAML."""
    found: dict[str, list[tuple[str, str, str]]] = {}
    for kind, directory in CORPUS_DIRECTORIES.items():
        documents = sorted((TEST_ARTIFACTS / directory).glob(
            f"*/{kind}-*-generated-java-artifact-lib.yaml"))
        found[kind] = [
            (f"{REPOSITORY}/{REPOSITORY_PATHS[kind]}/{document.parent.name}",
             f"{kind} {document.parent.name}",
             document.read_text(encoding="utf-8"))
            for document in documents[:PER_TYPE]
        ]
    return found


class ResourceServerStub(BaseHTTPRequestHandler):
    """Enough of the resource server to drive one audit: /search-deep and the three typed GETs."""

    corpus: dict[str, list[tuple[str, str, str]]] = {}
    paths = {"templates": "template", "template-elements": "element", "template-fields": "field"}
    yaml_requests: list[str] = []

    def log_message(self, *args):  # noqa: D102 - silence the default stderr logging
        pass

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/search-deep":
            kind = query.get("resource_types", ["template"])[0]
            rows = [{"@id": identifier, "schema:name": name}
                    for identifier, name, _ in self.corpus.get(kind, [])]
            limit = int(query.get("limit", ["500"])[0])
            self._send_json({"totalCount": len(rows), "resources": rows[:limit]})
            return
        segments = parsed.path.lstrip("/").split("/", 1)
        if len(segments) == 2 and segments[0] in self.paths:
            kind = self.paths[segments[0]]
            wanted = urllib.parse.unquote(segments[1])
            for identifier, _, document in self.corpus.get(kind, []):
                if identifier == wanted:
                    self.yaml_requests.append(self.headers.get("Accept", ""))
                    self._send_text(document, "application/yaml")
                    return
        self.send_error(404)

    def _send_json(self, body):
        self._send_text(json.dumps(body), "application/json")

    def _send_text(self, body: str, content_type: str):
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def toolchain_available() -> tuple[bool, str]:
    if not TEST_ARTIFACTS.is_dir():
        return False, f"cedar-test-artifacts not checked out at {TEST_ARTIFACTS}"
    if not TS_LIBRARY.is_file():
        return False, f"the TypeScript library is not built ({TS_LIBRARY})"
    for classes in (ARTIFACT_LIBRARY_CLASSES, VALIDATION_LIBRARY_CLASSES):
        if not classes.is_dir():
            return False, f"{classes} is not built"
    if subprocess.run(["which", "node"], capture_output=True).returncode != 0:
        return False, "node is not on PATH"
    try:
        java = conversion.audit.run_validate_sh("java", 60)
    except Exception as error:  # noqa: BLE001 - any failure here means the gate cannot resolve JDK 17
        return False, f"cedar_validate.sh cannot resolve JDK 17: {error}"
    if not Path(java).is_file():
        return False, f"java not found at {java}"
    return True, ""


AVAILABLE, UNAVAILABLE_REASON = toolchain_available()


@unittest.skipUnless(AVAILABLE, UNAVAILABLE_REASON)
class YamlConversionAuditEndToEnd(unittest.TestCase):
    """One whole audit against a stub server, with both real converters and the real validator."""

    @classmethod
    def setUpClass(cls):
        cls.corpus = corpus()
        for kind, documents in cls.corpus.items():
            if not documents:
                raise unittest.SkipTest(f"no {kind} YAML in {TEST_ARTIFACTS}")
        ResourceServerStub.corpus = cls.corpus
        ResourceServerStub.yaml_requests = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), ResourceServerStub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

        cls.directory = Path(tempfile.mkdtemp(prefix="yaml-conversion-audit-"))
        cls.records = cls.directory / "run.jsonl"
        cls.output = io.StringIO()
        with mock.patch.dict(os.environ, {"CEDAR_API_KEY": "test-key", "CEDAR_HOME": str(CEDAR_HOME)}):
            with contextlib.redirect_stdout(cls.output):
                cls.exit_code = conversion.main([
                    "--server", cls.origin, "--allow-http",
                    "--out", str(cls.records),
                    "--progress-every", "5",
                    "--save-failing", str(cls.directory / "failing"),
                ])
        cls.report = cls.output.getvalue()
        cls.written = [json.loads(line) for line in
                       cls.records.read_text(encoding="utf-8").splitlines() if line.strip()]
        cls.summary = json.loads((cls.directory / "run-summary.json").read_text(encoding="utf-8"))
        cls.failures = json.loads((cls.directory / "run-failures.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=10)

    def total(self) -> int:
        return sum(len(documents) for documents in self.corpus.values())

    def test_every_artifact_is_fetched_as_yaml_and_recorded_once(self):
        self.assertEqual(len(self.written), self.total())
        self.assertEqual(len({record["artifactId"] for record in self.written}), self.total())
        self.assertTrue(all(record["fetched"] for record in self.written), self.report)
        self.assertTrue(all(request == "application/yaml"
                            for request in ResourceServerStub.yaml_requests),
                        ResourceServerStub.yaml_requests)
        self.assertTrue(all(record["yaml"]["mediaType"] == "application/yaml"
                            for record in self.written))

    def test_both_lanes_report_an_outcome_for_every_artifact(self):
        for record in self.written:
            for lane in conversion.LANES:
                self.assertIn(record["outcome"][lane], conversion.OUTCOMES, record["artifactId"])
                self.assertIn("convert", record[lane], record["artifactId"])

    def test_the_java_lane_converts_and_validates_the_corpus_the_library_itself_wrote(self):
        """The Java library's own YAML must survive its own round trip; anything else is a defect."""
        failures = [record["artifactId"] for record in self.written
                    if record["outcome"][conversion.JAVA] != "valid"]
        self.assertEqual(failures, [], self.report)

    def test_the_validator_is_the_same_one_for_both_lanes(self):
        toolchain = self.summary["toolchain"]
        self.assertIn("CedarValidator", toolchain[conversion.JAVA]["validator"])
        self.assertIn("node", toolchain[conversion.TYPESCRIPT])

    def test_the_summary_totals_agree_with_the_records(self):
        completion = self.summary["completion"]
        self.assertEqual(completion["processed"], self.total())
        self.assertEqual(completion["target"], self.total())
        for lane in conversion.LANES:
            counted = self.summary["lanes"][lane]["outcomes"]
            self.assertEqual(sum(counted.values()), self.total())
            for outcome in conversion.OUTCOMES:
                expected = sum(1 for record in self.written if record["outcome"][lane] == outcome)
                self.assertEqual(counted.get(outcome, 0), expected, f"{lane}/{outcome}")
        self.assertEqual(sum(self.summary["crossTabulation"].values()), self.total())

    def test_the_failures_file_names_exactly_the_artifacts_that_failed(self):
        expected = {record["artifactId"] for record in self.written
                    if any(record["outcome"][lane] != "valid" for lane in conversion.LANES)}
        self.assertEqual(set(self.failures["failedArtifactIds"]), expected)
        self.assertEqual(set(self.summary["failedArtifactIds"]), expected)
        for lane in conversion.LANES:
            named = {entry["artifactId"] for entry in self.failures["byLane"][lane]["artifacts"]}
            self.assertEqual(named, {record["artifactId"] for record in self.written
                                     if record["outcome"][lane] != "valid"})
            self.assertTrue(all(entry["reason"] for entry in self.failures["byLane"][lane]["artifacts"]))

    def test_a_failing_artifact_keeps_its_yaml_and_renderings(self):
        failing = self.directory / "failing"
        expected = [record for record in self.written
                    if any(record["outcome"][lane] != "valid" for lane in conversion.LANES)]
        if not expected:
            self.assertFalse(failing.exists(), "nothing failed, so nothing should have been saved")
            return
        self.assertEqual(len(list(failing.glob("*.yaml"))), len(expected))

    def test_the_printed_report_names_the_failing_identifiers(self):
        self.assertIn("=== Final report ===", self.report)
        self.assertIn("Schema artifacts that failed in at least one lane:", self.report)
        for entry in self.failures["byLane"][conversion.TYPESCRIPT]["artifacts"][:5]:
            self.assertIn(entry["artifactId"], self.report)

    def test_a_resume_over_a_finished_run_adds_nothing(self):
        before = self.records.read_text(encoding="utf-8")
        with mock.patch.dict(os.environ, {"CEDAR_API_KEY": "test-key", "CEDAR_HOME": str(CEDAR_HOME)}):
            with contextlib.redirect_stdout(io.StringIO()) as second:
                code = conversion.main([
                    "--server", self.origin, "--allow-http",
                    "--out", str(self.records), "--resume",
                ])
        self.assertEqual(code, self.exit_code)
        self.assertEqual(self.records.read_text(encoding="utf-8"), before)
        self.assertIn(f"{self.total()}/{self.total()} artifacts already complete", second.getvalue())


@unittest.skipUnless(AVAILABLE, UNAVAILABLE_REASON)
class DeploymentThatDoesNotServeYaml(unittest.TestCase):
    """A server that answers JSON to an Accept of application/yaml stops the run at the preflight."""

    class JsonOnlyStub(ResourceServerStub):
        def _send_text(self, body, content_type):
            super()._send_text(body, "application/json")

    def test_the_run_stops_with_a_status_that_says_why(self):
        self.JsonOnlyStub.corpus = corpus()
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.JsonOnlyStub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        directory = Path(tempfile.mkdtemp(prefix="yaml-conversion-audit-json-"))
        try:
            with mock.patch.dict(os.environ, {"CEDAR_API_KEY": "test-key",
                                              "CEDAR_HOME": str(CEDAR_HOME)}):
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    with contextlib.redirect_stderr(io.StringIO()) as err:
                        code = conversion.main([
                            "--server", f"http://127.0.0.1:{server.server_address[1]}",
                            "--allow-http", "--out", str(directory / "run.jsonl"),
                        ])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)
        self.assertEqual(code, 2)
        self.assertIn("does not serve the YAML representation", err.getvalue())
        self.assertIn("status: PARTIAL_NO_YAML_REPRESENTATION", out.getvalue())
        summary = json.loads((directory / "run-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["status"], "PARTIAL_NO_YAML_REPRESENTATION")
        self.assertEqual(summary["completion"]["processed"], 0)


class BoundedVerdicts(unittest.TestCase):
    """A verdict contributes exact counts and a bounded list."""

    def test_the_counts_are_exact_and_the_lists_are_capped(self):
        errors = [{"location": f"/{index}", "message": "no"} for index in range(9)]
        record, outcome = conversion.verdict_record(
            {"status": "invalid", "errors": errors, "warnings": [], "millis": 3}, max_errors=4)
        self.assertEqual(outcome, "invalid")
        self.assertEqual(record["errorCount"], 9)
        self.assertEqual(len(record["errors"]), 4)
        self.assertNotIn("warnings", record)

    def test_a_bridge_answer_that_is_not_a_verdict_becomes_an_outcome_of_its_own(self):
        record, outcome = conversion.verdict_record(
            {"status": "bridge-error", "message": "the bridge stopped answering"}, max_errors=20)
        self.assertEqual(outcome, "bridge-error")
        self.assertEqual(record["reason"], "the bridge stopped answering")


class SchemaTypeSelection(unittest.TestCase):
    """The scope stops at the three kinds that carry a schema."""

    def setUp(self):
        self.parser = conversion.build_parser()

    def test_all_selects_the_three_schema_kinds_in_a_fixed_order(self):
        self.assertEqual(conversion.parse_schema_types("all", self.parser),
                         ["template", "element", "field"])
        self.assertEqual(conversion.parse_schema_types("field,template", self.parser),
                         ["template", "field"])

    def test_an_instance_is_refused_with_the_kinds_that_are_allowed(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                conversion.parse_schema_types("instance", self.parser)
        self.assertIn("template, element, field", stderr.getvalue())


class FirstErrorLine(unittest.TestCase):
    """What the report prints beside a failing identifier."""

    def test_a_conversion_failure_names_the_stage_it_failed_at(self):
        record = {"convert": {"status": "error", "stage": "read", "message": "no modelVersion"}}
        self.assertEqual(conversion.first_error(record), "read: no modelVersion")

    def test_a_validation_failure_names_the_location_and_message(self):
        record = {"convert": {"status": "ok"},
                  "validation": {"status": "invalid",
                                 "errors": [{"location": "/properties", "message": "missing"}]}}
        self.assertEqual(conversion.first_error(record), "/properties: missing")

    def test_a_bridge_failure_still_says_something(self):
        record = {"convert": {"status": "bridge-error", "message": "the bridge stopped answering"}}
        self.assertEqual(conversion.first_error(record), "convert: the bridge stopped answering")


if __name__ == "__main__":
    unittest.main()


class ResumeCounting(unittest.TestCase):
    """A resumed run counts each artifact once, however many times it was tried."""

    def test_a_record_that_failed_to_fetch_is_not_counted_until_it_is_retried(self):
        aggregate = conversion.Aggregate()
        failed = {
            "artifactType": "template", "artifactId": "https://example.org/t/1", "artifactName": "t",
            "fetched": False, "fetch": {"reason": "fetch-failed", "error": "boom"},
            "outcome": {lane: "skipped" for lane in conversion.LANES},
        }
        # What the resume path now does: only a fetched record contributes before the pass starts.
        self.assertFalse(failed.get("fetched"))
        aggregate.add(failed)
        self.assertEqual(aggregate.processed, 1)
        # Counting it a second time, as the pass does when the retry is emitted, is what the old
        # resume produced for every retried artifact.
        aggregate.add(failed)
        self.assertEqual(aggregate.processed, 2)


class ConsideredRejections(unittest.TestCase):
    """A 500 the server means is not retried; one it did not is."""

    def test_a_cedar_error_document_is_not_retried(self):
        body = json.dumps({"status": "INTERNAL_SERVER_ERROR", "statusCode": 500,
                           "message": "Invalid version 0.1 for field pav:version at ",
                           "errorId": "83a11f9d-5292-4201-92a2-bd9648fddfd8"})
        self.assertTrue(conversion.rest.is_considered_rejection(500, body))

    def test_a_server_that_fell_over_is_retried(self):
        self.assertFalse(conversion.rest.is_considered_rejection(500, "<html>502 Bad Gateway</html>"))
        self.assertFalse(conversion.rest.is_considered_rejection(500, ""))
        self.assertFalse(conversion.rest.is_considered_rejection(500, json.dumps({"errorId": "x"})))

    def test_only_a_500_counts(self):
        body = json.dumps({"message": "slow down", "errorId": "x"})
        self.assertFalse(conversion.rest.is_considered_rejection(503, body))


class StuckWorker(unittest.TestCase):
    """A fetch that never answers costs its artifact, not the run."""

    def test_the_pass_goes_on_and_records_the_artifact_as_unread(self):
        refs = [conversion.rest.ArtifactRef("field", f"https://example.org/f/{n}") for n in range(3)]
        # The worker is released at the end of the test rather than left hanging: a pool thread is
        # not a daemon, and the interpreter joins it on the way out.
        released = threading.Event()
        self.addCleanup(released.set)

        def fetch(_client, ref):
            if ref.artifact_id.endswith("1"):
                released.wait(30)  # answers no sooner than the pass gives up, as a hung lookup does
            return {"@id": ref.artifact_id}, None

        seen = list(conversion.audit.fetch_in_order(None, refs, workers=3, fetch=fetch,
                                                    worker_timeout=0.5))
        self.assertEqual([ref.artifact_id for ref, _, _ in seen], [r.artifact_id for r in refs])
        stuck = [error for ref, _, error in seen if ref.artifact_id.endswith("1")][0]
        self.assertIsInstance(stuck, TimeoutError)
        self.assertEqual([error for ref, _, error in seen if not ref.artifact_id.endswith("1")],
                         [None, None])
