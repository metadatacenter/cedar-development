"""Cover for how the large store turns snapshot artifacts into graph nodes and folders.

The load itself needs containers and the admin tool. What is tested here is what decides the shape
of the store: which bodies the importer would refuse, how identifiers are localized, how a version
series gets its latest flags, and what a node records.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "e2e" / "rest-perf" / "large-store" / "large_store.py"
SPEC = importlib.util.spec_from_file_location("large_store", SCRIPT)
large_store = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = large_store
SPEC.loader.exec_module(large_store)

LOCAL = "https://repo.metadatacenter.orgx/"
NOW = datetime(2026, 11, 22, tzinfo=timezone.utc)


class BodyTest(unittest.TestCase):
    def test_a_duplicated_key_is_refused_as_the_importer_refuses_it(self):
        with self.assertRaises(large_store.DuplicateKey):
            large_store.parse_body(b'{"a": 1, "a": 2}')

    def test_a_body_that_is_not_an_object_is_refused(self):
        with self.assertRaises(ValueError):
            large_store.parse_body(b"[1]")

    def test_both_production_bases_are_localized(self):
        text = '{"@id": "https://repo.metadatacenter.net/templates/1", "x": "https://repo.metadatacenter.org/fields/2"}'
        self.assertEqual(large_store.localize(text, LOCAL),
                         '{"@id": "https://repo.metadatacenter.orgx/templates/1", '
                         '"x": "https://repo.metadatacenter.orgx/fields/2"}')

    def test_an_unreadable_timestamp_falls_back(self):
        self.assertEqual(large_store.timestamp("yesterday", NOW), (NOW.isoformat(timespec="seconds"),
                                                                    int(NOW.timestamp())))
        iso, seconds = large_store.timestamp("2020-01-02T03:04:05-07:00", NOW)
        self.assertEqual(iso, "2020-01-02T03:04:05-07:00")
        self.assertEqual(seconds, 1577959445)


class SeriesTest(unittest.TestCase):
    def test_a_series_has_one_latest_version_and_the_last_published_one(self):
        roots, flags = large_store.series_flags({
            "a": {"previous": "", "status": "bibo:published", "created": "1"},
            "b": {"previous": "a", "status": "bibo:published", "created": "2"},
            "c": {"previous": "b", "status": "bibo:draft", "created": "3"},
        })
        self.assertEqual(roots, {"a": "a", "b": "a", "c": "a"})
        self.assertEqual(flags["a"], {"isLatestVersion": False, "isLatestDraftVersion": False,
                                      "isLatestPublishedVersion": False})
        self.assertEqual(flags["b"], {"isLatestVersion": False, "isLatestDraftVersion": False,
                                      "isLatestPublishedVersion": True})
        self.assertEqual(flags["c"], {"isLatestVersion": True, "isLatestDraftVersion": True,
                                      "isLatestPublishedVersion": False})

    def test_a_branched_series_continues_through_its_latest_successor(self):
        _, flags = large_store.series_flags({
            "a": {"previous": "", "status": "bibo:published", "created": "1"},
            "b": {"previous": "a", "status": "bibo:draft", "created": "2"},
            "c": {"previous": "a", "status": "bibo:draft", "created": "3"},
        })
        self.assertTrue(flags["c"]["isLatestVersion"])
        self.assertTrue(flags["b"]["isLatestVersion"], "a branch the line did not take stands alone")

    def test_a_previous_version_outside_the_snapshot_starts_a_series(self):
        roots, flags = large_store.series_flags({"a": {"previous": "elsewhere", "status": "bibo:draft"}})
        self.assertEqual(roots, {"a": "a"})
        self.assertTrue(flags["a"]["isLatestDraftVersion"])

    def test_a_cycle_does_not_loop(self):
        roots, flags = large_store.series_flags({
            "a": {"previous": "b", "status": "bibo:draft"},
            "b": {"previous": "a", "status": "bibo:draft"},
        })
        self.assertEqual(set(roots), {"a", "b"})
        self.assertTrue(all(flag["isLatestVersion"] for flag in flags.values()))


class NodeTest(unittest.TestCase):
    def test_a_template_node_carries_its_version_facts(self):
        node = large_store.artifact_node("template", f"{LOCAL}templates/1", {
            "schema:name": "T", "pav:version": "2.0.0", "bibo:status": "bibo:published",
            "pav:previousVersion": f"{LOCAL}templates/0", "pav:createdOn": "2020-01-01T00:00:00Z",
        }, "owner", {"isLatestVersion": True, "isLatestDraftVersion": False, "isLatestPublishedVersion": True}, NOW)
        self.assertEqual(node["pav:version"], "2.0.0")
        self.assertEqual(node["pav:previousVersion"], {"id": f"{LOCAL}templates/0"})
        self.assertEqual(node["ownedBy"], "owner")
        self.assertEqual(node["createdOnTS"], 1577836800)
        self.assertNotIn("schema:isBasedOn", node)

    def test_an_instance_node_names_its_template_and_no_version(self):
        node = large_store.artifact_node("instance", f"{LOCAL}template-instances/1",
                                         {"schema:isBasedOn": f"{LOCAL}templates/1"}, "owner", None, NOW)
        self.assertEqual(node["schema:isBasedOn"], {"id": f"{LOCAL}templates/1"})
        self.assertEqual(node["schema:name"], "")
        self.assertNotIn("pav:version", node)

    def test_a_schema_artifact_without_version_facts_gets_defaults(self):
        node = large_store.artifact_node("field", f"{LOCAL}template-fields/1", {}, "owner", None, NOW)
        self.assertEqual((node["pav:version"], node["bibo:status"]), ("0.0.1", "bibo:draft"))
        self.assertTrue(node["isLatestVersion"])


class FolderNameTest(unittest.TestCase):
    def test_sibling_folders_differing_only_in_case_get_distinct_names(self):
        builder = large_store.TreeBuilder(Path("/nonexistent"), LOCAL, [], NOW)
        self.assertEqual(builder.sibling_name("p", "Instances of T"), "Instances of T")
        self.assertEqual(builder.sibling_name("p", "instances of t"), "instances of t [2]")
        self.assertEqual(builder.sibling_name("p", "Instances of T"), "Instances of T [3]")
        self.assertEqual(builder.sibling_name("q", "Instances of T"), "Instances of T", "another parent is free")


if __name__ == "__main__":
    unittest.main()
