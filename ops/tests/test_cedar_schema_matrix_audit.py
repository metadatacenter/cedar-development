"""Pin the full-corpus comparison contract; no array or YAML normalization is allowed."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import cedar_schema_matrix_audit as audit


class ComparisonTests(unittest.TestCase):
    def flags(self, outputs, yamls=None):
        rendered = {name: {'status': 'ok', 'yaml': value}
                    for name, value in (yamls or {'Java': 'name: "X"\n', 'TS': 'name: "X"\n'}).items()}
        validations = {audit.encoded(value, sort=True): {'status': 'valid'} for value in outputs.values()}
        return audit.comparison_flags(outputs, rendered, {'required': ['a', 'b']}, validations)

    def test_required_array_order_is_not_normalized(self):
        outputs = {str(i): {'required': ['a', 'b']} for i in range(4)}
        outputs['3'] = {'required': ['b', 'a']}
        self.assertFalse(self.flags(outputs)['allFourEqual'])

    def test_generated_object_order_is_separate_from_content(self):
        outputs = {str(i): {'a': 1, '11': 2} for i in range(4)}
        outputs['3'] = {'11': 2, 'a': 1}
        flags = self.flags(outputs)
        self.assertTrue(flags['allFourEqual'])
        self.assertFalse(flags['allFourSameGeneratedOrder'])

    def test_yaml_newline_and_escape_spelling_are_not_normalized(self):
        outputs = {str(i): {} for i in range(4)}
        for other in ['name: "X"', 'name: "X"\r\n', 'name: "\\x58"\n']:
            self.assertFalse(self.flags(outputs, {'Java': 'name: "X"\n', 'TS': other})['yamlByteEqual'])

    def test_missing_null_and_boolean_numeric_values_are_distinct(self):
        for other in [{'a': None}, {'a': False}, {'a': 0}, {}]:
            outputs = {str(i): {'a': True} for i in range(4)}
            outputs['3'] = other
            self.assertFalse(self.flags(outputs)['allFourEqual'])

    def test_three_successful_lanes_are_not_a_pass(self):
        flags = self.flags({str(i): {} for i in range(3)})
        for key in ['allFourProduced', 'allFourEqual', 'allFourValid', 'allFourSameGeneratedOrder']:
            self.assertFalse(flags[key])

    def test_cached_json_preserves_numeric_key_order_and_unicode(self):
        source = {'first': '☃', '11': 'line\u0085break', 'last': None}
        decoded = audit.unpack(audit.pack(source))
        self.assertEqual(list(source), list(decoded))
        self.assertEqual(source, decoded)


if __name__ == '__main__':
    unittest.main()
