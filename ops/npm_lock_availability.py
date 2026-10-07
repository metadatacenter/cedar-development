#!/usr/bin/env python3
"""Check that every tarball a lockfile fetches from CEDAR's Nexus can still be installed.

Nexus removes a prerelease from the train registry three days after upload and a release thirty
days after it, so a lockfile committed long enough ago names tarballs that answer 404, and `npm ci`
stops at the first of them with a bare error. Run before `npm ci`, this names every such tarball
at once. A tarball the local npm cache holds counts as available, because npm installs a locked
tarball from its cache by integrity without asking the registry.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request


NEXUS_REPOSITORIES = "https://nexus.bmir.stanford.edu/repository/"


def nexus_entries(lock: dict) -> list[dict]:
    """The installed packages whose tarball the lockfile resolves from Nexus."""
    entries = []
    for path, record in sorted((lock.get("packages") or {}).items()):
        resolved = record.get("resolved") if isinstance(record, dict) else None
        if not path or not isinstance(resolved, str) or not resolved.startswith(NEXUS_REPOSITORIES):
            continue
        entries.append({
            "path": path,
            "version": record.get("version"),
            "resolved": resolved,
            "integrity": record.get("integrity"),
        })
    return entries


def cached(cache: Path, integrity: str | None) -> bool:
    """Whether npm's content-addressed cache holds bytes with this integrity."""
    for value in (integrity or "").split():
        algorithm, _, encoded = value.partition("-")
        try:
            digest = base64.b64decode(encoded, validate=True).hex()
        except ValueError:
            continue
        if digest and (cache / "_cacache" / "content-v2" / algorithm / digest[:2]
                       / digest[2:4] / digest[4:]).is_file():
            return True
    return False


def published(url: str) -> bool:
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=30):
            return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def npm_cache() -> Path:
    result = subprocess.run(["npm", "config", "get", "cache"], text=True,
                            capture_output=True, check=True)
    return Path(result.stdout.strip())


def missing(lockfile: Path, cache: Path) -> list[dict]:
    lock = json.loads(lockfile.read_text(encoding="utf-8"))
    return [entry for entry in nexus_entries(lock)
            if not cached(cache, entry["integrity"]) and not published(entry["resolved"])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("lockfile", type=Path, nargs="+")
    parser.add_argument("--cache", type=Path, help="npm cache directory (default: npm's own)")
    args = parser.parse_args(argv)
    cache = args.cache or npm_cache()
    absent = []
    for lockfile in args.lockfile:
        absent.extend((lockfile, entry) for entry in missing(lockfile, cache))
    if not absent:
        return 0
    print("npm ci cannot install these locked packages: Nexus no longer serves them, "
          "and the npm cache does not hold them.", file=sys.stderr)
    for lockfile, entry in absent:
        name = entry["path"].rsplit("node_modules/", 1)[-1]
        print(f"  {lockfile}: {name}@{entry['version']} ({entry['resolved']})", file=sys.stderr)
    print("Restore each tarball into this host's npm cache with `npm cache add <file>.tgz`, after "
          "checking that its SHA-512 matches the lockfile's integrity.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
