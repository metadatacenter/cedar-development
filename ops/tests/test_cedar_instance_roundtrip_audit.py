"""Tests for the parts of the instance round-trip audit that do not need a deployment."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("cedar_instance_roundtrip_audit",
                                               OPS / "cedar_instance_roundtrip_audit.py")
audit = importlib.util.module_from_spec(_spec)
sys.modules["cedar_instance_roundtrip_audit"] = audit
_spec.loader.exec_module(audit)


class RecordReadingTests(unittest.TestCase):
    """Resume reads the records back, so a half-written final line must not end the run."""

    def records(self, text):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        handle.write(text)
        handle.close()
        path = pathlib.Path(handle.name)
        self.addCleanup(path.unlink)
        return path

    def test_a_truncated_final_line_is_skipped(self):
        path = self.records('{"id": "a", "clean": true}\n{"id": "b", "cle')
        self.assertEqual(["a"], [r["id"] for r in audit.read_records(path)])

    def test_a_missing_file_reads_as_nothing(self):
        self.assertEqual([], list(audit.read_records(pathlib.Path("/nonexistent/records.jsonl"))))

    def test_every_complete_record_is_returned(self):
        path = self.records('{"id": "a"}\n{"id": "b"}\n{"id": "c"}\n')
        self.assertEqual(["a", "b", "c"], [r["id"] for r in audit.read_records(path)])


class TemplateCacheTests(unittest.TestCase):
    """A deployment has far fewer templates than instances, so each is read once."""

    class Client:
        def __init__(self, answers):
            self.answers = answers
            self.reads = []

        def get_json(self, path):
            self.reads.append(path)
            answer = self.answers.get(path)
            if answer is None:
                raise RuntimeError("404")
            return answer

    def test_a_template_is_read_once_however_many_instances_name_it(self):
        client = self.Client({"/templates/https%3A%2F%2Frepo.example%2Ftemplates%2Ft1": {"@id": "t1"}})
        cache = {}
        for _ in range(5):
            got = audit.template_for(client, "https://repo.example/templates/t1", cache)
            self.assertEqual({"@id": "t1"}, got)
        self.assertEqual(1, len(client.reads))

    def test_a_template_that_cannot_be_read_is_not_asked_for_again(self):
        client = self.Client({})
        cache = {}
        for _ in range(4):
            self.assertIsNone(audit.template_for(client, "https://repo.example/templates/gone", cache))
        self.assertEqual(1, len(client.reads),
                         "an unreadable template must be remembered, not retried per instance")


class ArgumentTests(unittest.TestCase):
    def parse(self, *extra):
        return audit.build_parser().parse_args(
            ["--classpath", "cp", "--records", "records.jsonl", *extra])

    def test_the_write_path_is_asked_unless_opted_out_of(self):
        self.assertFalse(self.parse().no_write_path,
                         "the write path is the question that matters and should be the default")
        self.assertTrue(self.parse("--no-write-path").no_write_path)

    def test_failures_are_verified_unless_opted_out_of(self):
        self.assertFalse(self.parse().no_verify)
        self.assertTrue(self.parse("--no-verify").no_verify)

    def test_the_walk_is_tunable(self):
        arguments = self.parse("--fetch-workers", "64", "--page-size", "250",
                               "--timeout", "90", "--limit", "10")
        self.assertEqual((64, 250, 90.0, 10),
                         (arguments.fetch_workers, arguments.page_size,
                          arguments.timeout, arguments.limit))

    def test_a_whole_corpus_run_has_no_limit(self):
        self.assertIsNone(self.parse().limit)

if __name__ == "__main__":
    unittest.main()
