import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {richFixture,RICH_VALUES,DIAGRAM,LONG_TEXT} from './rich-fixtures.mjs';
import {RICH_FIELDS,richScenarios} from './rich-definitions.mjs';

test('rich fixture contains every capture target, independent editable records and embedded media',async t=>{
  const previous=process.env.CEDAR_HOME;
  process.env.CEDAR_HOME=fileURLToPath(new URL('../../../../',import.meta.url));
  t.after(()=>{if(previous===undefined)delete process.env.CEDAR_HOME;else process.env.CEDAR_HOME=previous;});
  const writes=[];
  const session={put:async(collection,body,folder)=>{const id='https://repo.test/'+collection+'/'+writes.length;writes.push({collection,body,folder,id});return id;}};
  const fixture=await richFixture(session,'owned-folder','UI review unit fixture',{widths:[1440,375]});
  const template=writes.find(w=>w.collection==='templates').body;
  for(const [,label] of RICH_FIELDS)assert(template.properties[label],label);
  assert(!template.required.includes('Collection diagram'));
  assert(!template.required.includes('Study instructions'));
  assert.match(DIAGRAM,/^data:image\/svg\+xml;base64,/);
  assert.match(template.properties['Study instructions']._ui._content,/<h2>.*<ul>/);
  assert.equal(template.properties['Collection diagram']._ui._content,DIAGRAM);
  for(const name of Object.keys(RICH_VALUES)){
    const value=template.properties[name],field=value.items??value;
    assert.equal(field._valueConstraints?.defaultValue,undefined,name+' must not perform a default lookup');
    assert(!(field._valueConstraints?.literals??[]).some(v=>v.selectedByDefault),name);
  }
  const records=writes.filter(w=>w.collection==='template-instances');
  assert.equal(records.length,3);assert.equal(new Set(records.map(r=>r.id)).size,3);
  assert(writes.every(w=>w.folder==='owned-folder'));
  assert(records.every(r=>r.body['schema:isBasedOn']===fixture.template));
  records[1].body.Text['@value']='changed';
  assert.equal(records[0].body.Text['@value'],LONG_TEXT);
  assert.equal(records[2].body.Text['@value'],LONG_TEXT);
  assert.equal(RICH_VALUES.Text['@value'],LONG_TEXT);
});

test('rich coverage pairs editing and reading at both widths and adds real interaction outcomes',()=>{
  const metadata=richScenarios('metadata-editor',[1440,375]),publicStates=richScenarios('openview',[1440,375]);
  assert.equal(metadata.length,102);assert.equal(publicStates.length,42);
  assert.equal(new Set(metadata.map(s=>s.id)).size,metadata.length);
  for(const width of [1440,375])for(const [slug] of RICH_FIELDS){
    for(const mode of ['populated','readonly'])assert(metadata.some(s=>s.id===`rich-${mode}-${slug}-${width}`));
    assert(publicStates.some(s=>s.id===`rich-readonly-${slug}-${width}`));
  }
  for(const suffix of ['multiselect-changed','validation-corrected','term-selected','term-cleared','attribute-readonly'])
    assert(metadata.some(s=>s.id===`rich-${suffix}-375`));
});
