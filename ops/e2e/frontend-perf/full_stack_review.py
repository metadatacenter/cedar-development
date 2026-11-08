"""Retain and review comparable daily hosted full-stack measurements; never enable gates."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import statistics as stats
from calibration_review import gh, zip_json, digest, mad, notify, DAYS, REVIEW_WORKFLOW

WORKFLOW = 'frontend-performance-full-stack.yml'
HISTORY = 'full-stack-performance-history'
SCENARIOS = ['workspace-dashboard', 'monitoring-dashboard', 'bridging-dashboard', 'content-index', 'term-picker'] + [
    f'{family}-{size}' for family in ('cee-standalone', 'ced-standalone', 'ced-integrated', 'designer', 'workspace-editor', 'openview')
    for size in ('small', 'large')]
METRICS = ('readyMs', 'blockingOver50Ms', 'cls', 'transferBytes')


def compact(report):
    result = {k: report[k] for k in ('startedAt', 'complete', 'interrupted', 'setupError', 'setupFailures', 'cleanupErrors') if k in report}
    meta = report.get('metadata', {})
    result['metadata'] = {k: meta[k] for k in ('repetitions', 'profiles', 'viewport', 'browser', 'node', 'suite', 'deployment') if k in meta}
    result['metadata']['machine'] = {k: meta.get('machine', {}).get(k) for k in ('platform', 'arch', 'cpu', 'logicalCpus', 'memoryBytes')}
    # Runtime configuration contains freshly generated identifiers, so use immutable image/package
    # source identities, not hashes of the generated configuration, to identify comparable inputs.
    result['metadata']['sources'] = meta.get('sources', {})
    result['samples'] = [{**{k:s[k] for k in ('scenario', 'profile', 'cache', 'repeat', 'status') if k in s},
                          'metrics':{k:s.get('metrics', {}).get(k) for k in METRICS}} for s in report.get('samples', [])]
    return result


def validate(report):
    if report.get('complete') is not True or report.get('interrupted') or report.get('setupError') or report.get('setupFailures') or report.get('cleanupErrors') != []:
        raise ValueError('Incomplete run or unverified setup/cleanup')
    meta = report['metadata']; deployment = meta['deployment']
    if meta['repetitions'] != 5 or set(meta['profiles']) != {'normal', 'constrained'}:
        raise ValueError('Requires five repetitions and both profiles')
    cohort = {k:meta[k] for k in ('machine', 'browser', 'node', 'profiles', 'viewport', 'sources')}
    cohort['suite'] = meta['suite']['sha256']
    cohort['deployment'] = {k:deployment[k] for k in ('train', 'images', 'resourceLimits', 'tooling')}
    if not all(cohort[k] for k in ('browser', 'node', 'suite', 'sources')) or not all(cohort['machine'].values()):
        raise ValueError('Missing stable measurement identity')
    expected = {(s,p,c,r) for s in SCENARIOS for p in ('normal','constrained') for c in ('cold','warm') for r in range(1,6)}
    samples = {}
    for sample in report['samples']:
        key = tuple(sample[k] for k in ('scenario','profile','cache','repeat'))
        if key not in expected or key in samples or sample['status'] != 'ok':
            raise ValueError('Failed, duplicated or unexpected sample')
        values = sample['metrics']
        for metric in METRICS:
            value = values[metric]
            if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or value < 0:
                raise ValueError('Invalid measurement')
        samples[key] = values
    if set(samples) != expected: raise ValueError('Missing scenario/profile/cache coverage')
    started = dt.datetime.fromisoformat(report['startedAt'].replace('Z','+00:00'))
    if started.tzinfo is None: raise ValueError('Missing UTC date')
    rows = []
    for scenario in SCENARIOS:
        for profile in ('normal','constrained'):
            for cache in ('cold','warm'):
                for metric in METRICS:
                    values = [samples[(scenario,profile,cache,r)][metric] for r in range(1,6)]
                    rows.append(dict(scenario=scenario,profile=profile,cache=cache,metric=metric,median=stats.median(values),withinRunMAD=mad(values)))
    return cohort, started.astimezone(dt.timezone.utc).date().isoformat(), rows


def review(history):
    groups = {}; rejected = list(history.get('unavailable', []))
    for key,entry in sorted(history['reports'].items(),key=lambda item:(item[1]['report'].get('startedAt',''),item[0])):
        try:
            cohort,day,rows = validate(entry['report']); identity = digest(cohort)
            group = groups.setdefault(identity,dict(id=identity,cohort=cohort,days={}))
            group['days'].setdefault(day,dict(date=day,run=entry['run'],rows=rows))
        except (KeyError,TypeError,ValueError) as error:
            rejected.append(dict(key=key,reason=str(error)))
    for group in groups.values():
        days = sorted(group.pop('days').values(),key=lambda d:d['date']); window=days[-DAYS:]
        group.update(count=len(days),dates=[d['date'] for d in days],windowDates=[d['date'] for d in window],runs=[d['run'] for d in window],rows=[])
        for index,row in enumerate(window[0]['rows']):
            values=[d['rows'][index]['median'] for d in window]
            group['rows'].append({**{k:row[k] for k in ('scenario','profile','cache','metric')},
                                 'median':stats.median(values),'min':min(values),'max':max(values),'betweenDayMAD':mad(values),
                                 'maxWithinRunMAD':max(d['rows'][index]['withinRunMAD'] for d in window)})
        group['status']='ready-for-variability-review' if len(days)>=DAYS else 'collecting'
    return dict(schemaVersion=1,requiredDays=DAYS,groups=sorted(groups.values(),key=lambda g:g['id']),rejected=rejected)


def markdown(result):
    lines=['# Hosted full-stack performance review','','All 17 modern scenarios, including standalone CEE/CED, use real isolated APIs and SSO. Timing gates remain reporting-only.','',
           'One earliest complete five-repetition run per UTC day counts in each stable train/tooling/browser/CPU cohort. After 14 days, review the latest 14 days for backend and runner variability before proposing limits. These unpaired daily measurements do not establish false-positive rates or approve gates.','',
           '| Cohort | Usable days | Assessment |','|---|---:|---|']
    for group in result['groups']:
        lines.append(f"| `{group['id'][:12]}` | {group['count']} / {DAYS} | {group['status']} |")
    if not result['groups']: lines.append('| No complete comparable cohort | 0 / 14 | collecting |')
    for group in result['groups']:
        lines += ['',f"Train: `{group['cohort']['deployment']['train']}`; CPU: {group['cohort']['machine']['cpu']}; browser: {group['cohort']['browser']}.",
                  'Evidence: '+', '.join(f"[{run['id']}]({run['url']})" for run in group['runs'])+'.',
                  'Per-scenario medians, ranges, within-run and between-day median absolute deviations are retained in `full-stack-review.json`.']
    if result['rejected']:
        lines += ['','Excluded incomplete/noncomparable reports:']+[f"- {r['key']}: {r['reason']}" for r in result['rejected']]
    return '\n'.join(lines)+'\n'


def collect(repository):
    base=f'repos/{repository}/actions'; history={'schemaVersion':1,'reports':{}}
    archives=[a for page in gh(base+'/artifacts?name='+HISTORY+'&per_page=100',pages=True) for a in page['artifacts']]
    for artifact in sorted(archives,key=lambda a:a['id'],reverse=True):
        if artifact['expired'] or artifact.get('workflow_run',{}).get('head_branch')!='main': continue
        run=gh(base+'/runs/'+str(artifact['workflow_run']['id']))
        if run['conclusion']=='success' and run['path']=='.github/workflows/'+REVIEW_WORKFLOW and run['event'] in ('schedule','workflow_run','workflow_dispatch'):
            history=zip_json(gh(base+'/artifacts/'+str(artifact['id'])+'/zip',raw=True),'full-stack-history.json')
            if history.get('schemaVersion')!=1 or not isinstance(history.get('reports'),dict): raise ValueError('Invalid retained full-stack history')
            break
    history['unavailable']=[]
    runs=[r for page in gh(base+'/workflows/'+WORKFLOW+'/runs?per_page=100',pages=True) for r in page['workflow_runs']]
    for run in sorted(runs,key=lambda r:r['id']):
        if run['conclusion']!='success' or run['head_branch'] not in ('main','develop') or run['event'] not in ('schedule','workflow_dispatch','push'): continue
        key=f"{run['id']}/{run.get('run_attempt',1)}"
        if key in history['reports']: continue
        artifacts=[a for page in gh(base+'/runs/'+str(run['id'])+'/artifacts?per_page=100',pages=True) for a in page['artifacts']]
        matches=[a for a in artifacts if a['name']=='full-stack-performance' and not a['expired']]
        if len(matches)!=1:
            history['unavailable'].append(dict(key=key,reason='Missing, expired or ambiguous full-stack report')); continue
        report=zip_json(gh(base+'/artifacts/'+str(matches[0]['id'])+'/zip',raw=True),'report.json')
        history['reports'][key]=dict(run={'id':run['id'],'url':run['html_url']},artifactId=matches[0]['id'],canonicalSourceDigest=digest(report),report=compact(report))
    return history


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository',default='metadatacenter/cedar-development');parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--notify',action='store_true');parser.add_argument('--recipient',default='martinjoconnor')
    args=parser.parse_args();history=collect(args.repository);result=review(history);body=markdown(result)
    args.output.mkdir(parents=True,exist_ok=True)
    for name,value in [('full-stack-history.json',history),('full-stack-review.json',result)]:
        (args.output/name).write_text(json.dumps(value,sort_keys=True)+'\n')
    (args.output/'full-stack-summary.md').write_text(body);print(body)
    if args.notify: print(notify(args.repository,args.recipient,result,body))


if __name__=='__main__': main()
