#!/usr/bin/env python3
"""Bounded, GET-only production search audit with independent set and metadata oracles.

No fixtures, writes, load commands, or reindexing. Reads a key from a file, refuses
redirects, and follows only search links on the selected HTTPS origin. Reports omit
credentials, continuation tokens, provenance identities, and full artifact bodies.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

from cedar_search_readonly_probe import NoRedirect, origin

TYPES = ['folder', 'field', 'element', 'template', 'instance']
SCHEMA_TYPES = ['field', 'element', 'template']
META = ['@id', 'resourceType', 'schema:name', 'bibo:status', 'isLatestVersion',
        'isLatestDraftVersion', 'isLatestPublishedVersion', 'pav:lastUpdatedOn',
        'pav:createdOn', 'activeUserCanRead', 'isOpen', 'isOpenImplicitly']


def ids(body):
    return [r.get('@id') for r in body.get('resources', [])]


def redacted_params(params):
    return {k: ('<token>' if k == 'continuation' and v != 'start' else v)
            for k, v in params.items()}


def link_params(server, url):
    parsed = urllib.parse.urlsplit(urllib.parse.urljoin(server, url))
    if (parsed.scheme != 'https' or parsed.netloc != urllib.parse.urlsplit(server).netloc
            or parsed.username or parsed.password or parsed.fragment
            or parsed.path not in ('/search', '/search-deep')):
        raise ValueError('Unsafe pagination origin or path')
    values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if any(len(v) != 1 for v in values.values()):
        raise ValueError('Repeated pagination parameter')
    return parsed.path, {k: v[0] for k, v in values.items()}


def metadata_errors(params, resources):
    errors = []
    allowed = (params.get('resource_types') or ','.join(TYPES)).split(',')
    for resource in resources:
        reasons = []
        kind = resource.get('resourceType')
        if kind not in allowed:
            reasons.append('resource-type')
        # Identifier lookup has documented selector precedence; only its type/date
        # filters are applied. It is not an indexed content search.
        if kind in SCHEMA_TYPES and 'id' not in params:
            status = params.get('publication_status', 'all')
            if status != 'all' and resource.get('bibo:status') != status:
                reasons.append('publication-status')
            version = params.get('version', 'all')
            if version == 'latest' and resource.get('isLatestVersion') is not True:
                reasons.append('latest-version')
            if version == 'latest-by-status':
                flag = {'bibo:draft': 'isLatestDraftVersion',
                        'bibo:published': 'isLatestPublishedVersion'}.get(status)
                if flag and resource.get(flag) is not True:
                    reasons.append('latest-by-status')
        if 'modified_after' in params or 'modified_before' in params:
            try:
                timestamp = datetime.fromisoformat(resource['pav:lastUpdatedOn'].replace('Z', '+00:00')).timestamp() * 1000
                if timestamp < int(params.get('modified_after', '-9223372036854775808')):
                    reasons.append('modified-after')
                if timestamp >= int(params.get('modified_before', '9223372036854775807')):
                    reasons.append('modified-before')
            except (KeyError, ValueError, TypeError):
                reasons.append('missing-modified-time')
        if resource.get('activeUserCanRead') is False:
            reasons.append('unreadable-hit')
        if reasons:
            errors.append({'id': resource.get('@id'), 'reasons': reasons})
    return errors


def comparable_params(params):
    """Jersey's empty Optional values are absent; canonical IDs may be shortened."""
    result = {k: str(v) for k, v in params.items()
              if k not in ('offset', 'continuation') and str(v) != ''}
    for key in ('id', 'is_based_on'):
        value = result.get(key, '')
        if value.startswith('https://repo.metadatacenter.org/'):
            result[key] = value.removeprefix('https://repo.metadatacenter.org/')
    return result


class Audit:
    def __init__(self, server, key, out, delay=.25, max_reads=1200):
        self.server, self.key, self.out, self.delay = server, key, out, delay
        self.max_reads = max_reads
        self.opener = urllib.request.build_opener(NoRedirect)
        self.records, self.checks, self.skipped = [], [], []
        self.started = datetime.now(timezone.utc).isoformat()
        self.failures = 0
        self.out.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.out.with_suffix('.jsonl').open('x')

    def check(self, name, condition, **details):
        self.checks.append({'check': name, 'pass': bool(condition), **details})

    def get(self, path, params, label, expected=200):
        if len(self.records) >= self.max_reads:
            raise RuntimeError('Read budget exhausted')
        if path in ('/search', '/search-deep'):
            link_params(self.server, path + '?' + urllib.parse.urlencode(params, doseq=True))
        elif not path.startswith('/template-fields/https%3A%2F%2Frepo.metadatacenter.org%2Ftemplate-fields%2F'):
            raise ValueError('Only search and explicit field reads are allowed')
        url = self.server + path + ('?' + urllib.parse.urlencode(params, doseq=True) if params else '')
        req = urllib.request.Request(url, method='GET', headers={
            'Authorization': 'apiKey ' + self.key, 'Accept': 'application/json'})
        started = time.monotonic()
        try:
            with self.opener.open(req, timeout=30) as response:
                status, body = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                body = json.load(error)
            except (ValueError, OSError):
                body = {}
            error.close()
        except (OSError, RuntimeError, ValueError) as error:
            status, body = type(error).__name__, {}
        self.failures = self.failures + 1 if not isinstance(status, int) or status >= 500 else 0
        row = {'n': len(self.records) + 1, 'label': label, 'path': path,
               'parameters': redacted_params(params), 'status': status,
               'elapsedSeconds': round(time.monotonic() - started, 3),
               'totalCount': body.get('totalCount'), 'currentOffset': body.get('currentOffset'),
               'nodeListQueryType': body.get('nodeListQueryType'),
               'resources': [{k: r.get(k) for k in META} for r in body.get('resources', [])]}
        if path.startswith('/template-fields/'):
            row['field'] = {k: body.get(k) for k in ['@id', 'schema:name', '_valueConstraints']}
        self.records.append(row)
        self.stream.write(json.dumps(row) + '\n')
        self.stream.flush()
        self.check('http-status', status in expected if isinstance(expected, tuple) else status == expected,
                   request=row['n'], expected=expected, actual=status)
        if status == 200 and path in ('/search', '/search-deep'):
            self.check('page-unique-ids', len(ids(body)) == len(set(ids(body))), request=row['n'])
            self.check('page-size', len(ids(body)) <= int(params.get('limit', 100)), request=row['n'])
            errors = metadata_errors(params, body.get('resources', []))
            self.check('result-metadata-filters', not errors, request=row['n'], errors=errors)
            for rel, link in (body.get('paging') or {}).items():
                try:
                    route, returned = link_params(self.server, link)
                    wanted = comparable_params(params)
                    normalized = comparable_params(returned)
                    self.check('pagination-preserves-query-and-filters', route == path and
                               all(normalized.get(k) == v for k, v in wanted.items()),
                               request=row['n'], relation=rel)
                    if 'offset' in returned:
                        self.check('pagination-nonnegative-offset', int(returned['offset']) >= 0,
                                   request=row['n'], relation=rel, offset=returned['offset'])
                except ValueError:
                    self.check('pagination-safe-origin', False, request=row['n'], relation=rel)
        if len(self.records) % 20 == 0:
            print(f'{len(self.records)} reads; {sum(not c["pass"] for c in self.checks)} failed checks; {label}', flush=True)
        time.sleep(self.delay)
        if status in (401, 403) or self.failures >= 5:
            raise RuntimeError('Stopped after authorization failure or repeated server failures')
        return body if status == 200 else None

    def search(self, query, extra=None, label='query', endpoint='/search', expected=200):
        return self.get(endpoint, {'q': query, 'limit': 100, 'sort': 'name', **(extra or {})}, label, expected)

    def walk(self, query, extra=None, endpoint='/search', continuation=False, limit=100, cap=1000, label='walk'):
        params = {'q': query, 'limit': limit, 'sort': 'name', **(extra or {})}
        if continuation:
            params['continuation'] = 'start'
        rows, totals, seen_links = [], [], set()
        for page in range(60):
            body = self.get(endpoint, params, f'{label}/page-{page}')
            if body is None:
                return None
            totals.append(body['totalCount'])
            rows.extend(body.get('resources', []))
            if totals[0] > cap:
                self.skipped.append({'label': label, 'reason': 'complete-set cap', 'totalCount': totals[0], 'cap': cap})
                return None
            link = (body.get('paging') or {}).get('next')
            if not link:
                self.check('walk-complete-unique', len(rows) == len({r['@id'] for r in rows}) == totals[0],
                           label=label, rows=len(rows), total=totals[0])
                self.check('walk-stable-total', len(set(totals)) == 1, label=label, totals=totals)
                return rows
            if link in seen_links:
                self.check('walk-advances', False, label=label)
                return None
            seen_links.add(link)
            try:
                endpoint, params = link_params(self.server, link)
            except ValueError:
                return None
        self.skipped.append({'label': label, 'reason': 'page cap'})
        return None

    def equal_sets(self, label, *rows):
        if all(r is not None for r in rows):
            sets = [set(r['@id'] for r in result) for result in rows]
            self.check(label, all(s == sets[0] for s in sets), sizes=[len(s) for s in sets],
                       differences=[sorted(s ^ sets[0])[:10] for s in sets[1:]])
        else:
            self.skipped.append({'label': label, 'reason': 'incomplete input'})

    def save(self, completed, error=None):
        report = {'started': self.started, 'finished': datetime.now(timezone.utc).isoformat(),
                  'server': self.server, 'completed': completed, 'error': error,
                  'scope': 'GET-only, supplied-key visibility; no production writes',
                  'limitations': ['Live index may change between requests.',
                                  'Admin visibility does not prove ordinary-user permission isolation.',
                                  'Coverage is query-selected; this is not an exhaustive artifact inventory.',
                                  'Continuation tokens and full artifact documents are not retained.'],
                  'reads': len(self.records), 'checks': self.checks,
                  'findings': [c for c in self.checks if not c['pass']], 'skipped': self.skipped,
                  'records': self.records}
        self.out.write_text(json.dumps(report, indent=2) + '\n')
        self.stream.close()
        print(json.dumps({k: report[k] for k in ['completed', 'reads', 'error']}), flush=True)
        print(f'{len(self.checks)} checks; {len(report["findings"])} failures; {len(self.skipped)} skipped; {self.out}', flush=True)


def run(a):
    # Full sets: equivalence is measured by identifier, not by matching counts.
    groups = [
        ['"Rad"', '"rad"', '"RAD"', '("Rad")'],
        ['"Moles/volume"', '"Moles volume"', '"MOLES/VOLUME"'],
        ['"2-Dimensional"', '"2 Dimensional"'],
        ['"Dried blood spot"', '"DRIED BLOOD SPOT"'],
        ['ALT:', 'ALT:*', '"ALT":*', 'ALT: *'],
        ['[pv]=Yes', '[pv]=yes'],
    ]
    cohorts = {}
    for group in groups:
        sets = [a.walk(q, label=f'equivalence/{q}') for q in group]
        a.equal_sets('equivalent-complete-sets/' + group[0], *sets)
        cohorts[group[0]] = sets[0]
    for q in ['"ALT"', '4768151', '[pv]*', 'rad\\*', '"spot blood Dried"']:
        cohorts[q] = a.walk(q, label=f'cohort/{q}')

    # Both indexed offset routes, with compound filters, checked against metadata.
    filters = [{}, *[{'resource_types': t} for t in TYPES],
               {'resource_types': 'template,element,field'},
               {'version': 'latest'}, {'version': 'latest-by-status'},
               {'publication_status': 'bibo:published'}, {'publication_status': 'bibo:draft'},
               {'version': 'latest', 'publication_status': 'bibo:published'},
               {'version': 'latest-by-status', 'publication_status': 'bibo:draft'},
               {'sharing': 'shared-with-everybody'}, {'sharing': 'shared-with-me'},
               {'modified_after': 0, 'modified_before': 1577836800000},
               {'modified_after': 1577836800000},
               {'resource_types': 'field', 'version': 'latest', 'publication_status': 'bibo:published',
                'modified_after': 1577836800000, 'sharing': 'shared-with-everybody'}]
    for q in ['"Rad"', '"Moles/volume"', '"Dried blood spot"', 'Sex:Male', 'ALT:', '[pv]*']:
        counts = {}
        for i, f in enumerate(filters):
            pair = [a.search(q, {'limit': 7, **f}, f'filters/{q}/{i}', endpoint=ep)
                    for ep in ['/search', '/search-deep']]
            if all(b is not None for b in pair):
                a.check('endpoint-count-parity', pair[0]['totalCount'] == pair[1]['totalCount'], query=q, filters=f)
                a.check('endpoint-first-page-parity', ids(pair[0]) == ids(pair[1]), query=q, filters=f)
                counts[i] = pair[0]['totalCount']
                if i and 0 in counts:
                    a.check('filter-count-subset', counts[i] <= counts[0], query=q, filters=f)
        if all(i in counts for i in range(6)):
            a.check('type-count-partition', sum(counts[i] for i in range(1, 6)) == counts[0], query=q, counts=counts)

    # Independent Boolean set algebra on bounded, fully enumerated production cohorts.
    A, B, C = '"Rad"', '"ALT"', '"Moles/volume"'
    base = {q: {r['@id'] for r in cohorts[q]} for q in (A, B, C) if cohorts[q] is not None}
    if len(base) == 3:
        x, y, z = base[A], base[B], base[C]
        expressions = [
            (f'{A} OR {B}', x | y), (f'{A} {B}', x | y), (f'{A} AND {B}', x & y),
            (f'{A} NOT {B}', x - y), (f'{A} AND NOT {B}', x - y),
            (f'{A} OR {B} AND {C}', x | (y & z)),
            (f'({A} OR {B}) AND {C}', (x | y) & z),
            (f'{A} AND ({B} OR {C})', x & (y | z)),
            (f'({A} OR {B}) NOT {C}', (x | y) - z),
            (f'{A} AND {A}', x), (f'{A} OR {A}', x), (f'{A} NOT {A}', set()),
            (f'({A} OR {B}) AND NOT ({A} AND {B})', (x | y) - (x & y)),
        ]
        for q, expected in expressions:
            for ep in ['/search', '/search-deep']:
                rows = a.walk(q, endpoint=ep, label=f'boolean/{q}')
                if rows is not None:
                    actual = {r['@id'] for r in rows}
                    a.check('boolean-complete-set', actual == expected, query=q, endpoint=ep,
                            expectedCount=len(expected), actualCount=len(actual), difference=sorted(actual ^ expected)[:10])

    # Follow the server's links with small pages, every supported sort and both modes.
    sorts = ['name', '-name', 'lastUpdatedOnTS', '-lastUpdatedOnTS',
             'createdOnTS', '-createdOnTS', 'foldersFirst,name']
    for sort in sorts:
        for ep, cont in [('/search', False), ('/search-deep', False), ('/search-deep', True)]:
            rows = a.walk('"Rad"', {'sort': sort}, endpoint=ep, continuation=cont, limit=7,
                          label=f'paging/rad/{sort}/{ep}/{cont}')
            a.equal_sets('paging-complete-set/' + sort, cohorts['"Rad"'], rows)
    for q in ['"Dried blood spot"', '"Moles/volume"', 'ALT:', '[pv]*']:
        rows = a.walk(q, endpoint='/search-deep', continuation=True, limit=43, label=f'continuation/{q}')
        a.equal_sets('continuation-complete-set/' + q, cohorts[q], rows)
    rows = a.walk('"Dried blood spot"', {'resource_types': 'field', 'version': 'latest',
                  'publication_status': 'bibo:published', 'modified_after': 0},
                  endpoint='/search-deep', continuation=True, limit=47, label='continuation/combined-filters')
    reference = a.walk('"Dried blood spot"', {'resource_types': 'field', 'version': 'latest',
                      'publication_status': 'bibo:published', 'modified_after': 0}, label='offset/combined-filters')
    a.equal_sets('continuation-combined-filter-set', reference, rows)

    # Invalid grammar and unsupported syntax should fail as client errors in all lanes.
    bad_queries = ['"Rad', 'Rad AND (', 'Rad AND', 'Rad OR', '()', 'Rad)', '(Rad',
                   '""', 'Sex:""', '[pv]', '[pv]=', 'Rad^2', 'Rad~2', '"Rad word"~2',
                   ' ']
    invalid_params = [({'limit': 0}, 400), ({'limit': -1}, 400), ({'limit': 2147483647}, 400),
                      ({'offset': -1}, 400), ({'version': 'no-such-version'}, 400),
                      ({'publication_status': 'no-such-status'}, 400), ({'resource_types': 'no-such-type'}, 400),
                      ({'sort': 'no-such-sort'}, 400),
                      ({'sharing': 'no-such-sharing'}, 400), ({'modified_after': 'yesterday'}, 400),
                      ({'modified_after': 10, 'modified_before': 10}, 400),
                      ({'modified_after': 20, 'modified_before': 10}, 400)]
    for ep, cont in [('/search', {}), ('/search-deep', {}), ('/search-deep', {'continuation': 'start'})]:
        for q in bad_queries:
            a.search(q, {'limit': 1, **cont}, 'invalid-syntax/' + repr(q), ep, 400)
        for params, expected in invalid_params:
            a.search('"Rad"', {'limit': 1, **cont, **params}, 'invalid-parameters', ep, expected)
    a.search('"Rad"', {'continuation': 'start'}, 'continuation/on-shallow', expected=400)
    a.search('"Rad"', {'continuation': 'garbage'}, 'continuation/invalid-token', '/search-deep', 400)
    a.search('"Rad"', {'continuation': 'start', 'offset': 0}, 'continuation/offset-conflict', '/search-deep', 400)
    a.search('"Rad"', {'offset': 2147483647, 'limit': 1}, 'shallow/window-limit', expected=400)
    a.search('"Rad"', {'offset': 2147483647, 'limit': 1}, 'deep/window-limit', '/search-deep', 400)

    # Token binding rejects changed filters. Complete the original walk afterwards.
    start = a.search('"Rad"', {'limit': 7, 'continuation': 'start'}, 'token/start', '/search-deep')
    if start and start.get('continuation'):
        token = start['continuation']
        for mutation in [{'q': '"ALT"'}, {'sort': '-name'}, {'resource_types': 'field'},
                         {'version': 'latest'}, {'publication_status': 'bibo:published'},
                         {'sharing': 'shared-with-everybody'}, {'modified_after': 0}]:
            a.search('"Rad"', {'limit': 7, 'continuation': token, **mutation}, 'token/binding', '/search-deep', 400)
        finish = a.search('"Rad"', {'limit': 100, 'continuation': token}, 'token/change-page-size', '/search-deep')
        if finish:
            a.equal_sets('continuation-page-size-change', cohorts['"Rad"'], start['resources'] + finish['resources'])

    # Stored constraints supply a separate oracle for the known missing Yes/No projection.
    witness = 'https://repo.metadatacenter.org/template-fields/fb2b0070-c10c-4d35-a80b-796f1f2ef8f1'
    field = a.get('/template-fields/' + urllib.parse.quote(witness, safe=''), {}, 'pv/stored-witness')
    if field:
        sets = field.get('_valueConstraints', {}).get('valueSets', [])
        known = any(s.get('uri') == 'https://cadsr.nci.nih.gov/metadata/CADSR-VS/VD3506068v1' for s in sets)
        if known:
            for q in ['4768151 AND [pv]*', '4768151 AND [pv]Yes', '4768151 AND [pv]No',
                      '4768151 AND [pv]=Yes', '4768151 AND [pv]=yes']:
                rows = a.walk(q, label='pv/witness/' + q)
                a.check('stored-possible-value-searchable', rows is not None and witness in {r['@id'] for r in rows},
                        query=q, witness=witness)
    for r in cohorts.get('[pv]*') or []:
        if r['resourceType'] == 'field':
            a.get('/template-fields/' + urllib.parse.quote(r['@id'], safe=''), {}, 'pv/indexed-field')
    for q in ['[pv]"Not available"', '[pv]="Not available"', '[pv]="NOT AVAILABLE"',
              '[pv]No', '[pv]no', '[pv]N*', '[pv]Yes OR [pv]No', '[pv]Yes AND [pv]No',
              'Sex:male', 'Sex:MALE', 'Sex:(Male OR Female)', 'Sex:Male OR Sex:Female',
              'Sex: Male OR Sex: Female', ':"Male"', '*:"Male"',
              '"C++"', '"C%2B%2B"', '"café"', '"CAFÉ"', '"β"', '"α"']:
        for ep in ['/search', '/search-deep']:
            a.search(q, {'limit': 3}, 'extended-syntax/' + q, ep)


def complete_reference_cohorts(reference):
    """A capped, failed or changing walk cannot be an oracle for a complete result set."""
    pages = {}
    for row in reference:
        if row['label'].startswith(('equivalence/', 'cohort/')):
            pages.setdefault(row['parameters']['q'], []).append(row)
    cohorts = {}
    for query, group in pages.items():
        rows = [r for page in group for r in page['resources']]
        unique = {r['@id']: r for r in rows}
        total = group[0]['totalCount']
        if (all(page['status'] == 200 and page['totalCount'] == total for page in group)
                and len(rows) == len(unique) == total):
            cohorts[query] = unique
    return cohorts


def followup(a, reference):
    """Read-only cross-checks of graph selectors, tied pages, and stored constraints."""
    cohorts = complete_reference_cohorts(reference)
    # Every title supplied by search is an independent positive phrase witness.
    witnesses = list(cohorts.get('"Rad"', {}).values())[:8]
    witnesses += list(cohorts.get('"Moles/volume"', {}).values())[:12]
    for r in witnesses:
        quoted = '"' + r['schema:name'].replace('\\', '\\\\').replace('"', '\\"') + '"'
        body = a.search(quoted, {'limit': 100}, 'title-roundtrip')
        a.check('returned-title-phrase-finds-original', body is not None and r['@id'] in ids(body),
                query=quoted, witness=r['@id'])
    # Compare index filtering with the metadata from the complete unfiltered cohort.
    for row in reference:
        if not row['label'].startswith('filters/') or row['path'] != '/search':
            continue
        params = row['parameters']
        q = params['q']
        if q not in cohorts or 'sharing' in params or params.get('version') == 'latest-by-status':
            continue
        source = list(cohorts[q].values())
        expected = {r['@id'] for r in source if not metadata_errors(params, [r])}
        a.check('filter-count-vs-complete-metadata', row['totalCount'] == len(expected),
                query=q, filters=params, expectedCount=len(expected), actualCount=row['totalCount'])
        a.check('filtered-page-vs-complete-metadata', set(ids(row)) <= expected, query=q, filters=params)

    walks = {}
    for row in reference:
        if row['label'].startswith('paging/rad/'):
            walks.setdefault(row['label'].rsplit('/page-', 1)[0], []).append(row)
    for label, pages in walks.items():
        sort = pages[0]['parameters']['sort']
        rows = [r for page in pages for r in page['resources']]
        field = {'name': 'schema:name', 'lastUpdatedOnTS': 'pav:lastUpdatedOn',
                 'createdOnTS': 'pav:createdOn'}.get(sort.lstrip('-'))
        if field:
            keys = [r[field] if field == 'schema:name' else
                    datetime.fromisoformat(r[field].replace('Z', '+00:00')).timestamp() for r in rows]
            a.check('requested-sort-order', keys == sorted(keys, reverse=sort.startswith('-')), label=label)
        else:
            keys = [(r['resourceType'] != 'folder', r['schema:name']) for r in rows]
            a.check('requested-folder-first-order', keys == sorted(keys), label=label)

    # Cut through known equal-name pairs with odd page sizes and repeat the shallow walk.
    for q in ['"Moles/volume"', 'ALT:']:
        source = list(cohorts[q].values()) if q in cohorts else None
        walked = []
        for ep, cont in [('/search', False), ('/search', False), ('/search-deep', True)]:
            rows = a.walk(q, endpoint=ep, continuation=cont, limit=13, label=f'ties/{q}/{ep}/{cont}')
            a.equal_sets('tied-paging-complete-set', source, rows)
            walked.append(rows)
        if all(x is not None for x in walked):
            a.check('repeated-shallow-order', [r['@id'] for r in walked[0]] == [r['@id'] for r in walked[1]], query=q)
            a.check('shallow-deep-tie-order', [r['@id'] for r in walked[0]] == [r['@id'] for r in walked[2]], query=q)

    witness = 'https://repo.metadatacenter.org/template-fields/fb2b0070-c10c-4d35-a80b-796f1f2ef8f1'
    absent_template = 'https://repo.metadatacenter.org/templates/00000000-0000-0000-0000-000000000000'
    for ep in ['/search', '/search-deep']:
        for extra in [{}, {'resource_types': 'template'}, {'publication_status': 'bibo:draft'},
                      {'publication_status': 'bibo:published'}, {'modified_before': 1},
                      {'offset': 1}, {'q': 'CedarAuditDeliberatelyAbsent20261019'}]:
            params = {'id': witness, 'limit': 3, 'sort': 'name', **extra}
            body = a.get(ep, params, 'graph/id-selector', expected=(200, 400))
            if body and extra.get('offset') == 1:
                a.check('id-lookup-offset', not ids(body) and body['totalCount'] == 1, endpoint=ep)
            if body and 'q' in extra:
                a.check('documented-id-selector-precedence', ids(body) == [witness], endpoint=ep)
        for extra in [{}, {'q': 'Sex:Male'}, {'q': '*'}]:
            body = a.get(ep, {'is_based_on': absent_template, 'limit': 3, 'sort': 'name', **extra},
                         'graph/template-selector', expected=(200, 400))
            if body:
                a.check('template-and-query-intersection-or-refusal', body['totalCount'] == 0,
                        endpoint=ep, parameters=extra, totalCount=body['totalCount'])
        # A graph listing must not quietly accept an unusable continuation token.
        body = a.get(ep, {'id': witness, 'continuation': 'garbage', 'limit': 3},
                     'graph/invalid-continuation', expected=400)
        a.get(ep, {'q': '"Rad"', 'sort': '', 'limit': 3}, 'parameters/empty-sort', expected=(200, 400))

    # Measure a selected cohort's missing projections, without downloading full documents to disk.
    sample = a.search('Indicator', {'resource_types': 'field', 'limit': 40}, 'pv/coverage-sample')
    indexed = set(cohorts['[pv]*']) if '[pv]*' in cohorts else None
    eligible, missing = [], []
    for row in (sample or {}).get('resources', []):
        field = a.get('/template-fields/' + urllib.parse.quote(row['@id'], safe=''), {}, 'pv/coverage-field')
        sets = (field or {}).get('_valueConstraints', {}).get('valueSets', [])
        if any(s.get('uri', '').startswith('https://cadsr.nci.nih.gov/metadata/CADSR-VS/')
               and s.get('numTerms', 0) > 0 for s in sets):
            eligible.append(row['@id'])
            if indexed is not None and row['@id'] not in indexed:
                missing.append(row['@id'])
    if indexed is None:
        a.skipped.append({'label': 'cadsr-projection-coverage-sample', 'reason': 'incomplete possible-value cohort'})
    else:
        a.check('cadsr-projection-coverage-sample', not missing, sampled=len((sample or {}).get('resources', [])),
                eligible=len(eligible), missing=len(missing), missingIds=missing)

    # These are literal square brackets, deliberately escaped by the server, not range syntax.
    for q in ['[Rad TO Ray]', 'Sex:[A TO Z]']:
        for ep in ['/search', '/search-deep']:
            a.search(q, {'limit': 1}, 'literal-brackets', ep)
    # Use positive indexed labels where available; zero-vs-zero is not evidence of PV case folding.
    for q in ['[pv]White', '[pv]white', '[pv]=White', '[pv]=white', '[pv]=WHITE',
              '[pv]"Stage II"', '[pv]"STAGE II"', '[pv]=II', '[pv]=ii']:
        a.search(q, {'limit': 10}, 'pv/positive-label/' + q)

    # Empty optional parameters mean omission in the HTTP layer, not malformed syntax.
    for ep in ['/search', '/search-deep']:
        empty = a.get(ep, {'q': '', 'limit': 1, 'sort': 'name'}, 'parameters/empty-query')
        omitted = a.get(ep, {'limit': 1, 'sort': 'name'}, 'parameters/omitted-query')
        if empty and omitted:
            a.check('empty-query-means-omitted', empty['totalCount'] == omitted['totalCount'] and
                    ids(empty) == ids(omitted))
        a.search('"Rad"', {'resource_types': '', 'limit': 1}, 'parameters/empty-types', ep)
        for q in ['"C%2B%2B"', '"Rad%22"', '"{Rad}"', '"Rad dose"', '"100%20"', '"Rad%2522"']:
            a.search(q, {'limit': 1}, 'encoding/literal-query', ep)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--server', type=origin, default='https://resource.metadatacenter.org')
    p.add_argument('--api-key-file', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--delay', type=float, default=.25)
    args = p.parse_args()
    if args.delay < .1:
        p.error('delay must be at least 0.1 seconds')
    if args.out.exists() or args.out.with_suffix('.jsonl').exists():
        p.error('output already exists; use a fresh evidence path')
    key = args.api_key_file.expanduser().read_text().strip()
    if not key or '\n' in key or '\r' in key:
        p.error('key must be one nonempty line')
    a = Audit(args.server, key, args.out, args.delay)
    try:
        run(a)
        followup(a, list(a.records))
    except Exception as error:
        a.save(False, type(error).__name__)
        return 2
    a.save(True)
    return int(any(not c['pass'] for c in a.checks))


if __name__ == '__main__':
    raise SystemExit(main())
