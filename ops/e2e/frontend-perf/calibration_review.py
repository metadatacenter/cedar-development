"""Hosted calibration review. Standard library + gh; never builds or enables gates."""
import argparse
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import statistics as stats
import subprocess
import zipfile

COMPONENTS = ('cee', 'ced', 'designer')
METRICS = {'readyMs': (.10, 100), 'blockingOver50Ms': (.15, 50), 'cls': (0, .02)}
WORKFLOW = 'frontend-performance-calibration.yml'
REVIEW_WORKFLOW = 'frontend-performance-review.yml'
HISTORY = 'performance-calibration-history'
ISSUE_MARKER = '<!-- cedar-performance-calibration-review -->'
DAYS = 14


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def scenarios(component):
    prefixes = ('designer', 'ced-integrated') if component == 'designer' else (component+'-standalone',)
    return [f'{prefix}-{size}' for prefix in prefixes for size in ('small', 'large')]


def nonempty(value):
    if not isinstance(value, str) or not value:
        raise ValueError('Missing cohort identity')
    return value


def sha(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('Missing artifact/suite digest')
    return value


def validate(report, component):
    """Reject incomplete controls; keep noisy complete controls in the dataset."""
    if report.get('complete') is not True or report.get('interrupted') or report.get('setupError'):
        raise ValueError('Incomplete control')
    meta = report['metadata']
    if meta['component'] != component or meta['repetitions'] != 5:
        raise ValueError('Unexpected component or pair count')
    artifacts = report['artifacts']
    artifact = sha(artifacts['baseline']['sha256'])
    if artifact != artifacts['candidate']['sha256']:
        raise ValueError('Control inputs are not identical')
    if meta['baselineRevision'] != meta['candidateRevision'] or not re.fullmatch('[0-9a-f]{40}', meta['baselineRevision']):
        raise ValueError('Control source references differ or are absent')
    cohort = {key: nonempty(meta.get(key)) for key in ('platform', 'arch', 'cpu', 'browser', 'node')}
    if not isinstance(meta.get('profile'), dict) or not isinstance(meta.get('viewport'), dict):
        raise ValueError('Missing measurement settings')
    cohort.update(component=component, artifact=artifact, suite=sha(meta['suite']['sha256']),
                  reference=meta['baselineRevision'], profile=meta['profile'], viewport=meta['viewport'], repetitions=5)
    for key in ('inventory', 'prepared'):
        if key in artifacts['baseline']:
            cohort[key] = sha(artifacts['baseline'][key]['sha256'])
            if cohort[key] != artifacts['candidate'][key]['sha256']:
                raise ValueError('Control fixture inventories differ')
    if component == 'designer':
        cohort['api'] = sha(artifacts['baseline']['apiSha256'])
        if cohort['api'] != artifacts['candidate']['apiSha256']:
            raise ValueError('Control API fixtures differ')
    expected = {(s, cache, version, repeat) for s in scenarios(component)
                for cache in ('cold', 'warm') for version in ('baseline', 'candidate') for repeat in range(1, 6)}
    samples = {}
    for sample in report['samples']:
        key = (sample['scenario'], sample['cache'], sample['version'], sample['repeat'])
        if key not in expected or key in samples or sample['status'] != 'ok':
            raise ValueError('Missing, duplicated or failed sample')
        metrics = sample['metrics']
        if metrics.get('networkFailures') != [] or metrics.get('pendingRequests') != 0:
            raise ValueError('Loading failures or missing network evidence')
        for metric in METRICS:
            value = metrics.get(metric)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('Missing or invalid measurement')
        samples[key] = metrics
    if set(samples) != expected:
        raise ValueError('Incomplete scenario/cache coverage')
    started = dt.datetime.fromisoformat(report['startedAt'].replace('Z', '+00:00'))
    if started.tzinfo is None:
        raise ValueError('Control date has no timezone')
    return cohort, started.astimezone(dt.timezone.utc).date().isoformat(), samples


def mad(values):
    median = stats.median(values)
    return stats.median(abs(v-median) for v in values)


def daily_rows(samples, component):
    rows = []
    for scenario in scenarios(component):
        for cache in ('cold', 'warm'):
            for metric, (relative, absolute) in METRICS.items():
                before = [samples[(scenario, cache, 'baseline', i)][metric] for i in range(1, 6)]
                after = [samples[(scenario, cache, 'candidate', i)][metric] for i in range(1, 6)]
                delta = [a-b for a, b in zip(after, before)]
                limit = max(absolute, relative*stats.median(before))
                noisy = max(mad(before), mad(after), mad(delta)) > limit
                rows.append(dict(scenario=scenario, cache=cache, metric=metric, baseline=stats.median(before),
                                 delta=stats.median(delta), limit=limit, inconclusive=noisy,
                                 warning=not noisy and stats.median(delta) > limit))
    return rows


def review(history):
    groups, rejected = {}, []
    for key, entry in sorted(history['reports'].items(), key=lambda item: (item[1]['report'].get('startedAt', ''), item[0])):
        try:
            cohort, day, samples = validate(entry['report'], entry['component'])
            group_id = digest(cohort)
            group = groups.setdefault(group_id, dict(id=group_id, cohort=cohort, days={}))
            # Earliest complete observation of the day wins, regardless of timing outcome.
            group['days'].setdefault(day, dict(date=day, run=entry['run'], rows=daily_rows(samples, entry['component'])))
        except (KeyError, TypeError, ValueError) as error:
            rejected.append(dict(key=key, reason=str(error)))
    output = []
    for group in groups.values():
        days = sorted(group.pop('days').values(), key=lambda day: day['date'])
        window = days[-DAYS:]
        group.update(count=len(days), dates=[day['date'] for day in days], windowDates=[day['date'] for day in window],
                     runs=[day['run'] for day in window], rows=[])
        for index, row in enumerate(window[0]['rows']):
            observations = [day['rows'][index] for day in window]
            deltas = [r['delta'] for r in observations]
            baselines = [r['baseline'] for r in observations]
            group['rows'].append(dict(scenario=row['scenario'], cache=row['cache'], metric=row['metric'],
                                     medianDelta=stats.median(deltas), minDelta=min(deltas), maxDelta=max(deltas),
                                     deltaMAD=mad(deltas), baselineMin=min(baselines), baselineMax=max(baselines),
                                     warnings=sum(r['warning'] for r in observations),
                                     inconclusive=sum(r['inconclusive'] for r in observations)))
        group['status'] = ('collecting' if len(days) < DAYS else 'needs-investigation'
                           if any(row['warnings'] or row['inconclusive'] for row in group['rows']) else 'ready-for-human-review')
        output.append(group)
    return dict(schemaVersion=1, requiredDays=DAYS, groups=sorted(output, key=lambda g: (g['cohort']['component'], g['id'])), rejected=rejected+history.get('unavailable', []))


def markdown(result):
    lines = ['# CEDAR performance calibration review', '',
             'Timing gates remain advisory. This is an automated evidence review, not automatic gate activation.', '',
             'At least 14 distinct UTC dates per comparable component cohort are required. The latest 14 dates form the fixed review window; older observations remain archived. Complete noisy controls are retained. Same-day repeats never increase the count or replace a slower earlier observation.', '',
             '| Component / cohort | Usable days | Assessment |', '|---|---:|---|']
    for component in COMPONENTS:
        groups = [g for g in result['groups'] if g['cohort']['component'] == component]
        if not groups:
            lines.append(f'| {component} | 0 / {DAYS} | collecting |')
        for group in groups:
            lines.append(f"| {component} / `{group['id'][:12]}` | {group['count']} / {DAYS} | {group['status']} |")
    lines += ['', 'A ready cohort supports reviewing the existing provisional rules: readiness exceeds both 10% and 100 ms; blocking exceeds both 15% and 50 ms; CLS increases by 0.02. Zero false warnings and zero inconclusive rows in the latest 14 complete daily controls are required for this recommendation. This conservative screen is not a statistical guarantee or approval of thresholds.', '',
              'Authenticated full-stack measurements have a separate hosted variability review. Their availability does not block isolated component recommendations; paired component controls do not establish full-stack SSO/backend variability.', '']
    for group in result['groups']:
        lines += [f"## {group['cohort']['component']} — {group['id'][:12]}", '',
                  f"CPU: {group['cohort']['cpu']}; browser: {group['cohort']['browser']}; suite: `{group['cohort']['suite']}`; artifact: `{group['cohort']['artifact']}`.", '',
                  '| Scenario / cache / metric | Median paired change | Range | MAD | Baseline range | False warnings | Inconclusive |',
                  '|---|---:|---|---:|---|---:|---:|']
        for row in group['rows']:
            lines.append(f"| {row['scenario']} / {row['cache']} / {row['metric']} | {row['medianDelta']:.3f} | {row['minDelta']:.3f}–{row['maxDelta']:.3f} | {row['deltaMAD']:.3f} | {row['baselineMin']:.3f}–{row['baselineMax']:.3f} | {row['warnings']} | {row['inconclusive']} |")
        lines += ['', 'Evidence: '+', '.join(f"[{run['id']}]({run['url']})" for run in group['runs']), '']
    if result['rejected']:
        lines += ['## Excluded evidence', '']+[f"- {r['key']}: {r['reason']}" for r in result['rejected']]
    return '\n'.join(lines)+'\n'


def gh(path, *, pages=False, payload=None, raw=False):
    command = ['gh', 'api', path]
    if pages:
        command += ['--paginate', '--slurp']
    if payload is not None:
        command += ['--method', 'POST', '--input', '-']
    data = subprocess.run(command, input=None if payload is None else json.dumps(payload).encode(),
                          stdout=subprocess.PIPE, check=True).stdout
    return data if raw else json.loads(data)


def zip_json(data, name):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        matches = [info for info in archive.infolist() if info.filename == name]
        if len(matches) != 1 or matches[0].file_size > 256*1024*1024:
            raise ValueError('Missing, duplicate or oversized artifact JSON')
        return json.loads(archive.read(matches[0]))


def compact_report(report):
    # Preserve every measurement used by the review plus exact identities; omit network URLs,
    # per-file inventories and screenshots. Original reports remain in their source artifacts.
    meta = report.get('metadata', {})
    compact = {k: report[k] for k in ('complete', 'interrupted', 'setupError', 'startedAt', 'finishedAt') if k in report}
    compact['metadata'] = {k: meta[k] for k in ('component', 'repetitions', 'platform', 'arch', 'cpu', 'browser', 'node',
                           'baselineRevision', 'candidateRevision', 'profile', 'viewport') if k in meta}
    compact['metadata']['suite'] = {'sha256': meta.get('suite', {}).get('sha256')}
    compact['artifacts'] = {}
    for version, artifact in report.get('artifacts', {}).items():
        compact['artifacts'][version] = {k: artifact[k] for k in ('sha256', 'apiSha256') if k in artifact}
        for key in ('inventory', 'prepared'):
            if key in artifact:
                compact['artifacts'][version][key] = {'sha256': artifact[key].get('sha256')}
    compact['samples'] = []
    for sample in report.get('samples', []):
        reduced = {k: sample[k] for k in ('scenario', 'cache', 'version', 'repeat', 'status') if k in sample}
        reduced['metrics'] = {k: sample.get('metrics', {})[k] for k in (*METRICS, 'networkFailures', 'pendingRequests') if k in sample.get('metrics', {})}
        compact['samples'].append(reduced)
    return compact


def collect(repository):
    base = f'repos/{repository}/actions'
    history = {'schemaVersion': 1, 'reports': {}}
    # Restore the last successful trusted default-branch review, never a PR artifact.
    archives = [a for page in gh(base+'/artifacts?name='+HISTORY+'&per_page=100', pages=True) for a in page['artifacts']]
    for artifact in sorted(archives, key=lambda a: a['id'], reverse=True):
        if artifact['expired'] or artifact.get('workflow_run', {}).get('head_branch') != 'main':
            continue
        run = gh(base+'/runs/'+str(artifact['workflow_run']['id']))
        if run['conclusion'] == 'success' and run['path'] == '.github/workflows/'+REVIEW_WORKFLOW and run['event'] in ('schedule', 'workflow_run', 'workflow_dispatch'):
            history = zip_json(gh(base+'/artifacts/'+str(artifact['id'])+'/zip', raw=True), 'history.json')
            if history.get('schemaVersion') != 1 or not isinstance(history.get('reports'), dict):
                raise ValueError('Invalid retained history; refusing to discard evidence')
            break
    history['unavailable'] = []
    runs = [run for page in gh(base+'/workflows/'+WORKFLOW+'/runs?per_page=100', pages=True) for run in page['workflow_runs']]
    for run in sorted(runs, key=lambda r: r['id']):
        if run['conclusion'] != 'success' or run['event'] not in ('push', 'schedule', 'workflow_dispatch') or run['head_branch'] not in ('main', 'develop'):
            continue
        artifacts = [a for page in gh(base+'/runs/'+str(run['id'])+'/artifacts?per_page=100', pages=True) for a in page['artifacts']]
        for component in COMPONENTS:
            key = f"{run['id']}/{run.get('run_attempt', 1)}/{component}"
            if key in history['reports']:
                continue
            matches = [a for a in artifacts if a['name'] == 'calibration-'+component and not a['expired']]
            if len(matches) != 1:
                history['unavailable'].append(dict(key=key, reason='Calibration artifact absent, expired or ambiguous'))
                continue
            report = zip_json(gh(base+'/artifacts/'+str(matches[0]['id'])+'/zip', raw=True), 'report.json')
            history['reports'][key] = dict(component=component, run={'id': run['id'], 'url': run['html_url']},
                artifactId=matches[0]['id'], canonicalSourceDigest=digest(report), report=compact_report(report))
    return history


def notify(repository, recipient, result, body):
    milestones = {g['id']+':'+g['status'] for g in result['groups'] if g['count'] >= DAYS}
    if not milestones:
        return 'Not enough comparable days; no notification sent.'
    issues = [i for page in gh(f'repos/{repository}/issues?state=all&per_page=100', pages=True) for i in page
              if 'pull_request' not in i and ISSUE_MARKER in (i.get('body') or '')]
    existing = next(iter(sorted(issues, key=lambda i: i['number'])), None)
    marker = r'<!-- calibration-milestones: (.*?) -->'
    seen = set()
    if existing:
        for text in [existing.get('body') or '']+[c['body'] for page in gh(existing['comments_url']+'?per_page=100', pages=True) for c in page]:
            for match in re.findall(marker, text):
                seen.update(json.loads(match))
    fresh = milestones-seen
    if not fresh:
        return 'Readiness milestone already reported; no duplicate notification.'
    message = (ISSUE_MARKER+'\n<!-- calibration-milestones: '+json.dumps(sorted(milestones))+' -->\n\n'
               +f'@{recipient} — at least one performance cohort now has 14 comparable daily runs. See the assessment below; gates have not been enabled.\n\n'+body)
    if len(message) > 60000:
        raise ValueError('Review exceeds issue size; retain artifact and revise summary before notifying')
    if existing:
        gh(existing['comments_url'], payload={'body': message})
        return existing['html_url']
    issue = gh(f'repos/{repository}/issues', payload={'title': 'Review CEDAR frontend performance timing gates', 'body': message, 'assignees': [recipient]})
    return issue['html_url']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='metadatacenter/cedar-development')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--history', type=Path, help='Offline evidence instead of GitHub collection')
    parser.add_argument('--notify', action='store_true')
    parser.add_argument('--recipient', default='martinjoconnor')
    args = parser.parse_args()
    if args.notify and args.history:
        parser.error('Offline evidence cannot send notifications')
    history = json.loads(args.history.read_text()) if args.history else collect(args.repository)
    result = review(history)
    body = markdown(result)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, value in [('history.json', history), ('review.json', result)]:
        (args.output/name).write_text(json.dumps(value, sort_keys=True)+'\n')
    (args.output/'summary.md').write_text(body)
    print(body)
    if args.notify:
        print(notify(args.repository, args.recipient, result, body))


if __name__ == '__main__':
    main()
