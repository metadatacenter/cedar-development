import assert from 'node:assert/strict';
import {join} from 'node:path';

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
  // A touch profile taps where a pointer profile clicks.
  if(session.touch)await session.page.touchscreen.tap(hit.x,hit.y);else await session.page.mouse.click(hit.x,hit.y);
}
// Tab through the page from a starting control. Each stop logs the focused element and, when it lies
// in the viewport, keeps a crop of it with its focus indicator; the next capture names the crops
// after its state. A stop outside the viewport is logged without a crop.
export async function keyboard(session,start,{stops=12}={}) {
  const {page}=session;
  await start.focus();
  for(let stop=1;stop<=stops;stop++){
    await page.keyboard.press('Tab');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const focus=await page.evaluate(()=>{
      let n=document.activeElement;while(n?.shadowRoot?.activeElement)n=n.shadowRoot.activeElement;
      const r=n?.getBoundingClientRect();
      return {tag:n?.tagName,label:n?.getAttribute('aria-label')||n?.getAttribute('title')||n?.textContent?.trim().slice(0,100),
        box:r&&r.width&&r.height?{x:r.x,y:r.y,width:r.width,height:r.height}:null,
        viewport:{width:innerWidth,height:innerHeight}};
    });
    let cropped=false;
    if(focus.box&&session.pendingCrops){
      const pad=8,{box,viewport}=focus;
      const x=Math.max(0,box.x-pad),y=Math.max(0,box.y-pad);
      const width=Math.min(viewport.width,box.x+box.width+pad)-x,height=Math.min(viewport.height,box.y+box.height+pad)-y;
      if(width>0&&height>0){
        const file=`focus-pending-${session.pendingCrops.length+1}.png`;
        // A viewport screenshot takes its clip in viewport coordinates, the same frame as the box.
        await page.screenshot({path:join(session.directory,file),clip:{x,y,width,height}});
        session.pendingCrops.push(file);cropped=true;
      }
    }
    session.actions.push({label:'Keyboard Tab',stop,focus:{tag:focus.tag,label:focus.label,box:focus.box},inViewport:cropped});
  }
  await session.flush();
}
// Change a checkbox through its displayed position, then confirm it took the requested state.
export async function setChecked(session,locator,on) {
  if(await locator.isChecked()!==on)await pointer(session,locator);
  if(await locator.isChecked()!==on)throw new Error(`Checkbox did not become ${on?'checked':'unchecked'}`);
}
