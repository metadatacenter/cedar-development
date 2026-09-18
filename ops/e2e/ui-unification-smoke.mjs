// Read-only browser checks of real shared control states; creates no artifacts.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import * as S from './selectors.mjs';
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({ignoreHTTPSErrors: true});
const page = await context.newPage();
const base = process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
const css = (locator, property) => locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), property);
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
  console.log('PASS: real group controls share focus, hover, pressed and disabled states');
} finally {
  await context.close();
  await browser.close();
}
