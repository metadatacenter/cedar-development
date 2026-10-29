// Cache-delivery contract for the seven frontend origins, and a save that proves the browser runs
// the payload a deployment accepted.
//
// On a local development stack every response must be no-store, because source trees and
// development servers keep stable file names. A deployed origin follows the policy the os-mirror
// vhosts carry instead: entry pages, deep links and /config/ are no-store, a bundle named by its
// content hash is immutable, every other file revalidates, and a request for a bundle that no
// longer exists is refused rather than answered with the entry page. frontend-cache-policy.mjs
// holds those rules. The Template Editor, Workspace and the Template Designer serve a version file
// that names a full source commit in their asset key. The Template Editor's and Workspace's make a
// fresh key on every load; the Template Designer's host, served by Node, writes one when it starts.
//
// Every build identity an origin serves is compared with the commit the deployment accepted: the
// version file's commit, and on a deployment each /config/build-info.json. A local stack accepts
// each checkout's HEAD. A deployment names its commits in CEDAR_ACCEPTED_COMMITS, a JSON object
// keyed by repository, for example {"cedar-workspace": "<40-character commit>", ...}.
//
// Last, an instance is opened in Workspace's metadata editor, saved, reloaded and saved again. Each
// save must carry the ETag the editor last read as If-Match, which is what a browser running a
// stale payload gets wrong. To prove a browser that held an earlier payload now runs the accepted
// one, name a profile directory in CEDAR_CACHE_SMOKE_PROFILE and run the smoke from it before and
// after a deployment: the same profile keeps its cache between runs.
//
//   npm run smoke:frontend-cache                  # local stack, development policy
//   CEDAR_HOST=staging.metadatacenter.org CEDAR_ACCEPTED_COMMITS='{...}' npm run smoke:frontend-cache
//   npm run smoke:frontend-cache -- --skip-instance
//
// The instance step signs in as the profile's first test user and deletes what it creates.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { kindOf, policyFor, violation } from './frontend-cache-policy.mjs';
import { editorStatus } from './metadata-journey-fixtures.mjs';
import * as S from './selectors.mjs';
import { RESOURCE, actors, artifactBody, call, enc, mutate } from './rest/lib.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const suffix = process.env.CEDAR_HOST ?? 'metadatacenter.orgx';
const policy = policyFor(suffix, process.env.CEDAR_CACHE_POLICY);
const skipInstance = process.argv.includes('--skip-instance');
const applications = [
  { name: 'CEDAR', base: `https://cedar.${suffix}`, repo: 'cedar-template-editor', deepLink: '/dashboard', perLoadKey: true },
  // Workspace's entry page is a loader that writes the Angular build's own entry page into itself.
  {
    name: 'Workspace',
    base: `https://workspace.${suffix}`,
    repo: 'cedar-workspace',
    deepLink: '/dashboard',
    perLoadKey: true,
    buildEntry: '/workspace-build/index.html',
  },
  { name: 'Designer', base: `https://designer.${suffix}`, repo: 'cedar-template-designer', deepLink: '/templates/create' },
  { name: 'OpenView', base: `https://openview.${suffix}`, deepLink: '/folders/cache-smoke' },
  { name: 'Content', base: `https://content.${suffix}` },
  { name: 'Monitoring', base: `https://monitoring.${suffix}`, deepLink: '/dashboard' },
  { name: 'Bridging', base: `https://bridging.${suffix}`, deepLink: '/home' },
];

function fail(message) {
  throw new Error(message);
}

async function fetchOk(label, url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status !== 200) fail(`${label}: ${url} returned ${response.status}`);
  return response;
}

/** Hold a response to the rule its path falls under. */
function expectPolicy(label, url, response) {
  const kind = kindOf(new URL(url).pathname);
  const problem = violation(policy, kind, response.headers.get('cache-control'));
  if (problem) fail(`${label} (${kind}): ${problem}`);
}

/** Every script and stylesheet the entry page loads from its own origin. */
function localAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g))
    if (!/^(?:https?:)?\/\//.test(match[1])) assets.add(match[1]);
  return [...assets];
}

function evaluateVersion(source, now) {
  const sandbox = { window: {}, Date: { now: () => now } };
  vm.runInNewContext(source, sandbox, { filename: 'config/version.js' });
  return sandbox.window;
}

/** The commit the deployment accepted for a repository, or on a local stack the checkout's HEAD. */
const acceptedCommits = (() => {
  if (!process.env.CEDAR_ACCEPTED_COMMITS) return {};
  try {
    return JSON.parse(process.env.CEDAR_ACCEPTED_COMMITS);
  } catch {
    fail('CEDAR_ACCEPTED_COMMITS is not a JSON object of repository names and commits');
  }
})();
function acceptedCommit(repository) {
  if (acceptedCommits[repository]) return acceptedCommits[repository];
  if (policy === 'deployment') fail(`CEDAR_ACCEPTED_COMMITS names no commit for ${repository}`);
  const cedarHome = process.env.CEDAR_HOME;
  if (!cedarHome) fail('CEDAR_HOME is required to verify served source identities');
  return execFileSync('git', ['-C', `${cedarHome}/${repository}`, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

for (const application of applications) {
  const entryUrl = `${application.base}/index.html`;
  const entry = await fetchOk(`${application.name} entry`, entryUrl);
  expectPolicy(`${application.name} entry`, entryUrl, entry);
  const html = await entry.text();
  const pages = [{ html, base: `${application.base}/` }];
  if (application.buildEntry) {
    const buildUrl = `${application.base}${application.buildEntry}`;
    const build = await fetchOk(`${application.name} build entry`, buildUrl);
    expectPolicy(`${application.name} build entry`, buildUrl, build);
    pages.push({ html: await build.text(), base: buildUrl });
  }

  if (application.deepLink) {
    const url = `${application.base}${application.deepLink}`;
    expectPolicy(`${application.name} deep link`, url, await fetchOk(`${application.name} deep link`, url));
  }
  for (const { html: page, base } of pages)
    for (const assetPath of localAssets(page)) {
      const url = new URL(assetPath, base).href;
      expectPolicy(`${application.name} ${assetPath}`, url, await fetchOk(`${application.name} ${assetPath}`, url));
    }
  const favicon = await fetch(`${application.base}/favicon.ico`, { cache: 'no-store' });
  if (favicon.status === 200) expectPolicy(`${application.name} favicon`, favicon.url, favicon);

  if (policy === 'deployment') {
    // A bundle a later build removed must be refused. Answered with the entry page, it would be
    // cached for a year under the bundle's name.
    const missing = await fetch(`${application.base}/main-CACHESMK.js`, { cache: 'no-store' });
    if (missing.status === 200 && (missing.headers.get('content-type') ?? '').includes('text/html'))
      fail(`${application.name}: a request for a missing hashed bundle was answered with the entry page`);
  }

  if (application.repo) {
    const versionUrl = `${application.base}/config/version.js`;
    const versionResponse = await fetchOk(`${application.name} version`, versionUrl);
    expectPolicy(`${application.name} version`, versionUrl, versionResponse);
    const versionSource = await versionResponse.text();
    const first = evaluateVersion(versionSource, 1_000);
    const second = evaluateVersion(versionSource, 2_000);
    if (!/^[0-9a-f]{40}$/.test(first.cedarSourceCommit ?? '')) {
      fail(`${application.name} version: cedarSourceCommit is not a full Git commit`);
    }
    const expectedCommit = acceptedCommit(application.repo);
    if (first.cedarSourceCommit !== expectedCommit) {
      fail(`${application.name} version: serves ${first.cedarSourceCommit}, expected ${expectedCommit}`);
    }
    if ((first.cedarDevelopmentMode === true) !== (policy === 'development')) {
      fail(`${application.name} version: development mode is ${first.cedarDevelopmentMode} under the ${policy} policy`);
    }
    if (application.perLoadKey && first.cedarCacheControl === second.cedarCacheControl) {
      fail(`${application.name} version: two page loads produced the same asset key`);
    }
    if (!first.cedarCacheControl.includes(first.cedarSourceCommit.slice(0, 12))) {
      fail(`${application.name} version: asset key does not contain the source commit`);
    }
    // A local stack's build information belongs to whatever native build last ran, not to the
    // source it serves, so only a deployment's is compared.
    if (policy === 'deployment') {
      const infoUrl = `${application.base}/config/build-info.json`;
      const infoResponse = await fetchOk(`${application.name} build information`, infoUrl);
      expectPolicy(`${application.name} build information`, infoUrl, infoResponse);
      const info = await infoResponse.json();
      if (info.sourceCommit !== expectedCommit) {
        fail(`${application.name} build information: names ${info.sourceCommit}, expected ${expectedCommit}`);
      }
    }
  }

  console.log(`  ok  ${application.name}`);
}

if (!skipInstance) await instanceRoundTrip();

console.log(
  `PASS: every frontend response keeps the ${policy} cache policy, every served build identity is the accepted ` +
    `commit${skipInstance ? '' : ', and two saves of a reloaded instance each sent the ETag the editor had read'}`,
);

/**
 * Open an instance in Workspace's metadata editor, save it, reload, and save again. Each save must
 * send the ETag of the read before it as If-Match, and the reload must read the first save's.
 */
async function instanceRoundTrip() {
  const workspace = applications.find((application) => application.name === 'Workspace');
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const { user1 } = await actors();
  const folderId = user1.profile.homeFolderId;
  const created = [];
  async function create(collection, body) {
    const made = await call(user1.auth, 'POST', `/${collection}?folder_id=${enc(folderId)}`, body);
    assert.equal(made.status, 201, `the fixture ${collection} could not be created: ${made.text}`);
    created.unshift({ collection, id: made.body['@id'] });
    return made.body['@id'];
  }
  const template = artifactBody('template', `Cache smoke ${run} template`);
  template.properties.Notes = artifactBody('field', 'Notes');
  template.properties['@context'].properties.Notes = { enum: ['https://example.org/cache-smoke/Notes'] };
  template._ui.order.push('Notes');
  template._ui.propertyLabels.Notes = 'Notes';
  template.required.push('Notes');
  const templateId = await create('templates', template);
  const instance = artifactBody('instance', `Cache smoke ${run} metadata`, {
    'schema:isBasedOn': templateId,
    Notes: { '@value': 'Opened' },
  });
  instance['@context'].Notes = 'https://example.org/cache-smoke/Notes';
  instance['@context']['pav:derivedFrom'] = { '@type': '@id' };
  const instanceId = await create('template-instances', instance);

  const profile = process.env.CEDAR_CACHE_SMOKE_PROFILE;
  const options = { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } };
  const browser = profile ? null : await chromium.launch({ headless: !process.env.HEADED });
  const context = profile
    ? await chromium.launchPersistentContext(profile, { ...options, headless: !process.env.HEADED })
    : await browser.newContext(options);
  try {
    const page = await context.newPage();
    // A request for the instance itself, whatever query it carries. The editor addresses it by the
    // last segment of its identifier, and a path below it, such as its report, is another resource.
    const resource = new URL(RESOURCE).origin;
    const uuid = instanceId.split('/').at(-1);
    const forInstance = (url) => {
      const parsed = new URL(url);
      const [collection, id, ...rest] = parsed.pathname.split('/').filter(Boolean);
      return parsed.origin === resource && collection === 'template-instances' && !rest.length &&
        decodeURIComponent(id).split('/').at(-1) === uuid;
    };
    // The ETag of the latest read of the instance, which the next save must send as If-Match.
    let lastRead = null;
    // An ETag opens with the revision it names and goes on to name the representation: a save's
    // reply says "2-resource-record", and a read nginx compressed says "2--gzip".
    const revision = (etag) => etag?.match(/^(?:W\/)?"(\d+)-/)?.[1];
    page.on('response', (response) => {
      if (forInstance(response.url()) && response.request().method() === 'GET' && response.ok())
        lastRead = response.headers().etag ?? null;
    });
    await page.goto(`${workspace.base}/instances/edit/${enc(instanceId)}`);
    // A browser with no session is sent to the sign-in page; one with a session opens the editor.
    const username = page.locator(S.KC_USERNAME).first();
    const loaded = editorStatus(page, /^Unmodified$/);
    const signIn = await Promise.race([
      username.waitFor({ timeout: 30_000 }).then(() => true),
      loaded.waitFor({ timeout: 30_000 }).then(() => false),
    ]);
    if (signIn) {
      await username.fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN ?? 'test1@test.com');
      await page.locator(S.KC_PASSWORD).first().fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD ?? 'test1');
      await page.locator(S.KC_SUBMIT).first().click();
    }
    await loaded.waitFor({ timeout: 30_000 });
    // The browser must run the payload the deployment accepted, not one an earlier visit cached.
    const running = await page.evaluate(() => window.cedarSourceCommit);
    assert.equal(running, acceptedCommit(workspace.repo), 'the browser runs a Workspace payload other than the accepted one');

    const notes = page.locator('cedar-embeddable-editor').getByLabel('Notes', { exact: true });
    async function save(value, label) {
      await editorStatus(page, /^Unmodified$/).waitFor({ timeout: 30_000 });
      const read = lastRead;
      assert.ok(read, `${label}: the editor's read of the instance carried no ETag`);
      await notes.fill(value);
      const write = page.waitForResponse((r) => forInstance(r.url()) && r.request().method() === 'PUT');
      await page.locator('#button-save-metadata').click();
      const response = await write;
      assert.equal(response.status(), 200, `${label}: the save returned ${response.status()}`);
      assert.equal(response.request().headers()['if-match'], read, `${label}: the save did not send the ETag it had read`);
      return response.headers().etag;
    }
    const firstSave = await save('Saved once', 'first save');
    await page.reload();
    await editorStatus(page, /^Unmodified$/).waitFor({ timeout: 30_000 });
    assert.ok(revision(firstSave), `the first save's ETag ${firstSave} names no revision`);
    assert.equal(
      revision(lastRead),
      revision(firstSave),
      `the reload read revision ${lastRead}, not ${firstSave}, which the first save wrote`,
    );
    await save('Saved twice', 'second save');
    const stored = await call(user1.auth, 'GET', `/template-instances/${enc(instanceId)}`);
    assert.equal(stored.body.Notes?.['@value'], 'Saved twice', 'the second save was not stored');
    console.log('  ok  instance round trip');
  } finally {
    await context.close();
    await browser?.close();
    for (const { collection, id } of created)
      await mutate(user1.auth, 'DELETE', `/${collection}/${enc(id)}`).catch(() => {});
  }
}
