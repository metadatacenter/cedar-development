#!/usr/bin/env python3
"""Plan/apply schema-checked instance value repairs with backups, ETags and readback."""
import argparse
import json
import pathlib
import sys
import collections
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import cedar_stored_json_matrix_audit as matrix
from cedar_artifact_repair import RepairClient
from instance_values import repair

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=pathlib.Path,required=True)
    parser.add_argument('--categories',type=pathlib.Path,required=True)
    parser.add_argument('--classpath',type=pathlib.Path,required=True)
    parser.add_argument('--java',required=True)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args();root=args.directory;root.mkdir(parents=True,exist_ok=True)
    categories=json.loads(args.categories.read_text()); ids=set()
    for name in ['Mixed @id and @value fields read differently','Malformed or empty URI (first Java rejection)','Malformed numeric literal or nested field array']:
        ids.update(categories[name]['ids'])
    if args.apply:
        ids = {r['id'] for r in json.loads((root/'plan.json').read_text())['artifacts'] if r['status']=='ready'}
    client=RepairClient('https://resource.metadatacenter.org',(pathlib.Path.home()/'.cedar-admin-key').read_text().strip(),timeout=60,retries=3)
    bridge=matrix.Bridge('validator',[args.java,'-cp',args.classpath.read_text().strip(),str(matrix.OPS/'cedar_validation_bridge.java')])
    reader=matrix.Bridge('java',[args.java,'-cp',args.classpath.read_text().strip(),str(matrix.OPS/'cedar_yaml_convert_bridge.java')])
    reports=[]
    try:
        for i,identifier in enumerate(sorted(ids),1):
            folder=root/identifier.rsplit('/',1)[-1];folder.mkdir(exist_ok=True)
            record={'id':identifier}
            def save(name,value): (folder/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
            try:
                path=matrix.rest.typed_artifact_path(matrix.rest.ArtifactRef('instance',identifier,''))
                source,etag=client.get_with_etag(path)
                tid=source['schema:isBasedOn'];tp=matrix.rest.typed_artifact_path(matrix.rest.ArtifactRef('template',tid,''));template,tetag=client.get_with_etag(tp)
                if args.apply:
                    planned=json.loads((folder/'before.json').read_text())
                    if source!=planned: raise ValueError('Stored source changed since plan; re-plan before applying')
                    if template!=json.loads((folder/'template.json').read_text()):raise ValueError('Template changed since plan')
                else:
                    save('before.json',source);save('template.json',template);save('etags.json',{'instance':etag,'template':tetag})
                candidate,changes,unresolved=repair(source,template);save('proposed.json',candidate)
                record.update(changes=changes,unresolved=unresolved)
                bridge.ask({'op':'cache-template','id':tid,'template':template})
                validation={name:bridge.ask({'op':'validate','kind':'instance','templateId':tid,'artifact':body}) for name,body in [('before',source),('after',candidate)]};save('validation.json',validation)
                if not changes:record['status']='needs-review'
                elif validation['after']['status']!='valid':record['status']='blocked-invalid'
                else:
                    accepted=reader.ask({'op':'render','kind':'instance','json':candidate,'compact':False})
                    save('reader-check.json',{k:v for k,v in accepted.items() if k!='yaml'})
                    if accepted['status']!='ok':record['status']='blocked-reader'
                    elif not args.apply:record['status']='ready'
                    else:
                        # Both GETs and full validation precede the conditional verbatim write.
                        client.put_verbatim(path,candidate,etag)
                        stored,_=client.get_with_etag(path);save('readback.json',stored)
                        if stored!=candidate:raise ValueError('Readback differs from proposed document')
                        checked=bridge.ask({'op':'validate','kind':'instance','templateId':tid,'artifact':stored});save('readback-validation.json',checked)
                        if checked['status']!='valid':raise ValueError('Readback does not validate')
                        record['status']='repaired'
            except Exception as e:record.update(status='error',error=str(e))
            save('apply-result.json' if args.apply else 'plan-result.json',record);reports.append(record)
            print(i,len(ids),record['status'],identifier.rsplit('/',1)[-1],flush=True)
    finally:
        bridge.close();reader.close()
    result={'mode':'apply' if args.apply else 'plan','counts':dict(collections.Counter(r['status'] for r in reports)),'artifacts':reports}
    (root/('apply.json' if args.apply else 'plan.json')).write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n');print(result['counts'],flush=True)
if __name__=='__main__':main()
