import copy
import unittest
import child_required as p

T = 'https://schema.metadatacenter.org/core/Template'
F = 'https://schema.metadatacenter.org/core/TemplateField'
E = 'https://schema.metadatacenter.org/core/TemplateElement'

class ChildRequiredTest(unittest.TestCase):
    def setUp(self):
        self.field = {'@type': F, 'type': 'object', 'properties': {'@value': {'type': ['string','null']}}}
        self.source = {'@type': T, 'properties': {'x': self.field, '@context': {'properties': {'x': {'enum':['urn:x']}}}}, 'required': ['@context']}
        self.java = copy.deepcopy(self.source)
        self.java['required'] += ['x']

    def test_only_java_required_children_are_added_without_reordering(self):
        self.java['required'] = ['x', '@context', 'unrelated']
        candidate, changes = p.plan_schema(self.source, self.java)
        self.assertEqual(candidate['required'], ['@context','x'])
        self.assertEqual(changes, [{'path':'','names':['x']}])
        candidate['properties']['x']['description'] = 'unauthorized'
        with self.assertRaises(AssertionError): p.assert_schema_additions(self.source,candidate,changes)

    def test_nested_schema_paths_and_static_fields(self):
        child=copy.deepcopy(self.source); child['@type']=E
        source={'@type':T,'properties':{'a/b':{'type':'array','items':child}},'required':[]}
        java=copy.deepcopy(source); java['required']=['a/b']
        java['properties']['a/b']['items']['required'].append('x')
        candidate, changes=p.plan_schema(source,java)
        self.assertEqual(changes[1]['path'],'/properties/a~1b/items')
        p.assert_schema_additions(source,candidate,changes)
        static=copy.deepcopy(self.source)
        static['properties']['x']['@type']=p.repair.STATIC_AT_TYPE
        with self.assertRaises(AssertionError): p.plan_schema(static,self.java)

    def test_empty_addition_preserves_values_and_context(self):
        source = {'@context': {'other':'urn:other'}, 'populated': {'@value':'retained'}}
        result = p.complete_instance(source,self.java)
        self.assertEqual(result['x'], {'@value':None})
        self.assertEqual(result['@context'], {'other':'urn:other','x':'urn:x'})
        result['x']['@value']='invented'
        with self.assertRaises(AssertionError): p.assert_instance_additions(source,result,self.java)

    def test_conflict_and_existing_value_are_not_repaired(self):
        with self.assertRaises(ValueError): p.complete_instance({'@context':{'x':'urn:wrong'}},self.java)
        source={'x':{'@value':'entered'},'@context':{}}
        self.assertEqual(p.complete_instance(source,self.java),source)
        result=copy.deepcopy(source);result['x']['@value']='changed'
        with self.assertRaises(AssertionError):p.assert_instance_additions(source,result,self.java)

    def test_invariant_rejects_extra_metadata_on_existing_field(self):
        source={'x': {'@value':'kept'}}
        result=copy.deepcopy(source); result['x']['@id']='urn:invented'
        with self.assertRaises(AssertionError): p.assert_instance_additions(source,result,self.java)

    def test_nested_repeated_elements_and_absent_optional_child(self):
        child=copy.deepcopy(self.java);child['@type']=E
        schema={'@type':T,'properties':{'a/b':{'type':'array','items':child}},'required':[]}
        source={'a/b':[{'@id':'urn:one'},{'@id':'urn:two','x':{'@value':'kept'}}]}
        result=p.complete_instance(source,schema)
        self.assertEqual(result['a/b'][0]['x'],{'@value':None})
        self.assertEqual(result['a/b'][1],source['a/b'][1])
        self.assertEqual(p.complete_instance({},schema),{})

    def test_multiple_uses_declared_minimum_without_inventing_values(self):
        self.java['properties']['x']={'type':'array','items':self.field,'minItems':2}
        result=p.complete_instance({},self.java)
        self.assertEqual(result['x'],[{'@value':None},{'@value':None}])
        result['x'].append({'@value':None})
        with self.assertRaises(AssertionError):p.assert_instance_additions({},result,self.java)

if __name__=='__main__':unittest.main()
