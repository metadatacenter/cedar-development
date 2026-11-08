import copy
import io
import json
import unittest
import zipfile
from unittest.mock import patch
import full_stack_review as review


def report(day=1):
    meta=dict(repetitions=5,profiles={'normal':{},'constrained':{'cpu':4}},viewport={'width':1440,'height':1000},
              browser='156',node='24',suite={'sha256':'a'*64},sources={'cee':{'revision':'b'*40}},
              machine=dict(platform='linux',arch='x64',cpu='cpu-a',logicalCpus=4,memoryBytes=16000000000),
              deployment=dict(train='fixed-train',images=['digest'],resourceLimits={'heap':512},tooling={'cli':'c'*40},bootstrap={'sha256':'fixed-bootstrap'},manifestSha256='random-runtime-config'))
    return dict(complete=True,interrupted=False,setupFailures=[],cleanupErrors=[],startedAt=f'2026-11-{day:02}T03:00:00Z',metadata=meta,
                samples=[dict(scenario=s,profile=p,cache=c,repeat=r,status='ok',metrics=dict(readyMs=1000,blockingOver50Ms=50,cls=0,transferBytes=10000))
                         for s in review.SCENARIOS for p in ('normal','constrained') for c in ('cold','warm') for r in range(1,6)])


def history(days=14):
    return dict(schemaVersion=1,reports={str(day):dict(run={'id':day,'url':'https://example.invalid/'+str(day)},report=report(day)) for day in range(1,days+1)})


class FullStackReviewTest(unittest.TestCase):
    def test_distinct_days_not_retries_and_variability_is_not_gate_approval(self):
        data=history(13);later=report();later['startedAt']='2026-11-01T06:00:00Z'
        data['reports']['later']=dict(run={'id':99,'url':'url'},report=later)
        group=review.review(data)['groups'][0]
        self.assertEqual((group['count'],group['status']),(13,'collecting'))
        data['reports']['14']=history()['reports']['14']
        result=review.review(data)
        self.assertEqual(result['groups'][0]['status'],'ready-for-variability-review')
        self.assertIn('do not establish false-positive rates or approve gates',review.markdown(result))

    def test_incomplete_or_invalid_measurements_never_count(self):
        for mutate in (lambda r:r.update(complete=False),lambda r:r.update(cleanupErrors=['failed']),
                       lambda r:r.update(setupFailures=['auth']),lambda r:r['samples'].pop(),
                       lambda r:r['samples'].append(copy.deepcopy(r['samples'][0])),
                       lambda r:r['samples'][0]['metrics'].update(readyMs=float('nan')),
                       lambda r:r['metadata'].update(repetitions=1)):
            data=history(1);mutate(data['reports']['1']['report']);result=review.review(data)
            self.assertEqual(len(result['rejected']),1);self.assertEqual(result['groups'],[])

    def test_exact_cohorts_exclude_ephemeral_runtime_settings(self):
        for mutate in (lambda m:m.update(browser='157'),lambda m:m['machine'].update(cpu='cpu-b'),
                       lambda m:m['deployment'].update(train='new-train'),lambda m:m['deployment']['tooling'].update(cli='new'),
                       lambda m:m['suite'].update(sha256='new')):
            data=history();mutate(data['reports']['14']['report']['metadata'])
            self.assertEqual(sorted(g['count'] for g in review.review(data)['groups']),[1,13])
        data=history();data['reports']['14']['report']['metadata']['deployment']['manifestSha256']='different-generated-config'
        self.assertEqual(review.review(data)['groups'][0]['count'],14)

    def test_compact_retains_inputs_and_latest_window_retains_slow_days(self):
        data=history(15);data['reports']['1']['report']['samples'][0]['metrics']['readyMs']=9999
        reduced=copy.deepcopy(data)
        for entry in reduced['reports'].values():entry['report']=review.compact(entry['report'])
        self.assertEqual(review.review(data),review.review(reduced))
        group=review.review(reduced)['groups'][0]
        self.assertEqual(group['windowDates'][0],'2026-11-02');self.assertEqual(group['count'],15)
        self.assertEqual(reduced['reports']['1']['report']['samples'][0]['metrics']['readyMs'],9999)

    def test_restores_history_and_failed_runs_do_not_count(self):
        archived=history(1);buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:archive.writestr('full-stack-history.json',json.dumps(archived))
        def api(path,**kwargs):
            if '/artifacts?name=' in path:return [{'artifacts':[dict(id=10,expired=False,workflow_run=dict(id=9,head_branch='main'))]}]
            if path.endswith('/runs/9'):return dict(conclusion='success',path='.github/workflows/'+review.REVIEW_WORKFLOW,event='schedule')
            if path.endswith('/artifacts/10/zip'):return buffer.getvalue()
            if '/workflows/' in path:return [{'workflow_runs':[dict(id=11,conclusion='failure',head_branch='main',event='schedule')]}]
            self.fail(path)
        with patch.object(review,'gh',side_effect=api):
            self.assertEqual(review.collect('org/repo')['reports'],archived['reports'])
        with patch.object(review,'gh',side_effect=RuntimeError('API unavailable')):
            with self.assertRaises(RuntimeError):review.collect('org/repo')
