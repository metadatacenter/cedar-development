import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {scenarios} from './scenarios.mjs';

test('dashboard readiness waits for both real report responses, even after the listing is ready',async()=>{
  let held;
  const server=createServer((req,res)=>{
    if(req.url==='/templates/one/report') {res.setHeader('Content-Type','application/json');res.end('{}');}
    else if(req.url==='/templates/two/report') {held=res;}
    else {res.setHeader('Content-Type','text/html');res.end('<div class="table-scroll" aria-busy="false"></div><script>fetch("/templates/one/report");fetch("/templates/two/report");</script>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const dashboard=scenarios('local.invalid',{small:'https://resource.local.invalid/templates/one',large:'https://resource.local.invalid/templates/two'},'folder')[0];
    let ready=false;const pending=dashboard.settled(page).then(()=>{ready=true;});
    await page.waitForFunction(()=>performance.getEntriesByType('resource').some(entry=>entry.name.endsWith('/templates/one/report')));
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(ready,false,'A visible listing cannot hide an unfinished action report');
    assert.ok(held);held.setHeader('Content-Type','application/json');held.end('{}');
    await pending;assert.equal(ready,true);
    page.setDefaultTimeout(250);
    const missing=scenarios('local.invalid',{small:'one',large:'missing'},'folder')[0];
    await assert.rejects(missing.settled(page),/Timeout/,'Missing reports remain a readiness failure');
  } finally {held?.end();await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
