"""Prepare an ephemeral GitHub-hosted CEDAR installation, never a workstation."""
import argparse
import hashlib
import io
import tarfile
import urllib.parse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import urllib.request

TRAIN = '2.9.33-dev.20261107.2016'


def guard(home):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('This initializer is restricted to an ephemeral GitHub-hosted runner')
    workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    if home.resolve() != workspace / 'CEDAR':
        raise ValueError('CI installation must be GITHUB_WORKSPACE/CEDAR')


def initialize(home):
    guard(home)
    for name in ('set-env-internal.sh', 'set-env-external.sh'):
        if (home/name).exists():
            raise ValueError('Refusing to replace existing installation settings')
    hidden = {}
    for name in ('set-env-internal.sh', 'set-env-external.sh'):
        text = (home/'cedar-development/bin/templates'/name).read_text()
        if name == 'set-env-internal.sh':
            for key in re.findall(r'^export (CEDAR_[A-Z_]*(?:PASSWORD|API_KEY|SALT_API_KEY))=', text, re.M):
                # The seeded CEDAR admin password is an import contract; ordinary CI users are
                # the realm's fixture users. Every datastore/admin/service credential is isolated.
                if key == 'CEDAR_ADMIN_USER_PASSWORD':
                    continue
                value = secrets.token_hex(32)
                hidden[key] = value
                print('::add-mask::'+value, flush=True)
                text = re.sub(r'^export '+key+r'=.*$', f'export {key}="{value}"', text, flags=re.M)
        else:
            text = text.replace('export CEDAR_DATACITE_ENABLED="true"', 'export CEDAR_DATACITE_ENABLED="false"')
        target = home/name
        target.write_text(text); target.chmod(0o600)
    state = home/'.cedar'
    state.mkdir(exist_ok=True)
    (state/'ci-secrets.json').write_text(json.dumps(hidden)); (state/'ci-secrets.json').chmod(0o600)
    # Small text fixtures need no production terminology corpus. Resource ceilings are explicit
    # benchmark metadata, not production configuration changes.
    deploy = home/'cedar-docker-deploy'
    micro = (deploy/'cedar-microservices/docker-compose.yml').read_text()
    services = re.findall(r'^  (server-[a-z]+):$', micro, re.M)
    override = {'services': {name: {'mem_limit':'768m','environment':{'JAVA_TOOL_OPTIONS':'-Xms64m -Xmx512m -XX:ActiveProcessorCount=2'}} for name in services}}
    (deploy/'cedar-microservices/docker-compose.override.yml').write_text(json.dumps(override))
    infra = {'services': {
        'opensearch': {'mem_limit':'1536m','environment':{'OPENSEARCH_JAVA_OPTS':'-Xms512m -Xmx512m'}},
        'neo4j': {'mem_limit':'1536m','environment':{'NEO4J_dbms_memory_heap_initial__size':'256m','NEO4J_dbms_memory_heap_max__size':'512m','NEO4J_dbms_memory_pagecache_size':'256m'}},
        'keycloak': {'mem_limit':'1024m','environment':{'JAVA_OPTS_APPEND':'-Xms64m -Xmx512m -XX:ActiveProcessorCount=2'}}}}
    (deploy/'cedar-infrastructure/docker-compose.override.yml').write_text(json.dumps(infra))
    (state/'ci-resource-limits.json').write_text(json.dumps({'microservices':override,'infrastructure':infra}))
    # Nginx's read-only mounts must exist. These fixed-field measurements require no shared assets
    # or ontology index, and do not exercise external terminology integrations.
    for name in ('cedar-shared-data', 'cedar-swagger-ui', 'terminology-store'):
        (home/name).mkdir(exist_ok=True)


def read_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def snapshot_assets(home, output):
    guard(home)
    output.mkdir(parents=True, exist_ok=False)
    base='https://raw.githubusercontent.com/metadatacenter/cedar-development/build-trains/'
    completion=read_json(base+'docker/completed/'+TRAIN+'.json')
    packages=read_json(base+'npm/completed/'+TRAIN+'.json')
    images={entry['image']:entry for entry in completion['images']}
    manifest={'schemaVersion':1,'kind':'ephemeral-docker-train','train':TRAIN,'domain':'metadatacenter.orgx',
              'images':completion['images'],'applications':{},'components':{},
              'tooling':{repo:subprocess.check_output(['git','rev-parse','HEAD'],cwd=home/repo,text=True).strip() for repo in ('cedar-cli','cedar-docker-build','cedar-docker-deploy')},
              'resourceLimits':json.loads((home/'.cedar/ci-resource-limits.json').read_text())}
    applications={'workspace':('workspace','cedar-workspace/app'), 'designer':('template-designer','cedar-template-designer/app'),
                  'openview':('openview','cedar-openview-dist'), 'monitoring':('monitoring','cedar-monitoring-dist'),
                  'bridging':('bridging','cedar-bridging-dist'), 'content':('content','cedar-content-distribution')}
    for name,(container,root) in applications.items():
        image=images['cedar-frontend-'+container]
        target=output/name;target.mkdir()
        subprocess.run(['docker','cp','frontend-'+container+':/srv/cedar/'+root+'/.',str(target)],check=True)
        files={}
        for path in sorted(target.rglob('*')):
            if path.is_symlink(): raise ValueError('Unexpected symlink in published frontend')
            if path.is_file():
                data=path.read_bytes(); files[path.relative_to(target).as_posix()]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
        revision=subprocess.check_output(['docker','exec','frontend-'+container,'cat','/usr/local/share/cedar-source-commit'],text=True).strip()
        if not re.fullmatch('[0-9a-f]{40}',revision): raise ValueError('Missing frontend source identity')
        manifest['applications'][name]={'directory':name,'files':files,'source':{'image':image['reference'],'digest':image['digest'],'revision':revision,'imageSourceRevision':image['sourceRevision']}}
    wanted={'cee':'cedar-embeddable-editor','ced':'cedar-embeddable-designer','cetp':'cedar-embeddable-term-picker'}
    for short,repo in wanted.items():
        matches=[entry for entry in packages['packages'] if entry['repository']==repo]
        if len(matches)!=1: raise ValueError('Missing immutable standalone package: '+repo)
        entry=matches[0]
        url=entry['tarball']
        if not url.startswith('https://nexus.bmir.stanford.edu/repository/npm-cedar/'):
            raise ValueError('Unexpected package registry')
        with urllib.request.urlopen(url,timeout=120) as response: data=response.read()
        if hashlib.sha256(data).hexdigest()!=entry['tarballSha256']:
            raise ValueError('Immutable package digest mismatch: '+repo)
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            member=archive.getmember('package/'+repo+'.js')
            if not member.isfile() or member.size>20*1024*1024: raise ValueError('Invalid standalone bundle')
            bundle=archive.extractfile(member).read()
        (output/(short+'.js')).write_bytes(bundle)
        manifest['components'][short]={'file':short+'.js','sha256':hashlib.sha256(bundle).hexdigest(),'source':entry}
    (output/'manifest.json').write_text(json.dumps(manifest,sort_keys=True)+'\n')


def monitor_account(home):
    guard(home)
    hidden_path=home/'.cedar/ci-secrets.json'; hidden=json.loads(hidden_path.read_text())
    def request(path, *, token=None, data=None, form=None):
        headers={}
        if token: headers['Authorization']='Bearer '+token
        body=None
        if form is not None: body=urllib.parse.urlencode(form).encode();headers['Content-Type']='application/x-www-form-urlencoded'
        if data is not None: body=json.dumps(data).encode();headers['Content-Type']='application/json'
        req=urllib.request.Request('http://127.0.0.1:8080'+path,data=body,headers=headers)
        with urllib.request.urlopen(req,timeout=30) as response:
            raw=response.read()
            return json.loads(raw) if raw else None
    token=request('/realms/master/protocol/openid-connect/token',form={'grant_type':'password','client_id':'admin-cli',
        'username':'administrator','password':hidden['CEDAR_KEYCLOAK_ADMIN_PASSWORD']})['access_token']
    username='frontend-perf-monitor@test.com';password=secrets.token_hex(24)
    print('::add-mask::'+password,flush=True)
    request('/admin/realms/CEDAR/users',token=token,data={'username':username,'email':username,'emailVerified':True,'enabled':True,
        'firstName':'Performance','lastName':'Monitor','credentials':[{'type':'password','value':password,'temporary':False}]})
    users=request('/admin/realms/CEDAR/users?username='+urllib.parse.quote(username)+'&exact=true',token=token)
    if len(users)!=1: raise ValueError('Dedicated monitor identity is ambiguous')
    roles=[request('/admin/realms/CEDAR/roles/'+role,token=token) for role in ('normal','monitorViewer')]
    request('/admin/realms/CEDAR/users/'+users[0]['id']+'/role-mappings/realm',token=token,data=roles)
    hidden['CEDAR_PERF_MONITOR_PASSWORD']=password;hidden_path.write_text(json.dumps(hidden))
    with open(os.environ['GITHUB_ENV'],'a') as stream:
        stream.write('CEDAR_PERF_MONITOR_LOGIN='+username+'\nCEDAR_PERF_MONITOR_PASSWORD='+password+'\n')


def diagnostics(home, output):
    guard(home)
    output.mkdir(parents=True, exist_ok=True)
    hidden_path = home/'.cedar/ci-secrets.json'
    hidden = list(json.loads(hidden_path.read_text()).values()) if hidden_path.exists() else []
    artifact_key = home/'.cedar/secrets/artifact-service.sh'
    if artifact_key.exists():
        hidden += re.findall(r'=[\"\']?([A-Za-z0-9_-]{20,})', artifact_key.read_text())
    def sanitize(text):
        for value in hidden:
            text = text.replace(value, '[CI secret]')
        text = re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9._-]+', r'\1[redacted]', text)
        return text
    listing = subprocess.run(['docker','ps','-a','--format','{{.Names}}'], capture_output=True,text=True,check=True)
    for name in listing.stdout.splitlines():
        if not re.fullmatch(r'(infra|server|frontend)-[a-z-]+',name):
            continue
        status = subprocess.run(['docker','inspect','--format','{{json .State}}',name],capture_output=True,text=True)
        logs = subprocess.run(['docker','logs','--tail','100',name],capture_output=True,text=True)
        (output/(name+'.txt')).write_text(sanitize(status.stdout+'\n'+logs.stdout+logs.stderr))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['initialize','assets','monitor-account','diagnostics'])
    parser.add_argument('--output',type=Path)
    args=parser.parse_args(); home=Path(os.environ['CEDAR_HOME'])
    if args.action=='initialize': initialize(home)
    elif args.action=='assets': snapshot_assets(home,args.output)
    elif args.action=='monitor-account': monitor_account(home)
    else: diagnostics(home,args.output)


if __name__=='__main__': main()
