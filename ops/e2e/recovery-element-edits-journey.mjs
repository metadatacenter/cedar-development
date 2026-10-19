import assert from 'node:assert/strict';
import {artifactBody,call,enc,RESOURCE} from './rest/lib.mjs';
import {journeyFolder} from './journey-fixtures.mjs';
import {editorStatus} from './metadata-journey-fixtures.mjs';
function add(parent,key,child,repeat=false){
  parent.properties[key]=repeat?{type:'array',minItems:0,items:child}:child;
  parent.properties['@context'].properties[key]={enum:['https://example.org/recovery-entries/'+key]};
  parent._ui.order.push(key);parent._ui.propertyLabels[key]=key;parent.required.push(key);
}
const content=value=>{const copy=structuredClone(value);delete copy['pav:lastUpdatedOn'];delete copy['oslc:modifiedBy'];return copy;};
// The journey acts as the runner's first test user only and never signs in as another account.
export async function recoveryElementEditsJourney({page,base,user,folderId,name,created,write,pass}){
  folderId=await journeyFolder({user,folderId,name,created},'recovery element edits');
  async function create(collection,body){
    const made=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(made.status,201,made.text);created.push({collection,id:made.body['@id']});return made.body['@id'];
  }
  for(const action of ['remove earlier and copy submitted','remove submitted and add replacement']){
    const template=artifactBody('template',name+' recovery entries'),element=artifactBody('element','Visits');
    add(element,'Detail',artifactBody('field','Detail'));add(template,'Visits',element,true);add(template,'Keep',artifactBody('field','Keep'));
    const templateId=await create('templates',template);
    const instance=artifactBody('instance',name+' recovery entries',{'schema:isBasedOn':templateId,
      Keep:{'@value':'Untouched'},Visits:[{'@id':null,'@context':{Detail:'https://example.org/recovery-entries/Detail'},Detail:{'@value':'Original'}}]});
    instance['@context'].Visits='https://example.org/recovery-entries/Visits';instance['@context'].Keep='https://example.org/recovery-entries/Keep';
    instance['@context']['pav:derivedFrom']={'@type':'@id'};
    const id=await create('template-instances',instance),path='/template-instances/'+enc(id);
    const read=async()=>{const result=await call(user.auth,'GET',path);assert.equal(result.status,200,result.text);return result.body;};
    await page.goto(base+'/instances/edit/'+enc(id));
    const cee=page.locator('cedar-embeddable-editor'),pager=cee.locator('app-cedar-multi-pager'),detail=cee.getByRole('textbox',{name:'Detail',exact:true});
    // The pager lists its occurrences only while there are two or more, and marks the one shown.
    const occurrence=number=>pager.getByRole('option',{name:number,exact:true,selected:true}).waitFor();
    const single=()=>pager.getByRole('listbox').waitFor({state:'detached'});
    await editorStatus(page,/^Unmodified$/).waitFor();
    await detail.waitFor();await pager.getByRole('button',{name:'Add empty instance here',exact:true}).click();await detail.fill('Submitted');
    const match=url=>url.origin===new URL(RESOURCE).origin&&url.pathname.startsWith('/template-instances/')&&decodeURIComponent(url.pathname.split('/').at(-1)).split('/').at(-1)===id.split('/').at(-1);
    const lose=async route=>{if(route.request().method()!=='PUT')return route.fallback();const result=await route.fetch();assert.equal(result.status(),200,await result.text());await route.abort('failed');};
    const save=page.locator('#button-save-metadata'),check=page.getByRole('button',{name:'Check save status',exact:true});
    await page.route(match,lose);
    try{await save.click();await check.waitFor();}finally{await page.unroute(match,lose);}
    const committed=await read();assert.equal(committed.Visits.length,2);assert.notEqual(committed.Visits[0]['@id'],committed.Visits[1]['@id']);
    let release;const gate=new Promise(resolve=>release=resolve);
    const hold=async route=>{if(route.request().method()!=='GET')return route.fallback();await gate;await route.continue();};
    await page.route(match,hold);
    try{
      await check.click();await page.getByText('Checking save status…',{exact:false}).waitFor();
      if(action==='remove earlier and copy submitted'){await pager.getByRole('option',{name:'1',exact:true}).click();await occurrence('1');}
      await pager.getByRole('button',{name:'Delete current',exact:true}).click();
      await single();
      assert.equal(await detail.inputValue(),action==='remove earlier and copy submitted'?'Submitted':'Original');
      await pager.getByRole('button',{name:action==='remove earlier and copy submitted'?'Add copy of this instance':'Add empty instance here',exact:true}).click();
      await detail.fill('Replacement');release();await check.waitFor({state:'hidden'});
      assert.equal(await detail.inputValue(),'Replacement');
      await page.locator('.metadata-save-status').filter({hasText:/^Modified$/}).waitFor();
    }finally{release();await page.unroute(match,hold);}
    await write(page,'PUT','/template-instances/',()=>save.click(),200,true);
    await page.locator('.metadata-save-status').filter({hasText:/^Saved$/}).waitFor();
    const stored=await read(),survivor=committed.Visits[action==='remove earlier and copy submitted'?1:0];
    assert.equal(stored.Visits.length,2);assert.equal(stored.Visits[0]['@id'],survivor['@id']);
    assert.ok(committed.Visits.every(entry=>entry['@id']!==stored.Visits[1]['@id']),'the replacement must receive its own identity');
    const expected={...committed,Visits:[survivor,{...committed.Visits[1],'@id':stored.Visits[1]['@id'],Detail:{'@value':'Replacement'}}]};
    assert.deepEqual(content(stored),content(expected));
    await page.reload();await editorStatus(page,/^Unmodified$/).waitFor();await detail.waitFor();assert.equal(await detail.inputValue(),survivor.Detail['@value']);
    await pager.getByRole('option',{name:'2',exact:true}).click();await occurrence('2');assert.equal(await detail.inputValue(),'Replacement');
    pass(`elements-${action}`, `Editor can ${action} during lost-save recovery; acknowledgement preserves the surviving identity and the replacement receives a distinct identity`);
  }
}
