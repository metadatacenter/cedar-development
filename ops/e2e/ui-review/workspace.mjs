import {workspaceFixtures} from './fixtures.mjs';
import {WIDTHS} from './catalog.mjs';
import {folderPage,listingReady,pointer,keyboard,setChecked,textSizeStates} from './interactions.mjs';

export async function collectWorkspace(session,record) {
  const {page}=session;
  await session.login();
  const f=await workspaceFixtures(session);
  const button=name=>page.getByRole('button',{name,exact:true});
  const tap=locator=>pointer(session,locator);
  const navigation=page.getByRole('complementary',{name:'Workspace navigation'});
  const filters=page.getByRole('group',{name:'Resource filters'});
  const dialog=page.getByRole('dialog');
  const panel=async(which,shown)=>{
    const control=page.locator(`[aria-controls="workspace-${which}"]`);
    if(await control.getAttribute('aria-expanded')!==String(shown))await tap(control);
    await page.locator('#workspace-'+which).waitFor({state:shown?'visible':'hidden'});
  };
  // Search reads an index the worker fills asynchronously. Wait until the review's own root folder
  // is searchable, as a user would wait for a new folder to appear, before searching for it.
  let searchable=false;
  const indexed=async()=>{
    const query='/search?'+new URLSearchParams({q:f.rootName,resource_types:'folder',version:'all',publication_status:'all',limit:'100',sort:'name',offset:'0'});
    for(const deadline=Date.now()+90000;!searchable;await new Promise(resolve=>setTimeout(resolve,500))){
      const reply=await session.request('GET',query);
      searchable=reply.status===200&&(reply.body?.resources??[]).some(r=>r['@id']===f.root);
      if(!searchable&&Date.now()>deadline)throw new Error('The review root folder never became searchable');
    }
  };
  const closeDialog=async()=>{await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});};
  const preview=async id=>{
    await folderPage(session,f.previews);
    await tap(page.locator(`[data-preview-id="${id}"]`));
    await page.locator('dialog.artifact-preview section[aria-busy="false"]').waitFor();
    if(await page.locator('dialog.artifact-preview [role="alert"]').count())throw new Error('Preview reports an error');
  };
  for(const width of WIDTHS){
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    await r('empty-list',async()=>{await folderPage(session,f.empty,[]);await panel('navigation',true);await panel('information',false);});
    await r('empty-grid',async()=>{await tap(button('Grid view'));await listingReady(page,[]);});
    await r('populated-list',()=>folderPage(session,f.listing,f.rows.slice(0,50)));
    await r('next-page',async()=>{await tap(button('Next'));await listingReady(page,f.rows.slice(50));});
    await r('previous-page',async()=>{await tap(button('Previous'));await listingReady(page,f.rows.slice(0,50));});
    await r('row-actions',async()=>{
      await page.locator('.table-scroll').evaluate(n=>{n.scrollLeft=n.scrollWidth;});
      await tap(page.locator('tbody tr').first().getByRole('button',{name:/^Actions for/}));
      await page.locator('#resource-menu').waitFor();
    });
    await page.keyboard.press('Escape');
    await r('details-open',async()=>{
      await page.locator('.table-scroll').evaluate(n=>{n.scrollLeft=0;});
      await tap(page.locator('tbody tr').first().locator('.resource-icon'));
      await panel('information',true);await page.locator('#information-name').waitFor();
    });
    await r('details-closed',()=>panel('information',false));
    // Each panel arrangement the two toggles allow, beyond both open.
    await r('panels-details-only',async()=>{await panel('navigation',false);await panel('information',true);});
    await r('panels-none',()=>panel('information',false));
    await r('panels-navigation-only',()=>panel('navigation',true));
    await r('populated-grid',async()=>{await tap(button('Grid view'));await listingReady(page,f.rows.slice(0,50));});
    await r('new-menu',async()=>{await tap(navigation.getByRole('button',{name:'New',exact:true}));await navigation.getByRole('button',{name:'Folder',exact:true}).waitFor();});
    await r('new-folder-dialog',async()=>{await tap(navigation.getByRole('button',{name:'Folder',exact:true}));await dialog.getByRole('textbox').first().waitFor();});
    if(width===375){
      await record('new-folder-dialog-keyboard-375',()=>keyboard(session,dialog.getByRole('textbox').first()));
      await record('new-folder-dialog-escaped-375',closeDialog,'Escape closes the dialog without creating a folder.');
    }else await closeDialog();
    if(await navigation.getByRole('button',{name:'Folder',exact:true}).isVisible())await page.keyboard.press('Escape');
    await r('type-menu',async()=>{await tap(button('Type'));await dialog.getByRole('checkbox',{name:'Instance',exact:true}).waitFor();});
    if(width===375)await record('type-instance-checked-375',()=>setChecked(session,dialog.getByRole('checkbox',{name:'Instance',exact:true}),true),
      'The last type choice, checked at its displayed position; Cancel follows.');
    await tap(dialog.getByRole('button',{name:'Cancel',exact:true}));await dialog.waitFor({state:'hidden'});
    await r('filters',async()=>{
      await tap(button('Type'));await setChecked(session,page.getByRole('checkbox',{name:'Folder',exact:true}),true);
      await setChecked(session,page.getByRole('checkbox',{name:'Template',exact:true}),true);await tap(button('Apply'));await listingReady(page,f.rows.slice(0,50));
    });
    await r('date-menu',async()=>{await tap(filters.getByRole('button',{name:'Last modified',exact:true}));await dialog.getByRole('button',{name:'Today',exact:true}).waitFor();});
    await r('date-filtered',async()=>{
      await tap(dialog.getByRole('button',{name:'Today',exact:true}));await tap(dialog.getByRole('button',{name:'Apply',exact:true}));
      await dialog.waitFor({state:'hidden'});await listingReady(page,f.rows.slice(0,50));
    },'Every fixture was modified today, so the first page is unchanged.');
    await tap(filters.getByRole('button',{name:'Clear last modified filter',exact:true}));
    await filters.getByRole('button',{name:'Last modified',exact:true}).waitFor();await listingReady(page,f.rows.slice(0,50));
    await r('sort',async()=>{await tap(button('Sort options'));await page.getByRole('menuitemradio',{name:'Name',exact:true}).waitFor();});
    await page.keyboard.press('Escape');
    await r('keyboard',()=>keyboard(session,button('Sort options')));
    await r('reloaded',async()=>{await page.reload();await listingReady(page,f.rows.slice(0,50));});
    await r('breadcrumb-return',async()=>{
      await folderPage(session,f.listing,f.rows.slice(0,50));
      await tap(page.locator('.table-toolbar .breadcrumbs a').filter({hasText:'Research programme'}));
      await listingReady(page,[f.listing]);
    });
    await r('template-details',async()=>{
      await folderPage(session,f.previews,[f.long,f.nested,f.short]);
      await tap(page.locator(`[data-resource-id="${f.short}"]`).locator('.resource-icon'));
      await panel('information',true);await page.locator('#information-name').filter({hasText:'Short form'}).waitFor();
    });
    await panel('information',false);
    await r('search',async()=>{
      await indexed();
      await page.getByRole('textbox',{name:'Search workspace',exact:true}).fill(f.rootName);
      await tap(button('Search'));
      await page.getByRole('navigation',{name:'Folder breadcrumb'}).filter({hasText:f.rootName}).waitFor();
      await page.locator('.table-scroll[aria-busy="false"] [data-resource-id]').first().waitFor();
    },'Search for the review\'s own temporary root folder. The results are whatever the search index returns first.');
    await r('home',async()=>{await page.goto(session.base+'/dashboard?view=list&sort=name');await listingReady(page);},
      'The test account\'s home folder, whatever it currently holds.');
    const clearType=filters.getByRole('button',{name:'Clear type filter',exact:true});
    await r('mixed-list',async()=>{
      await folderPage(session,f.mixed);if(await clearType.isVisible())await tap(clearType);await listingReady(page,f.mixedIds);
    },'One folder, template, element, field and record.');
    await r('mixed-grid',async()=>{await tap(button('Grid view'));await listingReady(page,f.mixedIds);});
    await r('mixed-filtered',async()=>{
      await tap(button('Type'));await setChecked(session,dialog.getByRole('checkbox',{name:'Template',exact:true}),true);
      await tap(dialog.getByRole('button',{name:'Apply',exact:true}));await listingReady(page,[f.mixedTemplate]);
    },'The type filter removes every row but the template.');
    await tap(clearType);await listingReady(page,f.mixedIds);
    // Each dialog a row's actions open, left unconfirmed so the fixtures stay as they are.
    await tap(button('List view'));await listingReady(page,f.mixedIds);
    const openDialog=page.locator('dialog[open]').first();
    const settled=()=>page.locator('dialog[open]:not([aria-busy="true"])').first().waitFor();
    const picker=async()=>{await settled();await openDialog.locator('.folder-picker .breadcrumbs [aria-current="location"]').waitFor();};
    const idle=()=>openDialog.locator('.dialog-close:not([disabled])').waitFor();
    const rowAction=async(id,label)=>{
      await page.locator('.table-scroll').evaluate(n=>{n.scrollLeft=n.scrollWidth;});
      await tap(page.locator(`[data-resource-id="${id}"]`).getByRole('button',{name:/^Actions for/}));
      await tap(page.locator('#resource-menu').getByRole('button',{name:label,exact:true}));
      await openDialog.waitFor();
    };
    const leave=async()=>{await page.keyboard.press('Escape');await page.locator('dialog[open]').first().waitFor({state:'hidden'});};
    for(const [scenario,label,id,ready] of [['rename-dialog','Rename',f.mixedTemplate,()=>openDialog.getByRole('textbox').first().waitFor()],
      ['copy-dialog','Copy',f.mixedTemplate,picker],['move-dialog','Move',f.mixedTemplate,picker],
      ['permissions-dialog','Permissions…',f.mixedTemplate,idle],['publish-dialog','Publish',f.mixedTemplate,settled],
      ['delete-dialog','Delete',f.mixedTemplate,settled],['folder-delete-dialog','Delete',f.mixedIds[0],idle]]){
      await r(scenario,async()=>{await rowAction(id,label);await ready();});
      await leave();
    }
    if(width!==768){
      const reason='Deliberately refused rename',refuse=route=>route.fulfill({status:403,json:{message:'Forbidden'}});
      let original='';
      await record(`rename-refused-${width}`,async()=>{
        await rowAction(f.mixedTemplate,'Rename');
        const name=openDialog.getByRole('textbox').first();await name.waitFor();original=await name.inputValue();
        session.expectedNetworkFailures.add(reason);await page.route('**/command/rename-resource',refuse);
        try{
          await name.fill('Specimen template renamed');
          await tap(openDialog.locator('button.primary[type="submit"]'));
          await openDialog.getByRole('alert').first().waitFor();
        }finally{await page.unroute('**/command/rename-resource',refuse);session.expectedNetworkFailures.delete(reason);}
      },'The harness answered this rename with 403 to show how the dialog reports a refusal; the name is unchanged.');
      // The dialog asks before discarding a changed name, so the original goes back before closing.
      await openDialog.getByRole('textbox').first().fill(original);await leave();
    }
    for(const kind of ['short','long','nested']){
      await r('preview-'+kind,()=>preview(f[kind]));
      if(kind==='nested'){
        await r('preview-tryout',async()=>{await tap(page.locator('dialog .try-out'));await page.locator('dialog section[aria-busy="false"]').waitFor();});
        await r('preview-return',async()=>{await tap(page.locator('dialog .try-out'));await page.locator('dialog section[aria-busy="false"]').waitFor();});
      }
      await page.keyboard.press('Escape');await page.locator('dialog.artifact-preview').waitFor({state:'hidden'});
    }
  }
  await page.setViewportSize({width:768,height:667});
  await record('both-panels-768',async()=>{await folderPage(session,f.listing,f.rows.slice(0,50));await panel('navigation',true);await panel('information',true);});
  await record('paging-overlap-768',async()=>{
    await page.locator('.workspace > main').evaluate(main=>{
      const heading=main.querySelector('thead').getBoundingClientRect(),paging=main.querySelector('.paging').getBoundingClientRect();
      main.scrollTop+=heading.top-paging.top;
    });
    await session.capture('paging-position-768','Displayed paging controls before pointer activation, without corrective scrolling.');
    await pointer(session,button('Next'),{scroll:false});await listingReady(page,f.rows.slice(50));
  });
  await textSizeStates(session,record,()=>folderPage(session,f.listing,f.rows.slice(0,50)));
}
