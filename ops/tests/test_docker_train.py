import argparse
import hashlib
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import docker_train


VERSION = "2.9.3-dev.20260824.1847"


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def source_value() -> dict:
    return {
        "version": VERSION,
        "repositories": {
            "cedar-cli": "a" * 40,
            "cedar-docker-build": "b" * 40,
        },
        "frontendPackages": {"CEDAR_WORKSPACE_NPM_VERSION": "2.9.3-dev.example"},
    }


class DockerTrainTest(unittest.TestCase):
    def test_train_registry_overrides_retained_builder_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / '.cedar-train-manifest-sha256').write_text('a' * 64)
            (workspace / '.cedar-frontend-manifest-sha256').write_text('b' * 64)
            inputs = {'CEDAR_NPM_REGISTRY': 'https://registry.example/train',
                      'CEDAR_WORKSPACE_NPM_VERSION': '2.9.3-dev.example'}
            write(workspace / '.cedar-frontend-inputs.json', inputs)
            with patch.dict(os.environ, {'CEDAR_NPM_REGISTRY': 'https://registry.example/retained'}), \
                 patch.object(docker_train, 'remote_exists', return_value=False), \
                 patch.object(docker_train, 'inspect_image'), \
                 patch.object(docker_train, 'verify_labels'), \
                 patch.object(docker_train, 'verify_embedded_manifest'), \
                 patch.object(docker_train, 'run') as run:
                docker_train.publish_image(argparse.Namespace(
                    config=docker_train.DEFAULT_CONFIG, version=VERSION,
                    workspace=workspace, image='cedar-frontend-workspace'))
            command = next(call for call in run.call_args_list
                           if 'build' in call.args[0])
            self.assertEqual(inputs, {key: command.kwargs['environment'][key] for key in inputs})

    def make_state(self, root: Path) -> str:
        source = source_value()
        source_path = root / "trains" / f"{VERSION}.json"
        write(source_path, source)
        write(root / "completed" / f"{VERSION}.json", {"version": VERSION})
        write(root / "npm" / "completed" / f"{VERSION}.json", {
            "version": VERSION,
            "planSha256": "d" * 64,
            "sourceManifestSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
            "dockerInputs": {"CEDAR_WORKSPACE_NPM_VERSION": "2.9.3-dev.example"},
            "packages": [],
        })
        return hashlib.sha256(source_path.read_bytes()).hexdigest()

    @staticmethod
    def frontend_hash(source_hash: str) -> str:
        npm = {
            "version": VERSION,
            "planSha256": "d" * 64,
            "sourceManifestSha256": source_hash,
            "dockerInputs": {"CEDAR_WORKSPACE_NPM_VERSION": "2.9.3-dev.example"},
            "packages": [],
        }
        content = (json.dumps(
            docker_train.runtime_manifest(VERSION, source_hash, npm),
            indent=2, sort_keys=True,
        ) + "\n").encode()
        return hashlib.sha256(content).hexdigest()

    def test_plan_records_exactly_two_internal_and_twenty_five_runtime_images(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            source_hash = self.make_state(state)
            docker_train.record_plan(argparse.Namespace(
                config=docker_train.DEFAULT_CONFIG,
                version=VERSION,
                state=state,
            ))

            plan = json.loads((state / "docker" / "trains" / f"{VERSION}.json").read_text())
            internal = [
                image for image in plan["images"]
                if image["prefix"].endswith("docker-cedar-internal")
            ]
            public = [
                image for image in plan["images"]
                if image["prefix"].endswith("docker-cedar")
            ]
            self.assertEqual(2, len(internal))
            self.assertEqual(25, len(public))
            self.assertEqual(source_hash, plan["sourceManifestSha256"])
            self.assertFalse((state / "docker" / "current.json").exists())

    @patch.object(docker_train, "inspect_image")
    @patch.object(docker_train, "run")
    def test_verify_pulls_every_image_before_advancing_current(self, run, inspect):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            source_hash = self.make_state(state)
            frontend_hash = self.frontend_hash(source_hash)
            docker_train.record_plan(argparse.Namespace(
                config=docker_train.DEFAULT_CONFIG,
                version=VERSION,
                state=state,
            ))

            barrier = threading.Barrier(4)
            observed = set()
            guard = threading.Lock()

            def inspected(reference):
                with guard:
                    observed.add(threading.get_ident())
                    first_wave = inspect.call_count <= 4
                if first_wave:
                    barrier.wait(timeout=5)
                repository = reference.rsplit(":", 1)[0]
                image = repository.rsplit("/", 1)[1]
                return {
                    "RepoDigests": [repository + "@sha256:" + "c" * 64],
                    "Os": "linux",
                    "Architecture": "amd64",
                    "Config": {"Labels": {
                        "org.metadatacenter.cedar.image": image,
                        "org.metadatacenter.cedar.train": VERSION,
                        "org.metadatacenter.cedar.source-manifest-sha256": source_hash,
                        "org.metadatacenter.cedar.frontend-manifest-sha256": frontend_hash,
                        "org.opencontainers.image.revision": "b" * 40,
                    }},
                }

            inspect.side_effect = inspected
            run.return_value.stdout = frontend_hash + "  /usr/local/share/cedar-build-manifest.json\n"
            docker_train.verify(argparse.Namespace(
                config=docker_train.DEFAULT_CONFIG,
                version=VERSION,
                state=state,
            ))

            completion = json.loads(
                (state / "docker" / "completed" / f"{VERSION}.json").read_text()
            )
            current = json.loads((state / "docker" / "current.json").read_text())
            self.assertEqual(4, len(observed))
            self.assertEqual(docker_train.core_images(docker_train.load_json(docker_train.DEFAULT_CONFIG)),
                             [item["image"] for item in completion["images"]])
            self.assertEqual(27, len(completion["images"]))
            self.assertEqual(VERSION, current["version"])
            pulls = [call for call in run.call_args_list if call.args[0][:2] == ["docker", "pull"]]
            self.assertEqual(27, len(pulls))

    @patch.object(docker_train, "inspect_image")
    @patch.object(docker_train, "run")
    def test_wrong_provenance_never_creates_completion_or_current(self, _run, inspect):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.make_state(state)
            docker_train.record_plan(argparse.Namespace(
                config=docker_train.DEFAULT_CONFIG,
                version=VERSION,
                state=state,
            ))
            inspect.return_value = {
                "RepoDigests": [],
                "Config": {"Labels": {}},
            }

            with self.assertRaises(RuntimeError):
                docker_train.verify(argparse.Namespace(
                    config=docker_train.DEFAULT_CONFIG,
                    version=VERSION,
                    state=state,
                ))

            self.assertFalse((state / "docker" / "completed" / f"{VERSION}.json").exists())
            self.assertFalse((state / "docker" / "current.json").exists())


if __name__ == "__main__":
    unittest.main()
