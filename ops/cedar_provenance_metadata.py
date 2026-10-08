#!/usr/bin/env python3
"""Prepare metadata-evidence restoration candidates without modifying production.

Historical document equality is not required. The current modifier must be the specified
repair account, its date must match that artifact's verified repair event, and current
document provenance must match the retained preimage. A fresh content hash/revision is
still captured to refuse changes between preparation and an eventual approved apply.
"""
import argparse
from collections import Counter
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time

from cedar_provenance_audit import atomic, digest, metadata, now
from cedar_provenance_plan import epoch, mod

CLASSIFICATION = 'eligible-repair-metadata'
POLICY = 'repair-metadata-v1'
WINDOW_SECONDS = 120


def validate_metadata_evidence(candidate, document, graph, repair_user):
    proof = candidate.get('metadataEvidence') or {}
    if (not repair_user or candidate.get('repairActor') != repair_user
            or graph.get('oslc:modifiedBy') != repair_user):
        raise ValueError('current modifier is not the specified repair account')
    if (proof.get('policy') != POLICY or proof.get('artifactId') != candidate['id']
            or proof.get('repairActor') != repair_user or proof.get('verifiedRepair') is not True
            or proof.get('windowSeconds') != WINDOW_SECONDS):
        raise ValueError('missing or inconsistent artifact-specific repair proof')
    if any(not re.fullmatch('[0-9a-f]{64}', proof.get(key, ''))
           for key in ('recordSha256', 'preimageSha256')):
        raise ValueError('missing retained evidence fingerprints')
    written = proof.get('writeEpoch')
    stamp = epoch(graph.get('pav:lastUpdatedOn'))
    if (type(written) not in (float, int) or not math.isfinite(written) or stamp is None
            or not int(written) <= stamp <= written + WINDOW_SECONDS):
        raise ValueError('graph modification is outside this artifact repair window')
    if graph.get('lastUpdatedOnTS') != int(stamp):
        raise ValueError('graph date and numeric timestamp disagree')
    original = mod(document)
    target = epoch(original.get('pav:lastUpdatedOn'))
    if (target is None or target > stamp or not original.get('oslc:modifiedBy')
            or original != proof.get('beforeModification')
            or original != (candidate.get('evidence') or {}).get('beforeModification')):
        raise ValueError('current original provenance does not match the retained preimage')


def verified_record_index(path):
    raw = path.read_bytes()
    events = set()
    for line in raw.splitlines():
        row = json.loads(line)
        if row.get('outcome') != 'repaired' or row.get('verified') is not True: continue
        preimage = Path(row.get('preimage', ''))
        if not preimage.is_absolute(): preimage = path.parent / preimage
        events.add((row.get('artifactId'), epoch(row.get('at')), str(preimage.resolve())))
    return hashlib.sha256(raw).hexdigest(), events


def proposal(row, repair_user, record_cache):
    evidence = row['evidence']
    record_path = Path(evidence['record'])
    if record_path not in record_cache:
        record_cache[record_path] = verified_record_index(record_path)
    record_hash, events = record_cache[record_path]
    preimage = Path(evidence['preimage']).resolve()
    if (row['id'], evidence.get('writeEpoch'), str(preimage)) not in events:
        raise ValueError('artifact has no matching verified event in the retained repair log')
    raw = preimage.read_bytes()
    saved = json.loads(raw)['artifact']
    if saved.get('@id') != row['id']:
        raise ValueError('preimage identity differs')
    candidate = copy.deepcopy(row)
    candidate.update(classification=CLASSIFICATION, repairActor=repair_user,
        metadataEvidence={'policy': POLICY, 'artifactId': row['id'], 'repairActor': repair_user,
            'verifiedRepair': True, 'writeEpoch': evidence['writeEpoch'], 'windowSeconds': WINDOW_SECONDS,
            'beforeModification': mod(saved), 'recordSha256': record_hash,
            'preimageSha256': hashlib.sha256(raw).hexdigest(), 'record': str(record_path),
            'preimage': str(preimage)})
    validate_metadata_evidence(candidate, row['document'], row['graph'], repair_user)
    return candidate


def propose(review, repair_user, out):
    out.mkdir(parents=True, exist_ok=False)
    counts = Counter(); kinds = Counter(); campaigns = Counter(); cache = {}
    with review.open() as source, (out / 'proposed-candidates.jsonl').open('w') as ready, (out / 'held.jsonl').open('w') as held:
        for line in source:
            row = json.loads(line)
            if row.get('classification') != 'repair-correlated-needs-revision-proof': continue
            counts['considered'] += 1
            try:
                candidate = proposal(row, repair_user, cache)
                ready.write(json.dumps(candidate) + '\n')
                counts['proposed'] += 1; kinds[row['kind']] += 1; campaigns[row['evidence']['campaign']] += 1
            except (OSError, KeyError, ValueError, TypeError) as error:
                counts['held'] += 1
                held.write(json.dumps({'id': row['id'], 'kind': row['kind'], 'reason': str(error)}) + '\n')
            if counts['considered'] % 5000 == 0: print('evidence checked', counts['considered'], flush=True)
    summary = {'status': 'PROPOSED_REQUIRES_FRESH_PREFLIGHT', 'readOnly': True, 'preparedAt': now(),
        'policy': POLICY, 'repairActor': repair_user, 'counts': counts, 'byKind': kinds, 'campaigns': campaigns,
        'basis': 'Artifact-specific verified repair event, matching Admin/time window, original provenance matching retained preimage. No historical whole-document equality requirement.'}
    atomic(out / 'summary.json', summary)
    print(json.dumps(summary, indent=2))


def fresh_candidate(candidate, stored, first, last, users, pending, repair_user):
    from cedar_provenance_apply import prepare
    from cedar_provenance_store import GRAPH_KEYS, public_document
    if candidate['id'] in pending: raise ValueError('pending lifecycle job')
    if first is None or last is None or first != last:
        raise ValueError('graph missing or changed during preflight')
    if stored is None: raise ValueError('document missing')
    if '_cedarDeletionToken' in stored: raise ValueError('document deletion pending')
    body = public_document(stored)
    if body.get('oslc:modifiedBy') not in users: raise ValueError('original modifier identity is unresolved')
    current = copy.deepcopy(candidate)
    current.update(document=metadata(body), graph={new: last[old] for old, new in GRAPH_KEYS.items() if old in last},
        expectedDocumentSha256=digest(body), expectedDocumentEtag='"%s"' % stored.get('_cedarRevision', 0),
        expectedGraphEtag='"%s"' % last.get('_cedarRevision', 1), preparedAt=now())
    # The same proof and current-state guards will run again before an eventual transaction.
    record = prepare(current, stored, last, repair_user=repair_user)
    return current, record


def preflight(stores, plan, repair_user, out):
    from cedar_provenance_apply import documents, pending_lifecycle_ids
    with plan.open() as source: candidates = [json.loads(line) for line in source]
    if len({c['id'] for c in candidates}) != len(candidates): raise ValueError('duplicate candidate identity')
    if any(c.get('classification') != CLASSIFICATION for c in candidates): raise ValueError('unexpected candidate classification')
    out.mkdir(parents=True, exist_ok=False)
    users = {row[0] for row in stores.query('MATCH(u:User) RETURN u._id')}
    counts = Counter(); kinds = Counter(); reasons = Counter()
    with (out / 'ready-candidates.jsonl').open('w') as ready, (out / 'held.jsonl').open('w') as held, (out / 'preflight.jsonl').open('w') as observations:
        for offset in range(0, len(candidates), 100):
            batch = candidates[offset:offset+100]; ids = [c['id'] for c in batch]
            first = stores.graphs(ids); docs = documents(stores, batch); last = stores.graphs(ids)
            pending = pending_lifecycle_ids(stores, ids)
            for candidate in batch:
                identifier = candidate['id']; counts['checked'] += 1
                try:
                    current, record = fresh_candidate(candidate, docs.get(identifier), first.get(identifier),
                        last.get(identifier), users, pending, repair_user)
                    ready.write(json.dumps(current) + '\n')
                    observations.write(json.dumps(dict(record, status='ready', checkedAt=now())) + '\n')
                    counts['ready'] += 1; kinds[candidate['kind']] += 1
                except (ValueError, KeyError, TypeError) as error:
                    counts['held'] += 1; reasons[str(error)] += 1
                    held.write(json.dumps({'id': identifier, 'kind': candidate['kind'], 'reason': str(error)}) + '\n')
            if offset % 1000 == 0:
                ready.flush(); observations.flush(); held.flush()
                atomic(out / 'progress.json', {'at': now(), 'readOnly': True, 'counts': counts})
                print('preflight', dict(counts), flush=True)
            time.sleep(.05)
    summary = {'status': 'PREPARED_NOT_APPLIED', 'readOnly': True, 'preparedAt': now(), 'policy': POLICY,
        'repairActor': repair_user, 'counts': counts, 'byKind': kinds, 'heldReasons': reasons,
        'inputSha256': hashlib.sha256(plan.read_bytes()).hexdigest(),
        'readyPlanSha256': hashlib.sha256((out / 'ready-candidates.jsonl').read_bytes()).hexdigest(),
        'beforeApply': ['Explicit execution authorization; this command only prepares.',
            'Coordinate with the current running verification before any maintenance outage.',
            'Take a fresh backup with application writers paused; executor repeats all guards.',
            'Use explicit --allow-repair-metadata and the same --repair-user; default apply policy remains strict.']}
    atomic(out / 'summary.json', summary)
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('propose', 'preflight'):
        command = commands.add_parser(name)
        command.add_argument('--repair-user', required=True)
        command.add_argument('--out', type=Path, required=True)
        command.add_argument('--review' if name == 'propose' else '--plan', type=Path, required=True)
    args = parser.parse_args(); os.umask(0o027)
    if args.command == 'propose': propose(args.review, args.repair_user, args.out)
    else:
        from cedar_provenance_store import Stores
        preflight(Stores(), args.plan, args.repair_user, args.out)


if __name__ == '__main__': main()
