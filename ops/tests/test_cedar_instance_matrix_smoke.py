"""Keep byte/order agreement and validation regressions distinct in the instance matrix."""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import cedar_instance_matrix_smoke as audit


class Bridge:
    def __init__(self, output, yaml='same\n', completion='valid', fail=False):
        self.output, self.yaml, self.completion, self.fail = output, yaml, completion, fail

    def ask(self, request):
        if request['op'] == 'render':
            return {'status': 'error', 'error': 'reader refused'} if self.fail else {'status': 'ok', 'yaml': self.yaml}
        if request['op'] == 'convert':
            return {'status': 'ok', 'jsonText': json.dumps(self.output)}
        if request['op'] == 'complete-instance':
            return {'status': self.completion, 'json': self.output}
        return {'status': 'valid'}


class InstanceMatrixTests(unittest.TestCase):
    def evaluate(self, java, ts):
        source = {'@id': 'urn:instance', 'schema:isBasedOn': 'urn:template'}
        ref = audit.matrix.rest.ArtifactRef('instance', 'urn:instance', 'Example')
        return audit.evaluate_instance({'java': java, 'typescript': ts}, Bridge({}),
                                       {'urn:template': {}}, ref, source)[0]

    def test_equal_content_is_not_equal_order_or_yaml(self):
        record = self.evaluate(Bridge({'a': 1, 'b': 2}), Bridge({'b': 2, 'a': 1}, yaml='other\n'))
        self.assertTrue(record['allFourEqual'])
        self.assertFalse(record['allFourSameGeneratedOrder'])
        self.assertFalse(record['yamlByteEqual'])

    def test_completion_failure_does_not_get_hidden_by_parity(self):
        record = self.evaluate(Bridge({}, completion='invalid'), Bridge({}))
        self.assertTrue(record['allFourEqual'])
        self.assertEqual('valid', record['sourceValidation']['status'])
        self.assertEqual('invalid', record['pairings']['java->java']['completedValidation']['status'])

    def test_failed_writer_is_not_counted_as_agreement(self):
        record = self.evaluate(Bridge({}, fail=True), Bridge({}))
        self.assertFalse(record['allFourProduced'])
        self.assertFalse(record['allFourEqual'])
        self.assertFalse(record['yamlByteEqual'])


if __name__ == '__main__':
    unittest.main()
