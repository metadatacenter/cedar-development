import assert from 'node:assert/strict';
import {artifactBody, call, enc, mintId, RESOURCE} from './rest/lib.mjs';
import {journeyFolder, recordCreate} from './journey-fixtures.mjs';

const collection = kind => kind === 'template' ? 'templates' : `template-${kind}s`;
function insert(parent, key, child, repeated = false) {
  parent.properties[key] = repeated ? {type: 'array', minItems: 0, items: child} : child;
  parent.properties['@context'].properties[key] = {enum: [`https://example.org/pull/${key}`]};
  parent._ui.order.push(key); parent._ui.propertyLabels[key] = key;
  parent._ui.propertyDescriptions[key] = 'Placement help';
}
const childAt = (doc, nested, repeated) => {
  const parent = nested ? doc.properties.Group : doc;
  return repeated ? parent.properties.Reused.items : parent.properties.Reused;
};
async function setup(ctx, suffix) {
  const folderId = await journeyFolder(ctx, suffix);
  const request = async (method, path, body, options, status = 200) => {
    const reply = await call(ctx.user.auth, method, path, body, options);
    assert.equal(reply.status, status, `${method} ${path}: ${reply.text}`);
    return reply;
  };
  const read = async (kind, id) => (await request('GET', `/${collection(kind)}/${enc(id)}`)).body;
  const create = async (kind, body) => {
    const made = await request('POST', `/${collection(kind)}?folder_id=${enc(folderId)}`, body, undefined, 201);
    const id = made.body['@id']; ctx.created.push({collection: collection(kind), id});
    return read(kind, id);
  };
  return {folderId, request, read, create};
}
async function versionPanel(page, kind) {
  const cards = page.locator(kind === 'field' ? 'app-field-card' : 'app-element-card');
  await cards.first().waitFor();
  let card;
  for (const candidate of await cards.all()) {
    const input = candidate.locator(kind === 'field' ? 'input.field-name' : 'input[name="shownName"]').first();
    if (await input.inputValue() === 'Reused') { card = candidate; break; }
  }
  assert.ok(card, `The ${kind} placement named Reused is present`);
  const settings = kind === 'field' ? card.locator('app-field-settings') : card;
  const toggle = settings.locator('.settings-toggle').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await settings.getByRole('tab', {name: 'Version', exact: true}).first().click();
  return settings.getByRole('tabpanel', {name: 'Version', exact: true}).first();
}
async function open(ctx, template, folderId) {
  await ctx.page.goto(`${ctx.designer}/templates/edit/${enc(template['@id'])}?folderId=${enc(folderId)}`);
  await ctx.page.locator('#state').filter({hasText: /^Unmodified$/}).waitFor();
  assert.equal(await ctx.page.locator('#check-save').isVisible(), false);
  assert.equal(await ctx.page.locator('#draft-offer').isVisible(), false);
}

// Real history, real immutable releases, real conditional parent saves; no repository answers mocked.
export async function pullVersionJourney(ctx) {
  const {page, name, created, write, pass} = ctx;
  const {folderId, request, read, create} = await setup(ctx, 'pull versions');
  for (const kind of ['field', 'element']) {
    const source = artifactBody(kind, 'Reused');
    if (kind === 'element') insert(source, 'Value', artifactBody('field', 'Value'));
    const old = await create(kind, source);
    const publish = id => request('POST', '/command/publish-artifact', {'@id': id, newVersion: id === old['@id'] ? '1.0.0' : '2.0.0'});
    await publish(old['@id']);
    const original = await read(kind, old['@id']);
    const makeDraft = async (from, version) => {
      const made = await request('POST', '/command/create-draft-artifact', {'@id': from, folderId, newVersion: version, propagateSharing: false}, undefined, 201);
      const id = made.body['@id']; created.push({collection: collection(kind), id}); return read(kind, id);
    };
    const next = await makeDraft(old['@id'], '2.0.0'); await publish(next['@id']);
    const released = await read(kind, next['@id']);
    const unfinished = await makeDraft(next['@id'], '3.0.0');
    for (const relation of ['linked', 'copied']) for (const placement of ['single', 'repeated', 'nested']) {
      const nested = placement === 'nested', repeated = placement === 'repeated';
      const embedded = structuredClone(original);
      if (relation === 'copied') Object.assign(embedded, {'@id': mintId(collection(kind)), 'pav:derivedFrom': original['@id'], 'bibo:status': 'bibo:draft', 'pav:version': '0.0.1'});
      const body = artifactBody('template', `${name} ${kind} ${relation} ${placement}`);
      const parent = nested ? artifactBody('element', 'Group') : body;
      insert(parent, 'Reused', embedded, repeated);
      if (nested) insert(body, 'Group', parent);
      insert(body, 'Sibling', artifactBody('field', 'Sibling'));
      const template = await create('template', body);
      // Identical validation permits a release pull even when the template already has records.
      const record = artifactBody('instance', `${name} existing record`, {'schema:isBasedOn': template['@id']});
      for (const key of template._ui.order) record['@context'][key] = `https://example.org/pull/${key}`;
      await create('instance', record);
      await open(ctx, template, folderId);
      const ced = page.locator('cedar-embeddable-designer');
      const panel = await versionPanel(page, kind);
      const button = panel.getByRole('button', {name: relation === 'linked' ? /^Upgrade to v2\.0\.0/ : /^Replace with origin v2\.0\.0/});
      await button.waitFor();
      assert.equal(await panel.getByRole('button', {name: /v3\.0\.0/}).count(), 0);
      await button.click();
      if (relation === 'copied') await panel.getByRole('dialog').getByRole('button', {name: 'Replace', exact: true}).click();
      await page.locator('#state').filter({hasText: /^Modified$/}).waitFor();
      const proposed = await ced.evaluate(el => el.currentArtifact);
      assert.equal(childAt(proposed, nested, repeated)['@id'], released['@id']);
      await write(page, 'PUT', '/templates/', () => page.locator('#save').click(), 200, true);
      await page.locator('#state').filter({hasText: /^Saved$/}).waitFor();
      const saved = await read('template', template['@id']);
      assert.equal(childAt(saved, nested, repeated)['@id'], released['@id']);
      assert.equal(childAt(saved, nested, repeated)['bibo:status'], 'bibo:published');
      assert.deepEqual(saved._ui, template._ui); assert.deepEqual(saved.required, template.required);
      assert.deepEqual(saved.properties['@context'], template.properties['@context']);
      assert.deepEqual(saved.properties.Sibling, template.properties.Sibling);
      if (repeated) assert.equal(saved.properties.Reused.minItems, template.properties.Reused.minItems);
      await page.reload(); await page.locator('#state').filter({hasText: /^Unmodified$/}).waitFor();
      assert.equal(childAt(await ced.evaluate(el => el.currentArtifact), nested, repeated)['@id'], released['@id']);
      assert.deepEqual(await read(kind, unfinished['@id']), unfinished);
      pass(`${kind}-${relation}-${placement}`, `${kind} ${relation} ${placement}: pulls the published release, preserves placement and siblings, saves and reopens against real REST`);
    }
  }
}

export async function reusablePublicationJourney(ctx) {
  const {page, name, write, pass} = ctx;
  const {folderId, read, create} = await setup(ctx, 'reusable publication');
  for (const kind of ['field', 'element']) for (const publish of [false, true]) for (const fault of (publish ? ['normal', 'lost', 'lost-publication'] : ['normal', 'lost'])) {
    const body = artifactBody('template', `${name} ${kind} ${publish} ${fault}`);
    const local = artifactBody(kind, 'Reused');
    if (kind === 'element') insert(local, 'Value', artifactBody('field', 'Value'));
    insert(body, 'Reused', local);
    const template = await create('template', body);
    await open(ctx, template, folderId);
    const panel = await versionPanel(page, kind);
    let writes = 0, publications = 0;
    const target = url => url.origin === new URL(RESOURCE).origin && (url.pathname.startsWith(`/${collection(kind)}/`) || url.pathname === '/command/publish-artifact');
    const intercept = async route => {
      const publishing = route.request().method() === 'POST';
      if (!publishing && route.request().method() !== 'PUT') return route.fallback();
      if (publishing) publications++; else writes++;
      const response = await route.fetch(); assert.equal(response.status(), publishing ? 200 : 201, await response.text());
      recordCreate(ctx.created, route.request().method(), route.request().url(), response.status(), await response.json());
      if (fault === (publishing ? 'lost-publication' : 'lost')) await route.abort('failed'); else await route.fulfill({response});
    };
    await page.route(target, intercept);
    try {
      await panel.getByRole('button', {name: publish ? 'Publish as reusable' : 'Save as reusable draft', exact: true}).click();
      // Attachment changes the parent; readback settles a lost response under the same identity.
      await page.locator('#state').filter({hasText: /^Modified$/}).waitFor();
      const embedded = (await page.locator('cedar-embeddable-designer').evaluate(el => el.currentArtifact)).properties.Reused;
      const id = publish ? embedded['@id'] : embedded['pav:derivedFrom'];
      assert.ok(id); const reusable = await read(kind, id);
      assert.equal(reusable['bibo:status'], publish ? 'bibo:published' : 'bibo:draft');
      assert.equal(writes, 1); assert.equal(publications, publish ? 1 : 0);
      if (!publish) assert.notEqual(embedded['@id'], id, 'a reusable draft remains an editable copy, not a mutable link');
      await write(page, 'PUT', '/templates/', () => page.locator('#save').click(), 200, true);
      await page.locator('#state').filter({hasText: /^Saved$/}).waitFor();
      await page.reload(); await page.locator('#state').filter({hasText: /^Unmodified$/}).waitFor();
      const reopened = (await page.locator('cedar-embeddable-designer').evaluate(el => el.currentArtifact)).properties.Reused;
      assert.equal(publish ? reopened['@id'] : reopened['pav:derivedFrom'], id);
      pass(`${kind}-${publish ? 'published' : 'draft'}-${fault}`, `${kind} reusable ${publish ? 'publication' : 'draft'} ${fault} reply: one stored artifact survives parent save and reopen`);
    } finally { await page.unroute(target, intercept); }
  }
}
