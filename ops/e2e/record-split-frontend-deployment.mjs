// Emit a machine-readable deployment record for the two extracted frontends.
// The running applications are authoritative: each record contains the exact
// environment-specific served-tree digest, not merely an image tag or package version.

const withoutTrailingSlash = value => value.replace(/\/$/, '');
const workspace = withoutTrailingSlash(
  process.env.CEDAR_WORKSPACE_PREVIEW ?? 'http://localhost:4201');
const designer = withoutTrailingSlash(
  process.env.CEDAR_DESIGNER_PREVIEW ?? 'http://localhost:4202');
const allowDirty = process.env.CEDAR_ALLOW_DIRTY_PREVIEW === '1';

async function readBuild(base, application, expectedCommit) {
  const url = `${base}/config/build-info.json`;
  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    throw new Error(`${application}: could not reach ${url}: ${error.message}`);
  }
  if (response.status !== 200) {
    throw new Error(`${application}: expected HTTP 200 from ${url}, got ${response.status}`);
  }
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!cacheControl.includes('no-store')) {
    throw new Error(`${application}: build identity is cacheable (${cacheControl || 'no Cache-Control header'})`);
  }
  const info = await response.json();
  if (info.application !== application) {
    throw new Error(`${application}: endpoint identifies itself as ${info.application}`);
  }
  if (!/^[0-9a-f]{40}$/.test(info.sourceCommit ?? '')) {
    throw new Error(`${application}: sourceCommit is not a full Git commit`);
  }
  if (!/^[0-9a-f]{64}$/.test(info.bundleSha256 ?? '')) {
    throw new Error(`${application}: bundleSha256 is not a SHA-256 digest`);
  }
  if (!allowDirty && info.sourceDirty !== false) {
    throw new Error(`${application}: refusing to record a dirty or unknown source payload`);
  }
  if (expectedCommit && info.sourceCommit !== expectedCommit) {
    throw new Error(`${application}: sourceCommit is ${info.sourceCommit}, expected ${expectedCommit}`);
  }
  return { origin: new URL(base).origin, ...info };
}

const [workspaceBuild, designerBuild] = await Promise.all([
  readBuild(workspace, 'cedar-workspace', process.env.CEDAR_EXPECT_WORKSPACE_COMMIT),
  readBuild(designer, 'cedar-template-designer', process.env.CEDAR_EXPECT_DESIGNER_COMMIT),
]);

const record = {
  schemaVersion: 1,
  environment: process.env.CEDAR_DEPLOYMENT_ENVIRONMENT ?? 'preview',
  recordedAt: new Date().toISOString(),
  deploymentId: `${workspaceBuild.bundleSha256.slice(0, 12)}-${designerBuild.bundleSha256.slice(0, 12)}`,
  workspace: workspaceBuild,
  designer: designerBuild,
};

console.log(JSON.stringify(record, null, 2));
