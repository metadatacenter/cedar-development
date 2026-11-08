// Verify and freeze published assets from an isolated deployment, without a source build/reactor.
import assert from 'node:assert/strict';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {apps, hash, inventory, designerDelivery} from './lab.mjs';

export async function preparePackaged(manifestPath, directory, domain, {signal}={}) {
  signal?.throwIfAborted();
  const raw=await readFile(manifestPath), manifest=JSON.parse(raw);
  assert.equal(manifest.schemaVersion,1); assert.equal(manifest.domain,domain);
  assert.ok(['ephemeral-docker-train','ephemeral-docker-acceptance'].includes(manifest.kind));
  const deployed = manifest.kind === 'ephemeral-docker-acceptance';
  if (deployed) {
    assert.equal(manifest.bootstrap?.compatibilityMounts,false);
    assert.equal(manifest.bootstrap?.emptyVolumes,true);
  }
  assert.match(manifest.train,/^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$/);
  const roots={}, evidence={reactor:null, sources:{}, outputs:{}, domain, adjustments:[],
    deployment:{mode:deployed ? 'direct' : 'lab',train:manifest.train,manifestSha256:hash(raw),images:manifest.images,resourceLimits:manifest.resourceLimits,tooling:manifest.tooling,bootstrap:manifest.bootstrap}};
  await mkdir(directory,{recursive:true});
  for(const name of Object.keys(apps)) {
    signal?.throwIfAborted();
    const entry=manifest.applications[name], target=join(directory,name);
    assert.ok(entry,`Missing published ${name}`);
    await cp(resolve(dirname(manifestPath),entry.directory),target,{recursive:true});
    const actual=await inventory(target);
    assert.deepEqual(actual.files,entry.files,`${name} deployment bytes changed after capture`);
    if (deployed && ['openview','monitoring','bridging'].includes(name)) {
      const settings=[];
      for (const file of Object.keys(actual.files).filter(file=>/^main-.*\.js$|^chunk-.*\.js$/.test(file))) {
        const bytes=await readFile(join(target,file),'utf8');
        settings.push(...[...bytes.matchAll(/cedarDomain:"([^"\r\n]*)"/g)].map(match=>match[1]));
      }
      assert.deepEqual(settings,[domain],`${name} image did not configure the deployment domain`);
    }
    if (!deployed && ['openview','monitoring','bridging'].includes(name)) {
      let changed=0;
      for (const file of Object.keys(actual.files).filter(file=>file.endsWith('.js'))) {
        const path=join(target,file), before=await readFile(path,'utf8');
        const after=before.replace(/\bcedarDomain\s*:\s*(["'])metadatacenter\.org\1/g,()=>{changed++;return 'cedarDomain:'+JSON.stringify(domain);});
        if (before!==after) {
          await writeFile(path,after);
          evidence.adjustments.push({application:name,file,change:'Local deployment domain only in the published production environment',beforeSha256:hash(before),afterSha256:hash(after)});
        }
      }
      assert.equal(changed,1,`${name} must have exactly one recognized production domain setting`);
    }
    if (!deployed) roots[`${name}.${domain}`]=target;
    evidence.outputs[name]=await inventory(target);
    evidence.sources[name]=entry.source;
  }
  const componentRoot=join(directory,'standalone');await mkdir(componentRoot);
  for(const name of ['cee','ced','cetp']) {
    signal?.throwIfAborted();
    const entry=manifest.components[name];assert.ok(entry,`Missing standalone ${name}`);
    const bytes=await readFile(resolve(dirname(manifestPath),entry.file));
    assert.equal(hash(bytes),entry.sha256,`${name} standalone bytes changed after capture`);
    await writeFile(join(componentRoot,name+'.js'),bytes);
    evidence.sources[name]=entry.source;
  }
  roots[`performance.${domain}`]=componentRoot;
  const integratedScript=await designerDelivery(join(directory,'designer'),domain);
  return {roots,evidence,componentRoot,integratedScript};
}
