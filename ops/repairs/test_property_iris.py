import copy
import unittest
import property_iris as p


class PropertyIriPlanTest(unittest.TestCase):
    def setUp(self):
        self.slot = {'path': '', 'route': [], 'name': 'value'}
        self.schema = {'properties': {'@context': {'properties': {}, 'required': ['schema']},
                                      'value': {'_ui': {'inputType': 'textfield'}}}}

    def test_reuses_existing_identity_and_preserves_values(self):
        source = {'value': {'@value': 'entered'}, '@context': {'schema': 'http://schema.org/'}}
        other = {'@context': {'value': 'urn:existing'}, 'value': {'@value': 'other'}}
        slots = p.resolve_slots([self.slot], [source, other])
        self.assertEqual(slots[0]['iri'], 'urn:existing')
        candidate = p.patch_instance(source, slots)
        self.assertEqual(candidate['value'], source['value'])
        p.assert_only_context_changes(source, candidate, slots)
        schema = p.patch_schema(self.schema, slots)
        p.assert_only_context_changes(self.schema, schema, slots, schema=True)
        self.assertEqual(schema['properties']['@context']['required'], ['schema', 'value'])

    def test_conflicting_existing_iris_block_migration(self):
        with self.assertRaises(p.Conflict):
            p.resolve_slots([self.slot], [{'@context': {'value': 'urn:a'}}, {'@context': {'value': 'urn:b'}}])

    def test_nested_arrays_and_missing_occurrences(self):
        slot = {**self.slot, 'route': ['a/b']}
        source = {'a/b': [{'value': {'@value': 'x'}}, {'value': {'@value': 'y'}}]}
        slots = p.resolve_slots([slot], [source, {}])
        candidate = p.patch_instance(source, slots)
        self.assertTrue(slots[0]['iri'].startswith(p.repair.PROPERTY_IRI_PREFIX))
        p.assert_only_context_changes(source, candidate, slots)
        self.assertEqual(candidate['a/b'][0]['@context'], candidate['a/b'][1]['@context'])
        self.assertEqual(p.patch_instance({}, slots), {})

    def test_invariant_rejects_value_changes_and_extra_context_keys(self):
        source = {'value': {'@value': 'original'}}
        slots = p.resolve_slots([self.slot], [source])
        candidate = p.patch_instance(source, slots)
        candidate['value']['@value'] = 'changed'
        with self.assertRaises(p.Conflict): p.assert_only_context_changes(source, candidate, slots)
        candidate = p.patch_instance(source, slots)
        candidate['@context']['other'] = 'urn:unexpected'
        with self.assertRaises(p.Conflict): p.assert_only_context_changes(source, candidate, slots)

    def test_static_and_attribute_groups_are_not_mapped(self):
        for kind in ['attribute-value', 'richtext']:
            schema = copy.deepcopy(self.schema)
            schema['properties']['value']['_ui']['inputType'] = kind
            slots = p.resolve_slots([self.slot], [])
            with self.assertRaises(p.Conflict): p.patch_schema(schema, slots)

    def test_never_overwrites_a_schema_or_instance_identity(self):
        slots = p.resolve_slots([self.slot], [])
        schema = p.patch_schema(self.schema, slots)
        with self.assertRaises(p.Conflict): p.patch_schema(schema, slots)
        with self.assertRaises(p.Conflict): p.patch_instance({'@context': {'value': 'urn:other'}}, slots)

    def test_audit_distinguishes_real_children_from_attribute_groups(self):
        field = {'@type': 'https://schema.metadatacenter.org/core/TemplateField',
                 '_ui': {'inputType': 'textfield'}, 'type': 'object'}
        group = {'@type': 'https://schema.metadatacenter.org/core/TemplateField',
                 '_ui': {'inputType': 'attribute-value'}, 'type': 'string'}
        schema = {'properties': {'@context': {'properties': {}}, 'value': field,
                                 'attributes': {'type': 'array', 'items': group}}}
        slots = p.missing_slots(schema)
        self.assertEqual([slot['name'] for slot in slots], ['value'])
        completed = p.patch_schema(schema, p.resolve_slots(slots, []))
        self.assertEqual(p.missing_slots(completed), [])
