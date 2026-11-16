"""rename_sheet.py drafts the renames a template's instances imply, for an owner to decide.

The sheet is a planning tool: nothing it proposes is written until an owner answers. These tests hold
it to that, and to being importable and pointable at a deployment like the other tools.
"""
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import rename_sheet as sheet
from test_cedar_artifact_repair import child, template

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = "https://repo.metadatacenter.org/templates/t"
INSTANCE = "https://repo.metadatacenter.org/template-instances/"


class ImportTest(unittest.TestCase):
    def test_the_module_imports_without_a_key_file(self):
        # It once read ~/.cedar-admin-key, and drafted the whole sheet, as it was imported.
        with tempfile.TemporaryDirectory() as home:
            environment = {key: value for key, value in os.environ.items() if not key.startswith("CEDAR_")}
            environment.update(HOME=home, CEDAR_HOME=home)
            result = subprocess.run([sys.executable, "-c", "import rename_sheet; print(rename_sheet.KEY)"],
                                    cwd=HERE, env=environment, capture_output=True, text=True, timeout=60)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("None", result.stdout.strip())


class SheetTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name)
        self.key = self.home / "key"
        self.key.write_text("test-key\n")
        self.decisions = self.home / "decisions.md"
        self.template = dict(template({"Title": child()}), **{"@id": TEMPLATE, "schema:name": "Study"})
        self.bodies = {TEMPLATE: self.template}
        for number in range(3):
            identifier = f"{INSTANCE}{number}"
            self.bodies[identifier] = {"@id": identifier, "schema:isBasedOn": TEMPLATE,
                                       "Old Title": {"@value": f"title {number}"}}
        (self.home / "top10-residual.json").write_text(json.dumps({TEMPLATE: sorted(
            identifier for identifier in self.bodies if identifier != TEMPLATE)}))
        (self.home / "production-validation.jsonl").write_text("")
        self.requested = []
        for patch in (mock.patch.object(sheet, "HOME", self.home),
                      mock.patch.object(sheet, "REGISTRY", self.home / "decision-registry.json"),
                      mock.patch.object(sheet, "DECISIONS", self.decisions)):
            patch.start()
            self.addCleanup(patch.stop)
        for table in (sheet.VALID, sheet.ANSWERED, sheet.SETTLED):
            self.addCleanup(table.clear)
        self.addCleanup(sheet.repair.RENAMES.clear)

    def urlopen(self, request, timeout):
        self.requested.append((request.full_url, request.get_header("Authorization")))
        identifier = sheet.urllib.parse.unquote(request.full_url.rsplit("/", 1)[-1])
        body = next(value for key, value in self.bodies.items() if sheet.rest.resource_path_id(key) == identifier)
        return contextlib.nullcontext(io.BytesIO(json.dumps(body).encode()))

    def draft(self, *options):
        with mock.patch.object(sheet.urllib.request, "urlopen", side_effect=self.urlopen), \
                contextlib.redirect_stdout(io.StringIO()):
            sheet.main(["--api-key-file", str(self.key), "--server", "http://127.0.0.1:9/", *options])
        return self.decisions.read_text()

    def test_every_request_goes_to_the_named_server_with_the_key_file(self):
        self.draft()
        self.assertTrue(self.requested)
        for url, authorization in self.requested:
            self.assertTrue(url.startswith("http://127.0.0.1:9/template"), url)
            self.assertEqual("apiKey test-key", authorization)

    def test_a_proposal_is_asked_and_never_settled(self):
        decisions = self.draft()
        self.assertIn("**1 questions across 1 templates.**", decisions)
        self.assertIn("`Old Title`", decisions)
        # The closest wording is marked, but only an owner's answer settles a rename.
        self.assertIn("**A** Title", decisions)
        self.assertEqual({}, json.loads((self.home / "settled-mapping.json").read_text()))

    def test_an_answered_key_is_not_asked_again_and_keeps_its_number(self):
        self.draft()
        registry = json.loads((self.home / "decision-registry.json").read_text())
        self.assertEqual({f"{TEMPLATE}\tOld Title": 1}, registry)
        (self.home / "answers-mapping.json").write_text(json.dumps({TEMPLATE: {"Old Title": "Title"}}))
        decisions = self.draft()
        self.assertIn("**0 questions across 0 templates.**", decisions)
        self.assertEqual(registry, json.loads((self.home / "decision-registry.json").read_text()))


if __name__ == "__main__":
    unittest.main()
