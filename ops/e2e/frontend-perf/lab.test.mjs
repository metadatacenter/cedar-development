import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {serve} from './lab.mjs';
import {instrumentation, profiles, pageMetrics} from './metrics.mjs';
import {template, scenarios} from './scenarios.mjs';

test('fixed fixtures scale actual fields and scenarios exclude legacy applications', () => {
  for (const n of [5,100]) {
    const t = template(n);
    assert.equal(t._ui.order.length,n);
    for (const name of t._ui.order) {
      assert.ok(t.properties[name]); assert.ok(t.required.includes(name));
      assert.ok(t.properties['@context'].properties[name]);
    }
  }
  const cases = scenarios('metadatacenter.orgx',{small:'small',large:'large'});
  assert.equal(cases.length,15);
  assert.ok(cases.some(s => s.id === 'cee-standalone-large'));
  assert.ok(cases.some(s => s.id === 'ced-standalone-large'));
  assert.ok(cases.every(s => !s.url.includes('://cedar.')));
});

test('browser-private production origin serves gzip, preserves warm cache and observes real paint', async () => {
  const directory = await mkdtemp(join(tmpdir(),'cedar-perf-test-'));
  let lab, browser;
  try {
    await writeFile(join(directory,'index.html'), '<!doctype html><link rel="icon" href="data:,"><h1>Measurement fixture</h1><script src="/payload.js"></script>');
    await writeFile(join(directory,'payload.js'), 'window.payload=true;\n'+Array.from({length:10000},(_,i) => `// payload ${i}`).join('\n'));
    lab = await serve({'perf.invalid':directory},directory);
    browser = await chromium.launch({args:['--host-resolver-rules='+lab.rules,'--no-proxy-server']});
    const context = await browser.newContext({ignoreHTTPSErrors:true});
    const page = await context.newPage();
    const meter = await instrumentation(context,page,profiles.normal);
    await meter.cold();
    const samples = [];
    for (let i=0;i<2;i++) {
      await page.goto('about:blank');
      meter.start();
      await page.goto('https://perf.invalid/');
      await page.waitForFunction(() => window.payload);
      await page.waitForTimeout(200);
      samples.push(pageMetrics(await page.evaluate(() => window.__cedarPerf.snapshot()),1,meter.snapshot()));
      meter.stop();
      assert.equal(await page.evaluate(async () => (await fetch('/no-such.js')).status),404);
    }
    assert.ok(samples[0].fcpMs > 0);
    assert.ok(samples[0].transferBytes > samples[1].transferBytes);
    assert.ok(samples[1].cachedRequests > 0);
    assert.deepEqual(samples[0].networkFailures,[]);
    await context.close();
  } finally {
    await browser?.close();
    if (lab) await new Promise(resolve => lab.server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
