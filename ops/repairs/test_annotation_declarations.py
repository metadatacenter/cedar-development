import copy
import unittest
import annotation_declarations as p


class AnnotationDeclarationsTest(unittest.TestCase):
    def setUp(self):
        self.source = {'@type': p.TEMPLATE, 'properties': {
            '@context': {'properties': {}, 'required': [], 'additionalProperties': False},
            'child': {'type': 'object'}}, 'required': ['child'], 'additionalProperties': False}
        self.canonical = copy.deepcopy(self.source)
        self.canonical['properties']['_annotations'] = {'type': 'object'}
        self.canonical['properties']['@context']['properties']['_annotations'] = {
            'type': 'string', 'enum': ['@nest']}

    def test_optional_additions_preserve_source_and_are_idempotent(self):
        before = copy.deepcopy(self.source)
        result, changes, safe = p.plan(self.source, self.canonical)
        self.assertEqual(self.source, before)
        self.assertEqual(changes, list(p.PATHS))
        self.assertTrue(safe)
        self.assertEqual(result['required'], ['child'])
        self.assertEqual(p.plan(result, self.canonical)[1], [])

    def test_open_containers_and_patterns_require_dependency_check(self):
        for path in ('root', 'context'):
            for change in ({'additionalProperties': True}, {'patternProperties': {'.*': {}}}):
                source = copy.deepcopy(self.source)
                node = source if path == 'root' else source['properties']['@context']
                node.update(change)
                self.assertFalse(p.plan(source, self.canonical)[2])

    def test_conflicting_or_required_annotations_are_not_overwritten(self):
        for path in p.PATHS:
            source = copy.deepcopy(self.source)
            p.holder(source, path)['_annotations'] = {'type': 'string'}
            with self.assertRaises(ValueError): p.plan(source, self.canonical)
        self.source['required'].append('_annotations')
        with self.assertRaises(ValueError): p.plan(self.source, self.canonical)

    def test_invariant_catches_unrelated_change_and_order_changes(self):
        result, changes, _ = p.plan(self.source, self.canonical)
        result['properties']['child']['title'] = 'changed'
        with self.assertRaises(AssertionError):
            p.assert_additions(self.source, result, self.canonical, changes)
        result, changes, _ = p.plan(self.source, self.canonical)
        result['properties']['child'] = result['properties'].pop('child')
        # Move the existing context after the child to alter their relative ordering.
        result['properties']['@context'] = result['properties'].pop('@context')
        with self.assertRaises(AssertionError):
            p.assert_additions(self.source, result, self.canonical, changes)

    def test_only_template_roots_are_supported(self):
        self.source['@type'] = 'https://schema.metadatacenter.org/core/TemplateElement'
        with self.assertRaises(ValueError): p.plan(self.source, self.canonical)


if __name__ == '__main__': unittest.main()
