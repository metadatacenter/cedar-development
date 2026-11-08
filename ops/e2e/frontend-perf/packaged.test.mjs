import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apps,hash,inventory} from './lab.mjs';
import {preparePackaged} from './packaged.mjs';

test('published deployment inputs preserve bytes and standalone bundles, rejecting tampering and missing surfaces',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cedar-published-perf-'));
  try {
    const manifest={schemaVersion:1,kind:'ephemeral-docker-train',domain:'metadatacenter.orgx',train:'2.9.33-dev.20261107.2016',images:[],applications:{},components:{}};
    for(const name of Object.keys(apps)) {
      const dir=join(root,name);await mkdir(dir);
      await writeFile(join(dir,'index.html'),'<h1>'+name+'</h1>');
      if(['openview','monitoring','bridging'].includes(name))
        await writeFile(join(dir,'main.js'),'var env={cedarDomain:"metadatacenter.org"};var website="https://metadatacenter.org";');
      if(name==='designer') {
        await mkdir(join(dir,'components'));
        const script='/* shared editors */',delivery={file:'cedar-editors.js',sha256:hash(script)};
        await writeFile(join(dir,'components/cedar-editors.js'),script);
        await writeFile(join(dir,'components/manifest.json'),JSON.stringify(Object.fromEntries(['cedar-embeddable-editor','cedar-embeddable-term-picker','cedar-embeddable-designer'].map(repo=>[repo,{delivery}]))));
      }
      manifest.applications[name]={directory:name,files:(await inventory(dir)).files,source:{revision:'a'.repeat(40)}};
    }
    for(const name of ['cee','ced','cetp']) {
      const text='/* '+name+' standalone */';await writeFile(join(root,name+'.js'),text);
      manifest.components[name]={file:name+'.js',sha256:hash(text),source:{version:'fixed'}};
    }
    const path=join(root,'manifest.json');await writeFile(path,JSON.stringify(manifest));
    const prepared=await preparePackaged(path,join(root,'valid'),'metadatacenter.orgx');
    assert.equal(Object.keys(prepared.roots).length,7);
    assert.equal(prepared.evidence.adjustments.length,3);
    assert.equal(await readFile(join(root,'valid/openview/main.js'),'utf8'),'var env={cedarDomain:"metadatacenter.orgx"};var website="https://metadatacenter.org";');
    assert.ok((await readFile(join(root,'openview/main.js'),'utf8')).includes('cedarDomain:"metadatacenter.org"'));
    assert.equal(await readFile(join(prepared.componentRoot,'ced.js'),'utf8'),'/* ced standalone */');
    assert.equal(prepared.evidence.deployment.train,manifest.train);
    manifest.kind='ephemeral-docker-acceptance';
    manifest.bootstrap={compatibilityMounts:false,emptyVolumes:true};
    await writeFile(path,JSON.stringify(manifest));
    await assert.rejects(preparePackaged(path,join(root,'wrong-domain'),'metadatacenter.orgx'),/did not configure/);
    for (const name of ['openview','monitoring','bridging']) {
      const file=join(root,name,'main.js');
      await writeFile(file,(await readFile(file,'utf8')).replace('cedarDomain:"metadatacenter.org"','cedarDomain:"metadatacenter.orgx"'));
      const {rename}=await import('node:fs/promises'); await rename(file,join(root,name,'main-123.js'));
      manifest.applications[name].files=(await inventory(join(root,name))).files;
    }
    await writeFile(path,JSON.stringify(manifest));
    const direct=await preparePackaged(path,join(root,'direct'),'metadatacenter.orgx');
    assert.deepEqual(Object.keys(direct.roots),['performance.metadatacenter.orgx']);
    assert.equal(direct.evidence.deployment.mode,'direct');
    assert.deepEqual(direct.evidence.adjustments,[]);
    assert.equal(await readFile(join(direct.componentRoot,'cee.js'),'utf8'),'/* cee standalone */');
    manifest.bootstrap.compatibilityMounts=true; await writeFile(path,JSON.stringify(manifest));
    await assert.rejects(preparePackaged(path,join(root,'overlay'),'metadatacenter.orgx'));
    manifest.bootstrap.compatibilityMounts=false; await writeFile(path,JSON.stringify(manifest));
    await writeFile(join(root,'cee.js'),'changed');
    await assert.rejects(preparePackaged(path,join(root,'tampered'),'metadatacenter.orgx'),/standalone bytes changed/);
    delete manifest.applications.monitoring;await writeFile(path,JSON.stringify(manifest));
    await assert.rejects(preparePackaged(path,join(root,'missing'),'metadatacenter.orgx'),/Missing published monitoring/);
    const abort=new AbortController();abort.abort();
    await assert.rejects(preparePackaged(path,join(root,'aborted'),'metadatacenter.orgx',{signal:abort.signal}),{name:'AbortError'});
  } finally {await rm(root,{recursive:true,force:true});}
});
