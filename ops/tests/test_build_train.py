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
