#!/usr/bin/env python3
"""Transfer one train candidate between isolated gates; publish only complete evidence."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile

import frontend_inventory
import frontend_train as train

CEE = 'cedar-embeddable-editor'
CED = 'cedar-embeddable-designer'
WORKSPACE = 'cedar-workspace'
SHARDS = 4
EXCLUDED = {'.git', 'node_modules', '.angular', 'coverage', 'test-results',
            'test-results-container', 'playwright-report', 'blob-report', '__pycache__'}


def context(args):
    plan = train.load_json(args.state / 'npm/trains' / f'{args.version}.json')
    source, content = train.source_manifest(args.state, args.version)
    if plan['sourceManifestSha256'] != train.sha256_bytes(content):
        raise RuntimeError('Candidate plan and source disagree')
    return plan, source, train.load_json(args.config)


def identity(args, plan):
    # Frontend preparation is appended later; the immutable dependency graph is the input.
    inputs = {k: v for k, v in plan.items() if k != 'frontendPreparation'}
    return {'version': args.version, 'planSha256': train.sha256_bytes(train.canonical_bytes(inputs)),
            'configSha256': train.path_sha256(args.config)}


def archive_candidate(args, plan, repository, data):
    args.artifact.mkdir(parents=True, exist_ok=True)
    root = args.workspace / repository
    archive = args.artifact / 'candidate.tar.gz'
    def include(member):
        if any(part in EXCLUDED for part in Path(member.name).parts):
            return None
        if member.issym() or member.islnk():
            # Outputs must be portable; never transfer links into another checkout.
            raise RuntimeError(f'Candidate contains a link: {member.name}')
        return member
    with tarfile.open(archive, 'w:gz') as output:
        output.add(root, arcname=repository, filter=include)
    receipt = {**identity(args, plan), 'repository': repository,
               'archiveSha256': train.path_sha256(archive), 'data': data}
    train.write_json(args.artifact / 'candidate.json', receipt)
    return receipt


def restore(args, plan, repository):
    receipt = train.load_json(args.artifact / 'candidate.json')
    if any(receipt.get(k) != v for k, v in identity(args, plan).items()) or receipt.get('repository') != repository:
        raise RuntimeError('Candidate belongs to different train inputs')
    archive = args.artifact / 'candidate.tar.gz'
    if train.path_sha256(archive) != receipt['archiveSha256']:
        raise RuntimeError('Candidate archive checksum mismatch')
    source, _ = train.source_manifest(args.state, args.version)
    train.repository_root(args.workspace, source, repository)
    with tarfile.open(archive) as stream:
        for member in stream.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] != repository or '..' in parts or any(p in EXCLUDED for p in parts) or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe candidate archive member')
        stream.extractall(args.workspace, filter='data')
    return receipt


def test_inventory(report):
    found = []
    def walk(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                for test in spec['tests']:
                    found.append((spec['id'] + ':' + test['projectName'], test))
            walk(suite.get('suites', []))
    if report.get('errors'):
        raise RuntimeError('Playwright reported errors')
    walk(report['suites'])
    if not found or len({key for key, _ in found}) != len(found):
        raise RuntimeError('Empty or duplicate Playwright inventory')
    return dict(found)


def inventory(root, environment, directory, extra=()):
    result = subprocess.run(['node', 'node_modules/playwright/cli.js', 'test', '--list',
                             '--reporter=json', *extra], cwd=root / directory,
                            env=environment, check=True, capture_output=True, text=True)
    return sorted(test_inventory(json.loads(result.stdout)))


def environment(args, plan, repository):
    config = train.load_json(args.config)
    env = train.verification_environment(config, plan, repository, args.workspace)
    env.update(CI='1', CEDAR_TEST_WORKERS=str(args.workers),
               VITEST_MAX_WORKERS=str(args.workers), NG_BUILD_MAX_WORKERS=str(args.workers))
    return env


def prepare_ced(args):
    plan, source, config = context(args)
    component = next(c for c in plan['components'] if c['repository'] == CED)
    root, revision = train.repository_root(args.workspace, source, CED)
    if revision != component['revision']:
        raise RuntimeError('CED source and plan disagree')
    train.assert_clean_repository(root, CED)
    train.stamp_package_version(root, component['version'])
    train.wire_components(args, plan, CED)
    train.wire_model(args, plan, CED, config)
    env = environment(args, plan, CED)
    commands = frontend_inventory.commands(config, CED)
    if commands.count(['npm', 'run', 'test:ci']) != 1:
        raise RuntimeError('CED gate recipe changed; update distributed coverage')
    for command in commands:
        train.run_command(['node', 'scripts/test-gate.mjs', 'prepare']
                          if command == ['npm', 'run', 'test:ci'] else command, root, env)
    package = root / component['stagedPackage']
    built = train.load_json(package / 'package.json')
    if (built['name'], built['version']) != (component['name'], component['version']):
        raise RuntimeError('CED candidate has wrong identity')
    browser = inventory(root, {**env, 'CED_WEBKIT': '1'}, 'browser')
    visual = inventory(root, {**env, 'CED_VISUAL': '1'}, 'browser', ['visual.spec.ts'])
    archive_candidate(args, plan, CED, {'packageSha256': train.path_sha256(package),
        'packagePath': component['stagedPackage'], 'browser': browser, 'visual': visual})


def check_ced(args):
    plan, _, _ = context(args)
    receipt = restore(args, plan, CED)
    root = args.workspace / CED
    env = environment(args, plan, CED)
    train.run_command(['npm', 'ci'], root, env)
    train.run_command(['npm', '--prefix', 'browser', 'ci'], root, env)
    report = root / 'browser' / 'train-report.json'
    report.unlink(missing_ok=True)
    if args.lane == 'visual':
        # The original ARM64 container and baseline selection are unchanged.
        command = ['bash', 'browser/run-in-container.sh', 'visual']
        report_config(root / 'browser', 'train-report.json')
        command += ['--config=train-report.config.cjs']
        expected = receipt['data']['visual']
    else:
        shard = int(args.lane)
        if not 1 <= shard <= SHARDS:
            raise ValueError('Invalid CED shard')
        env['CED_WEBKIT'] = '1'
        train.run_command(['./browser/node_modules/.bin/playwright', 'install', '--with-deps',
                           'chromium', 'webkit'], root, env)
        expected = inventory(root, env, 'browser', [f'--shard={shard}/{SHARDS}'])
        report_config(root / 'browser', 'train-report.json')
        command = ['npm', 'run', 'test:browser:prebuilt', '--', f'--shard={shard}/{SHARDS}',
                   '--config=train-report.config.cjs']
    train.run_command(command, root, env)
    completed = test_inventory(train.load_json(report))
    if sorted(completed) != expected or any(t.get('status') not in {'expected', 'skipped', 'flaky'} for t in completed.values()):
        raise RuntimeError('Shard did not complete its entire test inventory')
    if train.path_sha256(root / receipt['data']['packagePath']) != receipt['data']['packageSha256']:
        raise RuntimeError('Tests changed the candidate package')
    train.write_json(args.results / f'ced-{args.lane}.json', {
        **identity(args, plan), 'archiveSha256': receipt['archiveSha256'],
        'lane': args.lane, 'tests': expected})


def report_config(directory, output):
    # Playwright loads TypeScript config through its own loader, including in the container.
    (directory / 'train-report.config.cjs').write_text(
        "const base = require('./playwright.config.ts').default;\n"
        "module.exports = {...base, reporter: [['line'], ['json', {outputFile: "
        + json.dumps(output) + "}]]};\n")


def require_results(args, plan, receipt, prefix='ced', lanes=None):
    lanes = lanes or [str(i) for i in range(1, SHARDS + 1)] + ['visual']
    covered = {'browser': [], 'visual': []}
    for lane in lanes:
        result = train.load_json(args.results / f'{prefix}-{lane}.json')
        if any(result.get(k) != v for k, v in identity(args, plan).items()) or result.get('archiveSha256') != receipt['archiveSha256'] or result.get('lane') != lane:
            raise RuntimeError('Shard evidence belongs to different candidate inputs')
        covered['visual' if lane == 'visual' else 'browser'] += result['tests']
    for group, tests in covered.items():
        if sorted(tests) != receipt['data'][group]:
            raise RuntimeError(f'Missing or duplicate {group} test coverage')


def verify_published_candidate(plan, expected, package):
    verified = train.verify_record(plan['registry'], expected)
    content = train.fetch(verified['tarball'])
    if train.sha256_bytes(content) != verified['tarballSha256']:
        raise RuntimeError('Published tarball changed after verification')
    with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as archive:
        actual = {m.name.removeprefix('package/'): archive.extractfile(m).read()
                  for m in archive.getmembers() if m.isfile()}
    local = {p.relative_to(package).as_posix(): p.read_bytes()
             for p in package.rglob('*') if p.is_file()}
    # npm always omits package-lock.json (npm-shrinkwrap.json is shipped instead).
    local.pop('package-lock.json', None)
    # npm normalizes package.json; its published identity is checked by verify_record.
    # Compare its semantic fields as well as every other shipped byte.
    actual_manifest = json.loads(actual.pop('package.json'))
    local_manifest = json.loads(local.pop('package.json'))
    if actual != local or any(actual_manifest.get(k) != v for k, v in local_manifest.items()):
        raise RuntimeError('Published package differs from the tested candidate')
    return verified


def publish_ced(args):
    plan, _, _ = context(args)
    receipt = restore(args, plan, CED)
    require_results(args, plan, receipt)
    component = next(c for c in plan['components'] if c['repository'] == CED)
    package = args.workspace / CED / receipt['data']['packagePath']
    if train.path_sha256(package) != receipt['data']['packageSha256']:
        raise RuntimeError('CED package checksum mismatch')
    if not train.existing_verified_package(plan['registry'], component):
        train.run_command(['npm', 'publish', str(package), '--tag', 'dev', '--registry', plan['registry']], args.workspace / CED)
    verified = verify_published_candidate(plan, component, package)
    train.record_library_completion(args.state, 'ced', plan, component, verified)


def prepare_cee(args):
    plan, source, config = context(args)
    expected = plan['cee']
    train.verify_record(plan['registry'], plan['model'])
    root, revision = train.repository_root(args.workspace, source, CEE)
    if revision != expected['revision']:
        raise RuntimeError('CEE source and plan disagree')
    train.assert_clean_repository(root, CEE)
    train.stamp_package_version(root, expected['version'])
    train.wire_components(args, plan, CEE)
    dependency = config['cee']['modelDependency']
    for consumer in expected['modelConsumers']:
        train.install_exact_alias((root / consumer['manifest']).parent, dependency,
            plan['model']['name'], plan['model']['version'], consumer.get('legacyPeerDeps', False))
        train.require_exact_alias(root / consumer['manifest'], root / consumer['lock'],
            dependency, plan['model']['name'], plan['model']['version'])
    env = environment(args, plan, CEE)
    commands = frontend_inventory.commands(config, CEE)
    if commands.count(['npm', 'run', 'test:ci:prebuilt']) != 1:
        raise RuntimeError('CEE gate recipe changed; update distributed coverage')
    for command in commands:
        train.run_command(['npm', 'run', 'test:ci:nonvisual:prebuilt']
            if command == ['npm', 'run', 'test:ci:prebuilt'] else command, root, env)
    train.run_command(['npm', 'run', 'audit:prod'], root, env)
    train.run_command(['npm', '--prefix', 'visual', 'run', 'fixtures'], root, env)
    package_path = 'dist-npm/cedar-embeddable-editor'
    package = root / package_path
    built = train.load_json(package / 'package.json')
    if (built['name'], built['version']) != (expected['name'], expected['version']):
        raise RuntimeError('CEE candidate has wrong identity')
    archive_candidate(args, plan, CEE, {'packageSha256': train.path_sha256(package),
        'packagePath': package_path, 'publicSha256': train.path_sha256(root / 'visual/public'),
        'browser': inventory(root, env, 'visual'), 'visual': []})


def check_cee(args):
    plan, _, _ = context(args)
    receipt = restore(args, plan, CEE)
    root = args.workspace / CEE
    env = environment(args, plan, CEE)
    shard = int(args.lane)
    if not 1 <= shard <= SHARDS:
        raise ValueError('Invalid CEE shard')
    train.run_command(['npm', 'ci'], root, env)
    train.run_command(['npm', '--prefix', 'visual', 'ci'], root, env)
    expected = inventory(root, env, 'visual', [f'--shard={shard}/{SHARDS}'])
    report_config(root / 'visual', 'train-report.json')
    report = root / 'visual/train-report.json'
    report.unlink(missing_ok=True)
    train.run_command(['bash', 'visual/run-in-container.sh', '--prebuilt',
        f'--shard={shard}/{SHARDS}', '--config=train-report.config.cjs'], root, env)
    completed = test_inventory(train.load_json(report))
    if sorted(completed) != expected or any(t.get('status') not in {'expected', 'skipped', 'flaky'} for t in completed.values()):
        raise RuntimeError('CEE shard did not complete its entire test inventory')
    if (train.path_sha256(root / receipt['data']['packagePath']) != receipt['data']['packageSha256']
            or train.path_sha256(root / 'visual/public') != receipt['data']['publicSha256']):
        raise RuntimeError('Tests changed the CEE candidate')
    train.write_json(args.results / f'cee-{args.lane}.json', {
        **identity(args, plan), 'archiveSha256': receipt['archiveSha256'],
        'lane': args.lane, 'tests': expected})


def publish_cee(args):
    plan, _, _ = context(args)
    receipt = restore(args, plan, CEE)
    require_results(args, plan, receipt, prefix='cee', lanes=[str(i) for i in range(1, SHARDS + 1)])
    expected = plan['cee']
    package = args.workspace / CEE / receipt['data']['packagePath']
    if train.path_sha256(package) != receipt['data']['packageSha256']:
        raise RuntimeError('CEE package checksum mismatch')
    if not train.existing_verified_package(plan['registry'], expected):
        train.run_command(['npm', 'publish', str(package), '--tag', 'dev', '--registry', plan['registry']], args.workspace / CEE)
    verified = verify_published_candidate(plan, expected, package)
    train.record_library_completion(args.state, 'cee', plan, expected, verified)


def prepare_workspace(args):
    plan, _, config = context(args)
    result = train.prepare_repository(args, plan, config, WORKSPACE)
    archive_candidate(args, plan, WORKSPACE, {'result': result})


def restore_workspace(args, plan):
    local = argparse.Namespace(**vars(args))
    local.artifact = args.verified_workspace
    receipt = restore(local, plan, WORKSPACE)
    return receipt['data']['result']


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['prepare-ced', 'check-ced', 'publish-ced', 'prepare-workspace',
                                       'prepare-cee', 'check-cee', 'publish-cee'])
    p.add_argument('--version', required=True)
    p.add_argument('--workspace', type=Path, required=True)
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--artifact', type=Path, required=True)
    p.add_argument('--results', type=Path)
    p.add_argument('--lane')
    p.add_argument('--workers', type=int, default=4, choices=range(1, 17))
    p.add_argument('--config', type=Path, default=train.DEFAULT_CONFIG)
    return p


if __name__ == '__main__':
    args = parser().parse_args()
    globals()[args.command.replace('-', '_')](args)
