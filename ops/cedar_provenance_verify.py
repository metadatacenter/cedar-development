#!/usr/bin/env python3
"""Verify a completed graph repair after search projections drain; never edits artifacts.

Optional queue clearing is restricted to the configured application's pending log list,
and must be explicitly enabled. It never clears projection or permission work.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import time

from cedar_provenance_apply import documents
from cedar_provenance_audit import atomic, digest, normalized, now
from cedar_provenance_store import Stores, public_document


def queue(stores, clear):
    args = ['redis-cli', '-h', stores.env['CEDAR_REDIS_PERSISTENT_HOST'], '-p',
            stores.env['CEDAR_REDIS_PERSISTENT_PORT'], '--raw']
    key = 'CEDAR-QUEUE-app-log'
    depth = int(subprocess.check_output(args + ['LLEN', key], text=True, timeout=15).strip())
    if clear and depth > 100000:
        # The user explicitly authorized clearing this log queue. Leave the in-flight list alone.
        removed = subprocess.check_output(args + ['UNLINK', key], text=True, timeout=15).strip()
        if removed not in ('0', '1'): raise RuntimeError('log queue purge was not acknowledged')
        print('cleared pending application log queue; prior depth', depth, flush=True)
    return depth


def verify(stores, out, clear=False, deadline_seconds=86400):
    import requests
    summary = json.loads((out / 'summary.json').read_text())
    if summary['status'] != 'GRAPH_RESTORED_AWAITING_SEARCH_PROJECTION':
        raise RuntimeError('graph restoration did not complete; inspect journal first')
    # The existing relay takes at most 25 jobs per five-second interval, plus processing
    # time. A large restoration needs hours even when healthy; retain a bounded day
    # for verification rather than falsely failing a normally draining queue at two hours.
    deadline = time.monotonic() + deadline_seconds
    while True:
        pending = stores.query('MATCH (p:CedarVersionProjection) RETURN count(p)')[0][0]
        depth = queue(stores, clear)
        atomic(out / 'projection-progress.json', {'at': now(), 'pending': pending, 'logQueue': depth})
        print('pending projections', pending, 'log queue', depth, flush=True)
        if pending == 0: break
        if time.monotonic() >= deadline: raise RuntimeError('projection drain deadline exceeded')
        time.sleep(15)
    base = f"http://{stores.env['CEDAR_OPENSEARCH_HOST']}:{stores.env['CEDAR_OPENSEARCH_REST_PORT']}"
    counts = Counter()
    with (out / 'journal.jsonl').open() as journal, (out / 'verification-findings.jsonl').open('x') as findings:
        for line in journal:
            event = json.loads(line)
            if event['phase'] != 'intent': continue
            records = event['records']
            docs = documents(stores, records); graphs = stores.graphs([r['id'] for r in records])
            response = requests.post(base + '/cedar-search/_mget', json={'ids': [r['id'] for r in records]},
                params={'_source': 'info.@id,info.oslc:modifiedBy,info.pav:lastUpdatedOn'}, timeout=60)
            response.raise_for_status()
            indexed = {d['_id']: d for d in response.json()['docs']}
            for record in records:
                identifier = record['id']; params = record['parameters']
                graph = graphs.get(identifier); stored = docs.get(identifier)
                issues = []
                if stored is None or graph is None:
                    issues.append('resource removed after restoration')
                elif (digest(public_document(stored)) != record['documentSha256']
                        or stored.get('_cedarRevision', 0) != record['documentRevision']
                        or graph.get('_cedarRevision') != params['expectedGraphRevision'] + 1):
                    counts['changedAfterRestoration'] += 1
                    findings.write(json.dumps({'id': identifier, 'issues': ['later edit; batch verification retained']}) + '\n')
                    continue
                else:
                    if (graph.get('oslc_modifiedBy') != params['modifiedBy']
                            or graph.get('pav_lastUpdatedOn') != params['lastUpdatedOn']
                            or graph.get('lastUpdatedOnTS') != params['lastUpdatedOnTS']):
                        issues.append('graph provenance differs')
                    hit = indexed.get(identifier, {})
                    info = hit.get('_source', {}).get('info', {})
                    if (not hit.get('found') or info.get('oslc:modifiedBy') != params['modifiedBy']
                            or normalized('pav:lastUpdatedOn', info.get('pav:lastUpdatedOn')) !=
                               normalized('pav:lastUpdatedOn', params['lastUpdatedOn'])):
                        issues.append('search provenance differs or missing')
                counts['checked'] += 1
                if issues:
                    counts['failed'] += 1
                    findings.write(json.dumps({'id': identifier, 'issues': issues}) + '\n')
                else: counts['verified'] += 1
            if counts['checked'] % 1000 < 100: print('search verification', dict(counts), flush=True)
    result = {'status': 'VERIFIED' if not counts['failed'] else 'VERIFICATION_FAILED',
              'completedAt': now(), 'counts': counts, 'graphCommitted': summary['committed']}
    if counts['checked'] + counts['changedAfterRestoration'] != summary['committed']:
        result['status'] = 'VERIFICATION_COUNT_MISMATCH'
    atomic(out / 'final-verification.json', result)
    if result['status'] != 'VERIFIED': raise RuntimeError(result['status'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--clear-log-queue-over-limit', action='store_true')
    args = parser.parse_args()
    verify(Stores(), args.out, args.clear_log_queue_over_limit)


if __name__ == '__main__': main()
