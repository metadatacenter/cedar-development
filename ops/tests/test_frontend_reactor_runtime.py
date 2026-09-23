import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('frontend_reactor_runtime', Path(__file__).resolve().parents[1] / 'frontend_reactor_runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReactorRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.frontend = self.home / 'cedar-workspace'
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode='w:gz') as archive:
            data = b'new reactor bundle'
            member = tarfile.TarInfo('package/cedar-embeddable-editor.js')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        packed = archive_bytes.getvalue()
        digest = hashlib.sha256(packed).hexdigest()
        self.artifact = self.home / '.reactor/artifacts' / (digest + '.tgz')
        self.write(self.artifact, packed)
        self.write(self.home / '.reactor/runtime.json', json.dumps({'packages': {'cedar-embeddable-editor': digest}}).encode())
        self.install_lock = self.frontend / 'node_modules/.package-lock.json'
        self.entry = {'resolved': 'file:../.reactor/artifacts/' + self.artifact.name}
        self.lock()
        self.installed = self.frontend / 'node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js'
        self.served = self.frontend / 'app/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js'
        self.write(self.installed, data)
        self.write(self.served, data)

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def lock(self):
        self.write(self.install_lock, json.dumps({'packages': {'node_modules/cedar-embeddable-editor': self.entry}}).encode())

    def test_verified_reactor_install_is_current(self):
        self.assertTrue(module.current(self.home, self.frontend))

    def test_changed_served_or_installed_bundle_is_stale(self):
        for path in [self.installed, self.served]:
            original = path.read_bytes()
            path.write_bytes(b'old bundle')
            self.assertFalse(module.current(self.home, self.frontend))
            path.write_bytes(original)

    def test_modified_tarball_is_rejected(self):
        self.artifact.write_bytes(b'not the recorded artifact')
        self.assertFalse(module.current(self.home, self.frontend))

    def test_registry_install_does_not_claim_reactor_provenance(self):
        self.entry['resolved'] = 'https://registry.example/package.tgz'
        self.lock()
        self.assertFalse(module.current(self.home, self.frontend))

    def test_missing_artifact_is_stale(self):
        self.artifact.unlink()
        self.assertFalse(module.current(self.home, self.frontend))

    def test_start_restores_reactor_after_registry_install(self):
        from unittest.mock import patch
        self.write(self.frontend / 'package.json', json.dumps({'dependencies': {'cedar-embeddable-editor': '2.0.16'}}).encode())
        self.entry['resolved'] = 'https://registry.example/old.tgz'
        self.lock()
        with patch.object(module.subprocess, 'run') as run:
            module.sync(self.home, self.frontend)
        args = run.call_args.args[0]
        self.assertIn('--no-save', args)
        self.assertIn('cedar-embeddable-editor@file:' + str(self.artifact.resolve()), args)
        self.assertNotIn('--package-lock=false', args)

    def test_current_install_needs_no_npm_operation(self):
        from unittest.mock import patch
        self.write(self.frontend / 'package.json', json.dumps({'dependencies': {'cedar-embeddable-editor': '2.0.16'}}).encode())
        with patch.object(module.subprocess, 'run') as run:
            module.sync(self.home, self.frontend)
        run.assert_not_called()

    def test_corrupt_artifact_cannot_be_installed(self):
        from unittest.mock import patch
        self.write(self.frontend / 'package.json', json.dumps({'dependencies': {'cedar-embeddable-editor': '2.0.16'}}).encode())
        self.artifact.write_bytes(b'changed')
        with patch.object(module.subprocess, 'run') as run, self.assertRaises(ValueError):
            module.sync(self.home, self.frontend)
        run.assert_not_called()

    def test_matching_lock_with_wrong_bytes_forces_fresh_extraction(self):
        from unittest.mock import patch
        self.write(self.frontend / 'package.json', json.dumps({'dependencies': {'cedar-embeddable-editor': '2.0.16'}}).encode())
        self.installed.write_bytes(b'old bundle behind current hidden lock')
        def install(*args, **kwargs):
            self.assertFalse(self.installed.parent.exists())
            self.write(self.installed, b'new reactor bundle')
        with patch.object(module.subprocess, 'run', side_effect=install):
            module.sync(self.home, self.frontend)
        module.sync(self.home, self.frontend, verify_only=True)

    def test_verification_never_removes_stale_install(self):
        self.write(self.frontend / 'package.json', json.dumps({'dependencies': {'cedar-embeddable-editor': '2.0.16'}}).encode())
        self.installed.write_bytes(b'old bundle')
        with self.assertRaises(ValueError):
            module.sync(self.home, self.frontend, verify_only=True)
        self.assertEqual(self.installed.read_bytes(), b'old bundle')
