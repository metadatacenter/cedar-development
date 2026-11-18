import {workspaceFixtures} from './fixtures.mjs';
import {WIDTHS} from './catalog.mjs';
import {folderPage,listingReady,pointer,keyboard} from './interactions.mjs';

export async function collectWorkspace(session,record) {
  const {page}=session;
  await session.login();
  const f=await workspaceFixtures(session);
  const button=name=>page.getByRole('button',{name,exact:true});
  const tap=locator=>pointer(session,locator);
  const panel=async(which,shown)=>{
    const control=page.locator(`[aria-controls="workspace-${which}"]`);
    if(await control.getAttribute('aria-expanded')!==String(shown))await tap(control);
    await page.locator('#workspace-'+which).waitFor({state:shown?'visible':'hidden'});
  };
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
    await r('populated-grid',async()=>{await tap(button('Grid view'));await listingReady(page,f.rows.slice(0,50));});
    await r('filters',async()=>{
      await tap(button('Type'));await page.getByRole('checkbox',{name:'Folder',exact:true}).check();
      await page.getByRole('checkbox',{name:'Template',exact:true}).check();await tap(button('Apply'));await listingReady(page,f.rows.slice(0,50));
    });
    await r('sort',async()=>{await tap(button('Sort options'));await page.getByRole('menuitemradio',{name:'Name',exact:true}).waitFor();});
    await page.keyboard.press('Escape');
    await r('keyboard',()=>keyboard(session,button('Sort options')));
    await r('reloaded',async()=>{await page.reload();await listingReady(page,f.rows.slice(0,50));});
    await r('breadcrumb-return',async()=>{
      await folderPage(session,f.listing,f.rows.slice(0,50));
      await tap(page.locator('.table-toolbar .breadcrumbs a').filter({hasText:'Research programme'}));
      await listingReady(page,[f.listing]);
    });
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
}
