import assert from 'node:assert/strict';
import { queries, expectedAliases } from './queries.mjs';
import { exactResults, scopedQuery } from './assertions.mjs';

// Bound to the opt-in search runner and its shared stack lock. Ordinary journey runs do not
// provision this corpus; the explicit search command owns its creation, evidence and cleanup.
export async function searchJourney({ page, base, fixtures, scope, check }) {
  const queryCase = id => queries.find(test => test.id === id);
  const expected = id => expectedAliases(queryCase(id), 'reader').map(alias => fixtures.id(alias));
  const expression = id => scopedQuery(queryCase(id).query, scope);
  const responseFor = query => response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname.endsWith('/search') && url.searchParams.get('q') === query;
  };
  async function renderedResults(response, id) {
    exactResults({ status: response.status(), body: await response.json() }, expected(id));
    // The response event precedes the application's render; idle alone could observe the old rows.
    await page.waitForFunction(wanted => {
      const ids = [...document.querySelectorAll('[data-resource-id]')].map(row => row.getAttribute('data-resource-id')).sort();
      return document.querySelector('.table-scroll')?.getAttribute('aria-busy') === 'false'
        && JSON.stringify(ids) === JSON.stringify(wanted);
    }, [...expected(id)].sort());
    const ids = await page.locator('[data-resource-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-resource-id')));
    assert.deepEqual([...ids].sort(), [...expected(id)].sort(), 'Rendered rows differ from the permitted IDs');
    assert.equal(new URL(page.url()).searchParams.get('search'), expression(id));
    assert.equal(await page.getByRole('textbox', { name: 'Search workspace', exact: true }).inputValue(), expression(id));
  }
  async function submit(id) {
    const input = page.getByRole('textbox', { name: 'Search workspace', exact: true });
    await input.fill(expression(id));
    const [response] = await Promise.all([page.waitForResponse(responseFor(expression(id))), input.press('Enter')]);
    await renderedResults(response, id);
  }
  await page.goto(base + '/dashboard');
  await page.getByRole('button', { name: 'New', exact: true }).waitFor();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await check('journey/quoted-value', () => submit('field-phrase'));
  await check('journey/compound-query', () => submit('and-fields'));
  await check('journey/reload-back', async () => {
    const [reload] = await Promise.all([page.waitForResponse(responseFor(expression('and-fields'))), page.reload()]);
    await renderedResults(reload, 'and-fields');
    const [back] = await Promise.all([page.waitForResponse(responseFor(expression('field-phrase'))), page.goBack()]);
    await renderedResults(back, 'field-phrase');
  });
  await check('journey/type-filter', async () => {
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Filter by type' });
    for (const name of ['Folder', 'Template', 'Element', 'Field', 'Instance'])
      await popup.getByRole('checkbox', { name, exact: true }).setChecked(name === 'Instance');
    const [response] = await Promise.all([page.waitForResponse(responseFor(expression('field-phrase'))),
      popup.getByRole('button', { name: 'Apply', exact: true }).click()]);
    assert.equal(new URL(response.url()).searchParams.get('resource_types'), 'instance');
    await renderedResults(response, 'field-phrase');
  });
  await check('journey/open-identity', async () => {
    const id = fixtures.id('ny-stats');
    // The attribute is the identity; matching the visible name alone would select the private twin.
    await page.locator(`[data-resource-id="${id}"]`).getByRole('link', { name: 'Record 01', exact: true }).click();
    await page.getByRole('textbox', { name: 'Instance name', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#instance-name')?.value === 'Record 01');
    assert.equal(await page.getByRole('textbox', { name: 'Instance name', exact: true }).inputValue(), 'Record 01');
    const route = decodeURIComponent(new URL(page.url()).pathname);
    assert.ok(route.includes(id) || route.endsWith('/' + id.split('/').at(-1)), 'Opened a different instance identity');
    assert.equal(await page.locator(`[data-resource-id="${fixtures.id('private-twin')}"]`).count(), 0);
  });
  async function sharingSearch(id, label) {
    await page.goto(base + '/dashboard');
    await page.getByRole('link', { name: label, exact: true }).click();
    const sharing = queryCase(id).parameters.sharing;
    await page.waitForURL(url => url.searchParams.get('sharing') === sharing);
    await submit(id);
    assert.equal(new URL(page.url()).searchParams.get('sharing'), sharing);
    const [response] = await Promise.all([page.waitForResponse(responseFor(expression(id))), page.reload()]);
    assert.equal(new URL(response.url()).searchParams.get('sharing'), sharing);
    await renderedResults(response, id);
    assert.equal(new URL(page.url()).searchParams.get('sharing'), sharing);
  }
  await check('journey/public-sharing', () => sharingSearch('public-view-with-term', 'Shared with Everyone'));
  await check('journey/personal-sharing', () => sharingSearch('shared-view-with-term', 'Shared with Me'));
}
