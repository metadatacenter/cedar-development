import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireLocal,readOnlyResourcePost} from './guards.mjs';
test('fixture collection refuses production and lookalike hosts',()=>{
  for(const url of ['https://workspace.metadatacenter.orgx','http://localhost:8000','http://127.0.0.1:8080'])assert.doesNotThrow(()=>requireLocal(url));
  for(const url of ['https://workspace.metadatacenter.org','https://workspace.metadatacenter.orgx.example.com','https://notmetadatacenter.orgx','file://localhost/secret'])assert.throws(()=>requireLocal(url),/local development/);
});
test('read-only validation POSTs are allowed without opening mutation commands',()=>{
  for(const path of ['/artifact-validations/template','/template-update-checks/abc','/template-update-checks/element','/template-update-checks/field'])assert(readOnlyResourcePost('POST',path));
  for(const path of ['/command/publish-artifact','/command/rename-resource','/template-update-checks/abc/extra','/templates/abc'])assert(!readOnlyResourcePost('POST',path));
  assert(!readOnlyResourcePost('PUT','/artifact-validations/template'));
});
