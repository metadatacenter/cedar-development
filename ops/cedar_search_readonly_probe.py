#!/usr/bin/env python3
"""Bounded GET-only search regression probe; no fixtures, commands or reindex requests.

Counts are observations of a live, permission-scoped index, not an atomic inventory.
The API key is read from a file and sent only to the selected HTTPS origin. Redirects
are refused, and reports contain no headers, credentials or full artifact bodies.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


QUERIES = [
    'Rad', 'rad', 'RAD', '"Rad"', '"rad"', '"RAD"', 'rad*', r'rad\*',
    '"Moles/volume"', '"Moles volume"', '"2-Dimensional"', '"2 Dimensional"',
    '"Dried blood spot"', '"DRIED BLOOD SPOT"', '"spot blood Dried"',
    'Sex:Male', 'Sex: Male', 'Sex:"Male"', 'Sex: "Male"', 'Sex:Female',
    'Sex:Male AND Sex:Female', 'Sex:Male OR Sex:Female', 'Sex:Male NOT Sex:Female',
    'ALT:', 'ALT:*', '"ALT":*', '[pv]*', '[pv]Yes', '[pv]=Yes', '[pv]=yes',
    '4768151', '4768151 AND [pv]Yes', '"Rad', 'Rad AND (',
]
EQUAL_PAIRS = [
    ('Rad', 'rad'), ('Rad', 'RAD'), ('"Rad"', '"rad"'), ('"Rad"', '"RAD"'),
    ('"Moles/volume"', '"Moles volume"'), ('"2-Dimensional"', '"2 Dimensional"'),
    ('"Dried blood spot"', '"DRIED BLOOD SPOT"'),
    ('Sex:Male', 'Sex: Male'), ('Sex:"Male"', 'Sex: "Male"'),
    ('ALT:', 'ALT:*'), ('ALT:*', '"ALT":*'), ('[pv]=Yes', '[pv]=yes'),
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Authenticated redirects are refused')


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('Server must be an HTTPS origin without credentials, path or query')
    return urllib.parse.urlunsplit(('https', parsed.netloc, '', '', ''))


def paging_issues(server, query, paging):
    issues = []
    for relation, link in (paging or {}).items():
        if not isinstance(link, str) or not link:
            continue
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin(server, link))
        if parsed.scheme != 'https' or parsed.netloc != urllib.parse.urlsplit(server).netloc:
            issues.append({'kind': 'pagination-origin', 'relation': relation,
                           'scheme': parsed.scheme, 'host': parsed.hostname})
        returned = urllib.parse.parse_qs(parsed.query).get('q', [])
        if returned != [query]:
            issues.append({'kind': 'pagination-query', 'relation': relation, 'returned': returned})
    return issues


def analyze(records, server):
    findings = []
    for endpoint in ('search', 'search-deep'):
        rows = {row['query']: row for row in records if row['endpoint'] == endpoint}
        for row in rows.values():
            expected_status = 400 if row['query'] in ('"Rad', 'Rad AND (') else 200
            if row['status'] != expected_status:
                findings.append({'kind': 'status', 'endpoint': endpoint, 'query': row['query'],
                                 'actual': row['status'], 'expected': expected_status})
            for issue in paging_issues(server, row['query'], row.get('paging')):
                findings.append({'endpoint': endpoint, 'query': row['query'], **issue})
        for left, right in EQUAL_PAIRS:
            if all(rows.get(q, {}).get('status') == 200 for q in (left, right)):
                a, b = rows[left]['totalCount'], rows[right]['totalCount']
                if a != b:
                    findings.append({'kind': 'equivalent-counts', 'endpoint': endpoint,
                                     'queries': [left, right], 'counts': [a, b]})
        boolean = ['Sex:Male', 'Sex:Female', 'Sex:Male AND Sex:Female',
                   'Sex:Male OR Sex:Female', 'Sex:Male NOT Sex:Female']
        if all(rows.get(q, {}).get('status') == 200 for q in boolean):
            a, b, both, either, difference = [rows[q]['totalCount'] for q in boolean]
            if either != a + b - both or difference != a - both:
                findings.append({'kind': 'boolean-counts', 'endpoint': endpoint,
                                 'counts': [a, b, both, either, difference]})
    return findings


def run(server, key, delay):
    opener = urllib.request.build_opener(NoRedirect)
    records = []
    for endpoint in ('search', 'search-deep'):
        for query in QUERIES:
            url = server + '/' + endpoint + '?' + urllib.parse.urlencode(
                {'q': query, 'limit': 3, 'sort': 'name'})
            request = urllib.request.Request(url, method='GET', headers={
                'Authorization': 'apiKey ' + key, 'Accept': 'application/json'})
            start = time.monotonic()
            try:
                with opener.open(request, timeout=30) as response:
                    status, body = response.status, json.load(response)
            except urllib.error.HTTPError as error:
                status, body = error.code, {}
                error.close()
            except (OSError, RuntimeError, ValueError) as error:
                # Never print request objects or exception payloads containing remote input.
                status, body = type(error).__name__, {}
            row = {'endpoint': endpoint, 'query': query, 'status': status,
                   'elapsedSeconds': round(time.monotonic() - start, 3),
                   'totalCount': body.get('totalCount'), 'paging': body.get('paging'),
                   'sampleIds': [r.get('@id') for r in body.get('resources', [])]}
            records.append(row)
            print(f'{len(records)}/{2 * len(QUERIES)} {endpoint} {query!r}: {status}, '
                  f'count={row["totalCount"]}', flush=True)
            if status in (401, 403):
                break
            time.sleep(delay)
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', default='https://resource.metadatacenter.org', type=origin)
    parser.add_argument('--api-key-file', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--delay', type=float, default=.25)
    args = parser.parse_args()
    if args.delay < .1:
        parser.error('--delay must be at least 0.1 seconds')
    key = args.api_key_file.expanduser().read_text().strip()
    if not key or '\n' in key or '\r' in key:
        parser.error('API key file must contain one nonempty line')
    records = run(args.server, key, args.delay)
    report = {'time': datetime.now(timezone.utc).isoformat(), 'server': args.server,
              'scope': 'GET-only, supplied-key visibility, three sample IDs per query; no writes',
              'limitations': ['Live counts can change during the run.',
                              'Samples do not establish full result-set equality or permission isolation.',
                              'No inference about possible-value coverage without reading field constraints.',
                              'Pagination URLs are inspected but not followed.'],
              'records': records, 'findings': analyze(records, args.server)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(f'{len(records)} reads; {len(report["findings"])} findings; report: {args.out}')
    return 1 if report['findings'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
