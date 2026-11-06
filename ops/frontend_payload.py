#!/usr/bin/env python3
"""Budget built page assets, including copied components outside Angular's graph."""
import argparse
import gzip
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit


class EntryPage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == 'script' and attributes.get('src'):
            self.assets.append(attributes['src'])
        if tag == 'link' and attributes.get('rel') in ('stylesheet', 'modulepreload'):
            self.assets.append(attributes['href'])


def measure(root, specification, working_root=None):
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f'Build output is missing: {root}')
    assets = {}
    mounts = {'': root}
    for prefix, directory in specification.get('extraRoots', {}).items():
        mounts[prefix + '/'] = (Path(working_root) / directory).resolve()
    for prefix, directory in mounts.items():
        if not directory.is_dir():
            raise ValueError(f'Asset directory is missing: {directory}')
        for file in sorted(directory.rglob('*')):
            if not file.is_file() or file.suffix not in ('.js', '.mjs', '.css'):
                continue
            if not file.resolve().is_relative_to(directory):
                raise ValueError(f'Asset escapes build output: {file}')
            body = file.read_bytes()
            assets[prefix + file.relative_to(directory).as_posix()] = {
                'raw': len(body), 'gzip': len(gzip.compress(body, compresslevel=9, mtime=0)),
                'sha256': hashlib.sha256(body).hexdigest(),
            }
    if not assets:
        raise ValueError(f'No JavaScript or CSS in {root}')
    page = EntryPage()
    page.feed((root / 'index.html').read_text())
    stats = json.loads((root / 'browser-stats.json').read_text())
    initial = set()
    pending = list(page.assets)
    while pending:
        address = urlsplit(pending.pop())
        if address.scheme or address.netloc:
            raise ValueError(f'Unmeasured external page asset: {address.geturl()}')
        name = unquote(address.path)
        prefix = specification.get('urlPrefix', '/')
        if name.startswith(prefix):
            name = name[len(prefix):]
        name = name.removeprefix('/').removeprefix('./')
        if name not in assets:
            raise ValueError(f'Page references an unmeasured or missing asset: {name}')
        if name in initial:
            continue
        initial.add(name)
        for dependency in stats.get('outputs', {}).get(name, {}).get('imports', []):
            if dependency['kind'] in ('import-statement', 'import-rule'):
                pending.append(dependency['path'])
    if not initial:
        raise ValueError('Entry page has no measured assets')
    groups = {'initial': initial, 'total': set(assets)}
    sizes = {group: {kind: sum(assets[name][kind] for name in names) for kind in ('raw', 'gzip')}
             for group, names in groups.items()}
    failures = [f'{group} {kind}: {size:,} > {specification[group][kind]:,}'
                for group, values in sizes.items() for kind, size in values.items()
                if size > specification[group][kind]]
    return {'sizes': sizes, 'failures': failures,
            'assets': {name: {**data, 'initial': name in initial} for name, data in assets.items()}}


def check(surface, working_root, report=None):
    config = json.loads((Path(__file__).with_name('frontend-train.json')).read_text())
    row = next((row for row in config['surfaces'] if row['id'] == surface), None)
    if row is None or 'payloadBudget' not in row:
        raise ValueError(f'No page payload budget for {surface}')
    spec = row['payloadBudget']
    result = measure(Path(working_root) / spec['directory'], spec, working_root)
    for group, sizes in result['sizes'].items():
        print(f"{surface} {group}: {sizes['raw']:,} raw / {sizes['gzip']:,} gzip-9 bytes")
    for failure in result['failures']:
        print('FAIL ' + failure)
    if report:
        Path(report).write_text(json.dumps(result, indent=2) + '\n')
    return not result['failures']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--surface')
    parser.add_argument('--root', type=Path)
    parser.add_argument('--report')
    args = parser.parse_args()
    if args.root and not args.surface:
        parser.error('--root needs --surface')
    if args.report and not args.surface:
        parser.error('--report needs --surface')
    config = json.loads(Path(__file__).with_name('frontend-train.json').read_text())
    rows = [row for row in config['surfaces'] if 'payloadBudget' in row
            and (not args.surface or row['id'] == args.surface)]
    if not rows:
        parser.error('No matching page payload budget')
    home = Path(os.environ.get('CEDAR_HOME', '.'))
    if args.root is None and 'CEDAR_HOME' not in os.environ:
        parser.error('CEDAR_HOME is required unless --root names an isolated build')
    passed = True
    for row in rows:
        try:
            passed = check(row['id'], args.root or home / row['repository'] / row['directory'], args.report) and passed
        except (ValueError, OSError, KeyError) as error:
            print(f"FAIL {row['id']}: {error}")
            passed = False
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
