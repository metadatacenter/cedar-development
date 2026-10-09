import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cedar_provenance_apply as repair
from cedar_provenance_audit import digest
import cedar_provenance_user_alias as aliases
import test_cedar_provenance_apply as fixtures


class LegacyUserAliasTest(unittest.TestCase):
    def setUp(self):
        fixtures.RestorationTest.setUp(self)
        self.uuid = '6d21a887-b704-49a9-922a-aa71632f3232'
        self.old = aliases.LEGACY + self.uuid
        self.current = aliases.CANONICAL + self.uuid
        self.body['oslc:modifiedBy'] = self.old
        self.stored['oslc:modifiedBy'] = self.old
        self.candidate['document'] = copy.deepcopy(self.body)
        self.candidate['expectedDocumentSha256'] = digest(self.body)
        self.candidate['evidence'].update(postimageSha256=digest(self.body),
            beforeModification={k: self.body[k] for k in ('pav:lastUpdatedOn', 'oslc:modifiedBy')})
        self.candidate['modifierAlias'] = aliases.alias_for(self.old, [self.current])

    def prepare(self, **kw):
        return repair.prepare(self.candidate, self.stored, self.graph,
            user_ids=kw.get('users', [self.current]), allow_legacy_user_aliases=kw.get('allow', True))

    def test_restores_canonical_graph_identity_without_changing_document_or_ownership(self):
        before = copy.deepcopy(self.stored)
        record = self.prepare(); params = record['parameters']
        self.assertEqual(params['modifiedBy'], self.current)
        self.assertEqual(params['lastUpdatedOn'], '2017-01-02T03:04:05+00:00')
        self.assertEqual(self.stored, before)
        after = dict(self.graph, oslc_modifiedBy=self.current, pav_lastUpdatedOn=params['lastUpdatedOn'],
            lastUpdatedOnTS=params['lastUpdatedOnTS'], _cedarRevision=5)
        repair.verify([record], {'urn:test': self.stored}, {'urn:test': after})
        self.assertEqual(record['rollbackParameters']['modifiedBy'], 'urn:repair')

    def test_alias_requires_explicit_opt_in(self):
        with self.assertRaisesRegex(ValueError, 'opt-in'): self.prepare(allow=False)

    def test_live_match_must_be_unique_and_canonical(self):
        for users in (None, [], [self.current, self.current], [self.current, self.old],
                      ['https://another.example/users/' + self.uuid]):
            with self.subTest(users=users), self.assertRaises(ValueError): self.prepare(users=users)

    def test_rejects_wrong_namespace_malformed_uuid_and_different_identity(self):
        for source in ('http://repo.metadatacenter.net/users/' + self.uuid,
                       aliases.LEGACY + 'not-a-uuid', self.current):
            with self.subTest(source=source), self.assertRaises(ValueError):
                aliases.alias_for(source, [self.current])
        self.candidate['modifierAlias']['canonical'] = aliases.CANONICAL + '5278408e-231a-414c-8f6b-4c29656a9bde'
        with self.assertRaisesRegex(ValueError, 'sealed alias'): self.prepare()

    def test_alias_does_not_bypass_document_graph_or_historical_evidence_guards(self):
        for target, key, value in [('stored', 'payload', {}), ('stored', '_cedarRevision', 8),
                                  ('graph', 'oslc_modifiedBy', 'urn:someone'),
                                  ('candidate', 'evidence', {})]:
            with self.subTest(target=target, key=key):
                saved = copy.deepcopy(getattr(self, target))
                getattr(self, target)[key] = value
                with self.assertRaises(ValueError): self.prepare()
                setattr(self, target, saved)

    def test_unaliased_candidate_keeps_original_modifier(self):
        self.candidate.pop('modifierAlias')
        self.assertEqual(self.prepare()['parameters']['modifiedBy'], self.old)

    def test_apply_commits_alias_and_skips_missing_live_identity(self):
        missing = copy.deepcopy(self.candidate); missing['id'] = 'urn:missing'
        missing['modifierAlias']['canonical'] = 'urn:invalid'
        graphs = {'urn:test': self.graph}
        def query(statement, params=None):
            if 'MATCH (u:User)' in statement: return [[self.current]]
            return [[identifier, False] for identifier in params['ids']]
        stores = SimpleNamespace(query=query, graphs=lambda ids: graphs)
        def transact(stores, query, records):
            self.assertEqual(len(records), 1)
            p = records[0]['parameters']; self.assertEqual(p['modifiedBy'], self.current)
            graphs['urn:test'] = dict(self.graph, oslc_modifiedBy=p['modifiedBy'],
                pav_lastUpdatedOn=p['lastUpdatedOn'], lastUpdatedOnTS=p['lastUpdatedOnTS'], _cedarRevision=5)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); plan = root/'plan.jsonl'; backup = root/'backup'; query_file = root/'query'
            plan.write_text('\n'.join(json.dumps(r) for r in [self.candidate, missing]))
            backup.write_bytes(b'backup'); query_file.write_text('guarded query')
            with patch.object(repair, 'paused'), patch.object(repair, 'documents', return_value={'urn:test': self.stored}), patch.object(repair, 'transact', side_effect=transact):
                repair.apply(stores, plan, query_file, backup, root/'applied', allow_legacy_user_aliases=True)
            summary = json.loads((root/'applied/summary.json').read_text())
            self.assertEqual((summary['committed'], summary['skipped']), (1, 1))
            journal = json.loads((root/'applied/journal.jsonl').read_text().splitlines()[0])
            self.assertEqual(journal['records'][0]['documentSha256'], digest(self.body))


if __name__ == '__main__': unittest.main()
