#!/usr/bin/env python3
"""GET-only fresh preflight and offline Cypher bundle for an approved future graph restoration.

There is deliberately no apply option or database driver. Application writes must be paused and
these checks repeated before the separately approved operator transaction. Document bodies are
never rewritten. The tested query changes three modification properties, advances the graph
revision, and atomically queues search reprojection. It requires the current lifecycle lock/relay.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

from cedar_provenance_audit import (PersistentGetClient, ProductionLoadGuard, ReadPressureError,
                                    atomic, digest, now, rest)


def check_candidate(client, candidate):
    identifier = candidate['id']
    if candidate.get('classification') != 'eligible-unchanged-repair':
        return {'id': identifier, 'status': 'refused', 'reason': 'not an eligible candidate'}
    path = rest.typed_artifact_path(rest.ArtifactRef(candidate['kind'], identifier))
    try:
        first, first_tag, _ = client.get(path + '/details')
        body, body_tag, _ = client.get(path)
        last, last_tag, _ = client.get(path + '/details')
        if (body.get('@id') != identifier or body_tag != candidate['expectedDocumentEtag']
                or digest(body) != candidate['expectedDocumentSha256']):
            return {'id': identifier, 'status': 'changed', 'reason': 'document changed since audit'}
        keys = ('oslc:modifiedBy', 'pav:lastUpdatedOn', 'lastUpdatedOnTS')
        if (first_tag != last_tag or last_tag != candidate['expectedGraphEtag']
                or any(first.get(k) != last.get(k) or last.get(k) != candidate['graph'].get(k) for k in keys)):
            return {'id': identifier, 'status': 'changed', 'reason': 'graph changed since audit or during preflight'}
        if not re.fullmatch(r'"[1-9][0-9]*"', last_tag or ''):
            return {'id': identifier, 'status': 'refused', 'reason': 'unknown graph revision format'}
        original = datetime.fromisoformat(body['pav:lastUpdatedOn'].replace('Z', '+00:00'))
        if original.tzinfo is None or not body.get('oslc:modifiedBy'):
            return {'id': identifier, 'status': 'refused', 'reason': 'missing original provenance'}
        params = {'id': identifier, 'expectedModifiedBy': last['oslc:modifiedBy'],
                  'expectedLastUpdatedOnTS': last['lastUpdatedOnTS'],
                  'expectedGraphRevision': int(last_tag[1:-1]), 'modifiedBy': body['oslc:modifiedBy'],
                  'lastUpdatedOn': original.isoformat(timespec='seconds'),
                  'lastUpdatedOnTS': int(original.timestamp())}
        rollback = {'id': identifier, 'expectedModifiedBy': params['modifiedBy'],
                    'expectedLastUpdatedOnTS': params['lastUpdatedOnTS'],
                    'expectedGraphRevision': params['expectedGraphRevision'] + 1,
                    'modifiedBy': last['oslc:modifiedBy'], 'lastUpdatedOn': last['pav:lastUpdatedOn'],
                    'lastUpdatedOnTS': last['lastUpdatedOnTS']}
        return {'id': identifier, 'status': 'ready-for-review', 'checkedAt': now(),
                'documentEtag': body_tag, 'documentSha256': digest(body), 'graphEtag': last_tag,
                'parameters': params, 'rollbackParameters': rollback}
    except (rest.AuthenticationError, ReadPressureError): raise
    except Exception as error:
        return {'id': identifier, 'status': 'unreadable', 'reason': str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--api-key-file', type=Path, required=True)
    parser.add_argument('--server', default=rest.DEFAULT_SERVER)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--query', type=Path, default=Path(__file__).resolve().parents[2] /
        'cedar-microservice-libraries/cedar-workspace-operations-library/src/main/resources/org/metadatacenter/server/restore-artifact-provenance.cypher')
    args = parser.parse_args()
    if not 1 <= args.workers <= 8: parser.error('workers must be 1..8')
    if args.out.exists(): parser.error('use a new output directory; prior evidence is never overwritten')
    if not args.query.is_file(): parser.error('tested restoration query is missing')
    os.umask(0o077); args.out.mkdir(parents=True)
    candidates = [json.loads(line) for line in args.plan.read_text().splitlines()]
    if len({row['id'] for row in candidates}) != len(candidates): parser.error('plan has duplicate IDs')
    client = PersistentGetClient(args.server, args.api_key_file.read_text().strip())
    if args.server.rstrip('/') == rest.DEFAULT_SERVER.rstrip('/'):
        client.load_guard = ProductionLoadGuard(
            PersistentGetClient('https://monitor.metadatacenter.org', args.api_key_file.read_text().strip()),
            args.out / 'load-guard.json')
    records = []
    try:
        if client.load_guard: client.load_guard.check()
        with (args.out / 'preflight.jsonl').open('w') as stream, ThreadPoolExecutor(args.workers) as pool:
            for index, record in enumerate(pool.map(lambda item: check_candidate(client, item), candidates), 1):
                stream.write(json.dumps(record, ensure_ascii=False) + '\n'); stream.flush(); records.append(record)
                if index % 250 == 0: print('preflight', index, '/', len(candidates), flush=True)
    except ReadPressureError as error:
        atomic(args.out / 'summary.json', {'status': 'STOPPED_PRODUCTION_LOG_BACKPRESSURE',
            'readOnly': True, 'candidates': len(candidates), 'checked': len(records), 'reason': str(error)})
        raise SystemExit('Preflight stopped; no batches prepared: ' + str(error)) from None
    ready = [r for r in records if r['status'] == 'ready-for-review']
    for offset in range(0, len(ready), 100):
        atomic(args.out / f'batch-{offset // 100 + 1:04d}.json', {'rows': [r['parameters'] for r in ready[offset:offset+100]]})
        atomic(args.out / f'rollback-{offset // 100 + 1:04d}.json', {'rows': [r['rollbackParameters'] for r in ready[offset:offset+100]]})
    shutil.copyfile(args.query, args.out / 'restore-artifact-provenance.cypher')
    atomic(args.out / 'summary.json', {'preparedAt': now(), 'readOnly': True,
        'status': 'PREPARED_FOR_REVIEW', 'candidates': len(candidates), 'ready': len(ready),
        'skipped': [r for r in records if r['status'] != 'ready-for-review'],
        'planSha256': hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        'querySha256': hashlib.sha256(args.query.read_bytes()).hexdigest(),
        'conditionsBeforeAnyApply': [
            'Explicit approval of the candidate set and production change.',
            'Deploy the prevention fix and confirm the lifecycle lock and version projection relay are present.',
            'Pause application writes; rerun this GET-only preflight to a new directory.',
            'Take a database backup and retain preflight observations before any graph transaction.',
            'Execute each reviewed batch as a transaction; require one returned row per candidate or roll back.',
            'Wait for projection jobs to drain; verify JSON hashes/ETags unchanged and document/details/search provenance equal.',
            'Rollback only with the guarded rollback parameters, after projection drains and if no later edit changed the node.'
        ], 'restorationBasis': 'Retained document modification provenance; pre-repair graph metadata was not saved by the old repair tools.'})
    print('prepared', len(ready), 'candidates;', len(candidates)-len(ready), 'skipped; no production writes')


if __name__ == '__main__': main()
