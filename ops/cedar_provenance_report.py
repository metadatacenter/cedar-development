#!/usr/bin/env python3
"""Offline reconciliation of the complete document, graph and search-index censuses.

Keeps per-resource exceptions and aggregate measurements. No network or write-to-prod path.
An audit of a live system is an interval, not an atomic database snapshot.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from cedar_provenance_audit import KINDS, atomic, compare, now


def epoch(value):
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(date.timestamp()) if date.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def timestamp_defects(metadata, require_numeric=True):
    result = []
    for date_key, numeric_key in [('pav:createdOn', 'createdOnTS'), ('pav:lastUpdatedOn', 'lastUpdatedOnTS')]:
        date, number = metadata.get(date_key), metadata.get(numeric_key)
        if date is None and number is None:
            continue
        instant = epoch(date)
        if instant is None:
            result.append(date_key + ':missing-or-invalid')
        elif (numeric_key in metadata or require_numeric) and (type(number) is not int or number != instant):
            result.append(numeric_key + ':does-not-match-date')
    return result


def findings(row, indexed, index_available=True):
    result = {}
    if not index_available:
        result['indexNotEnumerated'] = True
    elif indexed is None:
        result['missingFromIndex'] = True
    else:
        result['indexListingMismatch'] = compare(indexed['listing'], row['listing'])
        result['indexGraphMismatch'] = compare(indexed['listing'], row.get('graph', {})) if 'graph' in row else []
        result['indexDocumentMismatch'] = compare(indexed['listing'], row.get('document', {})) if 'document' in row else []
        result['indexTimestampDefects'] = timestamp_defects(indexed['listing'], require_numeric=False)
        if 'graph' in row:
            result['indexGraphSortTimestampMismatch'] = [k for k in ('createdOnTS', 'lastUpdatedOnTS')
                if k in indexed['listing'] and indexed['listing'].get(k) != row['graph'].get(k)]
    if 'graph' in row:
        result['graphTimestampDefects'] = timestamp_defects(row['graph'])
    result['listingTimestampDefects'] = timestamp_defects(row['listing'], require_numeric=False)
    if row.get('notObserved'): result['detailedReadNotCompleted'] = True
    for key in ('graphError', 'documentError', 'identityMismatch', 'listingGraphMismatch', 'documentGraphMismatch'):
        result[key] = row.get(key)
    return {key: value for key, value in result.items() if value}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--repair-user', required=True)
    parser.add_argument('--allow-partial', action='store_true', help='report uncompleted reads/enumerations explicitly')
    args = parser.parse_args()
    os.umask(0o077)
    records = {}
    for kind in KINDS:
        for row in json.loads((args.audit / f'inventory-{kind}.json').read_text())['rows']:
            records[row['id']] = dict(row, notObserved=True)
    with (args.audit / 'observations.jsonl').open() as stream:
        for line in stream:
            row = json.loads(line); records[row['id']] = row
    summary = json.loads((args.audit / 'summary.json').read_text())
    counters, properties, days, listing_days = (defaultdict(Counter) for _ in range(4))
    index_coverage = {}
    with (args.audit / 'reconciliation.jsonl').open('w') as stream:
        for kind in KINDS:
            index_path = args.audit / f'inventory-index-{kind}.json'
            available = index_path.exists()
            if not available and not args.allow_partial:
                parser.error(f'index census for {kind} is missing; use --allow-partial to report an incomplete audit')
            inventory = json.loads(index_path.read_text()) if available else {'rows': [], 'coverage': {'complete': False, 'notEnumerated': True}}
            index_coverage[kind] = inventory['coverage']
            indexed = {r['id']: r for r in inventory['rows']}
            observed_ids = set()
            for row in records.values():
                if row['kind'] != kind: continue
                observed_ids.add(row['id'])
                result = findings(row, indexed.get(row['id']), available)
                counters[kind]['inventoried'] += 1
                if not row.get('notObserved'): counters[kind]['observed'] += 1
                if row['listing'].get('oslc:modifiedBy') == args.repair_user:
                    counters[kind]['listedAdminModifier'] += 1
                    stamp = epoch(row['listing'].get('pav:lastUpdatedOn'))
                    day = datetime.fromtimestamp(stamp, ZoneInfo('America/Los_Angeles')).date().isoformat() if stamp is not None else 'invalid'
                    listing_days[kind][day] += 1
                if result:
                    stream.write(json.dumps({'id': row['id'], 'kind': kind, 'findings': result}) + '\n')
                for key, value in result.items():
                    counters[kind][key] += 1
                    if isinstance(value, list):
                        for prop in value: properties[kind][key + ':' + prop] += 1
                if row.get('graph', {}).get('oslc:modifiedBy') == args.repair_user:
                    counters[kind]['graphAdminModifier'] += 1
                    if set(row.get('documentGraphMismatch', [])).intersection(('oslc:modifiedBy', 'pav:lastUpdatedOn')):
                        counters[kind]['adminModificationMismatch'] += 1
                        stamp = epoch(row['graph'].get('pav:lastUpdatedOn'))
                        day = datetime.fromtimestamp(stamp, ZoneInfo('America/Los_Angeles')).date().isoformat() if stamp is not None else 'invalid'
                        days[kind][day] += 1
            for identifier in indexed.keys() - observed_ids:
                counters[kind]['indexOnly'] += 1
                stream.write(json.dumps({'id': identifier, 'kind': kind, 'findings': {'indexOnly': True}}) + '\n')
    complete = (summary['status'] in ('COMPLETE', 'COMPLETE_WITH_EXCEPTIONS') and
        len(records) == sum(v['unique'] for v in summary['coverage'].values()) and
        all(v['complete'] for v in summary['coverage'].values()) and
        all(v['complete'] for v in index_coverage.values()))
    atomic(args.audit / 'reconciliation-summary.json', {
        'preparedAt': now(), 'readOnly': True, 'censusComplete': complete,
        'auditStatus': summary['status'], 'documentAndGraphReadsComplete': summary['status'] == 'COMPLETE',
        'byKind': counters, 'byProperty': properties,
        'adminModificationMismatchDaysPacific': days, 'indexCoverage': index_coverage,
        'listedAdminModifiedDaysPacific': listing_days,
        'limitations': ['Permission-scoped REST census; excludes database-only orphans.',
            'Observations span a live read interval, not a single atomic snapshot.',
            'Search/listing representations may omit numeric sort timestamps; absent projection fields cannot be verified through these APIs.',
            'A document/graph difference alone does not prove it was caused by a repair.',
            'Created-on/created-by differences are reported separately and are not restoration targets.']})
    print(json.dumps({'censusComplete': complete, 'byKind': counters}, indent=2))


if __name__ == '__main__': main()
