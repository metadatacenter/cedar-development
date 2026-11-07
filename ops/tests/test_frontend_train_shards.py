import argparse
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frontend_train as train
import frontend_train_shards as shards


class DistributedEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = self.root / 'config.json'
        config.write_text('{}')
        self.args = argparse.Namespace(version='2.9.3-dev.20260824.1847', config=config,
            workspace=self.root / 'workspace', state=self.root / 'state',
            artifact=self.root / 'artifact', results=self.root / 'results')
        self.plan = {'version': self.args.version, 'components': []}
        self.repo = self.args.workspace / shards.CED
        self.repo.mkdir(parents=True)
        (self.repo / 'bundle.js').write_text('tested bytes')
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules' / 'ignored').write_text('do not transfer')

    def candidate(self):
        return shards.archive_candidate(self.args, self.plan, shards.CED,
            {'browser': ['a', 'b', 'c', 'd'], 'visual': ['v']})

    def evidence(self, receipt):
        for lane, tests in [('1', ['a']), ('2', ['b']), ('3', ['c']), ('4', ['d']), ('visual', ['v'])]:
            train.write_json(self.args.results / f'ced-{lane}.json', {
                **shards.identity(self.args, self.plan), 'archiveSha256': receipt['archiveSha256'],
                'lane': lane, 'tests': tests})

    def test_transfer_preserves_candidate_bytes_and_excludes_dependencies(self):
        receipt = self.candidate()
        (self.repo / 'bundle.js').write_text('changed')
        with patch.object(train, 'source_manifest', return_value=({}, b'')), patch.object(train, 'repository_root'):
            restored = shards.restore(self.args, self.plan, shards.CED)
        self.assertEqual(receipt, restored)
        self.assertEqual('tested bytes', (self.repo / 'bundle.js').read_text())
        import tarfile
        with tarfile.open(self.args.artifact / 'candidate.tar.gz') as archive:
            self.assertFalse(any('node_modules' in p for p in archive.getnames()))

    def test_changed_archive_or_inputs_refuse_before_extraction(self):
        self.candidate()
        with self.assertRaisesRegex(RuntimeError, 'different train inputs'):
            shards.restore(self.args, {**self.plan, 'changed': True}, shards.CED)
        archive = self.args.artifact / 'candidate.tar.gz'
        archive.write_bytes(archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            shards.restore(self.args, self.plan, shards.CED)

    def test_all_shards_and_visual_are_required_exactly_once(self):
        receipt = self.candidate()
        self.evidence(receipt)
        shards.require_results(self.args, self.plan, receipt)
        path = self.args.results / 'ced-3.json'
        data = train.load_json(path)
        for tests in ([], ['b'], ['c', 'extra']):
            train.write_json(path, {**data, 'tests': tests})
            with self.assertRaisesRegex(RuntimeError, 'coverage'):
                shards.require_results(self.args, self.plan, receipt)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            shards.require_results(self.args, self.plan, receipt)

    def test_receipts_from_different_candidate_or_lane_are_rejected(self):
        receipt = self.candidate()
        self.evidence(receipt)
        path = self.args.results / 'ced-visual.json'
        data = train.load_json(path)
        for field in ('archiveSha256', 'planSha256', 'configSha256', 'lane'):
            train.write_json(path, {**data, field: 'wrong'})
            with self.assertRaisesRegex(RuntimeError, 'different candidate'):
                shards.require_results(self.args, self.plan, receipt)

    def test_appended_preparation_does_not_change_candidate_identity(self):
        self.assertEqual(shards.identity(self.args, self.plan), shards.identity(self.args,
            {**self.plan, 'frontendPreparation': {'preparedAt': 'later'}}))

    def test_inventory_retains_skipped_cases_and_browser_projects(self):
        report = {'suites': [{'specs': [{'id': 'same', 'tests': [
            {'projectName': 'chromium', 'status': 'skipped'},
            {'projectName': 'webkit', 'status': 'expected'}]}]}]}
        self.assertEqual(['same:chromium', 'same:webkit'], sorted(shards.test_inventory(report)))
        report['errors'] = [{'message': 'could not load test'}]
        with self.assertRaisesRegex(RuntimeError, 'errors'):
            shards.test_inventory(report)

    def test_workspace_restoration_uses_verified_artifact(self):
        args = argparse.Namespace(**vars(self.args), verified_workspace=self.args.artifact)
        with patch.object(shards, 'restore', return_value={'data': {'result': [{'workspace': ['dist']}, []]}}) as restore:
            result = shards.restore_workspace(args, self.plan)
        self.assertEqual([{'workspace': ['dist']}, []], result)
        self.assertEqual(self.args.artifact, restore.call_args.args[0].artifact)

    def test_workflow_requires_all_lanes_and_workspace_before_frontend_publication(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-train.yml').read_text()
        self.assertIn("lane: ['1', '2', '3', '4', visual]", workflow)
        self.assertIn('needs: [publish-cee, publish-picker, publish-ced, prepare-workspace, prepare-consumers]', workflow)
        self.assertIn('--verified-workspace "$RUNNER_TEMP/workspace-prepared"', workflow)
        self.assertIn('pattern: ced-result-*', workflow)
        self.assertIn('needs: check-ced', workflow)

    def test_independent_matrix_covers_every_eligible_release_repository(self):
        config = train.load_json(train.DEFAULT_CONFIG)
        expected = shards.independent_consumers(config)
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-train.yml').read_text()
        job = workflow.split('  prepare-consumers:', 1)[1].split('  publish-frontends:', 1)[0]
        import re
        actual = re.search(r'repository: \[(.*?)\]', job).group(1).split(', ')
        self.assertEqual(expected, sorted(actual))
        self.assertIn('needs: [publish-cee, publish-picker]', job)
        self.assertNotIn('needs: publish-ced', job)
        self.assertIn('prepare-consumer --repository', job)
        component = next(c for c in config['components'] if c['repository'] == shards.CED)
        component['consumers'].append({'repository': expected[0]})
        with self.assertRaisesRegex(RuntimeError, 'depends on CED'):
            shards.independent_consumers(config)

    def test_consumer_restoration_requires_complete_set_and_matching_identity(self):
        config = train.load_json(train.DEFAULT_CONFIG)
        surface = next(s for s in config['surfaces'] if s['id'] == 'content')
        config = {**config, 'surfaces': [{**surface, 'repository': 'consumer'}], 'components': []}
        root = self.args.workspace / 'consumer'
        root.mkdir()
        (root / 'tested.js').write_text('verified')
        self.args.verified_consumers = self.root / 'consumers'
        self.args.artifact = self.args.verified_consumers / 'consumer-consumer'
        self.args.verified_consumers.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'Missing'):
            shards.restore_consumers(self.args, self.plan, config)
        shards.archive_candidate(self.args, self.plan, 'consumer', {'result': [{'app': ['dist']}, []]})
        with patch.object(train, 'source_manifest', return_value=({}, b'')), patch.object(train, 'repository_root'):
            result = shards.restore_consumers(self.args, self.plan, config)
            self.assertEqual({'consumer': [{'app': ['dist']}, []]}, result)
            with self.assertRaisesRegex(RuntimeError, 'different train inputs'):
                shards.restore_consumers(self.args, {**self.plan, 'changed': True}, config)
        (self.args.verified_consumers / 'extra').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'unexpected'):
            shards.restore_consumers(self.args, self.plan, config)

    def test_consumer_receipt_is_written_only_after_complete_repository_gate(self):
        self.args.repository = 'consumer'
        with patch.object(shards, 'context', return_value=(self.plan, {}, {})), \
             patch.object(shards, 'independent_consumers', return_value=['consumer']), \
             patch.object(train, 'repository_root', return_value=(self.repo, 'revision')), \
             patch.object(train, 'assert_clean_repository'), \
             patch.object(train, 'prepare_repository', side_effect=RuntimeError('browser failed')), \
             patch.object(shards, 'archive_candidate') as archive:
            with self.assertRaisesRegex(RuntimeError, 'browser failed'):
                shards.prepare_consumer(self.args)
            archive.assert_not_called()

    def test_cee_requires_all_four_shards_including_declared_skips(self):
        receipt = self.candidate()
        receipt['data']['visual'] = []
        for lane, case in zip(['1', '2', '3', '4'], ['a', 'b', 'c', 'd']):
            train.write_json(self.args.results / f'cee-{lane}.json', {
                **shards.identity(self.args, self.plan), 'archiveSha256': receipt['archiveSha256'],
                'lane': lane, 'tests': [case]})
        shards.require_results(self.args, self.plan, receipt, 'cee', ['1', '2', '3', '4'])
        (self.args.results / 'cee-4.json').unlink()
        with self.assertRaises(FileNotFoundError):
            shards.require_results(self.args, self.plan, receipt, 'cee', ['1', '2', '3', '4'])

    def test_cee_publication_waits_for_shards(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-train.yml').read_text()
        publish = workflow.split('  publish-cee:', 1)[1].split('  publish-picker:', 1)[0]
        self.assertIn('needs: check-cee', publish)
        self.assertIn('pattern: cee-result-*', publish)
        self.assertIn('frontend_train_shards.py publish-cee', publish)
