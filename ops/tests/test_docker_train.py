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

    def test_backend_plan_and_checkout_need_no_npm_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            workspace = Path(directory) / 'workspace'
            self.make_state(state)
            (state / 'npm/completed' / f'{VERSION}.json').unlink()
            args = argparse.Namespace(config=docker_train.DEFAULT_CONFIG, version=VERSION,
                state=state, workspace=workspace, image='cedar-server-repo')
            docker_train.record_backend_plan(args)
            plan = docker_train.load_json(state / 'docker/backend-trains' / f'{VERSION}.json')
            self.assertEqual(20, len(plan['images']))
            self.assertFalse(any(row['image'] in docker_train.FRONTEND_IMAGES for row in plan['images']))
            with patch.object(docker_train, 'checkout_one') as checkout:
                docker_train.checkout(args)
            self.assertEqual(2, checkout.call_count)
            self.assertTrue((workspace / '.cedar-backend-manifest-sha256').is_file())
            self.assertFalse((workspace / '.cedar-frontend-manifest-sha256').exists())
            self.assertEqual({}, docker_train.load_json(workspace / '.cedar-frontend-inputs.json'))
            with self.assertRaises(FileNotFoundError):
                docker_train.record_plan(args)
            self.assertFalse((state / 'docker/current.json').exists())

    def test_backend_plan_refuses_changed_source_or_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.make_state(state)
            args = argparse.Namespace(config=docker_train.DEFAULT_CONFIG, version=VERSION, state=state)
            docker_train.record_backend_plan(args)
            source_path = state / 'trains' / f'{VERSION}.json'
            source = docker_train.load_json(source_path)
            source['repositories']['cedar-cli'] = 'c' * 40
            write(source_path, source)
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                docker_train.record_backend_plan(args)
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                docker_train.backend_plan_hash(docker_train.load_json(args.config), VERSION, state)

    def test_backend_publication_uses_backend_provenance_without_frontend_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / '.cedar-train-manifest-sha256').write_text('a' * 64)
            (workspace / '.cedar-backend-manifest-sha256').write_text('b' * 64)
            write(workspace / '.cedar-frontend-inputs.json', {})
            image = 'cedar-server-repo'
            labels = docker_train.expected_labels(image, VERSION, 'a' * 64, None, 'b' * 64)
            with patch.dict(os.environ, {'CEDAR_FRONTEND_MANIFEST_SHA256': 'c' * 64}), \
                 patch.object(docker_train, 'remote_exists', return_value=False), \
                 patch.object(docker_train, 'inspect_image', return_value={'Config': {'Labels': labels}}), \
                 patch.object(docker_train, 'run') as run:
                docker_train.publish_image(argparse.Namespace(config=docker_train.DEFAULT_CONFIG,
                    version=VERSION, workspace=workspace, image=image))
            command = next(c for c in run.call_args_list if 'build' in c.args[0])
            env = command.kwargs['environment']
            self.assertNotIn('CEDAR_FRONTEND_MANIFEST_SHA256', env)
            self.assertEqual('b' * 64, env['CEDAR_BACKEND_MANIFEST_SHA256'])
            with self.assertRaisesRegex(RuntimeError, 'backend provenance'):
                docker_train.expected_labels('cedar-frontend-workspace', VERSION, 'a' * 64, None, 'b' * 64)

    def test_complete_split_train_still_pulls_and_verifies_all_images(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                source_hash = self.make_state(state)
                args = argparse.Namespace(config=docker_train.DEFAULT_CONFIG, version=VERSION, state=state)
                docker_train.record_backend_plan(args)
                docker_train.record_plan(args)
                backend_hash = docker_train.backend_plan_hash(docker_train.load_json(args.config), VERSION, state)
                frontend_hash = self.frontend_hash(source_hash)
                def inspected(reference):
                    image = reference.rsplit('/', 1)[1].split(':')[0]
                    labels = docker_train.expected_labels(image, VERSION, source_hash, frontend_hash,
                        backend_hash if image not in docker_train.FRONTEND_IMAGES else None)
                    if corrupt and image == 'cedar-server-repo':
                        labels['org.metadatacenter.cedar.backend-manifest-sha256'] = 'f' * 64
                    return {'Config': {'Labels': labels}, 'RepoDigests': [reference.rsplit(':', 1)[0] + '@sha256:' + 'c' * 64],
                            'Os': 'linux', 'Architecture': 'amd64'}
                with patch.object(docker_train, 'inspect_image', side_effect=inspected), \
                     patch.object(docker_train, 'run') as run:
                    run.return_value.stdout = frontend_hash + '  manifest\n'
                    if corrupt:
                        with self.assertRaisesRegex(RuntimeError, 'incorrect provenance'):
                            docker_train.verify(args)
                        self.assertFalse((state / 'docker/current.json').exists())
                    else:
                        docker_train.verify(args)
                        completion = docker_train.load_json(state / 'docker/completed' / f'{VERSION}.json')
                        self.assertEqual(3, completion['schemaVersion'])
                        self.assertEqual(backend_hash, completion['backendManifestSha256'])
                        self.assertEqual(27, len(completion['images']))
                        self.assertEqual(27, len([c for c in run.call_args_list if c.args[0][:2] == ['docker', 'pull']]))

    def test_workflow_starts_backend_after_maven_and_keeps_complete_final_join(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-train.yml').read_text()
        early = workflow.split('  record-backend-plan:', 1)[1].split('  record-docker-plan:', 1)[0]
        self.assertIn('needs: publish-maven', early)
        self.assertNotIn('publish-frontends', early)
        backend = workflow.split('  java-base:', 1)[1].split('  frontends:', 1)[0]
        self.assertNotIn('record-docker-plan', backend)
        self.assertIn('needs: [record-backend-plan, microservice-base]', backend)
        final = workflow.split('  verify-docker-train:', 1)[1]
        self.assertIn('needs: [record-docker-plan, java-base, microservice-base, infrastructure, microservices, frontends]', final)
        self.assertIn('Pull and verify all 27 core images', final)



if __name__ == "__main__":
    unittest.main()
