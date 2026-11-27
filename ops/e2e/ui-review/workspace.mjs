import {workspaceFixtures} from './fixtures.mjs';
import {WIDTHS,PAIRED_WIDTHS} from './catalog.mjs';
import {RESOURCE,USER_SERVER,GROUP_SERVER} from '../rest/lib.mjs';
import {waitForPage,folderPage,listingReady,pointer,keyboard,setChecked,textSizeStates,holdRequests,refuseConnections,staleRevision} from './interactions.mjs';

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
  // A tooltip on the focused control takes the first Escape, as it must, and the next closes the dialog.
  const escapeFrom=async open=>{await page.keyboard.press('Escape');
    try{await open.waitFor({state:'hidden',timeout:2000});}catch{await page.keyboard.press('Escape');await open.waitFor({state:'hidden'});}};
  const closeDialog=()=>escapeFrom(dialog);
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
    const leave=()=>escapeFrom(page.locator('dialog[open]').first());
    for(const [scenario,label,id,ready] of [['rename-dialog','Rename',f.mixedTemplate,()=>openDialog.getByRole('textbox').first().waitFor()],
      ['copy-dialog','Copy',f.mixedTemplate,picker],['move-dialog','Move',f.mixedTemplate,picker],
      ['permissions-dialog','Permissions…',f.mixedTemplate,idle],['publish-dialog','Publish',f.mixedTemplate,settled],
      ['delete-dialog','Delete',f.mixedTemplate,settled],['folder-delete-dialog','Delete',f.mixedIds[0],idle]]){
      await r(scenario,async()=>{await rowAction(id,label);await ready();});
      await leave();
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
      // The toolbars and listing scroll in a region of their own above paging; an older build scrolls the whole column.
      const pane=main.querySelector('.listing-pane'),scroller=pane&&getComputedStyle(pane).overflowY==='auto'?pane:main;
      const heading=main.querySelector('thead').getBoundingClientRect(),paging=main.querySelector('.paging').getBoundingClientRect();
      scroller.scrollTop+=heading.top-paging.top;
    });
    await session.capture('paging-position-768','Displayed paging controls before pointer activation, without corrective scrolling.');
    await pointer(session,button('Next'),{scroll:false});await listingReady(page,f.rows.slice(50));
  });
  // Slow loading, a backend the browser cannot reach and a rename someone else's save has
  // overtaken, each caused in the review browser alone. The server answers the rename itself.
  const alert=page.locator('div.alert[role="alert"]');
  const dialogAlert=page.locator('dialog[open] p.alert[role="alert"]');
  for(const width of PAIRED_WIDTHS){
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    await page.setViewportSize({width,height:width===1440?1000:667});
    await folderPage(session,f.listing,f.rows.slice(0,50));
    let held;
    await r('listing-loading',async()=>{
      held=await holdRequests(page,url=>url.origin===new URL(RESOURCE).origin,{held:request=>request.method()==='GET',label:'Next listing page'});
      await tap(button('Next'));await held.started();await page.locator('.table-scroll[aria-busy="true"]').waitFor();
    },'The harness holds the next page\'s responses to show loading; the server is not slow.');
    await held?.release();await listingReady(page,f.rows.slice(50));
    let restore;
    await r('backend-unreachable',async()=>{
      restore=await refuseConnections(session,[RESOURCE,USER_SERVER,GROUP_SERVER],'Deliberately unreachable CEDAR servers');
      await tap(button('Previous'));await alert.waitFor();
    },'The harness drops every request to the CEDAR servers, as a lost connection does, then goes to the previous page.');
    await restore?.();restore=null;
    await tap(alert.getByRole('button'));await alert.waitFor({state:'hidden'});
    await folderPage(session,f.mixed,f.mixedIds);
    await r('rename-conflict',async()=>{
      await page.locator('.table-scroll').evaluate(n=>{n.scrollLeft=n.scrollWidth;});
      await tap(page.locator(`[data-resource-id="${f.mixedTemplate}"]`).getByRole('button',{name:/^Actions for/}));
      await tap(page.locator('#resource-menu').getByRole('button',{name:'Rename',exact:true}));
      const open=page.locator('dialog[open]').first();
      await open.getByRole('textbox').first().fill('Renamed during review '+width);
      restore=await staleRevision(session,url=>url.origin===new URL(RESOURCE).origin,'Deliberately overtaken rename');
      await tap(open.locator('button[type="submit"]'));
      await dialogAlert.filter({hasText:/changed/i}).waitFor();
    },'The harness sends the rename with the revision before the one Workspace read, as when someone else saved first; the server refused it and nothing changed.');
    await restore?.();restore=null;
    // The dialog keeps the typed name, so cancelling it asks before discarding the edit.
    const renaming=page.locator('dialog.action-dialog[open]');
    await tap(renaming.getByRole('button',{name:'Cancel',exact:true}));
    await tap(page.locator('dialog.confirmation-dialog[open]').getByRole('button',{name:'Yes',exact:true}));
    await renaming.waitFor({state:'hidden'});
  }
  // Screens a user reaches in ordinary work that the states above leave out. Each width edits its
  // own copy of the template or folder, so a saved description or a share at one width never shows at
  // the other.
  const toast=page.locator('cedar-toast .toast');
  const confirmation=page.locator('dialog.confirmation-dialog[open]');
  const openDialog=page.locator('dialog[open]').first();
  const rowActions=async id=>{
    await page.locator('.table-scroll').evaluate(n=>{n.scrollLeft=n.scrollWidth;});
    await tap(page.locator(`[data-resource-id="${id}"]`).getByRole('button',{name:/^Actions for/}));
  };
  const menu=async(name,item)=>{
    await tap(page.locator(`summary[aria-label="${name}"]`));
    await tap(page.locator('details.header-menu[open] nav').getByRole('link',{name:item,exact:true}));
  };
  const account=async(title,item,menuName='User menu')=>{
    await folderPage(session,f.listing,f.rows.slice(0,50));
    await menu(menuName,item);
    await page.getByRole('heading',{level:1,name:title,exact:true}).waitFor();
    await page.locator('main.account-content, main.groups-content').first().waitFor();
    await waitForPage(page,()=>![...document.querySelectorAll('main p')].some(p=>p.textContent.trim()==='Loading…'));
  };
  const person=[session.otherUser.profile.firstName,session.otherUser.profile.lastName].filter(Boolean).join(' ');
  for(const width of PAIRED_WIDTHS){
    const r=(id,fn,note)=>record(`${id}-${width}`,fn,note);
    const own=f.ownCopies[width];
    await page.setViewportSize({width,height:width===1440?1000:667});
    await folderPage(session,own.folder,own.ids);
    await r('description-editing',async()=>{
      await tap(page.locator(`[data-resource-id="${own.template}"]`).locator('.resource-icon'));
      await panel('information',true);
      const description=page.locator('#resource-description');
      await description.scrollIntoViewIfNeeded();await description.fill('Specimens collected for the coastal survey, revised '+width);
      await page.locator('cedar-description-editor').getByRole('button',{name:'Save',exact:true}).waitFor();
    },'An unsaved description, with its Save and Cancel controls.');
    await r('description-saved',async()=>{
      await tap(page.locator('cedar-description-editor').getByRole('button',{name:'Save',exact:true}));
      await toast.waitFor();
    },'The saved description, and the toast that confirms it.');
    await panel('information',false);
    await r('selection-delete-dialog',async()=>{
      await tap(page.locator(`[data-resource-id="${own.template}"] .resource-icon`));
      await tap(page.locator('.selection-delete'));await openDialog.waitFor();
      await page.locator('dialog[open]:not([aria-busy="true"])').first().waitFor();
    },'The dialog the toolbar\'s Delete opens for the selected rows, left unconfirmed.');
    await escapeFrom(openDialog);
    await r('share-search',async()=>{
      await rowActions(own.template);
      await tap(page.locator('#resource-menu').getByRole('button',{name:'Permissions…',exact:true}));
      const picker=openDialog.getByRole('combobox',{name:'User or group'});
      await picker.waitFor();await picker.fill(person);
      await openDialog.getByRole('option',{name:person,exact:true}).waitFor();
    },`Sharing with the second test account, ${person}, found by name.`);
    await r('shared',async()=>{
      await tap(openDialog.getByRole('option',{name:person,exact:true}));
      await tap(openDialog.getByRole('button',{name:'Add',exact:true}));
      await openDialog.locator('cedar-toast .toast').waitFor();
    },`${person} added as a viewer; the permissions are saved at once.`);
    await escapeFrom(openDialog);
    await r('discard-confirmation',async()=>{
      await rowActions(own.template);
      await tap(page.locator('#resource-menu').getByRole('button',{name:'Rename',exact:true}));
      await openDialog.getByRole('textbox').first().fill('Unsaved name '+width);
      await tap(openDialog.getByRole('button',{name:'Cancel',exact:true}));await confirmation.waitFor();
    },'Cancelling a dialog that holds an edit asks before discarding it.');
    await tap(confirmation.getByRole('button',{name:'Yes',exact:true}));
    await page.locator('dialog.action-dialog[open]').waitFor({state:'hidden'});
    let restore;
    await r('write-unconfirmed',async()=>{
      await tap(navigation.getByRole('button',{name:'New',exact:true}));
      await tap(navigation.getByRole('button',{name:'Folder',exact:true}));
      await openDialog.getByRole('textbox').first().fill('Field notes '+width);
      restore=await refuseConnections(session,[RESOURCE,USER_SERVER,GROUP_SERVER],'Deliberately lost reply to a new folder');
      await tap(openDialog.locator('button[type="submit"]'));
      await openDialog.getByRole('button',{name:'Retry',exact:true}).waitFor();
    },'The harness drops the new folder\'s request, as a lost connection does, so Workspace cannot know whether it was created.');
    await restore?.();restore=null;
    // Retry looks the folder up by the identity it was sent under, and a folder never created answers 404.
    const lookup='Lookup of a folder whose creation was never confirmed';
    session.expectedNetworkFailures.add(lookup);
    await r('write-rechecked',async()=>{
      await tap(openDialog.getByRole('button',{name:'Retry',exact:true}));
      await openDialog.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'detached'});
      await page.locator('dialog[open]:not([aria-busy="true"])').first().waitFor();
    },'With the connection back, Retry looks the folder up: it was never created, so the dialog offers to create it again.');
    session.expectedNetworkFailures.delete(lookup);
    // The dialog still holds the typed name, so cancelling it asks before discarding it.
    await tap(openDialog.getByRole('button',{name:'Cancel',exact:true}));
    await tap(confirmation.getByRole('button',{name:'Yes',exact:true}));
    await page.locator('dialog.action-dialog[open]').waitFor({state:'hidden'});
    await r('profile',()=>account('Profile','Profile'));
    await r('settings',()=>account('Settings','Settings'));
    await r('groups',()=>account('Groups','Groups','Actions menu'));
    await r('privacy',()=>account('Privacy','Privacy','Actions menu'));
  }
  if(!session.touch){
    await page.setViewportSize({width:1440,height:1000});
    await folderPage(session,f.mixed,f.mixedIds);
    const source=page.locator(`[data-resource-id="${f.mixedTemplate}"] .resource-icon`);
    const target=page.locator(`[data-resource-id="${f.mixedIds[0]}"] .resource-icon`);
    // Measured before the drag: the drag preview repeats the row's icon.
    let start;
    await record('drag-preview-1440',async()=>{
      const from=await source.boundingBox(),to=await target.boundingBox();
      start={x:from.x+from.width/2,y:from.y+from.height/2};
      await page.mouse.move(start.x,start.y);await page.mouse.down();
      await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});
      await page.locator('cedar-drag-preview').waitFor();
    },'The template dragged over a folder with the button still held; nothing is dropped.');
    // Back to where it started, so releasing it moves nothing.
    if(start)await page.mouse.move(start.x,start.y,{steps:12});
    await page.mouse.up();await listingReady(page,f.mixedIds);
  }
  await textSizeStates(session,record,()=>folderPage(session,f.listing,f.rows.slice(0,50)));
}
