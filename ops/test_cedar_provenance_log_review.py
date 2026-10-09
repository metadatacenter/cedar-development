import unittest
from cedar_provenance_log_review import access, warning, java_id_hash, correlate


class LogReviewTest(unittest.TestCase):
    def test_java_objects_hash_matches_known_server_log(self):
        self.assertEqual(java_id_hash('https://repo.metadatacenter.net/templates/a87b5cb4-6344-4a43-8fcb-82d400bff2c7'),'198f18f6')

    def test_access_decodes_identity_and_timezone_and_flags(self):
        line='127.0.0.1 - - [25/Sep/2026:05:05:34 -0700] "PUT /templates/https%3A%2F%2Frepo.metadatacenter.net%2Ftemplates%2Ftest?verbatim=true HTTP/1.1" 200 5659 "-" "Python-urllib/3.14" 450'
        item=access(line)
        self.assertEqual(item['id'],'https://repo.metadatacenter.net/templates/test')
        self.assertEqual(item['status'],200);self.assertTrue(item['verbatim'])
        warn=warning("WARN  [2026-09-25 12:05:34,022] example: Verbatim write: user urn:admin replaced org.metadatacenter.id.CedarTemplateId@198f18f6 ('A \'quoted\' name'), owned by urn:owner, stating oslc:modifiedBy urn:original\n")
        self.assertAlmostEqual(warn['epoch']-item['epoch'],.022,places=5)
        self.assertEqual(warn['statedModifier'],'urn:original')

    def test_corroboration_requires_success_verbatim_actor_modifier_and_unique_identity(self):
        row={'id':'urn:item','kind':'template','graph':{'lastUpdatedOnTS':100,'oslc_modifiedBy':'urn:admin'},'document':{'oslc:modifiedBy':'urn:original'}}
        warn={'epoch':100.5,'actor':'urn:admin','statedModifier':'urn:original'}
        req={'epoch':100,'method':'PUT','verbatim':True,'status':200}
        self.assertEqual(correlate(row,[warn],[req],True,'urn:admin')['category'],'corroborated-verbatim-write')
        for w,r,u in [(dict(warn,actor='urn:other'),req,True),(dict(warn,statedModifier='urn:other'),req,True),
                      (warn,dict(req,status=500),True),(warn,dict(req,verbatim=False),True),(warn,req,False),
                      (dict(warn,epoch=120),req,True),(warn,dict(req,epoch=120),True)]:
            self.assertNotEqual(correlate(row,[w],[r],u,'urn:admin')['category'],'corroborated-verbatim-write')


if __name__=='__main__':unittest.main()
