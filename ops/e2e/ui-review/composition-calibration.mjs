import assert from 'node:assert/strict';
import {join} from 'node:path';

// Separate answer key: none of these categories or verdicts enter the reviewer packet.
export const compositionCases = [
  {id: 'g14', broken: true, category: 'short-identity-fragmented', family: 'composition'},
  {id: 'h76', broken: false, category: 'long-identity-needs-wrap', family: 'composition'},
  {id: 'j32', broken: false, category: 'short-identity-coherent', family: 'composition'},
  {id: 'k85', broken: true, category: 'label-detached-from-control', family: 'composition'},
  {id: 'm46', broken: true, category: 'related-settings-interrupted', family: 'composition'},
  {id: 'n90', broken: false, category: 'coherent-narrow-settings', family: 'composition'},
];

export async function captureComposition(browser, directory, item) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    const heading = ['g14', 'h76', 'j32'].includes(item.id);
    const name = item.id === 'h76' ? 'Estimated total elapsed observation time' : 'Elapsed time';
    const identity = `<header><span class="identity">${name}</span><span class="facts">Decimal · seconds</span></header><p>Set the properties used when recording this measurement.</p>`;
    const detached = '<label for="precision">Precision</label><label class="interloper">Internal code<input value="elapsed_time"></label><input id="precision" value="2 decimal places">';
    const enabled = '<label class="check"><input type="checkbox" checked> Enable limits</label>';
    const key = '<label class="code">Internal code<input value="elapsed_time"></label>';
    const bounds = '<div class="bounds"><label>Lower bound<input value="0"></label><label>Upper bound<input value="60"></label></div>';
    const settings = item.id === 'm46' ? enabled + key + bounds : key + '<div class="limits">' + enabled + bounds + '</div>';
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{font:18px system-ui;color:#173e3c;margin:40px}main{width:${item.id === 'h76' ? 300 : item.id === 'n90' ? 220 : 400}px;border:1px solid #c2cece;padding:24px}h1{font-size:24px;margin:0 0 24px}header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}.identity{font-weight:600}.facts{white-space:nowrap;color:#555}p{font-size:16px;line-height:1.5}section,label{display:flex;flex-direction:column;gap:6px}section{gap:20px}input{width:100%;min-width:0;font:inherit;padding:8px;border:1px solid #9ba7a7;border-radius:4px}.check{flex-direction:row;align-items:center}.check input{width:auto}.bounds{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,110px),1fr));gap:12px}.limits{display:flex;flex-direction:column;gap:8px}
      ${item.id === 'g14' ? '.identity{flex-basis:100%}' : ''}
      ${item.id === 'k85' ? '#precision{margin-top:22px}' : ''}
      </style><main><h1>Measurement settings</h1>${heading ? identity : '<section>' + (item.id === 'k85' ? detached : settings) + '</section>'}</main>`);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator('main').evaluate(main => [...main.querySelectorAll('header, header > span, label, input, .bounds, .limits')].map(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      const range = document.createRange(); range.selectNodeContents(el);
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.font = style.font;
      return {element: el.tagName.toLowerCase(), className: el.className, text: el.textContent.trim(),
        x: r.x, y: r.y, width: r.width, height: r.height,
        intrinsicTextWidth: ctx.measureText(el.textContent.trim()).width, gap: style.columnGap};
    }));
    // Prove the fixture's premise against the browser/font actually used. A broken fixture must fail
    // capture, not silently teach the scorer an incorrect layout verdict.
    if (heading) {
      const row = geometry.find(x => x.element === 'header');
      const label = geometry.find(x => x.className === 'identity');
      const facts = geometry.find(x => x.className === 'facts');
      const fits = label.intrinsicTextWidth + facts.intrinsicTextWidth + parseFloat(row.gap) <= row.width;
      assert.equal(fits, item.id !== 'h76', `${item.id}: intended fit premise changed`);
      assert.equal(Math.abs(label.y - facts.y) < 2, item.id === 'j32', `${item.id}: intended rows changed`);
    } else if (item.id === 'k85') {
      const labels = geometry.filter(x => x.element === 'label');
      const inputs = geometry.filter(x => x.element === 'input');
      assert.ok(inputs.at(-1).y > labels[1].y + labels[1].height, 'Detached control must follow the intervening control');
    } else {
      const check = geometry.find(x => x.className === 'check');
      const code = geometry.find(x => x.className === 'code');
      const bounds = geometry.find(x => x.className === 'bounds');
      assert.equal(code.y > check.y && code.y < bounds.y, item.id === 'm46');
      if (item.id === 'n90') {
        const inputs = geometry.filter(x => x.element === 'input').slice(-2);
        assert.ok(inputs[1].y > inputs[0].y + inputs[0].height, 'Narrow control must genuinely stack its bounds');
      }
    }
    const file = `${item.id}-screen.png`;
    await page.screenshot({path: join(directory, file)});
    return {id: item.id, images: [file], actions: ['Inspected the displayed measurement settings without editing.'],
      geometry, accessibility: await page.locator('body').ariaSnapshot()};
  } finally {await page.close();}
}
