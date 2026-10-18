import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquire, release, lockPath, holderOf, describeHolder } from '../../split-lock.mjs';
import { Fixtures } from './fixtures.mjs';
import { plan } from './matrix.mjs';
import { journeyScenarios } from './queries.mjs';
import { awaitCorpus, recorder, runRest, restCheckIds, completion } from './suite.mjs';

export async function runLive({ isolated = false, tier = 'rest', reportPath }) {
  assert.ok(reportPath, 'A live run must retain its fixture ledger and results');
  // Import is deliberately below the runner's explicit --live boundary.
  const api = await import('../lib.mjs');
  const runToken = 'SearchCorpus' + randomUUID().replaceAll('-', '');
  const scope = isolated ? '' : runToken;
  const report = { ...plan({ isolated, tier }), status: 'RUNNING', runToken, startedAt: new Date().toISOString(),
    fixtures: [], mutations: [], requests: [], readiness: [], checks: [], cleanupErrors: [],
    source: { developmentHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' }).trim() },
    runtime: { resource: api.RESOURCE, group: api.GROUP_SERVER, node: process.version,
      attribution: 'Observed running deployment; no build, redeploy or release-gate certification is performed.' } };
  const checkpoint = () => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  };
  checkpoint();
  let fixtures, browser, lock, interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let cleaning = false;
  try {
    const path = lockPath(fileURLToPath(new URL('../../', import.meta.url))), holder = holderOf();
    const taken = acquire(path, holder);
    assert.ok(taken.acquired, `Another journey run holds the stack lock: ${taken.holder ? describeHolder(taken.holder) : path}`);
    lock = { path, holder };
    const { user1, user2 } = await api.actors();
    const credentials = { owner: user1.auth, reader: user2.auth };
    const request = async (actor, method, path, body, options = {}) => {
      if (interrupted && !cleaning) throw new Error('Run interrupted; cleaning up owned fixtures');
      const { server = 'resource', conditional = false, current, ...rest } = options;
      const opts = { ...rest, ...(server === 'group' ? { base: api.GROUP_SERVER } : {}) };
      let response;
      if (conditional && current) {
        const etag = current.headers?.get('etag');
        assert.ok(etag, `Missing revision for ${method} ${path}`);
        response = await api.call(credentials[actor], method, path, body, { ...opts, headers: { ...opts.headers, 'If-Match': etag } });
      } else response = await (conditional ? api.mutate : api.call)(credentials[actor], method, path, body, opts);
      // Synthetic corpus only. Never persist request headers, credentials or the user directory.
      report.requests.push({ actor, method, path, server, status: response.status,
        ...(path.startsWith('/search') ? { response: response.body } : {}) });
      return response;
    };
    fixtures = new Fixtures({ request, owner: user1.profile['@id'], reader: user2.profile['@id'], scope: runToken, report, checkpoint });
    await fixtures.provision(user1.profile.homeFolderId);
    await awaitCorpus(fixtures, request, report);
    const check = recorder(report, checkpoint);
    if (tier !== 'rest') {
      // The browser uses a separate context and only this synthetic corpus. No UI is changed.
      const { chromium } = await import('playwright');
      const { searchJourney } = await import('./journey.mjs');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(25000);
      const base = process.env.CEDAR_BASE || 'https://workspace.metadatacenter.orgx';
      await page.goto(base + '/dashboard');
      await page.locator('#username').waitFor();
      await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER2_LOGIN || 'test2@test.com');
      await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER2_PASSWORD || 'test2');
      await page.locator('#kc-login').click();
      await page.getByRole('button', { name: 'New', exact: true }).waitFor();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await searchJourney({ page, base, fixtures, scope, check });
      report.browserErrors = errors;
      if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
      await browser.close();
      browser = undefined;
    }
    // Run the browser against the settled core corpus before REST lifecycle cases mutate membership.
    if (tier !== 'journey') await runRest({ fixtures, request, report, scope, check });
  } catch (error) {
    report.fatal = { message: error.message, stack: error.stack };
  } finally {
    try { await browser?.close(); }
    catch (error) { report.fatal ??= { message: `Browser cleanup: ${error.message}` }; }
    cleaning = true;
    try { if (fixtures) report.cleanupErrors = await fixtures.cleanup(); }
    catch (error) { report.cleanupErrors.push({ message: error.message }); }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const expected = [...(tier !== 'journey' ? restCheckIds : []),
      ...(tier !== 'rest' ? journeyScenarios.map(item => `journey/${item.id}`) : [])];
    report.completion = completion(report, expected);
    report.status = interrupted ? 'INTERRUPTED' : report.fatal || report.cleanupErrors.length || !report.completion.complete || report.completion.failed.length
      ? 'FAIL' : 'IMPLEMENTED_CASES_PASS_WITH_DECLARED_GAPS';
    report.finishedAt = new Date().toISOString();
    if (lock) release(lock.path, lock.holder);
    checkpoint();
  }
  return report;
}
