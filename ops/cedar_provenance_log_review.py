#!/usr/bin/env python3
"""Read-only correlation of provenance anomalies with retained server write logs.

This produces investigation evidence, never an apply plan. WARN identifiers use
CedarResourceId.hashCode (Objects.hash(id)); exact request URIs provide an
independent identity check. Neither a name nor an Admin attribution alone is proof.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import parse_qs, unquote, urlsplit

CLASSES = {'template': 'CedarTemplateId', 'element': 'CedarElementId',
           'field': 'CedarFieldId', 'instance': 'CedarTemplateInstanceId'}
WARN = re.compile(r'^WARN\s+\[([^]]+)\].*?: Verbatim write: user (\S+) replaced '
    r'org\.metadatacenter\.id\.(\w+)@([0-9a-f]+) \(\'(.*)\'\), owned by (.*?), stating oslc:modifiedBy (\S+)\s*$')
ACCESS = re.compile(r'^\S+ \S+ \S+ \[([^]]+)\] "(\w+) (\S+) HTTP/[^\"]+" (\d{3}) ')


def java_id_hash(identifier):
    data = identifier.encode('utf-16-be'); value = 0
    for pos in range(0, len(data), 2): value = (31*value + int.from_bytes(data[pos:pos+2], 'big')) & 0xffffffff
    return format((value+31) & 0xffffffff, 'x')


def warning(line):
    match = WARN.match(line)
    if not match: return None
    stamp, actor, kind, code, name, owner, modifier = match.groups()
    epoch = datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S,%f').replace(tzinfo=timezone.utc).timestamp()
    return {'epoch':epoch,'actor':actor,'class':kind,'hash':code,'name':name,'owner':owner,'statedModifier':modifier}


def access(line):
    match = ACCESS.match(line)
    if not match: return None
    stamp, method, target, status = match.groups()
    if method not in ('PUT','PATCH','POST','DELETE'): return None
    uri = urlsplit(target); parts = uri.path.split('/',2)
    if len(parts)!=3 or parts[1] not in ('templates','template-elements','template-fields','template-instances'):
        return None
    identifier = unquote(parts[2])
    if not identifier.startswith(('http://','https://')): identifier = unquote(identifier)
    epoch = datetime.strptime(stamp,'%d/%b/%Y:%H:%M:%S %z').timestamp()
    return {'epoch':epoch,'method':method,'id':identifier,'status':int(status),
        'verbatim':parse_qs(uri.query).get('verbatim') == ['true']}


def correlate(row, warnings, requests, unique_hash, actor, tolerance=3):
    stamp = row['graph']['lastUpdatedOnTS']
    near_requests = [r for r in requests if abs(r['epoch']-stamp)<=tolerance]
    successful = [r for r in near_requests if r['method']=='PUT' and r['verbatim'] and 200<=r['status']<300]
    matching_warnings = [w for w in warnings if abs(w['epoch']-stamp)<=tolerance and w['actor']==actor
        and w['statedModifier']==row['document'].get('oslc:modifiedBy')]
    if row['graph'].get('oslc_modifiedBy') != actor: category='not-currently-admin'
    elif successful and matching_warnings and unique_hash: category='corroborated-verbatim-write'
    elif successful: category='verbatim-access-only'
    elif matching_warnings and unique_hash: category='verbatim-warning-only'
    else: category='no-close-verbatim-match'
    return {'id':row['id'],'kind':row['kind'],'category':category,
        'previousClassification':row.get('previousClassification'), 'graphEpoch':stamp,
        'uniqueHashAmongGraphArtifacts':unique_hash,'matchedWarnings':matching_warnings,
        'nearRequests':near_requests,'successfulVerbatimRequests':len(successful),
        'allArtifactRequestCount':len(requests),'allArtifactWarningCount':len(warnings)}


def inspect(stores, source, log_dir, out, actor):
    from cedar_provenance_audit import atomic, now
    rows = [json.loads(line) for line in source.open()]
    targets = {r['id']:r for r in rows}
    if len(targets)!=len(rows): raise ValueError('duplicate input identifiers')
    out.mkdir(parents=True,exist_ok=False)
    ids_by_hash = defaultdict(list)
    for identifier, kind in stores.query('MATCH (a:Artifact) RETURN a._id, a.resourceType'):
        if isinstance(identifier,str) and kind in CLASSES:
            ids_by_hash[(CLASSES[kind],java_id_hash(identifier))].append(identifier)
    target_hashes = {(CLASSES[r['kind']],java_id_hash(r['id'])) for r in rows}
    warns=defaultdict(list); requests=defaultdict(list); files=[]; totals=Counter()
    # Read once, in file order, without downloading multi-gigabyte application logs.
    for path in sorted(log_dir.glob('dropwizard*.log'))+sorted(log_dir.glob('access*.log')):
        stat=path.stat(); before={'file':str(path),'size':stat.st_size,'mtimeNs':stat.st_mtime_ns}
        is_access=path.name.startswith('access'); count=0
        with path.open('rb') as stream:
            for line_number, raw in enumerate(stream,1):
                if is_access:
                    if not any(b'"'+m+b' ' in raw for m in (b'PUT',b'PATCH',b'POST',b'DELETE')): continue
                    item=access(raw.decode(errors='replace'))
                    if item is None or item['id'] not in targets: continue
                    bucket=requests[item['id']]
                else:
                    if b'Verbatim write:' not in raw: continue
                    totals['verbatimWarningLines']+=1
                    item=warning(raw.decode(errors='replace'))
                    if item is None:
                        totals['unparsedWarningLines']+=1;continue
                    key=(item['class'],item['hash'])
                    if key not in target_hashes:continue
                    bucket=warns[key]
                item.update(file=str(path),line=line_number,lineSha256=hashlib.sha256(raw).hexdigest())
                bucket.append(item);count+=1
        after=path.stat();before.update(matchedLines=count,changedDuringRead=(stat.st_size,stat.st_mtime_ns)!=(after.st_size,after.st_mtime_ns))
        files.append(before);print(path.name,'matched',count,flush=True)
    counts=Counter(); groups=defaultdict(Counter)
    with (out/'correlations.jsonl').open('x') as output, (out/'retained-events.jsonl').open('x') as events:
        for row in rows:
            key=(CLASSES[row['kind']],java_id_hash(row['id']))
            result=correlate(row,warns[key],requests[row['id']],ids_by_hash[key]==[row['id']],actor)
            counts[result['category']]+=1;groups[row['previousClassification']][result['category']]+=1
            output.write(json.dumps(result)+'\n')
            events.write(json.dumps({'id':row['id'],'warnings':warns[key],'requests':requests[row['id']]})+'\n')
    summary={'readOnly':True,'completedAt':now(),'checked':len(rows),'categories':counts,'byPreviousClassification':groups,
        'parsing':totals,'files':files,'toleranceSeconds':3,
        'limitations':['Correlation is investigation evidence, not execution authorization or a repair plan.',
            'Warnings state submitted modifier but not the old modification date; preserved document/preimage supplies that date.',
            'Live graph identifiers were used for hash collision checks; exact access URIs are also required for corroboration.',
            'Fresh artifact/document checks and review of conflicting writes are required before any future repair.']}
    atomic(out/'summary.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k!='files'},indent=2))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--observations',type=Path,required=True);p.add_argument('--logs',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True);p.add_argument('--repair-user',required=True)
    a=p.parse_args();os.umask(0o027)
    from cedar_provenance_store import Stores
    inspect(Stores(),a.observations,a.logs,a.out,a.repair_user)


if __name__=='__main__':main()
