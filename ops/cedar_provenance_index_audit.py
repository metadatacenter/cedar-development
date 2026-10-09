#!/usr/bin/env python3
"""Read-only, complete search-index versus graph provenance census, including regular folders."""
import argparse
from collections import Counter
import json
from pathlib import Path

from cedar_provenance_audit import atomic, compare, now
from cedar_provenance_store import Stores


def audit(stores, out):
    import requests
    out.mkdir(parents=True, exist_ok=False)
    graphs = {}
    for identifier, kind, created, creator, updated, modifier in stores.query(
            'MATCH (a) WHERE a:Artifact OR (a:Folder AND NOT coalesce(a.isUserHome,false) '
            'AND NOT coalesce(a.isSystem,false)) RETURN a._id, a.resourceType, '
            'a.pav_createdOn, a.pav_createdBy, a.pav_lastUpdatedOn, a.oslc_modifiedBy'):
        if identifier in graphs: raise RuntimeError('duplicate graph identity')
        graphs[identifier] = {'resourceType': kind, 'pav:createdOn': created, 'pav:createdBy': creator,
                              'pav:lastUpdatedOn': updated, 'oslc:modifiedBy': modifier}
    base = f"http://{stores.env['CEDAR_OPENSEARCH_HOST']}:{stores.env['CEDAR_OPENSEARCH_REST_PORT']}"
    response = requests.post(base + '/cedar-search/_search', params={'scroll': '2m'}, json={
        'size': 1000, 'sort': ['_doc'], 'track_total_hits': True,
        '_source': ['cid', 'info.@id', 'info.resourceType', 'info.pav:createdOn', 'info.pav:createdBy',
                    'info.pav:lastUpdatedOn', 'info.oslc:modifiedBy'], 'query': {'match_all': {}}}, timeout=60)
    response.raise_for_status(); page = response.json(); scroll = page['_scroll_id']
    total = page['hits']['total']['value']; counts = Counter(); seen = set()
    try:
        with (out / 'findings.jsonl').open('w') as findings:
            def finding(value):
                counts['finding:' + value['issue']] += 1
                findings.write(json.dumps(value) + '\n')
            while page['hits']['hits']:
                for hit in page['hits']['hits']:
                    identifier = hit['_id']; info = hit['_source'].get('info', {})
                    counts['indexed:' + str(info.get('resourceType'))] += 1
                    if identifier in seen: finding({'id': identifier, 'issue': 'duplicate-index-identity'})
                    seen.add(identifier)
                    graph = graphs.get(identifier)
                    if identifier != info.get('@id'):
                        finding({'id': identifier, 'issue': 'index-identity-disagreement'})
                    if graph is None:
                        finding({'id': identifier, 'kind': info.get('resourceType'), 'issue': 'index-without-eligible-graph'})
                    else:
                        diff = compare(info, graph)
                        if info.get('resourceType') != graph['resourceType']: diff.append('resourceType')
                        if diff: finding({'id': identifier, 'kind': graph['resourceType'],
                            'issue': 'index-graph-provenance-difference', 'properties': diff,
                            'graph': graph, 'index': info})
                if len(seen) % 10000 == 0: print('indexed', len(seen), '/', total, flush=True)
                response = requests.post(base + '/_search/scroll', json={'scroll': '2m', 'scroll_id': scroll}, timeout=60)
                response.raise_for_status(); page = response.json(); scroll = page['_scroll_id']
            for identifier, graph in graphs.items():
                if identifier not in seen:
                    finding({'id': identifier, 'kind': graph['resourceType'], 'issue': 'graph-without-index'})
        if len(seen) != total: raise RuntimeError('index enumeration coverage mismatch')
        atomic(out / 'summary.json', {'status': 'COMPLETE_INDEX_GRAPH_CENSUS', 'readOnly': True,
            'completedAt': now(), 'graphExpected': len(graphs), 'indexTotal': total,
            'indexUnique': len(seen), 'counts': counts,
            'scope': 'All search documents versus Artifact and regular Folder graph nodes; excludes home/system folders. Live graph read and independent index snapshot.'})
    finally:
        requests.delete(base + '/_search/scroll', json={'scroll_id': [scroll]}, timeout=15)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    audit(Stores(), args.out)
