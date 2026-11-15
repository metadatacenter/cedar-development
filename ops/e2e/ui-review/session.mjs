import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {actors, call, mutate, enc} from '../rest/lib.mjs';
import {fixtureAt} from '../journey-fixtures.mjs';
import {withBrowserAuthentication} from '../auth-activity.mjs';
import {hash} from './contract.mjs';

const base = process.env.CEDAR_DESIGNER_BASE || 'https://designer.metadatacenter.orgx';
// Review fixtures may only be created on the local development deployment.
if (!['designer.metadatacenter.orgx', 'localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('The Designer pilot requires the local development host');

export async function openSession(directory) {
  await mkdir(directory, {recursive: true});
  const {user1} = await actors();
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const actions = [], states = [], created = [], runtimeErrors = [], cleanupErrors = [];
  const flush = () => writeFile(join(directory, 'session.json'), JSON.stringify({actions, states, created, runtimeErrors, cleanupErrors}, null, 2));
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  // Write the identity before sending the create; a missing response must not orphan a fixture.
  await page.route('**/templates/**', async route => {
    const block = async reason => {
      actions.push({label: 'Template request blocked by review fixture guard', outcome: 'blocked', reason});
      await flush(); await route.abort();
    };
    if (route.request().method() === 'PUT') {
      const item = fixtureAt(route.request().url());
      if (!item) return block('Request does not identify a local template fixture');
      if (!created.some(x => x.id === item.id)) {
        const body = route.request().postDataJSON();
        if (route.request().headers()['if-match'] || !String(body?.['schema:name']).startsWith('UI review pilot '))
          return block('New template must have no If-Match header and its name must begin with UI review pilot ');
        const existing = await call(user1.auth, 'GET', `/${item.collection}/${enc(item.id)}`);
        if (existing.status !== 404) return block('Template identifier is not confirmed absent');
        created.push(item); await flush();
      }
    }
    await route.continue();
  });
  const params = new URLSearchParams({folderId: user1.profile.homeFolderId,
    returnTo: 'https://workspace.metadatacenter.orgx/dashboard'});

  async function ready() {
    await page.waitForFunction(() => document.querySelector('cedar-embeddable-designer')?.shadowRoot?.querySelector('input, button'));
    await page.waitForFunction(() => ['Unmodified', 'Modified', 'Saved'].includes(document.getElementById('state')?.textContent));
    await page.evaluate(() => document.fonts.ready);
  }
  async function openNew() {
    await withBrowserAuthentication('Designer UI review sign-in', async () => {
      await page.goto(`${base}/templates/create?${params}`);
      await page.locator('#username, cedar-embeddable-designer, #message[data-error=true]').first().waitFor({state: 'visible'});
      if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || 'test1@test.com');
        await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || 'test1');
        await page.locator('#kc-login').click();
      }
      await ready();
    });
  }
  async function action(label, perform) {
    const entry = {label, at: new Date().toISOString()};
    try {await perform(); entry.outcome = 'performed';}
    catch (error) {entry.outcome = 'failed'; entry.error = error.message; throw error;}
    finally {actions.push(entry); await flush();}
  }
  async function capture(id, note = '') {
    if (!/^[a-z0-9-]+$/.test(id) || states.some(s => s.id === id)) throw new Error('Invalid or duplicate state ID');
    // Preserve hover/focus: moving the pointer for a screenshot can hide the very action
    // under review and make a subsequent click appear broken.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = `${id}.png`, aria = `${id}.aria.yml`, metrics = `${id}.json`;
    await page.screenshot({path: join(directory, screenshot), fullPage: true});
    await writeFile(join(directory, aria), await page.locator('body').ariaSnapshot());
    const geometry = await page.evaluate(() => {
      const roots = [], walk = root => {roots.push(root); for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);};
      walk(document);
      const describe = el => {
        const box = el.getBoundingClientRect(), css = getComputedStyle(el);
        const text = 'value' in el ? String(el.value) : el.textContent?.trim() || '';
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.font = css.font;
        const intrinsicTextWidth = context.measureText(text).width +
          Math.max(0, text.length - 1) * (parseFloat(css.letterSpacing) || 0);
        return {tag: el.tagName.toLowerCase(), className: el.getAttribute('class'), role: el.getAttribute('role'), id: el.id,
          label: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 120),
          expanded: el.getAttribute('aria-expanded'), controls: el.getAttribute('aria-controls'),
          disabled: Boolean(el.disabled), value: 'value' in el ? el.value : undefined,
          visible: box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none',
          x: box.x, y: box.y, width: box.width, height: box.height,
          intrinsicTextWidth, paddingInline: [css.paddingLeft, css.paddingRight], gap: css.gap};
      };
      return {viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
        controls: roots.flatMap(root => [...root.querySelectorAll('button,input,textarea,select,[role="tab"],[role="separator"]')].map(describe)),
        regions: roots.flatMap(root => [...root.querySelectorAll('.overview-panel,.preview-panel,.field-header,.field-card-header,.field-heading,.field-header-details,.field-type-icon,.field-name-caption,.field-type-label,.occurrence-range,.required-mark,.field-actions,.container-type-label,.template-field-label,.version-group,app-field-card,app-field-summary')].map(describe))};
    });
    await writeFile(join(directory, metrics), JSON.stringify(geometry, null, 2));
    const crops = [];
    const scroll = await page.evaluate(() => ({x: scrollX, y: scrollY}));
    const cards = page.locator('app-field-card');
    for (let i = 0; i < Math.min(await cards.count(), 3); i++) {
      if (!await cards.nth(i).isVisible()) continue;
      // Locator screenshots scroll their target into view. Crop the current viewport instead:
      // evidence collection must not change scroll/hover preconditions for the next interaction.
      const box = await cards.nth(i).boundingBox(), viewport = page.viewportSize();
      if (!box || !viewport) continue;
      const x = Math.max(0, box.x), y = Math.max(0, box.y);
      const width = Math.min(viewport.width, box.x + box.width) - x;
      const height = Math.min(viewport.height, box.y + box.height) - y;
      if (width <= 0 || height <= 0) continue;
      const file = `${id}-card-${i + 1}.png`;
      await page.screenshot({path: join(directory, file), clip: {x: x + scroll.x, y: y + scroll.y, width, height}});
      crops.push(file);
    }
    states.push({id, note, screenshot, aria, metrics, crops, cropCoverage: 'Visible viewport only; scroll explicitly to inspect below-fold content.', viewport: page.viewportSize(), actionCount: actions.length});
    await flush();
  }
  async function addField(type, name) {
    await action(`Add ${type} field`, async () => {
      const add = page.getByRole('button', {name: /^Add field$/}).last();
      await add.scrollIntoViewIfNeeded(); await add.click();
      await page.locator('app-field-type-picker').getByRole('button', {name: type, exact: true}).click();
      const input = page.locator('input[aria-label="Enter field name"]:focus');
      await input.fill(name); await input.press('Tab');
    });
  }
  async function close() {
    try {await browser.close();}
    catch (error) {cleanupErrors.push(`Browser close: ${error.message}`);}
    for (const item of [...created].reverse()) {
      try {
        const path = `/${item.collection}/${enc(item.id)}`;
        const result = await mutate(user1.auth, 'DELETE', path);
        if (![204, 404].includes(result.status)) throw new Error(`cleanup returned ${result.status}`);
        if ((await call(user1.auth, 'GET', path)).status !== 404) throw new Error('fixture still readable after cleanup');
      } catch (error) {cleanupErrors.push(`${item.id}: ${error.message}`);}
    }
    await flush();
  }
  async function servedEvidence() {
    const components = await context.request.get(`${base}/components/manifest.json`);
    if (!components.ok()) throw new Error('Cannot read served component manifest');
    const manifest = await components.json();
    const verified = [];
    for (const entry of Object.values(manifest)) {
      const file = entry.delivery?.file || entry.bundle;
      const expected = entry.delivery?.sha256 || entry.sha256;
      if (!file || verified.some(v => v.file === file)) continue;
      const response = await context.request.get(`${base}/components/${file}`);
      const digest = hash(await response.body());
      if (!response.ok() || digest !== expected) throw new Error(`Served asset mismatch: ${file}`);
      verified.push({file, sha256: digest});
    }
    const local = JSON.parse(await readFile(join(process.env.CEDAR_HOME, 'cedar-template-designer/app/components/manifest.json'), 'utf8'));
    if (JSON.stringify(local) !== JSON.stringify(manifest)) throw new Error('Served and staged manifests differ');
    return {manifest, verified, browser: browser.version()};
  }
  return {page, context, actions, states, created, runtimeErrors, cleanupErrors, openNew, ready, action, capture, addField, close, servedEvidence};
}
