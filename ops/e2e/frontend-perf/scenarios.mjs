import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
const enc = encodeURIComponent;
// Fixture generation is independent of authentication and REST harness initialization.
function artifactBody(kind, name) {
  const body = JSON.parse(readFileSync(new URL(`../fixtures/minimal-${kind}.json`, import.meta.url), 'utf8'));
  body['@id'] = null;
  body['schema:name'] = name;
  return body;
}

export const sizes = {small:5, large:100};
export function template(count) {
  const body = artifactBody('template', `Performance ${count} fields`);
  body['schema:description'] = 'Fixed text-field performance fixture';
  for (let i=1;i<=count;i++) {
    const name = `Field ${String(i).padStart(3,'0')}`;
    const field = artifactBody('field', name);
    field['schema:description'] = '';
    body.properties[name] = field;
    body.properties['@context'].properties[name] = {enum:[`https://example.org/perf/field-${i}`]};
    body._ui.order.push(name); body._ui.propertyLabels[name] = name;
    body.required.push(name);
  }
  return body;
}

export async function standaloneFixtures(root, domain, integratedScript, selected) {
  for (const [size,count] of Object.entries(sizes)) await writeFile(join(root,`${size}.json`), JSON.stringify(template(count)));
  for (const [name,tag,property] of [['cee','cedar-embeddable-editor','templateObject'], ['ced','cedar-embeddable-designer','template'], ['ced-integrated','cedar-embeddable-designer','template'], ['cetp','cedar-embeddable-term-picker',null]]) {
    if (selected && !selected.includes(name)) continue;
    const integrated = name === 'ced-integrated';
    if (integrated && !integratedScript) throw new Error('Missing equivalent Designer component delivery');
    await writeFile(join(root,`${name}.html`), `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name.toUpperCase()} performance fixture</title>
      <link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:24px} ${tag}{display:block;min-height:600px}</style>
      ${integrated ? `<link rel="stylesheet" href="https://designer.${domain}/components/fonts.css"><link rel="stylesheet" href="https://designer.${domain}/components/custom-properties.css">` : ''}
      <${tag}></${tag}><script src="${integrated ? integratedScript : '/'+name+'.js'}"></script><script>
      (async () => {
        await customElements.whenDefined('${tag}'); const el = document.querySelector('${tag}');
        window.__changes = 0; el.addEventListener('${name.startsWith('ced') ? 'templateChange' : 'change'}', () => window.__changes++);
        ${property ? `el.config = {defaultLanguage:'en', fallbackLanguage:'en', terminologyBaseUrl:'https://terminology.${domain}/', bridgeBaseUrl:'https://bridge.${domain}/'};
        el.${property} = await (await fetch('/' + (new URLSearchParams(location.search).get('size') || 'small') + '.json')).json();` :
        `el.terminologyBaseUrl = 'https://terminology.${domain}/'; el.selectionMode = 'constraints';`}
        window.__configured = true;
      })().catch(error => {throw error});</script></html>`);
  }
}

export async function fixtures(directory) {
  const {actors, call, mutate, mintId} = await import('../rest/lib.mjs');
  const {assertSafeTargets} = await import('../rest-perf/lib.mjs');
  assertSafeTargets({allowRemote:false});
  const {user1:user} = await actors(), created = [], ids = {};
  const ledger = join(directory,'fixtures.json');
  const save = () => writeFile(ledger, JSON.stringify({created, ids},null,2)+'\n');
  const cleanup = async () => {
    // A full baseline can outlive the setup token.
    const {user1:currentUser} = await actors();
    const errors = [];
    for (const entry of [...created].reverse()) {
      if (entry.deleted) continue;
      try {
        const path = '/' + entry.collection + '/' + enc(entry.id);
        const before = await call(currentUser.auth,'GET',path);
        if (before.status !== 404) {
          const result = await mutate(currentUser.auth,'DELETE',path);
          assert.equal(result.status,204,`Cleanup ${entry.collection}: ${result.status}`);
          assert.equal((await call(currentUser.auth,'GET',path)).status,404);
        }
        entry.deleted = true; await save();
      } catch(error) {errors.push(error.message);}
    }
    return errors;
  };
  try {
    const folder = await call(user.auth,'POST','/folders', {folderId:user.profile.homeFolderId,
      name:`Frontend performance ${Date.now()}`, description:'Temporary performance fixtures'});
    assert.equal(folder.status,201,folder.text);
    const folderId = folder.body['@id'];
    created.push({collection:'folders',id:folderId}); await save();
    for (const [size,count] of Object.entries(sizes)) {
      const body = template(count);
      // Pre-register identities so a lost write response still has a cleanup target.
      const id = mintId('templates'); body['@id'] = id;
      created.push({collection:'templates',id}); await save();
      const made = await call(user.auth,'PUT','/templates/'+enc(id)+'?folder_id='+enc(folderId),body,{headers:{'If-None-Match':'*'}});
      assert.equal(made.status,201,made.text);
      ids[size] = id; await save();
      const opened = await mutate(user.auth,'POST','/command/make-artifact-open',{'@id':id}, {etagPath:'/templates/'+enc(id)+'/details'});
      assert.equal(opened.status,200,opened.text);
    }
    return {ids,folderId,cleanup};
  } catch(error) {const errors = await cleanup(); if (errors.length) error.message += '; cleanup: '+errors.join('; '); throw error;}
}

const visible = selector => async page => page.locator(selector).first().waitFor({state:'visible'});
// Target the fixture controls directly. Broad accessible-name queries walk every field and
// can themselves create long tasks under CPU throttling, contaminating the measurement.
const editorReady = async page => {
  const field = page.locator('cedar-embeddable-editor input[aria-label="Field 001"]');
  await field.waitFor({state:'visible'});
  assert.equal(await field.isEnabled(),true);
};
const designerReady = async page => {
  const field = page.locator('cedar-embeddable-designer input.field-name').first();
  await field.waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('cedar-embeddable-designer');
    return el?.currentTemplate?._ui?.order?.includes('Field 001');
  });
  assert.equal(await field.inputValue(),'Field 001');
  assert.equal(await field.isEnabled(),true);
};
// Confirm the same real CEF summaries in both lanes; the bare CED lane uses its fallback.
const fieldSummariesReady = count => async page => page.waitForFunction(expected => {
  const root = document.querySelector('cedar-embeddable-designer')?.shadowRoot;
  const summaries = [...(root?.querySelectorAll('app-field-summary cedar-embeddable-field') ?? [])];
  return summaries.length === expected && summaries.every(field => (field.shadowRoot ?? field).querySelector('.cee-spec-box'));
}, count);
const typeAnswer = async page => {
  const field = page.locator('cedar-embeddable-editor input[aria-label="Field 001"]');
  await field.pressSequentially('Performance answer'); await field.press('Tab');
  assert.equal(await field.inputValue(),'Performance answer');
};
const renameField = async page => {
  const field = page.locator('cedar-embeddable-designer input.field-name').first();
  await field.fill('Measured field'); await field.press('Tab');
  await page.waitForFunction(() => document.querySelector('cedar-embeddable-designer')?.currentTemplate?._ui?.propertyLabels?.['Field 001'] === 'Measured field');
};

export function scenarios(domain, ids, folderId) {
  const base = name => `https://${name}.${domain}`;
  const rows = [
    {id:'workspace-dashboard',url:base('workspace')+'/dashboard?sort=name&view=list'+(folderId ? '&folderId='+enc(folderId) : ''), auth:true,
      ready:visible('cedar-workspace-page .destinations'), readiness:'Dashboard destinations and listing finished',
      async settled(page) {await page.waitForFunction(() => document.querySelector('.table-scroll')?.getAttribute('aria-busy') === 'false');}},
    {id:'monitoring-dashboard',url:base('monitoring')+'/',auth:true,
      ready:async p => p.locator('mat-card-title',{hasText:'Health Checks'}).waitFor(), readiness:'Health Checks navigation card visible'},
    {id:'bridging-dashboard',url:base('bridging')+'/',auth:true,
      ready:async p => p.locator('mat-card-title',{hasText:'Create Datacite DOI'}).waitFor(), readiness:'Create Datacite DOI landing card visible'},
    {id:'content-index',url:base('content')+'/',ready:visible('h1'),readiness:'Content distribution index heading visible'},
    {id:'term-picker',url:base('performance')+'/cetp.html',ready:visible('cedar-embeddable-term-picker input[type=search]'),
      readiness:'Empty picker search control visible (no terminology query)'},
  ];
  for (const size of Object.keys(sizes)) {
    rows.push({id:`cee-standalone-${size}`,url:base('performance')+`/cee.html?size=${size}`,ready:editorReady,
      readiness:`First editable text field in ${sizes[size]}-field form`,action:typeAnswer,actionName:'Type and blur first answer'});
    rows.push({id:`ced-standalone-${size}`,url:base('performance')+`/ced.html?size=${size}`,ready:designerReady,
      readiness:`Loaded ${sizes[size]}-field template and first name input`,action:renameField,actionName:'Edit field display name and publish updated model'});
    rows.push({id:`ced-integrated-${size}`,url:base('performance')+`/ced-integrated.html?size=${size}`,ready:designerReady,
      settled:fieldSummariesReady(sizes[size]), readiness:`Loaded ${sizes[size]}-field template with all real CEF summaries, using Designer's shared component bundle without its host`,
      action:renameField,actionName:'Edit field display name and publish updated model'});
    rows.push({id:`designer-${size}`,url:base('designer')+'/templates/edit/'+enc(ids[size]),auth:true,ready:async p => {
      await p.locator('#state').filter({hasText:/^Unmodified$/}).waitFor(); await designerReady(p);
    },settled:fieldSummariesReady(sizes[size]),readiness:`Saved ${sizes[size]}-field template loaded with permissions and all real CEF summaries`,action:renameField,actionName:'Edit field display name and publish updated model (no save)'});
    rows.push({id:`workspace-editor-${size}`,url:base('workspace')+'/instances/create/'+enc(ids[size]),auth:true,ready:editorReady,
      readiness:`Editable ${sizes[size]}-field CEE form in Workspace`,action:typeAnswer,actionName:'Type and blur first answer (no save)'});
    rows.push({id:`openview-${size}`,url:base('openview')+'/templates/'+ids[size].split('/').at(-1),
      ready:async p => {await p.locator('cedar-embeddable-editor').waitFor(); await p.getByText('Field 001',{exact:true}).first().waitFor();},
      readiness:`Public ${sizes[size]}-field template rendered in CEE`});
  }
  return rows;
}

export const scenarioFamily = id => id.replace(/-(small|large)$/, '');
export const authenticationCases = cases => [...new Map(cases.filter(s => s.auth)
  .map(s => [scenarioFamily(s.id), s])).values()];

export async function authenticate(browser, cases, directory) {
  const context = await browser.newContext({ignoreHTTPSErrors:true});
  context.setDefaultTimeout(60000);
  const extraContexts = [], byScenario = {}, failures = [];
  try {
    for (const entry of authenticationCases(cases)) {
      console.log('Preparing signed-in session: '+entry.id);
      const monitorLogin = entry.id === 'monitoring-dashboard' && process.env.CEDAR_PERF_MONITOR_LOGIN;
      const owner = monitorLogin ? await browser.newContext({ignoreHTTPSErrors:true}) : context;
      owner.setDefaultTimeout(60000);
      if (owner !== context) extraContexts.push(owner);
      const page = await owner.newPage();
      try {
      await page.goto(entry.url,{waitUntil:'domcontentloaded'});
      const login = page.locator('#username');
      await Promise.race([login.waitFor(),entry.ready(page),
        page.locator('app-no-access').waitFor().then(() => {throw new Error('Account lacks MONITOR_READ; use an authorized local Monitor test account');})]);
      if (await login.isVisible()) {
        const password = monitorLogin ? process.env.CEDAR_PERF_MONITOR_PASSWORD : process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
        if (!password) throw new Error('CEDAR_PERF_MONITOR_PASSWORD is required with CEDAR_PERF_MONITOR_LOGIN');
        await login.fill(monitorLogin || process.env.CEDAR_FRONTEND_local_USER1_LOGIN || 'test1@test.com');
        await page.locator('#password').fill(password);
        await page.locator('#kc-login').click();
      }
      await entry.ready(page);
      if (owner !== context) byScenario[entry.id] = await owner.storageState();
      await page.close();
      } catch(error) {
        await page.screenshot({path:join(directory,entry.id+'-auth-failure.png')}).catch(()=>{});
        await writeFile(join(directory,entry.id+'-auth-failure.txt'),await page.locator('body').innerText().catch(()=>''));
        failures.push({scenario:entry.id,error:error.message});
        console.error(`Authentication setup for ${entry.id}: ${error.message.split('\n')[0]}`);
        await page.close();
      }
    }
    return {default:await context.storageState(),byScenario,failures}; // Credentials stay in memory.
  } finally {await context.close(); for (const extra of extraContexts) await extra.close();}
}
