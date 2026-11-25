import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FixtureLedger} from './lifecycle.mjs';
function fixture(options={}){
  const objects=new Map(),events=[],preferences={workspace:{view:'list'},editor:{language:'en'}};
  let prefs=structuredClone(preferences);
  const reply=(status,body={},etag)=>({status,body,headers:new Headers(etag?{etag}: {})});
  const request=async(method,path,body,opts)=>{
    events.push({method,path,body,opts});
    if(path==='/users/test'){
      if(method==='PATCH')for(const [key,value]of Object.entries(body)){
        if(value===null)delete prefs[key.slice(14)];else prefs[key.slice(14)]=value;
      }
      return reply(200,{uiPreferences:prefs});
    }
    if(method==='GET')return reply(objects.has(path)?200:404,objects.get(path),options.noEtag?undefined:'revision');
    if(method==='PUT'){
      assert(events.some(e=>e.method==='persist'&&e.ids.includes('https://local/templates/a')),'Identity must be persisted before the write');
      if(options.pendingReply)await options.pendingReply;
      objects.set(path,body);if(options.lostReply)throw Error('Reply lost');return reply(201);
    }
    if(method==='DELETE'){
      assert.equal(opts.headers['If-Match'],'revision');
      if(options.refuseDelete)return reply(412);
      objects.delete(path);return reply(204);
    }
    throw Error('Unexpected '+method+' '+path);
  };
  const ledger=new FixtureLedger({request,mint:()=> 'https://local/templates/a',persist:async()=>events.push({method:'persist',ids:ledger.fixtures.map(f=>f.id)}),userPath:'/users/test',preferences,userBase:'local'});
  return {ledger,objects,events,preferences,changePreferences:()=>{prefs={workspace:{view:'grid'},editor:{language:'de'},added:{x:1}};}};
}
test('a lost create reply retains ownership and is conditionally removed and verified absent',async()=>{
  const f=fixture({lostReply:true});await assert.rejects(f.ledger.put('templates',{}),/Reply lost/);
  assert.equal(f.objects.size,1);await f.ledger.close();assert.equal(f.objects.size,0);
  assert.deepEqual(f.ledger.cleanupErrors,[]);assert.equal(f.ledger.cleanup[0].getStatus,404);
});
test('existing or unreadable identities cannot be registered as review-owned',async()=>{
  const f=fixture();f.objects.set('/templates/'+encodeURIComponent('https://local/templates/a'),{});
  await assert.rejects(f.ledger.put('templates',{}),/existing or unreadable/);
  assert.equal(f.ledger.fixtures.length,0);assert(!f.events.some(e=>e.method==='PUT'));
});
test('missing revisions and concurrent-change refusals fail cleanup without unconditional deletion',async()=>{
  for(const options of [{noEtag:true},{refuseDelete:true}]){
    const f=fixture(options);await f.ledger.put('templates',{});await f.ledger.close();
    assert.equal(f.objects.size,1);assert(f.ledger.cleanupErrors.length);
    if(options.noEtag)assert(!f.events.some(e=>e.method==='DELETE'));
  }
});
test('cleanup restores all preference groups, removes newly introduced groups and verifies equality',async()=>{
  const f=fixture();f.changePreferences();await f.ledger.close();
  assert.deepEqual(f.ledger.preferencesRestored,{ok:true});assert.deepEqual(f.ledger.cleanupErrors,[]);
  assert.equal(f.events.filter(e=>e.method==='PATCH'&&e.path==='/users/test').length,3);
});

test('cleanup waits for an in-flight create and prevents a later create from racing deletion',async()=>{
  let release;const pendingReply=new Promise(resolve=>{release=resolve;});
  const f=fixture({pendingReply}),creating=f.ledger.put('templates',{});
  while(!f.events.some(e=>e.method==='PUT'))await new Promise(resolve=>setImmediate(resolve));
  const closing=f.ledger.close();
  assert.throws(()=>f.ledger.put('templates',{}),/closing/);
  assert(!f.events.some(e=>e.method==='DELETE'));
  release();await creating;await closing;
  assert.equal(f.objects.size,0);assert.deepEqual(f.ledger.cleanupErrors,[]);
});
