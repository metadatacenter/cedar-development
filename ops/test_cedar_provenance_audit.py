"""Read-only transport, census completeness and provenance comparison regressions."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cedar_provenance_audit as audit


class ProvenanceAuditTest(unittest.TestCase):
    def test_logging_backpressure_stops_all_readers_without_more_production_requests(self):
        class Monitor:
            calls = 0
            def get(self, path):
                self.calls += 1
                return {'appLogQueueDepth': 4500000, 'worstLagSeconds': 2300}, None, None
        monitor = Monitor()
        with tempfile.TemporaryDirectory() as directory:
            guard = audit.ProductionLoadGuard(monitor, Path(directory) / 'guard.json')
            for _ in range(3):
                with self.assertRaises(audit.ReadPressureError): guard.check()
        self.assertEqual(monitor.calls, 1)
        class Stopped:
            def get(self, path): guard.check()
        with self.assertRaises(audit.ReadPressureError):
            audit.inspect(Stopped(), {'kind': 'template', 'id': 'id', 'listing': {}})

    def test_logging_capacity_guard_fails_closed_and_caches_healthy_checks(self):
        class Monitor:
            calls = 0
            def get(self, path):
                self.calls += 1
                return {'appLogQueueDepth': 20, 'worstLagSeconds': 10}, None, None
        monitor = Monitor()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'guard.json'
            guard = audit.ProductionLoadGuard(monitor, path)
            guard.check(); guard.check()
            self.assertEqual(monitor.calls, 1)
            class Unavailable:
                def get(self, path): raise audit.ReadError('monitor unavailable')
            with self.assertRaises(audit.ReadPressureError): audit.ProductionLoadGuard(Unavailable(), path).check()

    def test_same_instant_with_offsets_and_fractional_precision_is_not_a_false_mismatch(self):
        self.assertEqual([], audit.compare({'pav:lastUpdatedOn': '2017-12-29T08:48:17.987-08:00'},
                                           {'pav:lastUpdatedOn': '2017-12-29T16:48:17Z'}))
        self.assertEqual(['oslc:modifiedBy'], audit.compare({'oslc:modifiedBy': 'author'},
                                                           {'oslc:modifiedBy': 'admin'}))

    def test_untimestamped_strings_and_user_identifiers_are_not_normalized(self):
        self.assertEqual(['pav:lastUpdatedOn'], audit.compare({'pav:lastUpdatedOn': 'not-a-date'}, {}))
        self.assertEqual(['oslc:modifiedBy'], audit.compare({'oslc:modifiedBy': 'author'}, {}))

    def test_client_refuses_foreign_origin_and_redirect_paths(self):
        for server in ('http://example.org', 'https://user:password@example.org', 'https://example.org/path'):
            with self.assertRaises(ValueError): audit.PersistentGetClient(server, 'secret')
        client = audit.PersistentGetClient('https://example.org', 'secret')
        for path in ('https://other.org', '//other.org'):
            with self.assertRaises(ValueError): client.get(path)

    def test_client_uses_only_get_and_never_follows_redirects(self):
        class Response:
            status = 302
            def read(self): return b'credential-containing error must not escape'
        class Connection:
            def request(self, method, path, headers):
                self.method, self.path = method, path
            def getresponse(self): return Response()
        connection = Connection()
        client = audit.PersistentGetClient('https://example.org', 'secret')
        client.local.connection = connection
        with self.assertRaises(audit.ReadError) as caught: client.get('/templates/id')
        self.assertEqual(connection.method, 'GET')
        self.assertNotIn('credential', str(caught.exception))
        self.assertNotIn('secret', str(caught.exception))

    def test_offset_fallback_requires_unique_complete_coverage(self):
        class Client:
            def get(self, path, params):
                offset = params.get('offset', 0)
                rows = [{'@id': 'id' + str(i)} for i in range(offset, min(offset + 2, 5))]
                return {'totalCount': 5, 'resources': rows}, None, None
        with tempfile.TemporaryDirectory() as directory, patch.object(audit, 'KINDS', ('template',)):
            rows, coverage = audit.inventory(Client(), Path(directory), workers=2)
        self.assertEqual(len(rows), 5)
        self.assertTrue(coverage['template']['complete'])

    def test_duplicate_pages_cannot_be_reported_complete(self):
        class Client:
            def get(self, path, params):
                return {'totalCount': 4, 'resources': [{'@id': 'a'}, {'@id': 'b'}]}, None, None
        with tempfile.TemporaryDirectory() as directory, patch.object(audit, 'KINDS', ('template',)):
            rows, coverage = audit.inventory(Client(), Path(directory), workers=2)
        self.assertFalse(coverage['template']['complete'])
        self.assertEqual(coverage['template']['duplicates'], 2)

    def test_snapshot_continuations_are_followed_without_offsets(self):
        class Client:
            def get(self, path, params):
                assert 'offset' not in params
                first = params['continuation'] == 'start'
                return {'totalCount': 2, 'resources': [{'@id': 'a' if first else 'b'}],
                        'continuation': 'next' if first else None}, None, None
        with tempfile.TemporaryDirectory() as directory, patch.object(audit, 'KINDS', ('template',)):
            rows, coverage = audit.inventory(Client(), Path(directory))
        self.assertEqual(len(rows), 2)
        self.assertTrue(coverage['template']['complete'])

    def test_inspection_retains_both_sources_and_fails_closed_on_read_errors(self):
        class Client:
            def get(self, path):
                if path.endswith('/details'): return {'oslc:modifiedBy': 'admin'}, '"3-resource-record"', None
                return {'@id': 'id', 'oslc:modifiedBy': 'author'}, '"6"', None
        row = {'kind': 'template', 'id': 'id', 'listing': {'oslc:modifiedBy': 'admin'}}
        record = audit.inspect(Client(), row)
        self.assertTrue(record['complete'])
        self.assertEqual(record['documentGraphMismatch'], ['oslc:modifiedBy'])
        self.assertEqual(record['documentEtag'], '"6"')
        class Unreadable:
            def get(self, path): raise audit.ReadError('404')
        self.assertFalse(audit.inspect(Unreadable(), row)['complete'])

    def test_authentication_failure_stops_instead_of_becoming_an_artifact_finding(self):
        class Client:
            def get(self, path): raise audit.rest.AuthenticationError('401')
        with self.assertRaises(audit.rest.AuthenticationError):
            audit.inspect(Client(), {'kind': 'template', 'id': 'id', 'listing': {}})


if __name__ == '__main__': unittest.main()
