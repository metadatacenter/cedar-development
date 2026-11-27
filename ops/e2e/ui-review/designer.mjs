import {captureJourney} from './journeys.mjs';
import assert from 'node:assert/strict';
import {pointer, setChecked, keyboard, textSizeStates, holdSearchRequests, waitForPage, tabKey} from './interactions.mjs';
import {DESIGNER_TYPES, PREVIEWLESS_TYPES, TERM_PICKER_WIDTHS} from './catalog.mjs';

export async function collectDesigner(session, record) {
  const {page, action, capture} = session;
  const card = () => page.locator('app-field-card').first();
  let savedUrl;
  const click = locator => pointer(session, locator);
  const toggle = name => click(page.locator(`.${name}-toggle`));
  const reveal = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const element = await locator.elementHandle();
    await waitForPage(page, node => {
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
      for (let parent = node.parentElement || node.getRootNode().host; parent; parent = parent.parentElement || parent.getRootNode().host) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (r.top < box.top - 1 || r.bottom > box.bottom + 1)) return false;
      }
      let hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const seen = new Set();
      while (hit?.shadowRoot && !seen.has(hit)) {
        seen.add(hit);
        const next = hit.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!next || next === hit) break;
        hit = next;
      }
      for (let current = hit; current; current = current.parentElement || current.getRootNode().host) if (current === node) return true;
      return false;
    }, element);
    session.actions.push({label: 'Ordinary scroll fully reveals the existing control and its center hit target',
      target: await locator.evaluate(node => node.getAttribute('aria-label') || node.textContent?.trim() || node.value)});
    await session.flush();
  };
  const creationControls = async prefix => {
    // This is the template's trailing row, not the insertion gap or the nested element's row.
    const zone = page.locator('app-container-editor').first()
      .locator(':scope > .container-content > .add-field-section > .bottom-insert-zone');
    const add = zone.getByRole('button', {name: 'Add field', exact: true});
    const palette = page.locator('app-field-type-picker');
    await record(`${prefix}-creation-idle`, async () => {
      await zone.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.locator('app-field-card').last().getByRole('textbox', {name: 'Enter field name', exact: true}).focus();
    }, 'The trailing template creation row with neither pointer nor keyboard focus inside it.');
    await record(`${prefix}-creation-pointer`, async () => {
      if (!session.touch) await zone.hover();
    }, session.touch ? 'Touch has no hover; inspect the ordinary trailing controls before tapping.' : 'Pointer moved onto the trailing template creation row.');
    await record(`${prefix}-creation-pointer-open`, async () => {
      await click(add);
      await palette.getByRole('button', {name: 'Text', exact: true}).waitFor();
    }, 'Activated the trailing Add field at its displayed pointer position; no field is added.');
    await action('Close the creation picker without changing the template', () => click(palette.getByRole('button', {name: 'Close field picker', exact: true})));
    await record(`${prefix}-creation-keyboard`, async () => {
      await page.mouse.move(0, 0);
      await page.locator('app-field-card').last().getByTitle('Delete field', {exact: true}).focus();
      let reached = false;
      for (let stops = 1; stops <= 40; stops++) {
        await page.keyboard.press(tabKey(page));
        reached = await add.evaluate(button => button.getRootNode().activeElement === button);
        if (reached) {
          session.actions.push({label: 'Tab from final field Delete to trailing template Add field', stops, reached: true});
          await session.flush();
          break;
        }
      }
      if (!reached) throw new Error('Trailing template Add field was not reached within 40 Tab stops');
    }, 'Real Tab navigation from the final field Delete control reaches the trailing template Add field with the pointer elsewhere.');
    await record(`${prefix}-creation-keyboard-open`, async () => {
      await page.keyboard.press('Enter');
      await palette.getByRole('button', {name: 'Text', exact: true}).waitFor();
    }, 'Enter activates the keyboard-focused trailing Add field; no field is added.');
    if (prefix === 'multiple-1100') await record('multiple-1100-creation-page-break-reached',
      () => reveal(palette.getByRole('button', {name: 'Page Break', exact: true})),
      'Scrolled the already-open picker to Page Break and verified that its complete tile and pointer target are visible. No field is added.');
    await action('Close the keyboard-opened picker without changing the template', () => click(palette.getByRole('button', {name: 'Close field picker', exact: true})));
  };
  const settings = async tab => {
    const expand = card().getByRole('button', {name: 'Expand field settings', exact: true});
    if (await expand.isVisible()) await click(expand);
    await click(card().getByRole('tab', {name: tab, exact: true}));
  };
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
    await captureJourney(session, record, 'authoring-and-save', async () => {
    await session.openNew();
    await record('empty');
    await record('empty-panel-a', () => toggle('overview'));
    await record('empty-panel-b', () => toggle('overview'));
    await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now());
    await session.addField('Text', 'Sample');
    await record('single');
    await record('single-panel-a', () => toggle('overview'));
    await record('single-panel-b', () => toggle('overview'));
    await record('single-preview-a', async () => {await preview(); await waitForPreview();});
    await record('single-preview-b', preview);
    await creationControls('single');
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
    for (const width of [900, 768, 375])
      await record(`configuration-end-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await setPreview(width >= 600);
        await card().locator('app-property-picker').scrollIntoViewIfNeeded();
        await card().getByRole('button', {name: 'Collapse field settings', exact: true}).scrollIntoViewIfNeeded();
        await reveal(card().locator('app-property-picker'));
      }, 'Explicitly scrolled to inspect the end of Configuration.');
    await action('Enable multiple values', () => multiple(true));
    for (const width of [1100, 768, 375]) {
      await record(width === 375 ? 'phone-preview-multiple-375' : `both-panels-multiple-${width}`, async () => {
        await page.setViewportSize({width, height: 1000});
        await showEditor();
        await card().getByRole('textbox', {name: 'Enter field name', exact: true}).scrollIntoViewIfNeeded();
        await setPreview(true);
      });
      if (width === 1100) await creationControls('multiple-1100');
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
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Saved');
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
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Modified');
    });
    // An unsaved edit, then the draft the Designer retains for it through a reload.
    await action('Edit the description without saving', async () => {
      await page.getByPlaceholder('Add description...', {exact: true}).first().fill('Unsaved description');
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Modified');
    });
    await record('draft-offered', async () => {
      await waitForPage(page, () => Object.values(sessionStorage).some(raw => raw.includes('Unsaved description')));
      await page.reload();
      await page.getByRole('button', {name: 'Restore draft', exact: true}).waitFor();
    }, 'Reloading with unsaved changes.');
    await record('draft-offered-375', () => page.setViewportSize({width: 375, height: 667}));
    await action('Return to desktop before restoring the retained draft', () => page.setViewportSize({width: 1440, height: 1000}));
    await record('draft-restored', async () => {
      // The draft offer can render before the freshly loaded designer is ready to restore it.
      await waitForPage(page, () => document.getElementById('restore-draft')?.disabled === false);
      await click(page.getByRole('button', {name: 'Restore draft', exact: true}));
      // The host says so only once the Designer has adopted the draft.
      await page.getByRole('status').filter({hasText: 'Your draft has been restored.'}).waitFor();
      await card().waitFor();
      // The restored values render on the Designer's next coalesced pass, after the host's message.
      const description = page.getByRole('textbox', {name: 'Description', exact: true});
      for (let frame = 0; (await description.inputValue()) !== 'Unsaved description'; frame++) {
        assert.ok(frame < 120, 'The restored draft did not bring back its description.');
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
    });
    // The states that follow start from an empty, saved template.
    await action('Remove the sample field and save the template', async () => {
      await click(card().getByTitle('Delete field', {exact: true}));
      await page.getByPlaceholder('Add description...', {exact: true}).first().fill('Template description');
      await click(page.locator('#save'));
      await waitForPage(page, () => document.getElementById('state')?.textContent === 'Saved');
    });
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
      await page.locator('[aria-label="Enter field name"]:focus').fill('Visit notes');
    });
    await creationControls('nested');
    await record('keyboard', () => keyboard(session, page.locator('.overview-toggle'), {stops: 14}));
    await record('disabled-move-checked', async () => {
      const up = page.getByRole('button', {name: 'Move Participant up', exact: true});
      const order = () => page.locator('.overview-panel .node-label').allTextContents();
      const before = await order();
      assert.equal(await up.getAttribute('aria-disabled'), 'true');
      await up.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.deepEqual(await order(), before, 'Disabled Move up changed the outline order');
    }, 'Focused the disabled first-row Move up control and pressed Enter and Space; asserted that the outline order did not change.');
    await record('nested-hover-checked', async () => {
      const root = page.locator('app-container-editor').first();
      await click(root.locator(':scope > .container-content > .add-field-section > .bottom-insert-zone').getByRole('button', {name: 'Add field', exact: true}));
      const nested = page.locator('app-container-editor').last();
      const zone = nested.locator(':scope > .container-content > .add-field-section > .bottom-insert-zone');
      await zone.scrollIntoViewIfNeeded();
      if (!session.touch) await zone.hover();
      const add = zone.getByRole('button', {name: 'Add field', exact: true});
      await waitForPage(page, element => {
        for (let node = element; node instanceof Element; node = node.parentElement) {
          if (Number(getComputedStyle(node).opacity) < 0.99 || getComputedStyle(node).visibility === 'hidden') return false;
        }
        return true;
      }, await add.elementHandle(), {timeout: 3000});
    }, 'With the root field picker open, moved the pointer onto Visit’s trailing creation row and asserted that Add field is visible before activation.');
    await record('nested-activation-checked', async () => {
      const nested = page.locator('app-container-editor').last();
      await click(nested.locator(':scope > .container-content > .add-field-section > .bottom-insert-zone').getByRole('button', {name: 'Add field', exact: true}));
      await nested.locator('app-field-type-picker').getByRole('button', {name: 'Text', exact: true}).waitFor();
    }, 'Activated the revealed nested Add field with the pointer and verified that Visit’s field picker opened. No field was added.');
    });
    const typesComplete = await captureJourney(session, record, 'field-types-and-preview', async () => {
    // A fresh template holding one field of every type the picker offers: each card with its settings
    // open, then each field in Preview.
    await session.openNew();
    await page.setViewportSize({width: 1440, height: 1000});
    await setPreview(false);
    await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now() + ' field types');
    await record('field-type-picker', async () => {
      await click(page.getByRole('button', {name: /^Add field$/}).last());
      await page.locator('app-field-type-picker').getByRole('button', {name: DESIGNER_TYPES[0][1], exact: true}).waitFor();
    }, 'The picker adding a field opens, on a new template.');
    await action(`Add ${DESIGNER_TYPES[0][1]} field from the open picker`, async () => {
      await click(page.locator('app-field-type-picker').getByRole('button', {name: DESIGNER_TYPES[0][1], exact: true}));
      const input = page.locator('[aria-label="Enter field name"]:focus');
      await input.fill(DESIGNER_TYPES[0][1] + ' sample'); await input.press('Tab');
    });
    for (const [, label] of DESIGNER_TYPES.slice(1)) await session.addField(label, label + ' sample');
    for (const [index, [slug]] of DESIGNER_TYPES.entries()) {
      const typed = page.locator('app-field-card').nth(index);
      await record('type-' + slug, async () => {
        const expand = typed.getByRole('button', {name: 'Expand field settings', exact: true});
        if (await expand.isVisible()) await click(expand);
        await typed.getByRole('button', {name: 'Collapse field settings', exact: true}).waitFor();
      });
      if (['checkboxes', 'email', 'controlled-terms', 'pfas', 'doi', 'section-break', 'page-break'].includes(slug)) await record(`type-${slug}-configuration-end`, async () => {
        await click(typed.getByRole('tab', {name: 'Configuration', exact: true}));
        if (await typed.locator('app-property-picker').count()) await reveal(typed.locator('app-property-picker'));
        await reveal(typed.getByRole('button', {name: 'Collapse field settings', exact: true}));
      }, 'Scrolled to the end of Configuration and checked the complete settings footer, including the Property IRI and its actions where this field type has one.');
      await click(typed.getByRole('button', {name: 'Collapse field settings', exact: true}));
    }
    // The controlled-term picker, from the controlled-terms card's constraints, at desktop and phone width.
    const terms = page.locator('app-field-card').nth(DESIGNER_TYPES.findIndex(([slug]) => slug === 'controlled-terms'));
    const picker = page.getByRole('dialog', {name: 'Controlled-term constraints', exact: true});
    const scrollResult = async (tab, width) => {
      const release = picker.locator('#cetp-results button.of').first();
      await record(`term-picker-${tab}-scrolled-${width}`, async () => {
        await release.scrollIntoViewIfNeeded();
        await release.focus();
        const box = await release.boundingBox();
        const footer = await picker.getByRole('button', {name: 'Done', exact: true}).boundingBox();
        assert.ok(box && footer && box.y >= 0 && box.y + box.height <= footer.y, 'Release control is not above the dialog footer');
        await click(release);
        await waitForPage(page, element => element.getAttribute('aria-expanded') === 'true', await release.elementHandle());
        // The disclosure changes immediately; the release rows arrive asynchronously.
        // Preserve the rendered layout even if a loaded history is clipped: that is review evidence.
        await picker.locator('#cetp-results .history .release').first().waitFor({state: 'attached'});
      }, 'Scrolled to the first source release-history control, asserted that its full target is above Done, activated it with the pointer, verified expansion, and waited for the release rows to load before capture.');
      if (tab === 'ontologies') {
        for (const edge of ['first', 'last']) await record(`term-picker-ontologies-release-${edge}-${width}`, async () => {
          const rows = picker.locator('#cetp-results .history .release');
          await reveal(edge === 'first' ? rows.first() : rows.last());
        }, 'Scrolled within the open release history and verified that the complete release row and its center hit target are reachable above the footer.');
      }
      // The same source can appear on the next tab. Restore the closed history so
      // its activation check opens it instead of toggling a retained history shut.
      await action(`Close ${tab} release history after its capture`, async () => {
        await click(release);
        await waitForPage(page, element => element.getAttribute('aria-expanded') === 'false', await release.elementHandle());
      });
    };
    const firstTerm = picker.getByRole('button', {name: /^melanoma in \d+ ontolog/});
    for (const width of TERM_PICKER_WIDTHS) {
      await page.setViewportSize({width, height: width === 1440 ? 1000 : 667});
      await record(`term-picker-initial-feedback-${width}`, async () => {
        const expand = terms.getByRole('button', {name: 'Expand field settings', exact: true});
        if (await expand.isVisible()) await click(expand);
        await click(terms.getByRole('tab', {name: 'Constraints', exact: true}));
        await page.evaluate(() => {
          const timing = window.__cedarReviewSearchTiming = {started: performance.now(), visible: null, feedback: null, text: null};
          const visible = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 &&
            getComputedStyle(node).visibility !== 'hidden';
          const frame = () => {
            const root = document.querySelector('cedar-embeddable-designer')?.shadowRoot?.querySelector('cedar-embeddable-term-picker');
            if (visible(root)) {
              timing.visible ??= performance.now();
              const content = root.shadowRoot || root;
              const feedback = content.querySelector('.working:not(.idle)') || content.querySelector('#cetp-results .row, #cetp-results .empty, .notice');
              if (visible(feedback)) {timing.feedback = performance.now(); timing.text = feedback.textContent.trim(); return;}
            }
            if (performance.now() - timing.started < 10000) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        await click(terms.getByRole('button', {name: 'Edit controlled-term constraints', exact: true}));
        await waitForPage(page, () => window.__cedarReviewSearchTiming?.feedback !== null && window.__cedarReviewSearchTiming?.feedback !== undefined);
        const timing = await page.evaluate(() => {
          const {visible, feedback, text} = window.__cedarReviewSearchTiming;
          return {visibleToFeedbackMs: Math.round(feedback - visible), text};
        });
        session.actions.push({label: 'Frame-sampled initial search feedback without holding or delaying responses', width, ...timing});
        await session.flush();
      }, 'Opened the picker with the real service response unmodified and measured the interval from its first visible frame to visible search feedback or results.');
      await action('Close the unmodified initial search after it settles', async () => {
        await page.waitForLoadState('networkidle');
        await picker.locator('.working').waitFor({state: 'hidden'});
        await click(picker.getByRole('button', {name: 'Done', exact: true}));
        await picker.waitFor({state: 'hidden'});
      });
      const heldSearch = await holdSearchRequests(page);
      try {
      await record(`term-picker-open-${width}`, async () => {
        const expand = terms.getByRole('button', {name: 'Expand field settings', exact: true});
        if (await expand.isVisible()) await click(expand);
        await click(terms.getByRole('tab', {name: 'Constraints', exact: true}));
        await click(terms.getByRole('button', {name: 'Edit controlled-term constraints', exact: true}));
        await picker.getByRole('searchbox', {name: 'Find terms', exact: true}).waitFor();
      }, 'The harness temporarily holds the initial search response so the opening and loading states can be inspected separately.');
      await record(`term-picker-loading-${width}`, async () => {
        await heldSearch.waitForSearch();
        await picker.locator('.working:not(.idle)').waitFor({state: 'visible'});
      },
        'Initial search is in progress; the harness holds the response without changing the product or the query.');
      } finally {await heldSearch.release();}
      await record(`term-picker-settled-${width}`, async () => {
        await picker.locator('.working.idle').waitFor({state: 'attached'});
        await picker.locator('#cetp-results .row, #cetp-results .empty, .notice').first().waitFor({state: 'visible'});
        // Rendering the results can start an automatic next-page read. Include its completion.
        await page.waitForLoadState('networkidle');
        await picker.locator('.working').waitFor({state: 'hidden'});
        await picker.locator('.tail').filter({hasText: 'reading more'}).waitFor({state: 'hidden'});
      }, 'The original initial query has finished against the local terminology service. Inspect the settled results, empty message or error feedback before changing the query.');
      await record(`term-picker-results-${width}`, async () => {
        await picker.getByRole('searchbox', {name: 'Find terms', exact: true}).fill('melanoma');
        await firstTerm.waitFor();
      }, 'Searching the local terminology store for melanoma.');
      await record(`term-picker-term-${width}`, async () => {
        await click(firstTerm);
        await picker.getByRole('heading', {name: 'Term details', exact: true}).waitFor();
      });
      await scrollResult('term', width);
      await record(`term-picker-branches-${width}`, async () => {
        await click(picker.getByRole('tab', {name: /^Branches/}));
        await picker.getByRole('tabpanel', {name: /^Branches/}).waitFor();
      });
      await scrollResult('branches', width);
      await record(`term-picker-ontologies-${width}`, async () => {
        await click(picker.getByRole('tab', {name: /^Ontologies/}));
        await picker.getByRole('tabpanel', {name: /^Ontologies/}).waitFor();
      });
      await scrollResult('ontologies', width);
      await record(`term-picker-search-restored-${width}`, async () => {
        const search = picker.getByRole('searchbox', {name: 'Find terms', exact: true});
        await reveal(search);
        assert.equal(await search.inputValue(), 'melanoma');
      }, 'Returned to the existing search field by ordinary scrolling and verified that the full field and unchanged query are visible.');
      await record(`term-picker-done-${width}`, async () => {
        await click(picker.getByRole('button', {name: 'Done', exact: true}));
        await picker.waitFor({state: 'hidden'});
      });
      await click(terms.getByRole('button', {name: 'Collapse field settings', exact: true}));
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await setPreview(true);
    await record('overview-selection-header-reached', async () => {
      await click(page.locator('.overview-panel').getByRole('button', {name: 'Text sample', exact: true}));
      await click(page.locator('.overview-panel').getByRole('button', {name: 'Controlled Terms sample', exact: true}));
      const name = terms.getByRole('textbox', {name: 'Enter field name', exact: true});
      await waitForPage(page, node => {
        const r = node.getBoundingClientRect(), pane = node.closest('.designer-scroll').getBoundingClientRect();
        return r.top >= pane.top && r.bottom <= pane.bottom;
      }, await name.elementHandle());
      const remove = terms.getByTitle('Delete field', {exact: true});
      const box = await remove.boundingBox(), pane = await page.locator('.designer-scroll').boundingBox();
      assert.ok(box.y >= pane.y && box.y + box.height <= pane.y + pane.height);
    }, 'Selected another Overview row, then Controlled Terms sample. Without corrective scrolling, verified that its settled name and Delete control are inside the authoring viewport.');
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

    await record('attribute-value-readonly-checked', async () => {
      const inputs = page.locator('.preview-panel app-cedar-input-attribute-value input');
      assert.equal(await inputs.count(), 2, 'Expected both Attribute Value controls');
      for (const input of await inputs.all()) {
        const before = await input.inputValue();
        await input.focus();
        await page.keyboard.type('attempted-edit');
        assert.equal(await input.inputValue(), before, 'Read-only Preview accepted a text edit');
      }
    }, 'Attempted keyboard text entry in both Attribute Name and Attribute Value; asserted that neither value changed.');
    await action('Prepare keyboard navigation into Attribute Value', async () => {
      await page.locator('.preview-panel app-cedar-input-attribute-value input').first().focus();
      await page.keyboard.press(tabKey(page, 'Shift+Tab'));
    });
    for (const [index, part] of ['name', 'value'].entries())
      await record(`attribute-${part}-keyboard-focus`, async () => {
        await page.keyboard.press(tabKey(page));
        const input = page.locator('.preview-panel app-cedar-input-attribute-value input').nth(index);
        assert.ok(await input.evaluate(element => element.getRootNode().activeElement === element), 'Tab did not reach the expected Attribute Value control');
        const viewport = await page.locator('.cee-preview__mount').boundingBox();
        const visible = await input.evaluate((element, viewport) => {
          const label = element.closest('mat-form-field').querySelector('mat-label');
          return [element, label].every(part => {
            const box = part.getBoundingClientRect();
            return box.top >= viewport.y && box.bottom <= viewport.y + viewport.height;
          });
        }, viewport);
        assert.ok(visible, 'Attribute Value focus left its label or control outside Preview');
        const before = await input.inputValue();
        await page.keyboard.type('attempted-edit');
        assert.equal(await input.inputValue(), before, 'Read-only Preview accepted a text edit');
      }, 'Entered this read-only control using Tab from the preceding focus stop, without a separate scroll or scripted focus. Asserted that its label and control are fully inside Preview and that attempted typing leaves its value unchanged.');
    await record('preview-top-checked', async () => {
      await page.locator('.preview-panel').evaluate(element => {
        element.scrollTop = 0;
        for (const child of element.querySelectorAll('*')) if (child.scrollTop) child.scrollTop = 0;
      });
    }, 'Returned Preview to its top to inspect the complete identity header, independently of a field-centered scroll position.');
    await record('phone-scroll-restored', async () => {
      await page.setViewportSize({width: 375, height: 667});
      await setPreview(false);
      const editor = page.locator('.designer-scroll');
      await editor.evaluate(element => {element.scrollTop = 100;});
      const before = await editor.evaluate(element => element.scrollTop);
      await setPreview(true);
      await setPreview(false);
      const after = await editor.evaluate(element => element.scrollTop);
      assert.ok(Math.abs(after - before) <= 1, `Editor scroll changed from ${before} to ${after}`);
      session.actions.push({label: 'Phone authoring scroll restored after Preview', before, after});
    }, 'Recorded authoring scroll position, opened and closed Preview, and asserted that the same position was restored.');
    await record('phone-editor-top-checked', async () => {
      await page.locator('.designer-scroll').evaluate(element => {element.scrollTop = 0;});
    }, 'Returned phone authoring to its top to inspect complete labels independently of the preserved scroll position.');

    });
    await captureJourney(session, record, 'preferences-and-import', async () => {
    // After a failed type journey, initialize only the fixtures this independent group needs.
    if (!typesComplete) {
      await session.openNew();
      await page.getByPlaceholder('Template name', {exact: true}).fill('UI review pilot ' + Date.now() + ' settings');
      await session.addField('Text', 'Sample');
    }
    // Components the states above leave out, at desktop width: the user menu's two dialogs, the
    // field library sidebar its preference turns on, importing reusable fields and elements, an
    // element's settings with its labels and types, a type entered by IRI, and a property chosen in
    // the term picker. The preference is set back afterwards, so later states keep the inline picker.
    await action('Return to desktop authoring', async () => {
      await page.setViewportSize({width: 1440, height: 1000});
      await setPreview(false);
      await page.locator('.designer-scroll').evaluate(element => {element.scrollTop = 0;});
    });
    const userMenu = async item => {
      await click(page.getByRole('button', {name: 'User Menu', exact: true}));
      await click(page.locator('.user-menu-dropdown').getByRole('button', {name: item, exact: true}));
    };
    const preferences = page.getByRole('dialog', {name: 'User Preferences', exact: true});
    const selectionStyle = async label => {
      const option = preferences.getByRole('radio', {name: label});
      await option.scrollIntoViewIfNeeded();
      if (!await option.isChecked()) await click(option);
    };
    await record('preferences-modal', async () => {await userMenu('Preferences'); await preferences.waitFor();});
    await record('field-library-sidebar', async () => {
      await selectionStyle('Library Sidebar');
      await click(preferences.getByRole('button', {name: 'Close', exact: true}));
      // The sidebar's host draws no box of its own; its container does.
      await page.locator('app-field-library-sidebar .sidebar-container').waitFor();
    }, 'The Library Sidebar field selection style, chosen in the preferences.');
    await action('Return to the inline field picker', async () => {
      await userMenu('Preferences');
      await selectionStyle('Inline field picker');
      await click(preferences.getByRole('button', {name: 'Close', exact: true}));
      await page.locator('app-field-library-sidebar').waitFor({state: 'detached'});
    });
    await record('preset-definitions-modal', async () => {
      await userMenu('Define Presets');
      await page.locator('app-preset-definitions-modal [role="dialog"]').waitFor();
    });
    await action('Close the preset definitions', async () => {
      await click(page.locator('app-preset-definitions-modal .settings-dialog-close'));
      await page.locator('app-preset-definitions-modal [role="dialog"]').waitFor({state: 'detached'});
    });
    const importer = page.locator('app-child-picker dialog');
    await record('child-picker', async () => {
      await click(page.getByRole('button', {name: 'Import fields and elements', exact: true}).last());
      await importer.waitFor();
    }, 'The dialog that finds reusable fields and elements to import, before a search.');
    await action('Close the import dialog', async () => {
      await click(importer.getByRole('button', {name: 'Close', exact: true}));
      await importer.waitFor({state: 'detached'});
    });
    const elementSettings = page.locator('app-element-card').first();
    // The template open here holds fields only, so the element whose settings follow is added first.
    await action('Add an element at the end of the template', async () => {
      await click(page.getByRole('button', {name: 'Add element', exact: true}).last());
      await page.getByPlaceholder('Enter element name', {exact: true}).last().fill('Collection site');
    });
    await record('element-settings', async () => {
      await click(page.getByRole('button', {name: 'Expand element settings', exact: true}).first());
      await click(elementSettings.getByRole('tab', {name: 'Presentation', exact: true}));
      await elementSettings.locator('app-element-labels').scrollIntoViewIfNeeded();
    }, 'An element\'s Presentation settings, scrolled to its alternate names.');
    await record('types-manual-iri', async () => {
      await click(elementSettings.getByRole('tab', {name: 'Metadata', exact: true}));
      const types = elementSettings.locator('app-types-picker');
      await types.scrollIntoViewIfNeeded();
      await click(types.getByRole('button', {name: 'Enter IRI manually', exact: true}));
      await types.locator('app-manual-iri').waitFor();
    }, 'Entering a type for the element by its IRI.');
    const properties = page.getByRole('dialog', {name: 'Choose property IRI', exact: true});
    await record('property-detail', async () => {
      const expand = card().getByRole('button', {name: 'Expand field settings', exact: true});
      if (await expand.isVisible()) await click(expand);
      // A field that already has a property offers to replace it.
      const choose = card().getByRole('button', {name: /^(Choose|Replace) property IRI$/});
      await choose.scrollIntoViewIfNeeded(); await click(choose);
      await properties.getByRole('searchbox').fill('name');
      // A result opens to the sources that define it; selecting one shows its detail beneath it.
      const first = properties.locator('#cetp-results .row button').first();
      await first.waitFor(); await click(first);
      const source = properties.locator('.children.properties .child').first();
      await source.waitFor(); await click(source);
      await properties.locator('cetp-property-detail').waitFor();
    }, 'A property found by searching for "name", with its first source selected to show its detail.');
    await action('Close the property picker', async () => {
      await page.keyboard.press('Escape');
      await properties.waitFor({state: 'detached'});
    });

    });
    await captureJourney(session, record, 'missing-template', async () => {
    // An address no template has: the server answers 404 and the Designer reports it cannot load.
    const missingReason = 'Opening a template identifier no artifact has';
    await record('missing-template', async () => {
      session.expectedNetworkFailures.add(missingReason);
      try {
        await page.goto(new URL('/templates/edit/' + encodeURIComponent('https://repo.metadatacenter.orgx/templates/00000000-0000-4000-8000-000000000000'), session.base).href);
        await waitForPage(page, () => document.getElementById('state')?.textContent === 'Unable to load');
      } finally {session.expectedNetworkFailures.delete(missingReason);}
    });
    });
    // A missing saved fixture must remain a blocked state rather than a substituted screen.
    await captureJourney(session, record, 'text-size', async () => {
      await textSizeStates(session, record, async () => {
        if (!savedUrl) throw new Error('The authoring journey did not save a template');
        await page.goto(savedUrl); await session.ready();
      });
    });
    // Keep before/after evidence discoverable even when a review partition splits the sequence.
    // These are relationships, not verdicts or hints about what a reviewer should conclude.
    const relate = ids => {
      const captured = ids.filter(id => session.states.some(state => state.id === id));
      for (const state of session.states.filter(state => captured.includes(state.id)))
        state.relatedStates = [...new Set([...(state.relatedStates ?? []), ...captured.filter(id => id !== state.id)])];
    };
    for (const prefix of ['single', 'nested', 'multiple-1100'])
      relate([...(prefix === 'single' ? ['single', 'single-panel-a', 'single-panel-b', 'single-preview-a', 'single-preview-b'] : prefix === 'nested' ? ['nested', 'keyboard'] : ['both-panels-multiple-1100']),
        ...['idle', 'pointer', 'pointer-open', 'keyboard', 'keyboard-open'].map(state => `${prefix}-creation-${state}`)]);
    relate(['nested', 'nested-creation-pointer-open', 'nested-hover-checked', 'nested-activation-checked']);
    relate(['type-attribute-value-preview', 'attribute-value-readonly-checked', 'attribute-name-keyboard-focus', 'attribute-value-keyboard-focus']);
    relate(['type-text-preview', 'preview-top-checked', 'phone-scroll-restored', 'phone-editor-top-checked']);
    relate(['keyboard', 'disabled-move-checked']);
    relate(['multiple-1100-creation-pointer-open', 'multiple-1100-creation-keyboard-open', 'multiple-1100-creation-page-break-reached']);
    relate(['type-controlled-terms-preview', 'type-attribute-value-preview', 'overview-selection-header-reached']);
    for (const width of [900, 768, 375]) relate([`width-${width}`, `both-panels-${width}`, `configuration-end-${width}`]);
    for (const slug of ['checkboxes', 'email', 'controlled-terms', 'pfas', 'doi', 'section-break', 'page-break']) relate([`type-${slug}`, `type-${slug}-configuration-end`]);
    relate(['draft-offered', 'draft-offered-375', 'draft-restored']);
    for (const width of TERM_PICKER_WIDTHS)
      relate(['initial-feedback', 'open', 'loading', 'settled', 'results', 'term', 'branches', 'ontologies', 'term-scrolled', 'branches-scrolled', 'ontologies-scrolled', 'ontologies-release-first', 'ontologies-release-last', 'search-restored'].map(state => `term-picker-${state}-${width}`));
}
