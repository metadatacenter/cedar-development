import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cedar_provenance_apply as repair
from cedar_provenance_audit import digest


class Response:
    def __init__(self, value): self.value = value
    def raise_for_status(self): pass
    def json(self): return self.value


class Session:
    def __init__(self, rows, errors=None, fail_commit=False):
        self.rows, self.errors, self.fail_commit = rows, errors or [], fail_commit
        self.calls = []
    def post(self, url, **kwargs):
        self.calls.append(('POST', url))
        if url.endswith('/tx'): return Response({'commit': url + '/12/commit'})
        if url.endswith('/commit'):
            if self.fail_commit: raise TimeoutError('ambiguous commit')
            return Response({'errors': []})
        return Response({'errors': self.errors, 'results': [{'data': [{'row': r} for r in self.rows]}]})
    def delete(self, url, **kwargs): self.calls.append(('DELETE', url))


class RestorationTest(unittest.TestCase):
    def setUp(self):
        self.body = {'@id': 'urn:test', 'pav:lastUpdatedOn': '2017-01-02T03:04:05.123Z',
                     'oslc:modifiedBy': 'urn:original', 'payload': {'value': 'unchanged'}}
        self.stored = dict(self.body, _cedarRevision=3)
        self.graph = {'_id': 'urn:test', 'resourceType': 'template', '_cedarRevision': 4,
            'oslc_modifiedBy': 'urn:repair', 'pav_lastUpdatedOn': '2026-09-25T00:00:00Z',
            'lastUpdatedOnTS': 1790294400, 'ownedBy': 'urn:owner', 'isLatestVersion': True}
        self.candidate = {'id': 'urn:test', 'kind': 'template', 'classification': 'eligible-unchanged-repair',
            'document': copy.deepcopy(self.body),
            'expectedDocumentSha256': digest(self.body), 'expectedDocumentEtag': '"3"',
            'expectedGraphEtag': '"4"', 'graph': {'oslc:modifiedBy': 'urn:repair',
                'pav:lastUpdatedOn': '2026-09-25T00:00:00Z', 'lastUpdatedOnTS': 1790294400},
            'evidence': {'postimageSha256': digest(self.body), 'documentEtag': '"3"',
                'beforeModification': {k: self.body[k] for k in ('pav:lastUpdatedOn', 'oslc:modifiedBy')}}}
        self.converter = patch.object(repair, 'public_document', side_effect=lambda d:
            {k: v for k, v in d.items() if not k.startswith('_')})
        self.converter.start(); self.addCleanup(self.converter.stop)

    def prepared(self): return repair.prepare(self.candidate, self.stored, self.graph)

    def test_preflight_retains_whole_graph_and_guarded_rollback(self):
        record = self.prepared()
        self.assertEqual(record['graphPreimage'], self.graph)
        self.assertEqual(record['parameters']['lastUpdatedOn'], '2017-01-02T03:04:05+00:00')
        self.assertEqual(record['rollbackParameters']['expectedGraphRevision'], 5)
        self.assertEqual(record['rollbackParameters']['modifiedBy'], 'urn:repair')

    def test_refuses_changed_body_revision_graph_or_missing_proof(self):
        for target, key, value in [('stored', 'payload', {'value': 'user edit'}),
                                  ('stored', '_cedarRevision', 4), ('stored', '_cedarDeletionToken', 'x'),
                                  ('graph', '_cedarRevision', 5), ('graph', 'lastUpdatedOnTS', 2),
                                  ('candidate', 'classification', 'review'), ('candidate', 'evidence', {})]:
            with self.subTest(target=target, key=key):
                values = {name: copy.deepcopy(getattr(self, name)) for name in ('candidate', 'stored', 'graph')}
                values[target][key] = value
                with self.assertRaises(ValueError): repair.prepare(**values)

    def transaction(self, rows, **kwargs):
        session = Session(rows, **kwargs)
        stores = SimpleNamespace(session=session, base='http://localhost:7474/db/neo4j/tx')
        return stores, session

    def test_exact_results_commit_once(self):
        record = self.prepared(); p = record['parameters']
        stores, session = self.transaction([[p['id'], p['modifiedBy'], p['lastUpdatedOn'], p['lastUpdatedOnTS']]])
        repair.transact(stores, 'tested query', [record])
        self.assertEqual(session.calls[-1], ('POST', stores.base + '/12/commit'))
        self.assertEqual(len(session.calls), 3)

    def test_partial_or_wrong_results_roll_back_without_commit(self):
        for rows in ([], [['wrong', 'x', 'x', 0]], [['urn:test', 'wrong', 'x', 0]]):
            stores, session = self.transaction(rows)
            with self.assertRaises(RuntimeError): repair.transact(stores, 'tested query', [self.prepared()])
            self.assertEqual(session.calls[-1], ('DELETE', stores.base + '/12'))
            self.assertNotIn(('POST', stores.base + '/12/commit'), session.calls)

    def test_database_error_rolls_back_and_uncertain_commit_is_not_retried(self):
        record = self.prepared(); p = record['parameters']
        for options, error in [({'errors': [{'code': 'Conflict'}]}, RuntimeError),
                               ({'fail_commit': True}, TimeoutError)]:
            stores, session = self.transaction([[p['id'], p['modifiedBy'], p['lastUpdatedOn'], p['lastUpdatedOnTS']]], **options)
            with self.assertRaises(error): repair.transact(stores, 'tested query', [record])
            self.assertEqual(session.calls[-1], ('DELETE', stores.base + '/12'))
            self.assertLessEqual(session.calls.count(('POST', stores.base + '/12/commit')), 1)

    def test_verification_checks_all_graph_properties_and_document_content(self):
        record = self.prepared(); p = record['parameters']
        after = dict(self.graph, oslc_modifiedBy=p['modifiedBy'], pav_lastUpdatedOn=p['lastUpdatedOn'],
                     lastUpdatedOnTS=p['lastUpdatedOnTS'], _cedarRevision=5)
        repair.verify([record], {'urn:test': self.stored}, {'urn:test': after})
        for key, value in [('ownedBy', 'somebody'), ('isLatestVersion', False), ('_cedarRevision', 6)]:
            with self.assertRaises(RuntimeError):
                repair.verify([record], {'urn:test': self.stored}, {'urn:test': dict(after, **{key: value})})
        with self.assertRaises(RuntimeError):
            repair.verify([record], {'urn:test': dict(self.stored, payload={})}, {'urn:test': after})

    def test_pending_deletion_is_skipped_without_aborting_unrelated_candidate(self):
        parked = copy.deepcopy(self.candidate)
        parked['id'] = 'urn:parked'
        docs = {'urn:test': self.stored, 'urn:parked': self.stored}
        graphs = {'urn:test': self.graph, 'urn:parked': self.graph}
        def query(statement, params=None):
            if 'MATCH (u:User)' in statement: return [['urn:original']]
            self.assertIn('CedarArtifactDeletionOutbox', statement)
            self.assertIn('CedarArtifactRestoreOutbox', statement)
            self.assertIn('CedarVersionProjection', statement)
            return [[i, i == 'urn:parked'] for i in params['ids']]
        stores = SimpleNamespace(query=query, graphs=lambda ids: {i: graphs[i] for i in ids})
        def commit(stores, query, records):
            self.assertEqual([r['id'] for r in records], ['urn:test'])
            p = records[0]['parameters']
            graphs['urn:test'] = dict(self.graph, oslc_modifiedBy=p['modifiedBy'],
                pav_lastUpdatedOn=p['lastUpdatedOn'], lastUpdatedOnTS=p['lastUpdatedOnTS'], _cedarRevision=5)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / 'plan.jsonl'; plan.write_text(json.dumps(self.candidate)+'\n'+json.dumps(parked)+'\n')
            backup = root / 'backup'; backup.write_bytes(b'backup')
            query_path = root / 'query'; query_path.write_text('query')
            with patch.object(repair, 'paused'), patch.object(repair, 'documents', return_value=docs), patch.object(repair, 'transact', side_effect=commit):
                repair.apply(stores, plan, query_path, backup, root / 'out')
            summary = json.loads((root / 'out/summary.json').read_text())
            self.assertEqual(summary['committed'], 1)
            self.assertEqual(summary['skipped'], 1)
            self.assertEqual(json.loads((root / 'out/skipped.jsonl').read_text())['id'], 'urn:parked')


if __name__ == '__main__': unittest.main()
