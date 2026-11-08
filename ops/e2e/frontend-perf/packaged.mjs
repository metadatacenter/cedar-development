// Verify and freeze published assets from an isolated deployment, without a source build/reactor.
import assert from 'node:assert/strict';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {apps, hash, inventory, designerDelivery} from './lab.mjs';

export async function preparePackaged(manifestPath, directory, domain, {signal}={}) {
  signal?.throwIfAborted();
  const raw=await readFile(manifestPath), manifest=JSON.parse(raw);
  assert.equal(manifest.schemaVersion,1); assert.equal(manifest.domain,domain);
  assert.equal(manifest.kind,'ephemeral-docker-train');
  assert.match(manifest.train,/^\d+\.\d+\.\d+-dev\.\d{8}\.\d{4}$/);
  const roots={}, evidence={reactor:null, sources:{}, outputs:{}, domain, adjustments:[],
    deployment:{train:manifest.train,manifestSha256:hash(raw),images:manifest.images,resourceLimits:manifest.resourceLimits,tooling:manifest.tooling,bootstrap:manifest.bootstrap}};
  await mkdir(directory,{recursive:true});
  for(const name of Object.keys(apps)) {
    signal?.throwIfAborted();
    const entry=manifest.applications[name], target=join(directory,name);
    assert.ok(entry,`Missing published ${name}`);
    await cp(resolve(dirname(manifestPath),entry.directory),target,{recursive:true});
    const actual=await inventory(target);
    assert.deepEqual(actual.files,entry.files,`${name} deployment bytes changed after capture`);
    roots[`${name}.${domain}`]=target; evidence.outputs[name]=actual;
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
