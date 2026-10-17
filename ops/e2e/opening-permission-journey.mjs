import assert from 'node:assert/strict';
import {actors,call,mutate,enc} from './rest/lib.mjs';
import {recoveryFixture,settled} from './recovery-boundary-journey.mjs';

// Both journeys sign the second test user in to a browser context of their own, so they belong in
// the identity lane. Every grant they make is on their own fixtures and folders.

// Recheck access reads again what the opening read: the artifact's access report, or the folder a
// create is destined for. The page has settled once that read is answered and its status shows the
// outcome.
const statusOf=(p,metadata)=>p.locator(metadata?'.metadata-toolbar [role=status]':'#state');
const accessRead=(id,suffix)=>response=>{const path=decodeURIComponent(new URL(response.url()).pathname);
  return response.request().method()==='GET'&&path.endsWith(suffix)&&path.includes(id.split('/').at(-1));};
async function recheckedTo(p,metadata,recheck,read,status) {
  await Promise.all([p.waitForResponse(read),recheck.click()]);
  await statusOf(p,metadata).filter({hasText:status}).waitFor();
}
export async function openingPermissionJourney(args) {
  const {page,base,designer,user,pass}=args,{user2}=await actors();
  const context=await page.context().browser().newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:1000}});
  const reader=await context.newPage();reader.on('dialog',d=>d.accept());
  async function grant(path,role) {
    const r=await mutate(user.auth,'PUT',path+'/permissions',{owner:{'@id':user.profile['@id']},
      userPermissions:[{user:{'@id':user2.profile['@id']},role}],groupPermissions:[]});assert.equal(r.status,200,r.text);
  }
  try {
    await reader.goto(base+'/dashboard');await reader.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN||'test2@test.com');
    await reader.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD||'test2');await reader.locator('#kc-login').click();await reader.getByRole('button',{name:'New',exact:true}).waitFor();
    for(const kind of ['template','metadata']) {
      const f=await recoveryFixture(args,kind,'opening permissions');
      if(f.templateId)await grant('/templates/'+enc(f.templateId),'viewer');
      await grant(f.path,'viewer');await reader.goto(f.url);
      const recheck=reader.getByRole('button',{name:'Recheck access',exact:true});await recheck.waitFor();assert.ok(!(await f.save(reader).count()) || await f.save(reader).isDisabled());
      const report=accessRead(f.id,'/report');
      await recheckedTo(reader,f.metadata,recheck,report,/^Read only$/);
      await recheck.waitFor();assert.ok(!(await f.save(reader).count()) || await f.save(reader).isDisabled());
      const current=(await call(user.auth,'GET',f.path)).body;
      if(f.metadata)current.Notes['@value']='Latest saved';else current['schema:description']='Latest saved';
      assert.equal((await mutate(user.auth,'PUT',f.path,current)).status,200);
      await grant(f.path,'editor');await recheckedTo(reader,f.metadata,recheck,report,/^Unmodified$/);await f.ready(reader);
      await settled(f.input(reader),'Latest saved');
      await f.input(reader).fill('After initial access grant');await args.write(reader,'PUT','/'+f.collection+'/',()=>f.save(reader).click(),200,true);
      await reader.locator(f.metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();
      pass(`existing-${kind}`, `${kind}: a clean read-only opening rechecks real permissions, loads newer content and saves against its current revision`);
      // A create destination can remain readable while creating there is forbidden.
      const folderPath='/folders/'+enc(f.folderId);await grant(folderPath,'viewer');
      const createUrl=(f.metadata?base+'/instances/create/'+enc(f.templateId):designer+'/templates/create')+'?folderId='+enc(f.folderId);
      await reader.goto(createUrl);await recheck.waitFor();assert.ok(!(await f.save(reader).count()) || await f.save(reader).isDisabled());
      await grant(folderPath,'editor');await recheckedTo(reader,f.metadata,recheck,accessRead(f.folderId,f.folderId.split('/').at(-1)),/^Unmodified$/);
      await f.ready(reader);
      await f.input(reader).fill('After destination access grant');
      if(f.metadata)await reader.getByLabel('Instance name',{exact:true}).fill('Recovered destination '+args.name);
      else await reader.getByPlaceholder('Template name',{exact:true}).fill('Recovered destination '+args.name);
      const made=await args.write(reader,'PUT','/'+f.collection+'/',()=>f.save(reader).click(),201);
      assert.ok(made['@id']);await reader.locator(f.metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();
      pass(`destination-${kind}`, `${kind}: a denied create destination becomes usable after an explicit permission recheck and creates exactly once`);
    }
  } catch(error) {console.error(await reader.locator('body').innerText().catch(()=>''));throw error;} finally {await context.close();}
}
export async function signInPermissionJourney(args) {
  const {page,base,user,pass}=args,{user2}=await actors();
  const context=await page.context().browser().newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:1000}});
  const reader=await context.newPage();reader.on('dialog',d=>d.accept());
  async function grant(path,role) {
    const r=await mutate(user.auth,'PUT',path+'/permissions',{owner:{'@id':user.profile['@id']},userPermissions:[{user:{'@id':user2.profile['@id']},role}],groupPermissions:[]});assert.equal(r.status,200,r.text);
  }
  try {
    await reader.goto(base+'/dashboard');await reader.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN||'test2@test.com');await reader.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD||'test2');await reader.locator('#kc-login').click();await reader.getByRole('button',{name:'New',exact:true}).waitFor();
    for(const kind of ['template','metadata']) {
      const f=await recoveryFixture(args,kind,'sign-in permission change');if(f.templateId)await grant('/templates/'+enc(f.templateId),'viewer');await grant(f.path,'editor');
      await reader.goto(f.url);await f.ready(reader);await f.input(reader).fill('Retained across sign-in');
      const before=(await call(user.auth,'GET',f.path)).body;let writes=0;
      const count=r=>{if(r.method()==='PUT'&&f.matcher(new URL(r.url())))writes++;};reader.on('request',count);
      const expire=route=>route.request().method()==='PUT'?route.fulfill({status:401,json:{message:'Session expired'}}):route.fallback();
      await reader.route(f.matcher,expire);
      try {await f.save(reader).click();await reader.getByRole('button',{name:'Sign in again',exact:true}).waitFor();}
      finally {await reader.unroute(f.matcher,expire);}
      const refusedWrites=writes;assert.ok(refusedWrites>=1&&refusedWrites<=2,'at most one token refresh retry');
      await grant(f.path,'viewer');await reader.getByRole('button',{name:'Sign in again',exact:true}).click();
      await Promise.race([reader.locator('#username').waitFor(),reader.getByRole('button',{name:'Restore draft',exact:true}).waitFor()]);
      if(await reader.locator('#username').isVisible()) {await reader.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN||'test2@test.com');await reader.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD||'test2');await reader.locator('#kc-login').click();}
      await reader.getByRole('button',{name:'Restore draft',exact:true}).click();
      await reader.waitForFunction(({selector,value})=>JSON.stringify(document.querySelector(selector)?.captureDraft?.())?.includes(value),{selector:f.metadata?'cedar-embeddable-editor':'cedar-embeddable-designer',value:'Retained across sign-in'});assert.ok(!(await f.save(reader).count()) || await f.save(reader).isDisabled());
      const recheck=reader.getByRole('button',{name:'Recheck access',exact:true});await recheck.click();await reader.getByText(/do not currently have permission to update/).waitFor();
      assert.ok(!(await f.save(reader).count()) || await f.save(reader).isDisabled());assert.equal(writes,refusedWrites);assert.deepEqual((await call(user.auth,'GET',f.path)).body,before);
      await grant(f.path,'editor');await recheck.click();await recheck.waitFor({state:'hidden'});await f.ready(reader);assert.equal(await f.input(reader).inputValue(),'Retained across sign-in');assert.equal(writes,refusedWrites);
      await args.write(reader,'PUT','/'+f.collection+'/',()=>f.save(reader).click(),200,true);assert.equal(writes,refusedWrites+1);
      await reader.locator(f.metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();reader.off('request',count);
      pass(`signin-${kind}`, `${kind}: full sign-in restores the draft under reduced permissions, blocks writes, and resumes only after a fresh access grant and explicit save`);
    }
  } catch(error) {console.error(await reader.locator('body').innerText().catch(()=>''));throw error;} finally {await context.close();}
}
