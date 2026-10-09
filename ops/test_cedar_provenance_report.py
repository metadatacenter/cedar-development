import unittest
from cedar_provenance_report import findings, timestamp_defects


class ReconciliationTest(unittest.TestCase):
    def test_sort_metadata_uses_seconds_and_rejects_wrong_types(self):
        metadata = {'pav:lastUpdatedOn': '1970-01-01T01:00:01.987+01:00', 'lastUpdatedOnTS': 1}
        self.assertEqual([], timestamp_defects(metadata))
        for invalid in (True, '1', 1000, None):
            metadata['lastUpdatedOnTS'] = invalid
            self.assertEqual(['lastUpdatedOnTS:does-not-match-date'], timestamp_defects(metadata))

    def test_missing_invalid_dates_and_null_pairs(self):
        self.assertEqual([], timestamp_defects({}))
        self.assertEqual(['pav:createdOn:missing-or-invalid'], timestamp_defects({'createdOnTS': 1}))
        self.assertEqual(['pav:createdOn:missing-or-invalid'], timestamp_defects({'pav:createdOn': '1970-01-01'}))
        self.assertEqual([], timestamp_defects({'pav:createdOn': '1970-01-01T00:00:00Z'}, require_numeric=False))

    def test_stale_index_is_distinguished_from_document_graph_disagreement(self):
        row = {'listing': {'oslc:modifiedBy': 'new'}, 'graph': {'oslc:modifiedBy': 'new'},
               'document': {'oslc:modifiedBy': 'new'}, 'documentGraphMismatch': []}
        result = findings(row, {'listing': {'oslc:modifiedBy': 'old'}})
        self.assertEqual(result['indexGraphMismatch'], ['oslc:modifiedBy'])
        self.assertNotIn('documentGraphMismatch', result)
        self.assertTrue(findings(row, None)['missingFromIndex'])

    def test_unread_index_is_not_mislabeled_as_missing_documents(self):
        result = findings({'listing': {}, 'notObserved': True}, None, index_available=False)
        self.assertTrue(result['indexNotEnumerated'])
        self.assertTrue(result['detailedReadNotCompleted'])
        self.assertNotIn('missingFromIndex', result)


if __name__ == '__main__': unittest.main()
