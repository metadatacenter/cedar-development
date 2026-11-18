import {openBrowserSession} from './browser-session.mjs';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {withBrowserAuthentication} from '../auth-activity.mjs';
import {hash} from './contract.mjs';
import {pointer} from './interactions.mjs';

const base = process.env.CEDAR_DESIGNER_BASE || 'https://designer.metadatacenter.orgx';
// Review fixtures may only be created on the local development deployment.
if (!['designer.metadatacenter.orgx', 'localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('The Designer pilot requires the local development host');

export async function openSession(directory, options = {}) {
  await mkdir(directory, {recursive: true});
  const shared = await openBrowserSession(directory, 'designer', options);
  const {page,context,browser,user:user1,action,capture,close} = shared;
  page.on('dialog', dialog => void dialog.accept());
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
  async function addField(type, name) {
    await action(`Add ${type} field`, async () => {
      const add = page.getByRole('button', {name: /^Add field$/}).last();
      await pointer(shared, add);
      await pointer(shared, page.locator('app-field-type-picker').getByRole('button', {name: type, exact: true}));
      const input = page.locator('input[aria-label="Enter field name"]:focus');
      await input.fill(name); await input.press('Tab');
    });
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
  return {...shared, openNew, ready, addField, servedEvidence};
}
