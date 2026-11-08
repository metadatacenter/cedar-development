import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {apiFixtures, designerApi, designerIds, prepareDesigner} from './designer-fixture.mjs';
import {hash} from './lab.mjs';
import {loadingFailures} from './paired.mjs';

test('fixed Designer API supplies real field counts and refuses writes and unknown reads', async () => {
  const api=designerApi('test.invalid'), bodies=apiFixtures('test.invalid');
  assert.equal(bodies['/api/templates/'+designerIds.large]._ui.order.length,100);
  assert.equal(bodies['/api/templates/'+designerIds.small]._ui.order.length,5);
  const call=async (url,method='GET')=>{
    const response={writeHead(status,headers){this.status=status;this.headers=headers;return this;},end(body){this.body=body;}};
    assert.equal(await api({url,method,headers:{host:'resource.test.invalid'}},response),true);
    return response;
  };
  assert.equal((await call('/api/unknown')).status,404);
  assert.equal((await call('/api/templates/'+designerIds.small,'PUT')).status,405);
  const loaded=await call('/api/templates/'+designerIds.small);
  assert.equal(loaded.headers['Cache-Control'],'no-store');
  assert.equal(loaded.headers.ETag,'"performance-fixture"');
  assert.equal(JSON.parse(loaded.body)['@id'],'https://repo.test.invalid/templates/'+designerIds.small);
});

test('Designer fixture keeps UI assets unchanged and rejects mismatched shared bundle hashes', async () => {
  const root=await mkdtemp(join(tmpdir(),'cedar-designer-perf-'));
  try {
    const source=join(root,'source'), output=join(root,'output');
    const put=async (name,body)=>{const p=join(source,name);await mkdir(dirname(p),{recursive:true});await writeFile(p,body);};
    const delivery={file:'cedar-editors.js',sha256:hash('shared')};
    await put('components/cedar-editors.js','shared');
    await put('components/manifest.json',JSON.stringify(Object.fromEntries(['cedar-embeddable-editor','cedar-embeddable-term-picker','cedar-embeddable-designer'].map(n=>[n,{delivery}]))));
    await put('host/host.mjs','host'); await put('host/host.css','css');
    await put('host/manifest.json',JSON.stringify({script:{file:'host/host.mjs',sha256:hash('host')},style:{file:'host/host.css',sha256:hash('css')}}));
    await put('index.html','original markup');
    await put('scripts/handlers/KeycloakUserHandler.js','original handler;');
    await mkdir(output);
    const result=await prepareDesigner(source,output,'test.invalid');
    assert.equal(await readFile(join(output,'designer/index.html'),'utf8'),'original markup');
    assert.equal(await readFile(join(output,'designer/host/host.mjs'),'utf8'),'host');
    assert.equal(await readFile(join(source,'scripts/handlers/KeycloakUserHandler.js'),'utf8'),'original handler;');
    assert.ok((await readFile(join(output,'designer/scripts/handlers/KeycloakUserHandler.js'),'utf8')).startsWith('original handler;'));
    assert.ok(result.evidence.apiSha256);
    await put('components/cedar-editors.js','corrupted');
    await assert.rejects(prepareDesigner(source,join(root,'bad'),'test.invalid'),/verified shared Designer/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('two fixture origins are allowed but eager RDF/validator code fails loading checks',()=>{
  const network={networkFailures:[],pendingRequests:0,resources:[{url:'https://designer.test/components/cedar-rdf-n3-hash.js',complete:true}]};
  assert.deepEqual(loadingFailures(network,['https://designer.test','https://performance.test']),[]);
  assert.ok(loadingFailures(network,['https://designer.test'],[/\/cedar-rdf-/]).some(e=>e.includes('Deferred code')));
});
