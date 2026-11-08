import copy
import datetime as dt
import io
import json
import unittest
import zipfile
from unittest.mock import patch

import calibration_review as review


def report(component='cee', day=1, delta=0):
    value = {'complete': True, 'startedAt': f'2026-11-{day:02}T02:30:00Z', 'samples': [],
             'metadata': {'component': component, 'repetitions': 5, 'platform': 'linux', 'arch': 'x64',
                          'cpu': 'cpu-a', 'browser': '156', 'node': '24', 'baselineRevision': 'a'*40,
                          'candidateRevision': 'a'*40, 'suite': {'sha256': 'b'*64},
                          'profile': {'cpu': 4}, 'viewport': {'width': 1440, 'height': 1000}},
             'artifacts': {version: {'sha256': 'c'*64, 'apiSha256': 'd'*64} for version in ('baseline', 'candidate')}}
    for scenario in review.scenarios(component):
        for cache in ('cold', 'warm'):
            for version in ('baseline', 'candidate'):
                for repeat in range(1, 6):
                    value['samples'].append(dict(scenario=scenario, cache=cache, version=version, repeat=repeat, status='ok',
                        metrics=dict(readyMs=1000+(delta if version == 'candidate' else 0), blockingOver50Ms=100, cls=0,
                                     networkFailures=[], pendingRequests=0)))
    return value


def history(days=14):
    records = {}
    for component in review.COMPONENTS:
        for day in range(1, days+1):
            records[f'{day}/{component}'] = dict(component=component, run={'id': day, 'url': f'https://example.invalid/runs/{day}'}, report=report(component, day))
    return dict(schemaVersion=1, reports=records)


class ReviewTests(unittest.TestCase):
    def test_fourteen_distinct_dates_are_required_for_each_component(self):
        before = review.review(history(13))
        self.assertEqual({g['status'] for g in before['groups']}, {'collecting'})
        after = review.review(history())
        self.assertEqual(len(after['groups']), 3)
        self.assertEqual({g['status'] for g in after['groups']}, {'ready-for-human-review'})
        self.assertIn('not automatic gate activation', review.markdown(after))

    def test_repeats_do_not_add_days_or_replace_earlier_noisy_control(self):
        data = history(13)
        data['reports']['1/cee']['report'] = report(day=1, delta=500)
        later = report(day=1); later['startedAt'] = '2026-11-01T06:00:00Z'
        data['reports']['repeat/cee'] = dict(component='cee', run={'id': 99, 'url': 'url'}, report=later)
        group = next(g for g in review.review(data)['groups'] if g['cohort']['component'] == 'cee')
        self.assertEqual(group['count'], 13)
        self.assertTrue(any(r['warnings'] for r in group['rows']))

    def test_invalid_missing_duplicate_nonfinite_and_failed_samples_never_count(self):
        mutations = [lambda r: r.update(complete=False), lambda r: r['samples'].pop(),
                     lambda r: r['samples'].append(copy.deepcopy(r['samples'][0])),
                     lambda r: r['samples'][0].update(status='failed'),
                     lambda r: r['samples'][0]['metrics'].update(readyMs=float('nan')),
                     lambda r: r['samples'][0]['metrics'].update(pendingRequests=1),
                     lambda r: r['artifacts']['candidate'].update(sha256='f'*64),
                     lambda r: r['metadata'].update(browser='')]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                data = history(1); mutate(data['reports']['1/cee']['report'])
                result = review.review(data)
                self.assertEqual(len(result['rejected']), 1)
                self.assertFalse(any(g['cohort']['component'] == 'cee' for g in result['groups']))

    def test_cpu_browser_suite_and_artifact_changes_start_separate_cohorts(self):
        for mutation in (lambda r: r['metadata'].update(cpu='cpu-b'), lambda r: r['metadata'].update(browser='157'),
                         lambda r: r['metadata']['suite'].update(sha256='f'*64),
                         lambda r: [r['artifacts'][v].update(sha256='f'*64) for v in ('baseline', 'candidate')]):
            data = history(); mutation(data['reports']['14/cee']['report'])
            groups = [g for g in review.review(data)['groups'] if g['cohort']['component'] == 'cee']
            self.assertEqual(sorted(g['count'] for g in groups), [1, 13])
            self.assertTrue(all(g['status'] == 'collecting' for g in groups))

    def test_fourteen_noisy_days_trigger_review_but_not_a_readiness_recommendation(self):
        data = history(); data['reports']['1/cee']['report'] = report(day=1, delta=500)
        groups = review.review(data)['groups']
        self.assertEqual(next(g['status'] for g in groups if g['cohort']['component'] == 'cee'), 'needs-investigation')
        # A predetermined latest-14-day window can recover; the earlier observation stays archived.
        data['reports']['15/cee'] = dict(component='cee', run={'id':15,'url':'url'}, report=report(day=15))
        group = next(g for g in review.review(data)['groups'] if g['cohort']['component'] == 'cee')
        self.assertEqual(group['count'], 15)
        self.assertEqual(group['status'], 'ready-for-human-review')
        self.assertEqual(group['windowDates'][0], '2026-11-02')
        self.assertIn('1/cee', data['reports'])

    def test_notifications_only_at_new_milestones_and_are_assigned_to_user(self):
        with patch.object(review, 'gh') as api:
            review.notify('owner/repo','user',review.review(history(13)),'summary')
            api.assert_not_called()
        result = review.review(history())
        with patch.object(review, 'gh', side_effect=[[], {'html_url':'issue-url'}]) as api:
            self.assertEqual(review.notify('owner/repo','user',result,'summary'),'issue-url')
            payload = api.call_args.kwargs['payload']
            self.assertEqual(payload['assignees'], ['user'])
            self.assertIn('@user', payload['body'])
        existing = {'number':1,'body':payload['body'],'comments_url':'comments','html_url':'issue-url'}
        with patch.object(review, 'gh', side_effect=[[[existing]], []]) as api:
            self.assertIn('already reported',review.notify('owner/repo','user',result,'summary'))
            self.assertEqual(api.call_count, 2)
        # A new readiness milestone notifies once on the same issue.
        existing['body'] = existing['body'].replace('ready-for-human-review','needs-investigation')
        with patch.object(review, 'gh', side_effect=[[[existing]], [], {}]) as api:
            self.assertEqual(review.notify('owner/repo','user',result,'summary'),'issue-url')
            self.assertEqual(api.call_count,3)

    def test_zip_reader_reads_only_exact_json_member_never_extracts_files(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('../untrusted.py', 'raise Exception()')
            archive.writestr('report.json', '{"complete":true}')
        self.assertEqual(review.zip_json(buffer.getvalue(), 'report.json'), {'complete': True})
        with self.assertRaises(ValueError):
            review.zip_json(buffer.getvalue(), 'history.json')

    def test_compact_history_preserves_all_review_inputs(self):
        for component in review.COMPONENTS:
            raw = report(component)
            compact = review.compact_report(raw)
            self.assertEqual(review.validate(raw, component), review.validate(compact, component))
        broken = report(); broken['samples'][0]['metrics'].pop('readyMs')
        with self.assertRaises(ValueError):
            review.validate(review.compact_report(broken), 'cee')

    def test_archive_survives_expired_source_artifacts_and_failed_runs_do_not_count(self):
        saved = history(1)
        def archive(value, name):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as z:
                z.writestr(name, json.dumps(value))
            return buffer.getvalue()
        calls = []
        def api(path, **kwargs):
            calls.append(path)
            if '/artifacts?name=' in path:
                return [{'artifacts': [{'id':7,'expired':False,'workflow_run':{'id':8,'head_branch':'main'}}]}]
            if path.endswith('/runs/8'):
                return {'conclusion':'success','path':'.github/workflows/'+review.REVIEW_WORKFLOW,'event':'schedule'}
            if path.endswith('/artifacts/7/zip'):
                return archive(saved,'history.json')
            if '/workflows/' in path:
                return [{'workflow_runs':[{'id':99,'conclusion':'failure','event':'schedule','head_branch':'main'}]}]
            raise AssertionError(path)
        with patch.object(review, 'gh', side_effect=api):
            restored = review.collect('owner/repo')
        self.assertEqual(restored['reports'],saved['reports'])
        self.assertFalse(any('/runs/99/artifacts' in path for path in calls))

    def test_github_failures_do_not_become_zero_count_success(self):
        with patch.object(review, 'gh', side_effect=RuntimeError('GitHub unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                review.collect('owner/repo')


if __name__ == '__main__':
    unittest.main()
