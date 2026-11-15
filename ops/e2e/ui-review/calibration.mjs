import {hash} from './contract.mjs';
import {mkdir, writeFile, readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {compositionCases, captureComposition} from './composition-calibration.mjs';

// Held-out miniature interfaces, never injected into the product. The review packet does not
// contain this answer key. These measure basic detection/false alarms, not overall UX expertise.
const cases = [
  {id: 'a17', broken: false, category: 'legitimate-disabled-action'},
  {id: 'b42', broken: true, category: 'inert-panel-control'},
  {id: 'c09', broken: false, category: 'intentional-responsive-wrap'},
  {id: 'd63', broken: true, category: 'cancel-commits-change'},
  {id: 'e28', broken: true, category: 'clipped-primary-action'},
  {id: 'f51', broken: false, category: 'empty-panel-opens'},
  ...compositionCases,
];

export async function captureCalibration(directory) {
  await mkdir(directory, {recursive: false});
  const browser = await chromium.launch();
  const packet = [];
  try {
    for (const item of cases) {
      if (item.family === 'composition') {
        packet.push(await captureComposition(browser, directory, item));
        continue;
      }
      // setContent does not reset a page's JavaScript global lexical scope. Give every
      // case its own document so repeated declarations cannot silently disable handlers.
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const panel = ['b42', 'f51'].includes(item.id);
      const cancel = item.id === 'd63';
      const narrow = item.id === 'c09';
      const clipped = item.id === 'e28';
      const content = panel
        ? '<button id="toggle" aria-expanded="false">Overview</button><aside id="panel" hidden>There are no fields yet.</aside>'
        : `<div class="row"><label>Name<input id="name" value="${cancel ? 'Original' : ''}"></label><label>Description<textarea></textarea></label></div><div class="actions"><button id="save" ${item.id === 'a17' ? 'disabled' : ''}>Save template</button><button id="cancel">Cancel</button></div><p id="status">${cancel ? 'Stored name: Original' : 'Enter a name before saving.'}</p>`;
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;margin:40px;color:#173e3c}main{border:1px solid #bdcccc;padding:24px;width:${narrow ? '330' : '800'}px}h1{font-size:24px}.row{display:flex;gap:20px;flex-wrap:wrap}label{display:flex;flex-direction:column;gap:6px}input,textarea,button{font:inherit;padding:9px}input,textarea{width:280px}.actions{display:flex;gap:12px;margin-top:20px}aside{margin-top:20px;border:1px solid #bdcccc;padding:20px}${clipped ? '#save{width:44px;white-space:nowrap;overflow:hidden}' : ''}</style><main><h1>Template details</h1>${content}</main><script>
      let stored='Original';
      document.querySelector('#toggle')?.addEventListener('click',e=>{e.target.setAttribute('aria-expanded',e.target.getAttribute('aria-expanded')!=='true');${item.id === 'f51' ? "document.querySelector('#panel').hidden=!document.querySelector('#panel').hidden" : ''}});
      document.querySelector('#name')?.addEventListener('input',e=>{document.querySelector('#save').disabled=!e.target.value.trim()});
      function save(){stored=document.querySelector('#name').value;document.querySelector('#status').textContent='Stored name: '+stored}
      document.querySelector('#save')?.addEventListener('click',save);
      document.querySelector('#cancel')?.addEventListener('click',()=>{${cancel ? 'save()' : "document.querySelector('#name').value=stored"}});
      </script>`);
      const images = [];
      const shot = async suffix => {const name = `${item.id}-${suffix}.png`; await page.screenshot({path: join(directory, name)}); images.push(name);};
      await shot('before');
      const actions = [];
      if (panel) {await page.getByRole('button', {name: 'Overview', exact: true}).click(); actions.push('Clicked Overview.');}
      else if (cancel) {await page.getByLabel('Name', {exact: true}).fill('Revised'); await page.getByRole('button', {name: 'Cancel', exact: true}).click(); actions.push('Changed Name from Original to Revised, then clicked Cancel.');}
      else if (item.id === 'a17') {await page.getByLabel('Name', {exact: true}).fill('Study'); actions.push('Entered Study in the initially empty Name field.');}
      else actions.push('Inspected this ordinary form without editing.');
      if (errors.length) throw new Error(`Invalid calibration fixture ${item.id}: ${errors.join('; ')}`);
      if (panel && await page.locator('#toggle').getAttribute('aria-expanded') !== 'true')
        throw new Error(`Calibration ${item.id} toggle handler did not run`);
      if (panel && await page.locator('#panel').isVisible() !== (item.id === 'f51'))
        throw new Error(`Calibration ${item.id} panel differs from fixture intent`);
      if (cancel && await page.locator('#status').textContent() !== 'Stored name: Revised')
        throw new Error(`Calibration ${item.id} cancellation handler did not run`);
      if (item.id === 'a17' && !await page.locator('#save').isEnabled())
        throw new Error(`Calibration ${item.id} input handler did not run`);
      await shot('after');
      packet.push({id: item.id, images, actions, accessibility: await page.locator('body').ariaSnapshot()});
      await page.close();
    }
  } finally {await browser.close();}
  await writeFile(join(directory, 'packet.json'), JSON.stringify(packet, null, 2));
  await writeFile(join(directory, '..', 'calibration-key.json'), JSON.stringify(cases, null, 2));
}

export async function scoreCalibration(directory, reviewPath) {
  const key = JSON.parse(await readFile(join(directory, '..', 'calibration-key.json'), 'utf8'));
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  if (!Array.isArray(review.cases) || review.cases.length !== key.length || new Set(review.cases.map(x => x.id)).size !== key.length)
    throw new Error('Calibration needs one assessment per case');
  const results = key.map(k => {
    const r = review.cases.find(c => c.id === k.id);
    if (!r || typeof r.issue !== 'boolean' || typeof r.reason !== 'string' || !r.reason.trim())
      throw new Error('Incomplete calibration assessment');
    return {...k, detected: r.issue, reason: r.reason, correct: r.issue === k.broken};
  });
  const families = Object.fromEntries(['behavior', 'composition'].map(family => {
    const rows = results.filter(x => (x.family ?? 'behavior') === family);
    return [family, {detected: rows.filter(x => x.broken && x.detected).length, defects: rows.filter(x => x.broken).length, falseAlarms: rows.filter(x => !x.broken && x.detected).length, controls: rows.filter(x => !x.broken).length}];
  }));
  const result = {results, families, detected: results.filter(x => x.broken && x.detected).length,
    defects: key.filter(x => x.broken).length, falseAlarms: results.filter(x => !x.broken && x.detected).length,
    controls: key.filter(x => !x.broken).length,
    limitation: 'One small synthetic run; this does not establish production recall or reliability.'};
  await writeFile(join(directory, '..', 'calibration-score.json'), JSON.stringify(result, null, 2));
  return result;
}

// Freeze the app assessment before exposing held-out cases. Instruction compliance establishes
// blindness; the seal prevents rewriting product findings after seeing the calibration.
export async function sealReview(directory) {
  const alreadyReviewed = await access(join(directory, 'calibration-review.json')).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (alreadyReviewed) throw new Error('Seal the app review before calibration is assessed');
  const seal = {appReviewSha256: hash(await readFile(join(directory, 'review.json'))), sealedAt: new Date().toISOString()};
  await writeFile(join(directory, 'review-seal.json'), JSON.stringify(seal, null, 2), {flag: 'wx'});
  return seal;
}

export async function verifyReviewSeal(directory, reviewPath) {
  const seal = JSON.parse(await readFile(join(directory, 'review-seal.json'), 'utf8'));
  if (!seal.sealedAt || seal.appReviewSha256 !== hash(await readFile(reviewPath)))
    throw new Error('App review differs from the assessment sealed before calibration');
  return seal;
}
