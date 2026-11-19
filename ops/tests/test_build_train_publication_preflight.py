"""The build train's publication preflight only reads, and sends credentials only to Nexus.

publication_target_preflight probes every surface a train publishes to before anything is built.
It must never upload or log in, and it follows a Docker registry's token challenge, so it must
refuse to send the credentials to a token endpoint outside Nexus. A stand-in opener answers here.
"""
import contextlib
import email.message
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
SPEC = importlib.util.spec_from_file_location(
    "build_train_publication_preflight", Path(__file__).resolve().parents[1] / "build_train.py")
build_train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = build_train
SPEC.loader.exec_module(build_train)

HOST = build_train.NEXUS_HOST
CREDENTIALS = {"BMIR_NEXUS_USERNAME": "builder", "BMIR_NEXUS_PASSWORD": "secret"}


class Answer(io.BytesIO):
    def __init__(self, body=b"", status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = email.message.Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value


class Nexus:
    """Answers each probe as Nexus does, and keeps every request it was sent."""

    def __init__(self, realm=f"{HOST}/v2/token", refuse=None):
        self.realm = realm
        self.refuse = refuse or {}
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        url = request.full_url
        if url in self.refuse:
            raise urllib.error.HTTPError(url, self.refuse[url], "refused", email.message.Message(), io.BytesIO())
        if url.endswith("/-/whoami"):
            return Answer(json.dumps({"username": "builder"}).encode())
        if url == build_train.NEXUS_DOCKER_V2:
            if request.get_header("Authorization", "").startswith("Bearer "):
                return Answer(b"{}")
            raise urllib.error.HTTPError(url, 401, "unauthorized", self.challenge(), io.BytesIO())
        if url.startswith(self.realm):
            return Answer(json.dumps({"token": "bearer-token"}).encode())
        return Answer(b"ok")

    def challenge(self):
        headers = email.message.Message()
        headers["WWW-Authenticate"] = f'Bearer realm="{self.realm}",service="nexus",scope="registry:catalog:*"'
        return headers


class PublicationPreflightTest(unittest.TestCase):
    def preflight(self, nexus, environment=CREDENTIALS):
        with contextlib.redirect_stdout(io.StringIO()):
            build_train.publication_target_preflight(environment, opener=nexus)

    def test_every_surface_is_read_and_nothing_is_written(self):
        nexus = Nexus()
        self.preflight(nexus)
        urls = [request.full_url for request in nexus.requests]
        self.assertEqual([f"{HOST}/service/rest/v1/status/check", f"{HOST}/service/rest/v1/status/writable",
                          build_train.NEXUS_MAVEN_TRAIN_REPOSITORY, f"{build_train.NEXUS_NPM_REPOSITORY}-/whoami",
                          build_train.NEXUS_DOCKER_V2, f"{HOST}/v2/token?service=nexus&scope=registry%3Acatalog%3A%2A",
                          build_train.NEXUS_DOCKER_V2], urls)
        self.assertEqual({"GET"}, {request.get_method() for request in nexus.requests})
        self.assertTrue(all(request.data is None for request in nexus.requests))
        self.assertTrue(all(url.startswith(HOST + "/") for url in urls))
        self.assertEqual("Bearer bearer-token", nexus.requests[-1].get_header("Authorization"))

    def test_credentials_never_go_to_a_token_endpoint_outside_nexus(self):
        nexus = Nexus(realm="https://elsewhere.example/token")
        with self.assertRaisesRegex(RuntimeError, "invalid token endpoint"):
            self.preflight(nexus)
        self.assertFalse(any("elsewhere" in request.full_url for request in nexus.requests))

    def test_missing_credentials_stop_before_any_request(self):
        nexus = Nexus()
        with self.assertRaisesRegex(RuntimeError, "BMIR_NEXUS_USERNAME and BMIR_NEXUS_PASSWORD"):
            self.preflight(nexus, {"BMIR_NEXUS_USERNAME": "builder"})
        self.assertEqual([], nexus.requests)

    def test_a_refusal_is_named_for_the_operator(self):
        for code, detail in ((401, "credentials were rejected"), (403, "not allowed to read"),
                             (503, "unavailable or unhealthy")):
            with self.subTest(code=code):
                nexus = Nexus(refuse={f"{HOST}/service/rest/v1/status/writable": code})
                with self.assertRaisesRegex(RuntimeError, f"Nexus writable status failed: .*{detail}"):
                    self.preflight(nexus)


if __name__ == "__main__":
    unittest.main()
