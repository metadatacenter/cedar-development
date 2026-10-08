import copy
import unittest
import cedar_provenance_restore_plan as restore
from cedar_provenance_audit import digest


class FreshRestorationPreflightTest(unittest.TestCase):
    def fixture(self):
        body = {'@id': 'urn:template', 'pav:lastUpdatedOn': '2017-12-29T08:48:17.987-08:00',
                'oslc:modifiedBy': 'urn:original', 'schema:name': 'Keep content'}
        graph = {'pav:lastUpdatedOn': '2026-09-25T20:02:23-07:00',
                 'oslc:modifiedBy': 'urn:admin', 'lastUpdatedOnTS': 1790391743}
        candidate = {'id': 'urn:template', 'kind': 'template', 'classification': 'eligible-unchanged-repair',
                     'expectedDocumentEtag': '"6"', 'expectedGraphEtag': '"1"',
                     'expectedDocumentSha256': digest(body), 'graph': graph}
        class Client:
            calls = 0
            def get(self, path):
                self.calls += 1
                if path.endswith('/details'): return copy.deepcopy(graph), '"1"', None
                return copy.deepcopy(body), '"6"', None
        return body, graph, candidate, Client()

    def test_preflight_creates_forward_and_guarded_rollback_parameters_without_writes(self):
        body, graph, candidate, client = self.fixture()
        result = restore.check_candidate(client, candidate)
        self.assertEqual(result['status'], 'ready-for-review')
        self.assertEqual(client.calls, 3)
        self.assertEqual(result['parameters']['modifiedBy'], 'urn:original')
        self.assertEqual(result['parameters']['lastUpdatedOnTS'], 1514566097)
        self.assertEqual(result['rollbackParameters']['expectedGraphRevision'], 2)
        self.assertEqual(result['rollbackParameters']['modifiedBy'], 'urn:admin')

    def test_content_changes_are_skipped_even_when_provenance_looks_the_same(self):
        body, graph, candidate, client = self.fixture()
        body['schema:name'] = 'Real edit after the audit'
        self.assertEqual(restore.check_candidate(client, candidate)['status'], 'changed')

    def test_graph_changes_are_skipped_even_with_unchanged_document_revision(self):
        body, graph, candidate, client = self.fixture()
        candidate['graph'] = copy.deepcopy(graph)
        graph['lastUpdatedOnTS'] += 1
        self.assertEqual(restore.check_candidate(client, candidate)['status'], 'changed')

    def test_noneligible_rows_do_not_even_make_a_network_request(self):
        body, graph, candidate, client = self.fixture()
        candidate['classification'] = 'no-retained-repair-evidence'
        self.assertEqual(restore.check_candidate(client, candidate)['status'], 'refused')
        self.assertEqual(client.calls, 0)

    def test_transient_or_authentication_errors_never_create_parameters(self):
        body, graph, candidate, client = self.fixture()
        class Unreadable:
            def get(self, path): raise OSError('network unavailable')
        self.assertEqual(restore.check_candidate(Unreadable(), candidate)['status'], 'unreadable')
        class Unauthorized:
            def get(self, path): raise restore.rest.AuthenticationError('401')
        with self.assertRaises(restore.rest.AuthenticationError): restore.check_candidate(Unauthorized(), candidate)


if __name__ == '__main__': unittest.main()
