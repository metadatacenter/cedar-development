import {mkdir,readFile,writeFile,readdir,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {actors,call,enc,mintId,RESOURCE,USER_SERVER,HOST} from '../rest/lib.mjs';
import {withBrowserAuthentication} from '../auth-activity.mjs';
import {fixtureAt} from '../journey-fixtures.mjs';
import {FixtureLedger} from './lifecycle.mjs';
import {captureState} from './evidence.mjs';
import {hash} from './contract.mjs';
import {regions, profile as browserProfile} from './catalog.mjs';

import {requireLocal,readOnlyResourcePost} from './guards.mjs';
export async function openBrowserSession(directory, app, {profile='chromium'}={}) {
  const {engine,context:contextOptions}=browserProfile(profile);
  const base=app==='designer' ? process.env.CEDAR_DESIGNER_BASE||`https://designer.${HOST}` : process.env.CEDAR_WORKSPACE_BASE||`https://workspace.${HOST}`;
  for(const url of [base,RESOURCE,USER_SERVER])requireLocal(url);
  const lock=join(process.env.CEDAR_HOME,'.cedar/locks/ui-review-user1');
  await mkdir(join(process.env.CEDAR_HOME,'.cedar/locks'),{recursive:true});
  try {await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw new Error(`Another UI review owns the test account; inspect ${lock}/owner.json before recovering an abandoned lock`);throw error;}
  await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,app,directory,startedAt:new Date().toISOString()}));
  let browser,ledger,closed;
  const states=[],actions=[],runtimeErrors=[],cleanupErrors=[],consoleMessages=[];
  const expectedNetworkFailures=new Set();
  const startedAt=new Date().toISOString();
  let checkpoint=Promise.resolve();
  const flush=()=>{const content=JSON.stringify({schemaVersion:1,app,startedAt,actions,states,
    originalPreferences:ledger?.preferences,fixtures:ledger?.fixtures??[],cleanup:ledger?.cleanup??[],preferencesRestored:ledger?.preferencesRestored,
    runtimeErrors,cleanupErrors,consoleMessages},null,2)+'\n';
    checkpoint=checkpoint.catch(()=>{}).then(async()=>{await writeFile(join(directory,'session.json.tmp'),content);await rename(join(directory,'session.json.tmp'),join(directory,'session.json'));});
    return checkpoint;
  };
  const action=async(label,fn)=>{const row={label,at:new Date().toISOString()};try{const value=await fn();row.outcome='performed';return value;}catch(e){row.outcome='failed';row.error=e.message;throw e;}finally{actions.push(row);await flush();}};
  async function close(){
    if(closed)return closed;
    closed=(async()=>{
      try{await browser?.close();}catch(e){cleanupErrors.push('Browser close: '+e.message);}
      try{await ledger?.close();}catch(e){cleanupErrors.push('Fixture cleanup: '+e.message);}
      if(ledger)cleanupErrors.push(...ledger.cleanupErrors);
      try {await flush();} finally {process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);await rm(lock,{recursive:true,force:true});}
    })();return closed;
  }
  const interrupt=async code=>{cleanupErrors.push('Collection interrupted');await close();process.exit(code);};
  const onInterrupt=()=>void interrupt(130),onTerminate=()=>void interrupt(143);
  process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
  try {
    const {user1:user}=await actors();
    const request=(...args)=>call(user.auth,...args);
    ledger=new FixtureLedger({request,persist:flush,mint:mintId,userPath:'/users/'+enc(user.profile['@id'].split('/').at(-1)),preferences:user.profile.uiPreferences,userBase:USER_SERVER});
    browser=await {chromium,webkit}[engine].launch({headless:true});
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},...contextOptions});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',e=>runtimeErrors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'){const expected=expectedNetworkFailures.size>0&&/^Failed to load resource: net::ERR_FAILED$/.test(m.text());consoleMessages.push({text:m.text(),expected,reason:expected?[...expectedNetworkFailures]:[]});if(!expected)runtimeErrors.push(m.text());}});
    // Only resource mutations belonging to this run may leave the browser.
    await context.route('**/*',async route=>{
      const req=route.request();
      const address=new URL(req.url());
      const readOnlyValidation=readOnlyResourcePost(req.method(),address.pathname);
      if(address.origin===new URL(RESOURCE).origin&&!['GET','HEAD','OPTIONS'].includes(req.method())&&!readOnlyValidation) {
        const item=fixtureAt(req.url());
        if(app==='designer' && item?.collection==='templates' && req.method()==='PUT' && !ledger.fixtures.some(f=>f.id===item.id) && !req.headers()['if-match'] && String(req.postDataJSON()?.['schema:name']).startsWith('UI review pilot ')) await ledger.register(item.collection,item.id);
        // A record the Metadata Editor creates from a review-owned template belongs to the review.
        if(app==='metadata-editor' && item?.collection==='template-instances' && req.method()==='PUT' && !ledger.fixtures.some(f=>f.id===item.id) && !req.headers()['if-match'] && ledger.fixtures.some(f=>f.collection==='templates'&&f.id===req.postDataJSON()?.['schema:isBasedOn'])) await ledger.register(item.collection,item.id);
        if(!item||!ledger.fixtures.some(f=>f.id===item.id)) {
          runtimeErrors.push('Blocked mutation outside review-owned fixtures: '+req.method()+' '+new URL(req.url()).pathname);
          await flush();await route.abort();return;
        }
      }
      await route.continue();
    });
    async function login(){await withBrowserAuthentication('Independent UI review sign-in',async()=>{
      await page.goto(base+'/dashboard');
      await page.locator('#username, cedar-workspace-page .destinations').first().waitFor({state:'visible'});
      if(await page.locator('#username').isVisible()){
        await page.locator('#username').fill(process.env.CEDAR_FRONTEND_local_USER1_LOGIN||'test1@test.com');
        await page.locator('#password').fill(process.env.CEDAR_FRONTEND_local_USER1_PASSWORD||'test1');
        await page.locator('#kc-login').click();
      }
      await page.getByRole('button',{name:'New',exact:true}).waitFor();
      await page.locator('.table-scroll[aria-busy="false"]').waitFor();
    });}
    const pendingCrops=[];
    const capture=(id,note)=>captureState({page,directory,states,actions,flush,regions:regions(app),pendingCrops,fullPage:false},id,note);
    async function servedEvidence(){
      const root=join(process.env.CEDAR_HOME,'cedar-workspace/app');
      const files=(await readdir(join(root,'workspace-build'),{recursive:true})).filter(f=>/\.(js|css|html)$/.test(f)).map(f=>'workspace-build/'+f);
      files.push('third_party_components/cedar-embeddable-editor/cedar-embeddable-editor.js');
      const verified=[];
      for(let i=0;i<files.length;i+=4)await Promise.all(files.slice(i,i+4).map(async file=>{
        const response=await context.request.get(base+'/'+file);const digest=hash(await response.body());
        if(!response.ok()||digest!==hash(await readFile(join(root,file))))throw new Error('Served asset mismatch: '+file);
        verified.push({file,sha256:digest});
      }));
      return {verified:verified.sort((a,b)=>a.file.localeCompare(b.file)),browser:browser.version()};
    }
    await flush();
    return {page,context,base,user,ledger,browser,directory,pendingCrops,profile,engine:browser.browserType().name(),touch:!!contextOptions.hasTouch,expectedNetworkFailures,put:ledger.put.bind(ledger),request,states,actions,runtimeErrors,cleanupErrors,action,capture,close,login,servedEvidence,flush};
  } catch(error){await close();throw error;}
}
