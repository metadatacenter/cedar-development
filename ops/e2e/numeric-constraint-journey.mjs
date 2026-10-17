import assert from 'node:assert/strict';
import {artifactBody, call, mutate, enc} from './rest/lib.mjs';
import {focused,journeyFolder} from './journey-fixtures.mjs';
import {editorStatus} from './metadata-journey-fixtures.mjs';

// The journey acts as the runner's first test user only and never signs in as another account.
export async function numericConstraintJourney({page,base,user,folderId,name,created,write,pass}) {
  folderId=await journeyFolder({user,folderId,name,created},'numeric constraints');
  async function create(collection,body) {
    const r=await call(user.auth,'POST','/'+collection+'?folder_id='+enc(folderId),body);
    assert.equal(r.status,201,r.text);created.push({collection,id:r.body['@id']});return r.body['@id'];
  }
  const template=artifactBody('template',name+' numeric constraints');
  for(const key of ['Low','High','Keep']) {
    const field=artifactBody('field',key);
    if(key!=='Keep') {field._ui.inputType='numeric';field._valueConstraints={requiredValue:false,numberType:'xsd:decimal'};field.required=['@value','@type'];}
    template.properties[key]=field;template.properties['@context'].properties[key]={enum:['https://example.org/numeric/'+key]};
    template._ui.order.push(key);template._ui.propertyLabels[key]=key;template.required.push(key);
  }
  const tid=await create('templates',template);
  const instance=artifactBody('instance',name+' numeric answers',{'schema:isBasedOn':tid,
    Low:{'@value':'100','@type':'xsd:decimal'},High:{'@value':'200','@type':'xsd:decimal'},Keep:{'@value':'Preserved'}});
  for(const key of ['Low','High','Keep'])instance['@context'][key]='https://example.org/numeric/'+key;
  instance['@context']['pav:derivedFrom']={'@type':'@id'};
  const id=await create('template-instances',instance),path='/template-instances/'+enc(id);
  const before=await call(user.auth,'GET',path);
  await page.goto(base+'/instances/edit/'+enc(id));
  const cee=page.locator('cedar-embeddable-editor'),low=cee.getByLabel('Low',{exact:true}),high=cee.getByLabel('High',{exact:true});
  // Tighten the template only once the editor holds the earlier one and the answers to it.
  await editorStatus(page,/^Unmodified$/).waitFor();
  await low.fill('125');await high.fill('190');await editorStatus(page,/^Modified$/).waitFor();
  const latest=(await call(user.auth,'GET','/templates/'+enc(tid))).body;
  for(const key of ['Low','High'])Object.assign(latest.properties[key]._valueConstraints,{minValue:150,maxValue:175});
  const tightened=await mutate(user.auth,'PUT','/templates/'+enc(tid),latest);assert.equal(tightened.status,200,tightened.text);
  const save=page.locator('#button-save-metadata');
  const rejected=await write(page,'PUT','/template-instances/',()=>save.click(),400,true);
  for(const [key,message] of [['Low','Below the minimum 150.'],['High','Above the maximum 175.']])
    assert.ok(rejected.objects.validationReport.errors.some(e=>e.location==='/'+key+'/@value'&&e.message===message),JSON.stringify(rejected));
  const unchanged=await call(user.auth,'GET',path);assert.deepEqual(unchanged.body,before.body);assert.equal(unchanged.headers.get('etag'),before.headers.get('etag'));
  // The editor lists the server's findings once it has handled the refusal.
  const issues=page.getByLabel('Metadata errors',{exact:true});await issues.waitFor();
  assert.equal(await low.inputValue(),'125');assert.equal(await high.inputValue(),'190');assert.equal(await save.isDisabled(),true);
  await issues.locator('summary').click();
  const finding=key=>issues.getByRole('button',{name:new RegExp(key+'.*(minimum|maximum)')});
  for(const key of ['Low','High'])await finding(key).waitFor();
  await finding('Low').click();
  await focused(low,'Finding did not focus Low');
  await low.fill('150');
  // The findings are the server's verdict on the draft it rejected, so the first edit withdraws them
  // all, the one for High included. Waiting for that, rather than racing it, is what keeps the next
  // step deterministic.
  await issues.waitFor({state:'hidden'});
  await high.fill('175');
  await write(page,'PUT','/template-instances/',()=>save.click(),200,true);
  await page.locator('.metadata-save-status').filter({hasText:/^Saved$/}).waitFor();
  const after=(await call(user.auth,'GET',path)).body,expected=structuredClone(before.body);
  expected.Low['@value']='150';expected.High['@value']='175';
  for(const value of [after,expected]) {delete value['pav:lastUpdatedOn'];delete value['oslc:modifiedBy'];}
  assert.deepEqual(after,expected);await page.reload();
  await editorStatus(page,/^Unmodified$/).waitFor();await low.waitFor();assert.equal(await low.inputValue(),'150');assert.equal(await high.inputValue(),'175');
  assert.equal(await cee.getByLabel('Keep',{exact:true}).inputValue(),'Preserved');
  pass('New numeric bounds reject stale Editor answers at the real server, list both findings, locate an answer from its finding, withdraw the findings once the answers change, and accept exact boundaries without changing other content');
}
