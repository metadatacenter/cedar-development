import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {command, prepare} from './lab.mjs';

test('interruption stops a preparation child without treating emitted output as a successful build', async()=>{
  const root=await mkdtemp(join(tmpdir(),'cedar-perf-cancel-'));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),200);
  try {
    await assert.rejects(command(process.execPath,['-e',"console.log('started');setInterval(()=>{},1000)"],root,join(root,'build.log'),controller.signal),{name:'AbortError'});
    assert.match(await readFile(join(root,'build.log'),'utf8'),/started/);
    await assert.rejects(prepare('/does-not-exist',join(root,'lab'),'local.invalid',{signal:controller.signal}),{name:'AbortError'});
  } finally {clearTimeout(timer);await rm(root,{recursive:true,force:true});}
});


test('setup failure preserves structured cleanup errors, including failure to refresh credentials', async()=>{
  const {cleanupAfterSetupFailure} = await import('./scenarios.mjs');
  for (const cleanup of [async()=>['fixture still exists'], async()=>{throw new Error('cleanup login unavailable');}, async()=>[]]) {
    const setup=new Error('fixture creation failed');
    await assert.rejects(cleanupAfterSetupFailure(setup,cleanup),error=>{
      assert.equal(error,setup);
      assert.ok(Array.isArray(error.cleanupErrors));
      if(error.cleanupErrors.length) assert.match(error.message,/cleanup:/);
      return true;
    });
  }
});
