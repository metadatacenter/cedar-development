import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReviewGroups} from './group-fixtures.mjs';
function setup({lost=false,denyDelete=false,delay}={}){
 const objects=new Map(),events=[];let groups;
 const reply=(status,body={})=>({status,body,headers:new Headers({etag:'"revision"'})});
 const request=async(method,path,body,opts)=>{
  events.push({method,path,opts});assert.equal(new URL(opts.base).hostname.split('.')[0],'group');
  if(path==='/groups'){
   if(method==='GET')return reply(200,{groups:[...objects.values()]});
   assert.equal(groups.items.length,1);assert.equal(groups.items[0].id,null);
   assert(events.some(e=>e.method==='persist'),'Intent must precede POST');
   if(delay)await delay;
   const group={...body,'@id':'https://repo.metadatacenter.orgx/groups/temporary'};objects.set(group['@id'],group);
   if(lost)throw Error('Lost reply');return reply(201,group);
  }
  const id=decodeURIComponent(path.slice('/groups/'.length));
  if(method==='GET')return objects.has(id)?reply(200,objects.get(id)):reply(404);
  assert.equal(method,'DELETE');assert.equal(opts.headers['If-Match'],'"revision"');
  if(denyDelete)return reply(412);objects.delete(id);return reply(204);
 };
 groups=new ReviewGroups(request,async()=>events.push({method:'persist'}));return {groups,objects,events};
}
test('group creation journals its unique name and verifies conditional cleanup',async()=>{
 const f=setup();const g=await f.groups.create('members');assert(f.groups.owns('https://group.metadatacenter.orgx/groups/'+encodeURIComponent(g.id)+'/users'));
 assert(!f.groups.owns('https://group.metadatacenter.orgx/groups/other/users'));
 await f.groups.close();assert.equal(f.objects.size,0);assert.deepEqual(f.groups.cleanupErrors,[]);assert(f.groups.items[0].absent);
});
test('lost group creation response is reconciled by the persisted unique name',async()=>{
 const f=setup({lost:true});await assert.rejects(f.groups.create('members'),/Lost reply/);
 await f.groups.close();assert.equal(f.objects.size,0);assert.deepEqual(f.groups.cleanupErrors,[]);
});
test('refused conditional deletion remains an explicit cleanup failure',async()=>{
 const f=setup({denyDelete:true});await f.groups.create('members');await f.groups.close();
 assert.equal(f.objects.size,1);assert.match(f.groups.cleanupErrors[0],/412/);
});

test('cleanup drains a pending group create and refuses a later creation',async()=>{
 let release;const delay=new Promise(resolve=>{release=resolve;});
 const f=setup({delay}),creating=f.groups.create('members');
 while(!f.events.some(e=>e.method==='POST'))await new Promise(resolve=>setImmediate(resolve));
 const closing=f.groups.close();
 assert.throws(()=>f.groups.create('later'),/closing/);
 assert(!f.events.some(e=>e.method==='DELETE'));
 release();await creating;await closing;
 assert.equal(f.objects.size,0);assert.deepEqual(f.groups.cleanupErrors,[]);
});
