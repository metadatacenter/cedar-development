import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "cedar_artifact_patch.py"
SPEC = importlib.util.spec_from_file_location("cedar_artifact_patch_safety", SCRIPT)
PATCHER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = PATCHER
SPEC.loader.exec_module(PATCHER)


class Cursor(list):
    def limit(self, count):
        return Cursor(self[:count])


class ReplaceResult:
    def __init__(self, matched_count):
        self.matched_count = matched_count


class Collection:
    def __init__(self, document=None, change_after_scan=False, change_before_replace=False):
        self.current = copy.deepcopy(document)
        self.change_after_scan = change_after_scan
        self.change_before_replace = change_before_replace
        self.replacements = []

    def find(self, *_args):
        if self.current is None:
            return Cursor()
        snapshot = copy.deepcopy(self.current)
        if self.change_after_scan:
            self.current["schema:name"] = "concurrent server edit"
            self.change_after_scan = False
        return Cursor([snapshot])

    def find_one(self, _query):
        return copy.deepcopy(self.current)

    def replace_one(self, expected, replacement):
        if self.change_before_replace:
            self.current["schema:name"] = "edit in compare-and-swap gap"
            self.change_before_replace = False
        self.replacements.append((copy.deepcopy(expected), copy.deepcopy(replacement)))
        if expected != self.current:
            return ReplaceResult(0)
        self.current = copy.deepcopy(replacement)
        return ReplaceResult(1)


class Store:
    def __init__(self, collection):
        self.collections = {
            name: collection if name == "templates" else Collection()
            for name in PATCHER.COLLECTIONS
        }

    def __getitem__(self, name):
        return self.collections[name]


class Client:
    def __init__(self, store):
        self.store = store
        self.closed = False

    def __getitem__(self, _name):
        return self.store

    def close(self):
        self.closed = True


class JsonUtil:
    CANONICAL_JSON_OPTIONS = object()

    @staticmethod
    def dumps(value, **arguments):
        arguments.pop("json_options", None)
        return json.dumps(value, **arguments)


def mongo_modules(client):
    pymongo = types.ModuleType("pymongo")
    pymongo.MongoClient = lambda *_args, **_kwargs: client
    bson = types.ModuleType("bson")
    bson.json_util = JsonUtil
    return {"pymongo": pymongo, "bson": bson}


def repairable_document():
    return {
        "_id": "mongo-1",
        "@id": "https://repo.metadatacenter.orgx/templates/one",
        "pav:derivedFrom": "",
        "schema:name": "before",
        "_cedarRevision": 4,
    }


class ArtifactPatchArgumentSafetyTest(unittest.TestCase):
    def parse_error(self, arguments):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            PATCHER.parse_arguments(arguments)
        self.assertEqual(2, raised.exception.code)
        return stderr.getvalue()

    def test_apply_requires_an_explicit_nonempty_item_list(self):
        error = self.parse_error(["--mongo", "mongodb://example", "--apply"])
        self.assertIn("--apply requires an explicit --items list", error)
        error = self.parse_error([
            "--mongo", "mongodb://example", "--items", "", "--apply",
        ])
        self.assertIn("--items must name at least one repair item", error)

    def test_report_mode_still_defaults_to_every_item(self):
        _parser, _arguments, items = PATCHER.parse_arguments([
            "--mongo", "mongodb://example",
        ])
        self.assertEqual(set(PATCHER.ITEMS), items)

    def test_backup_directory_is_only_for_mongo_apply(self):
        error = self.parse_error([
            "--tree", "/tmp/artifacts", "--items", "26", "--apply",
            "--backup-dir", "/tmp/backup",
        ])
        self.assertIn("--backup-dir requires --mongo and --apply", error)


class ArtifactPatchMongoSafetyTest(unittest.TestCase):
    def run_mongo(self, collection, backup):
        store = Store(collection)
        client = Client(store)
        catalog = PATCHER.Catalog("/catalog/that/does/not/exist")
        with patch.dict(sys.modules, mongo_modules(client)):
            report = PATCHER.run_over_mongo(
                "mongodb://example", "cedar", {26}, catalog, True, None, backup
            )
        self.assertTrue(client.closed)
        return report, collection

    def test_apply_backs_up_exact_preimage_and_advances_revision(self):
        original = repairable_document()
        collection = Collection(original)
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "preimages"
            report, collection = self.run_mongo(collection, backup)
            files = list(backup.rglob("*.json"))
            self.assertEqual(1, len(files))
            payload = json.loads(files[0].read_text(encoding="utf-8"))

        self.assertEqual([], report.conflicts)
        self.assertEqual(original, payload["document"])
        self.assertEqual(PATCHER.mongo_document_hash(original, JsonUtil),
                         payload["preImageSha256"])
        self.assertEqual(original, collection.replacements[0][0])
        self.assertNotIn("pav:derivedFrom", collection.current)
        self.assertEqual(5, collection.current["_cedarRevision"])

    def test_hash_check_stops_when_document_changed_after_scan(self):
        collection = Collection(repairable_document(), change_after_scan=True)
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "preimages"
            report, collection = self.run_mongo(collection, backup)
            self.assertEqual([], list(backup.rglob("*.json")))

        self.assertEqual(1, len(report.conflicts))
        self.assertIn("changed after scan", report.conflicts[0])
        self.assertEqual([], collection.replacements)
        self.assertEqual("concurrent server edit", collection.current["schema:name"])

    def test_atomic_preimage_filter_stops_a_race_after_backup(self):
        original = repairable_document()
        collection = Collection(original, change_before_replace=True)
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "preimages"
            report, collection = self.run_mongo(collection, backup)
            self.assertEqual(1, len(list(backup.rglob("*.json"))))

        self.assertEqual(1, len(report.conflicts))
        self.assertIn("changed before replace", report.conflicts[0])
        self.assertEqual(original, collection.replacements[0][0])
        self.assertEqual("edit in compare-and-swap gap", collection.current["schema:name"])

    def test_existing_backup_directory_is_refused_before_connecting(self):
        collection = Collection(repairable_document())
        store = Store(collection)
        client = Client(store)
        catalog = PATCHER.Catalog("/catalog/that/does/not/exist")
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, mongo_modules(client)
        ):
            with self.assertRaisesRegex(RuntimeError, "backup directory already exists"):
                PATCHER.run_over_mongo(
                    "mongodb://example", "cedar", {26}, catalog, True, None, Path(directory)
                )
        self.assertFalse(client.closed)

    def test_main_exits_nonzero_when_a_concurrent_edit_stops_repairs(self):
        arguments = types.SimpleNamespace(
            tree=None,
            mongo="mongodb://example",
            db="cedar",
            apply=True,
            backup_dir=None,
            limit=None,
            samples=10,
            catalog="/catalog/that/does/not/exist",
            json=None,
        )
        report = PATCHER.Report(conflicts=["templates/one: changed before replace"])
        with (
            patch.object(PATCHER, "parse_arguments", return_value=(None, arguments, {26})),
            patch.object(PATCHER, "run_over_mongo", return_value=report),
            patch.object(PATCHER, "print_report"),
            self.assertRaises(SystemExit) as raised,
        ):
            PATCHER.main()
        self.assertEqual(2, raised.exception.code)


if __name__ == "__main__":
    unittest.main()
