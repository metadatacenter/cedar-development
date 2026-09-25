"""Schema context cleanup preserves metadata and any prefix that still interprets it."""
import copy
import unittest
from unittest.mock import patch
import cedar_artifact_repair as r

class ExtraSchemaContextTest(unittest.TestCase):
    def setUp(self):
        self.before={'@id':'urn:test','@type':r.STATIC_AT_TYPE,'@context':{
            'schema':'http://schema.org/', 'schema:description':{'@type':'xsd:string'},
            'xsd':r.REMOVABLE_SCHEMA_PREFIXES['xsd']}, 'schema:description':'Keep the actual text'}
        self.after=copy.deepcopy(self.before)
        del self.after['@context']['schema:description'];del self.after['@context']['xsd']
        self.plan={'beforeSha256':r.artifact_fingerprint(self.before),'afterSha256':r.artifact_fingerprint(self.after),
                   'changes':[{'path':'/@context/'+k,'replaced':self.before['@context'][k],'wrote':None} for k in ['schema:description','xsd']]}

    def test_reviewed_removal_idempotence_and_drift(self):
        with patch.dict(r.SCHEMA_CONTEXT_REMOVAL_PLANS, {'urn:test':self.plan},clear=True):
            after,changes=r.remove_reviewed_extra_schema_context(self.before)
            self.assertEqual(after,self.after);self.assertEqual(len(changes),2)
            self.assertEqual(r.remove_reviewed_extra_schema_context(after),(after,[]))
            drift=copy.deepcopy(self.before);drift['schema:description']='newer edit'
            with self.assertRaises(r.TransformRefused):r.remove_reviewed_extra_schema_context(drift)

    def test_metadata_and_required_context_are_protected(self):
        after=copy.deepcopy(self.after);after['schema:description']='lost'
        self.assertIsNotNone(r.only_removed_extra_schema_context(self.before,after))
        after=copy.deepcopy(self.after);del after['@context']['schema']
        self.assertIsNotNone(r.only_removed_extra_schema_context(self.before,after))
        before=copy.deepcopy(self.before);before['@type']=r.FIELD_AT_TYPE
        after=copy.deepcopy(self.after);after['@type']=r.FIELD_AT_TYPE
        self.assertIsNotNone(r.only_removed_extra_schema_context(before,after))

    def test_instance_schema_names_do_not_use_artifact_prefixes(self):
        node={'@type':'https://schema.metadatacenter.org/core/Template',
              '@context':{'skos':r.REMOVABLE_SCHEMA_PREFIXES['skos']},
              'properties':{'@context':{'properties':{'skos:notation':{}}}},
              'required':['skos:notation']}
        self.assertFalse(r.schema_prefix_is_used(node,'skos'))
        node['skos:prefLabel']='Actual metadata'
        self.assertTrue(r.schema_prefix_is_used(node,'skos'))

    def test_used_prefixes_are_retained(self):
        before={'@type':r.FIELD_AT_TYPE,'@context':{'openminds':r.REMOVABLE_SCHEMA_PREFIXES['openminds']},'openminds:schemaVersion':'1'}
        after=copy.deepcopy(before);del after['@context']['openminds']
        self.assertIsNotNone(r.only_removed_extra_schema_context(before,after))
        del before['openminds:schemaVersion'];del after['openminds:schemaVersion']
        self.assertIsNone(r.only_removed_extra_schema_context(before,after))
        before['description']='openminds:Something';after['description']=before['description']
        self.assertIsNotNone(r.only_removed_extra_schema_context(before,after))

    def test_nested_binding_shields_its_own_references(self):
        node={'@context':{'openminds':r.REMOVABLE_SCHEMA_PREFIXES['openminds']},'child':{
            '@context':{'openminds':r.REMOVABLE_SCHEMA_PREFIXES['openminds']},'openminds:schemaVersion':'1'}}
        self.assertFalse(r.schema_prefix_is_used(node,'openminds'))
        del node['child']['@context']['openminds']
        self.assertTrue(r.schema_prefix_is_used(node,'openminds'))

if __name__=='__main__':unittest.main()
