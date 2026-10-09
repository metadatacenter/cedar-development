import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cedar_provenance_apply as repair
import cedar_provenance_log_plan as policy
from cedar_provenance_audit import digest
from cedar_provenance_log_review import java_id_hash
import test_cedar_provenance_apply as fixtures


class LogEvidenceTest(unittest.TestCase):
    def setUp(self):
        fixtures.RestorationTest.setUp(self)
        self.identifier='https://repo.metadatacenter.org/templates/test'
        self.body['@id']=self.identifier; self.stored['@id']=self.identifier
        self.graph['_id']=self.identifier
        self.candidate.update(id=self.identifier,classification=policy.CLASSIFICATION,repairActor='urn:repair',
            document=copy.deepcopy(self.body),expectedDocumentSha256=digest(self.body))
        warn=f"WARN [2026-09-25 00:00:00,022] example: Verbatim write: user urn:repair replaced org.metadatacenter.id.CedarTemplateId@{java_id_hash(self.identifier)} ('Example'), owned by urn:owner, stating oslc:modifiedBy urn:original\n"
        req=f'127.0.0.1 - - [24/Sep/2026:17:00:00 -0700] "PUT /templates/{self.identifier}?verbatim=true HTTP/1.1" 200 100 "-" "Python" 100\n'
        self.candidate['logEvidence']={'policy':policy.POLICY,'artifactId':self.identifier,'repairActor':'urn:repair',
            'windowSeconds':3,'graphEpoch':1790294400,'beforeModification':{k:self.body[k] for k in ('pav:lastUpdatedOn','oslc:modifiedBy')},
            'uniqueHashAmongGraphArtifacts':True,'conflictingRetainedWrites':False,
            'warning':self.entry(warn),'request':self.entry(req)}

    def entry(self,raw):
        return {'file':'retained.log','line':1,'raw':raw,'lineSha256':hashlib.sha256(raw.encode()).hexdigest()}

    def prepare(self,candidate=None,**kwargs):
        return repair.prepare(candidate or self.candidate,self.stored,self.graph,'urn:repair',allow_log_evidence=True,**kwargs)

    def test_valid_log_pair_restores_original_date_and_modifier(self):
        self.assertEqual(self.prepare()['parameters']['modifiedBy'],'urn:original')
        self.assertEqual(self.prepare()['parameters']['lastUpdatedOn'],'2017-01-02T03:04:05+00:00')

    def test_explicit_log_opt_in_required(self):
        with self.assertRaises(ValueError): repair.prepare(self.candidate,self.stored,self.graph,'urn:repair')
        with self.assertRaises(ValueError): repair.prepare(self.candidate,self.stored,self.graph,allow_log_evidence=True)

    def test_cross_artifact_wrong_actor_modifier_status_mode_or_time_refused(self):
        changes=[('warning','urn:repair','urn:other'),('warning','urn:original','urn:other'),
            ('warning','00:00:00,022','00:01:00,022'),('warning','CedarTemplateId@','CedarFieldId@'),
            ('request',self.identifier,self.identifier+'other'),('request','200 100','499 100'),
            ('request','verbatim=true','verbatim=false'),('request','17:00:00','17:01:00')]
        for key,old,new in changes:
            with self.subTest(key=key,new=new):
                c=copy.deepcopy(self.candidate)
                c['logEvidence'][key]=self.entry(c['logEvidence'][key]['raw'].replace(old,new))
                with self.assertRaises(ValueError):self.prepare(c)

    def test_altered_raw_line_or_proof_rejected(self):
        for key,value in [('uniqueHashAmongGraphArtifacts',False),('conflictingRetainedWrites',True),
            ('beforeModification',{}),('graphEpoch',1),('windowSeconds',100),('artifactId','urn:other')]:
            c=copy.deepcopy(self.candidate);c['logEvidence'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.prepare(c)
        c=copy.deepcopy(self.candidate);c['logEvidence']['warning']['raw']+='changed'
        with self.assertRaises(ValueError):self.prepare(c)

    def test_current_content_change_or_non_admin_graph_is_rejected(self):
        self.stored['payload']={'later':'edit'}
        with self.assertRaisesRegex(ValueError,'document changed'):self.prepare()
        self.stored['payload']=self.body['payload']
        self.graph['oslc_modifiedBy']='urn:other';self.candidate['graph']['oslc:modifiedBy']='urn:other'
        with self.assertRaisesRegex(ValueError,'current modifier'):self.prepare()

    def test_warning_only_or_conflicting_request_is_excluded(self):
        row={'category':'corroborated-verbatim-write','uniqueHashAmongGraphArtifacts':True,'graphEpoch':100,
            'matchedWarnings':[{'epoch':100}], 'nearRequests':[{'epoch':100,'method':'PUT','verbatim':True,'status':200}]}
        self.assertEqual(len(policy.selected_evidence(row)),2)
        for key,value in [('category','verbatim-warning-only'),('laterSuccessfulRequests',[{}]),
            ('nearOtherSuccessfulRequests',[{}]),('uniqueHashAmongGraphArtifacts',False)]:
            with self.assertRaises(ValueError):policy.selected_evidence(dict(row,**{key:value}))

    def test_source_line_is_preserved_exactly_and_changed_source_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'log';raw=self.candidate['logEvidence']['warning']['raw'];path.write_text(raw)
            e=dict(self.entry(raw),file=str(path));lines,_=policy.retain_lines([e])
            self.assertEqual(lines[(str(path),1)]['raw'],raw)
            path.write_text(raw.replace('Example','Changed'))
            with self.assertRaisesRegex(ValueError,'changed'):policy.retain_lines([e])

    def test_preflight_keeps_frozen_content_and_checks_pending_and_identity_collision(self):
        obs={'id':self.identifier,'kind':'template','graph':copy.deepcopy(self.graph),
            'documentSha256':digest(self.body),'documentRevision':3}
        proof=self.candidate['logEvidence'];pair=(dict(proof['warning'],file='warn'),dict(proof['request'],file='req'))
        retained={(e['file'],e['line']):e for e in pair}
        hashes={('CedarTemplateId',java_id_hash(self.identifier)):[self.identifier]}
        def fresh(stored=None,pending=None,hash_ids=None,users=None):
            return policy.fresh_candidate(obs,{'graphEpoch':1790294400},pair,retained,stored or self.stored,
                self.graph,self.graph,users or ['urn:original'],pending or set(),hash_ids or hashes,'urn:repair')
        with patch('cedar_provenance_store.public_document',side_effect=lambda d:{k:v for k,v in d.items() if not k.startswith('_')}):
            c,_=fresh();self.assertEqual(c['expectedDocumentSha256'],digest(self.body))
            for kw in ({'stored':dict(self.stored,payload={})},{'pending':{self.identifier}},
                {'hash_ids':{next(iter(hashes)):[self.identifier,'urn:collision']}},{'users':['urn:original','urn:original']}):
                with self.assertRaises(ValueError):fresh(**kw)


if __name__=='__main__':unittest.main()
