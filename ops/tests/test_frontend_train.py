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

            def library_record(_registry, name, _version):
                return {"gitHead": model_sha if name == MODEL_NAME else cee_sha}

            with patch.object(frontend_train, "registry_record", side_effect=library_record):
                frontend_train.record_plan(argparse.Namespace(
                    config=config_path, version=VERSION, workspace=workspace, state=state,
                ))
            plan = frontend_train.load_json(state / "npm" / "trains" / f"{VERSION}.json")
            self.assertEqual(MODEL_VERSION, plan["cee"]["model"]["version"])
            self.assertEqual(CEE_VERSION, plan["frontends"][0]["ceeVersion"])
            self.assertEqual(
                f"2.9.3-dev.20260825220426.g{app_sha[:12]}.p2",
                plan["dockerInputs"]["CEDAR_APP_NPM_VERSION"],
            )
            self.assertEqual(
                CEE_VERSION, plan["dockerInputs"]["CEDAR_OPENVIEW_CEE_NPM_VERSION"]
            )
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
        with tempfile.TemporaryDirectory() as directory:
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
