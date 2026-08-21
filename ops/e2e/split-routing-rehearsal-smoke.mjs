// Credential-free assertions for the local split-route/rollback gateway.
// The gateway mode is explicit so a stale or partly-merged nginx config fails.

const mode = process.env.CEDAR_ROUTING_MODE ?? process.argv[2];
if (!['split', 'rollback'].includes(mode)) {
  throw new Error('CEDAR_ROUTING_MODE must be split or rollback');
}

const withoutTrailingSlash = value => value.replace(/\/$/, '');
const canonical = withoutTrailingSlash(
  process.env.CEDAR_ROUTING_REHEARSAL ?? 'http://localhost:4280');
const designer = withoutTrailingSlash(
  process.env.CEDAR_DESIGNER_REHEARSAL ?? 'http://localhost:4282');

function fail(message) {
  throw new Error(message);
}

async function request(label, url, expectedStatus, expectedRoutingMode) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual' });
  } catch (error) {
    fail(`${label}: could not reach ${url}: ${error.message}`);
  }
  if (response.status !== expectedStatus) {
    fail(`${label}: expected HTTP ${expectedStatus}, got ${response.status}`);
  }
  const routingMode = response.headers.get('x-cedar-routing-mode');
  if (routingMode !== expectedRoutingMode) {
    fail(`${label}: routing mode is ${routingMode}, expected ${expectedRoutingMode}`);
  }
  return response;
}

async function expectText(label, url, marker, expectedRoutingMode) {
  const response = await request(label, url, 200, expectedRoutingMode);
  const body = await response.text();
  if (!body.includes(marker)) {
    fail(`${label}: response did not contain ${JSON.stringify(marker)}`);
  }
  if (response.headers.has('location')) {
    fail(`${label}: unexpectedly redirected to ${response.headers.get('location')}`);
  }
  console.log(`  ok  ${label}`);
}

async function expectRedirect(path) {
  const response = await request(`Designer redirect ${path}`, `${canonical}${path}`, 307, 'split');
  const expected = `${designer}${path}`;
  const location = response.headers.get('location');
  if (location !== expected) {
    fail(`Designer redirect ${path}: Location is ${location}, expected ${expected}`);
  }
  console.log(`  ok  temporary redirect preserves ${path}`);
}

console.log(`Split frontend routing rehearsal (${mode})`);

if (mode === 'split') {
  await expectText('Canonical gateway serves Workspace bootstrap',
    `${canonical}/require-config.js`, "angular.bootstrap(document, ['cedar.workspace'])", 'split');
  await expectText('Canonical dashboard stays in Workspace',
    `${canonical}/dashboard`, '<div id="angular-views-entry"', 'split');
  await expectText('Canonical instance creation stays in Workspace',
    `${canonical}/instances/create/example`, '<div id="angular-views-entry"', 'split');
  await expectText('Designer gateway serves Designer bootstrap',
    `${designer}/require-config.js`, "angular.bootstrap(document, ['cedar.templateDesigner'])", 'designer');

  await expectRedirect('/templates/create?folderId=urn%3Auuid%3Aroute-test&returnTo=%2Fdashboard%3Ftab%3Dmine');
  await expectRedirect('/elements/edit/urn%3Auuid%3Aelement-test?returnTo=%2Fdashboard');
  await expectRedirect('/fields/create?returnTo=%2Ftemplates');
} else {
  await expectText('Canonical gateway serves monolith bootstrap',
    `${canonical}/require-config.js`, "angular.bootstrap(document, ['cedar.templateEditor'])", 'rollback');
  await expectText('Dashboard returns to monolith',
    `${canonical}/dashboard`, '<div id="angular-views-entry"', 'rollback');
  await expectText('Designer route returns to monolith',
    `${canonical}/templates/create?returnTo=%2Fdashboard`, '<div id="angular-views-entry"', 'rollback');
  await expectText('Instance route returns to monolith',
    `${canonical}/instances/create/example`, '<div id="angular-views-entry"', 'rollback');
}

console.log(`PASS: ${mode} routing table is complete and serves the expected application shells`);
