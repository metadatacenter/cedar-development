import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import cedar_search_matrix_audit as audit


class SearchMatrixAuditTest(unittest.TestCase):
    def test_only_exact_origin_search_links_are_followed(self):
        server = 'https://resource.example'
        route, params = audit.link_params(server, '/search?q=%22C%2B%2B%20rad%22&offset=3')
        self.assertEqual('/search', route)
        self.assertEqual('"C++ rad"', params['q'])
        for link in ['http://resource.example/search', 'https://evil.example/search',
                     'https://resource.example@evil.example/search', '/command/reindex',
                     '/search?q=one&q=two', '/search#fragment']:
            with self.assertRaises(ValueError):
                audit.link_params(server, link)

    def test_metadata_checks_reject_wrong_filters_and_respect_exclusive_upper_bound(self):
        resource = {'@id': 'field', 'resourceType': 'field', 'bibo:status': 'bibo:published',
                    'isLatestVersion': True, 'isLatestPublishedVersion': True,
                    'pav:lastUpdatedOn': '2020-01-01T00:00:00Z'}
        valid = {'resource_types': 'field', 'version': 'latest-by-status',
                 'publication_status': 'bibo:published', 'modified_after': 1577836800000}
        self.assertEqual([], audit.metadata_errors(valid, [resource]))
        invalid = {**valid, 'resource_types': 'template', 'publication_status': 'bibo:draft',
                   'modified_before': 1577836800000}
        self.assertEqual(['resource-type', 'publication-status', 'latest-by-status', 'modified-before'],
                         audit.metadata_errors(invalid, [resource])[0]['reasons'])

    def test_full_walk_detects_duplicate_and_missing_rows_even_when_counts_match(self):
        with tempfile.TemporaryDirectory() as directory:
            a = audit.Audit('https://resource.example', 'not-a-real-key', Path(directory) / 'result.json')
            pages = [
                {'totalCount': 3, 'resources': [{'@id': 'a'}, {'@id': 'b'}],
                 'paging': {'next': '/search?q=rad&limit=2&offset=2&sort=name'}},
                {'totalCount': 3, 'resources': [{'@id': 'b'}], 'paging': {}}]
            with patch.object(a, 'get', side_effect=pages):
                rows = a.walk('rad', limit=2)
            self.assertEqual(3, len(rows))
            self.assertFalse(next(c for c in a.checks if c['check'] == 'walk-complete-unique')['pass'])
            a.equal_sets('same-count-different-members', [{'@id': 'a'}], [{'@id': 'b'}])
            self.assertFalse(a.checks[-1]['pass'])
            a.stream.close()

    def test_tokens_are_redacted_from_evidence(self):
        self.assertEqual({'q': 'rad', 'continuation': '<token>'},
                         audit.redacted_params({'q': 'rad', 'continuation': 'private-position'}))
        self.assertEqual({'continuation': 'start'}, audit.redacted_params({'continuation': 'start'}))

    def test_complete_reference_sets_exclude_capped_failed_duplicate_and_changing_walks(self):
        def page(query, total, identifiers, status=200):
            return {'label': 'cohort/' + query, 'parameters': {'q': query}, 'status': status,
                    'totalCount': total, 'resources': [{'@id': value} for value in identifiers]}
        cohorts = audit.complete_reference_cohorts([
            page('empty', 0, []), page('complete', 2, ['a']), page('complete', 2, ['b']),
            page('capped', 1001, ['a']), page('duplicate', 2, ['a', 'a']),
            page('changing', 2, ['a']), page('changing', 3, ['b']), page('failed', 1, ['a'], 500)])
        self.assertEqual({'empty': {}, 'complete': {'a': {'@id': 'a'}, 'b': {'@id': 'b'}}}, cohorts)

    def test_only_documented_normalizations_are_equivalent(self):
        self.assertEqual({'id': 'template-fields/abc', 'q': '"C%2B%2B"'}, audit.comparable_params({
            'id': 'https://repo.metadatacenter.org/template-fields/abc', 'q': '"C%2B%2B"',
            'resource_types': '', 'offset': 2}))
        self.assertNotEqual(audit.comparable_params({'q': '"C%2B%2B"'}),
                            audit.comparable_params({'q': '"C++"'}))


if __name__ == '__main__':
    unittest.main()
