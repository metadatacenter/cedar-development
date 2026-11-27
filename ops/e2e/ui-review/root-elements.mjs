import assert from 'node:assert/strict';
import {captureJourney} from './journeys.mjs';
import {PAIRED_WIDTHS} from './catalog.mjs';
import {pointer, waitForPage} from './interactions.mjs';

// Root elements use the real host's /elements route, not a nested element inside a template.
export async function collectRootElements(session, record) {
  const {page} = session;
  const root = page.locator('cedar-embeddable-designer');
  const name = root.getByRole('textbox', {name: 'Element name', exact: true});
  const settings = root.locator('app-container-settings').first();
  const click = target => pointer(session, target);
  for (const width of PAIRED_WIDTHS) await captureJourney(session, record, `root-element-${width}`, async () => {
    const r = (state, operation, note) => record(`root-element-${state}-${width}`, operation, note);
    const title = `UI review pilot Collection site ${width}`;
    await page.setViewportSize({width, height: width === 1440 ? 1000 : 667});
    await r('empty', async () => {
      await session.openNew('element');
      if (await page.locator('#discard-draft').isVisible()) await click(page.locator('#discard-draft'));
      await name.waitFor(); assert.equal(await name.inputValue(), '');
    }, 'The real standalone element create route, before naming it or adding children.');
    await r('populated', async () => {
      await name.fill(title); await name.press('Tab');
      await session.addField('Text', 'Site name');
      await name.scrollIntoViewIfNeeded();
    });
    await click(settings.getByRole('button', {name: 'Expand element settings', exact: true}));
    for (const label of ['Presentation', 'Annotations', 'Metadata', 'Version']) await r(label.toLowerCase(), async () => {
      const tab = settings.getByRole('tab', {name: label, exact: true});
      await click(tab);
      await waitForPage(page, element => element.getAttribute('aria-selected') === 'true', await tab.elementHandle());
      await settings.getByRole('tabpanel', {name: label, exact: true}).waitFor();
      await tab.scrollIntoViewIfNeeded();
    }, 'The standalone root element’s own settings, with no parent placement configuration.');
    await click(settings.getByRole('button', {name: 'Collapse element settings', exact: true}));
    let url;
    await r('saved', async () => {
      await click(page.locator('#save'));
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Saved');
      await page.waitForURL(/\/elements\/edit\//); url = page.url();
      const id = await root.evaluate(node => node.currentArtifact['@id']);
      const stored = await session.request('GET', '/template-elements/' + encodeURIComponent(id));
      assert.equal(stored.status, 200); assert.equal(stored.body['schema:name'], title);
      assert.ok(stored.body.properties['Site name']);
      await name.scrollIntoViewIfNeeded();
    }, 'Saved through the host; backend readback verifies the element and its child field.');
    await r('reopened', async () => {
      await page.goto(url); await session.ready();
      assert.equal(await name.inputValue(), title);
      await root.getByRole('textbox', {name: 'Enter field name', exact: true}).waitFor();
      await name.scrollIntoViewIfNeeded();
    });
  });
}
