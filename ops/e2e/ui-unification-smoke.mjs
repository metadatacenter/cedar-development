// Read-only browser checks of real shared control states; creates no artifacts.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import {chromium} from 'playwright';
import * as S from './selectors.mjs';
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({ignoreHTTPSErrors: true});
const page = await context.newPage();
const base = process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
const css = (locator, property) => locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), property);
const screenshots = process.env.CEDAR_UI_SCREENSHOTS;
async function capture(name) {
  if (!screenshots) return;
  await mkdir(screenshots, {recursive: true});
  await page.screenshot({path: `${screenshots}/${name}.png`, fullPage: true});
}
async function flat(locator) {
  assert.equal(await css(locator, 'background-color'), 'rgb(255, 255, 255)');
  assert.equal(await css(locator, 'box-shadow'), 'none');
  assert.equal(await css(locator, 'background-image'), 'none');
}
async function noPageOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'only data tables may scroll horizontally');
}
async function heading(locator) {
  assert.equal(await css(locator, 'color'), 'rgb(23, 63, 62)', 'approved CEE artifact heading');
  assert.equal(await css(locator, 'font-weight'), '500');
}
try {
  await page.goto(base + '/groups');
  const login = page.locator(S.KC_USERNAME).first();
  if (await login.waitFor({state: 'visible', timeout: 10000}).then(() => true, () => false)) {
    await login.fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN || 'test1@test.com');
    await page.locator(S.KC_PASSWORD).first().fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD || 'test1');
    await page.locator(S.KC_SUBMIT).first().click();
  }
  await page.getByRole('tab', {name: 'Create group', exact: true}).click();
  const form = page.locator('.groups-create-form');
  const input = form.getByRole('textbox', {name: 'Group name'});
  const action = form.getByRole('button', {name: 'Create group', exact: true});
  assert.equal(await action.isDisabled(), true);
  assert.equal(await css(action, 'opacity'), '0.45');
  const disabledBackground = await css(action, 'background-color');
  await action.hover({force: true});
  assert.equal(await css(action, 'background-color'), disabledBackground, 'disabled hover must not imply interactivity');
  await input.fill('Unsaved shared-state check');
  assert.equal(await action.isEnabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await css(action, 'outline-width'), '2px');
  assert.equal(await css(action, 'outline-offset'), '2px');
  await input.hover();
  const resting = await css(action, 'background-color');
  await action.hover();
  const hovered = await css(action, 'background-color');
  assert.notEqual(hovered, resting, 'enabled primary action exposes hover feedback');
  await page.mouse.down();
  const pressed = await css(action, 'background-color');
  assert.notEqual(pressed, hovered, 'pressed state differs from hover');
  await input.hover();
  await page.mouse.up(); // release away from the action: never submit the form
  await input.fill('');
  await flat(page.locator('.topbar'));
  await flat(page.locator('.groups-create-card'));
  await heading(page.locator('.groups-page-header h1'));
  assert.equal(await css(input, 'border-radius'), '4px');
  assert.equal(await css(input, 'box-shadow'), 'none');
  assert.equal(await css(input, 'height'), '36px');
  await capture('groups-desktop');
  await page.setViewportSize({width: 375, height: 850});
  await noPageOverflow();
  await capture('groups-mobile');
  await page.setViewportSize({width: 1440, height: 1000});
  for (const route of ['profile', 'settings', 'privacy']) {
    await page.goto(base + '/' + route);
    await page.locator('.account-card').first().waitFor();
    await flat(page.locator('.account-header'));
    await flat(page.locator('.account-card').first());
    await heading(page.locator('.account-header h1'));
    await capture(route);
    await page.setViewportSize({width: 375, height: 850});
    await noPageOverflow();
    await page.setViewportSize({width: 1440, height: 1000});
  }
  await page.goto(base + '/dashboard');
  await page.getByRole('button', {name: 'New', exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector('.table-scroll')?.getAttribute('aria-busy') === 'false');
  await flat(page.locator('.topbar'));
  assert.equal(await css(page.locator('.search'), 'border-radius'), '4px');
  const logo = page.locator('.brand img');
  assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth > 0), true);
  await capture('workspace-desktop');
  await page.getByRole('button', {name: 'New', exact: true}).click();
  await page.locator('.new-menu').getByRole('button', {name: 'Folder', exact: true}).click();
  await heading(page.locator('dialog h2'));
  await capture('workspace-folder-dialog');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 375, height: 850});
  await capture('workspace-mobile');
  await noPageOverflow();
  console.log('PASS: Workspace, Groups, account pages and resource dialogs share CEE surfaces and headings; controls retain interaction states and narrow layouts');
} finally {
  await context.close();
  await browser.close();
}
