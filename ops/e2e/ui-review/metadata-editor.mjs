import assert from 'node:assert/strict';
import {metadataFixtures} from './fixtures.mjs';
import {WIDTHS, PAIRED_WIDTHS, METADATA_TYPES, METADATA_INVALID} from './catalog.mjs';
import {RESOURCE,USER_SERVER,GROUP_SERVER} from '../rest/lib.mjs';
import {pointer,keyboard,folderPage,textSizeStates,holdRequests,refuseConnections,staleRevision} from './interactions.mjs';
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
  // A value each of three types refuses, entered and left, then the list and date pickers open.
  for(const [slug,label,text] of METADATA_INVALID)await record(`type-${slug}-invalid-1440`,async()=>{
    const input=cee.getByRole('textbox',{name:label,exact:true});
    await input.fill(text);await input.press('Tab');await centre(input);
  },`"${text}" entered and left.`);
  await record('type-single-select-list-open-1440',async()=>{
    const select=cee.getByRole('combobox',{name:'Single select list',exact:true});
    await centre(select);await tap(select);await page.getByRole('listbox').first().waitFor();
  });
  await page.keyboard.press('Escape');await page.getByRole('listbox').first().waitFor({state:'hidden'});
  await record('type-date-open-1440',async()=>{
    await centre(cee.getByRole('textbox',{name:'Date, select date',exact:true}));
    await tap(cee.getByRole('button',{name:'Open calendar',exact:true}));await page.locator('mat-calendar').first().waitFor();
  });
  await page.keyboard.press('Escape');await page.locator('mat-calendar').first().waitFor({state:'hidden'});
  // The new record now holds unsaved values, so leaving it answers the editor's leave-page prompt.
  const leaveAnyway=dialog=>void dialog.accept();
  page.on('dialog',leaveAnyway);
  // The static corpus template opens with a page break, so its first page is empty and the static
  // content is on page 2.
  try{await record('static-fields-1440',()=>open(f.corpus.staticFields,'create'));}finally{page.off('dialog',leaveAnyway);}
  await record('static-fields-page-2-1440',async()=>{
    await tap(cee.getByRole('option',{name:'2',exact:true}).first());
    await cee.getByRole('option',{name:'2',exact:true,selected:true}).first().waitFor();
  });
  // The corpus field's preferred label, which the editor shows in place of its name.
  await record('attribute-value-1440',async()=>{await open(f.corpus.attributeValue,'create');await centre(cee.getByText(/^Attribute Value\b/));});
  // Slow loading, a backend the browser cannot reach during a save and a save someone else's has
  // overtaken, each caused in the review browser alone. The server answers the overtaken save itself.
  // A failed save leaves its edits on the page, so leaving it answers the leave-page prompt.
  const alert=page.locator('main p.alert[role="alert"]');
  const failedSave=async(id,value,fail)=>{
    await open(id);await cee.getByRole('textbox',{name:'Subject',exact:true}).fill(value);await status('Modified').waitFor();
    const restore=await fail();await tap(page.locator('#button-save-metadata'));await alert.waitFor();return restore;
  };
  page.on('dialog',leaveAnyway);
  try{
    // A time field and a date-time field that records its offset, on a form short enough to show both.
    await record('type-temporal-1440',async()=>{
      await open(f.corpus.temporal,'create');await cee.getByText('Complex datetime preferred',{exact:true}).first().waitFor();
    });
    // A list with fewer entries than its minimum, reported under the field once the warning takes the user there.
    await record('list-too-short-1440',async()=>{
      await open(f.tooFew);await save();
      const warnings=page.getByRole('group',{name:'Metadata warnings',exact:true});
      await tap(warnings.locator('summary'));await tap(warnings.getByRole('button',{name:/^Observations/}));
      await cee.locator('app-cedar-field-problems').filter({hasText:/\S/}).first().waitFor();
    },'A stored record with one Observations entry where the template asks for two, saved and then followed from its warning.');
    // A record saved with a link, then read in Workspace's preview, where the link and each choice
    // field's constraints are stated rather than edited.
    let linked;
    await record('readonly-link-1440',async()=>{
      await open(f.corpus.saved,'create');
      const link=cee.getByRole('textbox',{name:'Link',exact:true});
      await link.fill('https://example.org/specimens/42');await link.press('Tab');await save();
      await page.waitForURL(/\/instances\/edit\//);
      // The editor's address holds the record's short identifier; Workspace keys its row by the full one.
      linked=decodeURIComponent(page.url().split('/instances/edit/')[1].split('?')[0]).split('/').at(-1);
      await folderPage(session,f.folder);await tap(page.locator(`[data-preview-id$="/${linked}"]`));
      await preview.locator('section[aria-busy="false"]').waitFor();
      await centre(preview.getByText('Link',{exact:true}));
    },'A record saved with only its link filled in, in Workspace\'s read-only preview.');
    await record('readonly-choices-1440',()=>centre(preview.getByText('Radio',{exact:true})));
    await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
    for(const width of PAIRED_WIDTHS){
      const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
      await page.setViewportSize({width,height:width===1440?1000:667});
      let held,restore;
      await r('loading',async()=>{
        held=await holdRequests(page,url=>url.origin===new URL(RESOURCE).origin,{held:request=>request.method()==='GET',label:'Record opening'});
        await page.goto(session.base+'/instances/edit/'+encodeURIComponent(f.records[2])+'?'+new URLSearchParams({folderId:f.folder}),{waitUntil:'domcontentloaded'});
        await held.started();
      },'The harness holds the record\'s responses to show loading; the server is not slow.');
      await held?.release();await ready();
      await r('save-unreachable',async()=>{
        restore=await failedSave(f.failing['unreachable-'+width],'Unsaved specimen '+width,
          ()=>refuseConnections(session,[RESOURCE,USER_SERVER,GROUP_SERVER],'Deliberately unreachable CEDAR servers'));
      },'The harness drops every request to the CEDAR servers, as a lost connection does, then saves an edited record.');
      await restore?.();restore=null;
      await r('save-conflict',async()=>{
        restore=await failedSave(f.failing['conflict-'+width],'Overtaken specimen '+width,
          ()=>staleRevision(session,url=>url.origin===new URL(RESOURCE).origin,'Deliberately overtaken save'));
        await alert.filter({hasText:/changed/i}).waitFor();
      },'The harness sends the save with the revision before the one the editor read, as when someone else saved first; the server refused it and nothing changed.');
      await restore?.();restore=null;
      await r('leave-confirmation',async()=>{
        await open(f.failing['leave-'+width]);await cee.getByRole('textbox',{name:'Subject',exact:true}).fill('Abandoned specimen '+width);
        await status('Modified').waitFor();
        await tap(page.locator('cedar-workspace-return button'));await page.locator('dialog.confirmation-dialog[open]').waitFor();
      },'Going back to Workspace with unsaved edits asks before discarding them.');
      await tap(page.locator('dialog.confirmation-dialog[open]').getByRole('button',{name:'Yes',exact:true}));
      await page.locator('.table-scroll[aria-busy="false"]').waitFor();
    }
    await textSizeStates(session,record,()=>open(f.records[5]));
  }finally{page.off('dialog',leaveAnyway);}
}
