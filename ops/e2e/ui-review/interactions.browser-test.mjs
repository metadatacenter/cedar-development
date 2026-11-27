import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium, firefox, webkit} from 'playwright';
import {waitForPage} from './interactions.mjs';

for (const [engine, type] of Object.entries({chromium, firefox, webkit}))
  test(`${engine}: readiness survives document replacement and still waits for the destination condition`, async t => {
    const browser = await type.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route('http://readiness.test/**', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><p>Waiting</p>'}));
    await page.goto('http://readiness.test/start');
    let interruptions = 0;
    const evaluated = {evaluate: async (predicate, argument) => {
      try {return await page.evaluate(predicate, argument);}
      catch (error) {if (/Execution context was destroyed/.test(error.message)) interruptions++; throw error;}
    }};
    // Trigger replacement from inside the first evaluation, guaranteeing the interrupted read.
    const waiting = waitForPage(evaluated, () => {
      if (location.pathname === '/start') {
        location.href = '/destination';
        return new Promise(() => {});
      }
      return document.body.dataset.ready === 'yes';
    }, undefined, {timeout: 5000, interval: 10});
    await page.waitForURL('**/destination');
    let finished = false;
    waiting.then(() => {finished = true;});
    await page.waitForTimeout(100);
    assert.equal(finished, false);
    await page.evaluate(() => {document.body.dataset.ready = 'yes';});
    await waiting;
    assert(interruptions >= 1);
    assert.equal(await page.locator('body').getAttribute('data-ready'), 'yes');
  });
