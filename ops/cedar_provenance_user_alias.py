#!/usr/bin/env python3
"""Prepare a graph-only restoration using verified legacy user URI aliases.

No user account is created or renamed and no Mongo document is changed. The only
supported mapping preserves a UUID from the historical .net user namespace to
the current .org namespace, with exactly one live User carrying that UUID.
"""
import argparse
from collections import Counter
import copy
import hashlib
import json
import os
from pathlib import Path
from uuid import UUID

from cedar_provenance_audit import atomic, now

LEGACY = 'https://repo.metadatacenter.net/users/'
CANONICAL = 'https://metadatacenter.org/users/'
POLICY = 'legacy-user-uri-v1'


def alias_for(original, users):
    if not isinstance(original, str) or not original.startswith(LEGACY):
        raise ValueError('unsupported legacy user namespace')
    suffix = original[len(LEGACY):]
    if str(UUID(suffix)) != suffix:
        raise ValueError('noncanonical user UUID')
    target = CANONICAL + suffix
    if users is None:
        raise ValueError('live user identities required for alias resolution')
    matches = [u for u in users if isinstance(u, str) and u.rsplit('/', 1)[-1] == suffix]
    if matches != [target]:
        raise ValueError('legacy UUID does not have exactly one canonical live user')
    return {'policy': POLICY, 'original': original, 'canonical': target, 'uuid': suffix}


def resolved_modifier(candidate, body, users=None, allow=False):
    original = body.get('oslc:modifiedBy')
    alias = candidate.get('modifierAlias')
    if alias is None: return original
    if not allow:
        raise ValueError('legacy user aliases require explicit opt-in')
    expected = alias_for(original, users)
    if alias != expected:
        raise ValueError('sealed alias disagrees with original provenance or live identity')
    return expected['canonical']


def preflight(stores, plan, repair_user, out):
    from cedar_provenance_apply import documents, pending_lifecycle_ids, prepare
    candidates = [json.loads(line) for line in plan.open()]
    if not candidates or len({c['id'] for c in candidates}) != len(candidates):
        raise ValueError('empty plan or duplicate identities')
    out.mkdir(parents=True, exist_ok=False)
    users = [r[0] for r in stores.query('MATCH (u:User) RETURN u._id')]
    counts = Counter(); kinds = Counter(); reasons = Counter(); identities = set()
    with (out/'ready-candidates.jsonl').open('x') as ready, (out/'held.jsonl').open('x') as held, (out/'preflight.jsonl').open('x') as observations:
        for start in range(0, len(candidates), 100):
            batch = candidates[start:start+100]; ids = [r['id'] for r in batch]
            before = stores.graphs(ids); docs = documents(stores, batch); after = stores.graphs(ids)
            pending = pending_lifecycle_ids(stores, ids)
            for candidate in batch:
                counts['checked'] += 1; identifier = candidate['id']
                try:
                    if identifier in pending: raise ValueError('pending lifecycle job')
                    if before.get(identifier) != after.get(identifier):
                        raise ValueError('graph changed during preflight')
                    if (after.get(identifier) or {}).get('oslc_modifiedBy') != repair_user:
                        raise ValueError('current modifier is not the repair account')
                    current = copy.deepcopy(candidate)
                    current['modifierAlias'] = alias_for(candidate['document']['oslc:modifiedBy'], users)
                    current['preparedAt'] = now()
                    record = prepare(current, docs.get(identifier), after.get(identifier), repair_user,
                        user_ids=users, allow_legacy_user_aliases=True)
                    ready.write(json.dumps(current)+'\n')
                    observations.write(json.dumps(dict(record, modifierAlias=current['modifierAlias'], checkedAt=now()))+'\n')
                    counts['ready'] += 1; kinds[current['kind']] += 1
                    identities.add(current['modifierAlias']['canonical'])
                except (ValueError, KeyError, TypeError) as error:
                    counts['held'] += 1; reasons[str(error)] += 1
                    held.write(json.dumps({'id': identifier, 'kind': candidate['kind'], 'reason': str(error)})+'\n')
    result = {'status': 'PREPARED_NOT_APPLIED', 'readOnly': True, 'preparedAt': now(),
        'policy': POLICY, 'counts': counts, 'byKind': kinds, 'distinctUsers': len(identities),
        'heldReasons': reasons, 'inputSha256': hashlib.sha256(plan.read_bytes()).hexdigest(),
        'readyPlanSha256': hashlib.sha256((out/'ready-candidates.jsonl').read_bytes()).hexdigest(),
        'scope': 'Restore graph modification date and canonical modifier URI only; preserve Mongo, creation metadata, ownership and user accounts.',
        'beforeApply': 'Wait for current verification, take a fresh offline backup with application writers paused; executor repeats content/revision, identity and transaction guards.'}
    atomic(out/'summary.json', result)
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--repair-user', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(); os.umask(0o027)
    from cedar_provenance_store import Stores
    preflight(Stores(), args.plan, args.repair_user, args.out)


if __name__ == '__main__': main()
