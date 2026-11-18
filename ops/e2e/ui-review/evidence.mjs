import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function captureState({page,directory,states,actions,flush,fullPage=true}, id, note = '') {
    if (!/^[a-z0-9-]+$/.test(id) || states.some(s => s.id === id)) throw new Error('Invalid or duplicate state ID');
    // Preserve hover/focus: moving the pointer for a screenshot can hide the very action
    // under review and make a subsequent click appear broken.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = `${id}.png`, aria = `${id}.aria.yml`, metrics = `${id}.json`;
    await page.screenshot({path: join(directory, screenshot), fullPage});
    await writeFile(join(directory, aria), await page.locator('body').ariaSnapshot());
    const geometry = await page.evaluate(() => {
      const roots = [], walk = root => {roots.push(root); for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);};
      walk(document);
      const receiverAt = (x,y) => {let node=document.elementFromPoint(x,y);const seen=new Set();while(node?.shadowRoot&&!seen.has(node)){seen.add(node);const inner=node.shadowRoot.elementFromPoint(x,y);if(!inner||inner===node)break;node=inner;}return node;};
      const contains = (parent,child) => {for(let node=child;node;node=node.parentNode||node.getRootNode()?.host)if(node===parent)return true;return false;};
      const describe = el => {
        const box = el.getBoundingClientRect(), css = getComputedStyle(el);
        const text = 'value' in el ? String(el.value) : el.textContent?.trim() || '';
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.font = css.font;
        const intrinsicTextWidth = context.measureText(text).width +
          Math.max(0, text.length - 1) * (parseFloat(css.letterSpacing) || 0);
        const x=box.x+box.width/2,y=box.y+box.height/2;
        const hit=x>=0&&y>=0&&x<innerWidth&&y<innerHeight?receiverAt(x,y):null;
        return {pointerTarget:hit?{x,y,belongsToControl:contains(el,hit),tag:hit.tagName,label:hit.getAttribute('aria-label')||hit.textContent?.trim().slice(0,100)}:null,tag: el.tagName.toLowerCase(), className: el.getAttribute('class'), role: el.getAttribute('role'), id: el.id,
          label: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 120),
          expanded: el.getAttribute('aria-expanded'), controls: el.getAttribute('aria-controls'),
          disabled: Boolean(el.disabled), value: 'value' in el ? el.value : undefined,
          visible: box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none',
          x: box.x, y: box.y, width: box.width, height: box.height,
          intrinsicTextWidth, paddingInline: [css.paddingLeft, css.paddingRight], gap: css.gap};
      };
      return {viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
        controls: roots.flatMap(root => [...root.querySelectorAll('button,input,textarea,select,a[href],label,[role="tab"],[role="separator"]')].map(describe)),
        regions: roots.flatMap(root => [...root.querySelectorAll('.overview-panel,.preview-panel,.field-header,.field-card-header,.field-heading,.field-header-details,.field-type-icon,.field-name-caption,.field-type-label,.occurrence-range,.required-mark,.field-actions,.container-type-label,.template-field-label,.version-group,app-field-card,app-field-summary,.metadata-toolbar,.template-name,.field-label,.pager-container,.aligned-up,app-cedar-multi-pager,mat-expansion-panel-header,.explorer-toolbar,.table-toolbar,.breadcrumbs,.paging,#workspace-information')].map(describe))};
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
