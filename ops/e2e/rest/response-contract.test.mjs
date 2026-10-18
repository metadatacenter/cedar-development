import test from 'node:test';
import assert from 'node:assert/strict';
import { responseContractProblem } from './response-contract.mjs';

const answer = body => ({ status: 200, body, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }) });
const user = { '@id': 'https://example.org/users/reader' };

test('group contracts enforce required fields, closed properties and URI types while allowing null descriptions', () => {
  const group = { '@id': 'https://example.org/groups/test', resourceType: 'group', 'schema:name': 'Test',
    'schema:description': null, specialGroup: null };
  assert.equal(responseContractProblem('group', answer(group)), null);
  const { 'schema:name': omitted, ...missingName } = group;
  assert.match(responseContractProblem('group', answer(missingName)), /required property 'schema:name'/);
  assert.match(responseContractProblem('group', answer({ ...group, unexpected: true })), /additional properties/);
  assert.match(responseContractProblem('group', answer({ ...group, '@id': 'not a URI' })), /uri/);
});

test('permission contracts resolve nested references and reject an invalid role', () => {
  const permissions = { owner: user, userPermissions: [{ user, role: 'viewer' }], groupPermissions: [] };
  assert.equal(responseContractProblem('permissions', answer(permissions)), null);
  assert.match(responseContractProblem('permissions', answer({ ...permissions,
    userPermissions: [{ user, role: 'administrator' }] })), /allowed values/);
  assert.match(responseContractProblem('permissions', answer({ ...permissions, owner: {} })), /required property '@id'/);
});

test('listings allow documented extensions but refuse missing fields and type drift without coercion', () => {
  const listing = { '@context': {}, currentOffset: 0, nodeListQueryType: 'folder', totalCount: 1,
    resources: [{ '@id': 'https://example.org/templates/test', resourceType: 'template', extra: true }],
    extra: { future: true }, categoryName: null };
  assert.equal(responseContractProblem('listing', answer(listing)), null);
  const { totalCount: omitted, ...missingCount } = listing;
  assert.match(responseContractProblem('listing', answer(missingCount)), /required property 'totalCount'/);
  const wrongType = { ...listing, totalCount: '1' };
  assert.match(responseContractProblem('listing', answer(wrongType)), /integer/);
  assert.equal(wrongType.totalCount, '1');
  assert.match(responseContractProblem('listing', answer({ ...listing, resources: [{}] })), /required property/);
});

test('contract mistakes, failed HTTP calls and non-JSON responses cannot silently pass', () => {
  assert.match(responseContractProblem('missing-contract', answer({})), /Unknown response contract/);
  assert.match(responseContractProblem('group', { ...answer({}), status: 403 }), /expected HTTP 200/);
  assert.match(responseContractProblem('group', { ...answer({}), headers: new Headers() }), /expected JSON/);
});
