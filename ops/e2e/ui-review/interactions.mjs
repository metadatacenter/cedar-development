import assert from 'node:assert/strict';

export async function listingReady(page, ids) {
  await page.locator('.table-scroll[aria-busy="false"]').waitFor();
  if(ids)await page.waitForFunction(expected=>{
    const actual=[...document.querySelectorAll('[data-resource-id]')].map(n=>n.getAttribute('data-resource-id'));
    return expected.length===actual.length&&expected.every(id=>actual.includes(id));
  },ids);
}
export async function folderPage(session,id,ids) {
  await session.page.goto(session.base+'/dashboard?'+new URLSearchParams({folderId:id.split('/').slice(-2).join('/'),view:'list',sort:'name'}));
  await listingReady(session.page,ids);
}
// Scroll deliberately, then hit the displayed position. Playwright's click may scroll again
// to escape an overlap; doing so would erase evidence about the original pointer target.
export async function pointer(session,locator,{scroll=true}={}) {
  if(scroll)await locator.scrollIntoViewIfNeeded();
  const target=await locator.evaluate(element=>{
    const box=element.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
    let hit=document.elementFromPoint(x,y);const seen=new Set();
    while(hit?.shadowRoot&&!seen.has(hit)){seen.add(hit);const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
    let belongs=false;for(let n=hit;n;n=n.parentNode||n.getRootNode()?.host)if(n===element)belongs=true;
    return {x,y,belongs,disabled:!!element.disabled,label:element.getAttribute('aria-label')||element.textContent?.trim(),receiver:hit?.tagName};
  });
  session.actions.push({label:'Displayed pointer target',...target});await session.flush();
  assert(target.belongs,`Displayed control is obstructed: ${target.label}`);
  assert(!target.disabled,`Displayed control is disabled: ${target.label}`);
  await session.page.mouse.click(target.x,target.y);
}
export async function keyboard(session,start) {
  await start.focus();
  for(let i=0;i<12;i++){
    await session.page.keyboard.press('Tab');
    const focus=await session.page.evaluate(()=>{
      let n=document.activeElement;while(n?.shadowRoot?.activeElement)n=n.shadowRoot.activeElement;
      return {tag:n?.tagName,label:n?.getAttribute('aria-label')||n?.textContent?.trim().slice(0,100)};
    });
    session.actions.push({label:'Keyboard Tab',focus});
  }
  await session.flush();
}
