// Credential-free validation of the public Keycloak contract required by the
// local split frontends. This catches redirect allowlist and Web Origin drift
// before the longer authenticated browser journey starts.

const withoutTrailingSlash = value => value.replace(/\/$/, '');
const auth = withoutTrailingSlash(
  process.env.CEDAR_AUTH_URL
    ?? `https://auth.${process.env.CEDAR_HOST ?? 'metadatacenter.orgx'}`);
const clientId = process.env.CEDAR_KEYCLOAK_CLIENT_ID ?? 'cedar-angular-app';
const origins = (process.env.CEDAR_SPLIT_KEYCLOAK_ORIGINS
  ?? 'http://localhost:4201,http://localhost:4202')
  .split(',').map(value => withoutTrailingSlash(value.trim())).filter(Boolean);

function fail(message) {
  throw new Error(message);
}

async function request(label, url, options = {}) {
  try {
    return await fetch(url, { redirect: 'manual', ...options });
  } catch (error) {
    fail(`${label}: could not reach ${url}: ${error.message}`);
  }
}

async function expectRedirectAllowed(origin) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/silent-check-sso.html`,
    response_type: 'code',
    scope: 'openid',
    state: 'cedar-split-preflight',
    nonce: 'cedar-split-preflight',
  });
  const response = await request('callback allowlist',
    `${auth}/realms/CEDAR/protocol/openid-connect/auth?${params}`);
  const body = await response.text();
  if (response.status >= 400 || /invalid[^<]{0,40}redirect_uri/i.test(body)) {
    fail(`${origin}: Keycloak rejected the silent-login callback (HTTP ${response.status})`);
  }
  console.log(`  ok  callback ${origin}/*`);
}

async function expectCors(origin) {
  const response = await request('Web Origin preflight',
    `${auth}/realms/CEDAR/protocol/openid-connect/token`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
      },
    });
  const allowedOrigin = response.headers.get('access-control-allow-origin');
  const credentials = response.headers.get('access-control-allow-credentials');
  const methods = (response.headers.get('access-control-allow-methods') ?? '')
    .split(',').map(value => value.trim());
  if (response.status !== 200 || allowedOrigin !== origin || credentials !== 'true'
      || !methods.includes('POST')) {
    fail(`${origin}: Keycloak CORS mismatch (HTTP ${response.status}, origin=${allowedOrigin}, `
      + `credentials=${credentials}, methods=${methods.join(',')})`);
  }
  console.log(`  ok  Web Origin ${origin}`);
}

if (origins.length === 0) fail('no split frontend origins configured');

console.log(`Keycloak split-client preflight (${clientId})`);
for (const origin of origins) {
  await expectRedirectAllowed(origin);
  await expectCors(origin);
}
console.log('PASS: split frontend callbacks and exact Web Origins are authorized');
