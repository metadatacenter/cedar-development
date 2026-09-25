import copy
import unittest
import context_additional as p

F = 'https://schema.metadatacenter.org/core/TemplateField'
E = p.rest.TEMPLATE_ELEMENT

class ContextAdditionalTest(unittest.TestCase):
    def container(self, attribute=False, rule=False):
        return {'@type':p.TEMPLATE,'@context':{'custom':'urn:prefix'},'additionalProperties':False,
                'properties':{'@context':{'additionalProperties':copy.deepcopy(rule),'properties':{}},
                              'x':{'@type':F,'type':'object','_ui':{'inputType':'attribute-value' if attribute else 'textfield'}}},
                'required':['x']}

    def test_relaxes_only_instance_context_for_dynamic_attributes(self):
        source=self.container(True)
        java=copy.deepcopy(source);java['properties']['@context']['additionalProperties']=p.URI_MAPPING
        candidate, changes=p.plan_schema(source,java)
        self.assertEqual(changes[0]['direction'],'relax')
        self.assertIs(candidate['additionalProperties'],False)
        self.assertEqual(candidate['@context'],source['@context'])
        self.assertEqual(candidate['required'],source['required'])
        p.assert_only_context_rules(source,candidate,changes)

    def test_tightens_only_container_without_attribute_value_fields(self):
        source=self.container(False,p.URI_MAPPING);java=self.container()
        candidate, changes=p.plan_schema(source,java)
        self.assertEqual(changes[0]['direction'],'tighten')
        self.assertIs(candidate['properties']['@context']['additionalProperties'],False)
        self.assertEqual(p.plan_schema(java,java)[1],[])

    def test_nested_repeat_uses_own_children_and_escaped_path(self):
        source=self.container()
        child=self.container(True);child['@type']=E
        source['properties']['a/b']={'type':'array','items':child}
        java=copy.deepcopy(source)
        java['properties']['a/b']['items']['properties']['@context']['additionalProperties']=p.URI_MAPPING
        candidate, changes=p.plan_schema(source,java)
        self.assertEqual(changes[0]['path'],'/properties/a~1b/items')
        self.assertIs(candidate['properties']['@context']['additionalProperties'],False)

    def test_relaxation_proof_rejects_tightening_and_mixed_changes(self):
        source=self.container(True);java=self.container(True,p.URI_MAPPING)
        candidate, changes=p.plan_schema(source,java)
        self.assertTrue(p.is_pure_relaxation(source,candidate,changes))
        source=self.container(False,p.URI_MAPPING);java=self.container()
        candidate, changes=p.plan_schema(source,java)
        self.assertFalse(p.is_pure_relaxation(source,candidate,changes))
        nested=self.container(True);nested['@type']=E
        source['properties']['nested']={'type':'array','items':nested}
        java=copy.deepcopy(source)
        java['properties']['@context']['additionalProperties']=False
        java['properties']['nested']['items']['properties']['@context']['additionalProperties']=p.URI_MAPPING
        candidate, changes=p.plan_schema(source,java)
        self.assertFalse(p.is_pure_relaxation(source,candidate,changes))
        candidate['required'].append('other')
        with self.assertRaises(AssertionError):p.is_pure_relaxation(source,candidate,changes)

    def test_refuses_unreviewed_rule_or_disagreement_with_java(self):
        source=self.container(False,True)
        with self.assertRaises(ValueError):p.plan_schema(source,self.container())
        source=self.container()
        java=self.container(False,p.URI_MAPPING)
        with self.assertRaises(ValueError):p.plan_schema(source,java)

    def test_invariant_rejects_unrelated_constraint_and_context_edits(self):
        source=self.container(True);java=self.container(True,p.URI_MAPPING)
        candidate, changes=p.plan_schema(source,java)
        for mutate in [lambda x:x.update(additionalProperties=True),
                       lambda x:x['@context'].update(custom='urn:changed'),
                       lambda x:x['required'].append('other')]:
            changed=copy.deepcopy(candidate);mutate(changed)
            with self.assertRaises(AssertionError):p.assert_only_context_rules(source,changed,changes)

if __name__=='__main__':unittest.main()
