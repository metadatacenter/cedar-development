import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserDiagnostics,diagnosticUrl} from './diagnostics.mjs';

test('browser failures retain action and HTTP context without credentials, query strings or bodies',async()=>{
  const handlers={},actions=[{label:'Clear controlled term'}];
  const url='https://user:secret@resource.example.orgx/search?token=secret#private';
  const page={url:()=>url,on:(event,fn)=>handlers[event]=fn};
  const diagnostics=browserDiagnostics(page,actions);
  const request={method:()=> 'POST',url:()=>url,failure:()=>({errorText:'cancelled'})};
  handlers.requestfailed(request);
  handlers.response({status:()=>503,url:()=>url,request:()=>request});
  handlers.response({status:()=>200});
  assert.equal(diagnostics.networkFailures.length,2);
  assert.equal(diagnostics.networkFailures[0].lastAction,'Clear controlled term');
  assert.equal(diagnostics.networkFailures[0].kind,'transport');
  assert.equal(diagnostics.networkFailures[1].status,503);
  const row={...diagnostics.context(),text:'ac'};
  diagnostics.enrich({location:()=>({url,lineNumber:4,columnNumber:5}),args:()=>[
    {evaluate:fn=>fn({name:'HttpErrorResponse',status:503,statusText:'Unavailable',url,
      error:{type:'error',body:'secret'},headers:{Authorization:'secret'},message:'secret'})},
    {evaluate:fn=>fn('ac')},
  ]},row);
  actions.push({label:'Next screen'});await diagnostics.settle();
  assert.equal(row.lastAction,'Clear controlled term');
  assert.deepEqual(row.errorObjects,[{name:'HttpErrorResponse',statusText:'Unavailable',status:503,errorType:'error',url:'https://resource.example.orgx/search'}]);
  assert(!JSON.stringify({row,network:diagnostics.networkFailures}).includes('secret'));
  assert.equal(diagnosticUrl('not a URL'),null);
});

test('diagnostics keep the console event when its document disappears before reading the error object',async()=>{
  const diagnostics=browserDiagnostics({url:()=> 'about:blank',on:()=>{}},[]),row={text:'ac'};
  diagnostics.enrich({location:()=>({}),args:()=>[{evaluate:async()=>{throw new Error('Execution context was destroyed');}}]},row);
  await diagnostics.settle();assert.deepEqual(row.errorObjects,[{unavailable:true}]);
});
