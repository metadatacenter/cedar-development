import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import cedar_normalization_audit as audit


class EnumerationTests(unittest.TestCase):
    def test_runtime_pin_detects_rebuilt_dependencies_at_the_same_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, dependency, cp = root / 'bridge.java', root / 'library.jar', root / 'classpath.txt'
            source.write_text('bridge')
            dependency.write_bytes(b'first build')
            cp.write_text(str(dependency))
            before = audit.runtime_digest(source, cp)
            dependency.write_bytes(b'second build')
            self.assertNotEqual(before, audit.runtime_digest(source, cp))

    def test_missing_duplicate_changed_and_stale_rows_never_complete(self):
        baseline = dict(count=10, expected=10, listingErrors=0, duplicates=0, totalCountChanges=[])
        self.assertTrue(audit.enumeration_complete(baseline))
        for change in [dict(count=9), dict(listingErrors=1), dict(duplicates=1),
                       dict(totalCountChanges=[{'was': 9, 'now': 10}]), dict(inventoryCount=11)]:
            self.assertFalse(audit.enumeration_complete({**baseline, **change}))

    def test_offset_pages_use_observed_page_size_and_verify_final_total(self):
        calls = []
        def page(client, kind, limit, offset=None, continuation=None):
            calls.append(offset)
            start = offset or 0
            return {'totalCount': 5, 'resources': [{'@id': f'urn:{i}'} for i in range(start, min(5, start + min(limit, 2)))]}
        with patch.object(audit.rest, 'search_deep_page', side_effect=page):
            refs, meta = audit.enumerate_kind(None, 'field', 2)
        self.assertEqual([f'urn:{i}' for i in range(5)], [r.artifact_id for r in refs])
        self.assertTrue(audit.enumeration_complete(meta))
        self.assertEqual(sorted(x for x in calls if x is not None), [0, 2, 4])

    def test_zero_population_finishes_without_zero_step_range(self):
        with patch.object(audit.rest, 'search_deep_page', return_value={'totalCount': 0, 'resources': []}):
            refs, meta = audit.enumerate_kind(None, 'field')
        self.assertEqual([], refs)
        self.assertTrue(audit.enumeration_complete(meta))

    def test_artifact_and_occurrence_counts_are_separate(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE artifacts(kind TEXT,source BLOB,result BLOB)')
        db.execute('CREATE TABLE metadata(key TEXT,value TEXT)')
        row = audit.pack({'status': 'ok', 'complete': True, 'repairs': [{'issue': 'blank'}, {'issue': 'blank'}]})
        db.execute('INSERT INTO artifacts VALUES (?,?,?)', ('instance', b'body', row))
        summary = audit.summarize(db)
        self.assertEqual({'blank': 1}, summary['artifactCounts'])
        self.assertEqual({'blank': 2}, summary['occurrenceCounts'])
        self.assertFalse(summary['complete'])


class TransportTests(unittest.TestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            ports = []
            paths = []

            def do_GET(self):
                self.ports.append(self.client_address[1])
                self.paths.append(self.path)
                self.send_response(302 if self.path == '/redirect' else 200)
                self.send_header('Content-Length', '2')
                self.send_header('Location', 'https://elsewhere.invalid/secret')
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *args):
                pass
        self.handler = Handler
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.client = audit.KeepAliveGetOnlyClient(f'http://127.0.0.1:{self.server.server_port}',
                                                  'test-key', allow_http=True, retries=1)

    def tearDown(self):
        connection = getattr(self.client.opener.local, 'connection', None)
        if connection:
            connection.close()
        self.server.shutdown()
        self.server.server_close()

    def test_connection_is_reused(self):
        self.assertEqual({}, self.client.get_json('/one'))
        self.assertEqual({}, self.client.get_json('/two'))
        self.assertEqual(1, len(set(self.handler.ports)))

    def test_redirect_is_refused_without_a_second_request(self):
        with self.assertRaises(audit.rest.ResponseError):
            self.client.get_json('/redirect')
        self.assertEqual(['/redirect'], self.handler.paths)

    def test_transport_itself_refuses_foreign_origins_and_writes(self):
        import urllib.request
        for request in [urllib.request.Request('https://elsewhere.invalid/'),
                        urllib.request.Request(self.client.server + '/write', method='PUT')]:
            with self.assertRaises(ValueError):
                self.client.opener.open(request, timeout=1)
        self.assertEqual([], self.handler.paths)


if __name__ == '__main__':
    unittest.main()
