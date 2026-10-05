"""Every resumable audit and repair, stopped at each point a run can stop, then resumed.

Each tool keeps its own account of what it has finished, so each can resume wrongly in its own
way. It can count a retried artifact twice, forget an incident from before the stop, refuse a
records file whose last line a kill cut short, never retry what failed, or lose the record of a
write it had already made. Every cell here stops one tool at one point, with the artifacts before
the stop in one state, and resumes it. The resumed run must end with the summary the same run
writes when nothing stops it.

The libraries the tools drive are not under test, so the bridges are stand-ins that find every
artifact valid, and a local server stands in for the resource server. What is under test is the
bookkeeping around them.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from unittest import mock

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS))
sys.path.insert(0, str(OPS / "repairs"))
import cedar_artifact_rest_audit as rest  # noqa: E402
import cedar_artifact_validation_audit as validation  # noqa: E402
import cedar_yaml_conversion_audit as conversion  # noqa: E402
import cedar_artifact_repair as repair  # noqa: E402
# Last, because it loads a copy of the REST audit of its own under the same module name.
import cedar_instance_roundtrip_audit as roundtrip  # noqa: E402

REPOSITORY = "https://repo.metadatacenter.org"
PER_KIND = 3
TYPE_IRIS = {
    "template": "https://schema.metadatacenter.org/core/Template",
    "element": "https://schema.metadatacenter.org/core/TemplateElement",
    "field": "https://schema.metadatacenter.org/core/TemplateField",
}


def identifier(kind: str, number: int) -> str:
    offset = rest.TYPE_ORDER.index(kind) * 1000
    return f"{REPOSITORY}/{rest.ARTIFACT_PATHS[kind]}/{uuid.UUID(int=offset + number + 1)}"


def artifact(kind: str, number: int) -> dict[str, Any]:
    body: dict[str, Any] = {"@id": identifier(kind, number), "schema:name": f"{kind} {number}"}
    if kind == "instance":
        body.update({"@context": {}, "schema:isBasedOn": identifier("template", 0)})
    else:
        # The empty derivation is the defect the repair removes, and the audits only count it.
        body.update({"@type": TYPE_IRIS[kind], "pav:derivedFrom": ""})
    return body


class World:
    """The deployment, and what goes wrong in it, for one cell.

    ``failing_reads`` makes the next reads of an artifact fail, ``bridge_failures`` makes the bridge
    fail once on an artifact, and ``stop_at`` interrupts the run when a bridge reaches that artifact,
    the way a Ctrl-C between two artifacts does.
    """

    def __init__(self) -> None:
        self.artifacts: dict[str, tuple[str, dict[str, Any]]] = {}
        self.revisions: dict[str, int] = {}
        for kind in rest.TYPE_ORDER:
            for number in range(PER_KIND):
                body = artifact(kind, number)
                self.artifacts[body["@id"]] = (kind, body)
                self.revisions[body["@id"]] = 1
        self.failing_reads: dict[str, int] = {}
        self.bridge_failures: set[str] = set()
        self.stop_at: Optional[str] = None
        # A cell that needs a write in flight when the run stops holds the stopping artifact's read
        # until that write has started.
        self.hold_read_until_write: Optional[tuple[str, str]] = None
        self.write_started = threading.Event()
        self.lock = threading.Lock()

    def ids(self, kinds: tuple[str, ...]) -> list[str]:
        return [key for key, (kind, _) in self.artifacts.items() if kind in kinds]

    def reached(self, artifact_id: Optional[str]) -> None:
        with self.lock:
            if artifact_id is None or artifact_id != self.stop_at:
                return
            self.stop_at = None
        raise KeyboardInterrupt

    def bridge_fails(self, artifact_id: Optional[str]) -> bool:
        with self.lock:
            if artifact_id in self.bridge_failures:
                self.bridge_failures.discard(artifact_id)
                return True
            return False

    def read_fails(self, artifact_id: str) -> bool:
        with self.lock:
            remaining = self.failing_reads.get(artifact_id, 0)
            if remaining:
                self.failing_reads[artifact_id] = remaining - 1
                return True
            return False


WORLD = World()


class Deployment(BaseHTTPRequestHandler):
    """Enough of the resource server for every tool here: the search, typed reads, verbatim writes."""

    def log_message(self, *_args):  # noqa: D102 - keep test output quiet
        pass

    def do_GET(self):  # noqa: N802 - the handler API names it
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/search-deep":
            self.search(urllib.parse.parse_qs(parsed.query))
            return
        found = self.target(parsed.path)
        if found is None:
            self.send(404, {"message": "not found"})
            return
        artifact_id, (kind, body) = found
        held = WORLD.hold_read_until_write
        if held is not None and held[0] == artifact_id:
            WORLD.write_started.wait(10)
        if WORLD.read_fails(artifact_id):
            self.send(404, {"message": "not found, for now"})
            return
        if "yaml" in (self.headers.get("Accept") or ""):
            text = f"'@id': '{artifact_id}'\nkind: {kind}\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/yaml")
            self.send_header("Content-Length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)
            return
        self.send(200, body, etag=f'"{WORLD.revisions[artifact_id]}"')

    def do_PUT(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        found = self.target(parsed.path)
        if found is None or "verbatim=true" not in parsed.query:
            self.send(404, {"message": "not found"})
            return
        artifact_id, (kind, _) = found
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        held = WORLD.hold_read_until_write
        if held is not None and held[1] == artifact_id:
            WORLD.write_started.set()
            time.sleep(0.3)
        with WORLD.lock:
            if self.headers.get("If-Match") != f'"{WORLD.revisions[artifact_id]}"':
                self.send(412, {"message": "changed"})
                return
            WORLD.artifacts[artifact_id] = (kind, body)
            WORLD.revisions[artifact_id] += 1
        self.send(200, body, etag=f'"{WORLD.revisions[artifact_id]}"')

    def target(self, path: str):
        parts = path.strip("/").split("/", 1)
        reverse = {value: key for key, value in rest.ARTIFACT_PATHS.items()}
        if len(parts) != 2 or parts[0] not in reverse:
            return None
        wanted = urllib.parse.unquote(parts[1])
        for artifact_id, entry in WORLD.artifacts.items():
            if entry[0] == reverse[parts[0]] and wanted in {artifact_id, rest.resource_path_id(artifact_id)}:
                return artifact_id, entry
        return None

    def search(self, query: dict[str, list[str]]) -> None:
        kind = query["resource_types"][0]
        limit = int(query.get("limit", ["100"])[0])
        rows = [{"@id": artifact_id, "schema:name": body["schema:name"], "resourceType": entry_kind}
                for artifact_id, (entry_kind, body) in WORLD.artifacts.items() if entry_kind == kind]
        continuation = query.get("continuation", [None])[0]
        start = 0 if continuation in (None, rest.SEARCH_CONTINUATION_START) else int(continuation)
        if continuation is None:
            start = int(query.get("offset", ["0"])[0])
        page = rows[start:start + limit]
        answer: dict[str, Any] = {"resources": page, "totalCount": len(rows)}
        if continuation is not None and start + limit < len(rows):
            answer["continuation"] = str(start + limit)
        self.send(200, answer)

    def send(self, status: int, value: Any, etag: Optional[str] = None) -> None:
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(payload)


# --------------------------------------------------------------------------------------------------
# Stand-in bridges
# --------------------------------------------------------------------------------------------------


class StandInValidationBridge:
    """The validation bridge the validation audit and the repair drive, finding everything valid."""

    def __init__(self, *_args, **_kwargs):
        self.process: Optional[object] = None
        self.hello: dict[str, Any] = {}
        self.starts = 0

    def start(self) -> dict[str, Any]:
        self.process = object()
        self.starts += 1
        self.hello = {"status": "ok", "validator": "stand-in", "java": "none"}
        return self.hello

    def cache_template(self, _template_id: str, _template: dict) -> dict[str, Any]:
        return {"status": "ok"}

    def validate(self, _kind: str, body: Any, _template_id: Optional[str] = None) -> dict[str, Any]:
        artifact_id = body.get("@id") if isinstance(body, dict) else None
        WORLD.reached(artifact_id)
        if WORLD.bridge_fails(artifact_id):
            self.process = None
            raise validation.BridgeError("the stand-in bridge failed")
        return {"status": "valid", "errors": [], "reader": {"status": "read"}}

    def close(self) -> None:
        self.process = None

    def kill(self) -> None:
        self.process = None


class StandInLineBridge:
    """Either of the YAML audit's two co-processes. The Java lane is the one that can stop or fail."""

    def __init__(self, command: list[str], *_args, **_kwargs):
        self.typescript = str(conversion.TS_BRIDGE_SOURCE) in command
        self.process: Optional[object] = None

    def start(self) -> dict[str, Any]:
        self.process = object()
        return {"status": "ok", "reader": "stand-in", "renderer": "stand-in", "java": "none",
                "validator": "stand-in", "libraryVersion": "stand-in", "node": "none"}

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["op"] != "convert":
            return {"status": "valid", "errors": [], "warnings": [], "millis": 1}
        artifact_id = re.search(r"'@id': '([^']+)'", payload["yaml"]).group(1)
        if not self.typescript:
            WORLD.reached(artifact_id)
            if WORLD.bridge_fails(artifact_id):
                self.process = None
                raise validation.BridgeError("the stand-in bridge failed")
        return {"status": "ok", "json": {"@id": artifact_id}}

    def close(self) -> None:
        self.process = None


class StandInRoundtripBridge:
    """The round-trip audit's JVM, finding every instance served, writable and surviving."""

    reader = "stand-in"

    def __init__(self, _classpath: str):
        pass

    def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        if request["op"] == "roundtrip":
            WORLD.reached(json.loads(request["json"]).get("@id"))
            return {"status": "ok", "survives": True}
        if request["op"] == "serves":
            return {"status": "ok", "reproduced": True}
        if request["op"] == "writepath":
            return {"status": "ok", "accepted": True, "storedValid": True}
        return {"status": "ok"}

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------------------------------
# The tools
# --------------------------------------------------------------------------------------------------

# What differs between two runs of the same audit over the same deployment and is not about the
# deployment: when it ran, how fast, where it wrote, and how often the stand-in processes started.
VOLATILE = {"startedAt", "finishedAt", "generatedAt", "updatedAt", "at", "elapsedSeconds",
            "elapsed", "millis", "rate", "perSecond", "eta", "paths", "files", "refsFile",
            "findingsFile", "summaryFile", "bridge", "bridges", "bridgeRestarts", "bridgeStarts", "starts",
            "processedThisRun", "templatesRead", "templatesSeen", "progress", "processing",
            "etag", "newEtag", "preimage"}


def comparable(value: Any) -> Any:
    """A summary with what may differ between two identical runs taken out, and lists put in order."""
    if isinstance(value, dict):
        return {key: comparable(item) for key, item in value.items() if key not in VOLATILE}
    if isinstance(value, list):
        items = [comparable(item) for item in value]
        return sorted(items, key=lambda item: json.dumps(item, sort_keys=True))
    return value


class Tool:
    """One resumable tool: how to run it, where it writes, and the order it visits artifacts in."""

    name = ""
    kinds: tuple[str, ...] = ()
    # Reads of an artifact that must fail for its fetch to be recorded as failed.
    failing_reads = 1
    # Whether a resume fetches again an artifact whose fetch failed, rather than leaving that to
    # a later pass of the same run.
    retries_failed_fetches = True
    bridge_can_fail = True

    def __init__(self, directory: Path, origin: str):
        self.directory = directory
        self.origin = origin

    @property
    def records(self) -> Path:
        return self.directory / "run.jsonl"

    @property
    def summary_path(self) -> Path:
        return self.directory / "run-summary.json"

    def order(self) -> list[str]:
        return WORLD.ids(self.kinds)

    def arguments(self) -> list[str]:
        raise NotImplementedError

    def patches(self) -> list[Any]:
        return []

    def run(self, resume: bool = False) -> None:
        argv = self.arguments() + (["--resume"] if resume else [])
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, {"CEDAR_API_KEY": "test-key"}))
            for patch in self.patches():
                stack.enter_context(patch)
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            try:
                self.main(argv)
            except KeyboardInterrupt:
                pass

    def main(self, argv: list[str]) -> None:
        raise NotImplementedError

    def summary(self) -> Any:
        return comparable(json.loads(self.summary_path.read_text(encoding="utf-8")))


class ValidationAudit(Tool):
    name = "validation audit"
    kinds = rest.TYPE_ORDER

    def arguments(self) -> list[str]:
        return ["--server", self.origin, "--allow-http", "--types", "all", "--page-size", "2",
                "--fetch-workers", "2", "--progress-every", "1", "--out", str(self.records)]

    def patches(self) -> list[Any]:
        return [mock.patch.object(validation, "ValidationBridge", StandInValidationBridge),
                mock.patch.object(validation, "resolve_toolchain", lambda *_: ("java", "classes"))]

    def main(self, argv: list[str]) -> None:
        validation.main(argv)


class YamlConversionAudit(Tool):
    name = "YAML conversion audit"
    kinds = ("template", "element", "field")
    # Its preflight reads the first artifact once before the pass reads it again.
    failing_reads = 2

    def arguments(self) -> list[str]:
        return ["--server", self.origin, "--allow-http", "--types", "all", "--page-size", "2",
                "--fetch-workers", "2", "--progress-every", "1", "--out", str(self.records)]

    def patches(self) -> list[Any]:
        return [mock.patch.object(conversion.audit, "LineBridge", StandInLineBridge),
                mock.patch.object(conversion, "resolve_toolchain",
                                  lambda *_: ("java", "classes", "library"))]

    def main(self, argv: list[str]) -> None:
        conversion.main(argv)


class RestAudit(Tool):
    name = "REST audit"
    kinds = rest.TYPE_ORDER
    bridge_can_fail = False

    @property
    def refs(self) -> Path:
        return self.directory / "run-refs.jsonl"

    def arguments(self) -> list[str]:
        return ["--server", self.origin, "--allow-http", "--types", "all", "--page-size", "2",
                "--workers", "2", "--progress-every", "1", "--out", str(self.records),
                "--summary", str(self.summary_path), "--refs", str(self.refs)]

    def patches(self) -> list[Any]:
        # The REST audit has no bridge, so the stop comes as it audits the stopping artifact.
        audit_common = rest.audit_common

        def audit_with_stop(ref, body):
            WORLD.reached(ref.artifact_id)
            return audit_common(ref, body)

        return [mock.patch.object(rest, "audit_common", audit_with_stop)]

    def main(self, argv: list[str]) -> None:
        rest.main(argv)


class RoundtripAudit(Tool):
    name = "instance round-trip audit"
    kinds = ("instance",)
    # The YAML and the JSON representation are each read once.
    failing_reads = 2
    # A read that failed is read again by the pass that ends every run, over the whole file.
    retries_failed_fetches = False
    bridge_can_fail = False

    def arguments(self) -> list[str]:
        key = self.directory / "key"
        key.write_text("test-key", encoding="utf-8")
        return ["--server", self.origin, "--allow-http", "--key-file", str(key),
                "--classpath", "classes", "--records", str(self.records), "--page-size", "2",
                "--fetch-workers", "2", "--progress-every", "1"]

    def patches(self) -> list[Any]:
        return [mock.patch.object(roundtrip, "Bridge", StandInRoundtripBridge)]

    def main(self, argv: list[str]) -> None:
        roundtrip.main(argv)


class Repair(Tool):
    name = "repair"
    kinds = ("template", "field")
    # A bridge failure ends a repair run instead of becoming a record, which makes it one more
    # kind of stop rather than a state an earlier artifact can be left in.
    bridge_can_fail = False

    def __init__(self, directory: Path, origin: str, workers: int = 1):
        super().__init__(directory, origin)
        self.workers = workers
        self.targets = directory / "targets.jsonl"
        self.targets.write_text("".join(
            json.dumps({"artifactType": WORLD.artifacts[artifact_id][0], "artifactId": artifact_id,
                        "conditionRules": {"derived-from-empty": 1}}) + "\n"
            for artifact_id in self.order()), encoding="utf-8")

    def arguments(self) -> list[str]:
        return ["--server", self.origin, "--allow-http", "--from-records", str(self.targets),
                "--apply", "--workers", str(self.workers), "--progress-every", "1",
                "--out", str(self.records)]

    def patches(self) -> list[Any]:
        return [mock.patch.object(validation, "ValidationBridge", StandInValidationBridge),
                mock.patch.object(validation, "resolve_toolchain", lambda *_: ("java", "classes"))]

    def main(self, argv: list[str]) -> None:
        repair.main(argv)


# --------------------------------------------------------------------------------------------------
# The matrix
# --------------------------------------------------------------------------------------------------

# Where the run stops, as the number of artifacts it finished first.
POINTS = {
    "before the first artifact": lambda count: 0,
    "after the first artifact": lambda count: 1,
    "midway": lambda count: count // 2,
    "before the last artifact": lambda count: count - 1,
}
# What happened to the first artifact, before the stop.
PRIORS = ("fetched", "fetch failed", "bridge failed")
# Whether the stop also cut the record being written in two.
TAILS = ("clean", "torn")
FRAGMENT = '{"artifactType": "template", "artifactId": "https://repo.metadatacenter.org/temp'


class ResumeMatrix(unittest.TestCase):
    tool: type[Tool]

    def setUp(self):
        global WORLD
        WORLD = World()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Deployment)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)

    def fresh(self, **options: Any) -> Tool:
        global WORLD
        WORLD = World()
        directory = Path(tempfile.mkdtemp(prefix="resume-matrix-"))
        return self.tool(directory, self.origin, **options)

    def uninterrupted(self, prior: str, **options: Any) -> Any:
        """The summary the same run writes when nothing stops it."""
        tool = self.fresh(**options)
        first = tool.order()[0]
        if prior == "bridge failed":
            WORLD.bridge_failures.add(first)
        if prior == "fetch failed" and not tool.retries_failed_fetches:
            # This tool retries a failed read in a pass of its own, so the uninterrupted run meets
            # the failure too and recovers from it the same way.
            WORLD.failing_reads[first] = tool.failing_reads
        tool.run()
        return tool.summary()

    def resumed(self, point: str, prior: str, tail: str, **options: Any) -> Any:
        tool = self.fresh(**options)
        order = tool.order()
        WORLD.stop_at = order[POINTS[point](len(order))]
        if prior == "bridge failed":
            WORLD.bridge_failures.add(order[0])
        if prior == "fetch failed":
            WORLD.failing_reads[order[0]] = tool.failing_reads
        tool.run()
        self.assertIsNone(WORLD.stop_at, "the run never reached the artifact it was to stop at")
        if tail == "torn":
            with tool.records.open("a", encoding="utf-8") as stream:
                stream.write(FRAGMENT)
        WORLD.failing_reads.clear()
        tool.run(resume=True)
        return tool.summary()

    def check(self, point: str, prior: str, tail: str) -> None:
        self.assertEqual(self.uninterrupted(prior), self.resumed(point, prior, tail))


def cells(tool: type[Tool]) -> type[ResumeMatrix]:
    """One test per point, prior state and tail that makes sense for this tool."""
    namespace: dict[str, Any] = {"tool": tool}
    for point in POINTS:
        for prior in PRIORS:
            if prior == "bridge failed" and not tool.bridge_can_fail:
                continue
            # The first artifact's state is only seen by a run that finished it before stopping.
            if prior != "fetched" and point == "before the first artifact":
                continue
            for tail in TAILS:
                name = f"test_{point}_{prior}_{tail}".replace(" ", "_")
                namespace[name] = (lambda p, q, t: lambda self: self.check(p, q, t))(point, prior, tail)
    return type(f"{tool.__name__}Resume", (ResumeMatrix,), namespace)


ValidationAuditResume = cells(ValidationAudit)
YamlConversionAuditResume = cells(YamlConversionAudit)
RestAuditResume = cells(RestAudit)
RoundtripAuditResume = cells(RoundtripAudit)
RepairResume = cells(Repair)
del ResumeMatrix  # the base holds no cells of its own


class RestAuditStopsBetweenItsTwoFiles(unittest.TestCase):
    """The REST audit writes an artifact's findings and then, in another file, that it finished it."""

    setUp = RestAuditResume.setUp
    tearDown = RestAuditResume.tearDown
    fresh = RestAuditResume.fresh
    tool = RestAudit

    def stopped_after_findings(self, torn: str) -> Any:
        global WORLD
        expected = RestAuditResume.uninterrupted(self, "fetched")
        tool = self.fresh()
        tool.run()
        # The kill came after the last artifact's findings were written and before its completion.
        lines = tool.refs.read_text(encoding="utf-8").splitlines(keepends=True)
        last = max(index for index, line in enumerate(lines) if '"artifact-complete"' in line)
        kept = lines[:last]
        if torn == "completion":
            kept.append(lines[last][:30])
        tool.refs.write_text("".join(kept), encoding="utf-8")
        tool.run(resume=True)
        return expected, tool.summary()

    def test_findings_written_and_completion_not(self):
        expected, resumed = self.stopped_after_findings("none")
        self.assertEqual(expected, resumed)

    def test_the_completion_record_cut_in_two(self):
        expected, resumed = self.stopped_after_findings("completion")
        self.assertEqual(expected, resumed)


class RepairStopsWithAWriteInFlight(unittest.TestCase):
    """Parallel workers mean another artifact can be mid-write when one of them is interrupted."""

    setUp = RepairResume.setUp
    tearDown = RepairResume.tearDown
    fresh = RepairResume.fresh
    tool = Repair

    def test_the_write_in_flight_is_recorded_before_the_run_stops(self):
        expected = RepairResume.uninterrupted(self, "fetched", workers=2)
        tool = self.fresh(workers=2)
        order = tool.order()
        stopping, writing = order[2], order[3]
        WORLD.stop_at = stopping
        WORLD.hold_read_until_write = (stopping, writing)
        tool.run()
        self.assertEqual(WORLD.revisions[writing], 2, "the other worker's write never happened")
        recorded = [json.loads(line) for line in tool.records.read_text(encoding="utf-8").splitlines()]
        self.assertIn(writing, [record["artifactId"] for record in recorded if record["outcome"] == "repaired"])
        WORLD.hold_read_until_write = None
        tool.run(resume=True)
        self.assertEqual(expected, tool.summary())

    def test_a_record_another_repair_wrote_does_not_finish_the_artifact(self):
        tool = self.fresh()
        first = tool.order()[0]
        tool.records.write_text(json.dumps({
            "artifactType": "template", "artifactId": first, "repair": "another-repair",
            "outcome": "repaired"}) + "\n", encoding="utf-8")
        tool.run(resume=True)
        self.assertEqual(WORLD.revisions[first], 2, "the artifact was skipped as already repaired")


if __name__ == "__main__":
    unittest.main()
