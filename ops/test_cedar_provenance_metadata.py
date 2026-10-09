import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cedar_provenance_apply as repair
import cedar_provenance_metadata as policy
from cedar_provenance_audit import digest
import test_cedar_provenance_apply as fixtures


class MetadataEvidenceTest(unittest.TestCase):
    def setUp(self):
        fixtures.RestorationTest.setUp(self)
        self.candidate.update(classification=policy.CLASSIFICATION, repairActor='urn:repair',
            metadataEvidence={'policy': policy.POLICY, 'artifactId': 'urn:test', 'repairActor': 'urn:repair',
                'verifiedRepair': True, 'writeEpoch': 1790294400, 'windowSeconds': 120,
                'beforeModification': copy.deepcopy(self.candidate['evidence']['beforeModification']),
                'recordSha256': 'a'*64, 'preimageSha256': 'b'*64})

    def prepare(self): return repair.prepare(self.candidate, self.stored, self.graph, repair_user='urn:repair')

    def test_missing_historical_content_hash_and_revision_are_allowed_only_with_opt_in(self):
        self.candidate['evidence'].pop('postimageSha256')
        self.candidate['evidence'].pop('documentEtag')
        self.assertEqual(self.prepare()['parameters']['modifiedBy'], 'urn:original')
        with self.assertRaises(ValueError): repair.prepare(self.candidate, self.stored, self.graph)

    def test_known_historical_body_difference_does_not_override_current_metadata_evidence(self):
        self.candidate['evidence']['postimageSha256'] = 'f'*64
        self.assertEqual(self.prepare()['documentSha256'], digest(self.body))

    def test_non_admin_modifier_is_excluded_even_if_snapshot_matches(self):
        self.graph['oslc_modifiedBy'] = 'urn:someone-else'
        self.candidate['graph']['oslc:modifiedBy'] = 'urn:someone-else'
        with self.assertRaisesRegex(ValueError, 'current modifier'): self.prepare()

    def test_later_admin_edit_outside_recorded_window_is_excluded(self):
        self.graph.update(pav_lastUpdatedOn='2026-09-25T00:02:01Z', lastUpdatedOnTS=1790294521)
        self.candidate['graph'].update({'pav:lastUpdatedOn':'2026-09-25T00:02:01Z','lastUpdatedOnTS':1790294521})
        with self.assertRaisesRegex(ValueError, 'outside'): self.prepare()

    def test_preimage_disagreement_and_cross_artifact_evidence_are_excluded(self):
        for key, value in [('artifactId','urn:another'), ('verifiedRepair',False),
                           ('windowSeconds',86400), ('beforeModification',{}), ('preimageSha256','')]:
            with self.subTest(key=key):
                candidate=copy.deepcopy(self.candidate);candidate['metadataEvidence'][key]=value
                with self.assertRaises(ValueError):
                    repair.prepare(candidate,self.stored,self.graph,repair_user='urn:repair')

    def test_new_content_snapshot_still_protects_against_intervening_edits(self):
        self.stored['payload']={'value':'edited after preparation'}
        with self.assertRaisesRegex(ValueError, 'document changed'): self.prepare()

    def test_preflight_binds_current_content_instead_of_demanding_historical_content(self):
        current=dict(self.stored,payload={'value':'later structural repair'})
        with patch('cedar_provenance_store.public_document', side_effect=lambda d:{k:v for k,v in d.items() if not k.startswith('_')}):
            ready, record=policy.fresh_candidate(self.candidate,current,self.graph,self.graph,
                {'urn:original'},set(),'urn:repair')
        self.assertNotEqual(ready['expectedDocumentSha256'],self.candidate['expectedDocumentSha256'])
        self.assertEqual(ready['expectedDocumentSha256'],record['documentSha256'])

    def test_preflight_excludes_pending_jobs_unresolved_users_and_changing_graph(self):
        for users,pending,last in [(set(),set(),self.graph),({'urn:original'},{'urn:test'},self.graph),
                                  ({'urn:original'},set(),dict(self.graph,_cedarRevision=5))]:
            with patch('cedar_provenance_store.public_document',return_value=self.body),self.assertRaises(ValueError):
                policy.fresh_candidate(self.candidate,self.stored,self.graph,last,users,pending,'urn:repair')

    def test_proposal_checks_actual_verified_log_and_preimage_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);preimage=root/'before.json';log=root/'repair.jsonl'
            preimage.write_text(json.dumps({'artifact':self.body}))
            entry={'artifactId':'urn:test','outcome':'repaired','verified':True,
                'at':'2026-09-25T00:00:00Z','preimage':str(preimage)}
            log.write_text(json.dumps(entry)+'\n')
            row=copy.deepcopy(self.candidate)
            row['evidence'].update(record=str(log),preimage=str(preimage),writeEpoch=1790294400)
            self.assertEqual(policy.proposal(row,'urn:repair',{})['metadataEvidence']['artifactId'],'urn:test')
            entry['verified']=False;log.write_text(json.dumps(entry)+'\n')
            with self.assertRaisesRegex(ValueError,'no matching verified event'):policy.proposal(row,'urn:repair',{})
            entry['verified']=True;log.write_text(json.dumps(entry)+'\n')
            preimage.write_text(json.dumps({'artifact':dict(self.body,**{'@id':'urn:wrong'})}))
            with self.assertRaisesRegex(ValueError,'preimage identity'):policy.proposal(row,'urn:repair',{})


if __name__ == '__main__': unittest.main()
