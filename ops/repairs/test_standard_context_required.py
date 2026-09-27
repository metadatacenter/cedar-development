"""Standard context requirements are tightened only after dependent instances are ready."""
import copy
import unittest
from unittest.mock import patch
import cedar_artifact_repair as r

class StandardContextRequiredTest(unittest.TestCase):
    def setUp(self):
        self.before = {'@id':'urn:template', '@type':'https://schema.metadatacenter.org/core/Template',
                       'properties':{'@context':{'required':['rdfs'], 'properties':{'xsd':{'enum':[r.STANDARD_CONTEXT_VALUES['xsd']]}}}}}
        self.after=copy.deepcopy(self.before)
        self.after['properties']['@context']['required'].append('xsd')
        self.plan={'beforeSha256':r.artifact_fingerprint(self.before), 'afterSha256':r.artifact_fingerprint(self.after),
                   'changes':[{'path':'/properties/@context/required','wrote':['rdfs','xsd']}],
                   'instanceCheck':{'indexed':2,'fetched':2,'conflicts':[],'instancePatches':0}}

    def test_checked_template_and_idempotence(self):
        with patch.dict(r.STANDARD_CONTEXT_PLANS, {'urn:template':self.plan}, clear=True):
            after,changes=r.apply_reviewed_standard_context(self.before)
            self.assertEqual(after,self.after)
            self.assertEqual(len(changes),1)
            self.assertEqual(r.apply_reviewed_standard_context(after),(after,[]))

    def test_incomplete_conflicting_or_unpatched_instances_refused(self):
        for update in ({'fetched':1},{'conflicts':['urn:instance']},{'instancePatches':1}):
            plan={**self.plan,'instanceCheck':{**self.plan['instanceCheck'],**update}}
            with patch.dict(r.STANDARD_CONTEXT_PLANS, {'urn:template':plan}, clear=True):
                with self.assertRaises(r.TransformRefused):r.apply_reviewed_standard_context(self.before)

    def test_drift_and_unrelated_edits_refused(self):
        with patch.dict(r.STANDARD_CONTEXT_PLANS, {'urn:template':self.plan}, clear=True):
            drift=copy.deepcopy(self.before);drift['schema:name']='edited'
            with self.assertRaises(r.TransformRefused):r.apply_reviewed_standard_context(drift)
        for required in (['xsd','rdfs'],['rdfs','custom'],['rdfs','xsd','xsd']):
            after=copy.deepcopy(self.after);after['properties']['@context']['required']=required
            self.assertIsNotNone(r.only_reviewed_standard_context(self.before,after))
        after=copy.deepcopy(self.after);after['schema:name']='edited'
        self.assertIsNotNone(r.only_reviewed_standard_context(self.before,after))

    def test_instance_additions_preserve_values_and_refuse_overwrites(self):
        before={'@id':'urn:instance','schema:isBasedOn':'urn:template','@context':{},'entered':{'@value':'keep'}}
        after=copy.deepcopy(before);after['@context']={'xsd':r.STANDARD_CONTEXT_VALUES['xsd'],'pav:createdBy':{'@type':'@id'}}
        self.assertIsNone(r.only_reviewed_standard_context(before,after))
        plan={'beforeSha256':r.artifact_fingerprint(before),'afterSha256':r.artifact_fingerprint(after),
              'changes':[{'path':'/@context/'+k,'wrote':v} for k,v in after['@context'].items()]}
        with patch.dict(r.STANDARD_CONTEXT_PLANS,{'urn:instance':plan},clear=True):
            self.assertEqual(r.apply_reviewed_standard_context(before)[0],after)
        before['@context']['xsd']='urn:wrong'
        self.assertIsNotNone(r.only_reviewed_standard_context(before,after))
        before['@context']={};after['entered']['@value']='lost'
        self.assertIsNotNone(r.only_reviewed_standard_context(before,after))

if __name__=='__main__':unittest.main()
