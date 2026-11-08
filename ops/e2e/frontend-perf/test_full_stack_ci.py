import os
import hashlib
import io
import json
import shutil
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

    def test_fresh_ci_configuration_uses_verified_bootstrap_and_private_secrets(self):
        source = Path(__file__).resolve().parents[3]/'bin/templates'
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)/'CEDAR'; templates = home/'cedar-development/bin/templates'
            templates.mkdir(parents=True)
            for name in ('set-env-internal.sh','set-env-external.sh'):
                shutil.copyfile(source/name,templates/name)
            deploy = home/'cedar-docker-deploy'
            (deploy/'cedar-microservices').mkdir(parents=True)
            (deploy/'cedar-infrastructure').mkdir()
            (deploy/'cedar-frontend').mkdir()
            designer = home/'cedar-docker-build/cedar-frontend-template-designer/scripts/docker-entrypoint.sh'
            designer.parent.mkdir(parents=True); designer.write_text('#!/bin/bash\nexit 0\n')
            (deploy/'cedar-microservices/docker-compose.yml').write_text('services:\n  server-resource:\n    image: fixed\n')
            env = {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_WORKSPACE':root}
            data = b'checksum-verified-fixture'
            with patch.dict(os.environ,env,clear=True), patch.object(ci,'ADMIN_SHA256',hashlib.sha256(data).hexdigest()), \
                 patch.object(ci.urllib.request,'urlopen',return_value=io.BytesIO(data)), patch('builtins.print'):
                ci.initialize(home)
            secret = home/'.cedar/ci-secrets.json'
            self.assertEqual(secret.stat().st_mode & 0o777,0o600)
            self.assertTrue(all(len(value)==64 for value in json.loads(secret.read_text()).values()))
            override = json.loads((deploy/'cedar-microservices/docker-compose.override.yml').read_text())
            self.assertTrue(override['services']['server-resource']['volumes'][0].endswith(':/cedar/app/cedar-admin-tool.jar:ro'))
            self.assertEqual((home/'.cedar/cedar-admin-tool.jar').read_bytes(),data)
            limits = json.loads((home/'.cedar/ci-resource-limits.json').read_text())
            self.assertNotIn('volumes',limits['microservices']['services']['server-resource'])
            self.assertIn('CEDAR_DATACITE_ENABLED="false"',(home/'set-env-external.sh').read_text())
