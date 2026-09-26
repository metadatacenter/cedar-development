#!/usr/bin/env python3
"""Isolated CEE/Titanium RDF comparison; optional production access is GET-only.

Production samples and reports belong in ignored .cedar/audits, never in fixtures.
Exit 1 means a measured disagreement/contract failure, not necessarily a harness error.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import random
import selectors
import subprocess
import sys
from datetime import datetime, timezone

import fixtures

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from cedar_artifact_rest_audit import ArtifactRef, GetOnlyClient, typed_artifact_path


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Bridge:
    def __init__(self, command, stderr):
        self.log = stderr.open('w')
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, encoding='utf-8', bufsize=1)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def ask(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        if not self.selector.select(45):
            self.process.kill()
            raise RuntimeError('comparison bridge timed out; inspect retained stderr')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('comparison bridge stopped; inspect retained stderr')
        result = json.loads(line)
        if 'bridgeError' in result:
            raise RuntimeError(result['bridgeError'])
        return result

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.selector.close()
        self.log.close()


def select_refs(inventory, sample, seed):
    refs = json.loads(inventory.read_text())['refs']
    ids = sorted({r['artifact_id'] for r in refs if r['artifact_type'] == 'instance'})
    if sample > len(ids):
        raise ValueError('sample exceeds distinct inventory population')
    return random.Random(seed).sample(ids, sample), len(ids)


def production(args, out):
    if not args.sample:
        return []
    manifest = out / 'sample.json'
    bodies = out / 'production'
    bodies.mkdir(exist_ok=True)
    if args.replay:
        selected = json.loads(manifest.read_text())['selected']
    else:
        if manifest.exists():
            raise ValueError('use --replay or a new output directory; never overwrite sampled evidence')
        selected, population = select_refs(args.inventory, args.sample, args.seed)
        write(manifest, dict(selected=selected, population=population, seed=args.seed,
                            inventory=str(args.inventory), inventorySha256=digest(args.inventory),
                            sampling='uniform without replacement from retained inventory; fresh GET of bodies',
                            fetchedAt=datetime.now(timezone.utc).isoformat(), server=args.server))
        client = GetOnlyClient(args.server, args.api_key_file.read_text().strip(), timeout=40, retries=3)
        def fetch(identifier):
            file = bodies / (hashlib.sha256(identifier.encode()).hexdigest() + '.json')
            try:
                source = client.get_json(typed_artifact_path(ArtifactRef('instance', identifier, '')))
                if source.get('@id') != identifier:
                    raise ValueError('GET identity does not match selected identifier')
                write(file, dict(id=identifier, source=source))
            except Exception as error:
                # Shared client redacts credentials; still retain only error class for unexpected errors.
                write(file, dict(id=identifier, fetchError=type(error).__name__))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for count, _ in enumerate(pool.map(fetch, selected), 1):
                if count % 20 == 0:
                    print(f'Production fetched {count}/{len(selected)}', flush=True)
    records = []
    for identifier in selected:
        file = bodies / (hashlib.sha256(identifier.encode()).hexdigest() + '.json')
        record = json.loads(file.read_text())
        records.append(dict(record, group='production', sourceFile=str(file), sourceSha256=digest(file)))
    return records


def compare(record, node, java):
    if 'fetchError' in record:
        return dict(id=record['id'], group=record['group'], status='unreadable', fetchError=record['fetchError'])
    request = dict(source=record['source'], template=record.get('template'))
    cee = node.ask(request)
    titanium = java.ask(request)
    if titanium['ok']:
        try:
            titanium.update(node.ask(dict(action='canonical', nquads=titanium['nquads'])))
            if titanium.get('turtleOk'):
                titanium['turtleCanonical'] = node.ask(dict(action='canonical', nquads=titanium['turtle']))['canonical']
        except RuntimeError as error:
            titanium['canonicalError'] = str(error)
    if 'canonicalError' in cee or 'canonicalError' in titanium:
        status = 'comparison-error'
    elif cee['ok'] and titanium['ok']:
        status = 'equal' if cee['canonical'] == titanium.get('canonical') else 'dataset-difference'
    elif not cee['ok'] and not titanium['ok']:
        status = 'both-reject'
    else:
        status = 'cee-only-reject' if not cee['ok'] else 'titanium-only-reject'
    result = {k: v for k, v in record.items() if k != 'source'}
    result.update(status=status, cee=cee, titanium=titanium)
    if status == 'dataset-difference' and 'canonical' in titanium:
        # Secondary diagnostic only: never replace the strict RDF-term comparison.
        a = node.ask(dict(action='canonical', nquads=cee['nquads'], normalizeDouble=True))
        b = node.ask(dict(action='canonical', nquads=titanium['nquads'], normalizeDouble=True))
        result['doubleValueEquivalent'] = a == b
    result['turtleParity'] = (cee['turtleCanonical'] == cee['canonical']
                             if 'canonical' in cee and cee['turtleOk'] else None)
    result['javaTurtleParity'] = (titanium.get('turtleCanonical') == titanium.get('canonical')
                                  if titanium.get('turtleOk') else None)
    result['turtleContract'] = (not cee['turtleOk'] and not titanium.get('turtleOk')
                                if record['id'] == 'named-graph' else
                                cee['turtleOk'] == cee['ok'] and titanium.get('turtleOk', False) == titanium['ok'])
    if record.get('expect') == 'reject':
        result['ceeContract'] = not cee['ok']
        result['titaniumContract'] = not titanium['ok']
    elif record.get('expect') == 'dataset':
        expected = node.ask(dict(action='canonical', nquads=record['expectedNquads']))['canonical']
        result['expectedCanonical'] = expected
        result['ceeContract'] = cee['ok'] and cee.get('canonical') == expected
        result['titaniumContract'] = titanium['ok'] and titanium.get('canonical') == expected
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cedar-home', type=Path, default=HERE.parents[2])
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--inventory', type=Path)
    p.add_argument('--sample', type=int, default=0)
    p.add_argument('--seed', type=int, default=9262026)
    p.add_argument('--server', default='https://resource.metadatacenter.org')
    p.add_argument('--api-key-file', type=Path)
    p.add_argument('--replay', action='store_true')
    p.add_argument('--cee-rendered', type=Path, help='CEE harness export of instances after editor serialization')
    args = p.parse_args()
    if args.sample < 0:
        p.error('--sample must be non-negative')
    if args.sample and not args.replay and (not args.inventory or not args.api_key_file):
        p.error('--sample requires --inventory and --api-key-file unless --replay')
    os.umask(0o077)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    write(out/'summary.json', dict(complete=False, startedAt=datetime.now(timezone.utc).isoformat()))
    cee = args.cedar_home / 'cedar-embeddable-editor'
    source = cee / 'src/app/modules/shared/util/rdf-export.ts'
    bundle = out / 'cee-rdf.cjs'
    subprocess.run([str(cee/'node_modules/.bin/esbuild'), str(source), '--bundle', '--platform=node',
                    '--format=cjs', '--outfile='+str(bundle)], check=True)
    records = [dict(c, group='synthetic') for c in fixtures.cases()]
    write(out/'synthetic-corpus.json', records)
    for file in sorted((cee/'harness/fixtures/cee-suite').glob('*/instance-*.json')):
        records.append(dict(id='cee-'+file.parent.name, group='cee-stored-fixture',
                            source=json.loads(file.read_text()), sourceFile=str(file), sourceSha256=digest(file)))
    if args.cee_rendered:
        for record in json.loads(args.cee_rendered.read_text()):
            records.append(dict(record, id='cee-rendered-'+record['id'], group='cee-rendered-fixture',
                                sourceFile=str(args.cee_rendered), sourceSha256=digest(args.cee_rendered)))
    records += production(args, out)
    classpath = str(HERE/'target/classes') + ':' + (HERE/'target/classpath.txt').read_text().strip()
    runtime = {str(Path(path)): digest(Path(path)) for path in classpath.split(':') if Path(path).is_file()}
    for path in (HERE/'target/classes').glob('*.class'):
        runtime[str(path)] = digest(path)
    write(out/'runtime.json', dict(titanium='1.7.0', jarsAndClasses=runtime,
        ceeHead=subprocess.check_output(['git', '-C', str(cee), 'rev-parse', 'HEAD'], text=True).strip(),
        ceeSourceSha256=digest(source), bundleSha256=digest(bundle),
        node=subprocess.check_output(['node', '--version'], text=True).strip(),
        java=subprocess.run(['java', '-version'], capture_output=True, text=True).stderr,
        jsPackages={name:json.loads((cee/'node_modules'/name/'package.json').read_text())['version']
                    for name in ['jsonld', 'rdf-canonize', 'n3', 'esbuild']},
        toolHashes={str(f.relative_to(HERE)):digest(f) for f in HERE.rglob('*')
                    if f.is_file() and f.suffix in {'.py', '.java', '.cjs', '.xml'} and 'target' not in f.parts},
        comparison='RDFC-1.0 RDF dataset canonicalization, including graph, datatype and language; independent Java and CEE preparation'))
    node = Bridge(['node', str(HERE/'cee-bridge.cjs'), str(cee), str(bundle)], out/'node.stderr')
    java = Bridge(['java', '-cp', classpath, 'TitaniumBridge'], out/'java.stderr')
    results = []
    try:
        with (out/'results.jsonl').open('w') as stream:
            for index, record in enumerate(records, 1):
                result = compare(record, node, java)
                stream.write(json.dumps(result, ensure_ascii=False)+'\n')
                stream.flush()
                results.append(result)
                if index % 25 == 0:
                    print(f'Compared {index}/{len(records)}', flush=True)
    finally:
        node.close()
        java.close()
    groups = {}
    for group in sorted({r['group'] for r in results}):
        members = [r for r in results if r['group'] == group]
        groups[group] = dict(count=len(members), statuses=dict(collections.Counter(r['status'] for r in members)),
            ceeContractFailures=[r['id'] for r in members if r.get('ceeContract') is False],
            titaniumContractFailures=[r['id'] for r in members if r.get('titaniumContract') is False],
            turtleDifferences=[r['id'] for r in members if r.get('turtleParity') is False or r.get('javaTurtleParity') is False],
            turtleRejectedAfterNquads=[r['id'] for r in members if r.get('cee', {}).get('ok') and not r['cee']['turtleOk']],
            mutatedInputs=[r['id'] for r in members if r.get('cee', {}).get('inputUnchanged') is False or r.get('titanium', {}).get('inputUnchanged') is False])
        groups[group]['doubleLexicalOnly'] = [r['id'] for r in members if r.get('doubleValueEquivalent')]
    write(out/'summary.json', dict(complete=True, groups=groups))
    print(json.dumps(groups, indent=2))
    return int(any(r['status'] not in {'equal', 'both-reject'} or r.get('ceeContract') is False
                   or r.get('titaniumContract') is False or r.get('turtleParity') is False
                   or r.get('cee', {}).get('inputUnchanged') is False
                   or r.get('turtleContract') is False or r.get('javaTurtleParity') is False
                   or r.get('titanium', {}).get('inputUnchanged') is False for r in results))


if __name__ == '__main__':
    sys.exit(main())
