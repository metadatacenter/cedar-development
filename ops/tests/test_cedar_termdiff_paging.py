import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock
import urllib.error

OPS = Path(__file__).parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, OPS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


termdiff = load('termdiff', 'cedar_termdiff.py')
bench = load('term_bench', 'cedar_term_bench.py')


class FakeSearch:
    """Integrated search over `total` rows, answering the offset-paged envelope."""

    def __init__(self, total, refuse_from=None):
        self.total = total
        self.refuse_from = refuse_from
        self.requests = []

    def __call__(self, server, value_constraints, input_text, limit, offset, api_key, timeout):
        self.requests.append((limit, offset))
        if limit > termdiff.MAX_LIMIT or (self.refuse_from is not None and offset >= self.refuse_from):
            raise urllib.error.HTTPError('u', 400, 'refused', {}, io.BytesIO())
        rows = [{'@id': f'urn:{i}', 'prefLabel': f'term {i}'} for i in range(offset, min(offset + limit, self.total))]
        return {'totalCount': self.total, 'request': {'limit': limit, 'offset': offset},
                'currentOffset': offset, 'collection': rows}


class TermdiffPagingTest(unittest.TestCase):
    def fetch(self, fake, probe_size=termdiff.MAX_LIMIT, max_results=5000):
        with mock.patch.object(termdiff, 'post_search', fake):
            return termdiff.fetch_all('http://t', {}, '', probe_size, max_results, None, 1, 1)

    def test_a_large_set_is_reached_by_walking_offsets_in_windows_the_endpoint_accepts(self):
        fake = FakeSearch(1234)
        ids, labels, total, truncated = self.fetch(fake)
        self.assertEqual((1234, False), (total, truncated))
        self.assertEqual([f'urn:{i}' for i in range(1234)], ids)
        self.assertEqual('term 1233', labels['urn:1233'])
        self.assertEqual([(500, 0), (500, 500), (234, 1000)], fake.requests)

    def test_no_request_asks_for_more_than_the_maximum(self):
        fake = FakeSearch(30)
        ids, _, _, truncated = self.fetch(fake, probe_size=1000)
        self.assertEqual(([(500, 0)], 30, False), (fake.requests, len(ids), truncated))

    def test_a_set_past_the_cap_is_truncated_at_the_cap(self):
        fake = FakeSearch(1200)
        ids, _, total, truncated = self.fetch(fake, max_results=700)
        self.assertEqual((1200, True, 700), (total, truncated, len(ids)))
        self.assertEqual([(500, 0), (200, 500)], fake.requests)

    def test_a_refused_window_keeps_what_was_read_and_marks_the_set_incomplete(self):
        fake = FakeSearch(1200, refuse_from=500)
        ids, _, _, truncated = self.fetch(fake)
        self.assertEqual((500, True), (len(ids), truncated))

    def test_the_request_body_states_limit_and_offset_and_no_page(self):
        sent = {}

        class Answer(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def urlopen(req, timeout):
            sent.update(json.loads(req.data))
            return Answer(b'{"totalCount": 0, "collection": []}')

        with mock.patch.object(termdiff.urllib.request, 'urlopen', urlopen):
            termdiff.post_search('http://t', {}, 'x', 50, 100, None, 1)
        self.assertEqual((50, 100), (sent['limit'], sent['offset']))
        self.assertNotIn('page', sent)
        self.assertNotIn('pageSize', sent)


class TermBenchPagingTest(unittest.TestCase):
    def test_both_lookups_send_limit_and_offset_and_no_page(self):
        bodies = []
        with mock.patch.object(bench, 'post', lambda path, body: bodies.append((path, body))):
            bench.integrated('DOID', 'cancer', 50)
            bench.versioned('cancer', ['DOID'], 10)
        for path, body in bodies:
            self.assertNotIn('page', body, path)
            self.assertNotIn('pageSize', body, path)
        self.assertEqual((50, 0), (bodies[0][1]['limit'], bodies[0][1]['offset']))
        self.assertEqual((10, 0), (bodies[1][1]['limit'], bodies[1][1]['offset']))


if __name__ == '__main__':
    unittest.main()
