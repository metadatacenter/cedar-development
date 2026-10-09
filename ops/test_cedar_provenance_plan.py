import copy
import json
from pathlib import Path
import tempfile
import unittest
import cedar_provenance_plan as plan


class RestorationClassificationTest(unittest.TestCase):
    def test_relative_preimages_resolve_against_the_campaign_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'repairs').mkdir(); (root / 'before').mkdir()
            source = {'@id': 'urn:item', 'title': 'old'}
            (root / 'before/item.json').write_text(json.dumps({'artifact': source}))
            row = {'outcome': 'repaired', 'verified': True, 'artifactId': 'urn:item',
                   'preimage': 'before/item.json', 'repair': 'derive-title', 'newEtag': '"1-resource-record"',
                   'changes': [{'path': '/title', 'replaced': 'old', 'wrote': 'new'}]}
            (root / 'campaign.jsonl').write_text(json.dumps(row) + '\n')
            evidence, problems = plan.evidence_index(root / 'repairs', root)
            self.assertEqual(problems, [])
            self.assertEqual(evidence['urn:item'][0]['postimageSha256'], plan.digest({**source, 'title': 'new'}))

    def fixture(self):
        doc = {'pav:lastUpdatedOn': '2017-12-29T08:48:17-08:00', 'oslc:modifiedBy': 'urn:author'}
        graph = {'pav:lastUpdatedOn': '2026-09-25T20:02:23-07:00', 'oslc:modifiedBy': 'urn:admin'}
        row = {'complete': True, 'document': doc, 'graph': graph,
               'documentGraphMismatch': list(plan.MODIFICATION), 'listingGraphMismatch': [],
               'documentSha256': 'hash', 'documentEtag': '"6"'}
        event = {'beforeModification': copy.deepcopy(doc), 'writeEpoch': 1790391742.958894,
                 'postimageSha256': 'hash', 'documentEtag': '"6"'}
        return row, event

    def test_requires_unchanged_body_revision_original_provenance_and_write_time(self):
        row, event = self.fixture()
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'eligible-unchanged-repair')
        for property, value in [('documentEtag', '"7"'), ('documentSha256', 'changed')]:
            changed = copy.deepcopy(row); changed[property] = value
            self.assertNotEqual(plan.classify(changed, [event], 'urn:admin')[0], 'eligible-unchanged-repair')
        event['beforeModification']['oslc:modifiedBy'] = 'urn:other'
        self.assertNotEqual(plan.classify(row, [event], 'urn:admin')[0], 'eligible-unchanged-repair')

    def test_later_legitimate_edits_and_unproven_admin_writes_are_review_only(self):
        row, event = self.fixture()
        row['graph']['pav:lastUpdatedOn'] = '2026-10-07T20:02:23-07:00'
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'repair-history-but-current-state-unproven')
        row['graph']['oslc:modifiedBy'] = 'urn:real-editor'
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'different-graph-modifier-review')

    def test_does_not_invent_missing_originals_or_treat_creation_drift_as_repair_damage(self):
        row, event = self.fixture()
        row['document']['pav:lastUpdatedOn'] = None
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'missing-original-provenance-review')
        row['documentGraphMismatch'] = ['pav:createdOn']
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'creation-only-difference')

    def test_incomplete_reads_and_missing_or_weak_revisions_never_qualify(self):
        row, event = self.fixture()
        row['complete'] = False
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0], 'unreadable')
        row['complete'] = True
        for tag in (None, '', 'W/"6"', '"6-resource-record"'):
            row['documentEtag'] = event['documentEtag'] = tag
            self.assertNotEqual(plan.classify(row, [event], 'urn:admin')[0], 'eligible-unchanged-repair')

    def test_recorded_root_title_reconstruction_preserves_all_other_content(self):
        source = {'title': 'old', 'pav:lastUpdatedOn': '2017-12-29T08:48:17-08:00',
                  'properties': {'title': {'const': 'untouched'}}}
        event = {'repair': 'derive-title', 'changes': [{'path': '/title', 'replaced': 'old', 'wrote': 'new'}]}
        after = plan.recorded_scalar_postimage(source, event)
        self.assertEqual(after, {**source, 'title': 'new'})
        self.assertEqual(source['title'], 'old')
        event['changes'][0]['replaced'] = 'wrong prior title'
        self.assertIsNone(plan.recorded_scalar_postimage(source, event))
        self.assertEqual(plan.content_revision('"1-resource-record"'), '"1"')
        self.assertEqual(plan.content_revision('"1--gzip"'), '"1"')
        self.assertIsNone(plan.content_revision('W/"1"'))

    def test_concurrent_listing_drift_requires_review(self):
        row, event = self.fixture()
        row['listingGraphMismatch'] = ['oslc:modifiedBy']
        self.assertNotEqual(plan.classify(row, [event], 'urn:admin')[0], 'eligible-unchanged-repair')

    def test_unread_documents_remain_review_only_even_with_matching_listing_and_repair(self):
        row, event = self.fixture()
        row = {'notObserved': True, 'listing': row['graph']}
        self.assertEqual(plan.classify(row, [event], 'urn:admin')[0],
                         'listed-repair-correlated-needs-document-read')
        self.assertEqual(plan.classify(row, [], 'urn:admin')[0], 'not-observed')

    def test_nested_scalar_replay_checks_prior_values_and_decodes_json_pointers(self):
        source = {'title': 'old', 'properties': {'a/b~c': {'title': 'nested'}}}
        event = {'repair': 'derive-title', 'changes': [
            {'path': '/title', 'replaced': 'old', 'wrote': 'new'},
            {'path': '/properties/a~1b~0c/title', 'replaced': 'nested', 'wrote': 'new nested'}]}
        after = plan.recorded_scalar_postimage(source, event)
        self.assertEqual(after['properties']['a/b~c']['title'], 'new nested')
        self.assertEqual(source['title'], 'old')
        event['changes'][1]['replaced'] = 'wrong'
        self.assertIsNone(plan.recorded_scalar_postimage(source, event))

    def test_array_or_unrecorded_or_unknown_edits_are_not_reconstructed(self):
        event = {'repair': 'complete-context-required', 'changes': [
            {'path': '/required', 'replaced': None, 'wrote': 'a'}]}
        self.assertIsNone(plan.recorded_scalar_postimage({'required': []}, event))
        event = {'repair': 'derive-title', 'changes': [{'path': '/title', 'replaced': 'a', 'wrote': 'b'}],
                 'pathsRemoved': ['/other']}
        self.assertIsNone(plan.recorded_scalar_postimage({'title': 'a'}, event))


if __name__ == '__main__': unittest.main()
