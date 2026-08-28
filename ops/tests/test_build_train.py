import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "build_train.py"
SPEC = importlib.util.spec_from_file_location("build_train", MODULE_PATH)
build_train = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_train)


POM = """<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.metadatacenter</groupId>
    <artifactId>cedar-parent</artifactId>
    <version>2.9.3-SNAPSHOT</version>
  </parent>
  <groupId>org.metadatacenter</groupId>
  <artifactId>example</artifactId>
  <version>2.9.3-SNAPSHOT</version>
  <properties><cedar.version>2.9.3-SNAPSHOT</cedar.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.metadatacenter</groupId><artifactId>internal</artifactId>
      <version>2.9.3-SNAPSHOT</version>
    </dependency>
    <dependency>
      <groupId>example.org</groupId><artifactId>external</artifactId>
      <version>2.9.3-SNAPSHOT</version>
    </dependency>
  </dependencies>
</project>
"""


class BuildTrainTest(unittest.TestCase):
    def test_train_id_is_strict(self):
        self.assertEqual(
            "2.9.3-dev.20260824.1847",
            build_train.validate_train("2.9.3-dev.20260824.1847"),
        )
        for invalid in ("2.9.3-SNAPSHOT", "2.9.3-dev", "2.9.3-dev.20260824.184700"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                build_train.validate_train(invalid)

    def test_train_order_compares_numeric_release_components(self):
        self.assertGreater(
            build_train.train_key("2.10.0-dev.20260824.1847"),
            build_train.train_key("2.9.9-dev.20260825.1847"),
        )
        self.assertEqual(
            "2026-08-24T18:47:00Z",
            build_train.train_output_timestamp("2.9.3-dev.20260824.1847"),
        )

    def test_stamp_changes_only_cedar_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            pom = Path(directory) / "pom.xml"
            pom.write_text(POM, encoding="utf-8")
            self.assertTrue(build_train.stamp_pom(
                pom,
                "2.9.3-SNAPSHOT",
                "2.9.3-dev.20260824.1847",
            ))
            text = pom.read_text(encoding="utf-8")
            self.assertEqual(4, text.count("2.9.3-dev.20260824.1847"))
            self.assertEqual(1, text.count("2.9.3-SNAPSHOT"))

    def test_post_stamp_guard_rejects_any_remaining_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            repository = workspace / "example"
            repository.mkdir()
            pom = repository / "pom.xml"
            pom.write_text(POM, encoding="utf-8")
            config = {"mavenRepositories": ["example"]}

            build_train.stamp_workspace(
                config, workspace, "2.9.3-SNAPSHOT", "2.9.3-dev.20260824.1847"
            )
            with self.assertRaisesRegex(RuntimeError, "still contains -SNAPSHOT.*example/pom.xml"):
                build_train.assert_no_snapshot_poms(config, workspace)

            pom.write_text(
                pom.read_text(encoding="utf-8").replace(
                    "2.9.3-SNAPSHOT", "2.9.3-dev.20260824.1847"
                ),
                encoding="utf-8",
            )
            build_train.assert_no_snapshot_poms(config, workspace)

    def test_local_repository_guard_rejects_cedar_snapshot_path(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            snapshot = repository / "org" / "metadatacenter" / "example" / "2.9.3-SNAPSHOT"
            snapshot.mkdir(parents=True)
            (snapshot / "example-2.9.3-SNAPSHOT.jar").write_bytes(b"mutable")

            with self.assertRaisesRegex(RuntimeError, "org.metadatacenter snapshot paths"):
                build_train.assert_no_local_maven_snapshots(repository)

            snapshot.rename(snapshot.with_name("2.9.3-dev.20260824.1847"))
            build_train.assert_no_local_maven_snapshots(repository)

    def test_build_checks_local_repository_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            (workspace / "reactor").mkdir(parents=True)
            config = root / "config.json"
            config.write_text(json.dumps({
                "phases": [{"name": "reactor", "repository": "reactor"}],
                "mavenRepository": "https://nexus.example/releases/",
            }), encoding="utf-8")

            def fake_run(_arguments, cwd=None, capture=False):
                snapshot = workspace / ".m2" / "repository" / "org" / "metadatacenter" \
                    / "example" / "2.9.3-SNAPSHOT"
                snapshot.mkdir(parents=True)
                return ""

            arguments = type("Arguments", (), {
                "config": config,
                "version": "2.9.3-dev.20260824.1847",
                "workspace": workspace,
                "settings": root / "settings.xml",
            })()
            with patch.object(build_train, "run", side_effect=fake_run), \
                    patch.object(build_train, "publish_local_repository") as publish:
                with self.assertRaisesRegex(RuntimeError, "snapshot paths"):
                    build_train.build(arguments)
                publish.assert_not_called()

    def test_train_settings_do_not_enable_a_snapshot_repository(self):
        settings = (MODULE_PATH.parent / "maven-train-settings.xml").read_text(encoding="utf-8")
        self.assertNotIn("bmir-nexus-snapshots", settings)
        self.assertNotIn("<snapshots><enabled>true</enabled></snapshots>", settings)

    def test_write_json_is_complete_and_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state" / "current.json"
            build_train.write_json(path, {"version": "v", "a": 1})
            self.assertEqual({"a": 1, "version": "v"}, json.loads(path.read_text()))
            self.assertTrue(path.read_text().endswith("\n"))

    def test_upload_skips_identical_bytes_and_rejects_a_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact.jar"
            artifact.write_bytes(b"same")
            with patch.object(build_train, "remote_bytes", return_value=b"same"):
                self.assertEqual(
                    "unchanged",
                    build_train.upload_file(artifact, "https://nexus/example.jar", "u", "p"),
                )
            with patch.object(build_train, "remote_bytes", return_value=b"different"):
                with self.assertRaisesRegex(RuntimeError, "different bytes"):
                    build_train.upload_file(artifact, "https://nexus/example.jar", "u", "p")


if __name__ == "__main__":
    unittest.main()
