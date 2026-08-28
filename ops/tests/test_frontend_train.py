import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frontend_train


VERSION = "2.9.3-dev.20260824.1847"
MODEL_NAME = "@org.metadatacenter/cedar-model-typescript-library"
MODEL_VERSION = "1.0.3-dev.example"
CEE_NAME = "@org.metadatacenter/cedar-embeddable-editor"
CEE_VERSION = "2.0.2-dev.example"


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def dependency_files(root: Path, name: str, published: str, version: str) -> None:
    alias = f"npm:{published}@{version}"
    write(root / "package.json", {"dependencies": {name: alias}})
    write(root / "package-lock.json", {
        "packages": {
            "": {"dependencies": {name: alias}},
            f"node_modules/{name}": {"version": version, "integrity": "sha512-example"},
        },
    })


def commit(repository: Path, timestamp: str = "2026-08-25T22:04:26Z") -> str:
    subprocess.run(["git", "init", "--quiet"], cwd=repository, check=True)
    subprocess.run(["git", "add", "."], cwd=repository, check=True)
    environment = os.environ.copy()
    environment.update({
        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.org",
        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.org",
        "GIT_AUTHOR_DATE": timestamp, "GIT_COMMITTER_DATE": timestamp,
    })
    subprocess.run(["git", "commit", "--quiet", "-m", "fixture"],
                   cwd=repository, env=environment, check=True)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository,
                          text=True, capture_output=True, check=True).stdout.strip()


class FrontendTrainTest(unittest.TestCase):
    def test_train_owned_versions_include_train_and_captured_commit(self):
        revision = "a" * 40
        self.assertEqual(
            "1.0.3-dev.202608241847.gaaaaaaaaaaaa",
            frontend_train.train_package_version("1.0.3-dev.old", VERSION, revision),
        )
        self.assertEqual(
            "2.9.3-dev.202608241847.gaaaaaaaaaaaa.p4",
            frontend_train.wired_frontend_version("2.9.3-SNAPSHOT", VERSION, revision),
        )

    def test_train_owned_versions_are_semver_safe_during_a_leading_zero_hour(self):
        self.assertEqual(
            "1.0.5-dev.202608280209.gaaaaaaaaaaaa",
            frontend_train.train_package_version(
                "1.0.5-dev.old", "2.9.3-dev.20260828.0209", "a" * 40,
            ),
        )

    def test_record_plan_enforces_model_to_cee_to_frontend_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            state = root / "state"
            config_path = root / "config.json"

            model = workspace / "model"
            write(model / "package.json", {"version": MODEL_VERSION})
            write(model / "package-dist.json", {"name": MODEL_NAME, "version": MODEL_VERSION})
            model_sha = commit(model)

            cee = workspace / "cee"
            dependency_files(cee, "cedar-model-typescript-library", MODEL_NAME, MODEL_VERSION)
            cee_manifest = json.loads((cee / "package.json").read_text())
            cee_manifest["version"] = CEE_VERSION
            write(cee / "package.json", cee_manifest)
            cee_sha = commit(cee)

            app = workspace / "app"
            dependency_files(app, "cedar-embeddable-editor", CEE_NAME, CEE_VERSION)
            app_manifest = json.loads((app / "package.json").read_text())
            app_manifest.update({"name": "cedar-app", "version": "2.9.3-SNAPSHOT"})
            write(app / "package.json", app_manifest)
            app_sha = commit(app)

            config = {
                "registry": "https://registry.example/npm/",
                "model": {"repository": "model", "sourceManifest": "package.json",
                          "publishedManifest": "package-dist.json"},
                "cee": {"repository": "cee", "sourceManifest": "package.json",
                        "sourceLock": "package-lock.json", "publishedName": CEE_NAME,
                        "modelDependency": "cedar-model-typescript-library"},
                "frontends": [{"id": "main", "image": "cedar-frontend-main",
                               "repository": "app", "packagePath": ".",
                               "npmVersionVariable": "CEDAR_APP_NPM_VERSION",
                               "ceeConsumer": {"manifest": "package.json",
                                               "lock": "package-lock.json"}}],
                "runtimePackages": [{
                    "name": "@webcomponents/webcomponentsjs",
                    "versionVariable": "CEDAR_WEB_COMPONENTS_NPM_VERSION",
                    "registry": "https://registry.npmjs.org/",
                }],
                "dockerCeeVersionVariable": "CEDAR_OPENVIEW_CEE_NPM_VERSION",
            }
            write(config_path, config)
            write(state / "trains" / f"{VERSION}.json", {
                "version": VERSION,
                "repositories": {"model": model_sha, "cee": cee_sha, "app": app_sha},
                "frontendPackages": {"CEDAR_WEB_COMPONENTS_NPM_VERSION": "2.8.0"},
            })

            with patch.object(frontend_train, "registry_record") as registry:
                frontend_train.record_plan(argparse.Namespace(
                    config=config_path, version=VERSION, workspace=workspace, state=state,
                ))
            registry.assert_not_called()
            plan = frontend_train.load_json(state / "npm" / "trains" / f"{VERSION}.json")
            expected_model = frontend_train.train_package_version(
                MODEL_VERSION, VERSION, model_sha,
            )
            expected_cee = frontend_train.train_package_version(
                CEE_VERSION, VERSION, cee_sha,
            )
            self.assertEqual(expected_model, plan["cee"]["model"]["version"])
            self.assertEqual(expected_cee, plan["frontends"][0]["ceeVersion"])
            self.assertEqual(
                f"2.9.3-dev.202608241847.g{app_sha[:12]}.p4",
                plan["dockerInputs"]["CEDAR_APP_NPM_VERSION"],
            )
            self.assertEqual(
                expected_cee, plan["dockerInputs"]["CEDAR_OPENVIEW_CEE_NPM_VERSION"]
            )
            self.assertEqual(model_sha, plan["model"]["revision"])
            self.assertEqual(cee_sha, plan["cee"]["revision"])
            self.assertEqual("train-owned", plan["model"]["publication"])
            self.assertEqual("train-owned", plan["cee"]["publication"])
            self.assertEqual([{
                "name": "@webcomponents/webcomponentsjs",
                "version": "2.8.0",
                "registry": "https://registry.npmjs.org/",
            }], plan["runtimePackages"])

    def test_exact_alias_rejects_a_range(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "package.json", {"dependencies": {"cee": "^2.0.0"}})
            write(root / "package-lock.json", {"packages": {}})
            with self.assertRaisesRegex(RuntimeError, "must pin"):
                frontend_train.require_exact_alias(
                    root / "package.json", root / "package-lock.json",
                    "cee", CEE_NAME, CEE_VERSION,
                )

    def test_registry_verification_hashes_the_downloaded_tarball(self):
        tarball = b"immutable npm tarball"
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
        expected = {
            "name": "cedar-app", "version": "1.2.3", "repository": "app",
            "revision": "a" * 40,
        }
        with patch.object(frontend_train, "registry_record", return_value={
            "gitHead": "a" * 40,
            "dist": {"tarball": "https://registry.example/app.tgz", "integrity": integrity},
        }), patch.object(frontend_train, "fetch", return_value=tarball):
            verified = frontend_train.verify_record("https://registry.example/", expected)
        self.assertEqual(hashlib.sha256(tarball).hexdigest(), verified["tarballSha256"])

    def test_registry_verification_accepts_a_pinned_third_party_without_git_head(self):
        tarball = b"pinned third-party tarball"
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
        expected = {"name": "third-party", "version": "1.2.3"}
        with patch.object(frontend_train, "registry_record", return_value={
            "dist": {"tarball": "https://registry.example/third-party.tgz", "integrity": integrity},
        }), patch.object(frontend_train, "fetch", return_value=tarball):
            verified = frontend_train.verify_record("https://registry.example/", expected)
        self.assertEqual("1.2.3", verified["version"])
        self.assertNotIn("revision", verified)

    def test_frontend_verification_requires_and_hashes_the_vendored_shrinkwrap(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "frontend.tgz"
            shrinkwrap = b'{"lockfileVersion":3}\n'
            content = Path(directory) / "npm-shrinkwrap.json"
            content.write_bytes(shrinkwrap)
            with tarfile.open(archive_path, "w:gz") as archive:
                archive.add(content, arcname="package/npm-shrinkwrap.json")
            tarball = archive_path.read_bytes()
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
        expected = {
            "name": "frontend", "version": "1.2.3", "revision": "a" * 40,
            "requiresShrinkwrap": True,
        }
        with patch.object(frontend_train, "registry_record", return_value={
            "gitHead": "a" * 40,
            "dist": {"tarball": "https://registry.example/frontend.tgz", "integrity": integrity},
        }), patch.object(frontend_train, "fetch", return_value=tarball):
            verified = frontend_train.verify_record("https://registry.example/", expected)
        self.assertEqual(hashlib.sha256(shrinkwrap).hexdigest(), verified["shrinkwrapSha256"])

        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "frontend-without-lock.tgz"
            content = Path(directory) / "package.json"
            content.write_text('{}\n', encoding="utf-8")
            with tarfile.open(archive_path, "w:gz") as archive:
                archive.add(content, arcname="package/package.json")
            unlocked_tarball = archive_path.read_bytes()
        unlocked_integrity = "sha512-" + base64.b64encode(
            hashlib.sha512(unlocked_tarball).digest()
        ).decode()
        with patch.object(frontend_train, "registry_record", return_value={
            "gitHead": "a" * 40,
            "dist": {"tarball": "https://registry.example/frontend.tgz",
                     "integrity": unlocked_integrity},
        }), patch.object(frontend_train, "fetch", return_value=unlocked_tarball):
            with self.assertRaisesRegex(RuntimeError, "no readable npm-shrinkwrap"):
                frontend_train.verify_record("https://registry.example/", expected)

    def test_staged_shrinkwrap_preserves_graph_and_updates_package_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "package-lock.json"
            destination = root / "npm-shrinkwrap.json"
            write(source, {
                "name": "app",
                "version": "2.9.3-SNAPSHOT",
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "app", "version": "2.9.3-SNAPSHOT",
                         "dependencies": {"dependency": "^1.0.0"}},
                    "node_modules/dependency": {
                        "version": "1.2.3", "integrity": "sha512-pinned",
                    },
                },
            })
            subprocess.run([
                "node", str(Path(frontend_train.__file__).parent / "stage-npm-shrinkwrap.mjs"),
                str(source), str(destination), "app", VERSION,
            ], check=True)
            shrinkwrap = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(VERSION, shrinkwrap["version"])
            self.assertEqual(VERSION, shrinkwrap["packages"][""]["version"])
            self.assertEqual(
                "sha512-pinned",
                shrinkwrap["packages"]["node_modules/dependency"]["integrity"],
            )

    def test_npm_pack_includes_the_staged_shrinkwrap(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"npm_config_cache": str(Path(directory) / "npm-cache")}, clear=False,
        ):
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            write(package / "package.json", {"name": "app", "version": VERSION})
            write(root / "package-lock.json", {
                "name": "app", "version": "2.9.3-SNAPSHOT", "lockfileVersion": 3,
                "packages": {"": {"name": "app", "version": "2.9.3-SNAPSHOT"}},
            })
            subprocess.run([
                "node", str(Path(frontend_train.__file__).parent / "stage-npm-shrinkwrap.mjs"),
                str(root / "package-lock.json"), str(package / "npm-shrinkwrap.json"),
                "app", VERSION,
            ], check=True)
            subprocess.run([
                "npm", "pack", str(package), "--pack-destination", str(root),
                "--ignore-scripts", "--loglevel=error",
            ], check=True, stdout=subprocess.DEVNULL)
            archive = next(root.glob("*.tgz"))
            with tarfile.open(archive, "r:gz") as stream:
                self.assertIn("package/npm-shrinkwrap.json", stream.getnames())

    def test_publish_source_archive_excludes_ignored_worktree_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "package.json", {"name": "app", "version": "1.0.0"})
            write(root / "package-lock.json", {
                "name": "app", "version": "1.0.0", "lockfileVersion": 3,
                "packages": {"": {"name": "app", "version": "1.0.0"}},
            })
            (root / ".gitignore").write_text("dist/\n", encoding="utf-8")
            committed = root / "src" / "committed.js"
            committed.parent.mkdir()
            committed.write_text("committed\n", encoding="utf-8")
            commit(root)
            ignored = root / "dist" / "polluted.js"
            ignored.parent.mkdir()
            ignored.write_text("ignored local artifact\n", encoding="utf-8")

            archive = root / "head.tar"
            with archive.open("wb") as output:
                subprocess.run(
                    ["git", "-C", str(root), "archive", "--format=tar", "HEAD"],
                    check=True, stdout=output,
                )
            with tarfile.open(archive) as stream:
                names = stream.getnames()
            self.assertIn("src/committed.js", names)
            self.assertNotIn("dist/polluted.js", names)

            publisher = (
                Path(frontend_train.__file__).parent / "publish-frontend-package.sh"
            ).read_text(encoding="utf-8")
            self.assertIn('git -C "${repo_dir}" archive --format=tar HEAD', publisher)
            self.assertIn('npm pack "${archived_package_dir}"', publisher)
            self.assertNotIn('npm pack "${package_dir}"', publisher)
            self.assertIn('CEDAR_TRAIN_PACKAGE_VERSION', publisher)
            self.assertIn('CEDAR_TRAIN_OVERLAY_PATHS', publisher)

    def test_package_stamp_updates_source_lock_and_published_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "package.json", {"name": "model", "version": "1.0.3-dev.old"})
            write(root / "package-lock.json", {
                "name": "model", "version": "1.0.3-dev.old",
                "packages": {"": {"name": "model", "version": "1.0.3-dev.old"}},
            })
            write(root / "package-dist.json", {
                "name": MODEL_NAME, "version": "1.0.3-dev.old",
            })
            version = "1.0.3-dev.20260824.1847.gaaaaaaaaaaaa"
            frontend_train.stamp_package_version(root, version, "package-dist.json")
            self.assertEqual(version, frontend_train.load_json(root / "package.json")["version"])
            lock = frontend_train.load_json(root / "package-lock.json")
            self.assertEqual(version, lock["version"])
            self.assertEqual(version, lock["packages"][""]["version"])
            self.assertEqual(
                version, frontend_train.load_json(root / "package-dist.json")["version"],
            )

    def test_model_publication_runs_its_gate_from_the_captured_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            state = root / "state"
            model = workspace / "model"
            model.mkdir(parents=True)
            write(model / "package.json", {"name": "model", "version": "1.0.3-dev.old"})
            write(model / "package-lock.json", {
                "name": "model", "version": "1.0.3-dev.old",
                "packages": {"": {"name": "model", "version": "1.0.3-dev.old"}},
            })
            write(model / "package-dist.json", {
                "name": MODEL_NAME, "version": "1.0.3-dev.old",
            })
            revision = commit(model)
            version = frontend_train.train_package_version("1.0.3-dev.old", VERSION, revision)
            write(state / "trains" / f"{VERSION}.json", {
                "version": VERSION, "repositories": {"model": revision},
            })
            write(state / "npm" / "trains" / f"{VERSION}.json", {
                "version": VERSION, "registry": "https://registry.example/",
                "model": {"name": MODEL_NAME, "version": version,
                          "repository": "model", "revision": revision},
            })
            commands = []

            def run(command, cwd, environment=None):
                commands.append(command)
                if command == ["npm", "run", "test:package"]:
                    write(cwd / "dist" / "package.json", {
                        "name": MODEL_NAME, "version": version,
                    })

            with (
                patch.object(frontend_train, "existing_verified_package", return_value=False),
                patch.object(frontend_train, "run_command", side_effect=run),
                patch.object(frontend_train, "verify_record", return_value={
                    "name": MODEL_NAME, "version": version,
                    "repository": "model", "revision": revision,
                    "tarballSha256": "a" * 64,
                }),
            ):
                frontend_train.publish_model(argparse.Namespace(
                    version=VERSION, workspace=workspace, state=state,
                ))
            self.assertIn(["npm", "run", "test:coverage"], commands)
            self.assertIn(["npm", "run", "parity:yaml"], commands)
            self.assertIn(["npm", "run", "parity:json"], commands)
            self.assertTrue(any(command[:3] == ["npm", "publish", "./dist"] for command in commands))
            completion = frontend_train.load_json(
                state / "npm" / "model" / "completed" / f"{VERSION}.json"
            )
            self.assertEqual(revision, completion["expected"]["revision"])

    def test_cee_publication_wires_train_model_and_runs_full_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            state = root / "state"
            cee = workspace / "cee"
            dependency_files(cee, "cedar-model-typescript-library", MODEL_NAME, "1.0.3-dev.old")
            package = frontend_train.load_json(cee / "package.json")
            package["version"] = "2.0.2-dev.old"
            write(cee / "package.json", package)
            visual = cee / "visual"
            dependency_files(
                visual, "cedar-model-typescript-library", MODEL_NAME, "1.0.3-dev.old",
            )
            revision = commit(cee)
            cee_version = frontend_train.train_package_version(
                "2.0.2-dev.old", VERSION, revision,
            )
            model = {
                "name": MODEL_NAME, "version": "1.0.3-dev.20260824.1847.gmodelmodel12",
                "repository": "model", "revision": "a" * 40,
            }
            expected = {
                "name": CEE_NAME, "version": cee_version,
                "repository": "cee", "revision": revision,
                "modelConsumers": [
                    {"manifest": "package.json", "lock": "package-lock.json"},
                    {"manifest": "visual/package.json", "lock": "visual/package-lock.json"},
                ],
            }
            write(state / "trains" / f"{VERSION}.json", {
                "version": VERSION, "repositories": {"cee": revision},
            })
            write(state / "npm" / "trains" / f"{VERSION}.json", {
                "version": VERSION, "sourceManifestSha256": "f" * 64,
                "registry": "https://registry.example/", "model": model, "cee": expected,
            })
            config_path = root / "config.json"
            write(config_path, {"cee": {
                "modelDependency": "cedar-model-typescript-library",
            }})
            commands = []

            def wire(directory, dependency, published, version, legacy_peer_deps=False):
                dependency_files(directory, dependency, published, version)

            def run(command, cwd, environment=None):
                commands.append(command)
                if command == ["npm", "run", "test:ci"]:
                    write(cwd / "dist-npm" / "cedar-embeddable-editor" / "package.json", {
                        "name": CEE_NAME, "version": cee_version,
                    })

            def verified(_registry, package):
                return {
                    "name": package["name"], "version": package["version"],
                    "repository": package["repository"], "revision": package["revision"],
                    "tarballSha256": "b" * 64,
                }

            with (
                patch.object(frontend_train, "existing_verified_package", return_value=False),
                patch.object(frontend_train, "install_exact_alias", side_effect=wire),
                patch.object(frontend_train, "run_command", side_effect=run),
                patch.object(frontend_train, "verify_record", side_effect=verified),
            ):
                frontend_train.publish_cee(argparse.Namespace(
                    config=config_path, version=VERSION, workspace=workspace, state=state,
                ))
            self.assertIn(["npm", "run", "test:ci"], commands)
            self.assertIn(["npm", "run", "audit:prod"], commands)
            self.assertTrue(any(command[:2] == ["npm", "publish"] for command in commands))
            for manifest in (cee / "package.json", visual / "package.json"):
                self.assertIn(model["version"], manifest.read_text(encoding="utf-8"))
            completion = frontend_train.load_json(
                state / "npm" / "cee" / "completed" / f"{VERSION}.json"
            )
            self.assertEqual(revision, completion["expected"]["revision"])

    def test_frontend_preparation_records_exact_cee_wiring_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            state = root / "state"
            app = workspace / "app"
            dependency_files(app, "cedar-embeddable-editor", CEE_NAME, "2.0.2-dev.old")
            app_sha = commit(app)
            write(state / "trains" / f"{VERSION}.json", {
                "version": VERSION, "repositories": {"app": app_sha},
            })
            plan_path = state / "npm" / "trains" / f"{VERSION}.json"
            consumer = {
                "label": "main", "repository": "app", "revision": app_sha,
                "manifest": "package.json", "lock": "package-lock.json",
                "legacyPeerDeps": False, "publishedFrontend": "main",
            }
            write(plan_path, {
                "version": VERSION, "registry": "https://registry.example/",
                "cee": {"name": CEE_NAME, "version": CEE_VERSION, "revision": "b" * 40},
                "ceeConsumers": [consumer],
                "frontends": [{"id": "main", "repository": "app", "packagePath": "."}],
            })

            def wire(directory, dependency, published, version, legacy_peer_deps=False):
                dependency_files(directory, dependency, published, version)

            with (
                patch.object(frontend_train, "verify_record"),
                patch.object(frontend_train, "install_exact_alias", side_effect=wire),
            ):
                args = argparse.Namespace(version=VERSION, workspace=workspace, state=state)
                frontend_train.prepare_frontends(args)
                frontend_train.prepare_frontends(args)
            plan = frontend_train.load_json(plan_path)
            preparation = plan["frontendPreparation"]
            self.assertEqual(CEE_VERSION, preparation["ceeVersion"])
            self.assertEqual(
                ["package-lock.json", "package.json"], preparation["overlays"]["main"],
            )
            frontend_train.verify_frontend_preparation(plan, workspace)

    def test_frontend_preparation_rebuilds_a_consumer_that_bundles_cee(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            state = root / "state"
            repository = workspace / "bridging"
            source = repository / "src"
            dependency_files(source, "cedar-embeddable-editor", CEE_NAME, "2.0.2-dev.old")
            distribution = repository / "dist-package"
            write(distribution / "package.json", {
                "name": "bridging-dist", "version": "2.9.3-SNAPSHOT",
            })
            write(distribution / "package-lock.json", {
                "name": "bridging-dist", "version": "2.9.3-SNAPSHOT",
                "packages": {"": {"name": "bridging-dist", "version": "2.9.3-SNAPSHOT"}},
            })
            (distribution / "old.js").write_text("old bundle\n", encoding="utf-8")
            revision = commit(repository)
            write(state / "trains" / f"{VERSION}.json", {
                "version": VERSION, "repositories": {"bridging": revision},
            })
            plan_path = state / "npm" / "trains" / f"{VERSION}.json"
            consumer = {
                "label": "bridging", "repository": "bridging", "revision": revision,
                "manifest": "src/package.json", "lock": "src/package-lock.json",
                "legacyPeerDeps": False, "publishedFrontend": "bridging",
            }
            write(plan_path, {
                "version": VERSION, "registry": "https://registry.example/",
                "cee": {"name": CEE_NAME, "version": CEE_VERSION, "revision": "b" * 40},
                "ceeConsumers": [consumer],
                "frontends": [{
                    "id": "bridging", "repository": "bridging",
                    "packagePath": "dist-package",
                    "preparedBuild": {
                        "directory": "src", "commands": [["npm", "run", "build"]],
                        "output": "src/build-output",
                    },
                }],
            })

            def wire(directory, dependency, published, version, legacy_peer_deps=False):
                dependency_files(directory, dependency, published, version)

            def build(command, cwd, environment=None):
                self.assertEqual(["npm", "run", "build"], command)
                output = cwd / "build-output"
                output.mkdir()
                (output / "main.js").write_text("new CEE bundle\n", encoding="utf-8")

            with (
                patch.object(frontend_train, "verify_record"),
                patch.object(frontend_train, "install_exact_alias", side_effect=wire),
                patch.object(frontend_train, "run_command", side_effect=build),
            ):
                frontend_train.prepare_frontends(argparse.Namespace(
                    version=VERSION, workspace=workspace, state=state,
                ))
            self.assertFalse((distribution / "old.js").exists())
            self.assertEqual("new CEE bundle\n", (distribution / "main.js").read_text())
            self.assertTrue((distribution / "package.json").exists())
            preparation = frontend_train.load_json(plan_path)["frontendPreparation"]
            self.assertEqual(["dist-package"], preparation["overlays"]["bridging"])
            frontend_train.verify_frontend_preparation(
                frontend_train.load_json(plan_path), workspace,
            )

    def test_workflow_exposes_model_cee_and_frontends_as_top_level_stages(self):
        workflow = (
            Path(frontend_train.__file__).parent.parent
            / ".github" / "workflows" / "build-train.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("  publish-model:", workflow)
        self.assertIn("  publish-cee:", workflow)
        self.assertIn("  publish-frontends:", workflow)
        self.assertIn("needs: publish-model", workflow)
        self.assertIn("needs: publish-cee", workflow)
        self.assertNotIn("  publish-npm:", workflow)

    def test_completion_includes_verified_runtime_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            plan = {
                "version": VERSION,
                "sourceManifestSha256": "a" * 64,
                "registry": "https://registry.example/npm/",
                "model": {"name": "model", "version": "1", "revision": "a" * 40},
                "cee": {"name": "cee", "version": "2", "revision": "b" * 40},
                "frontends": [{"name": "app", "version": "3", "revision": "c" * 40}],
                "runtimePackages": [{
                    "name": "runtime", "version": "4",
                    "registry": "https://registry.npmjs.org/",
                }],
                "dockerInputs": {},
            }
            write(state / "npm" / "trains" / f"{VERSION}.json", plan)

            def verified(registry, expected):
                return {"name": expected["name"], "version": expected["version"],
                        "tarballSha256": "d" * 64, "registryUsed": registry}

            with patch.object(frontend_train, "verify_record", side_effect=verified):
                frontend_train.complete(argparse.Namespace(version=VERSION, state=state))
            completion = frontend_train.load_json(
                state / "npm" / "completed" / f"{VERSION}.json"
            )
            runtime = next(item for item in completion["packages"] if item["name"] == "runtime")
            self.assertEqual("https://registry.npmjs.org/", runtime["registryUsed"])


if __name__ == "__main__":
    unittest.main()
