// Credential-free cache-delivery contract for the seven local frontend origins.
//
// Development source trees use stable filenames, so the HTTPS proxy must make every response
// no-store. The three RequireJS applications add a second guarantee: their generated version file
// exposes a full source commit and produces a different asset key for each page load.

import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const suffix = process.env.CEDAR_HOST ?? 'metadatacenter.orgx';
const applications = [
  { name: 'CEDAR', base: `https://cedar.${suffix}`, repo: 'cedar-template-editor' },
  { name: 'Workspace', base: `https://workspace.${suffix}`, repo: 'cedar-workspace' },
  { name: 'Designer', base: `https://designer.${suffix}`, repo: 'cedar-template-designer' },
  { name: 'OpenView', base: `https://openview.${suffix}` },
  { name: 'Content', base: `https://content.${suffix}` },
  { name: 'Monitoring', base: `https://monitoring.${suffix}` },
  { name: 'Bridging', base: `https://bridging.${suffix}` },
];

function fail(message) {
  throw new Error(message);
}

async function fetchOk(label, url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status !== 200) fail(`${label}: ${url} returned ${response.status}`);
  return response;
}

function expectNoStore(label, response) {
  const policy = response.headers.get('cache-control') ?? '';
  if (!policy.toLowerCase().split(',').map(value => value.trim()).includes('no-store')) {
    fail(`${label}: expected Cache-Control no-store, got ${policy || 'no header'}`);
  }
}

function firstLocalAsset(html) {
  const matches = html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g);
  for (const match of matches) {
    if (!/^(?:https?:)?\/\//.test(match[1])) return match[1];
  }
  return null;
}

function evaluateVersion(source, now) {
  const sandbox = { window: {}, Date: { now: () => now } };
  vm.runInNewContext(source, sandbox, { filename: 'config/version.js' });
  return sandbox.window;
}

function currentCommit(repository) {
  const cedarHome = process.env.CEDAR_HOME;
  if (!cedarHome) fail('CEDAR_HOME is required to verify served source identities');
  return execFileSync('git', ['-C', `${cedarHome}/${repository}`, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
}

for (const application of applications) {
  const entry = await fetchOk(`${application.name} entry`, `${application.base}/index.html`);
  expectNoStore(`${application.name} entry`, entry);
  const html = await entry.text();
  const assetPath = firstLocalAsset(html);
  if (assetPath) {
    const asset = await fetchOk(`${application.name} boot asset`, new URL(assetPath, `${application.base}/`));
    expectNoStore(`${application.name} boot asset`, asset);
  }

  if (application.repo) {
    const versionResponse = await fetchOk(`${application.name} version`,
      `${application.base}/config/version.js`);
    expectNoStore(`${application.name} version`, versionResponse);
    const versionSource = await versionResponse.text();
    const first = evaluateVersion(versionSource, 1_000);
    const second = evaluateVersion(versionSource, 2_000);
    if (!/^[0-9a-f]{40}$/.test(first.cedarSourceCommit ?? '')) {
      fail(`${application.name} version: cedarSourceCommit is not a full Git commit`);
    }
    const expectedCommit = currentCommit(application.repo);
    if (first.cedarSourceCommit !== expectedCommit) {
      fail(`${application.name} version: serves ${first.cedarSourceCommit}, expected ${expectedCommit}`);
    }
    if (first.cedarDevelopmentMode !== true) {
      fail(`${application.name} version: local payload is not marked as development mode`);
    }
    if (first.cedarCacheControl === second.cedarCacheControl) {
      fail(`${application.name} version: two page loads produced the same asset key`);
    }
    if (!first.cedarCacheControl.includes(first.cedarSourceCommit.slice(0, 12))) {
      fail(`${application.name} version: asset key does not contain the source commit`);
    }
  }

  console.log(`  ok  ${application.name}`);
}

console.log('PASS: all local frontend responses are no-store and RequireJS keys are per-load and source-bound');
