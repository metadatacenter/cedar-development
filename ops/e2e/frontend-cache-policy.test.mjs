import assert from 'node:assert/strict';
import test from 'node:test';

import { IMMUTABLE_MAX_AGE, kindOf, policyFor, violation } from './frontend-cache-policy.mjs';

test('a path falls under the rule for an entry page, a deployment file, a hashed bundle or a stable-name file', () => {
  assert.equal(kindOf('/'), 'entry');
  assert.equal(kindOf('/index.html'), 'entry');
  assert.equal(kindOf('/folders/x'), 'entry', 'a deep link is answered with the entry page');
  assert.equal(kindOf('/config/build-info.json'), 'config');
  assert.equal(kindOf('/main-ABCDEFG2.js'), 'hashed');
  assert.equal(kindOf('/styles-7Z2X3Q4W.css'), 'hashed');
  assert.equal(kindOf('/main-abcdefg2.js'), 'stable', 'esbuild hashes are upper-case base32');
  assert.equal(kindOf('/main-ABCDEFG1.js'), 'stable', 'base32 has no 1');
  assert.equal(kindOf('/favicon.ico'), 'stable');
  assert.equal(kindOf('/assets/i18n/en.json'), 'stable');
});

test('a development stack must say no-store for everything', () => {
  for (const kind of ['entry', 'config', 'hashed', 'stable']) {
    assert.equal(violation('development', kind, 'no-store'), null, kind);
    assert.match(violation('development', kind, 'no-cache'), /expected no-store/, kind);
  }
});

test('a deployment keeps entry pages and deployment files out of every cache', () => {
  assert.equal(violation('deployment', 'entry', 'no-store'), null);
  assert.equal(violation('deployment', 'config', 'No-Store, private'), null);
  assert.match(violation('deployment', 'entry', 'no-cache'), /expected no-store, got no-cache/);
  assert.match(violation('deployment', 'config', null), /got no header/);
});

test('a deployment keeps a hashed bundle for a year and never revalidates it', () => {
  assert.equal(violation('deployment', 'hashed', `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`), null);
  assert.match(violation('deployment', 'hashed', 'public, max-age=14400'), /expected immutable/);
  assert.match(violation('deployment', 'hashed', 'immutable, max-age=14400'), /max-age of at least/);
});

test('a deployment lets a stable-name file be kept only if the browser asks before reusing it', () => {
  assert.equal(violation('deployment', 'stable', 'no-cache'), null);
  assert.equal(violation('deployment', 'stable', 'no-store'), null);
  assert.match(violation('deployment', 'stable', null), /expected no-cache, got no header/);
  assert.match(violation('deployment', 'stable', 'max-age=14400'), /expected no-cache/);
});

test('the policy follows the host unless named', () => {
  assert.equal(policyFor('metadatacenter.orgx'), 'development');
  assert.equal(policyFor('staging.metadatacenter.org'), 'deployment');
  assert.equal(policyFor('metadatacenter.orgx', 'deployment'), 'deployment');
  assert.throws(() => policyFor('metadatacenter.org', 'strict'), /must be development or deployment/);
});
