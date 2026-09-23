"""Shared frontend build and verification recipes, beside the dependency inventory."""
import json
from pathlib import Path, PurePosixPath


def surfaces(config):
    rows = config.get('surfaces')
    if not isinstance(rows, list) or not rows:
        raise ValueError('frontend inventory has no surfaces; every frontend needs verification or an explicit exemption')
    seen = set()
    names = set()
    for row in rows:
        key = (row.get('repository'), row.get('directory'))
        if not all(isinstance(value, str) and value for value in key) or key in seen:
            raise ValueError(f'duplicate or invalid frontend surface: {key}')
        for value in key:
            if PurePosixPath(value).is_absolute() or '..' in PurePosixPath(value).parts:
                raise ValueError(f'unsafe frontend surface: {key}')
        seen.add(key)
        name = row.get('reactorName')
        if not isinstance(name, str) or not name or name in names:
            raise ValueError(f'duplicate or missing reactor identity: {name}')
        names.add(name)
        if not row.get('verify') and not str(row.get('verificationExemption', '')).strip():
            raise ValueError(f'frontend {key} has neither verification nor an exemption')
        for field in ('setup', 'verify'):
            commands = row.get(field)
            if not isinstance(commands, list) or any(
                not isinstance(command, list) or not command or
                any(not isinstance(arg, str) or not arg for arg in command)
                for command in commands
            ):
                raise ValueError(f'invalid {field} commands for frontend {key}')
    return rows


def validate(config):
    rows = surfaces(config)
    known = {(r['repository'], directory) for r in rows
             for directory in [r['directory'], *r.get('packageDirectories', [])]}
    required = set()
    for item in [config.get('model', {}), config.get('cee', {}), *config.get('components', [])]:
        if item.get('repository'):
            required.add((item['repository'], str(PurePosixPath(item.get('sourceManifest', 'package.json')).parent)))
        for consumer in item.get('consumers', []):
            required.add((consumer['repository'], str(PurePosixPath(consumer['manifest']).parent)))
    for item in config.get('frontends', []):
        directory = item.get('preparedBuild', {}).get('directory', item.get('packagePath', '.'))
        required.add((item['repository'], directory))
        consumer = item.get('ceeConsumer')
        if consumer:
            required.add((item['repository'], str(PurePosixPath(consumer['manifest']).parent)))
    for item in config.get('additionalCeeConsumers', []):
        required.add((item['repository'], str(PurePosixPath(item['manifest']).parent)))
    missing = required - known
    if missing:
        raise ValueError('frontend verification coverage missing: ' + ', '.join(f'{r}/{d}' for r,d in sorted(missing)))
    return rows


def load(path):
    config = json.loads(Path(path).read_text())
    validate(config)
    return config


def commands(config, repository, directory='.'):
    row = next((r for r in surfaces(config) if (r['repository'], r['directory']) == (repository, directory)), None)
    if row is None:
        raise ValueError(f'frontend verification coverage missing: {repository}/{directory}')
    return row['setup'] + row['verify']
