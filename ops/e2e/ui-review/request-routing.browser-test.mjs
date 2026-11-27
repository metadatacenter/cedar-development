import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
import {holdSearchRequests, holdArtifactRead, refuseConnections, staleRevision} from './interactions.mjs';
import {captureJourney} from './journeys.mjs';

test('a failed loading journey releases held requests and keeps the fixture guard for the next journey', async t => {
  const browser=await chromium.launch();t.after(()=>browser.close());
  const context=await browser.newContext();let guarded=0;
  await context.route('**/*',async route=>{guarded++;await route.fulfill({contentType:'text/html',body:'ready'});});
  const page=await context.newPage();await page.goto('https://fixture.invalid/');
  const session={page,expectedNetworkFailures:new Set()},failures=[];
  const record={failure:(id,error)=>failures.push([id,error.message])};
  await captureJourney(session,record,'loading',async()=>{
    const held=await holdSearchRequests(page);
    await page.evaluate(()=>{fetch('/search',{method:'POST'}).catch(()=>{});});
    await held.waitForSearch();throw new Error('Capture failed');
  });
  assert.deepEqual(failures,[['journey:loading','Capture failed']]);
  assert.equal(page.url(),'about:blank');
  await page.goto('https://fixture.invalid/');const before=guarded;
  assert.equal(await page.evaluate(()=>fetch('/search',{method:'POST'}).then(r=>r.text())),'ready');
  assert.equal(guarded,before+1);
});

test('held searches drain before unroute and continue through the existing context guard', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  let guarded = 0;
  await context.route('**/*', async route => {
    if (route.request().method() === 'POST') guarded++;
    await route.fulfill({contentType: 'text/html', body: 'ready'});
  });
  const page = await context.newPage();
  await page.goto('https://fixture.invalid/');
  const held = await holdSearchRequests(page);
  const requested = page.waitForRequest(request => request.method() === 'POST');
  await page.evaluate(() => {window.answer = fetch('/search', {method: 'POST'}).then(response => response.text());});
  await requested;
  await held.waitForSearch();
  assert.equal(guarded, 0, 'search must remain held while loading is captured');
  await held.release();
  assert.equal(await page.evaluate(() => window.answer), 'ready');
  assert.equal(guarded, 1, 'the original context guard still receives the released request');
  assert.equal(await page.evaluate(() => fetch('/search', {method: 'POST'}).then(response => response.text())), 'ready');
  assert.equal(guarded, 2, 'later searches are no longer held');
});

test('a stale revision reaches the context guard one revision back, and a refused origin gets no answer', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const seen = [];
  await context.route('**/*', async route => {
    seen.push(route.request().headers()['if-match'] ?? null);
    await route.fulfill({contentType: 'text/html', body: 'ready'});
  });
  const page = await context.newPage();
  await page.goto('https://fixture.invalid/');
  const session = {page, expectedNetworkFailures: new Set()};
  const put = tag => page.evaluate(tag => fetch('/item', {method: 'PUT', headers: tag ? {'If-Match': tag} : {}}).then(r => r.text()), tag);
  const restoreRevision = await staleRevision(session, '**/item', 'stale');
  assert.equal(await put('"7-abc"'), 'ready');
  assert.equal(await put(null), 'ready');
  assert.deepEqual(seen.slice(-2), ['"6"', null], 'only a conditional write is sent one revision back');
  assert.ok(session.expectedNetworkFailures.has('stale'));
  await restoreRevision();
  assert.equal(await put('"7-abc"'), 'ready');
  assert.equal(seen.at(-1), '"7-abc"');
  assert.equal(session.expectedNetworkFailures.size, 0);
  const restoreConnection = await refuseConnections(session, ['https://fixture.invalid/api'], 'refused');
  const before = seen.length;
  assert.equal(await page.evaluate(() => fetch('/item').then(() => 'answered', () => 'failed')), 'failed');
  assert.equal(seen.length, before, 'a refused request never reaches the context');
  await restoreConnection();
  assert.equal(await page.evaluate(() => fetch('/item').then(r => r.text())), 'ready');
});


for(const engine of [chromium,webkit])test(`${engine.name()}: an unrelated read cannot signal artifact loading`,async t=>{
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext();
  const origin='https://resource.example.orgx';
  const uuid='11111111-1111-4111-8111-111111111111';
  const id='https://repo.example.orgx/template-instances/'+uuid;
  const served=[];
  await context.route('**/*',async route=>{
    served.push(new URL(route.request().url()).pathname);
    await route.fulfill({contentType:'text/html',body:'<title>Ready</title><main>Ready</main>'});
  });
  const page=await context.newPage();await page.goto(origin+'/page');
  const held=await holdArtifactRead(page,origin,'template-instances',id);
  let started=false;const ready=held.started().then(()=>{started=true;});
  // Simulate a request left over from the previous screen, then a report for the intended record.
  await page.evaluate(async uuid=>{
    await fetch('/folders/'+uuid);await fetch('/template-instances/'+uuid+'/report');
  },uuid);
  assert.equal(started,false);
  assert(served.includes('/folders/'+uuid));
  assert(served.includes('/template-instances/'+uuid+'/report'));
  await page.evaluate(uuid=>{window.record=fetch('/template-instances/'+uuid).then(r=>r.text());},uuid);
  await ready;assert(!served.includes('/template-instances/'+uuid));
  await held.release();assert.match(await page.evaluate(()=>window.record),/Ready/);
});
