import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectApps,evidencePath,verifyFiles,main,collectorIdentity} from './run.mjs';
import {APPS,requiredStates,coverageFor,catalogSha256} from './catalog.mjs';
import {hash,acceptanceBlockers} from './contract.mjs';
test('selectors use the maintained application catalogs and default to Designer',()=>{
  assert.deepEqual(selectApps(),['designer']);assert.deepEqual(selectApps('all'),APPS);
  assert.throws(()=>selectApps('typo'),/Unknown/);
  for(const app of APPS){const ids=requiredStates(app);assert.equal(new Set(ids).size,ids.length);}
});
test('missing required capture states remain blockers even when a collector forgets to flag them',()=>{
  for(const app of APPS){
    const c={app,catalogSha256:catalogSha256(app),states:[],incomplete:[],provenance:{current:true},cleanupErrors:[],runtimeErrors:[],servedVerified:true};
    assert.equal(acceptanceBlockers(c,[]).length,requiredStates(app).length);
    assert(coverageFor(c).scenarios.every(s=>s.capture==='omitted'&&s.inspected===null));
    c.incomplete.push({state:requiredStates(app)[0],error:'Timeout'});
    assert.equal(coverageFor(c).scenarios[0].capture,'blocked');
  }
});
test('evidence paths cannot escape their packet and changed or symlinked evidence fails',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ui-review-'));
  try {
    for(const file of ['../secret','/secret','a/../../secret','a\\secret'])assert.throws(()=>evidencePath(root,file),/Unsafe/);
    await writeFile(join(root,'state.png'),'old');assert.deepEqual(await verifyFiles(root,{'state.png':hash('old')}),[]);
    await writeFile(join(root,'state.png'),'new');assert.match((await verifyFiles(root,{'state.png':hash('old')}))[0],/changed/);
    await symlink(join(root,'state.png'),join(root,'link.png'));assert.match((await verifyFiles(root,{'link.png':hash('new')}))[0],/regular/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('all-mode records independent failures for every application instead of silently skipping later ones',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ui-review-'));
  try {
    assert.equal(await main(['--app=all','--output='+root,'--review='+root]),2);
    const summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
    assert.deepEqual(summary.results.map(r=>r.app),APPS);assert(summary.results.every(r=>r.code===2));
    const coverage=JSON.parse(await readFile(join(root,'coverage.json'),'utf8'));assert.equal(coverage.applications.length,3);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('a captured state without its hashed screenshot cannot count as complete evidence',()=>{
  const app='workspace';
  const c={app,catalogSha256:catalogSha256(app),states:requiredStates(app).map(id=>({id,screenshot:id+'.png',aria:id+'.yml',metrics:id+'.json'})),files:{},incomplete:[],provenance:{current:true},cleanupErrors:[],runtimeErrors:[],servedVerified:true};
  for(const state of c.states)for(const key of ['screenshot','aria','metrics'])c.files[state[key]]='digest';
  assert.deepEqual(acceptanceBlockers(c,[]),[]);
  delete c.files[c.states[0].screenshot];
  assert(acceptanceBlockers(c,[]).some(e=>e.includes('Missing screenshot')));
  c.states.push(c.states[0]);assert(acceptanceBlockers(c,[]).includes('Duplicate captured state IDs'));
});
test('a capture validates only against the catalog it was collected with',()=>{
  const app='metadata-editor';
  const c={app,catalogSha256:catalogSha256(app),states:requiredStates(app).map(id=>({id,screenshot:id+'.png',aria:id+'.yml',metrics:id+'.json'})),files:{},incomplete:[],provenance:{current:true},cleanupErrors:[],runtimeErrors:[],servedVerified:true};
  for(const state of c.states)for(const key of ['screenshot','aria','metrics'])c.files[state[key]]='digest';
  assert.deepEqual(acceptanceBlockers(c,[]),[]);
  for(const recorded of [catalogSha256('workspace'),undefined]){
    c.catalogSha256=recorded;
    assert(acceptanceBlockers(c,[]).some(e=>e.includes('different scenario catalog')));
  }
  assert.notEqual(catalogSha256('designer'),catalogSha256('workspace'));
});
test('collector identity covers imported helpers and the Playwright release, not tests',async()=>{
  const {sources,playwright}=await collectorIdentity();
  for(const key of ['ui-review/run.mjs','ui-review/calibration.mjs','rest/lib.mjs','auth-activity.mjs','journey-fixtures.mjs'])assert(key in sources,key);
  assert(!Object.keys(sources).some(key=>/test\.mjs$/.test(key)));
  assert.match(playwright,/^\d+\.\d+\.\d+/);
});
