import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import full_stack_ci as ci


class HostedStackTest(unittest.TestCase):
    def test_initializer_cannot_run_on_workstation_or_existing_installation(self):
        with tempfile.TemporaryDirectory() as root:
            home=Path(root)/'CEDAR';home.mkdir()
            with patch.dict(os.environ,{},clear=True):
                with self.assertRaisesRegex(ValueError,'GitHub-hosted'):ci.initialize(home)
            env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_WORKSPACE':root}
            with patch.dict(os.environ,env,clear=True):
                with self.assertRaisesRegex(ValueError,'GITHUB_WORKSPACE'):ci.guard(Path(root))
                (home/'set-env-internal.sh').write_text('keep')
                with self.assertRaisesRegex(ValueError,'existing installation'):ci.initialize(home)
                self.assertEqual((home/'set-env-internal.sh').read_text(),'keep')
