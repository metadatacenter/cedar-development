import {pointer, setChecked, keyboard, textSizeStates} from './interactions.mjs';
import {DESIGNER_TYPES, PREVIEWLESS_TYPES, TERM_PICKER_WIDTHS} from './catalog.mjs';

export async function collectDesigner(session, record) {
  const {page, action, capture} = session;
  const card = () => page.locator('app-field-card').first();
  let savedUrl;
  const click = locator => pointer(session, locator);
  const toggle = name => click(page.locator(`.${name}-toggle`));
  const settings = async tab => {
    const expand = card().getByRole('button', {name: 'Expand field settings', exact: true});
    if (await expand.isVisible()) await click(expand);
    await click(card().getByRole('tab', {name: tab, exact: true}));
  };
    await session.openNew();
    await record('empty');
    await record('empty-panel-a', () => toggle('overview'));
    await record('empty-panel-b', () => toggle('overview'));
    await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now());
    await session.addField('Text', 'Sample');
    await record('single');
    await record('single-panel-a', () => toggle('overview'));
    await record('single-panel-b', () => toggle('overview'));
    const preview = () => click(page.locator('cedar-embeddable-designer .app-header__actions > .panel-toggle'));
    const waitForPreview = () => page.locator('.preview-panel').getByRole('heading', {level: 1}).first().waitFor({state: 'visible'});
    const phone = () => page.locator('cedar-embeddable-designer').evaluate(host => host.getBoundingClientRect().width < 600);
    const setPreview = async shown => {
      const button = page.locator('cedar-embeddable-designer .app-header__actions > .panel-toggle');
      if ((await button.getAttribute('aria-expanded')) !== String(shown))
        await action(shown ? 'Open Preview' : 'Close Preview to return to editing', preview);
      if (shown) await waitForPreview();
      await page.locator('.designer-scroll').waitFor({state: shown && await phone() ? 'hidden' : 'visible'});
    };
    const showEditor = async () => {if (await phone()) await setPreview(false);};
    await record('single-preview-a', async () => {await preview(); await waitForPreview();});
    await record('single-preview-b', preview);
    for (const tab of ['Configuration', 'Presentation', 'Constraints', 'Annotations', 'Metadata', 'Version'])
      await record(tab.toLowerCase(), () => settings(tab));
    await settings('Configuration');
    const multiple = on => setChecked(session, card().getByLabel('Allow multiple', {exact: true}), on);
    await record('collapsed', () => click(card().getByRole('button', {name: 'Collapse field settings', exact: true})));
    await record('expanded', () => click(card().getByRole('button', {name: 'Expand field settings', exact: true})));
    await record('multiple', () => multiple(true));
    await record('long-name', () => card().getByRole('textbox', {name: 'Enter field name', exact: true})
      .fill('Participant preferred contact information and follow-up availability'));
    for (const width of [1440, 1100, 900, 768, 375])
      await record(`width-${width}`, () => page.setViewportSize({width, height: 1000}));
    await action('Prepare short-name layout with both panels', async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Sample');
      await multiple(false);
      await preview(); await waitForPreview();
    });
    for (const width of [1440, 1100, 1024, 900, 768, 375]) {
      await record(width === 375 ? 'phone-preview-375' : `both-panels-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await setPreview(true);
      });
      if (width === 375) {
        await record('phone-editor-375', () => setPreview(false));
        await record('phone-preview-short', async () => {
          await page.setViewportSize({width, height: 667});
          await setPreview(true);
        });
        await record('phone-editor-short', () => setPreview(false));
      }
    }
    for (const width of [768, 375])
      await record(`configuration-end-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await setPreview(width >= 600);
        await card().locator('app-property-picker').scrollIntoViewIfNeeded();
      }, 'Explicitly scrolled to inspect the end of Configuration.');
    await action('Enable multiple values', () => multiple(true));
    for (const width of [1100, 768, 375]) {
      await record(width === 375 ? 'phone-preview-multiple-375' : `both-panels-multiple-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await showEditor();
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
        await setPreview(true);
      });
      if (width === 375) await record('phone-editor-multiple-375', () => setPreview(false));
    }
    await action('Prepare a required repeating field', async () => {
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Participant identifier');
      await card().getByLabel('Requirement', {exact: true}).selectOption('required');
      await card().getByLabel('Minimum', {exact: true}).fill('1');
      await card().getByLabel('Maximum', {exact: true}).fill('3');
    });
    for (const width of [1100, 768, 375]) {
      await record(`required-preview-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await showEditor();
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
        await setPreview(true);
      });
      await record(`required-configuration-${width}`, async () => {
        await showEditor();
        await card().locator('app-property-picker').scrollIntoViewIfNeeded();
      });
    }
    await action('Inspect a shorter required name', () => card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Participant code'));
    for (const width of [1440, 768]) await record(`required-overview-${width}`, async () => {
      await page.setViewportSize({width, height: 1000});
      await setPreview(true);
      await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
    });
    await action('Return to desktop editing before save', async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      await multiple(false);
      await setPreview(false);
    });
    await record('saved', async () => {
      await click(page.locator('#save'));
      await page.waitForFunction(() => document.getElementById('state')?.textContent === 'Saved');
      // Under WebKit, Playwright reported Saved before it reported the saved template's address, and a
      // reload in that moment reopened the create page. Reopening needs the saved address.
      await page.waitForURL(/\/templates\/edit\//);
      savedUrl = page.url();
    });
    await record('reopened', async () => {await page.reload(); await session.ready();});
    const interruptWrite = route => route.request().method() === 'PUT' ? route.abort('failed') : route.fallback();
    await record('save-unconfirmed', async () => {
      await action('Deliberately interrupt the next temporary-template save', async () => {
        session.expectedNetworkFailures.add('Deliberately interrupted temporary-template save');
        await page.route('**/templates/**', interruptWrite);
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).fill('Sample revised');
        await click(page.locator('#save'));
        await page.locator('#check-save').waitFor({state: 'visible'});
      });
    }, 'The harness aborted this save request to exercise uncertain-save recovery; this is not a spontaneous transport failure.');
    await record('save-status-checked', async () => {
      await page.unroute('**/templates/**', interruptWrite);
      session.expectedNetworkFailures.clear();
      await click(page.locator('#check-save'));
      await page.waitForFunction(() => document.getElementById('state')?.textContent === 'Modified');
    });
    await record('last-field-removed', () => click(card().getByTitle('Delete field', {exact: true})));
    await record('removed-panel-a', () => toggle('overview'));
    await record('removed-panel-b', () => toggle('overview'));
    await session.addField('Text', 'Participant');
    await session.addField('Number', 'Age');
    await record('nested', async () => {
      const insert = page.getByRole('button', {name: 'Add element here', exact: true}).last();
      await insert.scrollIntoViewIfNeeded();
      // A touch device cannot hover. There the actions show above the selected card, so a phone user
      // taps the card below the gap.
      if (session.touch) await action('Reveal insertion actions by selecting the card below them',
        () => page.getByRole('group', {name: 'Age', exact: true}).tap({position: {x: 4, y: 4}}));
      else await action('Reveal insertion actions by hovering their gap', () => insert.locator('..').locator('..').hover());
      try {await action('Insert element using pointer', () => pointer(session, insert, {scroll: false}));}
      catch {
        await capture('nested-pointer-attempt', 'Pointer activation did not complete; keyboard activation follows.');
        await action('Insert element using keyboard', async () => {await insert.focus(); await insert.press('Enter');});
      }
      await page.getByPlaceholder('Enter element name', {exact: true}).last().fill('Visit');
      const container = page.locator('app-container-editor').last();
      await click(container.getByRole('button', {name: /^Add field$/}).last());
      await click(page.locator('app-field-type-picker').getByRole('button', {name: 'Text', exact: true}));
      await page.locator('input[aria-label="Enter field name"]:focus').fill('Visit notes');
    });
    await record('keyboard', () => keyboard(session, page.locator('.overview-toggle'), {stops: 14}));
    // A fresh template holding one field of every type the picker offers: each card with its settings
    // open, then each field in Preview.
    await session.openNew();
    await page.setViewportSize({width: 1440, height: 1000});
    await setPreview(false);
    await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now() + ' field types');
    for (const [, label] of DESIGNER_TYPES) await session.addField(label, label + ' sample');
    for (const [index, [slug]] of DESIGNER_TYPES.entries()) {
      const typed = page.locator('app-field-card').nth(index);
      await record('type-' + slug, async () => {
        const expand = typed.getByRole('button', {name: 'Expand field settings', exact: true});
        if (await expand.isVisible()) await click(expand);
        await typed.getByRole('button', {name: 'Collapse field settings', exact: true}).waitFor();
      });
      await click(typed.getByRole('button', {name: 'Collapse field settings', exact: true}));
    }
    // The controlled-term picker, from the controlled-terms card's constraints, at desktop and phone width.
    const terms = page.locator('app-field-card').nth(DESIGNER_TYPES.findIndex(([slug]) => slug === 'controlled-terms'));
    const picker = page.getByRole('dialog', {name: 'Controlled-term constraints', exact: true});
    const firstTerm = picker.getByRole('button', {name: /^melanoma in \d+ ontolog/});
    for (const width of TERM_PICKER_WIDTHS) {
      await page.setViewportSize({width, height: width === 1440 ? 1000 : 667});
      await record(`term-picker-open-${width}`, async () => {
        const expand = terms.getByRole('button', {name: 'Expand field settings', exact: true});
        if (await expand.isVisible()) await click(expand);
        await click(terms.getByRole('tab', {name: 'Constraints', exact: true}));
        await click(terms.getByRole('button', {name: 'Edit controlled-term constraints', exact: true}));
        await picker.getByRole('searchbox', {name: 'Find terms', exact: true}).waitFor();
      });
      await record(`term-picker-results-${width}`, async () => {
        await picker.getByRole('searchbox', {name: 'Find terms', exact: true}).fill('melanoma');
        await firstTerm.waitFor();
      }, 'Searching the local terminology store for melanoma.');
      await record(`term-picker-term-${width}`, async () => {
        await click(firstTerm);
        await picker.getByRole('heading', {name: 'Selected term', exact: true}).waitFor();
      });
      await record(`term-picker-branches-${width}`, async () => {
        await click(picker.getByRole('tab', {name: /^Branches/}));
        await picker.getByRole('tabpanel', {name: /^Branches/}).waitFor();
      });
      await record(`term-picker-ontologies-${width}`, async () => {
        await click(picker.getByRole('tab', {name: /^Ontologies/}));
        await picker.getByRole('tabpanel', {name: /^Ontologies/}).waitFor();
      });
      await record(`term-picker-done-${width}`, async () => {
        await click(picker.getByRole('button', {name: 'Done', exact: true}));
        await picker.waitFor({state: 'hidden'});
      });
      await click(terms.getByRole('button', {name: 'Collapse field settings', exact: true}));
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await setPreview(true);
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // An empty image or video field shows a notice in place of its content; a section break shows its title.
    const previewOf = (slug, label) => {
      const pane = page.locator('.preview-panel');
      if (slug === 'image') return pane.getByText('This image field has no URL.', {exact: true});
      if (slug === 'youtube') return pane.getByText('This video field has no YouTube link.', {exact: true});
      if (slug === 'section-break') return pane.getByRole('heading', {name: label + ' sample', exact: true});
      return pane.getByText(new RegExp('^' + escape(label) + ' sample'));
    };
    for (const [slug, label] of DESIGNER_TYPES.filter(([slug]) => !PREVIEWLESS_TYPES.includes(slug)))
      await record('type-' + slug + '-preview', () => previewOf(slug, label).first().evaluate(element => element.scrollIntoView({block: 'center'})));

    // The saved template, shown with the browser's default text size doubled.
    await textSizeStates(session, record, async () => {await page.goto(savedUrl); await session.ready();});
}
