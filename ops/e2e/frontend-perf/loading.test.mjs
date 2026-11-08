import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modernLoadingFailures} from './loading.mjs';
const net=urls=>({networkFailures:[],pendingRequests:0,resources:urls.map(url=>({url,complete:true}))});
test('modern hosts accept their local APIs but reject unexpected external downloads',()=>{
  assert.deepEqual(modernLoadingFailures(net(['https://auth.local.invalid/check','https://resource.local.invalid/templates/id']),'workspace-editor-large','local.invalid'),[]);
  assert.ok(modernLoadingFailures(net(['https://production.example/script.js']),'openview-small','local.invalid').some(e=>e.includes('Unexpected origin')));
});
test('landing pages keep editor code deferred; an actual editor can download it once',()=>{
  const resources=net(['https://workspace.local.invalid/third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.host-fonts.js']);
  assert.ok(modernLoadingFailures(resources,'workspace-dashboard','local.invalid').some(e=>e.includes('Deferred code')));
  assert.deepEqual(modernLoadingFailures(resources,'workspace-editor-large','local.invalid'),[]);
  const twice={...resources,resources:[...resources.resources,...resources.resources]};
  assert.ok(modernLoadingFailures(twice,'workspace-editor-large','local.invalid').some(e=>e.includes('Duplicate')));
});
test('asset errors and incomplete loads fail for every modern scenario family',()=>{
  for(const scenario of ['workspace-dashboard','monitoring-dashboard','bridging-dashboard','content-index','term-picker',
    'cee-standalone-small','ced-standalone-small','ced-integrated-small','designer-small','workspace-editor-small','openview-small']) {
    const resources={...net([]),networkFailures:[{status:404,path:'/assets/i18n-cee/en.json'}]};
    assert.ok(modernLoadingFailures(resources,scenario,'local.invalid').length,scenario);
  }
});

test('Chromium cancellation after HTTP 204 is successful; other cancellations still fail',()=>{
  const network=net(['https://auth.local.invalid/realms/CEDAR/protocol/openid-connect/login-status-iframe.html/init']);
  Object.assign(network.resources[0],{complete:false,failed:true,canceled:true,status:204});
  assert.deepEqual(modernLoadingFailures(network,'workspace-dashboard','local.invalid'),[]);
  network.resources[0].status=200;
  assert.ok(modernLoadingFailures(network,'workspace-dashboard','local.invalid').some(e=>e.includes('Incomplete')));
  network.resources[0].status=204; network.resources[0].canceled=false;
  assert.ok(modernLoadingFailures(network,'workspace-dashboard','local.invalid').some(e=>e.includes('Incomplete')));
});
