"""An unknown baseline/dependency must not become a no-impact result."""
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import cedar_template_impact as impact

TID = 'https://repo.metadatacenter.org/templates/example'
TEMPLATE = {'@id': TID, '@type': impact.TEMPLATE_TYPE}


class Bridge:
    def __init__(self, proposed_status='valid'):
        self.calls = 0
        self.proposed_status = proposed_status

    def cache_template(self, key, body):
        return {'status': 'ok'}

    def validate(self, kind, body, key=None):
        if kind == 'template':
            self.calls += 1
            return {'status': 'valid' if self.calls == 1 else self.proposed_status}
        return {'status': body['after' if key.endswith('after') else 'before'],
                'errors': [{'location': '/Name', 'message': 'example constraint'}]}


def fetched(before='valid', after='valid'):
    identifier = 'https://repo.metadatacenter.org/template-instances/example'
    return impact.rest.ArtifactRef('instance', identifier), {
        '@id': identifier, 'schema:isBasedOn': TID, 'before': before, 'after': after}, None


class ImpactTests(unittest.TestCase):
    def compare(self, rows, complete=True, bridge=None, proposed=None):
        return impact.compare_population(bridge or Bridge(), TID, TEMPLATE,
                                         proposed or TEMPLATE, rows,
                                         {'enumerated': len(rows), 'complete': complete})

    def test_separates_new_breakage_from_existing_invalidity_and_repairs(self):
        result = self.compare([fetched('valid', 'invalid'), fetched('invalid', 'invalid'),
                               fetched('invalid', 'valid'), fetched()])
        self.assertTrue(result['complete'])
        self.assertEqual(result['outcome'], 'at-risk')
        self.assertEqual(result['counts']['newlyInvalid'], 1)
        self.assertEqual(result['counts']['invalidBefore'], 2)
        self.assertEqual(result['counts']['newlyValid'], 1)
        self.assertEqual(len(result['newlyInvalid']), 1)
        self.assertIn('errors', result['newlyInvalid'][0])

    def test_unreadable_dependency_is_inconclusive(self):
        ref, _, _ = fetched()
        result = self.compare([(ref, None, RuntimeError('timeout'))])
        self.assertFalse(result['complete'])
        self.assertEqual(result['outcome'], 'inconclusive')

    def test_validator_error_is_not_invalidity(self):
        for before, after in [('error', 'valid'), ('valid', 'template-missing')]:
            result = self.compare([fetched(before, after)])
            self.assertEqual(result['outcome'], 'inconclusive')
            self.assertEqual(result['newlyInvalid'], [])

    def test_incomplete_inventory_cannot_claim_no_impact(self):
        self.assertEqual(self.compare([], complete=False)['outcome'], 'inconclusive')
        self.assertEqual(self.compare([])['outcome'], 'no-new-invalid-instances')

    def test_wrong_template_reference_or_instance_identity_is_unresolved(self):
        for key in ('@id', 'schema:isBasedOn'):
            ref, body, err = fetched()
            body[key] = 'https://example.org/other'
            self.assertEqual(self.compare([(ref, body, err)])['outcome'], 'inconclusive')

    def test_invalid_proposal_and_changed_template_identity_are_refused(self):
        self.assertEqual(self.compare([], bridge=Bridge('invalid'))['outcome'], 'proposed-template-invalid')
        self.assertEqual(self.compare([], proposed={**TEMPLATE, '@id': 'urn:other'})['outcome'], 'template-identity-mismatch')

    def test_known_breakage_remains_visible_when_coverage_is_incomplete(self):
        result = self.compare([fetched('valid', 'invalid')], complete=False)
        self.assertEqual(result['outcome'], 'at-risk')
        self.assertFalse(result['complete'])

    def test_population_size_mismatch_is_inconclusive(self):
        result = impact.compare_population(Bridge(), TID, TEMPLATE, TEMPLATE, [],
                                           {'enumerated': 1, 'complete': True})
        self.assertEqual(result['outcome'], 'inconclusive')

    def test_pagination_sends_only_template_filter_and_detects_duplicate_rows(self):
        class Client:
            def get_json(self, path, query):
                self.query = query
                return {'resources': [{'@id': 'urn:i'}, {'@id': 'urn:i'}], 'totalCount': 2}
        client = Client()
        _, coverage = impact.dependent_refs(client, TID)
        self.assertEqual(client.query['is_based_on'], TID)
        self.assertNotIn('resource_types', client.query)
        self.assertFalse(coverage['complete'])

    def test_concurrent_template_edit_invalidates_observation(self):
        class Client:
            def get_json(self, *args):
                return {**TEMPLATE, 'schema:name': 'concurrent edit'}
        with patch.object(impact, 'dependent_refs', return_value=([], {'enumerated': 0, 'complete': True})):
            result = impact.check_template(Client(), Bridge(), TID, TEMPLATE, stored=TEMPLATE)
        self.assertFalse(result['complete'])
        self.assertFalse(result['storedTemplateUnchanged'])
        self.assertEqual(result['outcome'], 'inconclusive')


if __name__ == '__main__':
    unittest.main()
