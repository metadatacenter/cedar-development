#!/usr/bin/env python3
"""Read-only provenance census directly from the configured native production stores.

No database write operations. Public Mongo conversion mirrors GenericLDDaoMongoDB and
JsonUtils; validate it against retained REST samples before trusting document hashes.
"""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys

from cedar_provenance_audit import atomic, compare, digest, metadata, now

COLLECTIONS = {'template': 'templates', 'element': 'template-elements',
               'field': 'template-fields', 'instance': 'template-instances'}
GRAPH_KEYS = {'pav_createdOn': 'pav:createdOn', 'pav_createdBy': 'pav:createdBy',
              'pav_lastUpdatedOn': 'pav:lastUpdatedOn', 'oslc_modifiedBy': 'oslc:modifiedBy',
              'createdOnTS': 'createdOnTS', 'lastUpdatedOnTS': 'lastUpdatedOnTS', 'ownedBy': 'ownedBy'}


def public_document(stored):
    from bson import json_util
    value = {k: v for k, v in stored.items()
             if k not in ('_id', '_cedarRevision', '_cedarDeletionToken')}
    value = json.loads(json_util.dumps(value, json_options=json_util.RELAXED_JSON_OPTIONS))

    def convert(node):
        if isinstance(node, list):
            for child in node: convert(child)
        if isinstance(node, dict):
            for old in ('_$schema', '_$oid', '_$numberLong'):
                if old in node:
                    raw = node.pop(old)
                    node[old[1:]] = (raw if isinstance(raw, str) else '' if isinstance(raw, (dict, list))
                                    else 'null' if raw is None else json.dumps(raw))
            for child in node.values(): convert(child)
    convert(value)
    return value


class Stores:
    def __init__(self):
        import requests
        from pymongo import MongoClient
        home = Path(os.environ['CEDAR_HOME'])
        sys.path.insert(0, str(home / 'cedar-cli'))
        from org.metadatacenter.util.ModeManager import ModeManager
        env = ModeManager.profile_environment('native')
        self.env = env
        self.session = requests.Session()
        self.session.auth = (env['CEDAR_NEO4J_USER_NAME'], env['CEDAR_NEO4J_USER_PASSWORD'])
        self.base = f"http://{env['CEDAR_NEO4J_HOST']}:{env.get('CEDAR_NEO4J_REST_PORT', '7474')}/db/neo4j/tx"
        self.mongo = MongoClient(host=env['CEDAR_MONGO_HOST'], port=int(env['CEDAR_MONGO_PORT']),
            username=env['CEDAR_MONGO_APP_USER_NAME'], password=env['CEDAR_MONGO_APP_USER_PASSWORD'],
            authSource='cedar', serverSelectionTimeoutMS=15000, appname='cedar-provenance-read-only')
        self.db = self.mongo['cedar']

    def query(self, statement, parameters=None):
        response = self.session.post(self.base + '/commit', json={'statements': [
            {'statement': statement, 'parameters': parameters or {}}]}, timeout=120)
        response.raise_for_status()
        payload = response.json()
        if payload.get('errors'):
            raise RuntimeError(', '.join(item['code'] for item in payload['errors']))
        return [item['row'] for item in payload['results'][0]['data']]

    def graphs(self, ids):
        return {p['_id']: p for p, in self.query(
            'UNWIND $ids AS id MATCH (a:Artifact {_id:id}) RETURN properties(a)', {'ids': ids})}

    def document(self, kind, identifier):
        values = list(self.db[COLLECTIONS[kind]].find({'@id': identifier}).limit(2))
        if len(values) != 1: raise ValueError('missing or duplicate Mongo identity')
        return values[0]


def observation(kind, stored, graph):
    body = public_document(stored)
    gm = {new: graph[old] for old, new in GRAPH_KEYS.items() if old in graph}
    dm = metadata(body)
    identifier = graph['_id']
    return {'id': identifier, 'kind': kind, 'observedAt': now(), 'source': 'direct-stores',
            'graph': gm, 'listing': gm, 'graphEtag': '"%s"' % graph.get('_cedarRevision', 1),
            'document': dm, 'documentSha256': digest(body),
            'documentEtag': '"%s"' % stored.get('_cedarRevision', 0), 'documentId': body.get('@id'),
            'documentGraphMismatch': compare(dm, gm), 'listingGraphMismatch': [],
            'identityMismatch': body.get('@id') != identifier,
            'deletionPending': '_cedarDeletionToken' in stored,
            'complete': '_cedarDeletionToken' not in stored}


def validate(stores, plan):
    candidates = [json.loads(line) for line in plan.open()]
    graphs = stores.graphs([c['id'] for c in candidates])
    failures = []
    for c in candidates:
        row = observation(c['kind'], stores.document(c['kind'], c['id']), graphs[c['id']])
        for target, key in [('expectedDocumentSha256', 'documentSha256'),
                            ('expectedDocumentEtag', 'documentEtag'), ('expectedGraphEtag', 'graphEtag')]:
            if c[target] != row[key]: failures.append({'id': c['id'], 'mismatch': key})
        for key in GRAPH_KEYS.values():
            if c['graph'].get(key) != row['graph'].get(key):
                failures.append({'id': c['id'], 'mismatch': key})
    return {'readOnly': True, 'checked': len(candidates), 'failures': failures}


def census(stores, out):
    out.mkdir(parents=True, exist_ok=False)
    counts = Counter(); graph_ids = {}; seen = set()
    # One graph read avoids unstable offset windows; only provenance and identity are retained.
    for p, in stores.query('MATCH (a:Artifact) RETURN properties(a)'):
        identifier = p.get('_id')
        if identifier in graph_ids: raise ValueError('duplicate graph identity')
        graph_ids[identifier] = p
        counts['graph:' + str(p.get('resourceType'))] += 1
    atomic(out / 'graph-counts.json', counts)
    with (out / 'observations.jsonl').open('w') as observations, (out / 'store-findings.jsonl').open('w') as findings:
        def finding(value):
            counts['finding:' + value['issue']] += 1
            findings.write(json.dumps(value) + '\n')
        for kind, collection in COLLECTIONS.items():
            for stored in stores.db[collection].find({}, batch_size=200):
                counts['mongo:' + kind] += 1
                identifier = stored.get('@id')
                if identifier in seen:
                    finding({'id': identifier, 'kind': kind, 'issue': 'duplicate-mongo-identity'})
                seen.add(identifier)
                graph = graph_ids.get(identifier)
                if graph is None:
                    finding({'id': identifier, 'kind': kind, 'issue': 'mongo-without-graph'})
                    continue
                if graph.get('resourceType') != kind:
                    finding({'id': identifier, 'kind': kind, 'issue': 'resource-type-mismatch'})
                    continue
                row = observation(kind, stored, graph)
                observations.write(json.dumps(row, ensure_ascii=False) + '\n')
                counts['observed'] += 1
                if row['documentGraphMismatch']: counts['provenance-difference:' + kind] += 1
                if counts['observed'] % 5000 == 0:
                    observations.flush()
                    print('observed', counts['observed'], flush=True)
            print('completed', kind, counts['mongo:' + kind], flush=True)
        for identifier, p in graph_ids.items():
            kind = p.get('resourceType')
            if kind in COLLECTIONS and identifier not in seen:
                finding({'id': identifier, 'kind': kind, 'issue': 'graph-without-mongo'})
                observations.write(json.dumps({'id': identifier, 'kind': kind, 'complete': False}) + '\n')
    atomic(out / 'summary.json', {'status': 'COMPLETE_DIRECT_STORE_CENSUS', 'readOnly': True,
        'completedAt': now(), 'counts': counts,
        'scope': 'All Artifact graph nodes and four Mongo artifact collections; live reads, not an atomic snapshot. Search index and folders are not compared.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate-plan', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    os.umask(0o027)
    stores = Stores()
    if args.validate_plan:
        result = validate(stores, args.validate_plan)
        print(json.dumps(result, indent=2))
        if result['failures']: raise SystemExit(1)
    elif args.out: census(stores, args.out)
    else: parser.error('choose --validate-plan or --out')


if __name__ == '__main__': main()
