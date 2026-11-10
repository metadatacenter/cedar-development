import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate as turn, setTimeout as delay} from 'node:timers/promises';
import {command, prepare} from './lab.mjs';

// The child creates the marker only after its output has reached the pipe, so the test interrupts a
// child that has emitted output however long a loaded machine takes to start it. The interruption
// waits one more turn of the event loop, in which this process reads that output.
test('interruption stops a preparation child without treating emitted output as a successful build', {timeout:60_000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'cedar-perf-cancel-'));
  const marker=join(root,'started');
  const child=`process.stdout.write('started\\n',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},''));setInterval(()=>{},1000)`;
  const controller=new AbortController();
  try {
    const running=command(process.execPath,['-e',child],root,join(root,'build.log'),controller.signal);
    let settled=false;
    running.then(()=>{settled=true;},()=>{settled=true;});
    while(!settled && !await access(marker).then(()=>true,()=>false)) await delay(10);
    await turn();
    controller.abort();
    await assert.rejects(running,{name:'AbortError'});
    assert.match(await readFile(join(root,'build.log'),'utf8'),/started/);
    await assert.rejects(prepare('/does-not-exist',join(root,'lab'),'local.invalid',{signal:controller.signal}),{name:'AbortError'});
  } finally {controller.abort();await rm(root,{recursive:true,force:true});}
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
