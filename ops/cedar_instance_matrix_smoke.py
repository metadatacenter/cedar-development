#!/usr/bin/env python3
"""GET-only instance smoke: stored JSON through both YAML writers and both JSON readers.

Retains source documents, templates and every rendering in an ignored evidence directory.
Generated JSON is validated as emitted; template completion is deliberately not implicit.
"""
import argparse
import collections
import concurrent.futures
import difflib
import json
import pathlib
import random

import cedar_stored_json_matrix_audit as matrix


def encoded(value, sort=False):
    return json.dumps(value, sort_keys=sort, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def run(args):
    directory = args.directory
    directory.mkdir(parents=True, exist_ok=False)
    fetched = []
    if args.sources:
        folders = sorted(args.sources.glob('*/source.json'))[:args.limit]
        sources = []
        for file in folders:
            source = json.loads(file.read_text())
            sources.append((matrix.rest.ArtifactRef('instance', source['@id'], source.get('schema:name', '')), source))
        templates = json.loads((args.sources / 'templates.json').read_text())
        (directory / 'selection.json').write_text(json.dumps({'replayedFrom': str(args.sources.resolve()),
            'ids': [ref.artifact_id for ref, _ in sources]}, indent=2))
    else:
        client = matrix.rest.GetOnlyClient('https://resource.metadatacenter.org',
            args.key_file.read_text().strip(), timeout=60, retries=3)
        if args.random_seed is not None:
            total = matrix.rest.search_deep_page(client, 'instance', 1, 0, None)['totalCount']
            positions = random.Random(args.random_seed).sample(range(total), min(total, args.limit + 100))
            offsets = sorted({position // 500 * 500 for position in positions})
            def fetch_page(offset):
                return offset, matrix.rest.search_deep_page(client, 'instance', 500, offset, None)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                pages = dict(pool.map(fetch_page, offsets))
            rows = [pages[position // 500 * 500]['resources'][position % 500] for position in positions]
            if len({row['@id'] for row in rows}) != len(rows):
                raise RuntimeError('Search index shifted or returned duplicate IDs; retry the random selection')
            selection = {'method': 'uniform random search-index positions without replacement; spare candidates replace unreadable entries',
                'seed': args.random_seed, 'totalIndexed': total, 'positions': positions,
                'pageTotals': sorted({page['totalCount'] for page in pages.values()}), 'resources': rows}
        else:
            page = matrix.rest.search_deep_page(client, 'instance', min(500, args.limit * 2), 0, None)
            rows = page['resources']
            selection = {'method': 'first search-deep page; smoke sample, not random or representative',
                'totalIndexed': page['totalCount'], 'resources': rows}
        (directory / 'selection.json').write_text(json.dumps(selection, indent=2))
        refs = [matrix.rest.ArtifactRef('instance', row['@id'], row.get('schema:name', '')) for row in rows]
        def fetch(ref):
            try:
                return ref, client.get_json(matrix.rest.typed_artifact_path(ref)), None
            except Exception as error:
                return ref, None, str(error)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            fetched = list(pool.map(fetch, refs))
        sources = [(ref, source) for ref, source, error in fetched if not error][:args.limit]
        if len(sources) != args.limit:
            raise RuntimeError(f'Requested {args.limit} readable instances but obtained {len(sources)}')
        (directory / 'fetch-errors.json').write_text(json.dumps([{'id': ref.artifact_id, 'error': error}
            for ref, source, error in fetched if error], indent=2))
        templates = {}
        template_errors = []
        def fetch_template(identifier):
            try:
                return identifier, client.get_json(matrix.rest.typed_artifact_path(
                    matrix.rest.ArtifactRef('template', identifier, ''))), None
            except Exception as error:
                return identifier, None, str(error)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for identifier, template, error in pool.map(fetch_template, sorted({s['schema:isBasedOn'] for _, s in sources})):
                if error:
                    template_errors.append({'id': identifier, 'error': error})
                else:
                    templates[identifier] = template
        (directory / 'template-fetch-errors.json').write_text(json.dumps(template_errors, indent=2))
        print(f'Fetched {len(sources)} instances and {len(templates)} templates; {len(template_errors)} unavailable templates', flush=True)
    (directory / 'templates.json').write_text(json.dumps(templates, ensure_ascii=False, indent=2))
    cp = args.classpath.read_text().strip()
    bridges = {}
    results = []
    try:
        bridges['java'] = matrix.Bridge('java', [args.java, '-cp', cp,
            str(matrix.OPS / 'cedar_yaml_convert_bridge.java')])
        bridges['typescript'] = matrix.Bridge('typescript', ['node',
            str(matrix.OPS / 'cedar_yaml_convert_bridge.cjs'), '--lib', str(args.library)])
        validator = matrix.Bridge('validator', [args.java, '-cp', cp,
            str(matrix.OPS / 'cedar_validation_bridge.java'), '--template-cache', str(max(200, len(templates)))])
        bridges['validator'] = validator
        for identifier, template in templates.items():
            assert validator.ask({'op': 'cache-template', 'id': identifier, 'template': template})['status'] == 'ok'
        for index, (ref, source) in enumerate(sources, 1):
            folder = directory / ref.artifact_id.rsplit('/', 1)[-1]
            folder.mkdir()
            (folder / 'source.json').write_text(json.dumps(source, ensure_ascii=False, indent=2))
            def validate(value):
                return validator.ask({'op': 'validate', 'kind': 'instance',
                    'templateId': source['schema:isBasedOn'], 'artifact': value})
            record = {'id': ref.artifact_id, 'name': ref.name, 'template': source['schema:isBasedOn'],
                'sourceValidation': validate(source), 'rendered': {}, 'pairings': {}}
            outputs = {}
            yamls = {}
            for writer in matrix.LANES:
                answer = bridges[writer].ask({'op': 'render', 'kind': 'instance', 'json': source, 'compact': False})
                record['rendered'][writer] = {k: v for k, v in answer.items() if k != 'yaml'}
                if answer['status'] != 'ok':
                    continue
                yamls[writer] = answer['yaml']
                (folder / f'{writer}.yaml').write_text(answer['yaml'])
                for reader in matrix.LANES:
                    lane = f'{writer}->{reader}'
                    converted = bridges[reader].ask({'op': 'convert', 'kind': 'instance',
                        'yaml': answer['yaml'], 'compact': False, 'includeJsonText': True})
                    result = {k: v for k, v in converted.items() if k not in ('json', 'jsonText')}
                    if converted['status'] == 'ok':
                        value = json.loads(converted['jsonText']) if 'jsonText' in converted else converted['json']
                        outputs[lane] = value
                        (folder / f'{writer}-{reader}.json').write_text(json.dumps(value, ensure_ascii=False, indent=2))
                        result['validation'] = validate(value)
                        completed = bridges['java'].ask({'op': 'complete-instance', 'json': value,
                            'template': templates[source['schema:isBasedOn']]}) if source['schema:isBasedOn'] in templates else {'status': 'template-missing'}
                        result['completedValidation'] = {k: v for k, v in completed.items() if k != 'json'}
                        result['sourceDifferences'] = list(matrix.differences(source, value))
                    record['pairings'][lane] = result
            record['allFourProduced'] = len(outputs) == 4
            record['allFourEqual'] = len(outputs) == 4 and len({encoded(v, True) for v in outputs.values()}) == 1
            record['allFourSameGeneratedOrder'] = len(outputs) == 4 and len({encoded(v) for v in outputs.values()}) == 1
            record['yamlByteEqual'] = len(yamls) == 2 and yamls['java'] == yamls['typescript']
            record['allFourMatchSource'] = len(outputs) == 4 and all(encoded(v, True) == encoded(source, True) for v in outputs.values())
            if len(yamls) == 2 and not record['yamlByteEqual']:
                (folder / 'yaml.diff').write_text(''.join(difflib.unified_diff(
                    yamls['java'].splitlines(True), yamls['typescript'].splitlines(True), 'java', 'typescript')))
            if 'java->java' in outputs:
                record['differencesFromJava'] = {lane: list(matrix.differences(outputs['java->java'], v))
                    for lane, v in outputs.items()}
            (folder / 'result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2))
            results.append(record)
            print(f'{index}/{len(sources)} content={record["allFourEqual"]} yaml={record["yamlByteEqual"]}', flush=True)
    finally:
        for bridge in bridges.values():
            bridge.close()
    summary = {'instances': len(results), 'templates': len(templates),
        'fetchErrors': sum(error is not None for _, _, error in fetched),
        'requested': args.limit,
        'sourceValidation': dict(collections.Counter(r['sourceValidation']['status'] for r in results)),
        'flags': {key: sum(r[key] for r in results) for key in (
            'allFourProduced', 'allFourEqual', 'allFourSameGeneratedOrder', 'yamlByteEqual', 'allFourMatchSource')},
        'generatedValidation': {lane: dict(collections.Counter(
            r['pairings'].get(lane, {}).get('validation', {}).get('status', 'not-produced') for r in results))
            for lane in (f'{w}->{r}' for w in matrix.LANES for r in matrix.LANES)}}
    summary['completedValidation'] = {lane: dict(collections.Counter(
        r['pairings'].get(lane, {}).get('completedValidation', {}).get('status', 'not-produced') for r in results))
        for lane in (f'{w}->{r}' for w in matrix.LANES for r in matrix.LANES)}
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--classpath', type=pathlib.Path, required=True)
    parser.add_argument('--library', type=pathlib.Path, required=True)
    parser.add_argument('--java', default='java')
    parser.add_argument('--sources', type=pathlib.Path, help='replay saved source.json files and templates.json without HTTP')
    parser.add_argument('--key-file', type=pathlib.Path, default=pathlib.Path.home() / '.cedar-admin-key')
    parser.add_argument('--limit', type=int, default=100)
    parser.add_argument('--random-seed', type=int, help='sample random search-index positions using this recorded seed')
    run(parser.parse_args())
