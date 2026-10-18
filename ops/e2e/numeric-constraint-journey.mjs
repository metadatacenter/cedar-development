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
  const report=await call(user.auth,'POST','/command/validate?resource_type=instance',{
    ...before.body,Low:{'@value':'125','@type':'xsd:decimal'},High:{'@value':'190','@type':'xsd:decimal'},
  });
  assert.equal(report.status,200,report.text);
  assert.equal(report.body.canSave,true);assert.equal(report.body.isValid,false);assert.equal(report.body.validates,'true');
  for(const key of ['Low','High'])assert.ok(report.body.warnings.some(e=>e.location==='/'+key+'/@value'),report.text);
  const save=page.locator('#button-save-metadata');
  await write(page,'PUT','/template-instances/',()=>save.click(),200,true);
  await page.locator('.metadata-save-status').filter({hasText:/^Saved$/}).waitFor();
  const saved=await call(user.auth,'GET',path),expected=structuredClone(before.body);
  expected.Low['@value']='125';expected.High['@value']='190';
  const content=value=>{const copy=structuredClone(value);delete copy['pav:lastUpdatedOn'];delete copy['oslc:modifiedBy'];return copy;};
  assert.deepEqual(content(saved.body),content(expected));
  assert.notEqual(saved.headers.get('etag'),before.headers.get('etag'));
  // Loading the current template exposes value-quality warnings while retaining both stored answers.
  await page.reload();await editorStatus(page,/^Unmodified$/).waitFor();
  const issues=page.getByLabel('Metadata warnings',{exact:true});await issues.waitFor();
  await issues.locator('summary').click();
  await issues.getByRole('button',{name:'Low: Value should be at least 150.',exact:true}).waitFor();
  await issues.getByRole('button',{name:'High: Value should be at most 175.',exact:true}).waitFor();
  assert.equal(await issues.locator('li').count(),2);
  assert.equal(await page.getByLabel('Metadata errors',{exact:true}).count(),0);
  assert.equal(await low.inputValue(),'125');assert.equal(await high.inputValue(),'190');
  assert.equal(await cee.getByLabel('Keep',{exact:true}).inputValue(),'Preserved');
  await page.waitForFunction(()=>{const r=document.querySelector('cedar-embeddable-editor')?.dataQualityReport;return r?.canSave===true&&r?.isValid===false;});
  const quality=await page.evaluate(()=>document.querySelector('cedar-embeddable-editor').dataQualityReport);
  assert.equal(quality.structurallyValid,true);
  for(const [key,code] of [['Low','minValue'],['High','maxValue']])assert.ok(quality.problems.some(problem=>
    problem.path.join('/')===key&&problem.code===code&&problem.category==='constraint'&&problem.blocksSave===false),JSON.stringify(quality));
  await issues.getByRole('button',{name:'Low: Value should be at least 150.',exact:true}).click();
  await focused(low,'Quality warning did not focus Low');
  await issues.getByRole('button',{name:'High: Value should be at most 175.',exact:true}).click();
  await focused(high,'Quality warning did not focus High');
  await low.fill('150');await high.fill('175');
  await issues.waitFor({state:'hidden'});
  await write(page,'PUT','/template-instances/',()=>save.click(),200,true);
  await page.locator('.metadata-save-status').filter({hasText:/^Saved$/}).waitFor();
  const after=(await call(user.auth,'GET',path)).body;
  expected.Low['@value']='150';expected.High['@value']='175';
  assert.deepEqual(content(after),content(expected));await page.reload();
  await editorStatus(page,/^Unmodified$/).waitFor();await low.waitFor();
  assert.equal(await low.inputValue(),'150');assert.equal(await high.inputValue(),'175');
  assert.equal(await cee.getByLabel('Keep',{exact:true}).inputValue(),'Preserved');
  await page.getByLabel('Metadata warnings',{exact:true}).waitFor({state:'hidden'});
  pass('tightened-bounds','New numeric bounds retain saveable stale Editor answers, report both quality warnings on reload, and accept exact boundary corrections without changing other content');
}
