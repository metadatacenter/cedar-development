import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureJourney, retainCleanup} from './journeys.mjs';

test('failed journey cleans faults before navigation and retains the failure', async()=>{
  const events=[], session={page:{unrouteAll:async()=>events.push('unroute'),goto:async()=>events.push('leave'),mouse:{up:async()=>events.push('release-pointer')}},expectedNetworkFailures:new Set(['fault'])};
  let releases=0;
  const release=retainCleanup(session.page,async()=>{releases++;events.push('restore');});
  const record=Object.assign(()=>{}, {failure:(name,error)=>events.push(name+':'+error.message)});
  assert.equal(await captureJourney(session,record,'first',async()=>{throw new Error('timeout');}),false);
  await release();assert.equal(releases,1);
  assert.deepEqual(events,['journey:first:timeout','restore','unroute','leave','release-pointer']);
  assert.equal(session.expectedNetworkFailures.size,0);
  assert.equal(await captureJourney(session,record,'second',async()=>events.push('next')),true);
});

test('unsafe recovery stops collection rather than hiding its failure', async()=>{
  const page={};retainCleanup(page,async()=>{throw new Error('Cannot restore requests');});
  await assert.rejects(captureJourney({page},{failure:()=>{}},'first',async()=>{throw new Error('timeout');}),/Cannot restore requests/);
});
