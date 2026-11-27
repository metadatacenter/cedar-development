import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireLocal,readOnlyResourcePost,ownedDraftFixture} from './guards.mjs';
test('fixture collection refuses production and lookalike hosts',()=>{
  for(const url of ['https://workspace.metadatacenter.orgx','http://localhost:8000','http://127.0.0.1:8080'])assert.doesNotThrow(()=>requireLocal(url));
  for(const url of ['https://workspace.metadatacenter.org','https://workspace.metadatacenter.orgx.example.com','https://notmetadatacenter.orgx','file://localhost/secret'])assert.throws(()=>requireLocal(url),/local development/);
});
test('read-only validation POSTs are allowed without opening mutation commands',()=>{
  for(const path of ['/artifact-validations/template','/template-update-checks/abc','/template-update-checks/element','/template-update-checks/field'])assert(readOnlyResourcePost('POST',path));
  for(const path of ['/command/publish-artifact','/command/rename-resource','/template-update-checks/abc/extra','/templates/abc'])assert(!readOnlyResourcePost('POST',path));
  assert(!readOnlyResourcePost('PUT','/artifact-validations/template'));
});

test('draft creation requires owned source and destination and a matching local new identity',()=>{
  const source='https://repo.metadatacenter.orgx/templates/11111111-1111-4111-8111-111111111111';
  const folder='https://repo.metadatacenter.orgx/folders/22222222-2222-4222-8222-222222222222';
  const draft='https://repo.metadatacenter.orgx/templates/33333333-3333-4333-8333-333333333333';
  const fixtures=[{collection:'templates',id:source},{collection:'folders',id:folder}];
  const body={'@id':source.split('/').slice(-2).join('/'),folderId:folder.split('/').slice(-2).join('/'),draftId:draft};
  assert.deepEqual(ownedDraftFixture(body,fixtures),{collection:'templates',id:draft});
  for(const change of [{'@id':'not-owned'},{folderId:'not-owned'},{draftId:undefined},{draftId:draft.replace('orgx','org')},{draftId:draft.replace('/templates/','/template-fields/')},{draftId:draft+'?other=true'}])
    assert.equal(ownedDraftFixture({...body,...change},fixtures),null);
});
