import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_frontend_configuration as gate


class ConfigurationAssertionsTest(unittest.TestCase):
    def test_only_hostname_may_change(self):
        before = {'main.js': (b'const e={cedarDomain:"production.example"};', 0o644),
                  'index.html': (b'<html></html>', 0o644)}
        after = {**before, 'main.js': (b'const e={cedarDomain:"' + gate.DOMAIN.encode() + b'"};', 0o644)}
        self.assertEqual('main.js', gate.verify_configuration(before, after, 'app'))
        for invalid in (before, {**after, 'extra.txt': (b'extra', 0o644)},
                        {**after, 'index.html': (b'changed', 0o644)},
                        {**after, 'main.js': (after['main.js'][0] + b'extra', 0o644)},
                        {**after, 'main.js': (after['main.js'][0], 0o755)}):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                gate.verify_configuration(before, invalid, 'app')

    def test_workflow_gates_publication_after_assembly(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-train.yml').read_text()
        job = workflow.split('  publish-frontends:', 1)[1].split('  record-backend-plan:', 1)[0]
        self.assertLess(job.index('frontend_train.py prepare-frontends'), job.index('check_frontend_configuration.py'))
        self.assertLess(job.index('check_frontend_configuration.py'), job.index('frontend_train.py publish-frontends'))
        self.assertIn('$RUNNER_TEMP/CEDAR/cedar-cli/requirements.txt', job)
        self.assertIn('name: frontend-configuration', job)
        self.assertNotIn('continue-on-error', job)


CLI = Path(os.environ.get('CEDAR_TEST_CLI', Path(__file__).resolve().parents[3] / 'cedar-cli'))


@unittest.skipUnless((CLI / 'cedar.py').is_file(), 'requires the sibling cedar-cli checkout')
class ConfigurationCommandsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        for repository in gate.REPOSITORIES:
            dist = self.workspace / repository / f'{repository}-dist'
            dist.mkdir(parents=True)
            (dist / 'index.html').write_text('<script type="module" src="main-A.js"></script>')
            (dist / 'styles.css').write_text('body { color: black }')
            (dist / 'main-A.js').write_text('const config={cedarDomain:"metadatacenter.org"};')
        self.dist = self.workspace / 'cedar-monitoring/cedar-monitoring-dist'
        (self.dist / 'chunk-B.js').write_text((self.dist / 'main-A.js').read_text())
        (self.dist / 'main-A.js').write_text('import "./chunk-B.js";import("./chunk-C.js");')
        (self.dist / 'chunk-C.js').write_text('import "./chunk-B.js";export const route=true;')

    def check(self):
        return gate.check_payloads(self.workspace, cli=CLI)

    def test_real_commands_configure_shared_chunk_and_reset_all_bytes(self):
        before = {repo: gate.snapshot(self.workspace / repo / f'{repo}-dist') for repo in gate.REPOSITORIES}
        receipt = self.check()
        self.assertEqual('chunk-B.js', receipt['payloads']['cedar-monitoring']['configurationModule'])
        self.assertEqual(5, len(receipt['payloads']['cedar-monitoring']['files']))
        self.assertEqual(before, {repo: gate.snapshot(self.workspace / repo / f'{repo}-dist') for repo in gate.REPOSITORIES})
        self.assertFalse(any(self.workspace.rglob('.git')))

    def test_missing_duplicate_and_broken_imports_fail_real_commands(self):
        for content in ('const missing=true;',
                        'const a={cedarDomain:"one"},b={cedarDomain:"two"};',
                        'import "./missing.js";const a={cedarDomain:"one"};'):
            with self.subTest(content=content):
                (self.dist / 'chunk-B.js').write_text(content)
                with self.assertRaises(subprocess.CalledProcessError):
                    self.check()

    def test_successful_exit_with_no_configuration_is_rejected(self):
        with patch.object(gate, 'run_cli'), self.assertRaisesRegex(RuntimeError, 'exactly one changed'):
            self.check()

    def test_reset_success_without_restoration_is_rejected(self):
        real = gate.run_cli

        def no_reset(cli, python, home, command):
            if command != 'reset-frontends':
                real(cli, python, home, command)

        with patch.object(gate, 'run_cli', side_effect=no_reset), \
                self.assertRaisesRegex(RuntimeError, 'reset did not restore'):
            self.check()

    def test_repeated_configuration_must_be_idempotent(self):
        real = gate.run_cli
        calls = []

        def non_idempotent(cli, python, home, command):
            real(cli, python, home, command)
            calls.append(command)
            if len(calls) == 2:
                (home / 'cedar-monitoring/cedar-monitoring-dist/styles.css').write_text('changed')

        with patch.object(gate, 'run_cli', side_effect=non_idempotent), \
                self.assertRaisesRegex(RuntimeError, 'not idempotent'):
            self.check()

    def test_missing_payload_fails_before_any_command(self):
        (self.dist / 'main-A.js').unlink()
        (self.dist / 'chunk-B.js').unlink()
        (self.dist / 'chunk-C.js').unlink()
        (self.dist / 'index.html').unlink()
        (self.dist / 'styles.css').unlink()
        with patch.object(gate, 'run_cli') as command, self.assertRaisesRegex(RuntimeError, 'Empty or missing'):
            self.check()
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
