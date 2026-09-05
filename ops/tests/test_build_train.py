import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "build_train.py"
SPEC = importlib.util.spec_from_file_location("build_train", MODULE_PATH)
build_train = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_train)


class FakeCIPolicy:
    GREEN_CONCLUSIONS = {"success", "skipped", "neutral"}
    GithubCIProbeError = RuntimeError

    def __init__(self, runs):
        self.runs = runs

    def probe_exact_commit(self, _repository, _revision, reporter=None):
        return SimpleNamespace(runs=tuple(self.runs))

    @staticmethod
    def latest_runs_by_name(runs):
        return {record.get("name", "CI"): record for record in runs}

    @staticmethod
    def run_url(_record):
        return ""


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
    @staticmethod
    def _preflight_fixture(root: Path):
        workspace = root / "workspace"
        repositories = ["model", "cee", "frontend", "demo", "cedar-docker-build"]
        for repository in repositories:
            (workspace / repository).mkdir(parents=True)
        wrapper = workspace / "model" / "mvnw"
        wrapper.write_text("#!/bin/sh\n", encoding="utf-8")
        wrapper.chmod(0o755)
        for relative in ("package.json", "package-dist.json", "package-lock.json"):
            (workspace / "model" / relative).write_text("{}\n", encoding="utf-8")
        for relative in ("package.json", "package-lock.json", "visual/package.json",
                         "visual/package-lock.json"):
            path = workspace / "cee" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}\n", encoding="utf-8")
        for repository in ("frontend", "demo"):
            for relative in ("package.json", "package-lock.json"):
                (workspace / repository / relative).write_text("{}\n", encoding="utf-8")
        manifest = workspace / "cedar-docker-build" / "bin" / "cedar-images-base.sh"
        manifest.parent.mkdir()
        manifest.write_text(
            "export IMAGE_VERSION=2.9.3-SNAPSHOT\n"
            "export CEDAR_MAVEN_VERSION=2.9.3-SNAPSHOT\n"
            "export CEDAR_APPLICATION_VERSION=2.9.3-SNAPSHOT\n"
            "export CEDAR_FRONTEND_NPM_VERSION=1\n"
            "export CEDAR_CEE_NPM_VERSION=1\n",
            encoding="utf-8",
        )
        groups = {
            "javaBase": ["java"],
            "microserviceBase": ["microservice"],
            "infrastructure": [f"infra-{index}" for index in range(7)],
            "microservices": [f"server-{index}" for index in range(21)],
            "frontends": ["frontend-image"],
        }
        for image in (item for values in groups.values() for item in values):
            (workspace / "cedar-docker-build" / image).mkdir()
        build = {
            "organization": "metadatacenter", "sourceBranch": "develop",
            "repositories": repositories, "mavenRepositories": ["model"],
            "phases": [{"name": "model", "repository": "model"}],
            "requiredArtifacts": ["model"],
        }
        frontend = {
            "model": {"repository": "model", "sourceManifest": "package.json",
                      "publishedManifest": "package-dist.json"},
            "cee": {"repository": "cee", "sourceManifest": "package.json",
                    "sourceLock": "package-lock.json", "additionalModelConsumers": [{
                        "manifest": "visual/package.json", "lock": "visual/package-lock.json",
                    }]},
            "frontends": [{
                "id": "frontend", "image": "frontend-image", "repository": "frontend",
                "packagePath": ".", "npmVersionVariable": "CEDAR_FRONTEND_NPM_VERSION",
                "ceeConsumer": {"manifest": "package.json", "lock": "package-lock.json"},
            }],
            "additionalCeeConsumers": [{
                "repository": "demo", "manifest": "package.json", "lock": "package-lock.json",
            }],
            "dockerCeeVersionVariable": "CEDAR_CEE_NPM_VERSION",
            "auditBaselines": [{
                "repository": "model",
                "lock": "package-lock.json",
                "sha256": hashlib.sha256(b"{}\n").hexdigest(),
                "vulnerabilities": {
                    "low": 0, "moderate": 0, "high": 0, "critical": 0,
                },
            }],
        }
        return workspace, build, frontend, {"groups": groups}

    def test_train_id_is_strict(self):
        self.assertEqual(
            "2.9.3-dev.20260824.1847",
            build_train.validate_train("2.9.3-dev.20260824.1847"),
        )
        for invalid in ("2.9.3-SNAPSHOT", "2.9.3-dev", "2.9.3-dev.20260824.184700"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                build_train.validate_train(invalid)

    def test_negative_command_return_code_names_the_signal(self):
        result = SimpleNamespace(returncode=-6, stdout="", stderr="")
        with patch.object(build_train.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, r"terminated by SIGABRT \(signal 6\)"):
                build_train.run(["npm", "run", "build"])

    def test_local_preflight_rejects_a_different_expected_development_version(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            parent = workspace / "cedar-parent"
            parent.mkdir()
            (parent / "pom.xml").write_text(
                '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                '<version>2.9.4-SNAPSHOT</version></project>\n',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                workspace=workspace,
                expected_source_version="2.9.5-SNAPSHOT",
                config=workspace / "build.json",
                frontend_config=workspace / "frontend.json",
                docker_config=workspace / "docker.json",
            )
            with self.assertRaisesRegex(RuntimeError, "cedar-parent version.*expected"):
                build_train.local_configuration_preflight(args)

    def test_complete_configuration_contract_passes_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = self._preflight_fixture(Path(directory))
            summary = build_train.validate_configuration(
                build, frontend, docker, workspace, "2.9.3-SNAPSHOT")

        self.assertEqual(31, summary["images"])
        self.assertEqual(1, summary["frontends"])
        self.assertEqual(1, summary["auditBaselines"])

    def test_changed_npm_lock_is_an_early_preflight_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = self._preflight_fixture(Path(directory))
            (workspace / "model" / "package-lock.json").write_text(
                '{"changed": true}\n', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "npm dependency graph changed.*model"):
                build_train.validate_configuration(build, frontend, docker, workspace)

    def test_unreviewed_npm_install_script_is_an_early_preflight_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = self._preflight_fixture(Path(directory))
            lock = workspace / "model" / "package-lock.json"
            lock.write_text(json.dumps({
                "packages": {"node_modules/native-addon": {
                    "version": "1.2.3", "hasInstallScript": True,
                }},
            }) + "\n", encoding="utf-8")
            baseline = frontend["auditBaselines"][0]
            baseline["sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest()
            baseline["strictInstallScripts"] = True
            (workspace / "model" / "package.json").write_text(
                '{"allowScripts": {}}\n', encoding="utf-8")
            policy = SimpleNamespace(
                unreviewed_install_scripts=lambda *_args: ["native-addon@1.2.3"])
            with patch.object(build_train, "_captured_npm_policy", return_value=policy):
                with self.assertRaisesRegex(
                    RuntimeError, "unreviewed npm install scripts.*native-addon"):
                    build_train.validate_configuration(build, frontend, docker, workspace)

    def test_missing_maven_wrapper_is_a_preflight_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = self._preflight_fixture(Path(directory))
            (workspace / "model" / "mvnw").unlink()
            with self.assertRaisesRegex(RuntimeError, "Maven wrapper"):
                build_train.validate_configuration(build, frontend, docker, workspace)

    def test_docker_suite_versions_must_match_the_captured_source(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = self._preflight_fixture(Path(directory))
            manifest = workspace / "cedar-docker-build" / "bin" / "cedar-images-base.sh"
            manifest.write_text(
                manifest.read_text(encoding="utf-8").replace(
                    "CEDAR_MAVEN_VERSION=2.9.3-SNAPSHOT",
                    "CEDAR_MAVEN_VERSION=2.9.2-SNAPSHOT",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "CEDAR_MAVEN_VERSION"):
                build_train.validate_configuration(
                    build, frontend, docker, workspace, "2.9.3-SNAPSHOT")

    def test_exact_source_ci_must_have_a_completed_green_run(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            workflows = workspace / "repository" / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text("name: CI\n", encoding="utf-8")
            source = {"repositories": {"repository": "a" * 40}}
            policy = FakeCIPolicy([{
                "name": "CI", "status": "completed", "conclusion": "cancelled",
                "path": ".github/workflows/ci.yml",
            }])
            with patch.dict(os.environ, {"GH_TOKEN": "token"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "concluded cancelled"):
                    build_train._github_ci_preflight(source, workspace, policy=policy)

    def test_train_workflow_cannot_substitute_for_source_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            workflows = workspace / "cedar-development" / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "build-train.yml").write_text("name: train\n", encoding="utf-8")
            source = {"repositories": {"cedar-development": "a" * 40}}
            policy = FakeCIPolicy([{
                "name": "Build train", "status": "in_progress", "conclusion": None,
                "path": ".github/workflows/build-train.yml",
            }])
            with patch.dict(os.environ, {"GH_TOKEN": "token"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "cedar-development: no CI run"):
                    build_train._github_ci_preflight(source, workspace, policy=policy)

    def test_cedar_development_source_validation_passes_while_train_is_running(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            workflows = workspace / "cedar-development" / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "build-train.yml").write_text("name: train\n", encoding="utf-8")
            (workflows / "release-tooling-ci.yml").write_text("name: CI\n", encoding="utf-8")
            source = {"repositories": {"cedar-development": "a" * 40}}
            policy = FakeCIPolicy([
                {
                    "name": "Immutable development build train", "status": "in_progress",
                    "conclusion": None, "path": ".github/workflows/build-train.yml",
                },
                {
                    "name": "Release tooling CI", "status": "completed",
                    "conclusion": "success", "path": ".github/workflows/release-tooling-ci.yml",
                },
            ])
            with patch.dict(os.environ, {"GH_TOKEN": "token"}, clear=False):
                build_train._github_ci_preflight(source, workspace, policy=policy)

    def test_non_train_workflow_without_a_run_blocks_after_indexing_grace(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            workflows = workspace / "repository" / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text("name: CI\n", encoding="utf-8")
            source = {"repositories": {"repository": "a" * 40}}
            with patch.dict(os.environ, {"GH_TOKEN": "token"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "no CI run.*bounded indexing"):
                    build_train._github_ci_preflight(
                        source, workspace, policy=FakeCIPolicy([]))

    def test_exact_source_without_a_workflow_is_advisory(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "repository").mkdir()
            source = {"repositories": {"repository": "a" * 40}}
            policy = FakeCIPolicy([])
            with patch.dict(os.environ, {"GH_TOKEN": "token"}, clear=False):
                build_train._github_ci_preflight(source, workspace, policy=policy)

    def test_publication_preflight_probes_the_release_policy_repository_root(self):
        version = "2.9.3-dev.20260824.1847"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            (state / "trains").mkdir(parents=True)
            (state / "trains" / f"{version}.json").write_text(json.dumps({
                "sourceVersion": "2.9.3-SNAPSHOT", "repositories": {},
            }), encoding="utf-8")
            paths = []
            for name in ("build", "frontend", "docker"):
                path = root / f"{name}.json"
                path.write_text("{}\n", encoding="utf-8")
                paths.append(path)
            arguments = type("Arguments", (), {
                "version": version,
                "state": state,
                "workspace": root / "workspace",
                "config": paths[0],
                "frontend_config": paths[1],
                "docker_config": paths[2],
            })()
            with patch.dict(os.environ, {
                "BMIR_NEXUS_USERNAME": "user", "BMIR_NEXUS_PASSWORD": "secret",
            }, clear=False), \
                    patch.object(build_train, "validate_configuration", return_value={
                        "repositories": 1, "mavenRepositories": 1,
                        "frontends": 1, "images": 31, "auditBaselines": 1,
                    }), \
                    patch.object(build_train, "_github_ci_preflight"), \
                    patch.object(build_train, "publication_target_preflight") as targets:
                build_train.publication_preflight(arguments)

        targets.assert_called_once_with()

    def test_read_only_target_preflight_uses_real_repository_shapes(self):
        requests = []

        def authenticated(url, _username, _password, label, opener=None):
            self.assertIsNone(opener)
            requests.append((label, url))
            if label == "npm registry authentication":
                return json.dumps({"username": "cedar"}).encode()
            return b""

        with patch.object(build_train, "_authenticated_request", side_effect=authenticated), \
                patch.object(build_train, "_docker_registry_preflight") as docker:
            build_train.publication_target_preflight({
                "BMIR_NEXUS_USERNAME": "user",
                "BMIR_NEXUS_PASSWORD": "secret",
            })

        self.assertIn(
            ("Maven train repository root", build_train.NEXUS_MAVEN_TRAIN_REPOSITORY),
            requests,
        )
        self.assertIn(
            ("npm registry authentication", build_train.NEXUS_NPM_REPOSITORY + "-/whoami"),
            requests,
        )
        self.assertFalse(any("maven-metadata.xml" in url for _label, url in requests))
        docker.assert_called_once_with("user", "secret", opener=None)

    def test_preflight_404_names_an_absent_probe_contract(self):
        def opener(request, timeout):
            self.assertEqual(60, timeout)
            raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)

        with self.assertRaisesRegex(
                RuntimeError, "expected endpoint is absent.*HTTP 404"):
            build_train._authenticated_request(
                build_train.NEXUS_MAVEN_TRAIN_REPOSITORY,
                "user",
                "secret",
                "Maven train repository root",
                opener=opener,
            )

    def test_docker_probe_sends_credentials_without_writing_client_config(self):
        requests = []

        class Response(io.BytesIO):
            status = 200
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        def opener(request, timeout):
            self.assertEqual(60, timeout)
            requests.append(request)
            return Response(b"{}")

        build_train._docker_registry_preflight("user", "secret", opener=opener)

        self.assertEqual(1, len(requests))
        self.assertTrue(requests[0].get_header("Authorization").startswith("Basic "))

    def test_publication_canary_runs_only_the_read_only_probe(self):
        workflow = (
            Path(__file__).resolve().parents[2]
            / ".github" / "workflows" / "publication-preflight-canary.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("schedule:", workflow)
        self.assertIn("python3 ops/build_train.py probe-publication", workflow)
        self.assertNotIn("docker login", workflow)
        self.assertNotIn("docker logout", workflow)
        self.assertNotIn("npm publish", workflow)

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
        """The guard reads the .sha1 sidecar, so the seam under test is the sidecar fetch."""
        destination = "https://nexus/example.jar"
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact.jar"
            artifact.write_bytes(b"same")
            same = hashlib.sha1(b"same").hexdigest()

            def sidecar(body):
                def fetch(url):
                    self.assertEqual(destination + ".sha1", url)
                    return body
                return fetch

            with patch.object(build_train, "remote_bytes", sidecar(same.encode())):
                self.assertEqual(
                    "unchanged",
                    build_train.upload_file(artifact, destination, "u", "p"),
                )
            with patch.object(build_train, "remote_bytes", sidecar(b"0" * 40)):
                with self.assertRaisesRegex(RuntimeError, "different bytes"):
                    build_train.upload_file(artifact, destination, "u", "p")

    def test_upload_reads_no_sidecar_when_the_train_id_is_known_unused(self):
        """A fresh train verifies its ID before dispatch, so nothing there needs asking about."""
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact.jar"
            artifact.write_bytes(b"same")

            def refuse(url):
                self.fail("a fresh train must not spend a request on " + url)

            with patch.object(build_train, "remote_bytes", refuse), \
                    patch.object(build_train, "with_retries") as put:
                self.assertEqual(
                    "uploaded",
                    build_train.upload_file(
                        artifact, "https://nexus/example.jar", "u", "p",
                        check_existing=False),
                )
            self.assertEqual(1, put.call_count)

    def test_upload_treats_a_missing_sidecar_as_a_free_path(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact.jar"
            artifact.write_bytes(b"same")
            with patch.object(build_train, "remote_bytes", lambda url: None), \
                    patch.object(build_train, "with_retries") as put:
                self.assertEqual(
                    "uploaded",
                    build_train.upload_file(artifact, "https://nexus/example.jar", "u", "p"),
                )
            self.assertEqual(1, put.call_count)

    def test_transient_nexus_failure_is_retried_but_content_verdict_is_not_changed(self):
        attempts = []

        def operation():
            attempts.append(len(attempts) + 1)
            if len(attempts) == 1:
                raise urllib.error.HTTPError(
                    "https://nexus/example.jar", 503, "unavailable", {}, None)
            return b"verified"

        with patch.object(build_train.time, "sleep") as sleep:
            self.assertEqual(b"verified", build_train.with_retries("read artifact", operation))
        self.assertEqual([1, 2], attempts)
        sleep.assert_called_once_with(2)

    def test_truncated_nexus_read_is_retried_before_byte_comparison(self):
        class Response(io.BytesIO):
            def __init__(self, body, declared):
                super().__init__(body)
                self.headers = {"Content-Length": str(declared)}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        responses = [Response(b"abc", 5), Response(b"abcde", 5)]
        with patch.object(build_train.urllib.request, "urlopen", side_effect=responses), \
                patch.object(build_train.time, "sleep") as sleep:
            self.assertEqual(b"abcde", build_train.remote_bytes("https://nexus/example.jar"))
        sleep.assert_called_once_with(2)


if __name__ == "__main__":
    unittest.main()


class LockBaselineReportTest(unittest.TestCase):
    def test_every_stale_npm_lock_is_named_together(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace, build, frontend, docker = BuildTrainTest._preflight_fixture(Path(directory))
            frontend["auditBaselines"].append({
                "repository": "cee",
                "lock": "package-lock.json",
                "sha256": hashlib.sha256(b"{}\n").hexdigest(),
                "vulnerabilities": {"low": 0, "moderate": 0, "high": 0, "critical": 0},
            })
            (workspace / "model" / "package-lock.json").write_text(
                '{"changed": true}\n', encoding="utf-8")
            (workspace / "cee" / "package-lock.json").write_text(
                '{"changed": "too"}\n', encoding="utf-8")
            with self.assertRaises(RuntimeError) as refused:
                build_train.validate_configuration(build, frontend, docker, workspace)

        message = str(refused.exception)
        self.assertIn("2 npm lock baselines fail review", message)
        self.assertIn("npm dependency graph changed for model:package-lock.json", message)
        self.assertIn("npm dependency graph changed for cee:package-lock.json", message)
        self.assertIn("update the digest and severity counts", message)

    def test_a_single_stale_lock_keeps_its_one_line_advice(self):
        message = build_train._lock_baseline_failure([
            "npm dependency graph changed for model:package-lock.json; expected audit "
            "baseline aa, found bb",
        ])
        self.assertTrue(message.startswith("npm dependency graph changed for model"))
        self.assertIn("Review npm audit and update the digest", message)
        self.assertNotIn("\n", message)
