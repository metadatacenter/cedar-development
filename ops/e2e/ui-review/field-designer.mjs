import assert from 'node:assert/strict';
import {DESIGNER_TYPES, PAIRED_WIDTHS} from './catalog.mjs';
import {captureJourney} from './journeys.mjs';
import {pointer, textSizeStates, waitForPage} from './interactions.mjs';

// Capture the real authenticated /fields host, including its repository save and draft policy.
// The component API is read for assertions only; ordinary controls perform every edit.
export async function collectFieldDesigner(session, record) {
  const {page} = session;
  const root = page.locator('cedar-embeddable-field-designer');
  const name = () => root.getByRole('textbox', {name: 'Enter field name', exact: true});
  const chooser = () => root.getByRole('dialog', {name: 'Choose field type', exact: true});
  const click = locator => pointer(session, locator);
  const show = async target => {
    await target.waitFor({state: 'visible'});
    await target.scrollIntoViewIfNeeded();
    assert(await target.evaluate(node => {
      const b = node.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
    }), 'The named Field Designer target is outside the captured viewport');
  };
  const fresh = async () => {
    await session.openNew();
    // Previous unsaved fixture work may be offered on this same create route. Use the host's
    // ordinary discard control; never clear storage or silently replace its document.
    if (await page.locator('#discard-draft').isVisible()) await click(page.locator('#discard-draft'));
    await chooser().waitFor({state: 'visible'});
  };
  const choose = async label => {
    await click(chooser().getByRole('button', {name: label, exact: true}));
    await chooser().waitFor({state: 'hidden'});
    await show(name());
  };
  const tab = async label => {
    const target = root.getByRole('tab', {name: label, exact: true});
    await click(target);
    await waitForPage(page, node => node.getAttribute('aria-selected') === 'true', await target.elementHandle());
    await show(target);
  };
  let savedUrl;
  for (const width of PAIRED_WIDTHS) await captureJourney(session, record, `field-authoring-${width}`, async () => {
    const r = (id, operation, note) => record(`${id}-${width}`, operation, note);
    const fieldName = `UI review pilot Contact ${width}`;
    await page.setViewportSize({width, height: width === 1440 ? 1000 : 667});
    await fresh();
    await r('chooser-open', () => show(chooser().getByRole('button', {name: 'Text', exact: true})));
    await r('chooser-dismissed', async () => {
      await page.keyboard.press('Escape');
      await chooser().waitFor({state: 'hidden'});
      await show(root.getByRole('button', {name: 'Choose field type', exact: true}));
    });
    await session.action('Reopen the field type chooser', () => click(root.getByRole('button', {name: 'Choose field type', exact: true})));
    await r('name-empty', async () => {
      await choose('Text');
      assert.equal(await name().inputValue(), '');
      assert.equal(await page.locator('#save').isEnabled(), false);
    });
    await r('name-invalid', async () => {
      await name().press('Tab');
      await waitForPage(page, node => node.getAttribute('aria-invalid') === 'true', await name().elementHandle());
      await show(root.locator('.validation-summary'));
    });
    await r('validation-expanded', async () => {
      await click(root.locator('.validation-summary summary'));
      await show(root.locator('.validation-summary').getByRole('button', {name: /Field name is required/}));
    });
    await r('name-corrected', async () => {
      await name().fill(fieldName); await name().press('Tab');
      await root.locator('.validation-summary').waitFor({state: 'hidden'});
      await show(name());
    });
    await r('collapsed', async () => {
      await click(root.getByRole('button', {name: 'Collapse field settings', exact: true}));
      await root.getByRole('tab', {name: 'Presentation', exact: true}).waitFor({state: 'hidden'});
      await show(name());
    });
    await session.action('Expand the standalone field settings', () => click(root.getByRole('button', {name: 'Expand field settings', exact: true})));
    for (const label of ['Presentation', 'Constraints', 'Annotations', 'Metadata', 'Version'])
      await r(label.toLowerCase(), () => tab(label));
    await session.action('Return to the field presentation before saving', () => tab('Presentation'));
    await r('saved', async () => {
      await click(page.locator('#save'));
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Saved');
      await page.waitForURL(/\/fields\/edit\//); savedUrl = page.url();
      const id = await root.evaluate(node => node.currentArtifact['@id']);
      const stored = await session.request('GET', '/template-fields/' + encodeURIComponent(id));
      assert.equal(stored.status, 200); assert.equal(stored.body['schema:name'], fieldName);
      await show(name());
    }, 'Saved through the real host; backend readback confirms the standalone field name.');
    await r('reopened', async () => {
      await page.reload(); await session.ready();
      assert.equal(await name().inputValue(), fieldName); await show(name());
    });
    const interrupted = route => route.request().method() === 'PUT' ? route.abort('failed') : route.fallback();
    await r('save-unconfirmed', async () => {
      session.expectedNetworkFailures.add('Deliberately interrupted temporary-field save');
      await page.route('**/template-fields/**', interrupted);
      await name().fill(fieldName + ' revised'); await name().press('Tab');
      await click(page.locator('#save')); await show(page.locator('#check-save'));
    }, 'The harness deliberately aborts the field save to show the existing recovery interface.');
    await r('save-status-checked', async () => {
      await page.unroute('**/template-fields/**', interrupted); session.expectedNetworkFailures.clear();
      await click(page.locator('#check-save'));
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Modified');
      await show(name());
    });
    await r('draft-offered', async () => {
      await waitForPage(page, value => Object.values(sessionStorage).some(raw => raw.includes(value)), fieldName + ' revised');
      await page.reload(); await show(page.locator('#restore-draft'));
    });
    await r('draft-restored', async () => {
      await waitForPage(page, () => document.getElementById('restore-draft')?.disabled === false);
      await click(page.locator('#restore-draft'));
      await waitForPage(page, ({tag, value}) => document.querySelector(tag)?.currentArtifact?.['schema:name'] === value,
        {tag: 'cedar-embeddable-field-designer', value: fieldName + ' revised'});
      await show(name());
    });
    await r('long-name', async () => {
      await name().fill('UI review pilot Participant preferred contact information and follow-up availability');
      await name().press('Tab'); await show(name());
    });
  });
  for (const [slug, label] of DESIGNER_TYPES) await captureJourney(session, record, `standalone-type-${slug}`, async () => {
    await page.setViewportSize({width: 1440, height: 1000});
    await fresh();
    await record(`type-${slug}-1440`, async () => {
      await choose(label); await name().fill(`UI review pilot ${label}`); await name().press('Tab');
      await show(root.getByRole('tab', {name: 'Presentation', exact: true}));
      assert.equal(await root.getByRole('tab', {name: 'Configuration', exact: true}).count(), 0);
    }, `A standalone ${label} definition. It has no parent placement controls; empty required settings remain visible as validation feedback.`);
  });
  await captureJourney(session, record, 'field-text-size', () => textSizeStates(session, record, async () => {
    if (!savedUrl) throw new Error('No saved field is available for text-size inspection');
    await page.goto(savedUrl); await session.ready();
    if (await page.locator('#discard-draft').isVisible()) await click(page.locator('#discard-draft'));
    await show(name());
  }));
}
