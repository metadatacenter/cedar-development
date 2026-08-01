// An audit of how the services treat a credential, rather than of any one route's logic.
//
// The headline property this suite guards: the services verify a bearer token's signature against
// Keycloak's key. A token is unpacked and its issuer, expiry and subject are checked, and — the part
// that once went unchecked — its signature is validated, so a token with a forged or altered signature
// no longer authenticates as whoever its payload names. This was a critical defect (the subject uuid is
// not a secret — it is stamped into pav:createdBy on every artifact — so any reader could mint a token
// for anyone); it is now fixed, and the reads below pin it: each turns into a failure the day
// verification regresses.
//
// The suite is still deliberately careful about writes, as defense in depth. A forged-token write is
// aimed only at a throwaway subtree the suite creates and is prepared to lose, never at anything it does
// not own outright, so a regression that reopened the hole could not damage real data mid-run. An
// earlier version aimed a permission change at the first user's home folder; back when forged writes
// were honoured it was accepted, and the home folder's ownership had to be repaired by hand.
import { suite, check, call, cleanup, authHeader, enc, RUN, GROUP_SERVER, OPENVIEW } from '../lib.mjs';

export const name = 'authentication';

/**
 * A real token with its signature corrupted: header and payload untouched, one character of the
 * signature flipped. Every claim the server reads — issuer, expiry, subject — is exactly what a
 * genuine login produced, so the only thing wrong is the one thing the server does not check.
 */
function tamperedSignature(jwt) {
  const [head, payload, signature] = jwt.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  return `${head}.${payload}.${flipped}`;
}

/** A completely synthetic token: valid shape, chosen claims, a signature that is just a word. */
function forgedFor(subjectUuid, { exp = 4102444800 } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'forged' });
  const payload = b64({ sub: subjectUuid, exp, iat: 1700000000, typ: 'Bearer' });
  return `${head}.${payload}.${'bm90LWEtc2lnbmF0dXJl'}`;
}

export async function run({ user1, user2, homeFolderId, folderId }) {
  const auth = user1.auth;
  const subjectOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;

  suite('authentication: a token signature is verified');

  // The subject uuid is not a secret: it is stamped into pav:createdBy on every artifact the user
  // touches. So a forgery needs nothing an ordinary reader of the data does not already have — which
  // is exactly why the signature must be checked. These forgeries used to be honoured; each must now
  // be refused. If any of them is accepted again, verification has regressed.
  const forged = forgedFor(subjectOf(user1.auth));
  const tampered = tamperedSignature(user1.auth);

  const forgedContents = await call(null, 'GET', `/folders/${enc(homeFolderId)}/contents`, undefined,
      { headers: { Authorization: `Bearer ${forged}` } });
  check(forgedContents.status === 401,
      'a token forged from a user id, with no key material, cannot list that user\'s home folder',
      `expected 401, got ${forgedContents.status} — a 200 means signatures are no longer verified`);

  check((await call(null, 'GET', '/search?q=a&limit=1', undefined,
      { headers: { Authorization: `Bearer ${forged}` } })).status === 401,
      'and cannot search as that user',
      'a forged token was accepted for search');

  check((await call(null, 'GET', '/search?q=a&limit=1', undefined,
      { headers: { Authorization: `Bearer ${tampered}` } })).status === 401,
      'a genuine token with one character of its signature changed is refused',
      'a token with an altered signature was accepted');

  // The other rejection reasons still hold, so a green result here is verification working and not the
  // auth path having broken and started refusing everything: expiry, and that the subject is real.
  const expired = forgedFor(subjectOf(user1.auth), { exp: 1000 });
  check((await call(null, 'GET', '/search?q=a&limit=1', undefined,
      { headers: { Authorization: `Bearer ${expired}` } })).status === 401,
      'an expired forgery is refused',
      'an expired token was accepted');

  const unknownSubject = forgedFor('00000000-0000-0000-0000-000000000000');
  check((await call(null, 'GET', '/search?q=a&limit=1', undefined,
      { headers: { Authorization: `Bearer ${unknownSubject}` } })).status === 401,
      'and a forgery naming no real user is refused',
      'a token for a non-existent user was accepted');

  // And a real, correctly-signed token still works, which proves the checks above reject the forgery
  // specifically rather than rejecting every bearer token.
  check((await call(user1.auth, 'GET', '/search?q=a&limit=1')).status === 200,
      'while a genuine, correctly-signed token is still accepted',
      'a valid token was refused — verification is now rejecting good tokens too');

  suite('authentication: a forged token cannot write either');

  // Demonstrated only against a throwaway subtree. A parent folder the first user owns, then a write
  // into it with a corrupted-signature token, which must be refused. Nothing outside this subtree is
  // ever a target. If the write is somehow accepted, the child is registered for teardown so the tree
  // is still cleaned up.
  const parentName = `Authentication Throwaway ${RUN}`;
  const parent = await call(auth, 'POST', '/folders',
      { folderId, name: parentName, description: 'Created by the REST suites' });
  if (check(parent.status === 201, 'a throwaway parent folder is created', `it could not be created: ${parent.status}`)) {
    const parentId = parent.body['@id'];
    cleanup('folder', `/folders/${enc(parentId)}`, parentName);

    const childName = `Written With A Bad Signature ${RUN}`;
    const forgedWrite = await call(null, 'POST', '/folders',
        { folderId: parentId, name: childName, description: 'created with a corrupted-signature token' },
        { headers: { Authorization: `Bearer ${tampered}` } });
    if (forgedWrite.status === 201) cleanup('folder', `/folders/${enc(forgedWrite.body['@id'])}`, childName);
    check(forgedWrite.status === 401, 'a corrupted-signature token cannot create a folder',
        `expected 401, got ${forgedWrite.status} — a 201 means write authentication does not verify signatures`);
  }

  suite('authentication: a missing or unparseable credential');

  // These are not merely unsigned — they are not credentials at all. Each must be refused, and refused
  // cleanly: a 500 means the request reached code that assumed authentication had happened.
  const routes = [
    { what: 'resource server, listing contents', base: undefined, path: `/folders/${enc(homeFolderId)}/contents` },
    { what: 'resource server, searching', base: undefined, path: '/search?q=anything&limit=1' },
    { what: 'group server, listing groups', base: GROUP_SERVER, path: '/groups' },
  ];
  const cleanlyRefused = [
    { what: 'no Authorization header', headers: {} },
    { what: 'an empty Authorization header', headers: { Authorization: '' } },
    { what: 'an apiKey that does not exist', headers: { Authorization: `apiKey ${'0'.repeat(64)}` } },
    { what: 'a credential with no scheme', headers: { Authorization: 'just-a-string' } },
    { what: 'an unknown scheme', headers: { Authorization: 'Basic dGVzdDE6dGVzdDE=' } },
    { what: 'a real token under the wrong scheme', headers: { Authorization: `apiKey ${user1.auth}` } },
    // A Bearer value that is not a well-formed JWT. This used to fault with 500 because the token was
    // parsed before it was verified; verification now rejects it cleanly as the invalid credential it
    // is.
    { what: 'a malformed Bearer value', headers: { Authorization: 'Bearer not-a-jwt' } },
  ];
  for (const credential of cleanlyRefused) {
    for (const route of routes) {
      const res = await call(null, 'GET', route.path, undefined, { base: route.base, headers: credential.headers });
      check(res.status === 401 || res.status === 403,
          `${credential.what} → ${route.what}`,
          res.status < 400
              ? `it was ACCEPTED with ${res.status} — this is not a valid credential`
              : `expected 401, got ${res.status}: ${(res.text ?? '').slice(0, 160)}`);
    }
  }

  suite('authentication: authenticated is not authorized');

  // The part that works, and the reason the signature bug matters so much: a genuine, correctly
  // signed token still must not reach another user's private things. Proved against a throwaway.
  const privateName = `Authentication Private ${RUN}`;
  const mine = await call(auth, 'POST', '/folders',
      { folderId, name: privateName, description: 'Created by the REST suites' });
  if (check(mine.status === 201, 'a private folder is created', `it could not be created: ${mine.status}`)) {
    const at = `/folders/${enc(mine.body['@id'])}`;
    cleanup('folder', at, privateName);

    for (const [what, method, body] of [
      ['read it', 'GET', undefined],
      ['rename it', 'PUT', { 'schema:name': `${privateName} hijacked`, 'schema:description': 'attempt' }],
    ]) {
      const res = await call(user2.auth, method, at, body);
      check(res.status === 403 || res.status === 404,
          `a valid credential for another account cannot ${what}`,
          res.status < 400
              ? `it succeeded with ${res.status} — another user reached a private folder`
              : `expected 403 or 404, got ${res.status}: ${(res.text ?? '').slice(0, 160)}`);
    }
    // The same token on that user's own home folder, so the refusals above are about ownership and
    // not a broken credential.
    check((await call(user2.auth, 'GET', `/folders/${enc(user2.profile.homeFolderId)}`)).status === 200,
        'while that credential reaches its own account\'s home folder',
        'the second user could not read their own home folder, so the refusals above prove nothing');
  }

  suite('authentication: what OpenView requires, and what it must not');

  const closed = `/templates/${enc('https://repo.metadatacenter.orgx/templates/does-not-exist')}`;
  check((await call(null, 'GET', closed, undefined, { base: OPENVIEW })).status === 404,
      'OpenView answers an anonymous request rather than demanding a credential',
      'it refused an anonymous request it is meant to serve');

  // The scheme chooser is exercised rather than assumed: getting it wrong would make every suite's
  // authentication silently uniform.
  check(authHeader(user1.auth).startsWith('Bearer '), 'a JWT is sent as a Bearer token',
      `it was sent as "${authHeader(user1.auth).split(' ')[0]}"`);
  check(authHeader('0'.repeat(64)) === `apiKey ${'0'.repeat(64)}`,
      'and an API key under CEDAR\'s own scheme',
      `it was sent as "${authHeader('0'.repeat(64)).split(' ')[0]}"`);

  return {};
}
