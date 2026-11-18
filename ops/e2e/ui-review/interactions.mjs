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
    // A label activates its control, so a hit on one of the control's labels reaches it too.
    const receivers=[element,...(element.labels??[])];
    let belongs=false;for(let n=hit;n;n=n.parentNode||n.getRootNode()?.host)if(receivers.includes(n))belongs=true;
    return {x,y,belongs,disabled:!!element.disabled,label:element.getAttribute('aria-label')||element.textContent?.trim(),receiver:hit?.tagName};
  });
  const {label,...hit}=target;
  session.actions.push({label:'Displayed pointer target',control:label,...hit});await session.flush();
  assert(hit.belongs,`Displayed control is obstructed: ${label}`);
  assert(!hit.disabled,`Displayed control is disabled: ${label}`);
  await session.page.mouse.click(hit.x,hit.y);
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
// Change a checkbox through its displayed position, then confirm it took the requested state.
export async function setChecked(session,locator,on) {
  if(await locator.isChecked()!==on)await pointer(session,locator);
  if(await locator.isChecked()!==on)throw new Error(`Checkbox did not become ${on?'checked':'unchecked'}`);
}
