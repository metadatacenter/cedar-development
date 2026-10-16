import {journeyFolder} from "./journey-fixtures.mjs";
import assert from 'node:assert/strict';
import {artifactBody, call, mutate, enc, RESOURCE} from './rest/lib.mjs';

export async function draftRecoveryJourney({page,base,designer,user,folderId,name,created,write,pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "recovery");
  async function create(collection,body) {
    const made=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(made.status,201,made.text);created.push({collection,id:made.body['@id']});return made.body['@id'];
  }
  for(const kind of ['template','element','field','metadata']) for(const failure of ['outage','lost reply','sign-in']) {
    const metadata=kind==='metadata';
    const collection=metadata?'template-instances':{template:'templates',element:'template-elements',field:'template-fields'}[kind];
    let body;
    if(metadata) {
      const template=artifactBody('template',name+' recovery template');
      template.properties.Notes=artifactBody('field','Notes');
      template.properties['@context'].properties.Notes={enum:['https://example.org/draft/Notes']};
      template._ui.order.push('Notes');template._ui.propertyLabels.Notes='Notes';template.required.push('Notes');
      const templateId=await create('templates',template);
      body=artifactBody('instance',name+' metadata',{'schema:isBasedOn':templateId,Notes:{'@value':'Opened'}});
      body['@context'].Notes='https://example.org/draft/Notes';body['@context']['pav:derivedFrom']={'@type':'@id'};
    } else body=artifactBody(kind,name+' recovery '+kind);
    const id=await create(collection,body),path='/'+collection+'/'+enc(id);
    const url=(metadata?base+'/instances/edit/':designer+'/'+kind+'s/edit/')+enc(id);
    await page.goto(url);
    const component=page.locator(metadata?'cedar-embeddable-editor':kind==='field'?'cedar-embeddable-field-designer':'cedar-embeddable-designer');
    if(!metadata) {
      await page.locator('#state').filter({hasText:/^Unmodified$/}).waitFor();
      if(kind==='field')await page.getByRole('tab',{name:'Presentation',exact:true}).click();
    }
    const input=metadata?component.getByLabel('Notes',{exact:true}):page.getByPlaceholder(kind==='field'?'Field description':'Add description...',{exact:true}).first();
    await input.fill('Retained '+failure);
    const matcher=url=>url.origin===new URL(RESOURCE).origin && url.pathname.startsWith('/'+collection+'/') &&
      decodeURIComponent(url.pathname.split('/').at(-1)).split('/').at(-1)===id.split('/').at(-1);
    let writes=0;
    const countWrites=request=>{if(request.method()==='PUT' && matcher(new URL(request.url())))writes++;};
    page.on('request',countWrites);
    const intercept=async route=>{
      if(route.request().method()!=='PUT')return route.fallback();
      if(failure==='sign-in')return route.fulfill({status:401,json:{message:'Session expired'}});
      if(failure==='lost reply') {const response=await route.fetch();assert.equal(response.status(),200,await response.text());}
      return route.abort('failed');
    };
    await page.route(matcher,intercept);
    const save=page.locator(metadata?'#button-save-metadata':'#save');await save.click();
    const recovery=page.getByRole('button',{name:failure==='sign-in'?'Recheck access':'Check save status',exact:true});
    await recovery.waitFor();assert.equal(await save.isDisabled(),true);
    await page.unroute(matcher,intercept);
    if(failure==='sign-in') {
      await page.getByRole('button',{name:'Sign in again',exact:true}).click();
      // A valid SSO cookie returns directly; a fully expired session asks for credentials.
      await Promise.race([page.locator('#username').waitFor(),page.getByRole('button',{name:'Restore draft',exact:true}).waitFor()]);
      if(await page.locator('#username').isVisible()) {
        await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN||'test1@test.com');
        await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD||'test1');
        await page.locator('#kc-login').click();
      }
    } else await page.reload();
    await page.getByRole('button',{name:'Restore draft',exact:true}).click();
    if(kind==='field')await page.getByRole('tab',{name:'Presentation',exact:true}).click();
    await page.waitForFunction(({element,value})=>element.value===value,
      {element:await input.elementHandle(),value:'Retained '+failure});
    assert.equal(await input.inputValue(),'Retained '+failure);
    assert.equal(await save.isDisabled(),true);
    const beforeRecovery=writes;await recovery.click();
    await page.waitForFunction(selector=>!document.querySelector(selector)?.disabled,metadata?'#button-save-metadata':'#save');
    assert.equal(writes,beforeRecovery,'restoration and status checks must not repeat a write');
    await input.fill('Next after '+failure);
    await write(page,'PUT','/'+collection+'/',()=>save.click(),200,true);
    const stored=await call(user.auth,'GET',path);assert.equal(stored.status,200,stored.text);
    assert.equal(metadata?stored.body.Notes['@value']:stored.body['schema:description'],'Next after '+failure);
    await page.locator(metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();
    await page.reload();
    if(!metadata)await page.locator('#state').filter({hasText:/^Unmodified$/}).waitFor();
    else await page.getByLabel('Instance name',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Restore draft',exact:true}).isVisible(),false);
    if(!metadata)assert.equal(await page.locator('#draft-offer').isVisible(),false);
    page.off('request',countWrites);
    pass(`${kind}: ${failure} survives reload/sign-in, restores real component input, checks outcome and saves conditionally`);
  }
}

export async function metadataReconciliationJourney({page,base,user,folderId,name,created,write,pass}) {
  const template=artifactBody('template',name+' conflict');
  template.properties.Notes=artifactBody('field','Notes');template.properties['@context'].properties.Notes={enum:['https://example.org/draft/Notes']};
  template._ui.order.push('Notes');template._ui.propertyLabels.Notes='Notes';template.required.push('Notes');
  async function create(collection,body) {const r=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);assert.equal(r.status,201,r.text);created.push({collection,id:r.body['@id']});return r.body['@id'];}
  const tid=await create('templates',template);
  const body=artifactBody('instance',name+' conflict record',{'schema:isBasedOn':tid,Notes:{'@value':'Opened'}});
  body['@context'].Notes='https://example.org/draft/Notes';body['@context']['pav:derivedFrom']={'@type':'@id'};
  const id=await create('template-instances',body),path='/template-instances/'+enc(id);
  await page.goto(base+'/instances/edit/'+enc(id));
  const notes=page.locator('cedar-embeddable-editor').getByLabel('Notes',{exact:true});await notes.fill('My choice');
  const before=await call(user.auth,'GET',path);
  const changed=await mutate(user.auth,'PUT',path,{...before.body,Notes:{'@value':'Other author'}});assert.equal(changed.status,200,changed.text);
  await write(page,'PUT','/template-instances/',()=>page.locator('#button-save-metadata').click(),412,true);
  await page.getByRole('button',{name:'Review latest saved version',exact:true}).click();
  const apply=page.getByRole('button',{name:'Apply reviewed changes',exact:true});await apply.waitFor();assert.equal(await apply.isDisabled(),true);
  await page.getByLabel('Keep my value',{exact:true}).check();await apply.click();assert.equal(await notes.inputValue(),'My choice');
  await write(page,'PUT','/template-instances/',()=>page.locator('#button-save-metadata').click(),200,true);
  assert.equal((await call(user.auth,'GET',path)).body.Notes['@value'],'My choice');
  pass('Metadata conflict: real 412, explicit comparison and choice, conditional save and authoritative readback');
}
