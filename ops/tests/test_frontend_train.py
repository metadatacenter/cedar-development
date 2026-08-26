import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
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
                f"2.9.3-dev.20260825220426.g{app_sha[:12]}",
                plan["dockerInputs"]["CEDAR_APP_NPM_VERSION"],
            )
            self.assertEqual(
                CEE_VERSION, plan["dockerInputs"]["CEDAR_OPENVIEW_CEE_NPM_VERSION"]
            )

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


if __name__ == "__main__":
    unittest.main()
