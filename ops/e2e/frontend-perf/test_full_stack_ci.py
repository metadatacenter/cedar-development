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

    def test_candidate_has_no_bootstrap_download_or_executable_mounts_and_requires_empty_volumes(self):
        source=Path(__file__).resolve().parents[3]/'bin/templates'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); home=root/'CEDAR';state=root/'build-trains';train='2.9.34-dev.20261108.1806'
            target=state/'docker/completed'/f'{train}.json';target.parent.mkdir(parents=True)
            target.write_text(json.dumps({'version':train,'images':[{}]*27}))
            templates=home/'cedar-development/bin/templates';templates.mkdir(parents=True)
            for name in ('set-env-internal.sh','set-env-external.sh'):shutil.copyfile(source/name,templates/name)
            deploy=home/'cedar-docker-deploy'
            for name in ('cedar-microservices','cedar-frontend','cedar-infrastructure'):(deploy/name).mkdir(parents=True)
            (deploy/'cedar-microservices/docker-compose.yml').write_text('services:\n  server-resource:\n    image: fixed\n')
            env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_WORKSPACE':directory,'CEDAR_TRAIN_VERSION':train}
            with patch.dict(os.environ,env,clear=True), patch.object(ci.urllib.request,'urlopen') as download, patch('builtins.print'):
                with patch.object(ci.subprocess,'check_output',side_effect=['','existing-volume']):
                    with self.assertRaisesRegex(ValueError,'no existing'):ci.initialize(home,state)
                self.assertFalse((home/'set-env-internal.sh').exists())
                with patch.object(ci.subprocess,'check_output',return_value=''):ci.initialize(home,state)
                download.assert_not_called()
            self.assertFalse((home/'.cedar/cedar-admin-tool.jar').exists())
            self.assertFalse((deploy/'cedar-frontend/docker-compose.override.yml').exists())
            override=json.loads((deploy/'cedar-microservices/docker-compose.override.yml').read_text())
            self.assertNotIn('volumes',override['services']['server-resource'])
            self.assertEqual(json.loads((home/'.cedar/ci-bootstrap.json').read_text()),
                             {'train':train,'emptyVolumes':True,'compatibilityMounts':False})

    def test_executable_overlays_and_entrypoint_substitutions_are_rejected(self):
        completion={'images':[{'image':'cedar-server-resource','reference':'fixed'}]}
        original={'Id':'sha256:fixed','Config':{'Entrypoint':['/entrypoint.sh']}}
        container={'Image':'sha256:fixed','Config':original['Config'],'Mounts':[
            {'Type':'volume','Destination':'/cedar/log/cedar-resource-server/'}]}
        def check():
            with patch.object(ci.subprocess,'check_output',side_effect=[json.dumps([container]),json.dumps([original])]):
                ci.verify_unmodified_containers(completion,Path('/runner/CEDAR'))
        check()
        container['Mounts'].append({'Type':'bind','Destination':'/cedar/app/cedar-admin-tool.jar'})
        with self.assertRaisesRegex(ValueError,'overlay'):check()
        container['Mounts']=[];container['Config']={'Entrypoint':['/replacement.sh']}
        with self.assertRaisesRegex(ValueError,'entrypoint'):check()
