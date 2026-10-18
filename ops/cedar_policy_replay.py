#!/usr/bin/env python3
"""Offline policy replay over retained audit sources. Never contacts or writes a deployment.

Extract semantic scalar values from schema corpus.sqlite and optional instance sources/*.json.gz.
The cache is already JSON, so original wire duplicates and lost numeric lexemes cannot be recovered.
Raw values stay in the requested local output directory; stdout contains aggregate counts only.
"""
import argparse
import hashlib
import itertools
import os
import subprocess
from collections import Counter, defaultdict
from decimal import Decimal
import gzip
import json
from pathlib import Path
import sqlite3
import unicodedata
import zlib


def extract(schema_db, instance_dir, destination):
    values = defaultdict(Counter)
    stats = Counter()
    def walk(node, context=False):
        if isinstance(node, list):
            for child in node:
                walk(child, context)
        elif isinstance(node, dict):
            constraints = node.get('_valueConstraints')
            if isinstance(constraints, dict):
                regex = constraints.get('regex')
                if isinstance(regex, str) and regex:
                    values['regex'][regex] += 1
                for key in ('minValue', 'maxValue', 'defaultValue'):
                    value = constraints.get(key)
                    if isinstance(value, (Decimal, int)) and not isinstance(value, bool):
                        values['numeric'][str(value)] += 1
            for key, value in node.items():
                if key in ('schema:name', 'rdfs:label', 'skos:prefLabel') and isinstance(value, str):
                    values['text'][value] += 1
                if key in ('pav:createdOn', 'pav:lastUpdatedOn') and isinstance(value, str):
                    values['timestamp'][value] += 1
                if key == '@id' and isinstance(value, str) and not context and not value.startswith('@'):
                    values['identifier'][value] += 1
                if key == 'properties' and isinstance(value, dict):
                    for name, child in value.items():
                        if isinstance(child, dict) and ('_ui' in child or '_ui' in (child.get('items') or {})):
                            values['text'][name] += 1
                walk(value, context or key == '@context')
        elif isinstance(node, str):
            stats['strings'] += 1
            if any(ord(c) > 127 or ord(c) < 32 for c in node):
                stats['non_ascii_or_control_strings'] += 1
                if any(unicodedata.category(c) == 'Cs' for c in node): stats['unpaired_surrogate_strings'] += 1
                if any(unicodedata.category(c) == 'Cf' for c in node): stats['format_character_strings'] += 1
                if unicodedata.normalize('NFC', node) != node: stats['non_nfc_strings'] += 1
    def consume(raw, kind):
        try:
            doc = json.loads(raw, parse_float=Decimal)
        except (ValueError, UnicodeError):
            stats['cached_source_parse_errors'] += 1
            return
        walk(doc)
        stats[kind + '_documents'] += 1
        total = sum(stats[k + '_documents'] for k in ('template', 'element', 'field', 'instance'))
        if total % 10000 == 0: print(json.dumps({'processed': total}), flush=True)
    db = sqlite3.connect(f'file:{schema_db.resolve()}?mode=ro', uri=True)
    try:
        for kind, source in db.execute('select kind,source from artifacts where source is not null'):
            consume(zlib.decompress(source), kind)
    finally: db.close()
    if instance_dir:
        for path in sorted(instance_dir.glob('*.json.gz')):
            with gzip.open(path, 'rb') as source: consume(source.read(), 'instance')
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / 'values.jsonl').open('w') as target:
        for kind, counter in values.items():
            for value, count in counter.items():
                target.write(json.dumps({'kind': kind, 'value': value, 'count': count}, ensure_ascii=True) + '\n')
    summary = {'counts': dict(stats), 'unique': {kind: len(counter) for kind, counter in values.items()},
               'occurrences': {kind: sum(counter.values()) for kind, counter in values.items()},
               'limitation': 'Retained JSON cannot prove the absence of original wire duplicate keys or recover numbers rounded before caching.'}
    (destination / 'extraction.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary), flush=True)



def sample_sources(schema_db, instance_dir, destination, per_bucket=50):
    """Deterministic ordinary/Unicode-or-pattern sample from each retained artifact kind."""
    if per_bucket < 1: raise ValueError('Sample size must be positive')
    counts, rows, seen = Counter(), [], set()
    def add(raw, kind):
        identity = hashlib.sha256(raw).hexdigest()
        if identity in seen: return
        source = raw.decode('utf-8')
        special = any(ord(c) > 127 for c in source) or '\\u' in source or '"regex"' in source
        bucket = kind + ('-unicode-or-pattern' if special else '-ordinary')
        if counts[bucket] >= per_bucket: return
        seen.add(identity)
        counts[bucket] += 1
        rows.append({'kind': 'json-source', 'value': source, 'count': 1, 'artifactKind': kind, 'sha256': identity})
    db = sqlite3.connect(f'file:{schema_db.resolve()}?mode=ro', uri=True)
    try:
        for kind, source in db.execute('select kind,source from artifacts where source is not null order by kind,id'):
            add(zlib.decompress(source), kind)
    finally: db.close()
    if instance_dir:
        for path in sorted(instance_dir.glob('*.json.gz')):
            with gzip.open(path, 'rb') as source: add(source.read(), 'instance')
            if counts['instance-ordinary'] == per_bucket and counts['instance-unicode-or-pattern'] == per_bucket: break
    rows.append({'kind': 'json-source', 'value': '{"integer":9007199254740993,"decimal":0.10000000000000001,"name":"e\\u0301😀\\u001c\\u00a0","__proto__":{"kept":true}}',
                 'count': 1, 'artifactKind': 'synthetic'})
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(''.join(json.dumps(row, ensure_ascii=True) + '\n' for row in rows))
    print(json.dumps({'sample': dict(counts), 'total': len(rows)}), flush=True)


def equivalent(left, right):
    """Compare source semantics, distinguishing booleans from numbers and preserving every string/key."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, Decimal)) and isinstance(right, (int, Decimal)):
        return left == right
    if type(left) is not type(right): return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equivalent(value, right[key]) for key, value in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(equivalent(a, b) for a, b in zip(left, right))
    return left == right


def compare(values, java, typescript, destination):
    counts, rejected, differences = Counter(), Counter(), []
    missing = object()
    with values.open() as source, java.open() as jvm, typescript.open() as browser:
        for index, rows in enumerate(itertools.zip_longest(source, jvm, browser, fillvalue=missing), 1):
            if any(row is missing for row in rows):
                raise ValueError('Replay result length differs from the input; incomplete runs cannot pass')
            row, left, right = [json.loads(line, parse_float=Decimal) for line in rows]
            kind = row['kind']
            counts[kind] += 1
            same = equivalent(left, right)
            if kind == 'json-source':
                try:
                    original = json.loads(row['value'], parse_float=Decimal)
                    same = all(equivalent(original, json.loads(result, parse_float=Decimal)) for result in (left, right))
                except (ValueError, TypeError): same = False
            if not same: differences.append({'row': index, 'kind': kind})
            elif left is None or left is False: rejected[kind] += 1
    summary = {'inputs': dict(counts), 'differences': differences, 'agreeingRejections': dict(rejected),
               'scope': 'Scalar concordance and exact JSON source round-trips; cached JSON cannot recover original duplicate keys or earlier rounding.'}
    destination.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'inputs': dict(counts), 'differences': len(differences), 'agreeingRejections': dict(rejected)}), flush=True)
    return not differences


def replay(values, destination, classpath, library):
    """Run the two current libraries offline, with raw values confined to local files."""
    destination.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).resolve().parent
    java_home = os.environ.get('JAVA_HOME')
    java = str(Path(java_home) / 'bin/java') if java_home else 'java'
    javac = str(Path(java_home) / 'bin/javac') if java_home else 'javac'
    classes = destination / 'classes'
    classes.mkdir(exist_ok=True)
    subprocess.run([javac, '-cp', classpath, '-d', str(classes), str(scripts / 'cedar_policy_replay_bridge.java')], check=True)
    commands = {
        'java': [java, '-cp', str(classes) + os.pathsep + classpath, 'org.metadatacenter.model.validation.cedar_policy_replay_bridge'],
        'typescript': ['node', str(scripts / 'cedar_policy_replay_bridge.cjs'), str(library.resolve())],
    }
    for lane, command in commands.items():
        with values.open() as source, (destination / (lane + '.jsonl')).open('w') as output, (destination / (lane + '.log')).open('w') as errors:
            subprocess.run(command, stdin=source, stdout=output, stderr=errors, check=True)
    manifest = {'valuesSha256': hashlib.sha256(values.read_bytes()).hexdigest(),
                'typescriptBundleSha256': hashlib.sha256(library.read_bytes()).hexdigest(),
                'javaClasspath': classpath, 'javaRuntime': java}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return compare(values, destination / 'java.jsonl', destination / 'typescript.jsonl', destination / 'comparison.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    extraction = commands.add_parser('extract', help='Collect distinct scalar inputs from retained sources')
    extraction.add_argument('--schema-db', required=True, type=Path)
    extraction.add_argument('--instances', type=Path)
    extraction.add_argument('--output', required=True, type=Path)
    sample = commands.add_parser('sample', help='Sample complete cached sources for preservation replay')
    sample.add_argument('--schema-db', required=True, type=Path)
    sample.add_argument('--instances', type=Path)
    sample.add_argument('--output', required=True, type=Path)
    sample.add_argument('--per-bucket', type=int, default=50)
    run = commands.add_parser('run', help='Run both current libraries and compare their results')
    run.add_argument('--values', required=True, type=Path)
    run.add_argument('--output', required=True, type=Path)
    run.add_argument('--java-classpath', required=True)
    run.add_argument('--typescript-library', required=True, type=Path)
    comparison = commands.add_parser('compare', help='Compare previously generated results')
    comparison.add_argument('--values', required=True, type=Path)
    comparison.add_argument('--java', required=True, type=Path)
    comparison.add_argument('--typescript', required=True, type=Path)
    comparison.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'extract': extract(args.schema_db, args.instances, args.output)
    elif args.command == 'sample': sample_sources(args.schema_db, args.instances, args.output, args.per_bucket)
    elif args.command == 'run':
        raise SystemExit(0 if replay(args.values, args.output, args.java_classpath, args.typescript_library) else 1)
    else:
        raise SystemExit(0 if compare(args.values, args.java, args.typescript, args.output) else 1)
