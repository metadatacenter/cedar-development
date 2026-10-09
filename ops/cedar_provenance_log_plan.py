#!/usr/bin/env python3
"""Seal retained verbatim-write log evidence and fresh read-only repair preflight.

Logs establish the write's identity, actor, mode and time. The unchanged Mongo
document supplies original modification provenance; logs are not document backups.
This command never applies a repair or writes to a production data store.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path

from cedar_provenance_audit import atomic, digest, metadata, now
from cedar_provenance_log_review import CLASSES, access, java_id_hash, warning
from cedar_provenance_plan import epoch, mod
from cedar_provenance_user_alias import LEGACY, alias_for, resolved_modifier

CLASSIFICATION = 'eligible-verbatim-log-evidence'
POLICY = 'verbatim-log-evidence-v1'
WINDOW = 3


def decoded(entry, parser):
    raw = entry.get('raw')
    if (not isinstance(raw, str) or not raw.endswith('\n')
            or hashlib.sha256(raw.encode()).hexdigest() != entry.get('lineSha256')
            or type(entry.get('line')) is not int or entry['line'] < 1
            or not isinstance(entry.get('file'), str)):
        raise ValueError('missing or altered retained log line')
    parsed = parser(raw)
    if parsed is None: raise ValueError('unparseable retained log line')
    return parsed


def validate_log_evidence(candidate, document, graph, repair_user):
    proof = candidate.get('logEvidence') or {}
    if not repair_user or graph.get('oslc:modifiedBy') != repair_user:
        raise ValueError('current modifier is not the specified repair account')
    if (proof.get('policy') != POLICY or proof.get('artifactId') != candidate['id']
            or proof.get('repairActor') != repair_user or candidate.get('repairActor') != repair_user
            or proof.get('uniqueHashAmongGraphArtifacts') is not True
            or proof.get('conflictingRetainedWrites') is not False
            or proof.get('windowSeconds') != WINDOW):
        raise ValueError('missing or inconsistent artifact-specific log proof')
    stamp = epoch(graph.get('pav:lastUpdatedOn'))
    if stamp is None or not math.isfinite(stamp) or graph.get('lastUpdatedOnTS') != int(stamp):
        raise ValueError('graph date and numeric timestamp disagree')
    if proof.get('graphEpoch') != graph.get('lastUpdatedOnTS'):
        raise ValueError('graph no longer matches logged repair time')
    original = mod(document); target = epoch(original.get('pav:lastUpdatedOn'))
    if target is None or not math.isfinite(target) or target >= stamp or original != proof.get('beforeModification'):
        raise ValueError('original provenance disagrees with sealed log observation')
    warn = decoded(proof.get('warning') or {}, warning)
    req = decoded(proof.get('request') or {}, access)
    if (warn['actor'] != repair_user or warn['statedModifier'] != original.get('oslc:modifiedBy')
            or warn['class'] != CLASSES[candidate['kind']] or warn['hash'] != java_id_hash(candidate['id'])
            or abs(warn['epoch'] - stamp) > WINDOW):
        raise ValueError('warning does not establish this artifact repair')
    if (req['id'] != candidate['id'] or req['method'] != 'PUT' or not req['verbatim']
            or not 200 <= req['status'] < 300 or abs(req['epoch'] - stamp) > WINDOW):
        raise ValueError('missing successful matching verbatim request')


def selected_evidence(row):
    if (row['category'] != 'corroborated-verbatim-write'
            or row.get('uniqueHashAmongGraphArtifacts') is not True
            or row.get('laterSuccessfulRequests') or row.get('nearOtherSuccessfulRequests')):
        raise ValueError('unproven log correlation or potentially conflicting write')
    requests = [r for r in row['nearRequests'] if r['method'] == 'PUT' and r['verbatim'] and 200 <= r['status'] < 300]
    return (min(row['matchedWarnings'], key=lambda w: abs(w['epoch']-row['graphEpoch'])),
            min(requests, key=lambda r: abs(r['epoch']-row['graphEpoch'])))


def retain_lines(entries):
    """Read only requested lines, once per file, validating prior scan fingerprints."""
    wanted = defaultdict(dict)
    for entry in entries:
        previous = wanted[entry['file']].setdefault(entry['line'], entry['lineSha256'])
        if previous != entry['lineSha256']: raise ValueError('inconsistent log fingerprints')
    retained = {}; sources = []
    for filename, lines in sorted(wanted.items()):
        path = Path(filename); before = path.stat(); missing = set(lines)
        with path.open('rb') as stream:
            for number, raw in enumerate(stream, 1):
                if number not in missing: continue
                if hashlib.sha256(raw).hexdigest() != lines[number]:
                    raise ValueError('source log line changed since correlation')
                retained[(filename, number)] = {'file': filename, 'line': number,
                    'lineSha256': lines[number], 'raw': raw.decode('utf-8')}
                missing.remove(number)
                if not missing: break
        if missing: raise ValueError('source log lines no longer available')
        after = path.stat()
        sources.append({'file': filename, 'linesRetained': len(lines), 'sizeBefore': before.st_size,
            'sizeAfter': after.st_size, 'mtimeNsBefore': before.st_mtime_ns, 'mtimeNsAfter': after.st_mtime_ns})
        print('retained', path.name, len(lines), flush=True)
    return retained, sources


def fresh_candidate(obs, correlation, pair, retained, stored, first, last, users, pending, hash_ids, repair_user):
    from cedar_provenance_apply import prepare
    from cedar_provenance_store import GRAPH_KEYS, public_document
    identifier = obs['id']
    if identifier in pending: raise ValueError('pending lifecycle job')
    if first is None or first != last: raise ValueError('graph missing or changed during preflight')
    if any(last.get(k) != v for k, v in obs['graph'].items()):
        raise ValueError('graph changed since log investigation')
    if stored is None or '_cedarDeletionToken' in stored: raise ValueError('document missing or deletion pending')
    body = public_document(stored)
    if digest(body) != obs['documentSha256'] or stored.get('_cedarRevision', 0) != obs['documentRevision']:
        raise ValueError('document changed since log investigation')
    key = (CLASSES[obs['kind']], java_id_hash(identifier))
    if hash_ids[key] != [identifier]: raise ValueError('artifact log identifier has a collision or is missing')
    candidate = {'id': identifier, 'kind': obs['kind'], 'classification': CLASSIFICATION,
        'repairActor': repair_user, 'preparedAt': now(), 'document': metadata(body),
        'graph': {new: last[old] for old, new in GRAPH_KEYS.items() if old in last},
        'expectedDocumentSha256': obs['documentSha256'],
        'expectedDocumentEtag': '"%s"' % stored.get('_cedarRevision', 0),
        'expectedGraphEtag': '"%s"' % last.get('_cedarRevision', 1),
        'logEvidence': {'policy': POLICY, 'artifactId': identifier, 'repairActor': repair_user,
            'windowSeconds': WINDOW, 'graphEpoch': correlation['graphEpoch'],
            'beforeModification': mod(body), 'uniqueHashAmongGraphArtifacts': True,
            'conflictingRetainedWrites': False,
            'warning': retained[(pair[0]['file'], pair[0]['line'])],
            'request': retained[(pair[1]['file'], pair[1]['line'])]}}
    original = body.get('oslc:modifiedBy')
    if isinstance(original, str) and original.startswith(LEGACY):
        candidate['modifierAlias'] = alias_for(original, users)
    target = resolved_modifier(candidate, body, users, True)
    if users.count(target) != 1: raise ValueError('original modifier is missing or ambiguous')
    record = prepare(candidate, stored, last, repair_user, user_ids=users,
        allow_legacy_user_aliases=True, allow_log_evidence=True)
    return candidate, record


def preflight(stores, observations, correlations, out, repair_user):
    from cedar_provenance_apply import documents, pending_lifecycle_ids
    obs_rows = [json.loads(line) for line in observations.open()]
    cor_rows = [json.loads(line) for line in correlations.open()]
    obs = {r['id']: r for r in obs_rows}; cors = {r['id']: r for r in cor_rows}
    if len(obs) != len(obs_rows) or len(cors) != len(cor_rows) or set(obs) != set(cors):
        raise ValueError('input identities are duplicated or disagree')
    out.mkdir(parents=True, exist_ok=False)
    selected = {}; held = []
    for identifier, row in cors.items():
        try: selected[identifier] = selected_evidence(row)
        except ValueError as error: held.append({'id': identifier, 'kind': obs[identifier]['kind'], 'reason': str(error)})
    retained, sources = retain_lines([entry for pair in selected.values() for entry in pair])
    atomic(out/'source-log-inventory.json', sources)
    users = [r[0] for r in stores.query('MATCH (u:User) RETURN u._id')]
    hash_ids = defaultdict(list)
    for identifier, kind in stores.query('MATCH (a:Artifact) RETURN a._id, a.resourceType'):
        if isinstance(identifier, str) and kind in CLASSES:
            hash_ids[(CLASSES[kind], java_id_hash(identifier))].append(identifier)
    counts = Counter(considered=len(obs), selected=len(selected)); kinds = Counter(); reasons = Counter()
    rows = [obs[i] for i in selected]
    with (out/'ready-candidates.jsonl').open('x') as ready, (out/'preflight.jsonl').open('x') as checks:
        for offset in range(0, len(rows), 100):
            batch = rows[offset:offset+100]; ids = [r['id'] for r in batch]
            first = stores.graphs(ids); docs = documents(stores, batch); last = stores.graphs(ids)
            pending = pending_lifecycle_ids(stores, ids)
            for row in batch:
                identifier = row['id']; counts['checked'] += 1
                try:
                    candidate, record = fresh_candidate(row, cors[identifier], selected[identifier], retained,
                        docs.get(identifier), first.get(identifier), last.get(identifier), users, pending, hash_ids, repair_user)
                    ready.write(json.dumps(candidate)+'\n'); checks.write(json.dumps(record)+'\n')
                    counts['ready'] += 1; kinds[row['kind']] += 1
                    if candidate.get('modifierAlias'): counts['legacyUserAliases'] += 1
                except (ValueError, KeyError, TypeError) as error:
                    held.append({'id': identifier, 'kind': row['kind'], 'reason': str(error)})
            if offset % 1000 == 0: print('preflight', dict(counts), flush=True)
    with (out/'held.jsonl').open('x') as output:
        for row in held: output.write(json.dumps(row)+'\n'); reasons[row['reason']] += 1
    counts['held'] = len(held)
    result = {'status': 'PREPARED_NOT_APPLIED', 'readOnly': True, 'preparedAt': now(), 'policy': POLICY,
        'counts': counts, 'byKind': kinds, 'heldReasons': reasons,
        'observationsSha256': hashlib.sha256(observations.read_bytes()).hexdigest(),
        'correlationsSha256': hashlib.sha256(correlations.read_bytes()).hexdigest(),
        'readyPlanSha256': hashlib.sha256((out/'ready-candidates.jsonl').read_bytes()).hexdigest(),
        'scope': 'Graph modification date/modifier only, with explicit verified legacy aliases; Mongo and user accounts remain unchanged.',
        'beforeApply': 'Wait for current repair verification; fresh offline backup and paused writers; sealed inputs and all candidate guards rechecked.'}
    atomic(out/'summary.json', result); print(json.dumps(result, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--observations', type=Path, required=True); p.add_argument('--correlations', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True); p.add_argument('--repair-user', required=True)
    args = p.parse_args(); os.umask(0o027)
    from cedar_provenance_store import Stores
    preflight(Stores(), args.observations, args.correlations, args.out, args.repair_user)


if __name__ == '__main__': main()
