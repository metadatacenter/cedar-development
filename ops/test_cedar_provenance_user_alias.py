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


class LegacyGraphModifierTest(unittest.TestCase):
    """A verbatim write left the document's legacy modifier on the graph, with the document's dates."""

    def setUp(self):
        fixtures.RestorationTest.setUp(self)
        self.uuid = '6d21a887-b704-49a9-922a-aa71632f3232'
        self.old = aliases.LEGACY + self.uuid
        self.current = aliases.CANONICAL + self.uuid
        self.body['oslc:modifiedBy'] = self.stored['oslc:modifiedBy'] = self.old
        self.graph.update(oslc_modifiedBy=self.old, pav_lastUpdatedOn='2017-01-02T03:04:05Z', lastUpdatedOnTS=1483326245)
        self.candidate.update(classification=aliases.LEGACY_GRAPH_CLASSIFICATION, document=copy.deepcopy(self.body),
            expectedDocumentSha256=digest(self.body), evidence=None,
            graph={'oslc:modifiedBy': self.old, 'pav:lastUpdatedOn': '2017-01-02T03:04:05Z', 'lastUpdatedOnTS': 1483326245},
            modifierAlias=aliases.alias_for(self.old, [self.current]))

    def prepare(self, **kw):
        return repair.prepare(self.candidate, self.stored, self.graph, kw.get('repair_user'),
            user_ids=kw.get('users', [self.current]), allow_legacy_user_aliases=kw.get('allow', True))

    def test_changes_only_the_modifier_and_keeps_the_graph_dates(self):
        before = copy.deepcopy(self.stored)
        record = self.prepare(); params = record['parameters']
        self.assertEqual(params, {'id': 'urn:test', 'expectedModifiedBy': self.old,
            'expectedLastUpdatedOnTS': 1483326245, 'expectedGraphRevision': 4, 'modifiedBy': self.current,
            'lastUpdatedOn': self.graph['pav_lastUpdatedOn'], 'lastUpdatedOnTS': self.graph['lastUpdatedOnTS']})
        self.assertEqual(self.stored, before)
        after = dict(self.graph, oslc_modifiedBy=self.current, _cedarRevision=5)
        repair.verify([record], {'urn:test': self.stored}, {'urn:test': after})
        with self.assertRaises(RuntimeError):
            repair.verify([record], {'urn:test': self.stored}, {'urn:test': dict(after, lastUpdatedOnTS=1790294400)})

    def test_rollback_restores_the_legacy_form(self):
        rollback = self.prepare()['rollbackParameters']
        self.assertEqual(rollback, {'id': 'urn:test', 'expectedModifiedBy': self.current,
            'expectedLastUpdatedOnTS': 1483326245, 'expectedGraphRevision': 5, 'modifiedBy': self.old,
            'lastUpdatedOn': '2017-01-02T03:04:05Z', 'lastUpdatedOnTS': 1483326245})

    def test_requires_explicit_opt_in_but_no_repair_evidence_or_account(self):
        with self.assertRaisesRegex(ValueError, 'opt-in'): self.prepare(allow=False)
        with self.assertRaisesRegex(ValueError, 'opt-in'):
            repair.prepare(self.candidate, self.stored, self.graph, 'urn:repair', allow_log_evidence=True)
        self.assertEqual(self.prepare(repair_user='urn:repair')['parameters']['modifiedBy'], self.current)

    def test_live_user_must_be_unique_and_canonical(self):
        for users in (None, [], [self.current, self.current], [self.old],
                      ['https://another.example/users/' + self.uuid]):
            with self.subTest(users=users), self.assertRaises(ValueError): self.prepare(users=users)

    def test_document_graph_and_alias_guards_still_apply(self):
        other = aliases.LEGACY + '5278408e-231a-414c-8f6b-4c29656a9bde'
        cases = [('stored', 'payload', {}), ('stored', '_cedarRevision', 8), ('stored', '_cedarDeletionToken', 'x'),
                 ('graph', '_cedarRevision', 5), ('graph', 'lastUpdatedOnTS', 1483326246),
                 ('graph', 'oslc_modifiedBy', 'urn:repair'), ('candidate', 'modifierAlias', None),
                 ('candidate', 'classification', 'review')]
        for target, key, value in cases:
            with self.subTest(target=target, key=key):
                saved = copy.deepcopy(getattr(self, target))
                getattr(self, target)[key] = value
                with self.assertRaises(ValueError): self.prepare()
                setattr(self, target, saved)
        # A graph that agrees with its observation but no longer with the document is refused.
        for key, value in [('oslc_modifiedBy', other), ('pav_lastUpdatedOn', '2026-10-21T00:00:00Z'),
                           ('lastUpdatedOnTS', 1790294400)]:
            with self.subTest(graph=key):
                graph, observed = copy.deepcopy(self.graph), copy.deepcopy(self.candidate['graph'])
                self.graph[key] = value
                self.candidate['graph'][{'oslc_modifiedBy': 'oslc:modifiedBy',
                    'pav_lastUpdatedOn': 'pav:lastUpdatedOn'}.get(key, key)] = value
                with self.assertRaises(ValueError): self.prepare()
                self.graph, self.candidate['graph'] = graph, observed

    def stores(self, graphs, pending=()):
        def query(statement, params=None):
            if 'MATCH (u:User)' in statement: return [[self.current], ['urn:repair']]
            return [[identifier, identifier in pending] for identifier in params['ids']]
        return SimpleNamespace(query=query, graphs=lambda ids: {i: graphs[i] for i in ids if i in graphs})

    def preflight(self, candidates, graphs, docs, pending=()):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        root = Path(directory.name); plan = root / 'plan.jsonl'
        plan.write_text(''.join(json.dumps(c) + '\n' for c in candidates))
        with patch.object(repair, 'documents', return_value=docs), patch('builtins.print'):
            aliases.preflight(self.stores(graphs, pending), plan, 'urn:repair', root / 'preflight')
        read = lambda name: [json.loads(l) for l in (root / 'preflight' / name).read_text().splitlines()]
        return read('ready-candidates.jsonl'), {r['id']: r['reason'] for r in read('held.jsonl')}

    def variant(self, identifier, **graph):
        candidate = copy.deepcopy(self.candidate); candidate['id'] = identifier
        body = dict(self.body, **{'@id': identifier})
        candidate.update(document=copy.deepcopy(body), expectedDocumentSha256=digest(body))
        return candidate, dict(self.graph, _id=identifier, **graph), dict(self.stored, **{'@id': identifier})

    def test_preflight_checks_graph_against_document_not_the_repair_account(self):
        ready, other, pending, admin = [self.variant(i) for i in ('urn:ready', 'urn:other', 'urn:pending', 'urn:admin')]
        other[1]['oslc_modifiedBy'] = aliases.LEGACY + '5278408e-231a-414c-8f6b-4c29656a9bde'
        admin[1]['oslc_modifiedBy'] = 'urn:repair'
        # An existing class keeps its own preflight rule: a graph not modified by the repair account is held.
        unchanged = copy.deepcopy(ready[0]); unchanged.update(id='urn:unchanged', classification='eligible-unchanged-repair')
        rows = [ready, other, pending, admin]
        prepared, held = self.preflight([r[0] for r in rows] + [unchanged],
            {r[0]['id']: r[1] for r in rows} | {'urn:unchanged': dict(ready[1], _id='urn:unchanged')},
            {r[0]['id']: r[2] for r in rows}, pending={'urn:pending'})
        self.assertEqual([c['id'] for c in prepared], ['urn:ready'])
        self.assertEqual(prepared[0]['modifierAlias']['canonical'], self.current)
        self.assertEqual(held, {'urn:other': 'graph modifier is not the document modifier',
            'urn:pending': 'pending lifecycle job', 'urn:admin': 'graph modifier is not the document modifier',
            'urn:unchanged': 'current modifier is not the repair account'})

    def test_preflight_holds_an_ambiguous_or_missing_live_user(self):
        missing = '0f9a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b'
        candidate, graph, stored = self.variant('urn:missing', oslc_modifiedBy=aliases.LEGACY + missing)
        body = dict(self.body, **{'@id': 'urn:missing', 'oslc:modifiedBy': aliases.LEGACY + missing})
        candidate.update(document=body, expectedDocumentSha256=digest(body))
        candidate['graph']['oslc:modifiedBy'] = aliases.LEGACY + missing
        prepared, held = self.preflight([candidate], {'urn:missing': graph}, {'urn:missing': dict(body, _cedarRevision=3)})
        self.assertEqual((prepared, held), ([], {'urn:missing': 'legacy UUID does not have exactly one canonical live user'}))
        original = self.stores
        def ambiguous(graphs, pending=()):
            stores = original(graphs, pending); query = stores.query
            stores.query = lambda s, p=None: ([[self.current], [self.current]] if 'MATCH (u:User)' in s else query(s, p))
            return stores
        self.stores = ambiguous
        prepared, held = self.preflight([self.candidate], {'urn:test': self.graph}, {'urn:test': self.stored})
        self.assertEqual((prepared, held), ([], {'urn:test': 'legacy UUID does not have exactly one canonical live user'}))

    def test_apply_admits_the_class_only_with_the_alias_option(self):
        graphs = {'urn:test': self.graph}
        stores = self.stores(graphs)
        def transact(stores, query, records):
            p = records[0]['parameters']
            self.assertEqual((p['modifiedBy'], p['lastUpdatedOn'], p['lastUpdatedOnTS']),
                             (self.current, self.graph['pav_lastUpdatedOn'], self.graph['lastUpdatedOnTS']))
            graphs['urn:test'] = dict(self.graph, oslc_modifiedBy=p['modifiedBy'], _cedarRevision=5)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); plan = root/'plan.jsonl'; backup = root/'backup'; query_file = root/'query'
            plan.write_text(json.dumps(self.candidate) + '\n')
            backup.write_bytes(b'backup'); query_file.write_text('guarded query')
            with patch.object(repair, 'paused'), patch.object(repair, 'documents', return_value={'urn:test': self.stored}), \
                    patch.object(repair, 'transact', side_effect=transact):
                with self.assertRaisesRegex(ValueError, 'unproven'):
                    repair.apply(stores, plan, query_file, backup, root/'refused')
                repair.apply(stores, plan, query_file, backup, root/'applied', allow_legacy_user_aliases=True)
            summary = json.loads((root/'applied/summary.json').read_text())
            self.assertEqual((summary['committed'], summary['skipped']), (1, 0))


if __name__ == '__main__': unittest.main()
