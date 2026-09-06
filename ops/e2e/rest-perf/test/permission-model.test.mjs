import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactCapabilities, fieldActions, filesystemAcl, folderActions, folderCapabilities, sameMembers,
  samePermissionActions,
} from '../permission-model.js';

test('artifact roles expose the documented cumulative capability sets', () => {
  assert.deepEqual(artifactCapabilities.viewer, ['readResource']);
  assert.ok(artifactCapabilities.editor.includes('updateResource'));
  assert.ok(!artifactCapabilities.editor.includes('manageGrants'));
  assert.ok(artifactCapabilities.manager.includes('manageGrants'));
  assert.ok(!artifactCapabilities.manager.includes('transferOwnership'));
  assert.ok(artifactCapabilities.owner.includes('transferOwnership'));
});

test('folder Editor can receive resources but cannot manage grants or OpenView', () => {
  assert.ok(folderCapabilities.editor.includes('createInFolder'));
  assert.ok(folderCapabilities.editor.includes('copyIntoFolder'));
  assert.ok(folderCapabilities.editor.includes('moveIntoFolder'));
  assert.ok(!folderCapabilities.editor.includes('moveResource'));
  assert.ok(!folderCapabilities.editor.includes('manageGrants'));
  assert.ok(!folderCapabilities.editor.includes('manageOpenView'));
});

test('resource state actions remain separate from capabilities', () => {
  assert.deepEqual(fieldActions.viewer, ['copyFromResource']);
  assert.deepEqual(fieldActions.editor, ['copyFromResource']);
  assert.deepEqual(fieldActions.manager, ['copyFromResource', 'enableOpenView']);
  assert.deepEqual(folderActions.editor, []);
  assert.deepEqual(folderActions.owner, ['enableOpenView']);
  assert.equal(samePermissionActions(['copyFromResource', 'publish'], ['copyFromResource']), true);
  assert.equal(samePermissionActions(['copyFromResource', 'disableOpenView', 'publish'],
      ['copyFromResource', 'enableOpenView']), false);
});

test('filesystem ACL fixtures use role and never the legacy permission property', () => {
  const acl = filesystemAcl('owner', [{ id: 'user', role: 'editor' }], [{ id: 'group', role: 'viewer' }]);
  assert.deepEqual(acl, {
    owner: { '@id': 'owner' },
    userPermissions: [{ user: { '@id': 'user' }, role: 'editor' }],
    groupPermissions: [{ group: { '@id': 'group' }, role: 'viewer' }],
  });
  assert.equal(JSON.stringify(acl).includes('permission'), false);
});

test('sameMembers compares sets while rejecting duplicates and missing members', () => {
  assert.equal(sameMembers(['b', 'a'], ['a', 'b']), true);
  assert.equal(sameMembers(['a', 'a'], ['a', 'b']), false);
  assert.equal(sameMembers(['a'], ['a', 'b']), false);
});
