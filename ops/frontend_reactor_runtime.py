"""Verify a development frontend against its installed immutable reactor artifact."""
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tarfile


def current(cedar_home: Path, frontend: Path) -> bool:
    """Accept reactor installs only when provenance, artifact and served bytes all agree."""
    try:
        store = cedar_home / '.reactor'
        digest = json.loads((store / 'runtime.json').read_text())['packages']['cedar-embeddable-editor']
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            return False
        artifact = (store / 'artifacts' / (digest + '.tgz')).resolve()
        entry = json.loads((frontend / 'node_modules/.package-lock.json').read_text())['packages']['node_modules/cedar-embeddable-editor']
        resolved = entry.get('resolved', '')
        if not resolved.startswith('file:') or (frontend / resolved[5:]).resolve() != artifact:
            return False
        if hashlib.sha256(artifact.read_bytes()).hexdigest() != digest:
            return False
        with tarfile.open(artifact) as archive:
            expected = archive.extractfile('package/cedar-embeddable-editor.js').read()
        installed = frontend / 'node_modules/cedar-embeddable-editor/cedar-embeddable-editor.js'
        served = frontend / 'app/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js'
        return installed.read_bytes() == expected == served.read_bytes()
    except (OSError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError):
        return False


def sync(cedar_home: Path, frontend: Path, *, verify_only=False) -> None:
    """Install successful reactor outputs without changing tracked manifests or locks."""
    runtime = cedar_home / '.reactor/runtime.json'
    if not runtime.is_file():
        return
    selected = json.loads(runtime.read_text())['packages']
    manifest = json.loads((frontend / 'package.json').read_text())
    lock_path = frontend / 'node_modules/.package-lock.json'
    installed = json.loads(lock_path.read_text()).get('packages', {}) if lock_path.is_file() else {}
    specs = []
    needs_install = False
    for section in ['dependencies', 'devDependencies', 'optionalDependencies']:
        for name in manifest.get(section, {}):
            digest = selected.get(name.rsplit('/', 1)[-1])
            if digest is None:
                continue
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
                raise ValueError('Invalid reactor artifact digest')
            artifact = (cedar_home / '.reactor/artifacts' / (digest + '.tgz')).resolve()
            if hashlib.sha256(artifact.read_bytes()).hexdigest() != digest:
                raise ValueError('Reactor artifact hash mismatch: ' + name)
            specs.append(name + '@file:' + str(artifact))
            resolved = installed.get('node_modules/' + name, {}).get('resolved', '')
            matches = resolved.startswith('file:') and (frontend / resolved[5:]).resolve() == artifact
            with tarfile.open(artifact) as archive:
                for member in archive.getmembers():
                    if not member.isfile():
                        continue
                    relative = Path(member.name)
                    if relative.parts[0] != 'package' or '..' in relative.parts:
                        raise ValueError('Invalid reactor package member')
                    local = frontend / 'node_modules' / name / Path(*relative.parts[1:])
                    if not local.is_file() or local.read_bytes() != archive.extractfile(member).read():
                        matches = False
            needs_install |= not matches
    if specs and needs_install:
        if verify_only:
            raise ValueError('Installed components differ from reactor selection: ' + str(frontend))
        print('Installing local reactor components for ' + str(frontend), flush=True)
        subprocess.run(['npm', 'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', *specs], cwd=frontend, check=True)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] in ('sync', 'verify'):
        sync(Path(sys.argv[2]), Path(sys.argv[3]), verify_only=sys.argv[1] == 'verify')
    else:
        sys.exit(0 if current(Path(sys.argv[1]), Path(sys.argv[2])) else 1)
