// Production bundle comparison. No builds, backend calls, credentials or checkout mutations.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {parseArgs} from 'node:util';
import {cpus, platform, arch, loadavg} from 'node:os';
import {chromium} from 'playwright';
import {serve, hash, inventory} from './lab.mjs';
import {prepareDesigner, designerApi, designerIds} from './designer-fixture.mjs';
import {standaloneFixtures, scenarios} from './scenarios.mjs';
import {profiles, instrumentation, pageMetrics} from './metrics.mjs';
import {assessPairs, loadingFailures, markdownReport, tolerances} from './paired.mjs';

const {values} = parseArgs({options:{component:{type:'string'}, baseline:{type:'string'}, candidate:{type:'string'},
  output:{type:'string'}, samples:{type:'string',default:'5'}, 'baseline-revision':{type:'string'},
  'candidate-revision':{type:'string'}, plan:{type:'boolean'}}});
const repetitions = Number(values.samples);
if (!['cee','ced','designer'].includes(values.component)) throw new Error('component must be cee, ced or designer');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30) throw new Error('samples must be 1–30');
const domain = 'cedar-perf.invalid', origin = `https://performance.${domain}`;
const isDesigner=values.component==='designer';
const cases = scenarios(domain,designerIds).filter(s => isDesigner
  ? s.id.startsWith('designer-') || s.id.startsWith('ced-integrated-')
  : s.id.startsWith(values.component+'-standalone-'));
const origins=isDesigner?[origin,`https://designer.${domain}`,`https://resource.${domain}`]:[origin];
if (values.plan) {
  console.log(JSON.stringify({scenarios:cases.map(s => s.id), repetitions, profile:profiles.constrained,
    cache:['cold','warm'], backend:false, timing:'advisory', loading:'required'},null,2));
} else {
  if (!values.baseline || !values.candidate || !values.output) throw new Error('baseline, candidate and output are required');
  const directory = resolve(values.output);
  await mkdir(directory,{recursive:false}); // Never replace an existing report.
  const report = {schemaVersion:1,startedAt:new Date().toISOString(),complete:false,samples:[],artifacts:{},
    metadata:{component:values.component,repetitions,profile:profiles.constrained,viewport:{width:1440,height:1000},
      node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,loadAtStart:loadavg(),
      timingMode:'advisory',tolerances,baselineRevision:values['baseline-revision'],candidateRevision:values['candidate-revision']}};
  let lab, browser, interrupted = false;
  const stop = () => {interrupted = true; void browser?.close().catch(()=>{});};
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
  const persist = async () => {
    report.comparison = assessPairs(report.samples,cases.map(s => s.id),repetitions);
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
    await writeFile(join(directory,'summary.md'),markdownReport(report));
  };
  try {
    const roots = {}, variants = {};
    for (const version of ['baseline','candidate']) {
      const root = join(directory,version);
      await mkdir(root);
      if(isDesigner) {
        const prepared=await prepareDesigner(resolve(values[version]),root,domain);
        variants[version]=prepared.roots; report.artifacts[version]=prepared.evidence;
      } else {
        const bytes = await readFile(resolve(values[version]));
        if (!bytes.length) throw new Error('Empty '+version+' bundle');
        await writeFile(join(root,values.component+'.js'),bytes);
        await standaloneFixtures(root,domain,undefined,[values.component]);
        variants[version] = {[new URL(origin).hostname]:root};
        report.artifacts[version] = {sha256:hash(bytes),bytes:bytes.length,inventory:await inventory(root)};
      }
    }
    report.metadata.suite = await inventory(new URL('.',import.meta.url).pathname);
    Object.assign(roots,variants.baseline);
    lab = await serve(roots,directory,isDesigner?designerApi(domain):undefined);
    // Unknown hostnames fail DNS; request routing is deliberately avoided so caching stays real.
    browser = await chromium.launch({headless:true,handleSIGINT:false,handleSIGTERM:false,
      args:['--host-resolver-rules='+lab.rules+', MAP * ~NOTFOUND','--no-proxy-server','--disable-background-networking']});
    report.metadata.browser = browser.version();
    for (let repeat=1; repeat<=repetitions && !interrupted; repeat++) {
      const ordered = repeat%2 ? cases : [...cases].reverse();
      for (const scenario of ordered) for (const version of repeat%2 ? ['baseline','candidate'] : ['candidate','baseline']) {
        if (interrupted) break;
        Object.assign(roots,variants[version]);
        const context = await browser.newContext({ignoreHTTPSErrors:true,viewport:report.metadata.viewport,serviceWorkers:'block'});
        context.setDefaultTimeout(30000);
        try {
          const page = await context.newPage();
          const meter = await instrumentation(context,page,profiles.constrained);
          await meter.cold();
          for (const cache of ['cold','warm']) {
            if (interrupted) break;
            const sample = {scenario:scenario.id,version,repeat,cache,profile:'constrained',status:'failed',loadBefore:loadavg()};
            const errors = [], onError = e => errors.push(e.message);
            page.on('pageerror',onError);
            try {
              await page.goto('about:blank');
              meter.start();
              const start = performance.now();
              await page.goto(scenario.url,{waitUntil:'domcontentloaded',timeout:30000});
              await scenario.ready(page); await scenario.settled?.(page);
              await page.evaluate(async () => {await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));});
              const readyMs = performance.now()-start;
              await page.waitForTimeout(1000);
              const snapshot = await page.evaluate(() => window.__cedarPerf.snapshot());
              const network = meter.snapshot();
              sample.metrics = pageMetrics(snapshot,readyMs,network);
              errors.push(...loadingFailures(network,origins,isDesigner?[/\/cedar-rdf-/,/\/cedar-schema-validation\.mjs$/]:[]));
              meter.stop();
              if(scenario.id.startsWith('designer-') && await page.locator('#check-save:visible, #recheck-access:visible, #sign-in-again:visible, #reload:visible, #draft-offer:visible, #draft-storage-error:visible, #server-issues:visible').count())
                throw new Error('Unexpected recovery UI on a normal Designer load');
              if (cache === 'warm') {
                const begun = performance.now();
                await scenario.action(page);
                sample.metrics.actionMs = performance.now()-begun;
              }
              if (errors.length) throw new Error(errors.join('; '));
              sample.status = 'ok';
              if (repeat === 1 && cache === 'cold') await page.screenshot({path:join(directory,`${version}-${scenario.id}.png`)});
            } catch(error) {
              sample.status = 'failed';
              sample.error = error.message;
              await page.screenshot({path:join(directory,`${version}-${scenario.id}-${repeat}-${cache}-failure.png`)}).catch(()=>{});
            } finally {meter.stop(); page.off('pageerror',onError);}
            report.samples.push(sample);
            await persist();
            console.log(`${repeat}/${repetitions} ${version} ${scenario.id}/${cache}: ${sample.status} ${Math.round(sample.metrics?.readyMs ?? 0)} ms`);
          }
        } finally {await context.close();}
      }
    }
  } catch(error) {report.setupError = error.stack; console.error(error.stack);}
  finally {
    await browser?.close().catch(()=>{});
    if (lab) await new Promise(r => lab.server.close(r));
    report.interrupted = interrupted;
    report.finishedAt = new Date().toISOString(); report.metadata.loadAtEnd = loadavg();
    report.complete = !report.setupError && !interrupted && report.samples.length === cases.length*repetitions*4 &&
      report.samples.every(s => s.status === 'ok' && ['readyMs','blockingOver50Ms','cls'].every(k => Number.isFinite(s.metrics?.[k])));
    await persist();
    process.exitCode = report.complete ? 0 : 1;
    console.log('Report: '+join(directory,'summary.md'));
    process.off('SIGINT',stop); process.off('SIGTERM',stop);
  }
}
