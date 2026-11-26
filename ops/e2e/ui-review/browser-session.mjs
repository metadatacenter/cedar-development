import {mkdir,readFile,writeFile,readdir,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {actors,call,enc,mintId,RESOURCE,USER_SERVER,HOST,OPENVIEW} from '../rest/lib.mjs';
import {withBrowserAuthentication} from '../auth-activity.mjs';
import {fixtureAt} from '../journey-fixtures.mjs';
import {FixtureLedger} from './lifecycle.mjs';
import {captureState} from './evidence.mjs';
import {renderedComponents, scriptCoverage} from './ui-coverage.mjs';
import {hash} from './contract.mjs';
import {regions, profile as browserProfile} from './catalog.mjs';

import {requireLocal,readOnlyResourcePost} from './guards.mjs';
export async function openBrowserSession(directory, app, {profile='chromium'}={}) {
  const {engine,context:contextOptions,defaultFontSize}=browserProfile(profile);
  const base=app==='designer' ? process.env.CEDAR_DESIGNER_BASE||`https://designer.${HOST}`
    : app==='openview' ? process.env.CEDAR_OPENVIEW_FRONTEND||`https://openview.${HOST}`
    : process.env.CEDAR_WORKSPACE_BASE||`https://workspace.${HOST}`;
  for(const url of [base,RESOURCE,USER_SERVER])requireLocal(url);
  const lock=join(process.env.CEDAR_HOME,'.cedar/locks/ui-review-user1');
  await mkdir(join(process.env.CEDAR_HOME,'.cedar/locks'),{recursive:true});
  try {await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw new Error(`Another UI review owns the test account; inspect ${lock}/owner.json before recovering an abandoned lock`);throw error;}
  await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,app,directory,startedAt:new Date().toISOString()}));
  let browser,ledger,closed,coveragePage=null,codeCoverage=null;
  const census={};
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
      // Chromium alone reports script coverage. It is read before the browser closes.
      if(coveragePage)try{codeCoverage=scriptCoverage(await coveragePage.coverage.stopJSCoverage());}catch(e){cleanupErrors.push('Code coverage: '+e.message);}
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
    // A read as an anonymous visitor of OpenView's server, with no CEDAR credential.
    const anonymousRead=path=>call(null,'GET',path,undefined,{base:OPENVIEW});
    ledger=new FixtureLedger({request,persist:flush,mint:mintId,userPath:'/users/'+enc(user.profile['@id'].split('/').at(-1)),preferences:user.profile.uiPreferences,userBase:USER_SERVER});
    browser=await {chromium,webkit}[engine].launch({headless:true});
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},...contextOptions});
    // A ResizeObserver loop reaches the window's error event in every engine, but Playwright's page
    // error event misses it in Chromium and undercounts it in WebKit. Report it through the console.
    await context.addInitScript(()=>window.addEventListener('error',event=>{
      if(/^ResizeObserver loop/.test(event.message))console.error('Window error: '+event.message);
    }));
    const page=await context.newPage();page.setDefaultTimeout(15000);
    if(engine==='chromium'){await page.coverage.startJSCoverage({resetOnNavigation:false});coveragePage=page;}
    page.on('pageerror',e=>runtimeErrors.push(e.message));
    // OpenView runs under Angular's development server locally, whose live-reload client tries a
    // socket the local proxy does not carry. Those messages come from that client, not from OpenView,
    // and are kept as expected console messages with their reason.
    const devServerNoise=app==='openview'?/^(WebSocket connection to 'wss:\/\/[^']+\/\?token=[^']+' failed|\[vite\] failed to connect to websocket)/:null;
    page.on('console',m=>{if(m.type()==='error'){
      const reason=expectedNetworkFailures.size>0&&/^Failed to load resource: (net::ERR_FAILED|the server responded with a status of \d{3}\b.*)$/.test(m.text())?[...expectedNetworkFailures]
        :devServerNoise?.test(m.text())?['Development server live-reload socket, absent from a deployed OpenView']:[];
      consoleMessages.push({text:m.text(),expected:reason.length>0,reason});if(!reason.length)runtimeErrors.push(m.text());}});
    // Only resource mutations belonging to this run may leave the browser.
    await context.route('**/*',async route=>{
      const req=route.request();
      const address=new URL(req.url());
      const readOnlyValidation=readOnlyResourcePost(req.method(),address.pathname);
      if(address.origin===new URL(RESOURCE).origin&&!['GET','HEAD','OPTIONS'].includes(req.method())&&!readOnlyValidation) {
        // A rename names its resource in its body, by identifier or typed local path, not in its address.
        const renamed=req.method()==='POST'&&address.pathname==='/command/rename-resource'?String(req.postDataJSON()?.['@id']??''):null;
        const item=renamed===null?fixtureAt(req.url()):ledger.fixtures.find(f=>renamed&&(f.id===renamed||f.id.endsWith('/'+renamed)));
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
    // The browser's default text size, the setting a user changes in Chromium's settings.
    async function setDefaultFontSize(px){
      if(!defaultFontSize)throw new Error(`The ${profile} profile cannot change the default text size`);
      const cdp=await context.newCDPSession(page);
      await cdp.send('Page.setFontSizes',{fontSizes:{standard:px,fixed:Math.round(px*13/16)}});
      await cdp.detach();
    }
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
    // Each state's census of the components it renders is kept apart from the state's evidence.
    const capture=async(id,note)=>{await captureState({page,directory,states,actions,flush,regions:regions(app),pendingCrops,fullPage:false},id,note);census[id]=await renderedComponents(page);};
    // OpenView's development server compiles its own bundles in memory, so they can only be
    // fingerprinted; the CEE bundle it serves from node_modules is compared with the installed one.
    async function openviewServedEvidence(){
      const root=join(process.env.CEDAR_HOME,'cedar-openview/cedar-openview-src');
      const verified=[],observed=[];
      const cee='node_modules/cedar-embeddable-editor/cedar-embeddable-editor.host-fonts.js';
      const response=await context.request.get(base+'/'+cee);const digest=hash(await response.body());
      if(!response.ok()||digest!==hash(await readFile(join(root,cee))))throw new Error('Served asset mismatch: '+cee);
      verified.push({file:cee,sha256:digest});
      const html=await (await context.request.get(base+'/templates/ui-review-probe')).text();
      for(const [,file] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)){
        const asset=await context.request.get(new URL(file,base+'/').href);
        observed.push({file,sha256:hash(await asset.body())});
      }
      return {verified:[...verified,...observed.sort((a,b)=>a.file.localeCompare(b.file))],browser:browser.version()};
    }
    async function servedEvidence(){
      if(app==='openview')return openviewServedEvidence();
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
    return {page,context,base,user,ledger,browser,directory,pendingCrops,profile,census,codeCoverage:()=>codeCoverage,engine:browser.browserType().name(),touch:!!contextOptions.hasTouch,expectedNetworkFailures,put:ledger.put.bind(ledger),request,anonymousRead,defaultFontSize:!!defaultFontSize,setDefaultFontSize,states,actions,runtimeErrors,cleanupErrors,action,capture,close,login,servedEvidence,flush};
  } catch(error){await close();throw error;}
}
