import unittest
from instance_values import repair
class Repairs(unittest.TestCase):
    def schema(self):
        return {'properties': {'link': {'properties': {'@id': {'type':'string'}}, 'additionalProperties':False}}}
    def test_duplicate_and_null_only(self):
        for value in [None,'https://example.org/a']:
            source={'link':{'@id':'https://example.org/a','@value':value,'rdfs:label':'keep'}}
            result,changes,_=repair(source,self.schema())
            self.assertEqual({'link':{'@id':'https://example.org/a','rdfs:label':'keep'}},result)
            self.assertEqual(1,len(changes))
            self.assertIn('@value',source['link'])
    def test_conflicting_populated_value_is_not_deleted(self):
        source={'link':{'@id':'https://example.org/a','@value':'different'}}
        result,changes,unresolved=repair(source,self.schema())
        self.assertEqual(source,result);self.assertFalse(changes);self.assertTrue(unresolved)
    def test_trim_url_but_not_multiple_urls_or_embedded_spaces(self):
        for raw,expected in [('https://example.org/a\n','https://example.org/a'),('https://example.org/a https://example.org/b','https://example.org/a https://example.org/b'),('https://example.org/a\u00a0b','https://example.org/a\u00a0b')]:
            result,_,_=repair({'link':{'@id':raw}},self.schema());self.assertEqual(expected,result['link']['@id'])
    def test_empty_optional_identifier(self):
        result,_,_=repair({'link':{'@id':''}},self.schema());self.assertEqual({'link':{}},result)
    def test_orcid_requires_valid_checksum(self):
        for raw,expected in [('https://orcid.org/0000-0002-1825- 0097','https://orcid.org/0000-0002-1825-0097'),('https://orcid.org/0000-0002-1825- 0098','https://orcid.org/0000-0002-1825- 0098')]:
            result,_,_=repair({'link':{'@id':raw}},self.schema())
            self.assertEqual(expected,result['link']['@id'])
    def test_absent_schema_never_authorizes_deletion(self):
        source={'link':{'@id':'x','@value':None}};self.assertEqual(source,repair(source,{})[0])
if __name__=='__main__':unittest.main()
