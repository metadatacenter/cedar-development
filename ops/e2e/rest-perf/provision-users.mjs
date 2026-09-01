#!/usr/bin/env node
// Idempotently provision a stable pool of local Keycloak/CEDAR performance identities.
// Their resources are ephemeral; the identities and home folders intentionally persist.
import { env } from 'node:process';
import {
  KEYCLOAK, REALM, absolute, arg, assertSafeTargets, intArg, parallelLimit, tokenSubject,
  userProfile, userToken, writeJson,
} from './lib.mjs';

assertSafeTargets();

const count = intArg('count', 50, { max: 500 });
const concurrency = intArg('concurrency', 4, { max: 20 });
const output = absolute(arg('output', 'reports/rest-perf/users.json'));
const usernameDomain = arg('domain', 'test.com');
const password = env.CEDAR_PERF_USER_PASSWORD;
const adminUsername = env.CEDAR_KEYCLOAK_ADMIN_USER;
const adminPassword = env.CEDAR_KEYCLOAK_ADMIN_PASSWORD;

if (!password) throw new Error('CEDAR_PERF_USER_PASSWORD is required');
if (!adminUsername || !adminPassword) {
  throw new Error('source cedar-profile-native-develop.sh first; CEDAR_KEYCLOAK_ADMIN_USER and _PASSWORD are required');
}

async function adminToken() {
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  });
  if (!response.ok) throw new Error(`Keycloak admin login failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

async function adminRequest(token, method, path, body) {
  const response = await fetch(`${KEYCLOAK}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* Keep text for diagnostics. */ }
  return { status: response.status, body: json, text, headers: response.headers };
}

const administrator = await adminToken();
const normalRoleResponse = await adminRequest(administrator, 'GET', '/roles/normal');
if (normalRoleResponse.status !== 200) {
  throw new Error(`could not read the normal realm role: ${normalRoleResponse.status} ${normalRoleResponse.text}`);
}
const normalRole = normalRoleResponse.body;

async function exactUser(username) {
  const response = await adminRequest(administrator, 'GET', `/users?username=${encodeURIComponent(username)}&exact=true`);
  if (response.status !== 200) throw new Error(`could not look up ${username}: ${response.status} ${response.text}`);
  return response.body?.find(candidate => candidate.username === username);
}

async function provision(index) {
  const sequence = String(index + 1).padStart(3, '0');
  const username = `restperf-${sequence}@${usernameDomain}`;
  let keycloakUser = await exactUser(username);
  let created = false;
  if (!keycloakUser) {
    const response = await adminRequest(administrator, 'POST', '/users', {
      username,
      email: username,
      firstName: 'REST Performance',
      lastName: `User ${sequence}`,
      enabled: true,
      emailVerified: true,
    });
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`could not create ${username}: ${response.status} ${response.text}`);
    }
    keycloakUser = await exactUser(username);
    created = response.status === 201;
  }
  if (!keycloakUser?.id) throw new Error(`Keycloak created ${username} but it cannot be found`);

  const passwordResponse = await adminRequest(administrator, 'PUT',
      `/users/${keycloakUser.id}/reset-password`, { type: 'password', value: password, temporary: false });
  if (passwordResponse.status !== 204) {
    throw new Error(`could not set the password for ${username}: ${passwordResponse.status} ${passwordResponse.text}`);
  }
  const roleResponse = await adminRequest(administrator, 'POST',
      `/users/${keycloakUser.id}/role-mappings/realm`, [normalRole]);
  if (roleResponse.status !== 204) {
    throw new Error(`could not assign normal to ${username}: ${roleResponse.status} ${roleResponse.text}`);
  }

  // A real cedar-angular-app login fires the Keycloak listener that provisions the CEDAR user,
  // Everybody membership and home folder. Polling the profile proves the callback completed.
  const token = await userToken(username, password);
  const profile = await userProfile(token);
  if (profile['@id'] !== `https://metadatacenter.org/users/${tokenSubject(token)}`) {
    throw new Error(`${username} has unexpected CEDAR id ${profile['@id']}`);
  }
  console.log(`  ${created ? 'created' : 'verified'} ${username}`);
  return {
    sequence: index + 1,
    username,
    subject: tokenSubject(token),
    cedarUserId: profile['@id'],
    homeFolderId: profile.homeFolderId,
  };
}

console.log(`Provisioning ${count} REST performance users in Keycloak realm ${REALM}`);
const users = await parallelLimit(Array.from({ length: count }, (_, index) => index), concurrency, provision);
writeJson(output, {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  realm: REALM,
  usernameDomain,
  users,
});
console.log(`Verified ${users.length} users and wrote ${output}`);
