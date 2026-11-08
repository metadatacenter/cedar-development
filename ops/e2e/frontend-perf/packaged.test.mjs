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
    assert.equal(await readFile(join(prepared.componentRoot,'ced.js'),'utf8'),'/* ced standalone */');
    assert.equal(prepared.evidence.deployment.train,manifest.train);
    await writeFile(join(root,'cee.js'),'changed');
    await assert.rejects(preparePackaged(path,join(root,'tampered'),'metadatacenter.orgx'),/standalone bytes changed/);
    delete manifest.applications.monitoring;await writeFile(path,JSON.stringify(manifest));
    await assert.rejects(preparePackaged(path,join(root,'missing'),'metadatacenter.orgx'),/Missing published monitoring/);
    const abort=new AbortController();abort.abort();
    await assert.rejects(preparePackaged(path,join(root,'aborted'),'metadatacenter.orgx',{signal:abort.signal}),{name:'AbortError'});
  } finally {await rm(root,{recursive:true,force:true});}
});
