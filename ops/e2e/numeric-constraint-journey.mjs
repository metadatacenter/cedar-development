import assert from 'node:assert/strict';
import {artifactBody, call, mutate, enc} from './rest/lib.mjs';
import {journeyFolder} from './journey-fixtures.mjs';

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
  await low.fill('125');await high.fill('190');
  const latest=(await call(user.auth,'GET','/templates/'+enc(tid))).body;
  for(const key of ['Low','High'])Object.assign(latest.properties[key]._valueConstraints,{minValue:150,maxValue:175});
  const tightened=await mutate(user.auth,'PUT','/templates/'+enc(tid),latest);assert.equal(tightened.status,200,tightened.text);
  const save=page.locator('#button-save-metadata');
  const rejected=await write(page,'PUT','/template-instances/',()=>save.click(),400,true);
  for(const [key,message] of [['Low','Below the minimum 150.'],['High','Above the maximum 175.']])
    assert.ok(rejected.objects.validationReport.errors.some(e=>e.location==='/'+key+'/@value'&&e.message===message),JSON.stringify(rejected));
  const unchanged=await call(user.auth,'GET',path);assert.deepEqual(unchanged.body,before.body);assert.equal(unchanged.headers.get('etag'),before.headers.get('etag'));
  assert.equal(await low.inputValue(),'125');assert.equal(await high.inputValue(),'190');assert.equal(await save.isDisabled(),true);
  const issues=page.getByLabel('Metadata errors',{exact:true});await issues.locator('summary').click();
  for(const [key,input,value] of [['Low',low,'150'],['High',high,'175']]) {
    if(await issues.isVisible()) {
      const finding=issues.getByRole('button',{name:new RegExp(key+'.*(minimum|maximum)')});
      if(await finding.count()) {await finding.click();await input.evaluate(el=>{if(el.getRootNode().activeElement!==el)throw new Error('Finding did not focus '+el.id);});}
    }
    await input.fill(value);
  }
  await write(page,'PUT','/template-instances/',()=>save.click(),200,true);
  await page.locator('.metadata-save-status').filter({hasText:/^Saved$/}).waitFor();
  const after=(await call(user.auth,'GET',path)).body,expected=structuredClone(before.body);
  expected.Low['@value']='150';expected.High['@value']='175';
  for(const value of [after,expected]) {delete value['pav:lastUpdatedOn'];delete value['oslc:modifiedBy'];}
  assert.deepEqual(after,expected);await page.reload();
  await low.waitFor();assert.equal(await low.inputValue(),'150');assert.equal(await high.inputValue(),'175');
  assert.equal(await cee.getByLabel('Keep',{exact:true}).inputValue(),'Preserved');
  pass('New numeric bounds reject stale Editor answers at the real server, locate both answers and accept exact boundaries without changing other content');
}
