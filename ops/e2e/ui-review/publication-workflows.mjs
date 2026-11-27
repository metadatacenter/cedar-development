import assert from 'node:assert/strict';
import {captureJourney} from './journeys.mjs';
import {PAIRED_WIDTHS} from './catalog.mjs';
import {container,field} from './fixtures.mjs';
import {folderPage,pointer} from './interactions.mjs';
import {enterVersion} from '../workspace-journey-fixtures.mjs';

export async function collectPublicationWorkflows(session,record){
 const {page}=session,tap=target=>pointer(session,target);
 for(const width of PAIRED_WIDTHS)await captureJourney(session,record,`publication-chain-${width}`,async()=>{
  const folder=await session.put('folders',{folderId:session.user.profile.homeFolderId,name:'UI review publication '+width,description:'Temporary review folder'});
  const name='UI review coastal study '+width;
  const id=await session.put('templates',container(name,{Specimen:field('Specimen')}),folder);
  const row=id=>page.locator(`[data-resource-id="${id}"]`);
  const menu=async(id,label)=>{await tap(row(id).getByRole('button',{name:/^Actions for/}));await tap(page.locator('#resource-menu').getByRole('button',{name:label,exact:true}));};
  const dialog=page.locator('dialog.action-dialog[open]');
  const r=(state,fn,note)=>record(`${state}-${width}`,fn,note);
  await page.setViewportSize({width,height:width===1440?1000:667});
  await folderPage(session,folder,[id]);
  await r('publication-version',async()=>{await menu(id,'Publish');await enterVersion(page,'1.0.0');});
  await r('published',async()=>{
   const response=page.waitForResponse(res=>res.request().method()==='PATCH'&&new URL(res.url()).pathname.endsWith('/publication'));
   await tap(dialog.getByRole('button',{name:'Ok',exact:true}));assert.ok([200,201].includes((await response).status()));
   await dialog.waitFor({state:'hidden'});await folderPage(session,folder,[id]);
   const stored=await session.request('GET','/templates/'+encodeURIComponent(id));assert.equal(stored.body['bibo:status'],'bibo:published');assert.equal(stored.body['pav:version'],'1.0.0');
  },'The temporary template published through Workspace and verified by backend readback.');
  const version=async artifact=>{
   await tap(row(artifact).locator('.resource-icon'));
   const toggle=page.locator('[aria-controls="workspace-information"]');
   if(await toggle.getAttribute('aria-expanded')!=='true')await tap(toggle);
   await tap(page.getByRole('tab',{name:'Version',exact:true}));await page.getByRole('tabpanel',{name:'Version',exact:true}).waitFor();
  };
  await r('published-version',()=>version(id));
  await r('draft-version',async()=>{await menu(id,'Create Draft');await enterVersion(page,'1.1.0');});
  let draft;
  await r('draft-created',async()=>{
   const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname==='/command/create-draft-artifact');
   await tap(dialog.getByRole('button',{name:'Ok',exact:true}));const reply=await response;assert.equal(reply.status(),201);draft=(await reply.json())['@id'];
   await dialog.waitFor({state:'hidden'});await folderPage(session,folder,[id,draft]);
   const stored=await session.request('GET','/templates/'+encodeURIComponent(draft));assert.equal(stored.body['pav:version'],'1.1.0');assert.equal(stored.body['bibo:status'],'bibo:draft');
  },'A new draft created through Workspace from the published template, with its identity registered before the write and read back afterward.');
  await r('draft-version-chain',async()=>{
   await version(draft);const previous=page.getByRole('tabpanel',{name:'Version',exact:true}).locator('.previous-versions').filter({hasText:'1.0.0'});
   await previous.waitFor();await previous.scrollIntoViewIfNeeded();
  },'The draft’s Version panel shows its preceding published version.');
 });
}
