import {readFile, writeFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {STATES, hash, validateReview, verdict, acceptanceBlockers} from './contract.mjs';

const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const output = option('output') && resolve(option('output'));
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({app: 'designer', states: STATES, workflow: 'capture → fresh independent reviewer → validate review',
    scope: 'Local real host and components; temporary template writes are removed. No product code or baseline changes.',
    review: 'Inspect images and interaction evidence; explore further using session.mjs. Missing coverage never passes.'}, null, 2));
} else if (process.argv.includes('--seal-review')) {
  if (!output) throw new Error('--output is required');
  const {sealReview} = await import('./calibration.mjs');
  console.log(JSON.stringify(await sealReview(output)));
} else if (option('review')) {
  const text = await readFile(join(output, 'capture.json'), 'utf8');
  const capture = {...JSON.parse(text), captureSha256: hash(text)};
  const review = JSON.parse(await readFile(resolve(option('review')), 'utf8'));
  const available = new Set(Object.keys(capture.files));
  const errors = validateReview(capture, review, available);
  for (const [file, digest] of Object.entries(capture.files)) {
    try {if (hash(await readFile(join(output, file))) !== digest) errors.push(`Evidence changed after capture: ${file}`);}
    catch {errors.push(`Evidence missing after capture: ${file}`);}
  }
  let calibration;
  try {
    const {scoreCalibration, verifyReviewSeal} = await import('./calibration.mjs');
    await verifyReviewSeal(output, resolve(option('review')));
    calibration = await scoreCalibration(join(output, 'calibration'), join(output, 'calibration-review.json'));
    if (calibration.detected !== calibration.defects || calibration.falseAlarms)
      errors.push('Reviewer did not distinguish all concealed calibration defects from acceptable controls');
  } catch (error) {errors.push('Calibration incomplete: ' + error.message);}
  const result = {verdict: verdict(capture, review, errors), validationErrors: errors,
    acceptanceBlockers: acceptanceBlockers(capture, errors),
    captureSha256: capture.captureSha256, calibration, review, scope: 'A reviewed pilot, not release certification or proof of complete UX coverage.'};
  await writeFile(join(output, 'review-result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, 'review-result.html'), reportHtml(capture, result));
  console.log(`${result.verdict}: ${review?.findings?.length ?? 0} findings; ${join(output, 'review-result.html')}`);
  if (result.acceptanceBlockers.length) console.error(result.acceptanceBlockers.join('\n'));
  process.exitCode = result.verdict === 'INCOMPLETE' ? 2 : result.verdict === 'REVIEWED' ? 0 : 1;
} else if (process.argv.includes('--capture')) {
  if (!output) throw new Error('--output is required');
  await collect(output);
} else throw new Error('Choose --plan, --capture --output=DIR, or --review=JSON --output=DIR');

async function collect(directory) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const {openSession} = await import('./session.mjs');
  const session = await openSession(directory);
  const {page, action, capture} = session;
  const incomplete = [];
  let served = null, servedVerified = false;
  const record = async (id, operation, note = '') => {
    try {if (operation) await action(id, operation); await capture(id, note);}
    catch (error) {
      incomplete.push({state: id, error: error.message});
      console.error(`INCOMPLETE ${id}: ${error.message.split('\n')[0]}`);
      await capture(`${id}-unreached`, 'The requested interaction did not complete.').catch(() => {});
    }
  };
  const card = () => page.locator('app-field-card').first();
  const toggle = name => page.locator(`.${name}-toggle`).click();
  const settings = async tab => {
    const expand = card().getByRole('button', {name: 'Expand field settings', exact: true});
    if (await expand.isVisible()) await expand.click();
    await card().getByRole('tab', {name: tab, exact: true}).click();
  };
  try {
    served = await session.servedEvidence();
    execFileSync(process.env.CEDAR_HOME + '/cedar-cli/.venv/bin/python',
      [process.env.CEDAR_HOME + '/cedar-development/ops/frontend_reactor_runtime.py', 'verify', process.env.CEDAR_HOME,
        process.env.CEDAR_HOME + '/cedar-template-designer'], {stdio: 'pipe'});
    servedVerified = true;
    await session.openNew();
    await record('empty');
    await record('empty-panel-a', () => toggle('overview'));
    await record('empty-panel-b', () => toggle('overview'));
    await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now());
    await session.addField('Text', 'Sample');
    await record('single');
    await record('single-panel-a', () => toggle('overview'));
    await record('single-panel-b', () => toggle('overview'));
    const preview = () => page.locator('cedar-embeddable-designer .app-header__actions > .panel-toggle').click();
    const waitForPreview = () => page.locator('.preview-panel').getByRole('heading', {level: 1}).first().waitFor({state: 'visible'});
    await record('single-preview-a', async () => {await preview(); await waitForPreview();});
    await record('single-preview-b', preview);
    for (const tab of ['Configuration', 'Presentation', 'Constraints', 'Annotations', 'Metadata', 'Version'])
      await record(tab.toLowerCase(), () => settings(tab));
    await settings('Configuration');
    await record('collapsed', () => card().getByRole('button', {name: 'Collapse field settings', exact: true}).click());
    await record('expanded', () => card().getByRole('button', {name: 'Expand field settings', exact: true}).click());
    await record('multiple', () => card().getByLabel('Allow multiple', {exact: true}).check());
    await record('long-name', () => card().getByRole('textbox', {name: 'Enter field name', exact: true})
      .fill('Participant preferred contact information and follow-up availability'));
    for (const width of [1440, 1100, 900, 768, 375])
      await record(`width-${width}`, () => page.setViewportSize({width, height: 1000}));
    await action('Prepare short-name layout with both panels', async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Sample');
      await card().getByLabel('Allow multiple', {exact: true}).uncheck();
      await preview(); await waitForPreview();
    });
    for (const width of [1440, 1100, 1024, 900, 768, 375])
      await record(`both-panels-${width}`, () => page.setViewportSize({width, height: 1000}));
    for (const width of [768, 375])
      await record(`configuration-end-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await card().locator('app-property-picker').scrollIntoViewIfNeeded();
      }, 'Explicitly scrolled to inspect the end of Configuration.');
    await action('Enable multiple values with both panels visible', () => card().getByLabel('Allow multiple', {exact: true}).check());
    for (const width of [1100, 768, 375])
      await record(`both-panels-multiple-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
      });
    await action('Prepare a required repeating field', async () => {
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Participant identifier');
      await card().getByLabel('Requirement', {exact: true}).selectOption('required');
      await card().getByLabel('Minimum', {exact: true}).fill('1');
      await card().getByLabel('Maximum', {exact: true}).fill('3');
    });
    for (const width of [1100, 768, 375]) {
      await record(`required-preview-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
      });
      await record(`required-configuration-${width}`, () => card().locator('app-property-picker').scrollIntoViewIfNeeded());
    }
    await action('Inspect a shorter required name', () => card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Participant code'));
    for (const width of [1440, 768]) await record(`required-overview-${width}`, async () => {
      await page.setViewportSize({width, height: 1000});
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
    });
    await action('Return to desktop editing before save', async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      await card().getByLabel('Allow multiple', {exact: true}).uncheck();
      await preview();
    });
    await record('saved', async () => {
      await page.locator('#save').click();
      await page.waitForFunction(() => document.getElementById('state')?.textContent === 'Saved');
    });
    await record('reopened', async () => {await page.reload(); await session.ready();});
    const interruptWrite = route => route.request().method() === 'PUT' ? route.abort('failed') : route.fallback();
    await record('save-unconfirmed', async () => {
      await action('Deliberately interrupt the next temporary-template save', async () => {
        await page.route('**/templates/**', interruptWrite);
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Sample revised');
        await page.locator('#save').click();
        await page.locator('#check-save').waitFor({state: 'visible'});
      });
    }, 'The harness aborted this save request to exercise uncertain-save recovery; this is not a spontaneous transport failure.');
    await record('save-status-checked', async () => {
      await page.unroute('**/templates/**', interruptWrite);
      await page.locator('#check-save').click();
      await page.waitForFunction(() => document.getElementById('state')?.textContent === 'Modified');
    });
    await record('last-field-removed', () => card().getByTitle('Delete field', {exact: true}).click());
    await record('removed-panel-a', () => toggle('overview'));
    await record('removed-panel-b', () => toggle('overview'));
    await session.addField('Text', 'Participant');
    await session.addField('Number', 'Age');
    await record('nested', async () => {
      const insert = page.getByRole('button', {name: 'Add element here', exact: true}).last();
      await insert.scrollIntoViewIfNeeded();
      await action('Reveal insertion actions by hovering their gap', () => insert.locator('..').locator('..').hover());
      try {await action('Insert element using pointer', () => insert.click({timeout: 3000}));}
      catch {
        await capture('nested-pointer-attempt', 'Pointer activation did not complete; keyboard activation follows.');
        await action('Insert element using keyboard', async () => {await insert.focus(); await insert.press('Enter');});
      }
      await page.getByPlaceholder('Enter element name', {exact: true}).last().fill('Visit');
      const container = page.locator('app-container-editor').last();
      await container.getByRole('button', {name: /^Add field$/}).last().click();
      await page.locator('app-field-type-picker').getByRole('button', {name: 'Text', exact: true}).click();
      await page.locator('input[aria-label="Enter field name"]:focus').fill('Visit notes');
    });
    await record('keyboard', async () => {
      await page.locator('.overview-toggle').focus();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          let node = document.activeElement;
          while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
          return {tag: node?.tagName, label: node?.getAttribute('aria-label') || node?.getAttribute('title') || node?.textContent?.trim().slice(0, 100)};
        });
        session.actions.push({label: 'Keyboard Tab', focused});
      }
    });
  } catch (error) {incomplete.push({state: 'session', error: error.message});}
  finally {
    try {
      const end = await session.servedEvidence();
      if (JSON.stringify(end.verified) !== JSON.stringify(served?.verified))
        incomplete.push({state: 'runtime', error: 'Served assets changed during capture'});
    } catch (error) {incomplete.push({state: 'runtime', error: error.message});}
    await session.close();
  }
  for (const id of STATES) if (!session.states.some(state => state.id === id) && !incomplete.some(x => x.state === id))
    incomplete.push({state: id, error: 'Not reached'});
  const runtimeNow = JSON.parse(await readFile(join(process.env.CEDAR_HOME, '.reactor/runtime.json'), 'utf8'));
  if (runtimeNow.build !== provenance.build) incomplete.push({state: 'runtime', error: 'Selected build changed during capture'});
  const fresh = JSON.parse(execFileSync(process.env.CEDAR_HOME + '/cedar-cli/.venv/bin/python', ['-c',
    'import json,sys; from pathlib import Path; from org.metadatacenter.reactor_evidence import source_identity; h=Path(sys.argv[1]); p=json.loads(Path(sys.argv[2]).read_text()); print(json.dumps([n for n,v in p["sources"].items() if source_identity(h/n)!=v["recorded"]]))',
    process.env.CEDAR_HOME, join(directory, 'provenance.json')], {cwd: join(process.env.CEDAR_HOME, 'cedar-cli'), encoding: 'utf8'}));
  provenance.staleAfterCapture = fresh;
  provenance.current = provenance.current && fresh.length === 0;
  const files = {};
  for (const file of (await readdir(directory)).filter(file => /\.(png|json|yml)$/.test(file)))
    files[file] = hash(await readFile(join(directory, file)));
  const result = {schemaVersion: 1, provenance, served, servedVerified, states: session.states,
    incomplete, cleanupErrors: session.cleanupErrors, runtimeErrors: session.runtimeErrors, files};
  const raw = JSON.stringify(result, null, 2) + '\n';
  await writeFile(join(directory, 'capture.json'), raw);
  await writeFile(join(directory, 'reviewer-brief.md'), reviewerBrief(hash(raw)));
  await writeFile(join(directory, 'index.html'), reportHtml(result));
  const {captureCalibration} = await import('./calibration.mjs');
  await captureCalibration(join(directory, 'calibration'));
  console.log(`Captured ${STATES.filter(id => session.states.some(s => s.id === id)).length}/${STATES.length} required states (${session.states.length} total): ${directory}`);
  if (incomplete.length || session.cleanupErrors.length) process.exitCode = 2;
}

function reviewerBrief(digest) {
  return `# Independent Designer UI review\n\nReview the assembled CEDAR Template Designer as a person authoring metadata templates. Preserve the existing product design. Do not read implementation source or ask what defects are expected before recording your findings. Do not edit product code or baselines.\n\nInspect every state in capture.json using the screenshots, card crops, accessibility snapshots, geometry and session.json actions. Card crops cover only the visible viewport and do not scroll; inspect below-fold content through explicit recorded scrolling in a supplemental session. Evaluate control behavior, feedback, state transitions, information grouping, hierarchy, wrapping, visibility, keyboard use and ordinary editing. Explain what is acceptable too. Review the rendered interface independently from implementation correctness. Assess semantic grouping, hierarchy, reading order, visual density, and behavior as separate questions. Readability and lack of overlap are necessary but do not establish a good composition. For each region identify the primary entity or action and the information that belongs with it. Assess proximity, alignment, and use of available space. Compare short and long content and adjacent pane sizes where evidence permits. Explain whether wrapping or stacking is needed to preserve readability, or whether it fragments a small logical group or adds avoidable scanning. When claiming that a wrap or stack is necessary, substantiate it with the visible content, measured text/control widths, spacing and available region width; a narrow viewport alone is not evidence. Geometry includes approximate intrinsic text widths (not a complete layout solver). If fit cannot be established, state uncertainty rather than inventing a space constraint. Check whether all controls can remain present with a coherent grouping. Do not assume all wrapping is wrong. A concern can be worth reporting even when every control still works. Separate supported usability defects, design proposals, and uncertainty; preserve the product's information and interaction model. For behavior findings reproduce a normal user's sequence including hover, focus and scrolling; distinguish harness side effects from product failure. Record acceptable cases as carefully as problems. No finding quota, and no claims about measured user performance without measurement. Do not invent findings to meet a quota. Missing evidence is a limitation.\n\nUse the public openSession(directory) helper exported from ${fileURLToPath(new URL('session.mjs', import.meta.url))} for additional real-browser exploration in a fresh session. It provides page (Playwright), openNew(), action(label, callback), capture(id), addField(type,name), ready() and close(). Always close in finally; only work on its temporary templates. Before saving, set the TEMPLATE name to \`UI review pilot <unique suffix>\` through the Template name input. The helper deliberately aborts writes to other names or existing unowned identifiers; that is a fixture guard, not a product/network failure. Use capture() to retain evidence. Supplemental exploration is separately reported; the frozen capture cannot be overwritten.\n\nComplete and save the application review before opening calibration/packet.json or any calibration images. The coordinator seals review.json, then asks you to review calibration. Do not alter the sealed app review after calibration; report new app observations separately. Never read calibration-key.json, calibration fixture source, or prior reviews.\n\nWrite review.json with schemaVersion:1, reviewer, captureSha256:"${digest}", independence:{freshContext:true,knownDefectsDisclosed:false}, inspectedStates:[all inspected IDs], acceptableObservations:string, composition:{grouping:string,hierarchy:string,wrapping:string,spaceUse:string}, limitations:string, findings:[{id,title,kind:"defect"|"design-proposal"|"uncertain",severity:"high"|"medium"|"low",steps:[strings],observed,expected,impact,evidence:[relative files from capture.files]}]. Additional observations with only supplemental evidence go in a separate supplemental-review.json, never use a nonexistent frozen evidence path. A blank finding list is allowed.\n`;
}

function escape(text) {return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function reportHtml(capture, result) {
  return `<!doctype html><meta charset="utf-8"><title>Designer UI review</title><style>body{font:16px system-ui;max-width:1200px;margin:32px auto;padding:0 20px;color:#163d3c}img{max-width:100%;border:1px solid #ccdada}article{margin:32px 0}a{color:#087c8e}pre{white-space:pre-wrap}li{margin:12px 0}</style><h1>Designer UI review</h1><p>${escape(result?.verdict ?? 'Evidence awaiting independent review')} · build ${escape(capture.provenance.build)}</p>
    ${result ? '<ol>' + (Array.isArray(result.review?.findings) ? result.review.findings : []).filter(f => f && typeof f === 'object').map(f => `<li><strong>${escape(f.title)}</strong> (${escape(f.kind)})<p>${escape(f.observed)}</p><p>${escape(f.impact)}</p>${(Array.isArray(f.evidence) ? f.evidence : []).map(p => `<a href="${escape(p)}">${escape(p)}</a> `).join('')}</li>`).join('') + '</ol><p>' + escape(result.review?.limitations) + '</p>' : ''}
    ${result ? `<h2>Composition assessment</h2><dl>${[['grouping', 'Grouping'], ['hierarchy', 'Hierarchy'], ['wrapping', 'Wrapping'], ['spaceUse', 'Use of space']].map(([aspect, label]) => `<dt><strong>${escape(label)}</strong></dt><dd>${escape(result.review?.composition?.[aspect])}</dd>`).join('')}</dl><h2>Acceptable behavior</h2><p>${escape(result.review?.acceptableObservations)}</p>` : ''}
    <p>Collection incomplete: ${escape(JSON.stringify(capture.incomplete))}</p>
    ${result ? `<p>Acceptance blockers: ${escape(JSON.stringify(result.acceptanceBlockers))}</p><p>Review validation: ${escape(JSON.stringify(result.validationErrors))}</p><p>Calibration: ${result.calibration?.detected ?? '?'}/${result.calibration?.defects ?? '?'} concealed defects detected; ${result.calibration?.falseAlarms ?? '?'} false alarms.</p>` : ''}
    ${capture.states.map(s => `<article id="${s.id}"><h2>${escape(s.id)}</h2><p>${escape(s.note)}</p><a href="${s.aria}">Accessibility snapshot</a> · <a href="${s.metrics}">Geometry and controls</a><img loading="lazy" src="${s.screenshot}" alt="${escape(s.id)}">${s.crops.map(p => `<a href="${p}">Card detail</a> `).join('')}</article>`).join('')}`;
}
