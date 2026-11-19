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

    def test_the_invariant_names_a_change_the_template_does_not_prove(self):
        # The invariant once re-ran the transform, so in a run it compared the transform's output
        # with itself and any change the transform made passed.
        after,_=r.repair_unambiguous_instance_structure(self.before,self.template)
        element='/element'
        for pointer,tamper in (
                (element+'/region/@value',lambda d:d['element']['region'].update({'@value':'lost'})),
                (element+'/@context/region',lambda d:d['element']['@context'].update({'region':'urn:other'})),
                (element+'/@id',lambda d:d['element'].update({'@id':r.ELEMENT_INSTANCE_BASE+'invented'})),
                (element+'/attributes',lambda d:d['element'].update({'attributes':['kept']})),
                (element+'/extra',lambda d:d['element'].update({'extra':{'@value':'x'}})),
                ('/schema:name',lambda d:d.update({'schema:name':'x'}))):
            with self.subTest(pointer=pointer):
                tampered=copy.deepcopy(after);tamper(tampered)
                self.assertEqual(r.only_unambiguous_instance_structure(self.before,tampered,self.template),pointer)
        # A rename the template's IRI does not prove is refused.
        before=copy.deepcopy(self.before);before['element']['@context']['region ']='urn:different'
        renamed=copy.deepcopy(before);renamed['element']['region']=renamed['element'].pop('region ')
        renamed['element']['@context']['region']=renamed['element']['@context'].pop('region ')
        self.assertEqual(r.only_unambiguous_instance_structure(before,renamed,self.template),element+'/region')
        # Partial application is not an extra change.
        self.assertIsNone(r.only_unambiguous_instance_structure(self.before,self.before,self.template))

if __name__=='__main__':unittest.main()
