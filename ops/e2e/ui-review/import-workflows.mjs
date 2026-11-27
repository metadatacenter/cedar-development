import {captureJourney} from './journeys.mjs';
import {PAIRED_WIDTHS} from './catalog.mjs';
import {pointer, refuseConnections} from './interactions.mjs';
import {RESOURCE} from '../rest/lib.mjs';

export async function collectImportWorkflows(session, record) {
  const {page}=session;
  for(const width of PAIRED_WIDTHS) await captureJourney(session,record,`import-recovery-${width}`,async()=>{
    await page.setViewportSize({width,height:width===1440?1000:667});
    await session.openNew();
    if(await page.locator('#discard-draft').isVisible())await pointer(session,page.locator('#discard-draft'));
    await pointer(session,page.getByRole('button',{name:'Import fields and elements',exact:true}).last());
    const dialog=page.locator('app-child-picker dialog');await dialog.waitFor();
    await dialog.locator('#child-search').fill('');
    const restore=await refuseConnections(session,[RESOURCE],'Deliberately unavailable reusable artifact search');
    await record(`import-search-failed-${width}`,async()=>{
      await pointer(session,dialog.getByRole('button',{name:'Search',exact:true}));
      await dialog.getByRole('alert').waitFor();
    },'A real import search with resource-server connections deliberately refused; the dialog retains the query and displays its existing failure feedback.');
    await restore();
    await record(`import-search-recovered-${width}`,async()=>{
      const completed=page.waitForResponse(response=>new URL(response.url()).pathname==='/search'&&response.ok());
      await pointer(session,dialog.getByRole('button',{name:'Search',exact:true}));
      await completed;
      await dialog.locator('.result-row').first().waitFor();
      await dialog.locator('.table-scroll[aria-busy="false"]').waitFor();
      await dialog.getByRole('alert').waitFor({state:'detached'});
    },'Search is repeated after restoring connectivity; the populated results replace the error without closing the dialog.');
    await pointer(session,dialog.getByRole('button',{name:'Close',exact:true}));
  });
}
