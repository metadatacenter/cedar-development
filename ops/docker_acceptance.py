#!/usr/bin/env python3
"""Check out the captured hosted stack and attach fresh-start and smoke evidence before publication."""
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


# The MCP servers sit outside the train, so the REST tier's mcp suite runs them at their own heads.
MCP_REPOSITORIES = ('cedar-artifact-rest-mcp', 'cedar-artifact-mcp', 'cedar-cee-mcp', 'bioportal-term-mcp')
MCP_BRANCH = 'main'


def smoke_sources(home, state, settings):
    """Give the smoke tiers the checkouts they read beside the stack they drive.

    The tiers read OpenAPI specifications and test resources from the train's repositories, so each
    is checked out at the commit the train captured. The term picker's response validation needs its
    dependencies installed, and the REST tier's mcp suite runs a jar built from its own repository.
    """
    version = full_stack_ci.guard(home, state)
    source, _ = docker_train.source_manifest(version, state)
    for repository, revision in sorted(source['repositories'].items()):
        if not docker_train.SHA_RE.fullmatch(revision):
            raise ValueError('Invalid captured source: '+repository)
        if not (home/repository).exists():
            docker_train.checkout_one(repository, revision, home)
    docker_train.run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=home/'cedar-embeddable-term-picker')
    for repository in MCP_REPOSITORIES:
        target = home/'mcp'/repository
        if not target.exists():
            docker_train.run(['git', 'clone', '--quiet', '--depth', '1', '--branch', MCP_BRANCH,
                              f'https://github.com/metadatacenter/{repository}.git', str(target)])
    # Maven runs in the MCP checkout, so a settings path relative to the workflow's directory
    # would name a file that does not exist there.
    docker_train.run(['mvn', '-q', '-B', '-s', str(Path(settings).resolve()), 'package', '-DskipTests'],
                     cwd=home/'mcp'/'cedar-artifact-rest-mcp')


def smoke_judge(home):
    """The gate `cedarcli test e2e` records for, from the captured CLI, so both judge one way."""
    sys.path.insert(0, str(home/'cedar-cli'))
    from org.metadatacenter import smoke_gate

    def judge(report, state, version):
        return smoke_gate.train_findings(report, smoke_gate.train_subject(home, state, version))
    return judge


def record(home, state, report_path, smoke_path, judge=None):
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
    smoke_raw = smoke_path.read_bytes(); smoke = json.loads(smoke_raw)
    findings = (judge or smoke_judge(home))(smoke, state, version)
    if findings:
        raise ValueError('The whole-stack smoke does not stand for this train: '+'; '.join(findings))
    run = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    completion['freshStackAcceptance'] = {
        'status':'passed', 'completedAt':report['finishedAt'], 'reportSha256':hashlib.sha256(raw).hexdigest(),
        'run':run,
        'scenarios':sorted(required), 'successfulSamples':len(samples), 'timingsReportingOnly':True,
        'emptyVolumes':True, 'compatibilityMounts':False, 'applicationPages':'deployment-nginx',
        'tooling':deployment['tooling'], 'resourceLimits':deployment['resourceLimits'],
    }
    completion['wholeStackSmoke'] = {
        'status':'passed', 'completedAt':smoke['finishedAt'], 'reportSha256':hashlib.sha256(smoke_raw).hexdigest(),
        'run':run, 'sourcesDigest':smoke['sourcesDigest'], 'durationSeconds':smoke['durationSeconds'],
        'tiers':{tier:result['verdict'] for tier, result in smoke['tiers'].items()},
    }
    docker_train.write_json(path, completion)
    print('Fresh-stack acceptance passed: 17 modern scenarios, 34 cold/warm checks; no executable overlays.')
    print('Whole-stack smoke passed: '+', '.join(sorted(smoke['tiers']))+f" tiers against train {version}.")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['checkout','smoke-sources','record'])
    parser.add_argument('--state',required=True,type=Path)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--smoke-report',type=Path,help='The record cedarcli test e2e --train wrote')
    parser.add_argument('--settings',type=Path,default=Path(__file__).parent/'maven-train-settings.xml')
    args=parser.parse_args(); home=Path(os.environ['CEDAR_HOME'])
    if args.action=='checkout':checkout(home,args.state)
    elif args.action=='smoke-sources':smoke_sources(home,args.state,args.settings)
    elif args.report is None or args.smoke_report is None:
        parser.error('record needs --report and --smoke-report')
    else:record(home,args.state,args.report,args.smoke_report)


if __name__=='__main__':main()
