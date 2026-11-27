import {basename} from 'node:path';

// These are static, hermetic calibration pages, not Angular application pages. Wait for fonts
// and two rendered frames with a deadline; do not replay an action or redraw a calibration case.
async function painted(page) {
  await page.waitForFunction(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  }, undefined, {timeout: 5000});
}
async function state(page) {
  return page.evaluate(() => JSON.stringify({
    document: document.documentElement.outerHTML,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    activeElement: [...document.querySelectorAll('*')].indexOf(document.activeElement),
    elements: [...document.querySelectorAll('*')].map(n => [
      n.scrollLeft, n.scrollTop,
      'value' in n ? n.value : null, 'checked' in n ? n.checked : null,
      'selected' in n ? n.selected : null,
      n.getBoundingClientRect().toJSON(),
    ]),
  }));
}

export async function calibrationScreenshot(page, path, {onEvent = async () => {}} = {}) {
  await painted(page);
  const before = await state(page);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.screenshot({path, timeout: 10000});
    } catch (error) {
      await onEvent({image: basename(path), attempt, outcome: 'failed', error: error.message});
      if (attempt === 2 || !/Protocol error \(Page\.captureScreenshot\): Unable to capture screenshot(?:\r?\n|$)/.test(error.message)) throw error;
      await painted(page);
      if (await state(page) !== before) {
        const changed = new Error('Calibration state changed after screenshot failure; refusing to retry', {cause: error});
        await onEvent({image: basename(path), attempt, outcome: 'aborted', error: changed.message});
        throw changed;
      }
      continue;
    }
    if (attempt > 1) await onEvent({image: basename(path), attempt, outcome: 'recovered'});
    return;
  }
}
