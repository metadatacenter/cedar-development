import assert from 'node:assert/strict';
import {RICH_FIELDS} from './rich-definitions.mjs';
import {richFixture,LONG_TEXT,RICH_VALUES} from './rich-fixtures.mjs';
import {captureJourney} from './journeys.mjs';
import {pointer,waitForPage,folderPage} from './interactions.mjs';
import {PAIRED_WIDTHS} from './catalog.mjs';

export async function showRichField(root,slug,label) {
  const target=slug==='image'?root.locator('app-cedar-static-image img')
    :slug==='rich-text'?root.getByRole('heading',{name:'Before collecting a specimen',exact:true})
    :root.getByText(label,{exact:true}).first();
  await target.waitFor({state:'visible'});
  await target.evaluate(node=>node.scrollIntoView({block:'center'}));
  if(slug==='image')assert(await target.evaluate(node=>node.complete&&node.naturalWidth>0),'Authored image did not load');
  assert(await target.evaluate(node=>{const b=node.getBoundingClientRect();return b.width>0&&b.height>0&&b.bottom>0&&b.top<innerHeight;}),`Rich field ${label} is outside the viewport`);
}
function relate(session,ids) {
  const present=session.states.filter(s=>ids.includes(s.id));
  for(const state of present)state.relatedStates=[...new Set([...(state.relatedStates??[]),...present.filter(s=>s!==state).map(s=>s.id)])];
}
export async function collectRichMetadata(session,record,{folder,open,save,attributeTemplate}) {
  const {page}=session,fixture=await richFixture(session,folder,'UI review rich specimen',{widths:PAIRED_WIDTHS});
  const cee=page.locator('cedar-embeddable-editor'),preview=page.locator('dialog.artifact-preview');
  const tap=locator=>pointer(session,locator);
  const previewRecord=async id=>{
    await folderPage(session,folder);
    await tap(page.locator(`[data-preview-id="${id}"]`));
    await preview.locator('section[aria-busy="false"]').waitFor();
  };
  for(const width of PAIRED_WIDTHS){
    const r=(id,fn,note)=>record(`rich-${id}-${width}`,fn,note);
    await captureJourney(session,record,`rich-values-${width}`,async()=>{
      await page.setViewportSize({width,height:width===1440?1000:667});await open(fixture.editable[width]);
      await session.action('Verify the populated fixture reached the form',async()=>assert.equal(await cee.getByRole('textbox',{name:'Text',exact:true}).inputValue(),LONG_TEXT));
      for(const [slug,label] of RICH_FIELDS)await r('populated-'+slug,()=>showRichField(cee,slug,label),
        'A stored fixture value in the editable form. Authority identifiers carry stored fixture labels; no external authority lookup is claimed.');
    });
    await captureJourney(session,record,`rich-readonly-${width}`,async()=>{
      await page.setViewportSize({width,height:width===1440?1000:667});await previewRecord(fixture.record);
      for(const [slug,label] of RICH_FIELDS)await r('readonly-'+slug,()=>showRichField(preview,slug,label),
        'The same populated fixture in Workspace’s read-only preview; the saved record remains unchanged.');
      await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
    });
    await captureJourney(session,record,`rich-choices-validation-${width}`,async()=>{
      await page.setViewportSize({width,height:width===1440?1000:667});await open(fixture.editable[width]);
      const select=cee.getByRole('combobox',{name:'Multi select list',exact:true});
      await r('multiselect-open',async()=>{await tap(select);await page.getByRole('option',{name:'Alpha',exact:true,selected:true}).waitFor();await page.getByRole('option',{name:'Beta',exact:true,selected:true}).waitFor();});
      await r('multiselect-changed',async()=>{
        await tap(page.getByRole('option',{name:'Alpha',exact:true}));
        await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'hidden'});
        assert.equal((await select.innerText()).trim(),'Beta');
      },'Alpha is deselected through the open picker; Beta remains selected.');
      const email=cee.getByRole('textbox',{name:'Email',exact:true});
      await r('validation',async()=>{
        await email.fill('not an email');await email.press('Tab');await showRichField(cee,'email','Email');
        await waitForPage(page,node=>node.getAttribute('aria-invalid')==='true',await email.elementHandle());
      });
      await r('validation-corrected',async()=>{
        await email.fill(RICH_VALUES.Email['@value']);await email.press('Tab');await showRichField(cee,'email','Email');
        await waitForPage(page,node=>node.getAttribute('aria-invalid')!=='true',await email.elementHandle());
      });
      await session.action('Save and verify the selected fixture value',async()=>{
      await save();
      const stored=await session.request('GET','/template-instances/'+encodeURIComponent(fixture.editable[width]));
      assert.equal(stored.status,200);assert.deepEqual(stored.body['Multi select list'].map(v=>v['@value']),['Beta']);
      });
    });
    await captureJourney(session,record,`rich-term-selection-${width}`,async()=>{
      await page.setViewportSize({width,height:width===1440?1000:667});await open(fixture.editable[width]);
      const input=cee.getByRole('combobox',{name:'Controlled term',exact:true});
      await r('term-suggestions',async()=>{
        await showRichField(cee,'controlled-term','Controlled term');
        await input.fill('melano');
        await page.getByRole('option',{name:'melanoma',exact:true}).waitFor();
      },'Real suggestions from the configured local terminology service; the collector does not fabricate a response.');
      await r('term-selected',async()=>{
        await pointer(session,page.getByRole('option',{name:'melanoma',exact:true}),{scroll:false});await input.press('Tab');
        assert.equal(await input.inputValue(),'melanoma');await showRichField(cee,'controlled-term','Controlled term');
      });
      await session.action('Save and verify the selected fixture value',async()=>{
      await save();
      const stored=await session.request('GET','/template-instances/'+encodeURIComponent(fixture.editable[width]));
      assert.equal(stored.body['Controlled term']['@id'],RICH_VALUES['Controlled term']['@id']);
      });
      await r('term-cleared',async()=>{
        await tap(cee.locator('app-cedar-input-controlled').getByRole('button',{name:'Clear',exact:true}));
        assert.equal(await input.inputValue(),'');await page.keyboard.press('Escape');
      });
    });
    await captureJourney(session,record,`rich-attribute-${width}`,async()=>{
      await page.setViewportSize({width,height:width===1440?1000:667});await open(attributeTemplate,'create');
      await r('attribute-populated',async()=>{
        await tap(cee.getByRole('button',{name:'Add empty instance here',exact:true}));
        await cee.getByRole('textbox',{name:'Attribute Name',exact:true}).fill('Collection conditions');
        await cee.getByRole('textbox',{name:'Attribute Value',exact:true}).fill(LONG_TEXT);
        await cee.getByRole('textbox',{name:'Attribute Value',exact:true}).press('Tab');
      });
      await save();await page.waitForURL(/\/instances\/edit\//);
      const id=decodeURIComponent(page.url().split('/instances/edit/')[1].split('?')[0]).split('/').at(-1);
      await r('attribute-readonly',async()=>{
        await folderPage(session,folder);await tap(page.locator(`[data-preview-id$="/${id}"]`));
        await preview.locator('section[aria-busy="false"]').waitFor();
        const value=preview.getByRole('textbox',{name:'Attribute Value',exact:true});
        assert.equal(await value.inputValue(),LONG_TEXT);await value.scrollIntoViewIfNeeded();
      });
      await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
    });
    for(const [slug] of RICH_FIELDS)relate(session,[`rich-populated-${slug}-${width}`,`rich-readonly-${slug}-${width}`]);
    for(const group of [['multiselect-open','multiselect-changed'],['validation','validation-corrected'],['term-suggestions','term-selected','term-cleared'],['attribute-populated','attribute-readonly']])relate(session,group.map(id=>`rich-${id}-${width}`));
  }
}
