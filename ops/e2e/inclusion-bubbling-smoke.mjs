// Update Bubbling offers no tick for a published artifact.
//
// Propagation writes the stored content of every target it is given. Publication fixes that content,
// so the resource server refuses a published target outright: the whole request fails with 400 and
// errorKey publishedArtifactCanNotBeChanged, and nothing is written. Before the window read
// `bibo:status` it offered the tick anyway, and the only way to learn any of this was to choose one
// and meet the refusal after the fact.
//
// The fixtures are one element reused by two templates — one published, one still a draft — which
// separates "publication forbids this" from "this is simply not selected". Both belong to the same
// user, so nothing here turns on permissions; InclusionSubgraphAuthorizationTest covers those.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { actors, call, mutate, artifactBody, enc, RUN } from './rest/lib.mjs';
import * as S from './selectors.mjs';

const BASE = process.env.CEDAR_BASE ?? `https://cedar.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`;
const USER = process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com';
const PASSWORD = process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1';
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A template that embeds the given element under one property, which is what records the arc. */
function templateEmbedding(elementObject, name) {
  const tmpl = JSON.parse(readFileSync(resolve(FIXTURES, 'minimal-template.json'), 'utf8'));
  tmpl['@id'] = null;
  tmpl['schema:name'] = name;
  const field = 'embeddedElement';
  tmpl.properties[field] = elementObject;
  tmpl.required = Array.isArray(tmpl.required) ? [...tmpl.required, field] : [field];
  tmpl._ui = tmpl._ui || {};
  tmpl._ui.order = [...(tmpl._ui.order || []), field];
  tmpl._ui.propertyLabels = { ...(tmpl._ui.propertyLabels || {}), [field]: 'Embedded Element' };
  tmpl._ui.propertyDescriptions = { ...(tmpl._ui.propertyDescriptions || {}), [field]: 'embedded by the bubbling smoke' };
  if (tmpl.properties['@context']?.properties) {
    tmpl.properties['@context'].properties[field] = { enum: ['https://schema.metadatacenter.org/properties/' + field] };
    if (Array.isArray(tmpl.properties['@context'].required)) tmpl.properties['@context'].required.push(field);
  }
  return tmpl;
}

const { user1 } = await actors();
const auth = user1.auth;
const folderId = user1.profile.homeFolderId;
const created = [];

const element = await call(auth, 'POST', `/template-elements?folder_id=${enc(folderId)}`,
    artifactBody('element', `Bubbling Element ${RUN}`));
assert.equal(element.status, 201, `element: ${element.text?.slice(0, 300)}`);
const elementId = element.body['@id'];
created.push({ collection: 'template-elements', id: elementId });
const elementObject = (await call(auth, 'GET', `/template-elements/${enc(elementId)}`)).body;

const publishedName = `Bubbling PUBLISHED ${RUN}`;
const published = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
    templateEmbedding(elementObject, publishedName));
assert.equal(published.status, 201, `published template: ${published.text?.slice(0, 300)}`);
const publishedId = published.body['@id'];
created.push({ collection: 'templates', id: publishedId });
const release = await call(auth, 'POST', '/command/publish-artifact', { '@id': publishedId, newVersion: '1.0.0' });
assert.equal(release.status, 200, `publish: ${release.text?.slice(0, 300)}`);

const draftName = `Bubbling DRAFT ${RUN}`;
const draft = await call(auth, 'POST', `/templates?folder_id=${enc(folderId)}`,
    templateEmbedding(elementObject, draftName));
assert.equal(draft.status, 201, `draft template: ${draft.text?.slice(0, 300)}`);
const draftId = draft.body['@id'];
created.push({ collection: 'templates', id: draftId });

const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } });
// The livereload socket is not served here and its retries only add noise.
await context.route('**://*:35729/**', route => route.abort());
const page = await context.newPage();

try {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  const loginForm = page.locator(S.KC_USERNAME).first();
  const newButton = page.getByRole('button', { name: 'New' });
  const seen = await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'login').catch(() => null),
    newButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'reused').catch(() => null),
  ]);
  if (seen === 'login') {
    await loginForm.fill(USER);
    await page.locator(S.KC_PASSWORD).first().fill(PASSWORD);
    await page.locator(S.KC_SUBMIT).first().click();
    await newButton.waitFor({ timeout: 60_000 });
  }
  assert.ok(seen, 'neither the Keycloak form nor the dashboard appeared');

  // Editing the shared element and saving it is what opens Update Bubbling. The editor route
  // carries the artifact IRI unencoded; encoding it lands on the error page.
  await page.goto(`${BASE}/elements/edit/${elementId}?folderId=${enc(folderId)}`);
  await page.locator('a:has(i.fa-font)').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.locator('a:has(i.fa-font)').first().click();
  await page.waitForTimeout(1000);
  // Field inputs bind ng-model-options="{ debounce: 1000 }", so the name commits about a second
  // after the input event and nothing flushes it early. Saving sooner stores "Untitled".
  const nameBox = page.getByRole('textbox', { name: 'Enter Field Name' }).last();
  await nameBox.click();
  await nameBox.fill(`Bubbling Probe ${RUN}`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Save Element' }).click();

  const selector = page.locator('cedar-artifact-selector');
  await selector.getByText(publishedName, { exact: false }).first().waitFor({ timeout: 30_000 });
  await selector.getByText(draftName, { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);

  const rows = await page.evaluate(({ publishedName, draftName }) => {
    const read = name => {
      const node = [...document.querySelectorAll('cedar-artifact-selector .tree-artifact')]
          .find(n => n.textContent.includes(name));
      if (!node) return null;
      const input = node.querySelector('input[type="checkbox"]');
      return {
        hasCheckbox: !!input,
        disabled: input ? input.disabled : null,
        checked: input ? input.checked : null,
        // The application colours every checkbox in the page, so what a reader actually sees
        // that distinguishes a disabled one is its computed opacity.
        opacity: input ? Number(getComputedStyle(input).opacity) : null,
        text: node.textContent.replace(/\s+/g, ' ').trim(),
      };
    };
    return { published: read(publishedName), draft: read(draftName) };
  }, { publishedName, draftName });

  assert.ok(rows.published?.hasCheckbox, 'the published template should still render a checkbox');
  assert.equal(rows.published.disabled, true,
      'a published artifact must not be tickable: the update refuses it and fails the whole request');
  assert.ok(rows.published.opacity < 0.75,
      `the disabled tick must read as unavailable, not merely unresponsive (opacity ${rows.published.opacity})`);
  assert.match(rows.published.text, /published/i, 'the row should say why it cannot be ticked');
  assert.equal(rows.draft.disabled, false, 'a draft must stay selectable');
  assert.ok(rows.draft.opacity > 0.9, `a draft's tick must not be greyed (opacity ${rows.draft.opacity})`);
  assert.doesNotMatch(rows.draft.text, /published/i, 'a draft must not be marked published');

  // The whole tree is posted back as the update request, so a click on the disabled tick must not
  // reach the payload — not merely fail to render.
  const treeNow = () => page.evaluate(() => JSON.stringify(
      window.angular.element(document.querySelector('cedar-inclusion-modal')).scope().inclusion.tree));
  const before = await treeNow();
  await page.evaluate(({ publishedName }) => {
    [...document.querySelectorAll('cedar-artifact-selector .tree-artifact')]
        .find(n => n.textContent.includes(publishedName))
        ?.querySelector('input[type="checkbox"]')?.click();
  }, { publishedName });
  await page.waitForTimeout(600);
  const after = await treeNow();
  assert.equal(after, before, 'clicking the disabled tick changed the tree that gets posted');
  assert.notEqual(JSON.parse(after).templates?.[publishedId]?.operation, 'update',
      'the published target was marked for update');

  // The rest of the window must still work: tick the draft and apply.
  await selector.locator('.tree-artifact').filter({ hasText: draftName })
      .locator('input[type="checkbox"]').first().click({ force: true });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText(/updates successfully/i).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(3000);

  // And it propagated to exactly one of them.
  const childrenOf = body => Object.keys(body?.properties?.embeddedElement?.properties ?? {})
      .filter(key => !key.startsWith('@') && !key.includes(':'));
  const storedPublished = await call(auth, 'GET', `/templates/${enc(publishedId)}`);
  const storedDraft = await call(auth, 'GET', `/templates/${enc(draftId)}`);
  assert.deepEqual(childrenOf(storedPublished.body), [],
      'the published template took the change despite offering no tick');
  assert.equal(storedPublished.body['pav:version'], '1.0.0');
  assert.equal(storedPublished.body['bibo:status'], 'bibo:published');
  assert.ok(childrenOf(storedDraft.body).length === 1,
      `the draft should carry the new field, but holds ${JSON.stringify(childrenOf(storedDraft.body))}`);

  console.log('PASS: Update Bubbling greys out a published target, keeps it out of the posted tree, '
      + 'and still propagates into the draft beside it');
} catch (error) {
  await page.screenshot({ path: '/tmp/inclusion-bubbling-smoke-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  for (const item of created.reverse()) {
    const result = await mutate(auth, 'DELETE', `/${item.collection}/${enc(item.id)}`);
    assert.ok([200, 204].includes(result.status), `Cleanup failed: ${result.text}`);
  }
}
