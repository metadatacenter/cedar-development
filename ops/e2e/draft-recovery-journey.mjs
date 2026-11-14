import { waitForState } from "./journey-fixtures.mjs";
import { withBrowserAuthentication } from "./auth-activity.mjs";
import {journeyFolder} from "./journey-fixtures.mjs";
import {editorStatus} from "./metadata-journey-fixtures.mjs";
import assert from 'node:assert/strict';
import {artifactBody, call, mutate, enc, RESOURCE} from './rest/lib.mjs';

// These journeys act as the runner's first test user. The sign-in case returns through the SSO
// cookie. Separate expired-sso cases expire the browser's Keycloak cookies and require the real
// credential form, while retaining the tab's application storage. Neither signs in as another account.
export async function draftRecoveryJourney({page,base,designer,user,folderId,name,created,write,pass}) {
  folderId = await journeyFolder({user, folderId, name, created}, "recovery");
  async function create(collection,body) {
    const made=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(made.status,201,made.text);created.push({collection,id:made.body['@id']});return made.body['@id'];
  }
  for(const kind of ['template','element','field','metadata']) for(const failure of [
    'outage','lost reply','sign-in', ...(['template','metadata'].includes(kind)?['expired-sso']:[]),
  ]) {
    const signingIn = failure==='sign-in' || failure==='expired-sso';
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
    const status=text=>metadata?editorStatus(page,text):page.locator('#state').filter({hasText:text});
    await status(/^Unmodified$/).waitFor();
    if(kind==='field')await page.getByRole('tab',{name:'Presentation',exact:true}).click();
    const input=metadata?component.getByLabel('Notes',{exact:true}):page.getByPlaceholder(kind==='field'?'Field description':'Add description...',{exact:true}).first();
    await input.fill('Retained '+failure);
    const matcher=url=>url.origin===new URL(RESOURCE).origin && url.pathname.startsWith('/'+collection+'/') &&
      decodeURIComponent(url.pathname.split('/').at(-1)).split('/').at(-1)===id.split('/').at(-1);
    let writes=0;
    const countWrites=request=>{if(request.method()==='PUT' && matcher(new URL(request.url())))writes++;};
    page.on('request',countWrites);
    const intercept=async route=>{
      if(route.request().method()!=='PUT')return route.fallback();
      if(signingIn)return route.fulfill({status:401,json:{message:'Session expired'}});
      if(failure==='lost reply') {const response=await route.fetch();assert.equal(response.status(),200,await response.text());}
      return route.abort('failed');
    };
    const save=page.locator(metadata?'#button-save-metadata':'#save');
    const recovery=page.getByRole('button',{name:signingIn?'Recheck access':'Check save status',exact:true});
    await page.route(matcher,intercept);
    try {
      await save.click();
      await recovery.waitFor();assert.equal(await save.isDisabled(),true);
    } finally {await page.unroute(matcher,intercept);}
    const refusedWrites = writes;
    if(signingIn) {
      await withBrowserAuthentication("draft recovery sign-in", async () => {
        if(failure==='expired-sso') {
          // Expire only Keycloak SSO cookies. Draft-bearing local/session storage and app cookies
          // stay intact; the server must now ask for credentials instead of accepting an SSO cookie.
          const sso = cookie => /^KEYCLOAK_(IDENTITY|SESSION)(?:_|$)/.test(cookie.name);
          const cookies = (await page.context().cookies()).filter(sso);
          assert.ok(cookies.some(cookie=>cookie.name.startsWith('KEYCLOAK_IDENTITY')), 'Expected a live Keycloak SSO identity cookie');
          await page.context().addCookies(cookies.map(cookie=>({...cookie,expires:1})));
          assert.equal((await page.context().cookies()).filter(sso).length, 0, 'SSO cookies actually expired');
        }
        await page.getByRole('button',{name:'Sign in again',exact:true}).click();
        if(failure==='expired-sso') {
          await page.locator('#username').waitFor();
          assert.equal(await page.getByRole('button',{name:'Restore draft',exact:true}).isVisible(), false,
            'An expired SSO cookie cannot bypass credential entry');
        } else await page.locator('#username').or(page.getByRole('button',{name:'Restore draft',exact:true})).first().waitFor();
        if(failure==='expired-sso' || await page.locator('#username').isVisible()) {
          await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN||'test1@test.com');
          await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD||'test1');
          await page.locator('#kc-login').click();
        }
        await page.getByRole('button',{name:'Restore draft',exact:true}).waitFor();
      });
    } else await page.reload();
    await page.getByRole('button',{name:'Restore draft',exact:true}).click();
    if(kind==='field')await page.getByRole('tab',{name:'Presentation',exact:true}).click();
    await waitForState(page, ({element,value})=>element.value===value,
      {element:await input.elementHandle(),value:'Retained '+failure});
    assert.equal(await input.inputValue(),'Retained '+failure);
    assert.equal(await save.isDisabled(),true);
    assert.equal(writes,refusedWrites,'reload, sign-in and restoration must not replay the write');
    const beforeRecovery=writes;await recovery.click();
    await waitForState(page, selector=>!document.querySelector(selector)?.disabled,metadata?'#button-save-metadata':'#save');
    assert.equal(writes,beforeRecovery,'restoration and status checks must not repeat a write');
    await input.fill('Next after '+failure);
    await write(page,'PUT','/'+collection+'/',()=>save.click(),200,true);
    const stored=await call(user.auth,'GET',path);assert.equal(stored.status,200,stored.text);
    assert.equal(metadata?stored.body.Notes['@value']:stored.body['schema:description'],'Next after '+failure);
    await page.locator(metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();
    await page.reload();
    // A loaded page has already decided whether to offer a draft.
    await status(/^Unmodified$/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Restore draft',exact:true}).isVisible(),false);
    if(!metadata)assert.equal(await page.locator('#draft-offer').isVisible(),false);
    page.off('request',countWrites);
    pass(`restore-${kind}-${failure}`, failure==='expired-sso'
      ? `${kind}: expired SSO cookies require credential login, preserve the draft without replaying its write, and allow a conditional save and clean reopen`
      : `${kind}: ${failure} survives reload/sign-in, restores real component input, checks outcome and saves conditionally`);
  }
}

export async function metadataConflictJourney({page,base,user,folderId,name,created,write,pass}) {
  folderId=await journeyFolder({user,folderId,name,created},'metadata conflict');
  const template=artifactBody('template',name+' conflict');
  template.properties.Notes=artifactBody('field','Notes');template.properties['@context'].properties.Notes={enum:['https://example.org/draft/Notes']};
  template._ui.order.push('Notes');template._ui.propertyLabels.Notes='Notes';template.required.push('Notes');
  async function create(collection,body) {const r=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);assert.equal(r.status,201,r.text);created.push({collection,id:r.body['@id']});return r.body['@id'];}
  const tid=await create('templates',template);
  const body=artifactBody('instance',name+' conflict record',{'schema:isBasedOn':tid,Notes:{'@value':'Opened'}});
  body['@context'].Notes='https://example.org/draft/Notes';body['@context']['pav:derivedFrom']={'@type':'@id'};
  const id=await create('template-instances',body),path='/template-instances/'+enc(id);
  await page.goto(base+'/instances/edit/'+enc(id));
  const notes=page.locator('cedar-embeddable-editor').getByLabel('Notes',{exact:true});
  const save=page.locator('#button-save-metadata');
  const noComparison=async()=>{
    assert.equal(await page.getByRole('button',{name:'Review latest saved version',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).count(),0);
    assert.equal(await page.locator('main table').count(),0);
  };
  await editorStatus(page,/^Unmodified$/).waitFor();await noComparison();
  await notes.fill('My retained draft');await noComparison();
  const before=await call(user.auth,'GET',path);
  const changed=await mutate(user.auth,'PUT',path,{...before.body,Notes:{'@value':'Other author'}});assert.equal(changed.status,200,changed.text);
  const latest=await call(user.auth,'GET',path);assert.equal(latest.status,200,latest.text);
  let writes=0;
  const countWrites=request=>{if(request.method()==='PUT' && request.url().includes('/template-instances/'))writes++;};
  page.on('request',countWrites);
  try {
    await write(page,'PUT','/template-instances/',()=>save.click(),412,true);
    assert.equal(await save.isDisabled(),true);
    assert.equal(await notes.inputValue(),'My retained draft');await noComparison();
    await page.reload();
    await page.getByRole('button',{name:'Restore draft',exact:true}).click();
    await waitForState(page, element=>element.value==='My retained draft',await notes.elementHandle());
    assert.equal(await save.isDisabled(),true);
    await notes.fill('More work on the retained draft');
    assert.equal(await save.isDisabled(),true);await noComparison();
    const reload=page.getByRole('button',{name:'Reload metadata',exact:true});
    const confirmation=page.locator('dialog.confirmation-dialog');
    await reload.click();
    await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await notes.inputValue(),'More work on the retained draft');
    assert.equal(await save.isDisabled(),true);
    await reload.click();
    await confirmation.getByRole('button',{name:'Yes',exact:true}).click();
    await editorStatus(page,/^Unmodified$/).waitFor();
    assert.equal(await notes.inputValue(),'Other author');await noComparison();
    assert.equal(await page.getByRole('button',{name:'Restore draft',exact:true}).count(),0);
    assert.equal(writes,1,'reload, restoration and confirmed discard never replay a stale write');
    const stored=await call(user.auth,'GET',path);assert.equal(stored.status,200,stored.text);
    assert.deepEqual(stored.body,latest.body,'the complete newer record remains unchanged');
  } finally {page.off('request',countWrites);}
  pass("metadata-conflict", 'Metadata conflict: real 412 retains the draft through reload and restoration, blocks stale writes, and requires confirmed discard to open the latest version');
}
