// Real login + CED rendering, create/update and stale-save protection through the split host.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { actors, call, mutate, enc, artifactBody } from './rest/lib.mjs';
const designerBase = process.env.CEDAR_DESIGNER_BASE || 'https://designer.metadatacenter.orgx';
const workspaceBase = process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
const { user1 } = await actors();
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
context.setDefaultTimeout(30000);
const page = await context.newPage();
const created = [];
const errors = [];
const responseBodies = new Map();
// Capture writes before fulfilling them: the host navigates immediately after success.
await page.route(url => /^\/(templates|template-elements|template-fields|command\/publish-create-draft-template)(?:\/|$)/.test(url.pathname), async intercepted => {
  const req = intercepted.request();
  if (!['POST', 'PUT'].includes(req.method())) return intercepted.continue();
  const response = await intercepted.fetch();
  const data = await response.json();
  responseBodies.set(req.method() + ' ' + req.url(), data);
  if (req.method() === 'POST' && response.ok() && data['@id']) {
    const path = new URL(req.url()).pathname;
    const collection = path.startsWith('/template-fields') ? 'template-fields' : path.startsWith('/template-elements') ? 'template-elements' : 'templates';
    created.push({ collection, id: data['@id'] });
  }
  await intercepted.fulfill({ response });
});
page.on('pageerror', error => errors.push(error.message));
let savingNavigation = false;
page.on('dialog', dialog => {
  // Deliberate navigation away from stale edits may warn; successful Save must not.
  if (savingNavigation) errors.push(`Unexpected ${dialog.type()} dialog after Save: ${dialog.message()}`);
  void dialog.accept();
});
async function save() {
  savingNavigation = true;
  await page.locator('#save').click();
}
async function open(path) {
  savingNavigation = false;
  await page.goto(designerBase + path);
  await page.locator('#username, cedar-embeddable-designer, cedar-embeddable-field-designer, #message[data-error=true]').first().waitFor({ state: 'visible' });
  if (await page.locator('#username').isVisible().catch(() => false)) {
    await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || 'test1@test.com');
    await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || 'test1');
    await page.locator('#kc-login').click();
  }
  await page.waitForFunction(() => document.querySelector('cedar-embeddable-designer, cedar-embeddable-field-designer')?.shadowRoot?.querySelector('input, button'), { timeout: 30000 });
  await page.waitForFunction(() => ['No unsaved changes', 'Unsaved changes'].includes(document.getElementById('state').textContent));
  if (path.startsWith('/fields/edit/')) {
    await page.getByRole('button', { name: 'Expand field settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Display', exact: true }).click();
  }
}
try {
  for (const [kind, route, collection] of [['template', 'templates', 'templates'], ['element', 'elements', 'template-elements'], ['field', 'fields', 'template-fields']]) {
    const name = `CED host smoke ${kind} ${Date.now()}`;
    const params = new URLSearchParams({ folderId: user1.profile.homeFolderId, returnTo: workspaceBase + '/dashboard' });
    await open(`/${route}/create?${params}`);
    if (kind === 'field') await page.getByRole('button', { name: 'Number', exact: true }).click();
    const nameInput = () => kind === 'template' ? page.getByPlaceholder('Template name', { exact: true }) : page.getByRole('textbox', { name: kind === 'field' ? 'Field name' : 'Element name', exact: true });
    const descriptionInput = () => page.getByPlaceholder(kind === 'field' ? 'Add helper instructions for users...' : 'Add description...', { exact: true });
    await nameInput().fill(name);
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    const savedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/${collection}?`));
    await save();
    const response = await savedResponse;
    const body = responseBodies.get('POST ' + response.url());
    if (response.status() !== 201) {
      await writeFile('/tmp/ced-host-rejected-artifact.json', response.request().postData());
      await writeFile('/tmp/ced-host-rejection.json', JSON.stringify(body, null, 2));
    }
    assert.equal(response.status(), 201, JSON.stringify(body).slice(0, 1200));
    const id = body['@id'];
    await page.waitForURL(workspaceBase + '/dashboard');
    await open(`/${route}/edit/${enc(id)}?${params}`);
    assert.equal(await nameInput().inputValue(), name);
    await descriptionInput().fill('Updated through CED');
    const updatedResponse = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().includes(`/${collection}/`));
    await save();
    const update = await updatedResponse;
    assert.equal(update.status(), 200, JSON.stringify(responseBodies.get('PUT ' + update.url())).slice(0, 1200));
    assert.ok(update.request().headers()['if-match']);
    await page.waitForURL(workspaceBase + '/dashboard');
    const stored = await call(user1.auth, 'GET', `/${collection}/${enc(id)}`);
    assert.equal(stored.body['schema:description'], 'Updated through CED');
    console.log(`PASS: ${kind} create, reopen, conditional update, Workspace return`);
    // Concurrent backend edit must prevent the stale host from writing over it.
    await open(`/${route}/edit/${enc(id)}?${params}`);
    const external = { ...stored.body, 'schema:description': 'Concurrent editor' };
    const changed = await mutate(user1.auth, 'PUT', `/${collection}/${enc(id)}`, external);
    assert.equal(changed.status, 200, changed.text);
    await descriptionInput().fill('My unsaved change');
    await save();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('changed since'));
    assert.equal(await descriptionInput().inputValue(), 'My unsaved change');
    console.log(`PASS: ${kind} stale save blocked and edits retained`);
    if (kind === 'template') {
      const instance = artifactBody('instance', name + ' metadata', { 'schema:isBasedOn': id });
      for (const [key, value] of Object.entries(stored.body.properties['@context'].properties)) {
        if (value.enum) instance['@context'][key] = value.enum[0];
      }
      for (const key of stored.body._ui.order) instance[key] = { '@value': null };
      const seeded = await call(user1.auth, 'POST', `/template-instances?folder_id=${enc(user1.profile.homeFolderId)}`, instance);
      assert.equal(seeded.status, 201, seeded.text.slice(0, 1200));
      created.push({ collection: 'template-instances', id: seeded.body['@id'] });
      await open(`/${route}/edit/${enc(id)}?${params}`);
      await page.getByPlaceholder('Template name', { exact: true }).fill(name + ' revised');
      await page.getByRole('button', { name: /^Add field$/ }).click();
      await page.locator('app-field-type-picker').getByRole('button', { name: 'Text', exact: true }).click();
      await page.getByRole('textbox', { name: 'Field name', exact: true }).fill('Added after metadata');
      await save();
      await page.locator('#version-dialog').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByPlaceholder('Template name', { exact: true }).inputValue(), name + ' revised');
      await save();
      await page.locator('#version-dialog').waitFor({ state: 'visible' });
      const latest = await call(user1.auth, 'GET', `/${collection}/${enc(id)}`);
      const concurrent = await mutate(user1.auth, 'PUT', `/${collection}/${enc(id)}`,
        { ...latest.body, 'schema:description': 'Changed while version confirmation was open' });
      assert.equal(concurrent.status, 200, concurrent.text);
      const rejectedResponse = page.waitForResponse(res => res.request().method() === 'POST' && res.url().includes('/command/publish-create-draft-template/'));
      await page.getByRole('button', { name: 'Create new draft', exact: true }).click();
      assert.equal((await rejectedResponse).status(), 412);
      await page.waitForFunction(() => document.getElementById('message').textContent.includes('changed since'));
      const unchanged = await call(user1.auth, 'GET', `/${collection}/${enc(id)}`);
      assert.equal(unchanged.body['bibo:status'], 'bibo:draft');
      assert.equal(unchanged.body['schema:description'], 'Changed while version confirmation was open');
      assert.equal(await page.getByRole('textbox', { name: 'Field name', exact: true }).inputValue(), 'Added after metadata');
      console.log('PASS: stale version confirmation rejected without publishing, edits retained');
      await open(`/${route}/edit/${enc(id)}?${params}`);
      await page.getByPlaceholder('Template name', { exact: true }).fill(name + ' revised');
      await page.getByRole('button', { name: /^Add field$/ }).click();
      await page.locator('app-field-type-picker').getByRole('button', { name: 'Text', exact: true }).click();
      await page.getByRole('textbox', { name: 'Field name', exact: true }).fill('Added after metadata');
      await save();
      await page.locator('#version-dialog').waitFor({ state: 'visible' });
      const versionResponse = page.waitForResponse(res => res.request().method() === 'POST' && res.url().includes('/command/publish-create-draft-template/'));
      await page.getByRole('button', { name: 'Create new draft', exact: true }).click();
      const version = await versionResponse;
      const versionBody = responseBodies.get('POST ' + version.url());
      assert.ok(version.ok(), JSON.stringify(versionBody).slice(0, 1200));
      assert.ok(versionBody['@id'], 'Versioning returns the new draft');
      await page.waitForURL(workspaceBase + '/dashboard');
      const oldTemplate = await call(user1.auth, 'GET', `/${collection}/${enc(id)}`);
      assert.equal(oldTemplate.body['bibo:status'], 'bibo:published');
      const metadata = await call(user1.auth, 'GET', `/template-instances/${enc(seeded.body['@id'])}`);
      assert.equal(metadata.body['schema:isBasedOn'], id);
      console.log('PASS: template with metadata confirms versioning, preserves cancellation, leaves instances on original');
    }

  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Host message:', (await page.locator('#message').textContent({ timeout: 1000 }).catch(() => 'unavailable')).slice(0, 1200));
  console.error('Page errors:', errors);
  await page.screenshot({ path: '/tmp/ced-host-smoke-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  for (const item of created.reverse()) {
    const result = await mutate(user1.auth, 'DELETE', `/${item.collection}/${enc(item.id)}`);
    assert.ok([200, 204].includes(result.status), `Cleanup failed: ${result.text}`);
  }
}
