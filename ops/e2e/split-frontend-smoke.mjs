// Fast, credential-free contract smoke for the extracted frontend previews.
//
// Start both previews first:
//   ../cedar-services.sh start workspace designer
//   npm run smoke:split
//
// Override the defaults for a remote preview deployment with
// CEDAR_WORKSPACE_PREVIEW, CEDAR_DESIGNER_PREVIEW, CEDAR_AUTH_URL and
// CEDAR_RESOURCE_API. This smoke deliberately stops at the authentication
// boundary; the full browser journey owns login and resource mutations.

const withoutTrailingSlash = value => value.replace(/\/$/, '');

const workspace = withoutTrailingSlash(
  process.env.CEDAR_WORKSPACE_PREVIEW ?? 'http://localhost:4201');
const designer = withoutTrailingSlash(
  process.env.CEDAR_DESIGNER_PREVIEW ?? 'http://localhost:4202');
const auth = withoutTrailingSlash(
  process.env.CEDAR_AUTH_URL
    ?? `https://auth.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`);
const resourceApi = withoutTrailingSlash(
  process.env.CEDAR_RESOURCE_API ?? 'http://127.0.0.1:9007');

const workspaceOrigin = new URL(workspace).origin;
const designerOrigin = new URL(designer).origin;
const requireBuildInfo = process.env.CEDAR_REQUIRE_BUILD_INFO === '1';

function fail(message) {
  throw new Error(message);
}

async function fetchOk(label, url, options = {}) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', ...options });
  } catch (error) {
    fail(`${label}: could not reach ${url}: ${error.message}`);
  }
  if (response.status !== 200) {
    fail(`${label}: expected HTTP 200 from ${url}, got ${response.status}`);
  }
  return response;
}

async function expectText(label, url, marker, minimumBytes = 0) {
  const response = await fetchOk(label, url);
  const body = await response.text();
  if (body.length < minimumBytes) {
    fail(`${label}: expected at least ${minimumBytes} bytes, got ${body.length}`);
  }
  if (!body.includes(marker)) {
    fail(`${label}: response did not contain ${JSON.stringify(marker)}`);
  }
  console.log(`  ok  ${label}`);
}

async function readConfig(label, base) {
  const response = await fetchOk(label, `${base}/config/url-service.conf.json`);
  let config;
  try {
    config = await response.json();
  } catch (error) {
    fail(`${label}: invalid JSON: ${error.message}`);
  }
  return config;
}

async function expectBuildInfo(label, base, application, expectedCommit) {
  const response = await fetchOk(label, `${base}/config/build-info.json`);
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!cacheControl.includes('no-store')) {
    fail(`${label}: build identity is cacheable (${cacheControl || 'no Cache-Control header'})`);
  }

  let info;
  try {
    info = await response.json();
  } catch (error) {
    fail(`${label}: invalid JSON: ${error.message}`);
  }
  if (info.application !== application) {
    fail(`${label}: application is ${info.application}, expected ${application}`);
  }
  if (!/^[0-9a-f]{40}$/.test(info.sourceCommit ?? '')) {
    fail(`${label}: sourceCommit is not a full Git commit`);
  }
  if (info.sourceDirty !== false) {
    fail(`${label}: staging evidence requires a clean source tree, got sourceDirty=${info.sourceDirty}`);
  }
  if (!/^[0-9a-f]{64}$/.test(info.bundleSha256 ?? '')) {
    fail(`${label}: bundleSha256 is not a SHA-256 digest`);
  }
  if (expectedCommit && info.sourceCommit !== expectedCommit) {
    fail(`${label}: sourceCommit is ${info.sourceCommit}, expected ${expectedCommit}`);
  }
  console.log(`  ok  ${label} (${info.sourceCommit.slice(0, 8)}, ${info.bundleSha256.slice(0, 12)})`);
}

function assertNavigationConfig(label, config, expectDesignerOrigin = false) {
  if (config.workspaceFrontend !== workspaceOrigin) {
    fail(`${label}: workspaceFrontend is ${config.workspaceFrontend}, expected ${workspaceOrigin}`);
  }
  if (expectDesignerOrigin && config.templateDesignerFrontend !== designerOrigin) {
    fail(`${label}: templateDesignerFrontend is ${config.templateDesignerFrontend}, expected ${designerOrigin}`);
  }
  console.log(`  ok  ${label}`);
}

async function expectCors(label, origin, method) {
  const response = await fetchOk(label, `${resourceApi}/`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'Authorization,Content-Type',
    },
  });

  const allowedOrigin = response.headers.get('access-control-allow-origin');
  const allowedCredentials = response.headers.get('access-control-allow-credentials');
  const allowedMethods = (response.headers.get('access-control-allow-methods') ?? '').split(',');
  const allowedHeaders = (response.headers.get('access-control-allow-headers') ?? '')
    .toLowerCase().split(',');

  if (allowedOrigin !== origin) fail(`${label}: allowed origin is ${allowedOrigin}, expected ${origin}`);
  if (allowedCredentials !== 'true') fail(`${label}: credentials are not allowed`);
  if (!allowedMethods.includes(method)) fail(`${label}: ${method} is not allowed`);
  if (!allowedHeaders.includes('authorization') || !allowedHeaders.includes('content-type')) {
    fail(`${label}: Authorization and Content-Type are not both allowed`);
  }
  console.log(`  ok  ${label}`);
}

console.log('Split frontend preview contract');

await expectText('Workspace dashboard shell', `${workspace}/dashboard`, '<div id="angular-views-entry"');
await expectText('Workspace CEE route shell', `${workspace}/instances/create/example`,
  '<div id="angular-views-entry"');
await expectText('Workspace bootstrap', `${workspace}/require-config.js`,
  "angular.bootstrap(document, ['cedar.workspace'])");
await expectText('Workspace pinned CEE bundle',
  `${workspace}/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js`,
  'cedar-embeddable-editor', 1_000_000);
await expectText('Workspace auth origin', `${workspace}/config/version.js`,
  `window.cedarAuthUrl = "${auth}"`);

await expectText('Designer create shell', `${designer}/templates/create`,
  '<div id="angular-views-entry"');
await expectText('Designer bootstrap', `${designer}/require-config.js`,
  "angular.bootstrap(document, ['cedar.templateDesigner'])");
await expectText('Designer auth origin', `${designer}/config/version.js`,
  `window.cedarAuthUrl = "${auth}"`);

assertNavigationConfig('Workspace navigation origins',
  await readConfig('Workspace navigation config', workspace), true);
assertNavigationConfig('Designer navigation origins',
  await readConfig('Designer navigation config', designer));

await expectCors('Workspace REST preflight', workspaceOrigin, 'GET');
await expectCors('Designer REST preflight', designerOrigin, 'POST');

if (requireBuildInfo) {
  await expectBuildInfo('Workspace deployed build identity', workspace, 'cedar-workspace',
    process.env.CEDAR_EXPECT_WORKSPACE_COMMIT);
  await expectBuildInfo('Designer deployed build identity', designer, 'cedar-template-designer',
    process.env.CEDAR_EXPECT_DESIGNER_COMMIT);
}

console.log(`PASS: split frontend shells, bundle, origins, auth base and REST CORS are coherent${
  requireBuildInfo ? '; deployed source and bundle identities are clean and immutable' : ''}`);
