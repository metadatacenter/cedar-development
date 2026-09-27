"""Regression checks for the approved reserved child rename."""
import copy
import unittest
import cedar_artifact_repair as r

class ReservedValueChildTest(unittest.TestCase):
    def setUp(self):
        self.element = {'@type': r.ELEMENT_AT_TYPE, 'properties': {
            '@value': {'@type': r.FIELD_AT_TYPE, 'schema:name': '@value',
                       'properties': {'@value': {'type': ['string', 'null']}},
                       'required': ['@value'], 'skos:prefLabel': '値'},
            '@context': {'properties': {'@value': {'enum': ['urn:unchanged']}},
                         'required': ['@value']}},
            'required': ['@context', '@value'],
            '_ui': {'order': ['@xml:lang'], 'propertyLabels': {'@value': '@value'},
                    'propertyDescriptions': {'@value': 'Help Text'}}}

    def test_nested_rename_preserves_literal_schema_and_iri(self):
        before = {'@type': 'https://schema.metadatacenter.org/core/Template',
                  'properties': {'a/b': {'type': 'array', 'items': self.element}}}
        after, changes = r.rename_reserved_value_child(before)
        node = after['properties']['a/b']['items']
        self.assertEqual(node['_ui']['order'], ['@xml:lang', 'value'])
        expected = copy.deepcopy(self.element['properties']['@value'])
        expected['schema:name'] = 'value'
        self.assertEqual(node['properties']['value'], expected)
        self.assertEqual(node['properties']['@context']['properties']['value'], {'enum': ['urn:unchanged']})
        self.assertIsNone(r.only_renamed_reserved_value_child(before, after))
        self.assertEqual(r.rename_reserved_value_child(after), (after, []))
        self.assertTrue(all(c['path'].startswith('/properties/a~1b/items/') for c in changes))
        self.assertIn('@value', self.element['properties'])

    def test_invariant_rejects_unrelated_changes(self):
        after, _ = r.rename_reserved_value_child(self.element)
        after['properties']['value']['required'] = []
        self.assertIsNotNone(r.only_renamed_reserved_value_child(self.element, after))

    def test_collision_refused(self):
        self.element['properties']['value'] = {}
        with self.assertRaises(r.TransformRefused):
            r.rename_reserved_value_child(self.element)

    def test_existing_order_position_preserved(self):
        self.element['_ui']['order'] = ['@value', '@xml:lang']
        after, _ = r.rename_reserved_value_child(self.element)
        self.assertEqual(after['_ui']['order'], ['value', '@xml:lang'])
        self.assertIsNone(r.only_renamed_reserved_value_child(self.element, after))

if __name__ == '__main__':
    unittest.main()
