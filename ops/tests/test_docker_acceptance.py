import copy
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import docker_acceptance as acceptance


class AcceptanceTest(unittest.TestCase):
    def test_completion_requires_every_direct_scenario_without_compatibility_patches(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state=root/'build-trains';train='2.9.34-dev.20261108.1806'
            target=state/'docker/completed'/f'{train}.json';target.parent.mkdir(parents=True)
            completion={'version':train,'images':[{}]*27}
            names={'workspace-dashboard','monitoring-dashboard','bridging-dashboard','content-index','term-picker'}
            names|={family+'-'+size for family in ('cee-standalone','ced-standalone','ced-integrated','designer','workspace-editor','openview') for size in ('small','large')}
            report={'complete':True,'finishedAt':'now','metadata':{'adjustments':[], 'deployment':{
                'mode':'direct','train':train,'bootstrap':{'emptyVolumes':True,'compatibilityMounts':False},
                'images':completion['images'],'tooling':{},'resourceLimits':{}}},'samples':[
                {'scenario':name,'cache':cache,'status':'ok','profile':'normal','repeat':1} for name in names for cache in ('cold','warm')]}
            env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_WORKSPACE':directory,
                 'CEDAR_TRAIN_VERSION':train,'GITHUB_REPOSITORY':'metadatacenter/cedar-development','GITHUB_RUN_ID':'123'}
            with patch.dict(os.environ,env,clear=True):
                for defect in ('missing','failed','duplicate','lab','overlay','patched','different-images',None):
                    with self.subTest(defect=defect):
                        candidate=copy.deepcopy(report)
                        if defect=='missing':candidate['samples'].pop()
                        if defect=='failed':candidate['samples'][0]['status']='failed'
                        if defect=='duplicate':candidate['samples'][0]=candidate['samples'][1]
                        if defect=='lab':candidate['metadata']['deployment']['mode']='lab'
                        if defect=='overlay':candidate['metadata']['deployment']['bootstrap']['compatibilityMounts']=True
                        if defect=='patched':candidate['metadata']['adjustments']=[{'change':'domain'}]
                        if defect=='different-images':candidate['metadata']['deployment']['images']=[]
                        target.write_text(json.dumps(completion));before=target.read_bytes()
                        report_path=root/'report.json';report_path.write_text(json.dumps(candidate))
                        if defect:
                            with self.assertRaises(ValueError):acceptance.record(root/'CEDAR',state,report_path)
                            self.assertEqual(target.read_bytes(),before)
                        else:
                            acceptance.record(root/'CEDAR',state,report_path)
                            proof=json.loads(target.read_text())['freshStackAcceptance']
                            self.assertEqual(proof['successfulSamples'],34)
                            self.assertEqual(proof['status'],'passed')

    def test_train_cannot_publish_before_acceptance(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/build-train.yml').read_text()
        final=workflow.split('  verify-docker-train:',1)[1]
        steps=re.split(r'^      - ',final,flags=re.M)[1:]
        names=[step.splitlines()[0].removeprefix('name: ') for step in steps]
        ordered=['Pull and verify all 27 core images','Initialize an empty installation without compatibility mounts',
                 'Start the verified candidate from empty volumes',
                 'Check real deployed pages and standalone components with real APIs and SSO',
                 'Record required fresh-stack acceptance','Advance the completed Docker-train pointer']
        positions=[names.index(name) for name in ordered]
        self.assertEqual(positions,sorted(positions))
        for position in positions:
            self.assertNotRegex(steps[position],r'(?m)^        (?:if|continue-on-error):')
