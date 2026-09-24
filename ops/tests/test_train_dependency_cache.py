import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cache', Path(__file__).resolve().parents[1] / 'train_dependency_cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class DependencyCacheTest(unittest.TestCase):
    def test_restore_and_save_exclude_cedar_artifacts_and_failed_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, restored, saved = [root / p for p in ('cache', 'm2', 'saved')]
            for path in ['org/metadatacenter/lib/old.jar', 'com/example/lib.jar', 'com/example/bad.lastUpdated']:
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('bytes')
            self.assertEqual(1, cache.copy_maven_dependencies(source, restored))
            self.assertEqual(1, cache.copy_maven_dependencies(restored, saved))
            self.assertFalse((restored / 'org/metadatacenter').exists())
            self.assertEqual('bytes', (saved / 'com/example/lib.jar').read_text())

    def test_keys_use_captured_inputs_not_stamped_or_installed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repository'
            repo.mkdir()
            def git(*args):
                subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
            git('init', '-q')
            git('config', 'user.email', 'test@example.org')
            git('config', 'user.name', 'Test')
            (repo / 'pom.xml').write_text('captured pom')
            (repo / 'package-lock.json').write_text('captured lock')
            git('add', 'pom.xml', 'package-lock.json')
            git('commit', '-qm', 'inputs')
            keys = {kind: cache.dependency_key(root, kind) for kind in ('npm', 'maven')}
            (repo / 'pom.xml').write_text('stamped train version')
            (repo / 'package-lock.json').write_text('wired train dependency')
            for kind in keys:
                self.assertEqual(keys[kind], cache.dependency_key(root, kind))
            git('add', 'pom.xml', 'package-lock.json')
            git('commit', '-qm', 'new captured inputs')
            for kind in keys:
                self.assertNotEqual(keys[kind], cache.dependency_key(root, kind))
