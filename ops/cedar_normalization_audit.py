#!/usr/bin/env python3
"""GET-only inventory of repairInheritedDefects, evaluated by the actual Java implementation.

Stages enumerate, fetch and analyze are resumable. Use a new directory for a fresh
measurement. Analyze uses a caller-supplied frozen Java classpath, including the
config library; it never calls a production write or general identity minting.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import http.client
import io
import json
import pathlib
import ssl
import sqlite3
import threading
import urllib.error
import urllib.parse

import cedar_artifact_rest_audit as rest
import cedar_artifact_validation_audit as validation
from cedar_schema_matrix_audit import pack, unpack

KINDS = ('template', 'element', 'field', 'instance')


class _KeepAliveTransport:
    """One verified connection per worker; HTTP errors go through the shared retry policy."""
    def __init__(self, origin, ca_file=None):
        self.origin = urllib.parse.urlsplit(origin)
        self.context = ssl.create_default_context(cafile=ca_file)
        self.local = threading.local()

    def open(self, request, timeout):
        target = urllib.parse.urlsplit(request.full_url)
        if request.get_method() != 'GET' or (target.scheme, target.netloc) != (self.origin.scheme, self.origin.netloc):
            raise ValueError('only same-origin GET requests are allowed')
        connection = getattr(self.local, 'connection', None)
        if connection is None:
            cls = http.client.HTTPSConnection if target.scheme == 'https' else http.client.HTTPConnection
            options = {'context': self.context} if target.scheme == 'https' else {}
            connection = cls(target.hostname, target.port, timeout=timeout, **options)
            self.local.connection = connection
        try:
            path = urllib.parse.urlunsplit(('', '', target.path or '/', target.query, ''))
            connection.request('GET', path, headers=dict(request.header_items()))
            response = connection.getresponse()
            headers, status, reason = response.headers, response.status, response.reason
            body = response.read() if 200 <= status < 300 else response.read(4000)
            response.close()
            if not 200 <= status < 300:
                connection.close()
                self.local.connection = None
                # Never follow redirects, including to the same host.
                raise urllib.error.HTTPError(request.full_url, status, reason, headers, io.BytesIO(body))
            result = io.BytesIO(body)
            result.headers = headers
            return result
        except urllib.error.HTTPError:
            raise
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            self.local.connection = None
            raise urllib.error.URLError(error) from None


class KeepAliveGetOnlyClient(rest.GetOnlyClient):
    def __init__(self, server, api_key, **kwargs):
        super().__init__(server, api_key, **kwargs)
        self.opener = _KeepAliveTransport(self.server, kwargs.get("ca_file"))


def runtime_digest(source, classpath):
    """Pin dependency bytes, not just the paths that a Maven rebuild can overwrite."""
    digest = hashlib.sha256(source.read_bytes())
    for entry in classpath.read_text().strip().split(':'):
        path = pathlib.Path(entry)
        if not path.exists():
            raise ValueError('missing classpath entry: ' + str(path))
        digest.update(str(path).encode())
        for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
            if file.is_file():
                digest.update(str(file).encode())
                with file.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
    return digest.hexdigest()


def enumeration_complete(metadata):
    return (metadata['count'] == metadata['expected'] and not metadata['listingErrors']
            and metadata.get('inventoryCount', metadata['count']) == metadata['count']
            and not metadata['duplicates'] and not metadata['totalCountChanges'])


def enumerate_kind(client, kind, workers=4):
    """Use snapshots when served; bounded parallel offsets on older deployments.

    Offset pagination is not a snapshot. Reject duplicate/missing rows and changed
    totals, and retain that limitation in the evidence instead of claiming one.
    """
    first = rest.search_deep_page(client, kind, 500, continuation=rest.SEARCH_CONTINUATION_START)
    if first.get('continuation'):
        state = rest.AuditState()
        refs = list(rest.iter_artifact_refs(client, kind, 500, state))
        return refs, {'count': len(refs), 'expected': state.expected_by_type.get(kind),
                      'listingErrors': state.listing_errors, 'duplicates': state.duplicates,
                      'totalCountChanges': [x for x in state.total_count_changes if x['was'] is not None],
                      'pagination': state.pagination_by_type.get(kind)}
    total = first['totalCount']
    page_size = len(first['resources'])
    if not page_size and total:
        raise RuntimeError('Nonempty inventory returned an empty first page')
    refs, seen, duplicates, errors, changes = [], set(), 0, 0, []

    def consume(page):
        nonlocal duplicates, errors
        if page['totalCount'] != total:
            changes.append({'was': total, 'now': page['totalCount']})
        for row in page['resources']:
            identifier = row.get('@id') if isinstance(row, dict) else None
            if not isinstance(identifier, str) or not identifier:
                errors += 1
            elif identifier in seen:
                duplicates += 1
            else:
                seen.add(identifier)
                refs.append(rest.ArtifactRef(kind, identifier))

    consume(first)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for page in pool.map(lambda offset: rest.search_deep_page(client, kind, page_size, offset=offset),
                             range(page_size, total, page_size or 1)):
            consume(page)
            if len(refs) % 5000 == 0:
                print('enumerating', kind, len(refs), '/', total, flush=True)
    end_total = rest.search_deep_page(client, kind, 1, offset=0)['totalCount']
    if end_total != total:
        changes.append({'was': total, 'now': end_total})
    return refs, {'count': len(refs), 'expected': total, 'listingErrors': errors,
                  'duplicates': duplicates, 'totalCountChanges': changes, 'pagination': 'parallel-offset'}


def summarize(db):
    artifacts, occurrences, outcomes = collections.Counter(), collections.Counter(), collections.Counter()
    for kind, result in db.execute('SELECT kind,result FROM artifacts WHERE result IS NOT NULL'):
        row = unpack(result)
        outcomes[kind + ':' + row['status']] += 1
        if row.get('status') != 'ok' or row.get('complete') is not True:
            outcomes['incomplete'] += 1
        issues = [r['issue'] for r in row.get('repairs', [])]
        artifacts.update(set(issues))
        occurrences.update(issues)
    coverage = [dict(zip(('kind', 'enumerated', 'fetched', 'analyzed'), row)) for row in db.execute(
        'SELECT kind,count(*),sum(source IS NOT NULL),sum(result IS NOT NULL) FROM artifacts GROUP BY kind')]
    enumerations = {k: json.loads(v) for k, v in db.execute("SELECT key,value FROM metadata WHERE key LIKE 'enumerated_%'")}
    complete = (len(enumerations) == len(KINDS) and all(enumeration_complete(v) for v in enumerations.values())
                and all(c['enumerated'] == c['fetched'] == c['analyzed'] for c in coverage)
                and not outcomes['incomplete'])
    return {'scope': 'API-key-visible search inventory; not a transactional store snapshot',
            'complete': complete, 'coverage': coverage, 'outcomes': dict(outcomes),
            'artifactCounts': dict(artifacts), 'occurrenceCounts': dict(occurrences),
            'enumeration': enumerations}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=pathlib.Path, required=True)
    p.add_argument('--stage', choices=['enumerate', 'fetch', 'analyze'], required=True)
    p.add_argument('--server', default=rest.DEFAULT_SERVER)
    p.add_argument('--api-key-file', type=pathlib.Path)
    p.add_argument('--classpath', type=pathlib.Path,
                   help='File containing a frozen pre-retirement config-library classpath (not the current build)')
    p.add_argument('--java')
    p.add_argument('--workers', type=int, default=12)
    p.add_argument('--enumeration-workers', type=int, default=4)
    args = p.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(args.directory / 'corpus.sqlite', timeout=180)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,kind TEXT,source BLOB,fetch_error TEXT,result BLOB)')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT)')
    origin = db.execute("SELECT value FROM metadata WHERE key='server'").fetchone()
    if origin and origin[0] != args.server:
        p.error('cannot mix server origins in an audit directory')
    db.execute("INSERT OR IGNORE INTO metadata VALUES ('server',?)", (args.server,))
    db.commit()
    if args.stage in ('enumerate', 'fetch'):
        if not args.api_key_file:
            p.error('--api-key-file is required for network stages')
        client = KeepAliveGetOnlyClient(args.server, args.api_key_file.expanduser().read_text().strip(), timeout=45, retries=3)
    if args.stage == 'enumerate':
        for kind in KINDS:
            if db.execute('SELECT 1 FROM metadata WHERE key=?', ('enumerated_' + kind,)).fetchone():
                continue
            refs, entry = enumerate_kind(client, kind, args.enumeration_workers)
            for count, ref in enumerate(refs, 1):
                db.execute('INSERT OR IGNORE INTO artifacts (id,kind) VALUES (?,?)', (ref.artifact_id, kind))
                count += 1
                if count % 1000 == 0:
                    db.commit()
                    print('enumerated', kind, count, flush=True)
            entry['at'] = validation.utc_now()
            entry['inventoryCount'] = db.execute('SELECT count(*) FROM artifacts WHERE kind=?', (kind,)).fetchone()[0]
            if not enumeration_complete(entry):
                raise RuntimeError('Incomplete enumeration: ' + json.dumps(entry))
            db.execute('INSERT INTO metadata VALUES (?,?)', ('enumerated_' + kind, json.dumps(entry)))
            db.commit()
    elif args.stage == 'fetch':
        refs = [rest.ArtifactRef(kind, identifier) for identifier, kind in db.execute(
            'SELECT id,kind FROM artifacts WHERE source IS NULL')]
        batch = []
        for number, (ref, body, error) in enumerate(rest.fetch_in_order(client, refs, args.workers), 1):
            if error is None and (not isinstance(body, dict) or body.get('@id') != ref.artifact_id):
                error = ValueError('artifact body does not match the requested identity')
            batch.append((pack(body) if error is None else None, str(error) if error else None, ref.artifact_id))
            if number % 500 == 0:
                db.executemany('UPDATE artifacts SET source=?,fetch_error=? WHERE id=?', batch)
                db.commit()
                batch.clear()
                print('fetched', number, '/', len(refs), flush=True)
        db.executemany('UPDATE artifacts SET source=?,fetch_error=? WHERE id=?', batch)
        db.commit()
    else:
        if not args.classpath:
            p.error('--classpath is required for analyze')
        source = pathlib.Path(__file__).with_name('cedar_normalization_bridge.java')
        content_signature = runtime_digest(source, args.classpath)
        content_prior = db.execute("SELECT value FROM metadata WHERE key='runtimeContentSha256'").fetchone()
        if content_prior and content_prior[0] != content_signature:
            p.error('dependency bytes changed; use a fresh audit directory')
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('runtimeContentSha256',?)", (content_signature,))
        signature = hashlib.sha256(source.read_bytes() + args.classpath.read_bytes()).hexdigest()
        prior = db.execute("SELECT value FROM metadata WHERE key='runtime'").fetchone()
        if prior and prior[0] != signature:
            p.error('runtime changed; use a fresh audit directory')
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('runtime',?)", (signature,))
        db.commit()
        java = args.java or validation.run_validate_sh("java", 60)
        bridge = validation.LineBridge([java, '-Xmx2g', '-cp', args.classpath.read_text().strip(), str(source)],
                                       args.directory / 'java.log', 180)
        bridge.start()
        batch = []
        try:
            ids = db.execute('SELECT id,kind FROM artifacts WHERE source IS NOT NULL AND result IS NULL').fetchall()
            for number, (identifier, kind) in enumerate(ids, 1):
                body = unpack(db.execute('SELECT source FROM artifacts WHERE id=?', (identifier,)).fetchone()[0])
                if not isinstance(body, dict) or body.get('@id') != identifier:
                    result = {'status': 'identity-mismatch', 'complete': False}
                    batch.append((pack(result), identifier))
                    continue
                template = None
                if kind == 'instance' and isinstance(body, dict):
                    row = db.execute("SELECT source FROM artifacts WHERE id=? AND kind='template'",
                                     (body.get('schema:isBasedOn') if isinstance(body.get('schema:isBasedOn'), str) else None,)).fetchone()
                    if row and row[0]:
                        template = unpack(row[0])
                result = bridge.request({'op': 'audit', 'kind': kind, 'artifact': body, 'template': template})
                batch.append((pack(result), identifier))
                if number % 1000 == 0:
                    db.executemany('UPDATE artifacts SET result=? WHERE id=?', batch)
                    db.commit()
                    batch.clear()
                    print('analyzed', number, '/', len(ids), flush=True)
        finally:
            bridge.close()
            db.executemany('UPDATE artifacts SET result=? WHERE id=?', batch)
            db.commit()
        if runtime_digest(source, args.classpath) != content_signature:
            db.execute('UPDATE artifacts SET result=NULL')
            db.commit()
            raise RuntimeError('Dependency bytes changed during analysis; results discarded')
        with (args.directory / 'findings.jsonl').open('w') as out:
            for identifier, kind, result in db.execute('SELECT id,kind,result FROM artifacts WHERE result IS NOT NULL'):
                row = unpack(result)
                if row.get('repairs') or not row.get('complete'):
                    out.write(json.dumps({'artifactId': identifier, 'artifactType': kind, **row}) + '\n')
        (args.directory / 'summary.json').write_text(json.dumps(summarize(db), indent=2) + '\n')
    db.close()


if __name__ == '__main__':
    main()
