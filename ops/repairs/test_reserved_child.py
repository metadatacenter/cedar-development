"""Regression checks for the approved reserved child renames."""
import copy
import unittest
import cedar_artifact_repair as r

TEMPLATE_AT_TYPE = 'https://schema.metadatacenter.org/core/Template'


def field(name, iri):
    return ({'@type': r.FIELD_AT_TYPE, 'schema:name': name,
             'properties': {'@value': {'type': ['string', 'null']}}, 'required': ['@value']},
            {'enum': [iri]})


def container(kind, children, order=None):
    """A template or element declaring these (name, label) children, each referenced everywhere."""
    node = {'@type': kind, 'properties': {'@context': {'properties': {}, 'required': []}},
            'required': ['@context'], '_ui': {'order': [], 'propertyLabels': {}, 'propertyDescriptions': {}}}
    for name, label in children:
        child, iri = field(name, 'urn:' + name)
        node['properties'][name] = child
        node['properties']['@context']['properties'][name] = iri
        node['properties']['@context']['required'].append(name)
        node['required'].append(name)
        node['_ui']['order'].append(name)
        node['_ui']['propertyLabels'][name] = label
        node['_ui']['propertyDescriptions'][name] = 'Help Text'
    if order is not None:
        node['_ui']['order'] = order
    return node


class ReservedChildTest(unittest.TestCase):
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
        before = {'@type': TEMPLATE_AT_TYPE,
                  'properties': {'a/b': {'type': 'array', 'items': self.element}}}
        after, changes = r.rename_reserved_child(before)
        node = after['properties']['a/b']['items']
        self.assertEqual(node['_ui']['order'], ['@xml:lang', 'value'])
        expected = copy.deepcopy(self.element['properties']['@value'])
        expected['schema:name'] = 'value'
        self.assertEqual(node['properties']['value'], expected)
        self.assertEqual(node['properties']['@context']['properties']['value'], {'enum': ['urn:unchanged']})
        self.assertIsNone(r.only_renamed_reserved_child(before, after))
        self.assertEqual(r.rename_reserved_child(after), (after, []))
        self.assertTrue(all(c['path'].startswith('/properties/a~1b/items/') for c in changes))
        self.assertIn('@value', self.element['properties'])

    def test_invariant_rejects_unrelated_changes(self):
        after, _ = r.rename_reserved_child(self.element)
        after['properties']['value']['required'] = []
        self.assertIsNotNone(r.only_renamed_reserved_child(self.element, after))

    def test_collision_refused(self):
        self.element['properties']['value'] = {}
        with self.assertRaises(r.TransformRefused):
            r.rename_reserved_child(self.element)

    def test_existing_order_position_preserved(self):
        self.element['_ui']['order'] = ['@value', '@xml:lang']
        after, _ = r.rename_reserved_child(self.element)
        self.assertEqual(after['_ui']['order'], ['value', '@xml:lang'])
        self.assertIsNone(r.only_renamed_reserved_child(self.element, after))

    def test_type_child_of_a_template_keeps_its_place_and_iri(self):
        before = container(TEMPLATE_AT_TYPE, [('Title', 'Title'), ('@Type', '@Type'), ('Size', 'Size')])
        after, _ = r.rename_reserved_child(before)
        self.assertNotIn('@Type', after['properties'])
        self.assertEqual(after['properties']['Type']['schema:name'], 'Type')
        self.assertEqual(after['properties']['@context']['properties']['Type'], {'enum': ['urn:@Type']})
        self.assertEqual(after['_ui']['order'], ['Title', 'Type', 'Size'])
        self.assertEqual(after['required'], ['@context', 'Title', 'Type', 'Size'])
        self.assertEqual(after['properties']['@context']['required'], ['Title', 'Type', 'Size'])
        self.assertEqual(after['_ui']['propertyLabels']['Type'], 'Type')
        self.assertEqual(after['_ui']['propertyDescriptions']['Type'], 'Help Text')
        self.assertIsNone(r.only_renamed_reserved_child(before, after))
        self.assertEqual(r.rename_reserved_child(after), (after, []))

    def test_two_reserved_children_of_one_element_are_renamed_in_one_pass(self):
        before = container(r.ELEMENT_AT_TYPE, [('@xml:lang', '@xml:lang'), ('@value', '@value')])
        after, _ = r.rename_reserved_child(before)
        self.assertEqual(after['_ui']['order'], ['xml:lang', 'value'])
        self.assertEqual(after['required'], ['@context', 'xml:lang', 'value'])
        self.assertEqual(after['properties']['@context']['required'], ['xml:lang', 'value'])
        self.assertEqual(set(after['_ui']['propertyLabels']), {'xml:lang', 'value'})
        self.assertIsNone(r.only_renamed_reserved_child(before, after))
        self.assertEqual(r.rename_reserved_child(after), (after, []))

    def test_a_label_that_differs_from_the_key_is_kept(self):
        before = container(r.ELEMENT_AT_TYPE, [('@xml:lang', 'Language')])
        after, _ = r.rename_reserved_child(before)
        self.assertEqual(after['_ui']['propertyLabels'], {'xml:lang': 'Language'})
        self.assertIsNone(r.only_renamed_reserved_child(before, after))

    def test_a_child_whose_name_disagrees_with_its_key_is_refused(self):
        before = container(TEMPLATE_AT_TYPE, [('@Type', '@Type')])
        before['properties']['@Type']['schema:name'] = 'Type'
        with self.assertRaises(r.TransformRefused):
            r.rename_reserved_child(before)


if __name__ == '__main__':
    unittest.main()
