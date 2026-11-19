import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {CHECK_EXCEPTIONS} from './check-exceptions.mjs';

// The rules every application suite audits: everything axe-core tags for WCAG 2.0, 2.1 and 2.2 at
// levels A and AA, which includes colour contrast and the 24-pixel target size, plus the experimental
// rule that a control's visible label is part of its accessible name.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LABEL_IN_NAME = 'label-content-name-mismatch';

/**
 * Check the rendered page as it stands, without moving the pointer, focus or scroll position, so the
 * next interaction starts from the state the evidence shows. Each violation names its rule, the
 * element it concerns and what was measured.
 */
export async function automaticChecks(page) {
  await settleAnimations(page);
  const axe = await new AxeBuilder({page}).options({rules: {[LABEL_IN_NAME]: {enabled: true}}}).withTags(AXE_TAGS).analyze();
  const fromAxe = axe.violations.flatMap(rule => rule.nodes.map(node => ({source: 'axe', rule: rule.id, impact: rule.impact,
    target: node.target.flat(Infinity).join(' >>> '), detail: (node.failureSummary ?? rule.help).replace(/\s+/g, ' ').trim().slice(0, 300)})));
  return [...fromAxe, ...await page.evaluate(layoutViolations)];
}

/**
 * Let finite animations finish, so a tooltip or message still fading in is neither photographed nor
 * measured at a contrast it never settles at. An endless animation, such as a spinner, keeps running,
 * and no wait lasts longer than 1.5 seconds. Each shadow root keeps its own animations, so every one
 * is asked, after two frames in which a just-triggered animation can start.
 */
export async function settleAnimations(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const roots = [];
    const walk = root => {roots.push(root); for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);};
    walk(document);
    const finite = roots.flatMap(root => root.getAnimations?.() ?? [])
      .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
    return Promise.race([Promise.all(finite.map(animation => animation.finished.catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 1500))]);
  });
}

/**
 * Runs in the page. Reports layout a person would see as broken and axe does not test: a page that
 * scrolls sideways, text its own box cuts off without an ellipsis, a control the viewport cuts off,
 * and text drawn over other text.
 */
export function layoutViolations() {
  const found = [], roots = [];
  const walk = root => {roots.push(root); for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);};
  walk(document);
  const parentOf = node => node.parentElement ?? node.getRootNode()?.host ?? null;
  const contains = (outer, inner) => {for (let node = inner; node; node = parentOf(node)) if (node === outer) return true; return false;};
  const receiverAt = (x, y) => {
    let node = document.elementFromPoint(x, y);
    while (node?.shadowRoot) {const inner = node.shadowRoot.elementFromPoint(x, y); if (!inner || inner === node) break; node = inner;}
    return node;
  };
  const shown = el => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (el.checkVisibility?.({opacityProperty: true, visibilityProperty: true}) ?? true);
  };
  const TRANSIENT = /^(ng-|cdk-(focused|mouse-focused|keyboard-focused|program-focused|touch-focused)$|mat-focused$|mdc-ripple)/;
  const selector = el => {
    const parts = [];
    for (let node = el; node?.nodeType === 1 && node !== document.body && node !== document.documentElement && parts.length < 4; node = parentOf(node)) {
      let part = node.tagName.toLowerCase();
      if (node.id) {parts.unshift(part + '#' + node.id); break;}
      const classes = [...node.classList].filter(name => !TRANSIENT.test(name)).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const add = (rule, target, detail) => found.push({source: 'layout', rule, target, detail});
  const width = document.documentElement.clientWidth;
  const FORM = /^(INPUT|TEXTAREA|SELECT|OPTION)$/;
  const elements = roots.flatMap(root => [...root.querySelectorAll('*')]);
  const page = document.scrollingElement ?? document.documentElement;
  if (page.scrollWidth > page.clientWidth + 1)
    add('horizontal-page-overflow', 'document', `The page is ${page.scrollWidth}px wide in a ${page.clientWidth}px viewport.`);
  // Visually hidden text keeps a one-pixel box or a clip, and a form control scrolls its own value.
  const hiddenText = (el, css, box) => box.width <= 2 || box.height <= 2 || css.clip !== 'auto' || css.clipPath !== 'none';
  for (const el of elements) {
    if (FORM.test(el.tagName) || !shown(el) || ![...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) continue;
    const css = getComputedStyle(el), box = el.getBoundingClientRect();
    if (hiddenText(el, css, box) || [...el.children].some(child => !/^inline/.test(getComputedStyle(child).display))) continue;
    // An ellipsis or a line clamp says the text continues; a hard cut does not.
    const across = /hidden|clip/.test(css.overflowX) && css.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
    const down = /hidden|clip/.test(css.overflowY) && (css.webkitLineClamp ?? 'none') === 'none' && el.scrollHeight > el.clientHeight + 2;
    if (across || down) add('clipped-text', selector(el), `"${el.textContent.trim().slice(0, 60)}" needs ${el.scrollWidth}×${el.scrollHeight}px and shows ${el.clientWidth}×${el.clientHeight}px.`);
  }
  // A control in a region that scrolls sideways can be scrolled into view; a control cut off entirely
  // is usually a skip link or an off-canvas panel waiting to slide in.
  const scrollsAcross = el => {for (let node = parentOf(el); node && node !== document.body && node !== document.documentElement; node = parentOf(node)) if (/auto|scroll/.test(getComputedStyle(node).overflowX)) return true; return false;};
  const CONTROL = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=link],[role=combobox],[role=option]';
  for (const el of roots.flatMap(root => [...root.querySelectorAll(CONTROL)])) {
    if (!shown(el)) continue;
    const box = el.getBoundingClientRect();
    if (((box.left < -1 && box.right > 0) || (box.right > width + 1 && box.left < width)) && !scrollsAcross(el))
      add('control-outside-viewport', selector(el), `Spans ${Math.round(box.left)} to ${Math.round(box.right)}px of a ${width}px viewport.`);
  }
  // While a dialog, menu or other overlay is open, only its own text is compared: the page behind it
  // is covered on purpose.
  const layers = roots.flatMap(root => [...root.querySelectorAll('[aria-modal="true"],dialog[open],.cdk-overlay-pane')]).filter(shown);
  // A text range reports the whole run, including what an ellipsis or an overflowing ancestor hides,
  // so each line is first cut to the boxes that clip it.
  const clips = new Map();
  const clipFor = el => {
    if (clips.has(el)) return clips.get(el);
    const clip = {left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity};
    for (let node = el; node?.nodeType === 1; node = parentOf(node)) {
      const css = getComputedStyle(node);
      if (css.overflowX === 'visible' && css.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (css.overflowX !== 'visible') {clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right);}
      if (css.overflowY !== 'visible') {clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom);}
    }
    clips.set(el, clip);
    return clip;
  };
  const lines = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent.trim() || FORM.test(el.tagName) || !shown(el)) continue;
      const css = getComputedStyle(el);
      if (hiddenText(el, css, el.getBoundingClientRect()) || (layers.length && !layers.some(layer => contains(layer, el)))) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clip = clipFor(el);
      for (const whole of range.getClientRects()) {
        const left = Math.max(whole.left, clip.left), right = Math.min(whole.right, clip.right);
        const top = Math.max(whole.top, clip.top), bottom = Math.min(whole.bottom, clip.bottom);
        if (right - left > 1 && bottom - top > 1) lines.push({node, el, rect: {left, right, top, bottom, height: bottom - top}});
      }
    }
  }
  // Text boxes follow the font's ascent and descent, so lines set tighter than that touch without their
  // glyphs meeting. Only a substantial overlap that nothing opaque hides counts.
  const opaque = el => {const css = getComputedStyle(el); return css.backgroundImage !== 'none' || Number((css.backgroundColor.match(/[\d.]+/g) ?? [0, 0, 0, 0])[3] ?? 1) > 0.5;};
  const reported = new Set();
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (a.node === b.node) continue;
    const left = Math.max(a.rect.left, b.rect.left), right = Math.min(a.rect.right, b.rect.right);
    const top = Math.max(a.rect.top, b.rect.top), bottom = Math.min(a.rect.bottom, b.rect.bottom);
    if (right - left < 3 || bottom - top < 0.5 * Math.min(a.rect.height, b.rect.height)) continue;
    const hit = receiverAt((left + right) / 2, (top + bottom) / 2);
    const upper = hit && contains(a.el, hit) ? a : hit && contains(b.el, hit) ? b : null;
    if (!upper) continue;
    const lower = upper === a ? b : a;
    let hidden = false;
    for (let node = hit; node && !contains(node, lower.el); node = parentOf(node)) if (opaque(node)) {hidden = true; break;}
    const target = `${selector(lower.el)} under ${selector(upper.el)}`;
    if (hidden || reported.has(target)) continue;
    reported.add(target);
    add('overlapping-text', target, `"${lower.node.textContent.trim().slice(0, 40)}" lies under "${upper.node.textContent.trim().slice(0, 40)}".`);
  }
  return found;
}

/** The exception that accepts a violation, if any, and why. */
export function exceptionFor(app, violation, exceptions = CHECK_EXCEPTIONS) {
  return exceptions.find(entry => entry.app === app && entry.rule === violation.rule &&
    (entry.target instanceof RegExp ? entry.target.test(violation.target) : entry.target === violation.target)) ?? null;
}

/**
 * The capture's violations, grouped by rule and element across states: the same defect seen at three
 * widths is one problem to fix, not three.
 */
export async function summarizeChecks(directory, app, states, exceptions = CHECK_EXCEPTIONS) {
  const groups = new Map();
  let violations = 0;
  for (const state of states) {
    if (!state.checks) continue;
    for (const violation of JSON.parse(await readFile(join(directory, state.checks), 'utf8'))) {
      violations++;
      const key = `${violation.source}|${violation.rule}|${violation.target}`;
      if (!groups.has(key)) {
        const exception = exceptionFor(app, violation, exceptions);
        groups.set(key, {source: violation.source, rule: violation.rule, target: violation.target, impact: violation.impact ?? null,
          detail: violation.detail, states: [], exception: exception?.reason ?? null});
      }
      groups.get(key).states.push(state.id);
    }
  }
  return {violations, groups: [...groups.values()]};
}
