import assert from 'node:assert/strict';
import {metadataFixtures} from './fixtures.mjs';
import {WIDTHS, METADATA_TYPES} from './catalog.mjs';
import {pointer,keyboard,folderPage,textSizeStates} from './interactions.mjs';
export async function collectMetadataEditor(session,record) {
  const {page}=session;await session.login();const f=await metadataFixtures(session);
  const status=text=>page.locator('.metadata-toolbar [role=status]').filter({hasText:text});
  async function ready(){
    await page.locator('#instance-name').waitFor();
    await page.waitForFunction(()=>{
      const status=document.querySelector('.metadata-toolbar [role=status]')?.textContent;
      return status&&/Unmodified|Modified|Saved/.test(status);
    });
    await page.locator('cedar-embeddable-editor h1').waitFor();
  }
  async function open(id,mode='edit'){
    await page.goto(session.base+'/instances/'+mode+'/'+encodeURIComponent(id)+'?'+new URLSearchParams({folderId:f.folder}));
    await ready();
  }
  const cee=page.locator('cedar-embeddable-editor');
  const pager=()=>cee.locator('app-cedar-multi-pager').first();
  const tap=locator=>pointer(session,locator);
  const save=async()=>{await tap(page.locator('#button-save-metadata'));await status('Saved').waitFor();};
  // Tags is the form's first repeating field, so its occurrence actions come first.
  const tagAction=name=>cee.getByRole('button',{name,exact:true}).first();
  const option=n=>pager().getByRole('option',{name:String(n),exact:true});
  const preview=page.locator('dialog.artifact-preview');
  for(const width of WIDTHS){
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    for(const count of [0,1,2,5,6,12])await r('occurrences-'+count,async()=>{
      await open(f.records[count]);await pager().scrollIntoViewIfNeeded();
    });
    await r('last-page',async()=>{
      const next=pager().getByRole('button',{name:'Next page',exact:true});
      for(let i=0;i<2;i++)await tap(next);
      await option(12).waitFor();
      await tap(option(12));
    });
    await r('previous-page',async()=>{await tap(pager().getByRole('button',{name:'Previous page',exact:true}));await option(6).waitFor();});
    await r('long-labels',()=>cee.locator('app-cedar-multi-pager').nth(1).scrollIntoViewIfNeeded());
    await r('nested',async()=>{await cee.locator('mat-expansion-panel').first().scrollIntoViewIfNeeded();});
    await r('nested-end',async()=>{await cee.locator('mat-expansion-panel').last().getByRole('textbox').last().scrollIntoViewIfNeeded();});
    await r('keyboard',()=>keyboard(session,cee.getByRole('textbox',{name:'Subject',exact:true})));
    const value='Reviewed specimen '+width;
    await r('edited',async()=>{await cee.getByRole('textbox',{name:'Subject',exact:true}).fill(value);await status('Modified').waitFor();});
    await r('saved',async()=>{
      await save();
      const result=await session.request('GET','/template-instances/'+encodeURIComponent(f.records[12]));
      assert.equal(result.status,200);assert.equal(result.body.Subject['@value'],value);
    });
    await r('reopened',async()=>{await open(f.records[12]);assert.equal(await cee.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),value);});
    // Occurrence actions on this width's own one-tag record: add an empty tag, copy it, delete the copy.
    await r('occurrence-added',async()=>{
      await open(f.editable[width]);await tagAction('Add empty instance here').scrollIntoViewIfNeeded();
      await tap(tagAction('Add empty instance here'));await option(2).waitFor();await status('Modified').waitFor();
    });
    await r('occurrence-copied',async()=>{await tap(tagAction('Add copy of this instance'));await option(3).waitFor();});
    await r('occurrence-deleted',async()=>{await tap(tagAction('Delete current'));await option(3).waitFor({state:'detached'});});
    await save();
    await r('collapsed-all',async()=>{
      await open(f.records[5]);await tap(page.getByRole('button',{name:'Collapse All',exact:true}));
      await cee.locator('mat-expansion-panel.mat-expanded').first().waitFor({state:'detached'});
    });
    await tap(page.getByRole('button',{name:'Expand All',exact:true}));
    await r('download-menu',async()=>{await tap(page.getByRole('button',{name:'Download',exact:true}));await page.getByRole('menuitem').first().waitFor();});
    await page.keyboard.press('Escape');
    await r('readonly-top',async()=>{
      await folderPage(session,f.folder);await tap(page.locator(`[data-preview-id="${f.records[12]}"]`));
      await preview.locator('section[aria-busy="false"]').waitFor();
    },'Workspace\'s read-only preview of a saved record.');
    await r('readonly-repeated',()=>preview.getByRole('textbox',{name:'Tags',exact:true}).first().scrollIntoViewIfNeeded());
    await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
    await r('new-record',()=>open(f.templateId,'create'));
    // Saving without the required Subject stores the record and reports a warning.
    const warnings=page.getByRole('group',{name:'Metadata warnings',exact:true});
    await r('save-warning',async()=>{await save();await warnings.waitFor();});
    await r('warning-expanded',async()=>{
      await tap(warnings.locator('summary'));await warnings.getByRole('button',{name:/^Subject: /}).waitFor();
    });
    await r('warning-jump',async()=>{
      await tap(warnings.getByRole('button',{name:/^Subject: /}));
      await page.waitForFunction(()=>{let n=document.activeElement;while(n?.shadowRoot?.activeElement)n=n.shadowRoot.activeElement;return n?.matches?.('input,textarea');});
    },'Following the warning moves focus to the field it names.');
    await r('empty-name-saved',async()=>{
      await page.locator('#instance-name').fill('');await save();
      assert.notEqual(await page.locator('#instance-name').inputValue(),'','A saved record keeps a generated name');
    },'Saving with an empty record name.');
    await r('empty-template',()=>open(f.emptyTemplateId,'create'));
  }
  // New records from the corpus templates that together hold every input type, each field centred.
  await page.setViewportSize({width:1440,height:1000});
  const centre=locator=>locator.first().evaluate(element=>element.scrollIntoView({block:'center'}));
  await open(f.corpus.fieldTypes,'create');
  for(const [slug,label] of METADATA_TYPES)await record(`type-${slug}-1440`,()=>centre(cee.getByText(label,{exact:true})));
  // The static corpus template opens with a page break, so its first page is empty and the static
  // content is on page 2.
  await record('static-fields-1440',()=>open(f.corpus.staticFields,'create'));
  await record('static-fields-page-2-1440',async()=>{
    await tap(cee.getByRole('option',{name:'2',exact:true}).first());
    await cee.getByRole('option',{name:'2',exact:true,selected:true}).first().waitFor();
  });
  // The corpus field's preferred label, which the editor shows in place of its name.
  await record('attribute-value-1440',async()=>{await open(f.corpus.attributeValue,'create');await centre(cee.getByText(/^Attribute Value\b/));});
  await textSizeStates(session,record,()=>open(f.records[5]));
}
