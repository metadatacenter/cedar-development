#!/usr/bin/env python3
"""Exercise deployment commands on copies of the train's assembled static payloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


REPOSITORIES = ('cedar-openview', 'cedar-bridging', 'cedar-monitoring')
DOMAIN = 'train-configuration.example.invalid'
COMPILED_DOMAIN = re.compile(rb'cedarDomain:"[^"]*"')


def snapshot(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Payload contains a symlink: {path}')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = (path.read_bytes(), path.stat().st_mode & 0o777)
    if not result:
        raise RuntimeError(f'Empty or missing built payload: {root}')
    return result


def run_cli(cli, python, home, command):
    # No host profile or credentials are needed: this temporary estate has no mode selected.
    # Run the captured entry point, including command dispatch and real git restore, unmocked.
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('CEDAR_', 'GIT_'))}
    environment.update(CEDAR_HOME=str(home), CEDAR_HOST=DOMAIN)
    subprocess.run([str(python), str(cli / 'cedar.py'), 'prod', command],
                   cwd=home, env=environment, check=True)


def verify_configuration(before, after, repository):
    if before.keys() != after.keys():
        raise RuntimeError(f'{repository}: configuration added or removed payload files')
    changed = [name for name in before if before[name] != after[name]]
    if len(changed) != 1 or not changed[0].endswith('.js'):
        raise RuntimeError(f'{repository}: expected exactly one changed JavaScript module, got {changed}')
    name = changed[0]
    original, mode = before[name]
    expected, count = COMPILED_DOMAIN.subn(f'cedarDomain:"{DOMAIN}"'.encode(), original)
    if count != 1 or after[name] != (expected, mode):
        raise RuntimeError(f'{repository}: configuration changed more than the compiled hostname')
    return name


def check_payloads(workspace, python=sys.executable, cli=None):
    workspace = Path(workspace).resolve()
    cli = Path(cli or workspace / 'cedar-cli').resolve()
    if not (cli / 'cedar.py').is_file():
        raise RuntimeError(f'Captured CLI is missing: {cli}')
    originals, configured, receipt = {}, {}, {}
    with tempfile.TemporaryDirectory(prefix='cedar-frontend-configuration-') as directory:
        home = Path(directory)
        for repository in REPOSITORIES:
            source = workspace / repository / f'{repository}-dist'
            originals[repository] = snapshot(source)
            root = home / repository
            target = root / source.name
            shutil.copytree(source, target)
            if snapshot(target) != originals[repository]:
                raise RuntimeError(f'{repository}: copied payload differs from built payload')
            # The train's fresh output is not committed in its source checkout. Give reset a
            # private baseline containing these exact bytes, never the checkout's old dist.
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '--', source.name], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Train payload check',
                            '-c', 'user.email=train@example.invalid', '-c', 'commit.gpgsign=false',
                            '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Built payload'],
                           check=True)

        run_cli(cli, python, home, 'configure-frontends')
        for repository in REPOSITORIES:
            configured[repository] = snapshot(home / repository / f'{repository}-dist')
            module = verify_configuration(originals[repository], configured[repository], repository)
            receipt[repository] = {
                'configurationModule': module,
                'files': {name: hashlib.sha256(data).hexdigest()
                          for name, (data, _) in originals[repository].items()},
            }
        run_cli(cli, python, home, 'configure-frontends')
        for repository in REPOSITORIES:
            if snapshot(home / repository / f'{repository}-dist') != configured[repository]:
                raise RuntimeError(f'{repository}: repeated configuration is not idempotent')
        run_cli(cli, python, home, 'reset-frontends')
        for repository in REPOSITORIES:
            if snapshot(home / repository / f'{repository}-dist') != originals[repository]:
                raise RuntimeError(f'{repository}: reset did not restore the exact built payload')
            if snapshot(workspace / repository / f'{repository}-dist') != originals[repository]:
                raise RuntimeError(f'{repository}: original train payload changed during verification')
    print('Frontend configuration gate passed: hostname-only changes, idempotent configuration, byte-exact reset.')
    return {'domain': DOMAIN, 'payloads': receipt}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    result = check_payloads(args.workspace)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
