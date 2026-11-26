import {hash} from './contract.mjs';
import {mkdir, writeFile, readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {randomInt} from 'node:crypto';
import {chromium} from 'playwright';
import {COMPOSITION_PROBES, captureComposition} from './composition-calibration.mjs';
import assert from 'node:assert/strict';

// Held-out miniature interfaces, never injected into the product. Each capture draws its own set:
// which probes appear, whether each shows a concern or an acceptable control, its wording, its
// identifier and its position are all random. The answer key is written outside the packet, keyed
// by the packet's hash. These measure basic detection and false alarms, not overall UX expertise.
export const BEHAVIOR_PROBES = [
  {kind: 'panel', broken: ['inert-panel-control'], control: ['empty-panel-opens']},
  {kind: 'cancel', broken: ['cancel-commits-change'], control: ['cancel-restores-value']},
  {kind: 'save-enable', broken: ['save-stays-disabled'], control: ['legitimate-disabled-action']},
  {kind: 'clipping', broken: ['clipped-primary-action', 'clipped-primary-action-narrow'],
    control: ['ordinary-actions', 'intentional-responsive-wrap']},
  {kind: 'occlusion', broken: ['covered-action-target'], control: ['unobscured-action-target']},
];
export const CASES_PER_FAMILY = 8;
const MIN_CONCERNS = 2, MAX_CONCERNS = CASES_PER_FAMILY - 2;

// Wording sets. Every probe, in either polarity and every variant, must satisfy its layout and
// behavior premise in each of them; the browser test renders them all.
export const THEMES = [
  {form: 'Template details', name: 'Name', description: 'Description', save: 'Save template', cancel: 'Cancel',
    overview: 'Overview', empty: 'There are no fields yet.', stored: 'Stored name', original: 'Original',
    revised: 'Revised', entered: 'Study', prompt: 'Enter a name before saving.',
    records: 'Records', recordsIntro: 'Browse the study records.', item: 'Observation', column: 'Record name',
    settings: 'Measurement settings', shortName: 'Elapsed time', longName: 'Estimated total elapsed observation time',
    facts: 'Decimal · seconds', settingsIntro: 'Set the properties used when recording this measurement.',
    code: 'Internal code', codeValue: 'elapsed_time', precision: 'Precision', precisionValue: '2 decimal places',
    enable: 'Enable limits', lower: 'Lower bound', upper: 'Upper bound', rowTitle: 'Measurement', rowNote: 'Recorded observation'},
  {form: 'Publication record', name: 'Title', description: 'Abstract', save: 'Save record', cancel: 'Cancel',
    overview: 'Outline', empty: 'No sections have been added.', stored: 'Stored title', original: 'Draft',
    revised: 'Final', entered: 'Survey', prompt: 'Enter a title before saving.',
    records: 'Publications', recordsIntro: 'Browse the catalogued publications.', item: 'Article', column: 'Title',
    settings: 'Page settings', shortName: 'Page count', longName: 'Total number of pages including all appendices',
    facts: 'Integer · pages', settingsIntro: 'Set the properties used when cataloguing this publication.',
    code: 'Catalogue key', codeValue: 'page_count', precision: 'Rounding', precisionValue: 'Whole pages',
    enable: 'Enable range', lower: 'Fewest pages', upper: 'Most pages', rowTitle: 'Chapters', rowNote: 'Catalogued chapter'},
  {form: 'Instrument profile', name: 'Label', description: 'Notes', save: 'Save profile', cancel: 'Cancel',
    overview: 'Summary', empty: 'No channels are configured.', stored: 'Stored label', original: 'Bench',
    revised: 'Field', entered: 'Probe', prompt: 'Enter a label before saving.',
    records: 'Runs', recordsIntro: 'Browse the recorded instrument runs.', item: 'Run', column: 'Run name',
    settings: 'Channel settings', shortName: 'Wavelength', longName: 'Peak excitation wavelength of the light source',
    facts: 'Decimal · nanometres', settingsIntro: 'Set the properties used when recording this channel.',
    code: 'Channel key', codeValue: 'wavelength', precision: 'Resolution', precisionValue: '0.1 nanometre',
    enable: 'Use window', lower: 'Shortest (nm)', upper: 'Longest (nm)', rowTitle: 'Readings', rowNote: 'Recorded reading'},
];

const pick = (list, random) => list[random(list.length)];
function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {const j = random(i + 1); [list[i], list[j]] = [list[j], list[i]];}
  return list;
}
const signature = item => [item.kind, item.broken, item.category, item.theme].join('|');

// Every probe appears at least once per family; the remaining slots repeat probes at random. Each
// slot's polarity is drawn independently, held between two and six concerns per family, so neither
// the set of probes nor the count of concerns reveals an answer. No two cases render identically.
export function drawCases(random = randomInt) {
  for (;;) {
    const ids = new Set();
    const id = () => {
      let value;
      do value = pick('abcdefghjkmnpqrstuvwxyz', random) + String(random(100)).padStart(2, '0'); while (ids.has(value));
      ids.add(value);
      return value;
    };
    const family = (name, probes) => {
      let polarity;
      do polarity = Array.from({length: CASES_PER_FAMILY}, () => random(2) === 1);
      while (polarity.filter(Boolean).length < MIN_CONCERNS || polarity.filter(Boolean).length > MAX_CONCERNS);
      const slots = [...probes, ...Array.from({length: CASES_PER_FAMILY - probes.length}, () => pick(probes, random))];
      return slots.map((probe, i) => ({id: id(), family: name, kind: probe.kind, broken: polarity[i],
        category: pick(probe[polarity[i] ? 'broken' : 'control'], random), theme: random(THEMES.length)}));
    };
    const cases = [...family('behavior', BEHAVIOR_PROBES), ...family('composition', COMPOSITION_PROBES)];
    if (new Set(cases.map(signature)).size === cases.length) return shuffle(cases, random);
  }
}

async function captureOcclusion(browser, directory, item, t) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{font:18px system-ui;color:#173e3c;margin:40px}
      main{width:420px;height:340px;padding:20px;border:1px solid #bdcccc;overflow:auto;display:flex;flex-direction:column}
      .intro{height:380px;flex:none}.listing{min-height:240px;overflow:auto}
      table{width:100%;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid #bdcccc}
      th{position:sticky;top:0;z-index:1;background:white}
      footer{position:sticky;bottom:0;z-index:${item.broken ? 0 : 1};background:white;display:flex;align-items:center;justify-content:space-between;min-height:52px;flex:none}
      button{font:inherit;padding:8px 12px}#status{margin:20px 0}
      </style><main><div class="intro"><h1>${t.records}</h1><p>${t.recordsIntro}</p></div>
      <div class="listing"><table><thead><tr><th>${t.column}</th></tr></thead><tbody>${Array.from({length: 8}, (_, i) => `<tr><td>${t.item} ${i + 1}</td></tr>`).join('')}</tbody></table></div>
      <footer><span id="page">Page 1</span><button>Next</button></footer></main><p id="status">Page 1 selected.</p>
      <script>document.querySelector('button').onclick=()=>{
        document.querySelector('#page').textContent='Page 2';
        document.querySelectorAll('tbody td').forEach((cell,i)=>cell.textContent=${JSON.stringify(t.item)}+' '+(i+9));
        document.querySelector('#status').textContent='Page 2 selected.';
      }</script>`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('main').evaluate((main, broken) => {
      if (broken) main.scrollTop += main.querySelector('th').getBoundingClientRect().top - main.querySelector('button').getBoundingClientRect().top;
      else main.scrollTop = main.scrollHeight;
    }, item.broken);
    const target = await page.locator('button').evaluate(button => {
      const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {x, y, topTag: top?.tagName, topText: top?.textContent.trim(), receivesPointer: top === button || button.contains(top)};
    });
    assert.equal(target.receivesPointer, !item.broken, 'Occlusion calibration must prove its pointer-target premise');
    const images = [`${item.id}-before.png`, `${item.id}-after.png`];
    await page.screenshot({path: join(directory, images[0])});
    // A locator click may scroll away the overlap, hiding the ordinary pointer failure.
    await page.mouse.click(target.x, target.y);
    assert.equal(await page.locator('#status').textContent(), item.broken ? 'Page 1 selected.' : 'Page 2 selected.');
    assert.equal(await page.locator('#page').textContent(), item.broken ? 'Page 1' : 'Page 2');
    assert.equal(await page.locator('tbody td').first().textContent(), `${t.item} ${item.broken ? 1 : 9}`);
    if (!item.broken) {
      const readable = await page.locator('tbody td').first().evaluate(cell => {
        const row = cell.getBoundingClientRect(), pane = cell.closest('main').getBoundingClientRect();
        const header = cell.closest('table').querySelector('th').getBoundingClientRect();
        const footer = cell.closest('main').querySelector('footer').getBoundingClientRect();
        return row.top >= Math.max(pane.top, header.bottom) && row.bottom <= footer.top;
      });
      assert(readable, 'Unobscured action control must also show a complete result after paging');
    }
    await page.screenshot({path: join(directory, images[1])});
    return {id: item.id, images, actions: ['Scrolled the record pane, then clicked the center of Next without further scrolling.'],
      pointerTarget: target, accessibility: await page.locator('body').ariaSnapshot()};
  } finally {await page.close();}
}

async function captureForm(browser, directory, item, t) {
  // setContent does not reset a page's JavaScript global lexical scope. Give every case its own
  // document so repeated declarations cannot silently disable handlers.
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const {kind, broken, category} = item;
    const panel = kind === 'panel', cancel = kind === 'cancel', enable = kind === 'save-enable';
    const clipped = category.startsWith('clipped-primary-action');
    const narrow = category === 'intentional-responsive-wrap' || category === 'clipped-primary-action-narrow';
    const content = panel
      ? `<button id="toggle" aria-expanded="false">${t.overview}</button><aside id="panel" hidden>${t.empty}</aside>`
      : `<div class="row"><label>${t.name}<input id="name" value="${cancel || kind === 'clipping' ? t.original : ''}"></label><label>${t.description}<textarea></textarea></label></div><div class="actions"><button id="save" ${enable ? 'disabled' : ''}>${t.save}</button><button id="cancel">${t.cancel}</button></div><p id="status">${cancel ? `${t.stored}: ${t.original}` : enable ? t.prompt : ''}</p>`;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;margin:40px;color:#173e3c}main{border:1px solid #bdcccc;padding:24px;width:${narrow ? '330' : '800'}px}h1{font-size:24px}.row{display:flex;gap:20px;flex-wrap:wrap}label{display:flex;flex-direction:column;gap:6px}input,textarea,button{font:inherit;padding:9px}input,textarea{width:280px}.actions{display:flex;gap:12px;margin-top:20px}aside{margin-top:20px;border:1px solid #bdcccc;padding:20px}${clipped ? '#save{width:44px;white-space:nowrap;overflow:hidden}' : ''}</style><main><h1>${t.form}</h1>${content}</main><script>
      let stored=${JSON.stringify(t.original)};
      document.querySelector('#toggle')?.addEventListener('click',e=>{e.target.setAttribute('aria-expanded',e.target.getAttribute('aria-expanded')!=='true');${panel && !broken ? "document.querySelector('#panel').hidden=!document.querySelector('#panel').hidden" : ''}});
      document.querySelector('#name')?.addEventListener('input',e=>{
        ${enable && broken ? '' : "document.querySelector('#save').disabled=!e.target.value.trim();"}
        ${enable ? "document.querySelector('#status').hidden=!!e.target.value.trim();" : ''}
      });
      function save(){stored=document.querySelector('#name').value;document.querySelector('#status').textContent=${JSON.stringify(t.stored + ': ')}+stored}
      document.querySelector('#save')?.addEventListener('click',save);
      document.querySelector('#cancel')?.addEventListener('click',()=>{${cancel && broken ? 'save()' : "document.querySelector('#name').value=stored"}});
      </script>`);
    await page.evaluate(() => document.fonts.ready);
    const images = [];
    const shot = async suffix => {const name = `${item.id}-${suffix}.png`; await page.screenshot({path: join(directory, name)}); images.push(name);};
    await shot('before');
    const actions = [];
    if (panel) {
      await page.getByRole('button', {name: t.overview, exact: true}).click();
      actions.push(`Clicked ${t.overview}.`);
    } else if (cancel) {
      await page.getByLabel(t.name, {exact: true}).fill(t.revised);
      await page.getByRole('button', {name: t.cancel, exact: true}).click();
      actions.push(`Changed ${t.name} from ${t.original} to ${t.revised}, then clicked ${t.cancel}.`);
    } else if (enable) {
      await page.getByLabel(t.name, {exact: true}).fill(t.entered);
      actions.push(`Entered ${t.entered} in the initially empty ${t.name} field.`);
    } else actions.push('Inspected this ordinary form without editing.');
    // Prove each fixture's premise before it can score a reviewer.
    const fail = message => {throw new Error(`Invalid calibration fixture ${category}: ${message}`);};
    if (errors.length) fail(errors.join('; '));
    if (panel) {
      if (await page.locator('#toggle').getAttribute('aria-expanded') !== 'true') fail('toggle handler did not run');
      if (await page.locator('#panel').isVisible() === broken) fail('panel visibility differs from intent');
    }
    if (cancel) {
      const expected = broken ? t.revised : t.original;
      if (await page.locator('#status').textContent() !== `${t.stored}: ${expected}`) fail('cancellation outcome differs from intent');
      if (await page.locator('#name').inputValue() !== expected) fail('name after cancellation differs from intent');
    }
    if (enable && await page.locator('#save').isEnabled() === broken) fail('save availability differs from intent');
    if (enable && await page.locator('#status').isVisible()) fail('obsolete required-value hint remains after entry');
    if (kind === 'clipping') {
      const overflow = await page.locator('button').evaluateAll(buttons => buttons.map(b => b.scrollWidth > b.clientWidth));
      if (overflow[0] !== clipped || overflow.slice(1).some(Boolean)) fail('button clipping differs from intent');
      const rows = await page.locator('.row label').evaluateAll(labels => new Set(labels.map(l => Math.round(l.getBoundingClientRect().y))).size);
      if ((rows > 1) !== narrow) fail('field wrapping differs from intent');
    }
    await shot('after');
    return {id: item.id, images, actions, accessibility: await page.locator('body').ariaSnapshot()};
  } finally {await page.close();}
}

export async function captureCase(browser, directory, item) {
  const theme = THEMES[item.theme];
  if (item.family === 'composition') return captureComposition(browser, directory, item, theme);
  if (item.kind === 'occlusion') return captureOcclusion(browser, directory, item, theme);
  return captureForm(browser, directory, item, theme);
}

// The answer key lives outside every packet, so a reviewer given the packet directory never holds it.
export function keyDirectory() {
  if (process.env.CEDAR_UI_REVIEW_KEYS) return process.env.CEDAR_UI_REVIEW_KEYS;
  if (!process.env.CEDAR_HOME) throw new Error('CEDAR_HOME is required to locate calibration answer keys');
  return join(process.env.CEDAR_HOME, '.cedar/ui-review-keys');
}
const keyPath = (keys, packet) => join(keys, hash(packet) + '.json');

export async function captureCalibration(directory, {keys = keyDirectory(), cases = drawCases()} = {}) {
  await mkdir(directory, {recursive: false});
  const browser = await chromium.launch();
  const packet = [];
  try {
    for (const item of cases) packet.push(await captureCase(browser, directory, item));
  } finally {await browser.close();}
  // The images are what the reviewer judges, so the packet, and through it the key, carries their digests.
  for (const entry of packet)
    entry.imageSha256 = Object.fromEntries(await Promise.all(entry.images.map(async file => [file, hash(await readFile(join(directory, file)))])));
  const raw = JSON.stringify(packet, null, 2);
  await writeFile(join(directory, 'packet.json'), raw);
  await mkdir(keys, {recursive: true});
  await writeFile(keyPath(keys, raw), JSON.stringify(cases, null, 2), {flag: 'wx'});
}

export async function scoreCalibration(directory, reviewPath, {keys = keyDirectory()} = {}) {
  const raw = await readFile(join(directory, 'packet.json'), 'utf8');
  const key = JSON.parse(await readFile(keyPath(keys, raw), 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('No answer key matches this calibration packet; it was changed or generated elsewhere');
    throw error;
  }));
  assert.deepEqual(JSON.parse(raw).map(c => c.id).sort(), key.map(c => c.id).sort(), 'Calibration key and packet disagree');
  // A score is only worth the images it was given: each must be present and unchanged since capture.
  for (const entry of JSON.parse(raw)) {
    const digests = entry.imageSha256 ?? {};
    if (!Array.isArray(entry.images) || !entry.images.length || entry.images.some(file => typeof digests[file] !== 'string'))
      throw new Error(`Calibration case ${entry.id} records no digest for its images; capture calibration again`);
    for (const file of entry.images) {
      if (!/^[\w.-]+$/.test(file)) throw new Error('Unsafe calibration image path: ' + file);
      const bytes = await readFile(join(directory, file)).catch(() => null);
      if (!bytes || hash(bytes) !== digests[file]) throw new Error('Calibration image missing or changed since capture: ' + file);
    }
  }
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
