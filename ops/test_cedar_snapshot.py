#!/usr/bin/env python3
"""Tests for cedar_snapshot.py, against a deployment stood in for in memory.

A download is run end to end through the real enumeration, read pool, staging database, packing and
verification, with a fake client in place of the HTTP one. The ``zstd`` command must be installed.

    python3 -m unittest ops/test_cedar_snapshot.py
"""

import argparse
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import threading
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("cedar_snapshot.py")
SPEC = importlib.util.spec_from_file_location("cedar_snapshot", MODULE_PATH)
SNAPSHOT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = SNAPSHOT
SPEC.loader.exec_module(SNAPSHOT)
REST = SNAPSHOT.rest

BASE = "https://repo.metadatacenter.org"
TEMPLATES = [f"{BASE}/templates/{n:08d}-0000-4000-8000-000000000000" for n in range(3)]
# A legacy identity host, which the server must be asked for by the whole identifier.
LEGACY_INSTANCE = "https://repo.metadatacenter.net/template-instances/00000009-0000-4000-8000-000000000000"
INSTANCES = [f"{BASE}/template-instances/{n:08d}-0000-4000-8000-000000000000" for n in range(5)]
ORPHAN = f"{BASE}/template-fields/0000000f-0000-4000-8000-000000000000"


def instance_body(identifier: str, template: str) -> bytes:
    # A duplicated key and a number spelled with a trailing zero, which a parsed copy would lose.
    return (f'{{"@id": "{identifier}", "schema:isBasedOn": "{template}", '
            f'"n": {{"@value": 1.10}}, "n": 2}}').encode()


class FakeClient:
    """Serves /search-deep by continuation and each artifact's body, failing one read once."""

    def __init__(self):
        self.listing = {
            "template": TEMPLATES,
            "element": [],
            "field": [ORPHAN],
            "instance": INSTANCES + [LEGACY_INSTANCE],
        }
        templates_of = {identifier: TEMPLATES[(position * 2) % 3]
                        for position, identifier in enumerate(INSTANCES + [LEGACY_INSTANCE])}
        self.bodies = {REST.typed_artifact_path(REST.ArtifactRef("template", t)):
                       json.dumps({"@id": t, "schema:name": "T"}).encode() for t in TEMPLATES}
        for identifier, template in templates_of.items():
            self.bodies[REST.typed_artifact_path(REST.ArtifactRef("instance", identifier))] = \
                instance_body(identifier, template)
        self.flaky = REST.typed_artifact_path(REST.ArtifactRef("instance", INSTANCES[1]))
        self.failed_once = False
        self.lock = threading.Lock()
        self.paths: list[str] = []

    def get_json(self, path, query=None):
        assert path == "/search-deep"
        rows = self.listing[query["resource_types"]]
        start = 0 if query.get("continuation") in (None, "start") else int(query["continuation"])
        end = start + query["limit"]
        return {"resources": [{"@id": identifier} for identifier in rows[start:end]], "totalCount": len(rows),
                "continuation": str(end) if end < len(rows) else None}

    def get_bytes(self, path, accept="application/json", query=None):
        with self.lock:
            self.paths.append(path)
            if path == self.flaky and not self.failed_once:
                self.failed_once = True
                raise REST.ResponseError(f"GET {path} failed: TimeoutError")
        if path not in self.bodies:
            raise REST.ResponseError(f"GET {path} returned 404", 404)
        return self.bodies[path], {"etag": "\"e\"", "content-type": "application/json"}


class SnapshotDownloadTest(unittest.TestCase):

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.client = FakeClient()
        self.original_make_client = SNAPSHOT.make_client
        SNAPSHOT.make_client = lambda arguments, parser: self.client

    def tearDown(self):
        SNAPSHOT.make_client = self.original_make_client
        shutil.rmtree(self.root)

    def download(self) -> pathlib.Path:
        code = SNAPSHOT.main(["--root", str(self.root), "download", "--page-size", "2", "--workers", "3",
                              "--level", "3"])
        self.assertEqual(code, 0)
        return self.root / "production" / f"{SNAPSHOT.LATEST}{SNAPSHOT.ARCHIVE_SUFFIX}"

    def test_a_download_keeps_every_body_as_served(self):
        # The link itself, which the zstd command would skip if it were handed it unresolved.
        snapshot = SNAPSHOT.Snapshot(self.download())
        served = {entry["id"]: body for entry, body in snapshot.artifacts()}
        for identifier in INSTANCES + [LEGACY_INSTANCE]:
            path = REST.typed_artifact_path(REST.ArtifactRef("instance", identifier))
            self.assertEqual(served[identifier], self.client.bodies[path])
        self.assertEqual(set(served), set(TEMPLATES + INSTANCES + [LEGACY_INSTANCE]))

    def test_the_index_records_an_artifact_the_store_does_not_hold(self):
        manifest, index = SNAPSHOT.Snapshot(self.download().resolve()).header()
        (orphan,) = [entry for entry in index if entry["id"] == ORPHAN]
        self.assertEqual(orphan["status"], 404)
        self.assertNotIn("member", orphan)
        self.assertEqual(manifest["counts"]["byType"]["field"], {"enumerated": 1, "status404": 1})
        self.assertEqual(manifest["counts"]["byType"]["instance"]["served"], 6)

    def test_a_read_that_got_no_answer_is_asked_again(self):
        self.download()
        self.assertEqual(self.client.paths.count(self.client.flaky), 2)

    def test_a_legacy_identifier_is_asked_for_whole(self):
        self.download()
        legacy = [path for path in self.client.paths if "metadatacenter.net" in path]
        self.assertEqual(legacy, ["/template-instances/https%3A%2F%2Frepo.metadatacenter.net%2Ftemplate-instances"
                                  "%2F00000009-0000-4000-8000-000000000000"])

    def test_instances_are_grouped_by_template(self):
        _manifest, index = SNAPSHOT.Snapshot(self.download().resolve()).header()
        templates = [entry["template"] for entry in index if entry["type"] == "instance"]
        self.assertEqual(templates, sorted(templates))
        self.assertEqual([entry["type"] for entry in index][:3], ["template"] * 3)

    def test_the_archive_verifies_and_the_staging_database_is_removed(self):
        latest = self.download()
        report = SNAPSHOT.verify(latest.resolve())
        self.assertTrue(report["ok"], report["problems"])
        self.assertEqual(report["bodies"], 9)
        self.assertEqual(list((self.root / "production").glob("staging-*")), [])
        sidecar = json.loads((self.root / "production" / f"{SNAPSHOT.LATEST}.json").read_text())
        self.assertEqual(sidecar["archive"]["sha256"], SNAPSHOT.file_sha256(latest.resolve()))

    def test_verification_notices_a_changed_body(self):
        latest = self.download().resolve()
        _manifest, index = SNAPSHOT.Snapshot(latest).header()
        tampered = self.root / "tampered.tar.zst"
        members = list(SNAPSHOT.Snapshot(latest)._members())
        import io
        import subprocess
        import tarfile
        compressor = subprocess.Popen(["zstd", "-q", "-o", str(tampered)], stdin=subprocess.PIPE)
        with tarfile.open(fileobj=compressor.stdin, mode="w|") as tar:
            for member, data in members:
                if member.name.startswith("instance/"):
                    data = data.replace(b"1.10", b"1.1")
                    member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        compressor.stdin.close()
        compressor.wait()
        report = SNAPSHOT.verify(tampered)
        self.assertFalse(report["ok"])
        self.assertEqual(len(report["problems"]), 6)


class MemberNameTest(unittest.TestCase):

    def test_a_canonical_identifier_keeps_its_path(self):
        self.assertEqual(SNAPSHOT.member_name("instance", INSTANCES[0]),
                         "instance/repo.metadatacenter.org/template-instances/"
                         "00000000-0000-4000-8000-000000000000.json")

    def test_an_identifier_that_could_leave_its_directory_is_encoded_whole(self):
        name = SNAPSHOT.member_name("field", "https://example.org/a/../../etc")
        self.assertEqual(name.count("/"), 1)
        self.assertTrue(name.startswith("field/https%3A%2F%2F"))


class ReadRawTest(unittest.TestCase):

    def ref(self):
        return REST.ArtifactRef("template", TEMPLATES[0])

    def test_a_definite_refusal_is_final(self):
        class Refusing:
            def get_bytes(self, path):
                raise REST.ResponseError("GET returned 403", 403)
        answer, error = SNAPSHOT.read_raw(Refusing(), self.ref())
        self.assertEqual(answer[0], 403)
        self.assertTrue(SNAPSHOT.is_final(answer[0]))

    def test_a_server_error_is_asked_again(self):
        class Failing:
            def get_bytes(self, path):
                raise REST.ResponseError("GET returned 503", 503)
        answer, error = SNAPSHOT.read_raw(Failing(), self.ref())
        self.assertIsNone(answer)
        self.assertIsInstance(error, REST.ResponseError)


if __name__ == "__main__":
    unittest.main()
