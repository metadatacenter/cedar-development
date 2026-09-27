import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('push_train_state', Path(__file__).resolve().parents[1] / 'push_train_state.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class TrainStatePushTest(unittest.TestCase):
    def test_independent_updates_survive_a_concurrent_push(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(cwd, *args):
                return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout
            git(root, 'init', '--bare', 'remote')
            git(root, 'clone', str(root/'remote'), 'a')
            a = root/'a'
            git(a, 'config', 'user.email', 'test@example.org'); git(a, 'config', 'user.name', 'Test')
            git(a, 'checkout', '-b', 'build-trains')
            (a/'source').write_text('immutable source')
            git(a, 'add', 'source'); git(a, 'commit', '-m', 'source')
            git(a, 'push', 'origin', 'HEAD:build-trains')
            git(root, 'clone', '--branch', 'build-trains', str(root/'remote'), 'b')
            b = root/'b'
            git(b, 'config', 'user.email', 'test@example.org'); git(b, 'config', 'user.name', 'Test')
            for repo, name in [(a, 'maven'), (b, 'npm')]:
                (repo/name).write_text('verified')
                git(repo, 'add', name); git(repo, 'commit', '-m', name)
            git(a, 'push', 'origin', 'HEAD:build-trains')
            with patch.object(module.time, 'sleep'):
                module.push(b)
            self.assertEqual('verified', (b/'maven').read_text())
            self.assertEqual('verified', (b/'npm').read_text())
            self.assertEqual(git(b, 'rev-parse', 'HEAD').strip(),
                             git(b, 'ls-remote', 'origin', 'refs/heads/build-trains').split()[0])

    def test_push_retry_never_force_pushes_and_conflicts_fail(self):
        with patch.object(module.subprocess, 'run') as run:
            run.side_effect = [subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0),
                               subprocess.CalledProcessError(1, ['git','rebase'])]
            with self.assertRaises(subprocess.CalledProcessError):
                module.push(Path('/unused'))
            self.assertEqual(3, run.call_count)
            self.assertTrue(all('--force' not in c.args[0] for c in run.call_args_list))
