import assert from 'node:assert/strict';
import {actors,artifactBody,call,mutate,enc,RESOURCE} from './rest/lib.mjs';
import {journeyFolder} from './journey-fixtures.mjs';

export async function recoveryFixture(args,kind,suffix,{pattern=false}={}) {
  const {page,base,designer,user,name,created}=args;
  const folderId=await journeyFolder(args,suffix+' '+kind);
  async function create(collection,body) {
    const r=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(r.status,201,r.text);created.push({collection,id:r.body['@id']});return r.body['@id'];
  }
  const metadata=kind==='metadata',collection=metadata?'template-instances':{template:'templates',element:'template-elements',field:'template-fields'}[kind];
  let body,templateId;
  if(metadata) {
    const template=artifactBody('template',name+' '+suffix);
    template.properties.Notes=artifactBody('field','Notes');
    if(pattern)template.properties.Notes._valueConstraints.regex='^[A-Z]+$';
    template.properties['@context'].properties.Notes={enum:['https://example.org/recovery/Notes']};
    template._ui.order.push('Notes');template._ui.propertyLabels.Notes='Notes';template.required.push('Notes');
    templateId=await create('templates',template);
    body=artifactBody('instance',name+' '+suffix,{'schema:isBasedOn':templateId,Notes:{'@value':'OPENED'}});
    body['@context'].Notes='https://example.org/recovery/Notes';body['@context']['pav:derivedFrom']={'@type':'@id'};
  } else body=artifactBody(kind,name+' '+suffix);
  const id=await create(collection,body),path='/'+collection+'/'+enc(id);
  const url=(metadata?base+'/instances/edit/':designer+'/'+kind+'s/edit/')+enc(id);
  const input=p=>metadata?p.locator('cedar-embeddable-editor').getByLabel('Notes',{exact:true}):p.getByPlaceholder(kind==='field'?'Field description':'Add description...',{exact:true}).first();
  async function ready(p) {
    if(metadata)await p.getByLabel('Instance name',{exact:true}).waitFor();
    else {await p.locator('#editor > *').waitFor();if(kind==='field')await p.getByRole('tab',{name:'Presentation',exact:true}).click();}
    await input(p).waitFor();
  }
  const save=p=>p.locator(metadata?'#button-save-metadata':'#save');
  const matcher=url=>url.origin===new URL(RESOURCE).origin&&url.pathname.startsWith('/'+collection+'/')&&decodeURIComponent(url.pathname.split('/').at(-1)).split('/').at(-1)===id.split('/').at(-1);
  await page.goto(url);await ready(page);await assertNoRecoveryFiles(page);
  return {id,path,url,input,ready,save,matcher,metadata,collection,folderId,templateId};
}
export async function settled(input,value) {
  const until=Date.now()+10000;
  while(true) {
    const current=await input.inputValue();
    if(current===value)return;
    assert.ok(Date.now()<until,`Expected retained input ${value}, got ${current}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
export async function startupRecoveryJourney(args) {
  const {page,user,pass}=args;
  for(const kind of ['template','metadata'])for(const dependency of ['profile','component','artifact','destination']) {
    const f=await recoveryFixture(args,kind,'startup '+dependency);const value='Retained '+dependency;
    if(dependency==='destination') {
      await page.goto((f.metadata?args.base+'/instances/create/'+enc(f.templateId):args.designer+'/templates/create')+'?folderId='+enc(f.folderId));await f.ready(page);
      if(f.metadata)await page.getByLabel('Instance name',{exact:true}).fill(args.name+' retained create');else await page.getByPlaceholder('Template name',{exact:true}).fill(args.name+' retained create');
    }
    await f.input(page).fill(value);const before=await call(user.auth,'GET',f.path);
    const matcher=url=>dependency==='profile'?url.hostname.startsWith('user.')&&url.pathname.startsWith('/users/'):f.matcher(url);
    // Component URLs are discovered from the actual loaded page, not assumed from a dev build layout.
    const scripts=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name).filter(url=>/\.js(?:\?|$)/.test(url)&&/cedar-embeddable-(editor|designer)(?:\.host-fonts)?\.js/.test(url)));
    let intercepted=0;
    const fail=route=>{if(route.request().method()!=='GET')return route.fallback();intercepted++;return route.fulfill({status:503,json:{message:'Temporary startup outage'}});};
    const match=dependency==='component'?url=>scripts.some(script=>new URL(script).origin===url.origin&&new URL(script).pathname===url.pathname):dependency==='destination'?url=>url.origin===new URL(RESOURCE).origin&&url.pathname.startsWith('/folders/')&&decodeURIComponent(url.pathname.split('/').at(-1)).split('/').at(-1)===f.folderId.split('/').at(-1):matcher;
    if(dependency==='component')assert.ok(scripts.length,'find served component script');
    await page.route(match,fail);await page.reload();
    await page.locator(f.metadata?'.metadata-toolbar [role=status]':'#state').filter({hasText:'Unable to load'}).waitFor();assert.ok(intercepted>0,'startup failure must be injected');
    await page.getByRole('button',{name:f.metadata?'Retry':'Reload designer',exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore draft',exact:true}).waitFor();
    assert.ok(await page.evaluate(value=>Object.values(sessionStorage).some(raw=>raw.includes(value)),value));
    await assertNoRecoveryFiles(page);
    await page.unroute(match,fail);
    await page.getByRole('button',{name:f.metadata?'Retry':'Reload designer',exact:true}).click();
    await page.getByRole('button',{name:'Restore draft',exact:true}).click();await f.ready(page);await settled(f.input(page),value);await assertNoRecoveryFiles(page);
    assert.deepEqual((await call(user.auth,'GET',f.path)).body,before.body);
    // A retained create is a PUT answered 201 without If-Match; a retained update carries the opened revision.
    await args.write(page,'PUT','/'+f.collection+'/',()=>f.save(page).click(),dependency==='destination'?201:200,dependency!=='destination');
    await page.locator(f.metadata?'.metadata-save-status':'#state').filter({hasText:/^Saved$/}).waitFor();
    pass(`${kind}: ${dependency} startup failure retains the draft through Retry, restoration and explicit save`);
  }
}
export async function tabIsolationJourney(args) {
  const {page,base,pass}=args,{user2}=await actors();
  const otherContext=await page.context().browser().newContext({ignoreHTTPSErrors:true});
  const other=await otherContext.newPage();other.on('dialog',d=>d.accept());
  try {
    await other.goto(base+'/dashboard');await other.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN||'test2@test.com');
    await other.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD||'test2');await other.locator('#kc-login').click();await other.getByRole('button',{name:'New',exact:true}).waitFor();
    for(const kind of ['template','metadata']) {
      const f=await recoveryFixture(args,kind,'tab isolation');await f.input(page).fill('First tab draft');
      const retained=await page.evaluate(()=>Object.entries(sessionStorage));
      const fresh=await page.context().newPage();fresh.on('dialog',d=>d.accept());
      try {
        await fresh.goto(f.url);await f.ready(fresh);assert.equal(await fresh.getByRole('button',{name:'Restore draft',exact:true}).isVisible(),false);
        await f.input(fresh).fill('Second tab draft');await fresh.reload();await fresh.getByRole('button',{name:'Restore draft',exact:true}).click();await settled(f.input(fresh),'Second tab draft');
        await page.reload();await page.getByRole('button',{name:'Restore draft',exact:true}).click();await settled(f.input(page),'First tab draft');
        for(const path of [f.path,...(f.templateId?['/templates/'+enc(f.templateId)]:[])]) {
          const grant=await mutate(args.user.auth,'PUT',path+'/permissions',{owner:{'@id':args.user.profile['@id']},userPermissions:[{user:{'@id':user2.profile['@id']},role:'viewer'}],groupPermissions:[]});assert.equal(grant.status,200,grant.text);
        }
        await other.goto(f.url);
        // Model an account switch in a tab whose browser storage still contains the prior account's keys.
        await other.evaluate(entries=>{for(const [key,value] of entries)sessionStorage.setItem(key,value);},retained);
        await other.reload();
        await other.getByRole('button',{name:'Recheck access',exact:true}).waitFor();
        assert.equal(await other.getByRole('button',{name:'Restore draft',exact:true}).isVisible(),false);
        assert.ok(!(await other.locator('body').innerText()).includes('First tab draft'));
        await assertNoRecoveryFiles(other);
        assert.equal(await f.input(page).inputValue(),'First tab draft');assert.equal(await f.input(fresh).inputValue(),'Second tab draft');
        pass(`${kind}: independent tabs retain different drafts, and another account cannot discover or restore the first account's retained work`);
      } finally {await fresh.close();}
    }
  } finally {await otherContext.close();}
}

export async function assertNoRecoveryFiles(page) {
  assert.equal(await page.getByRole('button',{name:/^Download recovery (file|draft)$/}).count(),0);
  assert.equal(await page.getByText(/^Import recovery (file|draft)$/).count(),0);
  assert.equal(await page.locator('#notices input[type=file], .metadata-content > p input[type=file]').count(),0);
}
