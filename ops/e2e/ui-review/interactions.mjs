import {retainCleanup} from './journeys.mjs';
import {fixtureAt} from '../journey-fixtures.mjs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {TEXT_SIZE_WIDTHS} from './catalog.mjs';

// Poll from Node: Angular patches browser Promises, and mobile WebKit can resolve
// waitForFunction's thenable before its predicate is true.
export async function waitForPage(page, predicate, argument, {timeout = 30000, interval = 50} = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(predicate, argument)) return;
    if (Date.now() >= deadline) throw new Error('Page condition did not become true within ' + timeout + 'ms');
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
  }
}

// Safari's default macOS keyboard setting uses Option-Tab to include buttons.
export function tabKey(page, key = 'Tab', platform = process.platform) {
  return platform === 'darwin' && page.context().browser()?.browserType().name() === 'webkit'
    ? `Alt+${key}` : key;
}

// Hold the requests a route matches until released, so a capture can show loading, then drain the
// handler before removing it. Unrouting an unresolved handler lets another route handle that same
// request. Only requests for which held() is true wait; the rest pass straight through.
export async function holdRequests(page, url, {held = () => true, label = 'Held request'} = {}) {
  let release, started;
  const gate = new Promise(resolve => {release = resolve;});
  const intercepted = new Promise(resolve => {started = resolve;});
  const pending = new Set(), requests = new Set(), errors = [];
  const handler = async route => {
    requests.add(route.request());
    const holding = held(route.request());
    const work = (async () => {
      try {
        if (holding) await gate;
        await route.fallback();
      } catch (error) {errors.push(error);}
    })();
    pending.add(work);
    if (holding) started();
    await work;
    pending.delete(work);
  };
  await page.route(url, handler);
  return {started: async () => {
    let timer;
    try {
      await Promise.race([intercepted, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' was not intercepted within 15 seconds')), 15000);
      })]);
    } finally {clearTimeout(timer);}
  }, release: retainCleanup(page, async () => {
    release();
    while (pending.size) await Promise.all([...pending]);
    // fallback resolves before the context handler has finished. Updating interception patterns
    // at that point can re-dispatch the same request, so wait for its response too.
    let timer;
    try {
      await Promise.race([
        Promise.all([...requests].map(async request => {
          const response = await request.response();
          if (response) await response.finished();
        })),
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(label + ' did not finish within 30 seconds of its release')), 30000);}),
      ]);
    } finally {clearTimeout(timer);}
    await page.unroute(url, handler);
    if (errors.length) throw errors[0];
  })};
}
// A loading capture starts only when its own artifact is requested. An old page's background
// request can arrive after interception is installed but before the new page's authentication
// redirect finishes; letting that request satisfy started() audits a document about to disappear.
export async function holdArtifactRead(page, base, collection, id, label='Artifact opening') {
  const origin=new URL(base).origin;
  return holdRequests(page,url=>{
    const artifact=fixtureAt(url.href);
    return url.origin===origin&&artifact?.collection===collection&&artifact.id===id;
  },{held:request=>request.method()==='GET',label});
}

// Hold real term searches long enough to capture the picker loading.
export async function holdSearchRequests(page) {
  const hold = await holdRequests(page, '**/search', {held: request => request.method() === 'POST', label: 'Initial term search'});
  return {waitForSearch: hold.started, release: hold.release};
}
// A backend the browser cannot reach: every request to the given origins fails without an answer,
// as when a connection drops. The reason marks the failures the console reports as caused by the
// harness. Returns the function that restores the connection.
export async function refuseConnections(session, origins, reason) {
  const refused = new Set(origins.map(origin => new URL(origin).origin));
  const match = url => refused.has(url.origin);
  const refuse = route => route.abort('failed');
  session.expectedNetworkFailures.add(reason);
  await session.page.route(match, refuse);
  return retainCleanup(session.page, async () => {await session.page.unroute(match, refuse); session.expectedNetworkFailures.delete(reason);});
}
// A write another session's save has overtaken: each conditional request the route matches is sent
// with the revision before the one the page read, and the server refuses it with its own 412, as it
// does when someone else saved first. Nothing is written. The request still passes the context's
// fixture guard. Returns the function that removes the route.
export async function staleRevision(session, url, reason) {
  const stale = route => {
    const headers = route.request().headers();
    const revision = /^"(\d+)/.exec(headers['if-match'] ?? '')?.[1];
    return revision ? route.fallback({headers: {...headers, 'if-match': `"${Math.max(0, Number(revision) - 1)}"`}}) : route.fallback();
  };
  session.expectedNetworkFailures.add(reason);
  await session.page.route(url, stale);
  return retainCleanup(session.page, async () => {await session.page.unroute(url, stale); session.expectedNetworkFailures.delete(reason);});
}

export async function listingReady(page, ids) {
  await page.locator('.table-scroll[aria-busy="false"]').waitFor();
  if(ids)await waitForPage(page, expected=>{
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
    await page.keyboard.press(tabKey(page));
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
// The browser's default text size doubled, as a user sets it: text sized in rem, em or percent
// follows it and text fixed in pixels does not. Collectors record these states last, since the
// setting stays with the page. It is applied before the page loads, so measurements made while
// loading see the larger text, and again after, since a navigation can start a fresh renderer.
export async function textSizeStates(session,record,show) {
  if(!session.defaultFontSize)return;
  for(const width of TEXT_SIZE_WIDTHS){
    await session.page.setViewportSize({width,height:width===1440?1000:667});
    await record(`text-200-${width}`,async()=>{
      await session.setDefaultFontSize(32);await show();await session.setDefaultFontSize(32);
      await session.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    },'The browser default text size is 32 pixels, twice the usual 16. CEDAR sizes its text in pixels by agreement, so text that keeps its size is expected; judge the layout around it.');
  }
}
