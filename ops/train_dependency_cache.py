#!/usr/bin/env python3
"""Cache downloaded dependencies, never train outputs or working-tree rewrites."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess


def dependency_key(workspace, kind):
    digest = hashlib.sha256(b'cedar-train-dependencies-v1\0')
    pattern = '*package-lock.json' if kind == 'npm' else '*pom.xml'
    if kind == 'maven':
        digest.update(Path(__file__).with_name('maven-train-settings.xml').read_bytes())
    for repo in sorted(workspace.iterdir()):
        if not (repo / '.git').exists():
            continue
        paths = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z', '--', pattern])
        for name in sorted(paths.decode().split('\0')):
            if not name:
                continue
            # prepare stamps POMs and npm wiring rewrites locks. Cache identities
            # describe the captured inputs, not those disposable modifications.
            content = subprocess.check_output(['git', '-C', str(repo), 'show', f'HEAD:{name}'])
            digest.update(f'{repo.name}/{name}\0'.encode())
            digest.update(content)
            digest.update(b'\0')
    return digest.hexdigest()


def copy_maven_dependencies(source, destination):
    count = 0
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if relative.parts[:2] == ('org', 'metadatacenter'):
            continue
        if not path.is_file() or path.is_symlink() or path.name.endswith('.lastUpdated'):
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    key = commands.add_parser('key')
    key.add_argument('--workspace', type=Path, required=True)
    key.add_argument('--kind', choices=['npm', 'maven'], required=True)
    copy = commands.add_parser('copy-maven')
    copy.add_argument('--source', type=Path, required=True)
    copy.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'key':
        print(dependency_key(args.workspace, args.kind))
    else:
        print(f'Copied {copy_maven_dependencies(args.source, args.destination)} third-party dependency files')


if __name__ == '__main__':
    main()
