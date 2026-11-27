import assert from 'node:assert/strict';
import {captureJourney} from './journeys.mjs';
import {PAIRED_WIDTHS} from './catalog.mjs';
import {pointer,waitForPage} from './interactions.mjs';

export async function collectGroupWorkflows(session,record){
 const {page}=session,tap=target=>pointer(session,target);
 const dismissToast=async()=>{const button=page.getByRole('button',{name:'Dismiss notification',exact:true});if(await button.isVisible())await tap(button);};
 const person=[session.otherUser.profile.firstName,session.otherUser.profile.lastName].filter(Boolean).join(' ');
 for(const width of PAIRED_WIDTHS)await captureJourney(session,record,`group-administration-${width}`,async()=>{
  const fixture=await session.groups.create('collaborators '+width);
  const path='/groups/'+encodeURIComponent(fixture.id);
  const r=(state,fn,note)=>record(`group-${state}-${width}`,fn,note);
  await page.setViewportSize({width,height:width===1440?1000:667});
  await page.goto(session.base+'/groups');
  const confirmation=page.locator('dialog.confirmation-dialog[open]');
  await r('selected',async()=>{
   await page.locator('#group-search-picker').getByRole('combobox').fill(fixture.name);
   await tap(page.getByRole('option').filter({hasText:fixture.name}));
   await page.locator('#group-name').waitFor();
  },'A temporary group administered by the test account, showing the last-administrator safeguards.');
  await r('description-saved',async()=>{
   await page.locator('#group-description').fill('Coastal specimen collaborators');
   const response=page.waitForResponse(res=>new URL(res.url()).pathname===path&&res.request().method()==='PUT');
   await tap(page.getByRole('button',{name:'Save',exact:true}));assert.equal((await response).status(),200);
   const stored=await session.groups.call('GET',path);assert.equal(stored.body['schema:description'],'Coastal specimen collaborators');
  });
  const member=page.getByRole('listitem',{name:person,exact:true});
  await r('member-search',async()=>{
   await page.getByRole('combobox',{name:'Add a member',exact:true}).fill(person);
   await page.getByRole('option',{name:person,exact:true}).waitFor();
  });
  await r('member-added',async()=>{
   await tap(page.getByRole('option',{name:person,exact:true}));
   await tap(page.getByRole('button',{name:'Add member',exact:true}));await member.waitFor();await dismissToast();await member.scrollIntoViewIfNeeded();
  });
  await r('administrator-confirmation',async()=>{await tap(member.getByRole('checkbox'));await confirmation.waitFor();});
  await r('administrator-added',async()=>{
   const response=page.waitForResponse(res=>new URL(res.url()).pathname===path+'/users'&&res.request().method()==='PUT');
   await tap(confirmation.getByRole('button',{name:'Yes',exact:true}));assert.equal((await response).status(),200);await confirmation.waitFor({state:'hidden'});
   const users=await session.groups.call('GET',path+'/users');
   assert.ok(users.body.users.some(m=>m.user['@id']===session.otherUser.profile['@id']&&m.administrator));
   await dismissToast();await member.scrollIntoViewIfNeeded();
  });
  await r('remove-confirmation',async()=>{
   await tap(member.getByRole('button',{name:`Remove ${person} from the group`,exact:true}));await confirmation.waitFor();
  });
  await r('member-removed',async()=>{await tap(confirmation.getByRole('button',{name:'Yes',exact:true}));await member.waitFor({state:'detached'});await dismissToast();await page.locator('.groups-member-list').scrollIntoViewIfNeeded();});
  await r('delete-confirmation',async()=>{
   await tap(page.locator('#delete-group-tab'));
   await page.locator('#delete-group-picker').getByRole('combobox').fill(fixture.name);
   const selected=page.waitForResponse(res=>new URL(res.url()).pathname===path+'/users'&&res.request().method()==='GET');
   await tap(page.getByRole('option').filter({hasText:fixture.name}));await selected;
   await waitForPage(page,()=>document.querySelector('#delete-group-picker input')?.disabled===false&&!!document.querySelector('.groups-delete-button'));
   await tap(page.locator('.groups-delete-button'));await confirmation.waitFor();
  },'Deletion confirmation for the temporary group, before deletion is authorized.');
  await tap(confirmation.getByRole('button',{name:'Cancel',exact:true}));
 });
}
