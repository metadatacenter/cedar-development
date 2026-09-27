#!/usr/bin/env python3
"""Publish already-committed train evidence, reconciling independent job updates.

Never force-push or resolve conflicts automatically: colliding immutable evidence
must fail. Only independent paths can be rebased and retried.
"""
import argparse
from pathlib import Path
import subprocess
import time


def push(state: Path, attempts=5):
    for attempt in range(attempts):
        result = subprocess.run(['git', 'push', 'origin', 'HEAD:build-trains'], cwd=state)
        if result.returncode == 0:
            return
        if attempt + 1 == attempts:
            raise RuntimeError('Cannot publish train evidence after bounded retries')
        subprocess.run(['git', 'fetch', 'origin', 'build-trains'], cwd=state, check=True)
        subprocess.run(['git', 'rebase', 'FETCH_HEAD'], cwd=state, check=True)
        time.sleep(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    push(parser.parse_args().state)
