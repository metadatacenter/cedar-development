import {readFile,writeFile,readdir,mkdir,lstat} from 'node:fs/promises';
import {join,resolve,isAbsolute,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hash,validateReview,verdict,acceptanceBlockers,automaticFindings} from './contract.mjs';
import {summarizeChecks} from './automatic-checks.mjs';
import {APPS,PROFILES,profile as browserProfile,requiredStates,scenarios,regions,coverageFor,unmatchedRegions,catalogSha256} from './catalog.mjs';
import {reportHtml} from './report.mjs';
import {finishCapture} from './capture-finalization.mjs';

// The checkout each application's installed components are verified in.
const FRONTEND_DIRECTORIES={designer:'cedar-template-designer','field-designer':'cedar-template-designer',workspace:'cedar-workspace','metadata-editor':'cedar-workspace',
  openview:'cedar-openview/cedar-openview-src'};
export function selectApps(app='designer') {
  if(app==='all')return [...APPS];
  if(!APPS.includes(app))throw new Error('Unknown UI review application: '+app);
  return [app];
}
export function evidencePath(directory,file) {
  if(typeof file!=='string'||isAbsolute(file)||file.includes('\\')||file.split('/').some(p=>p==='..'||p==='.'||!p))throw new Error('Unsafe evidence path: '+file);
  return join(directory,file);
}
export async function verifyFiles(directory,files) {
  const errors=[];
  for(const [file,digest] of Object.entries(files??{}))try {
    const path=evidencePath(directory,file);
    // Capture evidence is flat. Disallow directories/symlinks that could escape the packet.
    if(file.includes('/')||!(await lstat(path)).isFile())throw new Error('Evidence must be a regular capture file');
    if(hash(await readFile(path))!==digest)errors.push('Evidence changed after capture: '+file);
  }catch(error){errors.push('Evidence unavailable: '+file+' ('+error.message+')');}
  return errors;
}
async function writeJson(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n');}
async function validate(directory,app,reviewPath) {
  const raw=await readFile(join(directory,'capture.json'),'utf8');
  const capture={...JSON.parse(raw),captureSha256:hash(raw)};
  const review=JSON.parse(await readFile(reviewPath,'utf8'));
  const errors=validateReview(capture,review,new Set(Object.keys(capture.files??{})));
  if((capture.app??'designer')!==app)errors.push('Capture belongs to a different application');
  errors.push(...await verifyFiles(directory,capture.files));
  let calibration;
  try {
    const {scoreCalibration,verifyReviewSeal}=await import('./calibration.mjs');
    await verifyReviewSeal(directory,reviewPath);
    calibration=await scoreCalibration(join(directory,'calibration'),join(directory,'calibration-review.json'));
    if(calibration.detected!==calibration.defects||calibration.falseAlarms)errors.push('Reviewer did not distinguish all concealed calibration defects from acceptable controls');
  }catch(error){errors.push('Calibration incomplete: '+error.message);}
  const result={app,verdict:verdict(capture,review,errors),validationErrors:errors,acceptanceBlockers:acceptanceBlockers(capture,errors),automaticFindings:automaticFindings(capture),
    captureSha256:capture.captureSha256,calibration,review,scope:'Independent review of the recorded scenarios; not exhaustive UX or release certification.'};
  await writeJson(join(directory,'review-result.json'),result);
  await writeJson(join(directory,'coverage.json'),coverageFor(capture,review));
  await writeFile(join(directory,'review-result.html'),reportHtml(capture,result));
  console.log(`${app}: ${result.verdict}; ${join(directory,'review-result.html')}`);
  return result.verdict==='INCOMPLETE'?2:result.verdict==='REVIEWED'?0:1;
}
export async function collectorFor(app) {
  if(app==='designer')return (await import('./designer.mjs')).collectDesigner;
  if(app==='field-designer')return (await import('./field-designer.mjs')).collectFieldDesigner;
  if(app==='workspace')return (await import('./workspace.mjs')).collectWorkspace;
  if(app==='metadata-editor')return (await import('./metadata-editor.mjs')).collectMetadataEditor;
  if(app==='openview')return (await import('./openview.mjs')).collectOpenView;
  throw new Error('Unknown UI review application: '+app);
}
// Every review module and every local module it imports, directly or transitively, keyed by its
// path under ops/e2e, plus the Playwright release that drives the browser.
const e2eRoot=fileURLToPath(new URL('..',import.meta.url));
const localImport=/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
export async function collectorIdentity(){
  const codeDir=fileURLToPath(new URL('.',import.meta.url));
  const pending=(await readdir(codeDir)).filter(f=>f.endsWith('.mjs')&&!/\.(browser-)?test\.mjs$/.test(f)).map(f=>join(codeDir,f));
  const sources={};
  while(pending.length){
    const path=pending.pop(),key=relative(e2eRoot,path);
    if(key in sources)continue;
    const text=await readFile(path,'utf8');
    sources[key]=hash(text);
    for(const [,specifier] of text.matchAll(localImport))pending.push(resolve(dirname(path),specifier));
  }
  const ordered=Object.fromEntries(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b)));
  const playwright=JSON.parse(await readFile(join(e2eRoot,'node_modules/playwright/package.json'),'utf8')).version;
  // The corpus templates the fixtures upload shape the evidence as much as the code does.
  const fixtureData={};
  if(process.env.CEDAR_HOME){
    const {CORPUS_TEMPLATES,corpusPath}=await import('./fixtures.mjs');
    for(const number of Object.values(CORPUS_TEMPLATES))fixtureData[relative(process.env.CEDAR_HOME,corpusPath(number))]=hash(await readFile(corpusPath(number)));
  }
  return {sources:ordered,playwright,fixtureData};
}
async function collect(directory,app,profile='chromium') {
  const collectorBefore=await collectorIdentity();
  const started=Date.now(),provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  let session,served=null,servedVerified=false;
  const incomplete=[];
  const record=async(id,operation,note='')=>{
    try{if(operation)await session.action(id,operation);await session.capture(id,note);}
    catch(error){incomplete.push({state:id,error:error.message});console.error(`INCOMPLETE ${app}/${id}: ${error.message.split('\n')[0]}`);await session.capture(id+'-unreached','Requested interaction did not complete.').catch(()=>{});throw error;}
  };
  record.failure=(state,error)=>{incomplete.push({state,error:error.message});console.error(`INCOMPLETE ${app}/${state}: ${error.message.split('\n')[0]}`);};
  try {
    session=['designer','field-designer'].includes(app)?await (await import('./session.mjs')).openSession(directory,{profile,app})
      :await (await import('./browser-session.mjs')).openBrowserSession(directory,app,{profile});
    // The packet names its profile, so the browser that actually ran must be that profile's engine.
    if(session.engine!==browserProfile(profile).engine)throw new Error(`Capture ran ${session.engine}, not the ${profile} profile's ${browserProfile(profile).engine}`);
    served=await session.servedEvidence();
    execFileSync(process.env.CEDAR_HOME+'/cedar-cli/.venv/bin/python',
      [process.env.CEDAR_HOME+'/cedar-development/ops/frontend_reactor_runtime.py','verify',process.env.CEDAR_HOME,
       join(process.env.CEDAR_HOME,FRONTEND_DIRECTORIES[app])],{stdio:'pipe'});
    servedVerified=true;
    await (await collectorFor(app))(session,record);
  }catch(error){incomplete.push({state:'session',error:error.message});console.error(`${app}: ${error.message}`);}
  finally {
    if(session){
      try{const end=await session.servedEvidence();if(JSON.stringify(end.verified)!==JSON.stringify(served?.verified))throw new Error('Served assets changed during capture');}
      catch(error){incomplete.push({state:'runtime',error:error.message});}
      await session.close();
    }
  }
  const states=session?.states??[];
  for(const id of requiredStates(app,profile))if(!states.some(s=>s.id===id)&&!incomplete.some(s=>s.state===id))incomplete.push({state:id,error:'Not reached'});
  if(states.length)for(const selector of unmatchedRegions(app,states))incomplete.push({state:'evidence',error:'Region selector matched no element in any state: '+selector});
  try {
    const fresh=JSON.parse(execFileSync(process.env.CEDAR_HOME+'/cedar-cli/.venv/bin/python',['-c',
      'import json,sys; from org.metadatacenter.ui_review import runtime_evidence; print(json.dumps(runtime_evidence(sys.argv[1])))',process.env.CEDAR_HOME],
      {cwd:join(process.env.CEDAR_HOME,'cedar-cli'),encoding:'utf8'}));
    provenance.staleAfterCapture=fresh.stale;
    provenance.current=provenance.current&&fresh.current&&fresh.build===provenance.build;
    if(fresh.build!==provenance.build)incomplete.push({state:'runtime',error:'Selected build changed during capture'});
  }catch(error){provenance.current=false;incomplete.push({state:'freshness',error:error.message});}
  const collectorSources=await collectorIdentity();
  if(JSON.stringify(collectorSources)!==JSON.stringify(collectorBefore))incomplete.push({state:'collector',error:'Review tooling changed during capture; rerun with stable tooling'});
  await writeJson(join(directory,'collector.json'),{catalogSha256:catalogSha256(app,profile),...collectorSources,scenarios:scenarios(app,profile),regions:regions(app)});
  const files={};
  for(const file of (await readdir(directory)).filter(f=>/\.(png|json|yml)$/.test(f)))files[file]=hash(await readFile(join(directory,file)));
  const automaticChecks=await summarizeChecks(directory,app,states);
  const result={schemaVersion:1,app,profile,engine:session?.engine??null,catalogSha256:catalogSha256(app,profile),provenance,served,servedVerified,states,automaticChecks,incomplete,cleanupErrors:session?.cleanupErrors??[],runtimeErrors:session?.runtimeErrors??[],files,durationSeconds:Math.round((Date.now()-started)/1000)};
  // Written after the capture's file list, so neither enters the evidence a reviewer is given.
  if(session){
    await writeJson(join(directory,'component-census.json'),{schemaVersion:1,app,profile,states:session.census??{}});
    const code=session.codeCoverage?.();
    if(code)await writeJson(join(directory,'code-coverage.json'),{schemaVersion:1,app,profile,engine:session.engine,...code});
  }
  const {captureCalibration}=await import('./calibration.mjs');
  await finishCapture(directory,result,captureCalibration);
  const open=automaticFindings(result),excepted=automaticChecks.groups.length-open.length;
  console.log(`${app}: captured ${requiredStates(app,profile).filter(id=>states.some(s=>s.id===id)).length}/${requiredStates(app,profile).length} states in ${result.durationSeconds}s; automatic checks: ${open.length} findings${excepted?` (${excepted} excepted)`:''}; awaiting independent review. ${directory}`);
  return acceptanceBlockers(result,[]).length?2:0;
}
export async function main(args=process.argv.slice(2)) {
  const option=key=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3);
  const app=option('app')??'designer',apps=selectApps(app),profile=option('profile')??'chromium';
  browserProfile(profile);
  const modes=[args.includes('--plan'),args.includes('--capture'),args.includes('--seal-review'),!!option('review')];
  if(modes.filter(Boolean).length!==1)throw new Error('Choose one of --plan, --capture, --seal-review or --review=PATH');
  if(modes[0]){console.log(JSON.stringify({profile,applications:apps.map(app=>({app,scenarios:scenarios(app,profile)})),profiles:Object.keys(PROFILES),workflow:'capture → fresh independent review → seal → concealed calibration → validate',scope:'Local temporary fixtures; no product edits. Coverage omissions cannot pass.'},null,2));return 0;}
  if(!option('output'))throw new Error('--output is required');
  const output=resolve(option('output')),results=[];
  for(const selected of apps){
    const directory=app==='all'?join(output,selected):output;
    try {
      if(modes[1]){
        if(app==='all'){await mkdir(directory);await writeFile(join(directory,'provenance.json'),await readFile(join(output,'provenance.json')));}
        const existing=await readdir(directory);if(existing.some(f=>f!=='provenance.json'))throw new Error('Refusing to overwrite existing capture evidence');
        results.push({app:selected,code:await collect(directory,selected,profile)});
      }else if(modes[2]){
        const {sealReview}=await import('./calibration.mjs');console.log(JSON.stringify(await sealReview(directory)));results.push({app:selected,code:0});
      }else results.push({app:selected,code:await validate(directory,selected,app==='all'?join(resolve(option('review')),selected,'review.json'):resolve(option('review')))});
    }catch(error){results.push({app:selected,code:2,error:error.message});console.error(selected+': '+error.message);}
  }
  if(app==='all'){
    const coverage=[];
    for(const result of results)try{coverage.push(JSON.parse(await readFile(join(output,result.app,'coverage.json'),'utf8')));}catch{coverage.push({app:result.app,error:result.error??'No coverage evidence'});}
    await writeJson(join(output,'coverage.json'),{applications:coverage});
    await writeJson(join(output,'summary.json'),{operation:modes[1]?'capture':modes[2]?'seal':'validate',results});
    await writeFile(join(output,'index.html'),'<!doctype html><meta charset="utf-8"><h1>CEDAR independent UI review</h1><p>Capture completion does not establish a UI review pass.</p><ul>'+results.map(r=>`<li><a href="${r.app}/${modes[3]?'review-result':'index'}.html">${r.app}</a>: ${r.code===2?'INCOMPLETE':modes[1]?'awaiting independent review':modes[2]?'sealed':r.code===0?'REVIEWED':'findings or design review'}</li>`).join('')+'</ul><a href="coverage.json">Scenario coverage</a>');
  }
  return Math.max(...results.map(r=>r.code));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
