import assert from 'node:assert/strict';
import {join} from 'node:path';

// Composition probes. Each renders either a concern or an acceptable control, in one of several
// variants; the draw records which in the answer key, never in the reviewer packet.
export const COMPOSITION_PROBES = [
  {kind: 'identity', broken: ['overlapping-identity-metadata'], control: ['short-identity-coherent', 'long-identity-needs-wrap']},
  {kind: 'settings', broken: ['clipped-setting-label', 'overlapping-settings-controls'],
    control: ['coherent-narrow-settings', 'coherent-settings']},
  {kind: 'row', broken: ['misaligned-row-controls'], control: ['aligned-row-controls']},
];

async function captureRow(page, directory, item, t) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{font:18px system-ui;color:#173e3c;margin:40px}
    main{width:900px;border:1px solid #c2cece;padding:24px}.row{display:flex;align-items:center;gap:16px}
    strong{margin-right:auto}.controls{display:flex;align-items:center;gap:12px;transform:translateY(${item.broken ? 12 : 0}px)}
    button{font:inherit;width:32px;height:32px;border:1px solid #9ba7a7;border-radius:50%;background:white;color:inherit}
    p{border:1px solid #9ba7a7;padding:12px;margin:24px 0 0}
    </style><main><div class="row"><strong>${t.rowTitle}</strong><div class="controls"><button>1</button><button>2</button><button>3</button><span>1–3 of 9</span><button aria-label="Previous">‹</button><button aria-label="Next">›</button></div></div><p>${t.rowNote}</p></main>`);
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.locator('.row').evaluate(row => [...row.children].map(el => {
    const r = el.getBoundingClientRect();
    return {element: el.tagName, x: r.x, y: r.y, width: r.width, height: r.height, centerY: r.y + r.height / 2};
  }));
  assert.equal(Math.round(Math.abs(geometry[0].centerY - geometry[1].centerY)), item.broken ? 12 : 0,
    `${item.category}: intended alignment changed`);
  const file = `${item.id}-screen.png`;
  await page.screenshot({path: join(directory, file)});
  return {id: item.id, images: [file], actions: [`Inspected the displayed ${t.rowTitle.toLowerCase()} without editing.`], geometry,
    accessibility: await page.locator('body').ariaSnapshot()};
}

export async function captureComposition(browser, directory, item, t) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    if (item.kind === 'row') return await captureRow(page, directory, item, t);
    const variant = item.category;
    const heading = item.kind === 'identity';
    const long = variant === 'long-identity-needs-wrap';
    const identity = `<header><span class="identity">${long ? t.longName : t.shortName}</span><span class="facts">${t.facts}</span></header><p>${t.settingsIntro}</p>`;
    const enabled = `<label class="check"><input type="checkbox" checked> ${t.enable}</label>`;
    const key = `<label class="code">${t.code}<input id="code" value="${t.codeValue}"></label>`;
    const bounds = `<div class="bounds"><label><span class="setting-label">${t.lower}</span><input id="lower" value="0"></label><label><span class="setting-label">${t.upper}</span><input id="upper" value="60"></label></div>`;
    const settings = key + '<div class="limits">' + enabled + bounds + '</div>';
    const width = long ? 300 : variant === 'coherent-narrow-settings' ? 190 : 400;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{font:18px system-ui;color:#173e3c;margin:40px}main{width:${width}px;border:1px solid #c2cece;padding:24px}h1{font-size:24px;margin:0 0 24px}header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}.identity{font-weight:600}.facts{white-space:nowrap;color:#555}p{font-size:16px;line-height:1.5}section,label{display:flex;flex-direction:column;gap:6px}section{gap:20px}input{width:100%;min-width:0;font:inherit;padding:8px;border:1px solid #9ba7a7;border-radius:4px}.check{flex-direction:row;align-items:center}.check input{width:auto}.bounds{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,110px),1fr));gap:12px}.limits{display:flex;flex-direction:column;gap:8px}
      ${variant === 'overlapping-identity-metadata' ? '.facts{transform:translateX(-72px)}' : ''}
      ${variant === 'overlapping-settings-controls' ? '.bounds{transform:translateY(-100px)}' : ''}
      ${variant === 'clipped-setting-label' ? '.bounds label:first-child .setting-label{max-width:3ch;white-space:nowrap;overflow:hidden}' : ''}
      ${variant === 'coherent-narrow-settings' ? 'h1{font-size:20px}' : ''}
      </style><main><h1>${t.settings}</h1>${heading ? identity : '<section>' + settings + '</section>'}</main>`);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator('main').evaluate(main => [...main.querySelectorAll('header, header > span, label, input, .setting-label, .bounds, .limits')].map(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.font = style.font;
      return {element: el.tagName.toLowerCase(), id: el.id, className: el.className, text: el.textContent.trim(),
        x: r.x, y: r.y, width: r.width, height: r.height,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        intrinsicTextWidth: ctx.measureText(el.textContent.trim()).width, gap: style.columnGap};
    }));
    // Prove the fixture's premise against the browser and fonts actually used. A broken fixture
    // must fail capture, not silently teach the scorer an incorrect layout verdict.
    if (heading) {
      const row = geometry.find(x => x.element === 'header');
      const label = geometry.find(x => x.className === 'identity');
      const facts = geometry.find(x => x.className === 'facts');
      const fits = label.intrinsicTextWidth + facts.intrinsicTextWidth + parseFloat(row.gap) <= row.width;
      assert.equal(fits, !long, `${variant}: intended fit premise changed`);
      assert.equal(Math.abs(label.y - facts.y) < 2, !long, `${variant}: intended rows changed`);
      const overlaps = Math.min(label.x + label.width, facts.x + facts.width) > Math.max(label.x, facts.x)
        && Math.min(label.y + label.height, facts.y + facts.height) > Math.max(label.y, facts.y);
      assert.equal(overlaps, variant === 'overlapping-identity-metadata', `${variant}: intended text overlap changed`);
    } else {
      const check = geometry.find(x => x.className === 'check');
      const code = geometry.find(x => x.className === 'code');
      const boundsBox = geometry.find(x => x.className === 'bounds');
      assert(code.y + code.height <= check.y, `${variant}: code must precede the enable control`);
      const inputs = geometry.filter(x => x.element === 'input').slice(-2);
      const codeInput = geometry.find(x => x.id === 'code');
      const overlaps = inputs.some(input => Math.min(input.y + input.height, codeInput.y + codeInput.height) > Math.max(input.y, codeInput.y)
        && Math.min(input.x + input.width, codeInput.x + codeInput.width) > Math.max(input.x, codeInput.x));
      assert.equal(overlaps, variant === 'overlapping-settings-controls', `${variant}: intended control overlap changed`);
      const clippedLabels = geometry.filter(x => x.className === 'setting-label' && x.scrollWidth > x.clientWidth);
      assert.equal(clippedLabels.length, variant === 'clipped-setting-label' ? 1 : 0, `${variant}: intended label clipping changed`);
      assert.equal(inputs[1].y > inputs[0].y + inputs[0].height, variant === 'coherent-narrow-settings',
        `${variant}: bounds must stack only in the narrow variant`);
      // A premise that holds by a few pixels is one a careful reviewer can measure the other way.
      // The enable label therefore stays on one line, beside its checkbox, and the narrow bounds
      // stack by a clear margin.
      const line = geometry.find(x => x.className === 'setting-label');
      assert(check.height <= line.height + 4, `${variant}: the enable label must stay on one line`);
      if (variant === 'coherent-narrow-settings') {
        const labels = geometry.filter(x => x.element === 'label').slice(-2);
        assert(labels.reduce((sum, label) => sum + label.intrinsicTextWidth, 12) > boundsBox.width + 24,
          'Narrow control must require stacking by a clear margin, even for its displayed labels');
      }
    }
    const file = `${item.id}-screen.png`;
    await page.screenshot({path: join(directory, file)});
    return {id: item.id, images: [file], actions: [`Inspected the displayed ${t.settings.toLowerCase()} without editing.`],
      geometry, accessibility: await page.locator('body').ariaSnapshot()};
  } finally {await page.close();}
}
