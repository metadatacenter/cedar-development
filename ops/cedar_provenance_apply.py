#!/usr/bin/env python3
"""Guarded graph-only restoration of evidence-backed modification provenance.

Requires stopped application writers and an offline Neo4j backup. Mongo is read-only.
Every batch has a durable preimage, an explicit transaction, exact result validation,
and fresh document/graph verification. Never retries an uncertain commit automatically.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import time

from cedar_provenance_audit import atomic, digest, now
from cedar_provenance_store import COLLECTIONS, Stores, public_document
from cedar_provenance_metadata import CLASSIFICATION as METADATA_CLASSIFICATION, validate_metadata_evidence

CHANGED = {'oslc_modifiedBy', 'pav_lastUpdatedOn', 'lastUpdatedOnTS', '_cedarRevision'}


def paused():
    # Native application listeners, including artifact/resource/worker, must all be absent.
    # Infrastructure stays up for direct-store transactions.
    for port in range(9000, 9020):
        with socket.socket() as probe:
            probe.settimeout(.1)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError('application listener still running on port %s' % port)


def documents(stores, candidates):
    found = {}
    for kind, collection in COLLECTIONS.items():
        ids = [c['id'] for c in candidates if c['kind'] == kind]
        if not ids: continue
        for row in stores.db[collection].find({'@id': {'$in': ids}}):
            identifier = row.get('@id')
            if identifier in found: raise RuntimeError('duplicate Mongo identity')
            found[identifier] = row
    return found


def pending_lifecycle_ids(stores, ids):
    rows = stores.query('UNWIND $ids AS id RETURN id, '
        'EXISTS { MATCH (p:CedarVersionProjection {resourceId:id}) } OR '
        'EXISTS { MATCH (p:CedarArtifactRestoreOutbox {resourceId:id}) } OR '
        'EXISTS { MATCH (p:CedarArtifactDeletionOutbox {resourceId:id}) }', {'ids': ids})
    if len(rows) != len(ids): raise RuntimeError('incomplete pending-job preflight')
    return {identifier for identifier, pending in rows if pending}


def prepare(candidate, stored, graph, repair_user=None):
    metadata_policy = candidate.get('classification') == METADATA_CLASSIFICATION and bool(repair_user)
    if candidate.get('classification') != 'eligible-unchanged-repair' and not metadata_policy:
        raise ValueError('candidate lacks eligible classification')
    if stored is None or graph is None: raise ValueError('missing document or graph')
    if '_cedarDeletionToken' in stored: raise ValueError('pending deletion')
    body = public_document(stored)
    if (body.get('@id') != candidate['id'] or graph.get('resourceType') != candidate['kind']
            or digest(body) != candidate['expectedDocumentSha256']
            or '"%s"' % stored.get('_cedarRevision', 0) != candidate['expectedDocumentEtag']):
        raise ValueError('document changed or identity disagrees')
    if ('"%s"' % graph.get('_cedarRevision', 1) != candidate['expectedGraphEtag']
            or any(graph.get(old) != candidate['graph'].get(new) for old, new in
                [('oslc_modifiedBy', 'oslc:modifiedBy'), ('pav_lastUpdatedOn', 'pav:lastUpdatedOn'),
                 ('lastUpdatedOnTS', 'lastUpdatedOnTS')])):
        raise ValueError('graph changed')
    original = datetime.fromisoformat(body['pav:lastUpdatedOn'].replace('Z', '+00:00'))
    if original.tzinfo is None or not body.get('oslc:modifiedBy'):
        raise ValueError('missing original provenance')
    evidence = candidate.get('evidence') or {}
    if metadata_policy:
        validate_metadata_evidence(candidate, body, {
            'oslc:modifiedBy': graph.get('oslc_modifiedBy'), 'pav:lastUpdatedOn': graph.get('pav_lastUpdatedOn'),
            'lastUpdatedOnTS': graph.get('lastUpdatedOnTS')}, repair_user)
    elif (evidence.get('postimageSha256') != digest(body)
            or evidence.get('documentEtag') != candidate['expectedDocumentEtag']
            or evidence.get('beforeModification') != {k: body.get(k) for k in ('pav:lastUpdatedOn', 'oslc:modifiedBy')}):
        raise ValueError('retained evidence does not match document')
    params = {'id': candidate['id'], 'expectedModifiedBy': graph['oslc_modifiedBy'],
              'expectedLastUpdatedOnTS': graph['lastUpdatedOnTS'],
              'expectedGraphRevision': graph.get('_cedarRevision', 1),
              'modifiedBy': body['oslc:modifiedBy'], 'lastUpdatedOn': original.isoformat(timespec='seconds'),
              'lastUpdatedOnTS': int(original.timestamp())}
    return {'id': candidate['id'], 'kind': candidate['kind'], 'parameters': params,
            'graphPreimage': graph, 'documentSha256': digest(body),
            'documentRevision': stored.get('_cedarRevision', 0),
            'rollbackParameters': {'id': candidate['id'], 'expectedModifiedBy': params['modifiedBy'],
                'expectedLastUpdatedOnTS': params['lastUpdatedOnTS'],
                'expectedGraphRevision': params['expectedGraphRevision'] + 1,
                'modifiedBy': graph['oslc_modifiedBy'], 'lastUpdatedOn': graph['pav_lastUpdatedOn'],
                'lastUpdatedOnTS': graph['lastUpdatedOnTS']}}


def transact(stores, query, records):
    transaction = None
    def post(url, statements):
        response = stores.session.post(url, json={'statements': statements}, timeout=120)
        response.raise_for_status()
        payload = response.json()
        if payload.get('errors'):
            raise RuntimeError(', '.join(error['code'] for error in payload['errors']))
        return payload
    try:
        opened = post(stores.base, [])
        transaction = opened['commit'].removesuffix('/commit')
        # Do not follow a transaction URL to another origin with database credentials.
        if not transaction.startswith(stores.base + '/') or not transaction[len(stores.base)+1:].isdigit():
            transaction = None
            raise RuntimeError('unexpected transaction URL')
        result = post(transaction, [{'statement': query,
            'parameters': {'rows': [r['parameters'] for r in records]}}])
        rows = [item['row'] for item in result['results'][0]['data']]
        expected = {r['id']: r['parameters'] for r in records}
        if len(rows) != len(records) or {row[0] for row in rows} != set(expected):
            raise RuntimeError('guarded batch refused; rolling back entire batch')
        for identifier, modifier, date, stamp in rows:
            p = expected[identifier]
            if [modifier, date, stamp] != [p['modifiedBy'], p['lastUpdatedOn'], p['lastUpdatedOnTS']]:
                raise RuntimeError('unexpected returned provenance; rolling back batch')
        post(transaction + '/commit', [])
        transaction = None
    finally:
        if transaction:
            # A failed/ambiguous commit is never retried; the journal supports inspection.
            try: stores.session.delete(transaction, timeout=15)
            except Exception: pass


def verify(records, docs, graphs):
    for record in records:
        identifier = record['id']; params = record['parameters']
        stored = docs[identifier]; graph = graphs[identifier]
        if (digest(public_document(stored)) != record['documentSha256']
                or stored.get('_cedarRevision', 0) != record['documentRevision']
                or '_cedarDeletionToken' in stored):
            raise RuntimeError('document changed during restoration')
        expected = dict(record['graphPreimage'], oslc_modifiedBy=params['modifiedBy'],
            pav_lastUpdatedOn=params['lastUpdatedOn'], lastUpdatedOnTS=params['lastUpdatedOnTS'],
            _cedarRevision=params['expectedGraphRevision'] + 1)
        if graph != expected: raise RuntimeError('graph postimage differs beyond approved fields')


def apply(stores, plan, query_path, backup, out, repair_user=None):
    paused()
    if not backup.is_file() or backup.stat().st_size == 0:
        raise RuntimeError('offline Neo4j backup missing')
    with plan.open() as stream:
        candidates = [json.loads(line) for line in stream]
    if not candidates or len({c['id'] for c in candidates}) != len(candidates):
        raise ValueError('empty plan or duplicate identities')
    allowed = {'eligible-unchanged-repair'} | ({METADATA_CLASSIFICATION} if repair_user else set())
    if any(c.get('classification') not in allowed for c in candidates):
        raise ValueError('plan includes unproven candidates')
    users = {row[0] for row in stores.query('MATCH (u:User) RETURN u._id')}
    out.mkdir(parents=True, exist_ok=False)
    summary = {'status': 'RUNNING', 'startedAt': now(), 'candidates': len(candidates),
        'committed': 0, 'skipped': 0, 'planSha256': hashlib.sha256(plan.read_bytes()).hexdigest(),
        'querySha256': hashlib.sha256(query_path.read_bytes()).hexdigest(), 'backup': str(backup)}
    atomic(out / 'summary.json', summary)
    query = query_path.read_text()
    try:
        # First batch is deliberately small; full Mongo/graph verification precedes every next batch.
        offsets = [(0, min(15, len(candidates)))] + [(i, min(i+100, len(candidates))) for i in range(15, len(candidates), 100)]
        with (out / 'journal.jsonl').open('x') as journal, (out / 'skipped.jsonl').open('x') as skipped:
            for start, end in offsets:
                paused()
                batch = candidates[start:end]
                docs = documents(stores, batch); graphs = stores.graphs([c['id'] for c in batch])
                pending = pending_lifecycle_ids(stores, [c['id'] for c in batch])
                records = []
                for candidate in batch:
                    try:
                        if candidate['id'] in pending:
                            raise ValueError('pending lifecycle job, including parked deletion')
                        if candidate['document']['oslc:modifiedBy'] not in users:
                            raise ValueError('original modifier identity is unresolved')
                        records.append(prepare(candidate, docs.get(candidate['id']), graphs.get(candidate['id']), repair_user))
                    except ValueError as error:
                        skipped.write(json.dumps({'id': candidate['id'], 'reason': str(error)}) + '\n')
                        summary['skipped'] += 1
                if records:
                    journal.write(json.dumps({'phase': 'intent', 'at': now(), 'offset': start, 'records': records}) + '\n')
                    journal.flush(); os.fsync(journal.fileno())
                    transact(stores, query, records)
                    verify(records, documents(stores, records), stores.graphs([r['id'] for r in records]))
                    journal.write(json.dumps({'phase': 'verified', 'at': now(), 'offset': start,
                                              'ids': [r['id'] for r in records]}) + '\n')
                    journal.flush(); os.fsync(journal.fileno())
                    summary['committed'] += len(records)
                atomic(out / 'summary.json', dict(summary, checked=end))
                if start == 0 or end % 1000 < 100 or end == len(candidates):
                    print('verified', summary['committed'], 'skipped', summary['skipped'], 'of', len(candidates), flush=True)
        summary.update(status='GRAPH_RESTORED_AWAITING_SEARCH_PROJECTION', completedAt=now())
        atomic(out / 'summary.json', summary)
    except BaseException:
        summary.update(status='STOPPED_REQUIRES_JOURNAL_INSPECTION', stoppedAt=now())
        atomic(out / 'summary.json', summary)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--query', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--allow-repair-metadata', action='store_true', help='Opt into artifact-specific repair-window/preimage evidence without historical content equality')
    parser.add_argument('--repair-user', help='Required repair account identity for --allow-repair-metadata')
    args = parser.parse_args()
    if not args.apply: parser.error('writes require --apply')
    if args.allow_repair_metadata != bool(args.repair_user):
        parser.error('--allow-repair-metadata and --repair-user must be supplied together')
    os.umask(0o027)
    apply(Stores(), args.plan, args.query, args.backup, args.out, args.repair_user)


if __name__ == '__main__': main()
