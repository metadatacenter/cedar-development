"""Full-run counts use each artifact's latest verdict, including retry recovery."""
import pathlib
import sys
import unittest
import threading
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import cedar_instance_matrix_full as audit
from test_cedar_instance_matrix_smoke import Bridge


class FullMatrixTests(unittest.TestCase):
    def test_retry_replaces_unread_and_keeps_regression_distinct(self):
        states = {'id': audit.compact({'fetchError': 'timeout'})}
        self.assertEqual({'unread': 1}, audit.summarize(states)['sourceValidation'])
        record = {'sourceValidation': {'status': 'valid'}, 'template': 'urn:t',
                  'pairings': {lane: {'completedValidation': {'status': 'valid'}} for lane in audit.LANES},
                  **{flag: True for flag in audit.FLAGS}}
        record['pairings']['java->java']['completedValidation']['status'] = 'invalid'
        states['id'] = audit.compact(record)
        result = audit.summarize(states)
        self.assertEqual(1, result['processed'])
        self.assertEqual({'valid': 1}, result['sourceValidation'])
        self.assertEqual(1, result['flags']['validSourceRegression:java->java'])
        self.assertEqual(1, result['flags']['allFourEqual'])

    def test_slow_read_does_not_block_ready_results(self):
        gate = threading.Event()
        def fetch(client, ref):
            if ref == 'slow':
                gate.wait(2)
            return ref, None
        stream = audit.fetch_ready(None, ['slow', 'fast'], fetch, workers=2)
        try:
            self.assertEqual(('fast', 'fast', None), next(stream))
        finally:
            gate.set()
        self.assertEqual([('slow', 'slow', None)], list(stream))

    def test_missing_template_does_not_modify_source(self):
        source = {'@id': 'urn:i'}
        record, _, _ = audit.smoke.evaluate_instance(
            {'java': Bridge(source), 'typescript': Bridge(source)}, Bridge({}), {},
            audit.rest.ArtifactRef('instance', 'urn:i', ''), source)
        self.assertEqual({'@id': 'urn:i'}, source)
        self.assertIsNone(record['template'])
        self.assertTrue(all(p['completedValidation']['status'] == 'template-missing'
                            for p in record['pairings'].values()))


if __name__ == '__main__':
    unittest.main()
