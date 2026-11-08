#!/usr/bin/env python3
"""Check out the captured hosted stack and attach fresh-start evidence before publication."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

import docker_train

sys.path.insert(0, str(Path(__file__).parent/'e2e/frontend-perf'))
import full_stack_ci


def checkout(home, state):
    version = full_stack_ci.guard(home, state)
    source, raw = docker_train.source_manifest(version, state)
    completion = json.loads((state/'docker/completed'/f'{version}.json').read_text())
    if hashlib.sha256(raw).hexdigest() != completion['sourceManifestSha256']:
        raise ValueError('Candidate and captured source manifest differ')
    if home.exists() and any(home.iterdir()):
        raise ValueError('Acceptance checkout must be empty')
    for repository in ('cedar-development','cedar-cli','cedar-docker-build','cedar-docker-deploy'):
        revision = source['repositories'][repository]
        if not docker_train.SHA_RE.fullmatch(revision):
            raise ValueError('Invalid captured source: '+repository)
        docker_train.checkout_one(repository, revision, home)


def record(home, state, report_path):
    version = full_stack_ci.guard(home, state)
    raw = report_path.read_bytes(); report = json.loads(raw)
    metadata = report['metadata']; deployment = metadata['deployment']
    required = {'workspace-dashboard','monitoring-dashboard','bridging-dashboard','content-index','term-picker'}
    required |= {family+'-'+size for family in ('cee-standalone','ced-standalone','ced-integrated',
                  'designer','workspace-editor','openview') for size in ('small','large')}
    samples = report['samples']
    expected = {(scenario, cache) for scenario in required for cache in ('cold','warm')}
    observed = {(sample['scenario'], sample['cache']) for sample in samples}
    if (not report.get('complete') or len(samples) != 34 or observed != expected
            or any(sample['status'] != 'ok' or sample['profile'] != 'normal' or sample['repeat'] != 1 for sample in samples)
            or metadata.get('adjustments') != [] or deployment.get('mode') != 'direct'
            or deployment.get('train') != version
            or deployment.get('bootstrap', {}).get('compatibilityMounts') is not False
            or deployment.get('bootstrap', {}).get('emptyVolumes') is not True):
        raise ValueError('Fresh-stack acceptance needs all 17 real pages/components without compatibility adjustments')
    path = state/'docker/completed'/f'{version}.json'
    completion = json.loads(path.read_text())
    if completion['images'] != deployment['images']:
        raise ValueError('Acceptance did not exercise this verified image inventory')
    completion['freshStackAcceptance'] = {
        'status':'passed', 'completedAt':report['finishedAt'], 'reportSha256':hashlib.sha256(raw).hexdigest(),
        'run':f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        'scenarios':sorted(required), 'successfulSamples':len(samples), 'timingsReportingOnly':True,
        'emptyVolumes':True, 'compatibilityMounts':False, 'applicationPages':'deployment-nginx',
        'tooling':deployment['tooling'], 'resourceLimits':deployment['resourceLimits'],
    }
    docker_train.write_json(path, completion)
    print('Fresh-stack acceptance passed: 17 modern scenarios, 34 cold/warm checks; no executable overlays.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['checkout','record'])
    parser.add_argument('--state',required=True,type=Path)
    parser.add_argument('--report',type=Path)
    args=parser.parse_args(); home=Path(os.environ['CEDAR_HOME'])
    if args.action=='checkout':checkout(home,args.state)
    else:record(home,args.state,args.report)


if __name__=='__main__':main()
