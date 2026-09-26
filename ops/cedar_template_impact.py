#!/usr/bin/env python3
"""Check a proposed template against freshly enumerated, API-key-visible instances. GET only.

Reports observed valid-to-invalid transitions, not permission to save. Search and
reads are not a transactional snapshot and cannot see dependencies hidden from the
API key. No save-path normalization or production validation endpoint is invoked.
"""
import argparse
import collections
import hashlib
import json
import pathlib

import cedar_artifact_rest_audit as rest
import cedar_artifact_validation_audit as audit

TEMPLATE_TYPE = "https://schema.metadatacenter.org/core/Template"


def digest(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=True,
                                     separators=(',', ':')).encode()).hexdigest()


def dependent_refs(client, template_id):
    """Reuse audited pagination, but restrict the search by exact template identity."""
    class ScopedClient:
        def get_json(self, path, query):
            query = dict(query)
            query.pop('resource_types', None)  # Mutually exclusive with is_based_on.
            query['is_based_on'] = template_id
            return client.get_json(path, query)

    state = rest.AuditState()
    refs = list(rest.iter_artifact_refs(ScopedClient(), 'instance', 500, state))
    changes = [x for x in state.total_count_changes if x['was'] is not None]
    expected = state.expected_by_type.get('instance')
    coverage = {'enumerated': len(refs), 'expected': expected, 'listingErrors': state.listing_errors,
                'duplicates': state.duplicates, 'totalCountChanges': changes,
                'pagination': state.pagination_by_type.get('instance')}
    coverage['complete'] = (len(refs) == expected and not state.listing_errors
                            and not state.duplicates and not changes)
    return refs, coverage


def compare_population(bridge, template_id, stored, proposed, fetched, coverage):
    """Never count an exception/missing template as a validity verdict."""
    result = {'templateId': template_id, 'storedSha256': digest(stored), 'proposedSha256': digest(proposed),
              'coverage': coverage, 'scope': 'API-key-visible instances; nontransactional observation',
              'counts': {}, 'newlyInvalid': [], 'unresolved': [], 'complete': False}
    if (not isinstance(stored, dict) or not isinstance(proposed, dict)
            or stored.get('@id') != template_id or proposed.get('@id') != template_id
            or stored.get('@type') != TEMPLATE_TYPE or proposed.get('@type') != TEMPLATE_TYPE):
        result['outcome'] = 'template-identity-mismatch'
        return result
    for name, body in [('stored', stored), ('proposed', proposed)]:
        verdict = bridge.validate('template', body)
        result[name + 'Validation'] = verdict
        if verdict.get('status') != 'valid':
            result['outcome'] = name + '-template-' + ('invalid' if verdict.get('status') == 'invalid' else 'unresolved')
            return result
    before_key, after_key = template_id + '#impact-before', template_id + '#impact-after'
    for key, body in [(before_key, stored), (after_key, proposed)]:
        if bridge.cache_template(key, body).get('status') != 'ok':
            raise RuntimeError('validator refused to cache a template')
    counts = collections.Counter()
    for ref, body, error in fetched:
        counts['processed'] += 1
        if error is not None or not isinstance(body, dict):
            counts['unreadable'] += 1
            result['unresolved'].append({'artifactId': ref.artifact_id, 'reason': 'unreadable'})
            continue
        if body.get('@id') != ref.artifact_id or body.get('schema:isBasedOn') != template_id:
            counts['identityMismatch'] += 1
            result['unresolved'].append({'artifactId': ref.artifact_id, 'reason': 'identity-or-template-mismatch'})
            continue
        before = bridge.validate('instance', body, before_key)
        after = bridge.validate('instance', body, after_key)
        if before.get('status') not in ('valid', 'invalid') or after.get('status') not in ('valid', 'invalid'):
            counts['validatorErrors'] += 1
            result['unresolved'].append({'artifactId': ref.artifact_id, 'reason': 'validator-unresolved',
                                         'before': before, 'after': after})
            continue
        if before['status'] == 'valid':
            counts['validBefore'] += 1
            if after['status'] == 'invalid':
                counts['newlyInvalid'] += 1
                result['newlyInvalid'].append({'artifactId': ref.artifact_id, 'sourceSha256': digest(body),
                                               'errors': after.get('errors', [])})
            else:
                counts['stillValid'] += 1
        else:
            counts['invalidBefore'] += 1
            counts['newlyValid' if after['status'] == 'valid' else 'stillInvalid'] += 1
    result['counts'] = dict(counts)
    result['complete'] = (coverage.get('complete') is True and not result['unresolved']
                          and counts['processed'] == coverage.get('enumerated'))
    result['outcome'] = ('at-risk' if result['newlyInvalid'] else
                         'no-new-invalid-instances' if result['complete'] else 'inconclusive')
    return result


def check_template(client, bridge, template_id, proposed, workers=8, stored=None):
    path = rest.typed_artifact_path(rest.ArtifactRef('template', template_id))
    stored = client.get_json(path) if stored is None else stored
    refs, coverage = dependent_refs(client, template_id)
    fetched = rest.fetch_in_order(client, refs, workers)
    try:
        result = compare_population(bridge, template_id, stored, proposed, fetched, coverage)
    finally:
        fetched.close()
    # A concurrent edit invalidates the baseline even if every instance read succeeded.
    try:
        unchanged = digest(client.get_json(path)) == digest(stored)
    except rest.AuditError:
        unchanged = False
    result['storedTemplateUnchanged'] = unchanged
    if not unchanged:
        result['complete'] = False
        if result['outcome'] == 'no-new-invalid-instances':
            result['outcome'] = 'inconclusive'
    result['observedAt'] = audit.utc_now()
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--template-id', required=True)
    p.add_argument('--proposed', type=pathlib.Path, required=True, help='Exact proposed stored JSON template body')
    p.add_argument('--api-key-file', type=pathlib.Path, required=True)
    p.add_argument('--server', default=rest.DEFAULT_SERVER)
    p.add_argument('--out', type=pathlib.Path, required=True)
    p.add_argument('--java')
    p.add_argument('--classpath')
    p.add_argument('--workers', type=int, default=8)
    args = p.parse_args()
    proposed = json.loads(args.proposed.read_text())
    client = rest.GetOnlyClient(args.server, args.api_key_file.expanduser().read_text().strip())
    java, classpath = audit.resolve_toolchain(args, p)
    bridge = audit.ValidationBridge(java, classpath, audit.BRIDGE_SOURCE, 4, '2g',
                                    args.out.with_suffix('.java.log'), 180)
    try:
        bridge.start()
        result = check_template(client, bridge, args.template_id, proposed, args.workers)
    except Exception as error:
        result = {'templateId': args.template_id, 'outcome': 'inconclusive', 'complete': False,
                  'error': str(error), 'observedAt': audit.utc_now()}
    finally:
        bridge.close()
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k in ('outcome', 'complete', 'counts', 'coverage')}))
    return 0 if result['complete'] and result['outcome'] == 'no-new-invalid-instances' else 1


if __name__ == '__main__':
    raise SystemExit(main())
