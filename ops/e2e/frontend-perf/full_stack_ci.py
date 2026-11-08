"""Prepare an ephemeral GitHub-hosted CEDAR installation, never a workstation."""
import argparse
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


def diagnostics(home, output):
    guard(home)
    output.mkdir(parents=True, exist_ok=True)
    hidden_path = home/'.cedar/ci-secrets.json'
    hidden = list(json.loads(hidden_path.read_text()).values()) if hidden_path.exists() else []
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
    parser.add_argument('action',choices=['initialize','diagnostics'])
    parser.add_argument('--output',type=Path)
    args=parser.parse_args(); home=Path(os.environ['CEDAR_HOME'])
    if args.action=='initialize': initialize(home)
    else: diagnostics(home,args.output)


if __name__=='__main__': main()
