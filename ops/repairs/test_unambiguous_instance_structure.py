import copy
import unittest
import cedar_artifact_repair as r

class UnambiguousStructureTest(unittest.TestCase):
    def setUp(self):
        self.schema={'type':'object','@type':r.ELEMENT_AT_TYPE,'properties':{
            '@id':{'type':['string','null']}, '@context':{'properties':{'region':{'enum':['urn:region']}}},
            'region':{'type':'object','@type':r.FIELD_AT_TYPE,'_ui':{'inputType':'textfield'}},
            'attributes':{'type':'object','@type':r.FIELD_AT_TYPE,'_ui':{'inputType':'attribute-value'}}}}
        self.template={'properties':{'element':self.schema}}
        self.before={'@id':'urn:instance','element':{'@id':'','@context':{'region ':'urn:region'},'region ': {'@value':'New York'},'attributes':['']}}

    def test_proven_rename_dangling_reference_and_empty_id(self):
        after, changes=r.repair_unambiguous_instance_structure(self.before,self.template)
        self.assertEqual(after['element'],{'@id':after['element']['@id'],'@context':{'region':'urn:region'},'region':{'@value':'New York'},'attributes':[]})
        self.assertTrue(after['element']['@id'].startswith(r.ELEMENT_INSTANCE_BASE))
        self.assertEqual(len(changes),3)
        self.assertIsNone(r.only_unambiguous_instance_structure(self.before,after,self.template))
        self.assertEqual(r.repair_unambiguous_instance_structure(after,self.template),(after,[]))
        after['element']['region']['@value']='lost'
        self.assertIsNotNone(r.only_unambiguous_instance_structure(self.before,after,self.template))

    def test_real_blank_values_and_conflicting_names_or_iris_are_preserved(self):
        for update in ({'':{'@value':'entered'}},{'region':{'@value':'already present'}},{'@context':{'region ':'urn:different'}}):
            before=copy.deepcopy(self.before);before['element'].update(update)
            after,_=r.repair_unambiguous_instance_structure(before,self.template)
            if '' in update:self.assertEqual(after['element']['attributes'],[''])
            else:self.assertEqual(after['element']['region '],{'@value':'New York'})
        before=copy.deepcopy(self.before);before['element']['@id']='urn:existing'
        after,_=r.repair_unambiguous_instance_structure(before,self.template)
        self.assertEqual(after['element']['@id'],'urn:existing')

if __name__=='__main__':unittest.main()
