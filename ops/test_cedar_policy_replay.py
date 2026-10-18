"""The replay gate must fail on data loss or incomplete output, without exposing source values."""
import contextlib
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
from cedar_policy_replay import compare, equivalent


class ReplayTest(unittest.TestCase):
    def test_semantic_equality_preserves_types_strings_and_exact_numbers(self):
        self.assertTrue(equivalent({'v': 1}, {'v': Decimal('1.0')}))
        self.assertFalse(equivalent({'v': True}, {'v': 1}))
        self.assertFalse(equivalent({'v': Decimal('0.10000000000000001')}, {'v': Decimal('0.1')}))
        self.assertFalse(equivalent({'e\u0301': 'value'}, {'é': 'value'}))
        self.assertFalse(equivalent({'v': '\u00a0'}, {'v': ''}))

    def test_truncated_output_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in [('values', '{"kind":"text","value":"private"}\n'), ('java', '[false,7]\n'), ('ts', '')]:
                (root / name).write_text(content)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                compare(root / 'values', root / 'java', root / 'ts', root / 'summary')

    def test_matching_loss_in_both_languages_still_fails_the_source_lane(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'values').write_text(json.dumps({'kind': 'json-source', 'value': '{"v":9007199254740993}'}) + '\n')
            for name in ('java', 'ts'):
                (root / name).write_text(json.dumps('{"v":9007199254740992}') + '\n')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertFalse(compare(root / 'values', root / 'java', root / 'ts', root / 'summary'))
            self.assertNotIn('9007199254740993', output.getvalue())
            self.assertEqual(json.loads((root / 'summary').read_text())['differences'], [{'row': 1, 'kind': 'json-source'}])


if __name__ == '__main__': unittest.main()
