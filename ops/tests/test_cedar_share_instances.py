from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "cron" / "cedar_share_instances.py"
SPEC = importlib.util.spec_from_file_location("cedar_share_instances", SCRIPT)
share = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = share
SPEC.loader.exec_module(share)

TEMPLATE = "https://repo.metadatacenter.org/templates/t-1"
GROUP = "https://repo.metadatacenter.org/groups/g-1"
OTHER_GROUP = "https://repo.metadatacenter.org/groups/g-2"
API_KEY = "test-key"


class _FakeResourceServer(BaseHTTPRequestHandler):
    """Answers search and instance-permission requests the way the resource server does."""

    def log_message(self, *args):
        pass

    def _send(self, status, body=None, etag=None):
        payload = json.dumps(body).encode("utf-8") if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if etag is not None:
            self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        state = self.server.state
        state["authorizations"].append(self.headers.get("Authorization"))
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/search-deep":
            query = urllib.parse.parse_qs(url.query)
            assert query["is_based_on"] == [TEMPLATE], query
            offset, limit = int(query["offset"][0]), int(query["limit"][0])
            ids = list(state["permissions"])
            page = [{"@id": instance_id} for instance_id in ids[offset:offset + limit]]
            return self._send(200, {"totalCount": len(ids), "resources": page})
        instance_id = self._instance_id(url.path)
        record = state["permissions"][instance_id]
        if instance_id in state["fail_reads"]:
            return self._send(500, {"message": "unavailable"})
        return self._send(200, record["body"], etag=f'"{record["revision"]}"')

    def do_PUT(self):
        state = self.server.state
        url = urllib.parse.urlsplit(self.path)
        instance_id = self._instance_id(url.path)
        record = state["permissions"][instance_id]
        if_match = self.headers.get("If-Match")
        if if_match is None:
            return self._send(428, {"message": "If-Match required"})
        if if_match != f'"{record["revision"]}"':
            return self._send(412, {"message": "changed since read"})
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if not self._is_request_shape(body):
            return self._send(400, {"message": "The request body can not be read as ResourcePermissionsRequest"})
        record["body"] = self._as_read(body)
        record["revision"] += 1
        state["writes"].append(instance_id)
        return self._send(200, record["body"], etag=f'"{record["revision"]}"')

    @staticmethod
    def _is_request_shape(body):
        """The server reads a write strictly: the owner and each grant carry an identifier and nothing else."""
        if set(body) != {"owner", "userPermissions", "groupPermissions"} or set(body["owner"]) != {"@id"}:
            return False
        users = all(set(e) == {"user", "role"} and set(e["user"]) == {"@id"} for e in body["userPermissions"])
        groups = all(set(e) == {"group", "role"} and set(e["group"]) == {"@id"} for e in body["groupPermissions"])
        return users and groups

    @staticmethod
    def _as_read(body):
        """A read names the owner and each group as well as identifying them."""
        read = json.loads(json.dumps(body))
        read["owner"]["firstName"] = "Owner"
        for entry in read["groupPermissions"]:
            entry["group"]["schema:name"] = "Group " + entry["group"]["@id"].rsplit("/", 1)[-1]
        return read

    @staticmethod
    def _instance_id(path):
        prefix, suffix = "/template-instances/", "/permissions"
        assert path.startswith(prefix) and path.endswith(suffix), path
        return urllib.parse.unquote(path[len(prefix):-len(suffix)])


def permissions(*group_entries):
    return {"owner": {"@id": "https://metadatacenter.org/users/owner", "firstName": "Owner"},
            "userPermissions": [], "groupPermissions": list(group_entries)}


class ShareInstancesTest(unittest.TestCase):

    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeResourceServer)
        self.server.state = {"permissions": {}, "writes": [], "fail_reads": set(), "authorizations": []}
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def add_instance(self, instance_id, body):
        self.server.state["permissions"][instance_id] = {"body": body, "revision": 1}

    def run_share(self, role="viewer"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            failures = share.share(self.base, API_KEY, TEMPLATE, GROUP, role)
        return failures, out.getvalue(), err.getvalue()

    def test_grants_the_role_under_the_etag_it_read_and_keeps_existing_grants(self):
        existing = {"group": {"@id": OTHER_GROUP, "schema:name": "Other"}, "role": "editor"}
        self.add_instance("https://repo.metadatacenter.org/template-instances/i-1", permissions(existing))

        failures, out, _ = self.run_share("viewer")

        self.assertEqual(0, failures)
        stored = self.server.state["permissions"]["https://repo.metadatacenter.org/template-instances/i-1"]
        granted = [(entry["group"]["@id"], entry["role"]) for entry in stored["body"]["groupPermissions"]]
        self.assertEqual([(OTHER_GROUP, "editor"), (GROUP, "viewer")], granted)
        self.assertEqual(2, stored["revision"], "the write was accepted under the ETag the read returned")
        self.assertIn("Granted viewer", out)
        self.assertTrue(all(value == "apiKey " + API_KEY for value in self.server.state["authorizations"]))

    def test_leaves_an_instance_that_already_names_the_group(self):
        self.add_instance("https://repo.metadatacenter.org/template-instances/i-1",
                          permissions({"group": {"@id": GROUP, "schema:name": "Group"}, "role": "viewer"}))

        failures, out, _ = self.run_share("editor")

        self.assertEqual((0, ""), (failures, out))
        self.assertEqual([], self.server.state["writes"], "an existing grant is not changed, whatever its role")

    def test_walks_every_page_of_the_templates_instances(self):
        count = share.PAGE_SIZE + 3
        for n in range(count):
            self.add_instance(f"https://repo.metadatacenter.org/template-instances/i-{n}", permissions())

        failures, _, _ = self.run_share()

        self.assertEqual(0, failures)
        self.assertEqual(count, len(self.server.state["writes"]))

    def test_reports_a_failed_instance_and_carries_on(self):
        self.add_instance("https://repo.metadatacenter.org/template-instances/i-1", permissions())
        self.add_instance("https://repo.metadatacenter.org/template-instances/i-2", permissions())
        self.server.state["fail_reads"].add("https://repo.metadatacenter.org/template-instances/i-1")

        failures, _, err = self.run_share()

        self.assertEqual(1, failures)
        self.assertIn("HTTP 500", err)
        self.assertEqual(["https://repo.metadatacenter.org/template-instances/i-2"], self.server.state["writes"])

    def test_refuses_a_role_the_server_does_not_have(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            share.main([TEMPLATE, GROUP, "read"])


if __name__ == "__main__":
    unittest.main()
