#!/usr/bin/env python3
"""Offline restoration plan from a provenance audit and retained repair evidence. Never writes prod.

Only a verified post-write body AND its unchanged content ETag, preserved preimage provenance,
a matching repair actor and a graph timestamp in the recorded write window qualify automatically.
Everything else remains a review item. Candidate status is not authorization to apply a repair.
"""
import argparse
import copy
from collections import Counter, defaultdict
from datetime import datetime
import json
import os
from pathlib import Path
import re

from cedar_provenance_audit import atomic, digest, now

MODIFICATION = ('pav:lastUpdatedOn', 'oslc:modifiedBy')


def epoch(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return dt.timestamp() if dt.tzinfo is not None else None
    except (TypeError, ValueError, AttributeError): return None


def mod(value):
    return {k: value.get(k) for k in MODIFICATION}


def load(path):
    return json.loads(path.read_text())


def content_revision(tag):
    # Resource PUT retains the artifact revision and appends its response representation.
    match = re.fullmatch(r'"([0-9]+)(?:-resource-record)?(?:--gzip)?"', tag or '')
    return '"' + match[1] + '"' if match else None


def recorded_scalar_postimage(source, row):
    """Replay recorded assignments for known scalar-only repairs, without rerunning a transform.

    Paths must resolve in the saved document and prior values must agree at every step. The
    reconstructed *whole* body and its recorded revision still have to match the live document.
    Array additions, removals, renames and unspecified transformations are deliberately refused.
    """
    supported = {'derive-title', 'pad-artifact-version', 'align-instance-context-iris'}
    if row.get('repair') not in supported or not row.get('changes'): return None
    changes = row['changes']
    if set(row.get('pathsRemoved', [])) - {c.get('path') for c in changes}: return None
    result = copy.deepcopy(source)
    for change in changes:
        path = change.get('path', '')
        if (not path.startswith('/') or not isinstance(change.get('wrote'), str)
                or change.get('repair', row['repair']) != row['repair']): return None
        parts = [part.replace('~1', '/').replace('~0', '~') for part in path[1:].split('/')]
        if row['repair'] == 'derive-title' and parts[-1] != 'title': return None
        if row['repair'] == 'pad-artifact-version' and parts[-1] != 'pav:version': return None
        if row['repair'] == 'align-instance-context-iris' and '@context' not in parts[:-1]: return None
        parent = result
        for part in parts[:-1]:
            if not isinstance(parent, dict) or part not in parent: return None
            parent = parent[part]
        if not isinstance(parent, dict) or parent.get(parts[-1]) != change.get('replaced'): return None
        parent[parts[-1]] = change['wrote']
    return result


def evidence_index(repairs, legacy_root=None):
    evidence = defaultdict(list)
    problems = []
    logs = [p for p in repairs.rglob('*.jsonl') if any(word in p.name for word in ('apply', 'applied', 'repair'))]
    if legacy_root:
        logs.extend(legacy_root.glob('*.jsonl'))
        for directory in legacy_root.glob('artifact-repair-*'):
            if directory.is_dir(): logs.extend(directory.rglob('*.jsonl'))
    for path in logs:
        try:
            with path.open() as stream:
                for line in stream:
                    row = json.loads(line)
                    if row.get('outcome') != 'repaired' or row.get('verified') is not True: continue
                    preimage = Path(row.get('preimage', ''))
                    if not preimage.is_absolute():
                        preimage = path.parent / preimage
                    if not preimage.is_file():
                        problems.append({'file': str(path), 'id': row.get('artifactId'), 'problem': 'missing preimage'})
                        continue
                    source = load(preimage)['artifact']
                    event = {
                        'campaign': str(path.relative_to(repairs).parts[0]) if path.is_relative_to(repairs) else path.name,
                        'record': str(path), 'preimage': str(preimage), 'beforeModification': mod(source),
                        'writeEpoch': epoch(row.get('at')), 'responseEtag': row.get('newEtag'),
                        'basis': 'verified-repair-log-with-preimage'}
                    after = recorded_scalar_postimage(source, row)
                    revision = content_revision(row.get('newEtag'))
                    if after is not None and revision:
                        event.update(postimageSha256=digest(after), documentEtag=revision,
                                     basis='preimage-plus-recorded-scalar-assignments-and-content-revision')
                    evidence[row['artifactId']].append(event)
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems.append({'file': str(path), 'problem': type(error).__name__})
    # The broad annotation backfill retained a full source, candidate, readback and content ETag.
    for result_path in repairs.rglob('write-result.json'):
        directory = result_path.parent
        needed = ['source.json', 'candidate.json', 'readback.json', 'readback-etag.json', 'write-intent.json']
        if not all((directory / name).is_file() for name in needed): continue
        try:
            result = load(result_path)
            if result.get('status') != 'verified': continue
            source, candidate, readback = [load(directory / name) for name in needed[:3]]
            intent = load(directory / 'write-intent.json')
            if candidate != readback: raise ValueError('candidate/readback mismatch')
            if mod(source) != mod(readback): raise ValueError('repair changed modification provenance')
            identifier = result['id']
            if source.get('@id') != identifier or readback.get('@id') != identifier:
                raise ValueError('evidence identity mismatch')
            if not isinstance(intent.get('time'), (int, float)):
                problems.append({'file': str(result_path), 'problem': 'write intent has no retained timestamp; cannot correlate graph write'})
                continue
            evidence[identifier].append({
                'campaign': str(result_path.relative_to(repairs).parts[0]), 'record': str(result_path),
                'preimage': str(directory / 'source.json'), 'postimage': str(directory / 'readback.json'),
                'beforeModification': mod(source), 'writeEpoch': intent['time'],
                'postimageSha256': digest(readback), 'documentEtag': load(directory / 'readback-etag.json'),
                'basis': 'verified-preimage-postimage-and-content-revision'})
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems.append({'file': str(result_path), 'problem': str(error)})
    return evidence, problems


def classify(row, events, repair_user):
    if row.get('notObserved'):
        listed = row.get('listing', {})
        stamp = epoch(listed.get('pav:lastUpdatedOn'))
        if listed.get('oslc:modifiedBy') == repair_user and stamp is not None:
            for event in reversed(events):
                written = event.get('writeEpoch')
                if written is not None and int(written) <= stamp <= written + 120:
                    return 'listed-repair-correlated-needs-document-read', event
        return 'not-observed', None
    if not row.get('complete'): return 'unreadable', None
    if row.get('identityMismatch'): return 'identity-disagreement-review', None
    differences = row.get('documentGraphMismatch', [])
    if not differences:
        return ('listing-drift' if row.get('listingGraphMismatch') else 'consistent'), None
    if not set(differences).intersection(MODIFICATION): return 'creation-only-difference', None
    document, graph = row['document'], row['graph']
    if graph.get('oslc:modifiedBy') != repair_user: return 'different-graph-modifier-review', None
    target_time, graph_time = epoch(document.get('pav:lastUpdatedOn')), epoch(graph.get('pav:lastUpdatedOn'))
    if target_time is None or not isinstance(document.get('oslc:modifiedBy'), str):
        return 'missing-original-provenance-review', None
    matching = []
    for event in events:
        if event['beforeModification'] != mod(document): continue
        written = event.get('writeEpoch')
        if graph_time is None or written is None or not int(written) <= graph_time <= written + 120: continue
        matching.append(event)
        if (event.get('postimageSha256') == row.get('documentSha256')
                and event.get('documentEtag') == row.get('documentEtag')
                and re.fullmatch(r'"[1-9][0-9]*"', row.get('documentEtag') or '')
                and row.get('listingGraphMismatch') == []):
            return 'eligible-unchanged-repair', event
    if matching: return 'repair-correlated-needs-revision-proof', matching[-1]
    if events: return 'repair-history-but-current-state-unproven', events[-1]
    return 'no-retained-repair-evidence', None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--repairs', type=Path, required=True)
    parser.add_argument('--repair-user', required=True)
    parser.add_argument('--legacy-root', type=Path, help='also inspect root-level historical repair JSONL records')
    parser.add_argument('--evidence-index', type=Path, help='reuse a previously prepared evidence JSONL index')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077); args.out.mkdir(parents=True, exist_ok=True)
    if args.evidence_index:
        evidence = defaultdict(list)
        evidence_summary = args.evidence_index.parent / 'summary.json'
        problems = load(evidence_summary).get('problems', []) if evidence_summary.exists() else [
            {'problem': 'cached evidence has no retained extraction summary'}]
        with args.evidence_index.open() as stream:
            for line in stream:
                event = json.loads(line); evidence[event.pop('id')].append(event)
    else:
        evidence, problems = evidence_index(args.repairs, args.legacy_root)
    records = {}
    for path in args.audit.glob('inventory-*.json'):
        if path.name.startswith('inventory-index-'): continue
        for row in load(path)['rows']: records[row['id']] = dict(row, notObserved=True)
    with (args.audit / 'observations.jsonl').open() as stream:
        for line in stream:
            row = json.loads(line); records[row['id']] = row
    counts, by_kind, campaigns = Counter(), defaultdict(Counter), Counter()
    proposed = []; reviews = []
    for row in records.values():
        category, proof = classify(row, evidence.get(row['id'], []), args.repair_user)
        counts[category] += 1; by_kind[row['kind']][category] += 1
        if category in ('consistent',): continue
        item = {'id': row['id'], 'kind': row['kind'], 'name': row.get('name'), 'classification': category,
                'observedAt': row.get('observedAt'), 'document': row.get('document'), 'graph': row.get('graph'),
                'listing': row.get('listing'),
                'documentGraphMismatch': row.get('documentGraphMismatch'),
                'expectedDocumentEtag': row.get('documentEtag'),
                'expectedDocumentSha256': row.get('documentSha256'),
                'expectedGraphEtag': row.get('graphEtag'), 'evidence': proof}
        if proof: campaigns[proof['campaign']] += 1
        if category == 'eligible-unchanged-repair':
            item['changes'] = [{'property': k, 'before': row['graph'].get(k), 'after': row['document'].get(k)}
                               for k in MODIFICATION if row['graph'].get(k) != row['document'].get(k)]
            item['changes'].append({'property': 'lastUpdatedOnTS', 'before': row['graph'].get('lastUpdatedOnTS'),
                                    'after': int(epoch(row['document']['pav:lastUpdatedOn']))})
            proposed.append(item)
        else: reviews.append(item)
    for name, rows in [('restoration-candidates.jsonl', proposed), ('review.jsonl', reviews)]:
        with (args.out / name).open('w') as stream:
            for row in rows: stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    with (args.out / 'repair-evidence.jsonl').open('w') as stream:
        for identifier, events in evidence.items():
            for event in events: stream.write(json.dumps({'id': identifier, **event}) + '\n')
    atomic(args.out / 'summary.json', {'preparedAt': now(), 'readOnly': True,
        'auditStatus': load(args.audit / 'summary.json').get('status'), 'inventoried': len(records),
        'observed': sum(not r.get('notObserved', False) for r in records.values()),
        'classifications': counts, 'byKind': by_kind, 'correlatedCampaigns': campaigns,
        'retainedEvidenceArtifacts': len(evidence), 'evidenceProblems': problems,
        'authorization': 'Review candidates only. No production writes performed or authorized by this plan.',
        'revalidation': 'Refresh document ETag/hash and graph provenance immediately before any approved restoration; changed candidates must be skipped.'})
    print(json.dumps({'counts': counts, 'evidenceArtifacts': len(evidence), 'evidenceProblems': len(problems)}, indent=2))


if __name__ == '__main__': main()
