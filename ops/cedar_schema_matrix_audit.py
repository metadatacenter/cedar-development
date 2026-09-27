#!/usr/bin/env python3
"""Resumable, GET-only stored JSON / Java YAML / TS YAML four-path schema audit.

Sources and results are compressed in SQLite. Enumeration, fetching and conversion
are separate resumable stages; --reset-results rechecks the cached corpus after a
library change. The TypeScript bundle is copied into the evidence directory.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import pathlib
import shutil
import sqlite3
import subprocess
import threading
import zlib

import cedar_artifact_rest_audit as rest
import cedar_artifact_validation_audit as audit


def pack(value):
    return zlib.compress(json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode())


def unpack(value):
    return json.loads(zlib.decompress(value))


def encoded(value, sort=False):
    return json.dumps(value, sort_keys=sort, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def comparison_flags(outputs, rendered, source, validations):
    """Content, array order, generated object order and YAML bytes are separate gates."""
    result = {}
    result['allFourProduced'] = len(outputs) == 4
    result['allFourEqual'] = len(outputs) == 4 and len(validations) == 1
    result['allFourValid'] = len(outputs) == 4 and all(x['status'] == 'valid' for x in validations.values())
    result['allFourSameGeneratedOrder'] = len(outputs) == 4 and len({encoded(v) for v in outputs.values()}) == 1
    result['yamlByteEqual'] = all(v.get('status') == 'ok' for v in rendered.values()) and rendered['Java']['yaml'] == rendered['TS']['yaml']
    result['allFourMatchSource'] = result['allFourEqual'] and encoded(source, sort=True) in validations
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--classpath', type=pathlib.Path, required=True)
    parser.add_argument('--ts-library', type=pathlib.Path, required=True)
    parser.add_argument('--key-file', type=pathlib.Path, default=pathlib.Path.home() / '.cedar-admin-key')
    parser.add_argument('--stage', choices=['enumerate', 'fetch', 'convert'], required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--reset-results', action='store_true')
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(args.directory / 'corpus.sqlite', timeout=180)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, kind TEXT, name TEXT, source BLOB, fetch_error TEXT, result BLOB, evidence BLOB)')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)')
    if args.stage == 'enumerate':
        client = rest.GetOnlyClient(rest.DEFAULT_SERVER, args.key_file.read_text().strip(), timeout=60, retries=3)
        state = rest.AuditState()
        for kind in ['template', 'element', 'field']:
            if db.execute('SELECT 1 FROM metadata WHERE key=?', ('enumerated_' + kind,)).fetchone():
                continue
            count = 0
            for ref in rest.iter_artifact_refs(client, kind, 500, state):
                db.execute('INSERT OR IGNORE INTO artifacts (id,kind,name) VALUES (?,?,?)', (ref.artifact_id, kind, ref.name))
                count += 1
                if count % 500 == 0:
                    db.commit()
                    print('enumerated', kind, count, flush=True)
            metadata = {'count': count, 'expected': state.expected_by_type.get(kind), 'pagination': state.pagination_by_type.get(kind), 'listingErrors': state.listing_errors, 'duplicates': state.duplicates}
            if count != metadata['expected'] or state.listing_errors:
                raise RuntimeError('Incomplete enumeration: ' + encoded(metadata))
            db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('enumerated_' + kind, encoded(metadata)))
            db.commit()
        return
    if args.stage == 'fetch':
        key = args.key_file.read_text().strip()
        local = threading.local()
        def fetch(row):
            if not hasattr(local, 'client'):
                local.client = rest.GetOnlyClient(rest.DEFAULT_SERVER, key, timeout=45, retries=3)
            artifact_id, kind = row
            try:
                value = local.client.get_json(rest.typed_artifact_path(rest.ArtifactRef(kind, artifact_id)))
                return artifact_id, pack(value), None
            except Exception as exc:
                return artifact_id, None, str(exc)
        pending = db.execute('SELECT id,kind FROM artifacts WHERE source IS NULL').fetchall()
        counts = collections.Counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            # Bounded batches avoid retaining the entire fetched corpus in executor futures.
            for offset in range(0, len(pending), 500):
                for artifact_id, source, error in list(pool.map(fetch, pending[offset:offset + 500])):
                    db.execute('UPDATE artifacts SET source=?,fetch_error=? WHERE id=?', (source, error, artifact_id))
                    counts['fetched' if source else 'failed'] += 1
                db.commit()
                print('fetch', min(offset + 500, len(pending)), '/', len(pending), dict(counts), flush=True)
        return
    if args.reset_results:
        db.execute('UPDATE artifacts SET result=NULL,evidence=NULL')
        db.commit()
    bundle = args.directory / 'typescript.cjs'
    source_hash = hashlib.sha256(args.ts_library.read_bytes()).hexdigest()
    prior = db.execute("SELECT value FROM metadata WHERE key='bundleSha256'").fetchone()
    if prior and prior[0] != source_hash and not args.reset_results:
        raise RuntimeError('Library changed; use --reset-results to recheck the cached corpus')
    shutil.copyfile(args.ts_library, bundle)
    db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('bundleSha256', source_hash))
    ops = pathlib.Path(__file__).resolve().parent
    root = ops.parent.parent
    revisions = {repo: subprocess.check_output(['git', '-C', str(root / repo), 'rev-parse', 'HEAD'], text=True).strip() for repo in ['cedar-artifact-library', 'cedar-model-typescript-library', 'cedar-model-validation-library', 'cedar-development']}
    previous_revisions = db.execute("SELECT value FROM metadata WHERE key='revisions'").fetchone()
    if previous_revisions and not args.reset_results:
        old = json.loads(previous_revisions[0])
        if any(old.get(repo) != revisions[repo] for repo in ['cedar-artifact-library', 'cedar-model-validation-library']):
            raise RuntimeError('Java library changed; use --reset-results to recheck the cached corpus')
    db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('revisions', encoded(revisions)))
    db.commit()
    java = audit.run_validate_sh('java', 60)
    cp = args.classpath.read_text().strip()
    local = threading.local()
    all_bridges = []
    lock = threading.Lock()
    def bridges():
        if not hasattr(local, 'bridges'):
            worker = threading.current_thread().name.replace('_', '-')
            j = audit.LineBridge([java, '-Xmx1500m', '-cp', cp, str(ops / 'cedar_yaml_convert_bridge.java')], args.directory / (worker + '-java.log'), 120)
            t = audit.LineBridge(['node', str(ops / 'cedar_yaml_convert_bridge.cjs'), '--lib', str(bundle)], args.directory / (worker + '-ts.log'), 120)
            try:
                j.start()
                t.start()
            except Exception:
                j.kill()
                t.kill()
                raise
            local.bridges = {'Java': j, 'TS': t}
            with lock:
                all_bridges.extend([j, t])
        return local.bridges
    def convert(row):
        artifact_id, kind, name, source_blob = row
        source = unpack(source_blob)
        result = {'id': artifact_id, 'kind': kind, 'name': name}
        for attempt in range(2):
            try:
                bs = bridges()
                result['sourceValidation'] = bs['Java'].request({'op': 'validate', 'kind': kind, 'artifact': source})
                rendered = {author: bridge.request({'op': 'render', 'kind': kind, 'json': source, 'compact': False}) for author, bridge in bs.items()}
                outputs = {}
                result['render'] = {author: {k: v for k, v in answer.items() if k not in ['yaml', 'seq']} for author, answer in rendered.items()}
                result['lanes'] = {}
                validations = {}
                for author, answer in rendered.items():
                    for reader, bridge in bs.items():
                        lane = author + ' YAML → ' + reader + ' JSON'
                        if answer.get('status') != 'ok':
                            result['lanes'][lane] = {'status': 'blocked'}
                            continue
                        converted = bridge.request({'op': 'convert', 'kind': kind, 'yaml': answer['yaml'], 'compact': False, 'includeJsonText': True})
                        if 'jsonText' in converted:
                            converted['json'] = json.loads(converted.pop('jsonText'))
                        detail = {k: v for k, v in converted.items() if k not in ['json', 'seq']}
                        if converted.get('status') == 'ok':
                            outputs[lane] = converted['json']
                            canonical = encoded(converted['json'], sort=True)
                            if canonical not in validations:
                                validations[canonical] = bs['Java'].request({'op': 'validate', 'kind': kind, 'artifact': converted['json']})
                            detail['validation'] = validations[canonical]
                        result['lanes'][lane] = detail
                result.update(comparison_flags(outputs, rendered, source, validations))
                result['readerDiagnostics'] = any(v.get('readErrors') or v.get('readWarnings') for v in list(result['render'].values()) + list(result['lanes'].values()))
                result['passed'] = all(result[k] for k in ['allFourProduced', 'allFourEqual', 'allFourValid', 'allFourSameGeneratedOrder', 'yamlByteEqual'])
                evidence = None if result['passed'] else pack({'source': source, 'yaml': rendered, 'outputs': outputs})
                return artifact_id, pack(result), evidence
            except Exception as exc:
                for b in getattr(local, 'bridges', {}).values():
                    b.kill()
                if hasattr(local, 'bridges'):
                    del local.bridges
                if attempt:
                    result['infrastructureError'] = str(exc)
                    result['passed'] = False
                    return artifact_id, pack(result), None
    pending_ids = [x[0] for x in db.execute('SELECT id FROM artifacts WHERE source IS NOT NULL AND result IS NULL')]
    counts = collections.Counter()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            for offset in range(0, len(pending_ids), 100):
                rows = [db.execute('SELECT id,kind,name,source FROM artifacts WHERE id=?', (artifact_id,)).fetchone() for artifact_id in pending_ids[offset:offset + 100]]
                for artifact_id, result_blob, evidence in list(pool.map(convert, rows)):
                    db.execute('UPDATE artifacts SET result=?,evidence=? WHERE id=?', (result_blob, evidence, artifact_id))
                    row = unpack(result_blob)
                    for key in ['passed', 'allFourProduced', 'allFourEqual', 'allFourValid', 'allFourSameGeneratedOrder', 'yamlByteEqual', 'readerDiagnostics']:
                        counts[key] += int(row.get(key, False))
                db.commit()
                print('convert', min(offset + 100, len(pending_ids)), '/', len(pending_ids), dict(counts), flush=True)
    finally:
        for b in all_bridges:
            b.close()
    totals = collections.Counter()
    failures = []
    for blob, in db.execute('SELECT result FROM artifacts WHERE result IS NOT NULL'):
        row = unpack(blob)
        totals['processed'] += 1
        totals['source_' + row.get('sourceValidation', {}).get('status', 'unknown')] += 1
        for key, value in row.items():
            if isinstance(value, bool):
                totals[key] += int(value)
        if not row['passed']:
            failures.append(row)
    (args.directory / 'summary.json').write_text(json.dumps(dict(totals), indent=2))
    (args.directory / 'failures.json').write_text(json.dumps(failures, indent=2))
    print(dict(totals), flush=True)


if __name__ == '__main__':
    main()
