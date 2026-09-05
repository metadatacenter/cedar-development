import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from ops.angular_build_isolation_canary import (
    forced_persistent_angular_cache,
    normalized_output,
    stop_process_group,
    tree_metadata,
    tree_snapshot,
)


DEVELOPMENT = Path(__file__).resolve().parents[2]


class AngularBuildIsolationCanaryTest(unittest.TestCase):

    def test_forced_cache_configuration_is_active_and_restores_exact_bytes(self):
        original = b'{\n  "version": 1,\n  "cli": {"analytics": false}\n}\n'
        with tempfile.TemporaryDirectory() as directory:
            angular_json = Path(directory) / "angular.json"
            angular_json.write_bytes(original)

            with forced_persistent_angular_cache(angular_json):
                active = json.loads(angular_json.read_text(encoding="utf-8"))
                self.assertEqual(
                    {
                        "enabled": True,
                        "environment": "all",
                        "path": ".angular/cache",
                    },
                    active["cli"]["cache"],
                )

            self.assertEqual(original, angular_json.read_bytes())

    def test_cache_configuration_is_restored_when_the_body_fails(self):
        original = b'{"version":1}\n'
        with tempfile.TemporaryDirectory() as directory:
            angular_json = Path(directory) / "angular.json"
            angular_json.write_bytes(original)

            with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                with forced_persistent_angular_cache(angular_json):
                    raise RuntimeError("fixture failure")

            self.assertEqual(original, angular_json.read_bytes())

    def test_tree_snapshot_distinguishes_absence_and_content_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "cache"
            absent = tree_snapshot(root)
            root.mkdir()
            (root / "entry").write_bytes(b"one")
            first = tree_snapshot(root)
            self.assertNotEqual(absent, first)
            self.assertEqual(1, first["files"])

            (root / "entry").write_bytes(b"two")
            self.assertNotEqual(first, tree_snapshot(root))
            self.assertEqual(1, tree_metadata(root)["files"])

    def test_terminal_wrapping_does_not_hide_runtime_detection_evidence(self):
        rendered = (
            "\x1b[32mActive frontend runtime(s) PID 42 detected; the build is isolated "
            "\nfrom their checkout and Angular cache.\x1b[0m"
        )

        normalized = normalized_output(rendered)
        self.assertIn("Active frontend runtime(s)", normalized)
        self.assertIn("isolated from their checkout and Angular cache", normalized)

    def test_canary_process_group_is_stopped_and_reaped(self):
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        stop_process_group(process)

        self.assertIsNotNone(process.poll())

    def test_operational_workflows_cover_linux_and_macos(self):
        release_ci = (DEVELOPMENT / ".github/workflows/release-tooling-ci.yml").read_text()
        canary_ci = (
            DEVELOPMENT / ".github/workflows/angular-build-isolation-canary.yml"
        ).read_text()

        for workflow in (release_ci, canary_ci):
            self.assertIn("ubuntu-latest", workflow)
            self.assertIn("macos-latest", workflow)
        self.assertIn("schedule:", canary_ci)
        self.assertIn("workflow_dispatch:", canary_ci)
        self.assertIn("ops/angular_build_isolation_canary.py", canary_ci)

    def test_canary_uses_the_public_cli_and_always_uploads_evidence(self):
        workflow = (
            DEVELOPMENT / ".github/workflows/angular-build-isolation-canary.yml"
        ).read_text()
        script = (DEVELOPMENT / "ops/angular_build_isolation_canary.py").read_text()

        self.assertIn('["bash", str(cli), "build", "this"]', script)
        self.assertIn("Active frontend runtime(s)", script)
        self.assertIn("liveCacheUnchanged", script)
        self.assertIn("cedar-monitoring-dist changed", script)
        self.assertIn("if: always()", workflow)
