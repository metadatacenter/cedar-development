"""Regressions from independent review of the production repair campaign."""
import argparse
import copy
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from test_cedar_artifact_repair import REPAIR as r, child, template, ELEMENT_TYPE


class SemanticSafetyTest(unittest.TestCase):
    def test_equal_values_do_not_collapse_different_predicates(self):
        before = {'@context': {'Repository': 'http://purl.org/dc/elements/1.1/source',
                               'Dataset_ID': 'http://purl.org/dc/elements/1.1/identifier'},
                  'Repository': {'@value': 'same'}, 'Dataset_ID': {'@value': 'same'}}
        self.assertEqual(r.superseded_keys(before, {'Dataset_ID'}), {})
        after = copy.deepcopy(before)
        del after['Repository']
        del after['@context']['Repository']
        self.assertIsNotNone(r.only_dropped_superseded_keys(
            before, after, template({'Dataset_ID': child()})))

    def test_nested_boolean_is_not_numeric_duplicate(self):
        before = {'@context': {'A': 'urn:p', 'B': 'urn:p'},
                  'A': {'@value': True}, 'B': {'@value': 1}}
        self.assertEqual(r.superseded_keys(before, {'B'}), {})

    def test_iri_values_are_not_empty(self):
        self.assertTrue(r.carries_a_value({'@id': 'urn:term'}))
        self.assertTrue(r.carries_a_value({'@value': False}))
        self.assertTrue(r.carries_a_value({'@value': 0}))
        self.assertFalse(r.carries_a_value({'@value': None, '@type': 'xsd:decimal'}))

    def test_rename_preserves_existing_iri_destination(self):
        t = template({'new': child()})
        before = {'old': {'@id': 'urn:old'}, 'new': {'@id': 'urn:current'}}
        changes = []
        after = r.renamed_container(before, t, {'old': 'new'}, '', changes)
        self.assertEqual(after, before)
        self.assertEqual(changes, [])
        self.assertIsNotNone(r.renamed_container_fault(
            before, {'new': before['old']}, t, {'old': 'new'}, ''))

    def test_two_populated_sources_are_refused_even_when_equal(self):
        before = {'A': {'@id': 'urn:a'}, 'B': {'@id': 'urn:a'}}
        with self.assertRaises(r.TransformRefused):
            r.chosen_source(before, ['A', 'B'])

    def test_completion_rejects_invented_value_in_declared_child(self):
        t = template({'Name': child()})
        after, _ = r.complete_instance({}, t)
        after['Name']['@value'] = 'invented'
        self.assertIsNotNone(r.only_completed_absences({}, after, t))

    def test_completion_rejects_undeclared_additions(self):
        self.assertIsNotNone(r.only_completed_absences({}, {'Invented': {}}, template({})))

    def test_completion_accepts_existing_element_with_missing_identity(self):
        e = child(ELEMENT_TYPE)
        e['properties'] = {'Name': child()}
        t = template({'Element': e})
        before = {'Element': {}}
        after, _ = r.complete_instance(before, t)
        self.assertIsNone(r.only_completed_absences(before, after, t))
        after['Element']['Name']['@value'] = 'invented'
        self.assertIsNotNone(r.only_completed_absences(before, after, t))


class WriteSafetyTest(unittest.TestCase):
    def run_repair(self, mutate=None, body=None, valid=True):
        class Client:
            def __init__(self):
                self.body = body or {'@id': 'urn:test', 'pav:derivedFrom': '', 'schema:name': 'old'}
            def get_with_etag(self, path):
                return copy.deepcopy(self.body), '"1"'
            def put_verbatim(self, path, candidate, etag):
                self.body = copy.deepcopy(candidate)
                if mutate:
                    mutate(self.body)
                return 200, '"2"'
        class Bridge:
            def validate(self, *args):
                return {'status': 'valid' if valid else 'invalid',
                        'errors': [] if valid else [{'message': 'invalid'}]}
        with tempfile.TemporaryDirectory() as folder:
            return r.repair_one(argparse.Namespace(apply=True, verify=True, preimages=folder),
                                [r.REPAIRS['empty-derived-from']], Client(), Bridge(), None,
                                r.rest.ArtifactRef('template', 'urn:test', 'test'))

    def test_readback_detects_unrelated_server_change(self):
        result = self.run_repair(lambda b: b.update({'schema:name': 'corrupted'}))
        self.assertFalse(result['verified'])
        self.assertIn('/schema:name', result['detail'])

    def test_readback_accepts_exact_candidate(self):
        self.assertTrue(self.run_repair()['verified'])

    def test_no_transform_does_not_mean_valid(self):
        result = self.run_repair(body={'@id': 'urn:test'}, valid=False)
        self.assertEqual(result['outcome'], 'still-invalid')

    def test_preimages_survive_repeated_attempts(self):
        ref = r.rest.ArtifactRef('template', 'urn:test', 'test')
        with tempfile.TemporaryDirectory() as folder:
            first = r.save_preimage(pathlib.Path(folder), ref, {'x': 1}, '"1"')
            second = r.save_preimage(pathlib.Path(folder), ref, {'x': 2}, '"2"')
            self.assertNotEqual(first, second)
            self.assertEqual(json.loads(first.read_text())['artifact'], {'x': 1})

    def test_missing_and_weak_etag_refused_before_network(self):
        client = r.RepairClient('https://example.org', 'test')
        for etag in [None, '', 'W/"1"']:
            with self.subTest(etag=etag), self.assertRaises(ValueError):
                client.put_verbatim('/templates/test', {}, etag)

    def test_context_migration_requires_explicit_scope(self):
        with patch('sys.stderr'), self.assertRaises(SystemExit):
            r.main(['--apply', '--repair', 'align-instance-context-iris',
                    '--from-records', 'unused.jsonl'])


class EmptySlotSafetyTest(unittest.TestCase):
    def test_preserve_empty_dynamic_attribute_members_and_their_context(self):
        for slot in ({'@value': None}, {}, []):
            with self.subTest(slot=slot):
                before = {'@context': {'Extra1': 'urn:extra', 'unused': 'urn:unused'},
                          'Extra': ['Extra1'], 'Extra1': slot, 'unused': {'@value': None}}
                t = template({'Extra': {'type': 'array', 'items': {'type': 'string'}}})
                after, changes = r.drop_empty_undeclared_keys(before, t)
                self.assertEqual(after['Extra1'], slot)
                self.assertEqual(after['@context']['Extra1'], 'urn:extra')
                self.assertEqual([c['path'] for c in changes], ['/unused'])
                self.assertIsNone(r.only_dropped_empty_undeclared_keys(before, after, t))
                del after['Extra1']
                del after['@context']['Extra1']
                self.assertIsNotNone(r.only_dropped_empty_undeclared_keys(before, after, t))

    def test_preserve_referenced_members_even_when_group_is_undeclared(self):
        before = {'Group': ['member'], 'member': {'@value': None}}
        self.assertEqual(r.drop_empty_undeclared_keys(before, template({})), (before, []))
        self.assertIsNotNone(r.only_dropped_empty_undeclared_keys(
            before, {'Group': ['member']}, template({})))


class CanonicalIriRequiredSafetyTest(unittest.TestCase):
    def test_relaxes_only_iri_presence_and_preserves_author_constraints(self):
        iri = child()
        iri['properties'] = {'@id': {'type': 'string'}, 'rdfs:label': {'type': 'string'}}
        iri['required'] = ['@id', 'rdfs:label']
        iri['_valueConstraints'] = {'requiredValue': True, 'ontologies': [{'acronym': 'DOID'}]}
        before = template({'Term': iri})
        after, changes = r.canonicalise_iri_field_required(before)
        self.assertEqual(len(changes), 1)
        self.assertNotIn('required', after['properties']['Term'])
        self.assertEqual(after['properties']['Term']['_valueConstraints'], iri['_valueConstraints'])
        self.assertIsNone(r.only_canonicalised_iri_field_required(before, after))
        self.assertEqual(r.canonicalise_iri_field_required(after)[1], [])
        after['properties']['Term']['_valueConstraints']['requiredValue'] = False
        self.assertIsNotNone(r.only_canonicalised_iri_field_required(before, after))

    def test_preserves_literal_ambiguous_and_container_requirements(self):
        for properties in ({'@value': {}}, {'@id': {}, '@value': {}}, {}):
            field = child()
            field.update(properties=properties, required=['@value'])
            before = template({'Field': field})
            self.assertEqual(r.canonicalise_iri_field_required(before), (before, []))
            bad = copy.deepcopy(before)
            del bad['properties']['Field']['required']
            self.assertIsNotNone(r.only_canonicalised_iri_field_required(before, bad))


class UnusedContextSafetyTest(unittest.TestCase):
    def test_removes_only_unused_undeclared_simple_mapping(self):
        before = {'@context': {'gone': 'urn:gone', 'Field': 'urn:field',
                               'complex': {'@id': 'urn:complex'}}, 'Field': {'@value': 'data'}}
        t = template({'Field': child()})
        after, changes = r.drop_unused_instance_context(before, t)
        self.assertEqual([x['path'] for x in changes], ['/@context/gone'])
        self.assertEqual(after['Field'], before['Field'])
        self.assertIsNone(r.only_dropped_unused_context(before, after, t))
        self.assertEqual(r.drop_unused_instance_context(after, t)[1], [])


class NoncanonicalContextDemandSafetyTest(unittest.TestCase):
    def test_removes_orphan_and_attribute_demands_without_removing_mappings(self):
        attr = child()
        attr['_ui'] = {'inputType': 'attribute-value'}
        before = template({'Name': child(), 'Attributes': {'type': 'array', 'items': attr}})
        before['properties']['@context'] = {
            'properties': {'Old': {'enum': ['urn:old']}, 'Attributes': {'enum': ['urn:attributes']}},
            'required': ['schema', 'rdfs:label', 'Name', 'Old', 'Attributes']}
        after, changes = r.drop_noncanonical_context_demands(before)
        self.assertEqual(after['properties']['@context']['required'], ['schema', 'rdfs:label', 'Name'])
        self.assertEqual(after['properties']['@context']['properties'], before['properties']['@context']['properties'])
        self.assertEqual(len(changes), 1)
        self.assertIsNone(r.only_dropped_noncanonical_context_demands(before, after))
        after['properties']['@context']['required'].remove('Name')
        self.assertIsNotNone(r.only_dropped_noncanonical_context_demands(before, after))

    def test_does_not_change_field_requirements_or_other_schema_content(self):
        field = child()
        field['required'] = ['@value']
        before = template({'Field': field})
        self.assertEqual(r.drop_noncanonical_context_demands(before), (before, []))
        bad = copy.deepcopy(before)
        bad['properties']['Field']['required'] = []
        self.assertIsNotNone(r.only_dropped_noncanonical_context_demands(before, bad))


class UnusedContextReferenceSafetyTest(unittest.TestCase):
    def test_retains_references_in_keys_types_groups_and_nested_content(self):
        for content in ({'Term': {}}, {'@type': 'Term'}, {'@type': 'Term:Type'},
                        {'Group': ['Term']}, {'Nested': {'Term': {'@value': None}}},
                        {'@context': {'alias': 'Term:Type'}}):
            before = copy.deepcopy(content)
            before.setdefault('@context', {})['Term'] = 'urn:term'
            after, changes = r.drop_unused_instance_context(before, template({}))
            self.assertEqual(after['@context']['Term'], 'urn:term')
            self.assertFalse(any(x['path'] == '/@context/Term' for x in changes))
            self.assertEqual({k: v for k, v in after.items() if k != '@context'},
                             {k: v for k, v in before.items() if k != '@context'})
            bad = copy.deepcopy(before)
            del bad['@context']['Term']
            self.assertIsNotNone(r.only_dropped_unused_context(before, bad, template({})))

    def test_preserves_declared_mapping_without_a_value(self):
        t = template({})
        t['properties']['@context'] = {'properties': {'Declared': {'enum': ['urn:d']}}}
        before = {'@context': {'Declared': 'urn:d'}}
        self.assertEqual(r.drop_unused_instance_context(before, t), (before, []))

    def test_nested_element_context(self):
        e = child(ELEMENT_TYPE)
        e['properties'] = {}
        t = template({'Element': e})
        before = {'Element': {'@context': {'gone': 'urn:gone'}}}
        after, changes = r.drop_unused_instance_context(before, t)
        self.assertEqual(len(changes), 1)
        self.assertIsNone(r.only_dropped_unused_context(before, after, t))


class EmptySlotCompletionSafetyTest(unittest.TestCase):

    def test_prune_only_explicit_undeclared_empties(self):
        before = {'@context': {'empty': 'urn:e', 'iri': 'urn:i'},
                  'empty': {'@value': None}, 'iri': {'@id': 'urn:term'},
                  'zero': {'@value': 0}, 'false': {'@value': False},
                  'label': {'rdfs:label': 'entered'}, 'declared': {}}
        t = template({'declared': child()})
        after, changes = r.drop_empty_undeclared_keys(before, t)
        self.assertEqual([c['path'] for c in changes], ['/empty'])
        self.assertIsNone(r.only_dropped_empty_undeclared_keys(before, after, t))
        self.assertEqual(r.drop_empty_undeclared_keys(after, t)[1], [])
        del after['iri']
        self.assertIsNotNone(r.only_dropped_empty_undeclared_keys(before, after, t))

    def test_null_literal_completion_requires_nullable_declaration(self):
        c = child()
        c['properties'] = {'@value': {'type': ['string', 'null']}}
        t = template({'Date': c})
        before = {'Date': {'@type': 'xsd:date'}}
        after, changes = r.complete_empty_literal(before, t)
        self.assertEqual(after['Date'], {'@type': 'xsd:date', '@value': None})
        self.assertIsNone(r.only_completed_empty_literals(before, after, t))
        self.assertEqual(r.complete_empty_literal(after, t)[1], [])
        after['Date']['@value'] = 'invented'
        self.assertIsNotNone(r.only_completed_empty_literals(before, after, t))
        c['properties']['@value']['type'] = 'string'
        self.assertEqual(r.complete_empty_literal(before, template({'Date': c}))[1], [])

    def test_do_not_complete_a_labeled_or_iri_slot(self):
        c = child()
        c['properties'] = {'@value': {'type': ['string', 'null']}}
        t = template({'Field': c})
        for slot in [{'rdfs:label': 'entered'}, {'@id': 'urn:term'}]:
            self.assertEqual(r.complete_empty_literal({'Field': slot}, t)[1], [])


class OrcidSpacingTest(unittest.TestCase):
    def test_checksum_valid_numeric_and_x_identifiers(self):
        for identifier in ['0000-0002-1825-0097', '0000-0001-8771-090X']:
            self.assertEqual(r.normalized_spaced_orcid('https://orcid.org/ ' + identifier),
                             'https://orcid.org/' + identifier)

    def test_does_not_guess_or_change_identifiers(self):
        for value in ['https://orcid.org/ 0000-0002-1825-0098',
                      'https://example.org/ 0000-0002-1825-0097',
                      'https://orcid.org/ 0000 0002 1825 0097',
                      'https://orcid.org/0000-0002-1825-0097', None]:
            self.assertIsNone(r.normalized_spaced_orcid(value))

    def test_transform_invariant_and_idempotence(self):
        c = child()
        c['properties'] = {'@id': {'type': 'string'}}
        t = template({'ORCID': c})
        before = {'ORCID': {'@id': 'https://orcid.org/ 0000-0002-1825-0097', 'rdfs:label': 'untouched'}}
        after, changes = r.normalize_instance_orcid_spacing(before, t)
        self.assertEqual(len(changes), 1)
        self.assertIsNone(r.only_normalized_orcid_spacing(before, after, t))
        self.assertEqual(r.normalize_instance_orcid_spacing(after, t)[1], [])
        after['ORCID']['rdfs:label'] = 'changed'
        self.assertIsNotNone(r.only_normalized_orcid_spacing(before, after, t))


if __name__ == '__main__':
    unittest.main()
