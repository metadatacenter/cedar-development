#!/usr/bin/env python3
"""GET-only census of document, graph-details and listing provenance. Never repairs.

Private JSONL observations include document hashes/ETags, not artifact contents or credentials.
Resume preserves earlier observations and retries failures. Index enumeration is permission-scoped;
counts, duplicates and pagination are retained so incomplete coverage cannot appear successful.
"""
from __future__ import annotations
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import ssl
import threading
import time
import urllib.parse

import cedar_artifact_rest_audit as rest

KINDS = ('template', 'element', 'field', 'instance', 'folder')
PROVENANCE = ('pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy')
SUMMARY_FIELDS = (*PROVENANCE, 'createdOnTS', 'lastUpdatedOnTS', 'ownedBy',
                  'createdByUserName', 'lastUpdatedByUserName')


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(path)


def metadata(value):
    return {k: value[k] for k in SUMMARY_FIELDS if k in value}


def normalized(key, value):
    if key.endswith('On') and isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if dt.tzinfo is not None:
                # Graph dates historically retain seconds, documents may retain fractions.
                return ('instant-second', int(dt.timestamp()))
        except ValueError:
            pass
    return value


def compare(left, right):
    return [k for k in PROVENANCE if normalized(k, left.get(k)) != normalized(k, right.get(k))]


class ReadError(RuntimeError):
    pass


class ReadPressureError(RuntimeError):
    """Stop bulk reads when their logging cost would worsen a production backlog."""


class ProductionLoadGuard:
    def __init__(self, monitor, destination, queue_limit=100000, lag_limit=600, interval=15):
        self.monitor, self.destination = monitor, destination
        self.queue_limit, self.lag_limit, self.interval = queue_limit, lag_limit, interval
        self.lock = threading.Lock()
        self.checked_at = None
        self.failure = None

    def check(self):
        with self.lock:
            if self.failure: raise ReadPressureError(self.failure)
            if self.checked_at is not None and time.monotonic() - self.checked_at < self.interval: return
            try:
                body, _, _ = self.monitor.get('/worker/lag')
                depth, lag = body.get('appLogQueueDepth'), body.get('worstLagSeconds')
                if type(depth) is not int or type(lag) is not int or depth < 0 or lag < 0:
                    raise ReadPressureError('production logging capacity could not be verified')
                sample = {'at': now(), 'readOnly': True, 'queueDepth': depth, 'lagSeconds': lag,
                          'queueLimit': self.queue_limit, 'lagLimit': self.lag_limit}
                atomic(self.destination, sample)
                if depth > self.queue_limit or lag > self.lag_limit:
                    raise ReadPressureError(f'production logging backlog: {depth} queued, {lag}s lag; bulk reads stopped')
                self.checked_at = time.monotonic()
            except Exception as error:
                self.failure = str(error)
                raise ReadPressureError(self.failure) from None


class PersistentGetClient:
    """One TLS-verified connection per worker; no method capable of a remote write."""
    def __init__(self, server, key, timeout=30, attempts=3):
        parsed = urllib.parse.urlsplit(server)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('server must be an HTTPS origin')
        if not isinstance(key, str) or not key or '\n' in key or '\r' in key:
            raise ValueError('API key must be one nonempty line')
        try:
            key.encode('latin-1')
        except UnicodeEncodeError:
            raise ValueError('API key cannot be represented in an HTTP header') from None
        self.host, self.port = parsed.hostname, parsed.port
        self.key, self.timeout, self.attempts = key, timeout, attempts
        self.local = threading.local()
        self.context = ssl.create_default_context()
        self.load_guard = None

    def get(self, path, query=None):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('only origin-relative GET paths are allowed')
        target = path + ('?' + urllib.parse.urlencode(query) if query else '')
        for attempt in range(self.attempts):
            if self.load_guard: self.load_guard.check()
            try:
                if not getattr(self.local, 'connection', None):
                    self.local.connection = http.client.HTTPSConnection(
                        self.host, self.port, timeout=self.timeout, context=self.context)
                connection = self.local.connection
                connection.request('GET', target, headers={
                    'Authorization': 'apiKey ' + self.key, 'Accept': 'application/json'})
                response = connection.getresponse()
                payload = response.read()
                if response.status == 401:
                    raise rest.AuthenticationError('401 Unauthorized; stopping audit')
                if response.status != 200:
                    # Do not print a server response, which may contain confidential contents.
                    if response.status in (429, 500, 502, 503, 504) and attempt + 1 < self.attempts:
                        connection.close(); self.local.connection = None
                        time.sleep(min(10, 2 ** attempt)); continue
                    raise ReadError(f'GET {path}: HTTP {response.status}')
                return json.loads(payload), response.getheader('ETag'), response.getheader('Date')
            except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
                if getattr(self.local, 'connection', None):
                    self.local.connection.close(); self.local.connection = None
                if attempt + 1 == self.attempts:
                    raise ReadError(f'GET {path}: {type(error).__name__}: {error}') from None
                time.sleep(min(10, 2 ** attempt))
        raise ReadError('GET attempts exhausted')


def inventory(client, directory, suffix='', workers=8, search_query=None):
    result = []
    coverage = {}
    for kind in KINDS:
        destination = directory / f'inventory{suffix}-{kind}.json'
        if destination.exists():
            saved = json.loads(destination.read_text())
            result.extend(saved['rows']); coverage[kind] = saved['coverage']; continue
        seen = set(); rows = []; offset = 0; continuation = 'start'; mode = None
        totals = []; duplicates = 0
        while True:
            query = dict(resource_types=kind, version='all', publication_status='all',
                         sort='createdOnTS,name', limit=500)
            if search_query: query['q'] = search_query
            query.update({'continuation': continuation} if continuation else {'offset': offset})
            page, _, _ = client.get('/search-deep', query)
            if search_query and page.get('nodeListQueryType') != 'search-term':
                raise ReadError('index census unexpectedly used the graph route')
            total = page['totalCount']; resources = page['resources']
            if not totals or total != totals[-1]: totals.append(total)
            next_token = page.get('continuation')
            if mode is None:
                mode = 'continuation' if next_token or total <= len(resources) else 'offset'
                if mode == 'offset' and total > len(resources):
                    # Older production view-all is a graph query, not an index snapshot. Read the
                    # fixed offset windows in a bounded pool, then require exact unique coverage.
                    first_size = len(resources)
                    if first_size == 0: raise ReadError('empty initial page with a nonzero count')
                    def page_at(position):
                        params = dict(query)
                        params.pop('continuation', None)
                        params['offset'] = position
                        return client.get('/search-deep', params)[0]
                    with ThreadPoolExecutor(workers) as pool:
                        for page_number, following in enumerate(pool.map(page_at, range(first_size, total, first_size)), 1):
                            if following['totalCount'] != totals[-1]: totals.append(following['totalCount'])
                            resources.extend(following['resources'])
                            if page_number % 20 == 0:
                                print('inventory pages', kind, page_number, 'rows', len(resources), '/', total, flush=True)
                    total = totals[-1]
            added = 0
            for resource in resources:
                identifier = resource['@id']
                if identifier in seen: duplicates += 1; continue
                seen.add(identifier); added += 1
                rows.append({'kind': kind, 'id': identifier, 'name': resource.get('schema:name'),
                             'listing': metadata(resource), 'listedAt': now()})
            if resources and not added:
                raise ReadError(f'repeated inventory page for {kind}, offset {offset}')
            offset += len(resources)
            if not resources or (mode == 'continuation' and not next_token) or (
                    mode == 'offset' and offset >= total): break
            continuation = next_token if mode == 'continuation' else None
        counts = {'reportedTotals': totals, 'unique': len(rows), 'duplicates': duplicates,
                  'pagination': mode, 'complete': len(totals) == 1 and len(rows) == totals[0] and not duplicates}
        atomic(destination, {'coverage': counts, 'rows': rows})
        result.extend(rows); coverage[kind] = counts
        print('inventory', kind, json.dumps(counts), flush=True)
    atomic(directory / f'coverage{suffix}.json', coverage)
    return result, coverage


def inspect(client, row):
    record = dict(row, observedAt=now())
    path = ('/folders/' + urllib.parse.quote(rest.resource_path_id(row['id']), safe='')
            if row['kind'] == 'folder' else rest.typed_artifact_path(rest.ArtifactRef(row['kind'], row['id'])))
    try:
        graph, graph_etag, graph_date = client.get(path + '/details')
        record.update(graph=metadata(graph), graphEtag=graph_etag, graphDate=graph_date)
        record['listingGraphMismatch'] = compare(row['listing'], record['graph'])
    except (rest.AuthenticationError, ReadPressureError):
        raise
    except Exception as error:
        record['graphError'] = str(error)
    if row['kind'] != 'folder':
        try:
            body, etag, date = client.get(path)
            record.update(document=metadata(body), documentEtag=etag, documentDate=date,
                          documentSha256=digest(body), documentId=body.get('@id'))
            record['documentListingMismatch'] = compare(record['document'], row['listing'])
            if 'graph' in record:
                record['documentGraphMismatch'] = compare(record['document'], record['graph'])
            record['identityMismatch'] = body.get('@id') != row['id']
        except (rest.AuthenticationError, ReadPressureError):
            raise
        except Exception as error:
            record['documentError'] = str(error)
    record['complete'] = 'graphError' not in record and 'documentError' not in record
    return record


def summarize(records, coverage, started, status):
    by_kind = {}
    for kind in KINDS:
        rows = [r for r in records.values() if r['kind'] == kind]
        by_kind[kind] = {
            'observed': len(rows), 'complete': sum(r['complete'] for r in rows),
            'graphErrors': sum('graphError' in r for r in rows),
            'documentErrors': sum('documentError' in r for r in rows),
            'documentGraphMismatch': sum(bool(r.get('documentGraphMismatch')) for r in rows),
            'documentListingMismatch': sum(bool(r.get('documentListingMismatch')) for r in rows),
            'listingGraphMismatch': sum(bool(r.get('listingGraphMismatch')) for r in rows),
            'mismatchedProperties': dict(Counter(k for r in rows for k in r.get('documentGraphMismatch', []))),
            'graphModifierCounts': dict(Counter(str(r.get('graph', {}).get('oslc:modifiedBy')) for r in rows)),
            'graphModifiedDayCounts': dict(Counter(str(r.get('graph', {}).get('pav:lastUpdatedOn'))[:10] for r in rows)),
        }
    return {'status': status, 'startedAt': started, 'updatedAt': now(), 'readOnly': True,
            'coverage': coverage, 'byKind': by_kind, 'observed': len(records),
            'scope': 'All five resource types returned by /search-deep for the supplied account, all versions/publication states. User-home folders and database-only orphans require separate store-level enumeration.',
            'timestampComparison': 'Timezone-normalized instants truncated to seconds; original strings retained.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', default=rest.DEFAULT_SERVER)
    parser.add_argument('--api-key-file', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--index-only', action='store_true', help='enumerate independent indexed provenance through a tautological search')
    parser.add_argument('--monitor-server', help='monitor HTTPS origin; standard production is guarded automatically')
    parser.add_argument('--max-log-queue', type=int, default=100000)
    parser.add_argument('--max-log-lag', type=int, default=600, help='maximum logging lag in seconds')
    args = parser.parse_args()
    if not 1 <= args.workers <= 16: parser.error('workers must be between 1 and 16')
    if args.max_log_queue < 1 or args.max_log_lag < 1: parser.error('logging limits must be positive')
    try:
        return run(args, parser)
    except ReadPressureError as error:
        stopped = args.out / ('index-run.json' if args.index_only else 'summary.json')
        report = json.loads(stopped.read_text()) if stopped.exists() else {}
        observations, coverage_path = args.out / 'observations.jsonl', args.out / 'coverage.json'
        if not args.index_only and observations.exists() and coverage_path.exists():
            records = {}
            with observations.open() as stream:
                for line in stream:
                    record = json.loads(line); records[record['id']] = record
            report = summarize(records, json.loads(coverage_path.read_text()),
                               report.get('startedAt', now()), 'STOPPED_PRODUCTION_LOG_BACKPRESSURE')
        report.update(status='STOPPED_PRODUCTION_LOG_BACKPRESSURE', stoppedAt=now(),
                      readOnly=True, stopReason=str(error))
        atomic(stopped, report)
        print('STOPPED:', error, flush=True)
        return 2


def run(args, parser):
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=True)
    records_path = args.out / 'observations.jsonl'
    if records_path.exists() and not args.resume and not args.index_only: parser.error('output exists; use --resume')
    key = Path(args.api_key_file).read_text().strip()
    if not key or '\n' in key or '\r' in key: parser.error('key must be one nonempty line')
    client = PersistentGetClient(args.server, key)
    monitor_server = args.monitor_server or ('https://monitor.metadatacenter.org'
        if args.server.rstrip('/') == rest.DEFAULT_SERVER.rstrip('/') else None)
    if monitor_server:
        client.load_guard = ProductionLoadGuard(PersistentGetClient(monitor_server, key),
            args.out / 'load-guard.json', args.max_log_queue, args.max_log_lag)
        client.load_guard.check()
    started = now()
    if args.index_only:
        # A OR NOT A is a tautology, including artifacts whose fields are absent. q=* is routed
        # to Neo4j instead, so it cannot audit the independently stored search projection.
        query = 'cedarAuditProbe20261008 OR (NOT cedarAuditProbe20261008)'
        indexed, coverage = inventory(client, args.out, suffix='-index', workers=args.workers, search_query=query)
        atomic(args.out / 'index-run.json', {'startedAt': started, 'finishedAt': now(),
            'query': query, 'readOnly': True, 'rows': len(indexed), 'coverage': coverage})
        return
    atomic(args.out / 'run.json', {'startedAt': started, 'server': args.server,
        'workers': args.workers, 'limit': args.limit, 'readOnly': True,
        'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    records = {}
    if records_path.exists():
        for line in records_path.read_text().splitlines():
            record = json.loads(line); records[record['id']] = record
    rows, coverage = inventory(client, args.out, workers=args.workers)
    if args.limit: rows = rows[:args.limit]
    pending = [r for r in rows if not records.get(r['id'], {}).get('complete')]
    print('reading', len(pending), 'of', len(rows), 'resources', flush=True)
    with records_path.open('a') as output, ThreadPoolExecutor(args.workers) as pool:
        # Batches bound queued futures and make progress/checkpointing predictable.
        for offset in range(0, len(pending), 500):
            for record in pool.map(lambda row: inspect(client, row), pending[offset:offset + 500]):
                output.write(json.dumps(record, ensure_ascii=False) + '\n')
                records[record['id']] = record
            output.flush(); os.fsync(output.fileno())
            atomic(args.out / 'summary.json', summarize(records, coverage, started, 'RUNNING'))
            print('processed', len(records), '/', len(rows), 'at', now(), flush=True)
        failed = [r for r in rows if not records.get(r['id'], {}).get('complete')]
        if failed:
            print('retrying', len(failed), 'incomplete resources', flush=True)
            for record in pool.map(lambda row: inspect(client, row), failed):
                output.write(json.dumps(record, ensure_ascii=False) + '\n'); output.flush()
                records[record['id']] = record
    errors = sum(not r['complete'] for r in records.values())
    status = ('SAMPLE' if args.limit else 'COMPLETE' if not errors and all(
        c['complete'] for c in coverage.values()) and len(records) == len(rows) else 'COMPLETE_WITH_EXCEPTIONS')
    atomic(args.out / 'summary.json', summarize(records, coverage, started, status))
    print('finished', status, 'resources', len(records), 'unreadable', errors, flush=True)


if __name__ == '__main__':
    raise SystemExit(main())
