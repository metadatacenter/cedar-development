#!/usr/bin/env python3
"""Prepare a graph-only restoration using verified legacy user URI aliases.

No user account is created or renamed and no Mongo document is changed. The only
supported mapping preserves a UUID from the historical .net user namespace to
the current .org namespace, with exactly one live User carrying that UUID.

A verbatim write copies the document's modifier into the graph, so a document that names its
modifier in the legacy form leaves that form on the graph too. Such a candidate keeps its dates:
only the graph's modifier changes, and only while the graph still names the document's own
modifier on the document's own date.
"""
import argparse
from collections import Counter
import copy
import hashlib
import json
import os
from pathlib import Path
from uuid import UUID

from cedar_provenance_audit import atomic, normalized, now

LEGACY = 'https://repo.metadatacenter.net/users/'
CANONICAL = 'https://metadatacenter.org/users/'
POLICY = 'legacy-user-uri-v1'
LEGACY_GRAPH_CLASSIFICATION = 'eligible-legacy-graph-modifier'


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


def stored_graph(graph):
    """The graph node's modification provenance under the audit's property names."""
    return {'oslc:modifiedBy': graph.get('oslc_modifiedBy'), 'pav:lastUpdatedOn': graph.get('pav_lastUpdatedOn'),
            'lastUpdatedOnTS': graph.get('lastUpdatedOnTS')}


def legacy_graph_modifier(document, graph):
    """Refuse unless the graph names the document's own legacy modifier on the document's own date."""
    modifier = document.get('oslc:modifiedBy')
    if graph.get('oslc:modifiedBy') != modifier:
        raise ValueError('graph modifier is not the document modifier')
    if not isinstance(modifier, str) or not modifier.startswith(LEGACY):
        raise ValueError('modifier is not in the legacy user form')
    instant = normalized('pav:lastUpdatedOn', document.get('pav:lastUpdatedOn'))
    if not isinstance(instant, tuple) or normalized('pav:lastUpdatedOn', graph.get('pav:lastUpdatedOn')) != instant:
        raise ValueError('graph modification date differs from the document')
    stamp = graph.get('lastUpdatedOnTS')
    if type(stamp) is not int or stamp != instant[1]:
        raise ValueError('graph numeric timestamp differs from the document')


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
    with plan.open() as stream:
        candidates = [json.loads(line) for line in stream]
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
                    graph = after.get(identifier) or {}
                    if candidate.get('classification') == LEGACY_GRAPH_CLASSIFICATION:
                        legacy_graph_modifier(candidate['document'], stored_graph(graph))
                    elif graph.get('oslc_modifiedBy') != repair_user:
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
        'scope': 'Restore graph modification date and canonical modifier URI only, or the canonical modifier URI alone for a legacy graph modifier; preserve Mongo, creation metadata, ownership and user accounts.',
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
