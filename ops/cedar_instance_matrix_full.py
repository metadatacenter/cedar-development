#!/usr/bin/env python3
"""GET-only full instance matrix with cached inventory/sources, resume, and final read retries."""
import argparse
import collections
import concurrent.futures
import dataclasses
import gzip
import json
import pathlib
import time

import cedar_instance_matrix_smoke as smoke

matrix = smoke.matrix
rest = matrix.rest
FLAGS = ('allFourProduced', 'allFourEqual', 'allFourSameGeneratedOrder', 'yamlByteEqual', 'allFourMatchSource')
LANES = tuple(f'{w}->{r}' for w in matrix.LANES for r in matrix.LANES)


def compact(record):
    if 'fetchError' in record:
        return {'source': 'unread', 'fetchError': record['fetchError']}
    return {'template': record.get('template'), 'source': record['sourceValidation']['status'],
            'flags': {k: record[k] for k in FLAGS},
            'completed': {lane: record['pairings'].get(lane, {}).get('completedValidation', {}).get('status', 'not-produced') for lane in LANES}}


def summarize(states):
    counts = collections.Counter()
    source = collections.Counter()
    completed = {lane: collections.Counter() for lane in LANES}
    for state in states.values():
        source[state['source']] += 1
        for key, value in state.get('flags', {}).items():
            counts[key] += bool(value)
        for lane, status in state.get('completed', {}).items():
            completed[lane][status] += 1
            if state['source'] == 'valid' and status != 'valid':
                counts[f'validSourceRegression:{lane}'] += 1
    return {'processed': len(states), 'flags': dict(counts), 'sourceValidation': dict(source),
            'completedValidation': {k: dict(v) for k, v in completed.items()}}


def fetch_ready(client, refs, fetch, workers=8):
    """Bounded read pool; ID-based resume does not require inventory-order delivery."""
    refs = iter(refs)
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    pending = {}
    def submit():
        ref = next(refs, None)
        if ref is not None:
            pending[pool.submit(fetch, client, ref)] = ref
    try:
        for _ in range(workers):
            submit()
        while pending:
            done, _ = concurrent.futures.wait(pending, timeout=rest.DEFAULT_WORKER_TIMEOUT,
                                             return_when=concurrent.futures.FIRST_COMPLETED)
            if not done:
                raise TimeoutError('All read workers stalled; resume from checkpoint')
            for future in done:
                ref = pending.pop(future)
                source, error = future.result()
                submit()
                yield ref, source, error
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--classpath', type=pathlib.Path, required=True)
    parser.add_argument('--library', required=True)
    parser.add_argument('--java', default='java')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--server', default='https://resource.metadatacenter.org')
    parser.add_argument('--key-file', type=pathlib.Path, default=pathlib.Path.home() / '.cedar-admin-key')
    args = parser.parse_args()
    root = args.directory
    root.mkdir(parents=True, exist_ok=args.resume)
    client = rest.GetOnlyClient(args.server, args.key_file.read_text().strip(), timeout=60, retries=3)
    pages = root / 'inventory-pages'
    pages.mkdir(exist_ok=True)
    manifest = root / 'inventory.json'
    if not manifest.exists():
        def page(offset):
            path = pages / f'{offset:06d}.json'
            if not path.exists():
                rest.atomic_write_json(path, rest.search_deep_page(client, 'instance', 500, offset, None))
            return json.loads(path.read_text())
        total = page(0)['totalCount']
        offsets = list(range(0, total, 500))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for i, _ in enumerate(pool.map(page, offsets), 1):
                if i % 20 == 0 or i == len(offsets):
                    print(f'Inventory pages {i}/{len(offsets)}', flush=True)
        refs, seen, duplicates, totals = [], set(), 0, set()
        for offset in offsets:
            data = page(offset)
            totals.add(data['totalCount'])
            for row in data['resources']:
                identifier = row['@id']
                if identifier in seen:
                    duplicates += 1
                else:
                    refs.append(rest.ArtifactRef('instance', identifier, row.get('schema:name', '')))
                    seen.add(identifier)
        inventory = {'reported': total, 'enumerated': len(refs), 'duplicateRowsSkipped': duplicates,
                     'pageTotals': sorted(totals), 'refs': [dataclasses.asdict(r) for r in refs]}
        rest.atomic_write_json(manifest, inventory)
    else:
        inventory = json.loads(manifest.read_text())
        refs = [rest.ArtifactRef(**r) for r in inventory['refs']]
    if inventory['enumerated'] != inventory['reported'] or len(inventory['pageTotals']) != 1:
        raise RuntimeError('Inventory coverage changed; reconcile inventory before claiming a full run')
    print(f'Inventory complete: {len(refs)} distinct instances', flush=True)
    sources = root / 'sources'
    sources.mkdir(exist_ok=True)
    templates_dir = root / 'templates'
    templates_dir.mkdir(exist_ok=True)
    states = {}
    records_path = root / 'records.jsonl'
    if args.resume and records_path.exists():
        with records_path.open() as stream:
            for line in stream:
                record = json.loads(line)
                states[record['id']] = compact(record)
    cp = args.classpath.read_text().strip()
    bridges = {
        'java': matrix.Bridge('java', [args.java, '-cp', cp, str(matrix.OPS / 'cedar_yaml_convert_bridge.java')]),
        'typescript': matrix.Bridge('typescript', ['node', str(matrix.OPS / 'cedar_yaml_convert_bridge.cjs'), '--lib', args.library]),
    }
    validator = matrix.Bridge('validator', [args.java, '-cp', cp, str(matrix.OPS / 'cedar_validation_bridge.java'), '--template-cache', '10000'])
    templates, missing_templates = {}, {}
    started, initial = time.time(), len(states)
    def load_template(identifier):
        if not identifier or identifier in templates or identifier in missing_templates:
            return
        path = templates_dir / (identifier.rsplit('/', 1)[-1] + '.json')
        try:
            if path.exists():
                template = json.loads(path.read_text())
            else:
                template = client.get_json(rest.typed_artifact_path(rest.ArtifactRef('template', identifier, '')))
                rest.atomic_write_json(path, template)
            answer = validator.ask({'op': 'cache-template', 'id': identifier, 'template': template})
            if answer['status'] != 'ok':
                raise RuntimeError(str(answer))
            templates[identifier] = template
        except Exception as error:
            missing_templates[identifier] = str(error)
    def fetch(cl, ref):
        path = sources / (ref.artifact_id.rsplit('/', 1)[-1] + '.json.gz')
        if path.exists():
            with gzip.open(path, 'rt') as stream:
                return json.load(stream), None
        source, error = rest.fetch_artifact(cl, ref)
        if error is None:
            temp = path.with_suffix('.tmp')
            with gzip.open(temp, 'wt') as stream:
                json.dump(source, stream, ensure_ascii=False)
            temp.replace(path)
        return source, error
    def checkpoint(status):
        doc = summarize(states)
        doc.update({'status': status, 'inventory': {k: v for k, v in inventory.items() if k != 'refs'},
                    'templatesLoaded': sum(1 for _ in templates_dir.glob('*.json')),
                    'templatesLoadedInFinalProcess': len(templates), 'missingTemplates': missing_templates,
                    'elapsedThisRunSeconds': round(time.time() - started, 1)})
        rest.atomic_write_json(root / 'summary.json', doc)
    try:
        with records_path.open('a') as out:
            def process(pending, retry=False):
                for ref, source, error in fetch_ready(client, pending, fetch):
                    if error:
                        record = {'id': ref.artifact_id, 'name': ref.name, 'fetchError': str(error)}
                    else:
                        identifier = source.get('schema:isBasedOn')
                        load_template(identifier)
                        record, outputs, yamls = smoke.evaluate_instance(bridges, validator, templates, ref, source)
                        regression = record['sourceValidation']['status'] == 'valid' and any(
                            record['pairings'].get(lane, {}).get('completedValidation', {}).get('status') != 'valid' for lane in LANES)
                        problem = not all(record[k] for k in FLAGS[:4]) or regression or record['sourceValidation']['status'] != 'valid'
                        if problem:
                            folder = root / 'issues' / ref.artifact_id.rsplit('/', 1)[-1]
                            folder.mkdir(parents=True, exist_ok=True)
                            (folder / 'source.json').write_text(json.dumps(source, ensure_ascii=False, indent=2))
                            (folder / 'result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2))
                            for lane, value in outputs.items():
                                (folder / (lane.replace('->', '-') + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2))
                            for lane, value in yamls.items():
                                (folder / (lane + '.yaml')).write_text(value)
                    record['retry'] = retry
                    out.write(json.dumps(record, ensure_ascii=False) + '\n')
                    out.flush()
                    states[ref.artifact_id] = compact(record)
                    if len(states) % 500 == 0 or retry:
                        checkpoint('running')
                        rate = (len(states) - initial) / max(time.time() - started, .001)
                        print(f'{len(states)}/{len(refs)} processed; {rate:.1f}/s; issues retained; retry={retry}', flush=True)
            process([r for r in refs if r.artifact_id not in states])
            retry_ids = {k for k, v in states.items() if v['source'] == 'unread'}
            print(f'Final retry: {len(retry_ids)} unread instances', flush=True)
            process([r for r in refs if r.artifact_id in retry_ids], retry=True)
            # Recheck failures to fetch a template, then reevaluate affected instances if recovered.
            failed_templates = set(missing_templates)
            for identifier in list(missing_templates):
                del missing_templates[identifier]
                load_template(identifier)
            recovered = failed_templates - set(missing_templates)
            process([r for r in refs if states[r.artifact_id].get('template') in recovered], retry=True)
        checkpoint('complete')
        print(json.dumps(json.loads((root / 'summary.json').read_text()), indent=2), flush=True)
    finally:
        validator.close()
        for bridge in bridges.values():
            bridge.close()


if __name__ == '__main__':
    main()
