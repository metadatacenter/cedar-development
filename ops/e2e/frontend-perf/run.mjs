import {mkdir, writeFile, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {cpus, platform, arch, release, loadavg, totalmem} from 'node:os';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {profiles, instrumentation, pageMetrics, summarize, htmlReport} from './metrics.mjs';
import {modernLoadingFailures, modernHostResolverRules} from './loading.mjs';
import {prepare, serve, inventory} from './lab.mjs';
import {preparePackaged} from './packaged.mjs';
import {standaloneFixtures, fixtures, scenarios, authenticate, scenarioFamily} from './scenarios.mjs';

const {values} = parseArgs({options:{samples:{type:'string',default:'5'}, profiles:{type:'string',default:'normal,constrained'},
  'deployment-manifest':{type:'string'}, scenarios:{type:'string'}, output:{type:'string'}, plan:{type:'boolean'}, check:{type:'boolean'}}});
const repetitions = Number(values.samples), selectedProfiles = values.profiles.split(',');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30) throw new Error('samples must be 1–30');
if (selectedProfiles.some(name => !Object.hasOwn(profiles,name))) throw new Error('profiles must be normal and/or constrained');
const home = process.env.CEDAR_HOME;
if (!home) throw new Error('Use cedarcli test frontend-performance (CEDAR_HOME is required)');
const domain = process.env.CEDAR_HOST ?? 'metadatacenter.orgx';
if (domain !== 'metadatacenter.orgx') throw new Error('This lab deliberately targets the local .orgx test stack only');
const choose = entries => {
  if (!values.scenarios) return entries;
  const names = values.scenarios.split(',');
  for (const name of names) if (!entries.some(e => e.id === name)) throw new Error('Unknown scenario: '+name);
  return entries.filter(e => names.includes(e.id));
};
const planned = choose(scenarios(domain,{small:'fixture-small',large:'fixture-large'}));
if (values.plan) {
  console.log(JSON.stringify({repetitions,profiles,selectedProfiles,cache:['cold','warm'],
    scenarios:planned.map(({id,readiness,actionName}) => ({id,readiness,action:actionName ?? null})),
    reportingOnly:true, legacy:false},null,2));
} else if (values.check) {
  const tests = (await readdir(new URL('.',import.meta.url))).filter(name => name.endsWith('.test.mjs')).sort();
  execFileSync(process.execPath,['--test',...tests.map(name => new URL(name,import.meta.url).pathname)],{stdio:'inherit'});
} else {
  const directory = resolve(values.output ?? join(home,'.cedar/reports/frontend-performance',new Date().toISOString().replace(/[:.]/g,'-')));
  await mkdir(directory,{recursive:true});
  if ((await readdir(directory)).length) throw new Error('Output directory must be empty; preserve earlier measurements');
  let browser, lab, data, interrupted = false;
  const preparation = new AbortController();
  const report = {schemaVersion:1,startedAt:new Date().toISOString(),reportingOnly:true,samples:[],metadata:{
    repetitions,profiles:Object.fromEntries(selectedProfiles.map(name => [name,profiles[name]])), viewport:{width:1440,height:1000},
    machine:{platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),loadAtStart:loadavg()},
    limits:['Local production-build lab, not production deployment latency or real-user Web Vitals.',
      'CPU slowdown is relative to this machine; it is not a calibrated device model.',
      'HTTP/1.1 HTTPS static files use gzip and one-hour cache; HTML is no-store. Real local APIs and SSO remain on nginx; production HTTP/2 or HTTP/3 behavior can differ.',
      'Fresh browser context per repetition; cold clears HTTP cache. Warm follows an about:blank navigation in the same tab. Actions run only after the warm load, avoiding retained drafts between load samples.',
      'Sign-in setup is excluded; any subsequent silent SSO/navigation redirects are included in readiness and CDP network totals.',
      'Paint/TTFB/CLS/long tasks describe the final top-level document, sampled one second after ready and fonts. Readiness includes navigation redirects.',
      'Network totals use CDP encodedDataLength (HTTP transfer, not TCP/TLS wire bytes); incomplete requests at the cutoff are not counted as completed bytes.',
      'Actions measure automation gesture through verified completion and two frames; they are not INP. No timing threshold fails a run.',
      'Fixed 5/100 text-field fixtures isolate rendering scale; no production content, DOI submission, save latency or external terminology benchmark.'],
  }};
  const persist = async () => {
    report.summary = summarize(report.samples);
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
    await writeFile(join(directory,'report.html'),htmlReport(report));
    const columns = ['scenario','profile','cache','repeat','status','readyMs','lcpMs','cls','blockingOver50Ms','transferBytes','requests','cachedRequests','actionMs'];
    const csv = [columns.join(','), ...report.samples.map(s => columns.map(k => JSON.stringify(s[k] ?? s.metrics?.[k] ?? '')).join(','))].join('\n');
    await writeFile(join(directory,'samples.csv'),csv+'\n');
  };
  const stop = () => {interrupted = true; preparation.abort(); void browser?.close().catch(()=>{});};
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
  try {
    const prepared = values['deployment-manifest']
      ? await preparePackaged(resolve(values['deployment-manifest']),join(directory,'lab'),domain,{signal:preparation.signal})
      : await prepare(home,join(directory,'lab'),domain,{signal:preparation.signal});
    preparation.signal.throwIfAborted();
    await standaloneFixtures(prepared.componentRoot,domain,prepared.integratedScript);
    prepared.evidence.outputs.standalone = await inventory(prepared.componentRoot);
    prepared.evidence.suite = await inventory(new URL('.',import.meta.url).pathname);
    await writeFile(join(directory,'lab/artifacts.json'),JSON.stringify(prepared.evidence,null,2)+'\n');
    report.metadata.artifacts = 'lab/artifacts.json';
    report.metadata.reactor = prepared.evidence.reactor;
    report.metadata.deployment = prepared.evidence.deployment;
    if (prepared.evidence.deployment) report.metadata.limits[0] = 'Published immutable train assets in an isolated Docker-backed CI lab; not production deployment latency or real-user Web Vitals.';
    if (prepared.evidence.deployment?.mode === 'direct') {
      report.metadata.limits[0] = 'Fresh-stack acceptance of the real Docker-served modern pages and immutable standalone components; timing is reporting-only.';
      report.metadata.limits[2] = 'Application pages and APIs use the deployment nginx. Only standalone component fixtures use the private HTTPS lab.';
    }
    report.metadata.sources = prepared.evidence.sources;
    report.metadata.adjustments = prepared.evidence.adjustments;
    report.metadata.suite = {revision:execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('.',import.meta.url),encoding:'utf8'}).trim(),
      sha256:prepared.evidence.suite.sha256};
    lab = await serve(prepared.roots,join(directory,'lab'));
    preparation.signal.throwIfAborted();
    data = await fixtures(directory);
    preparation.signal.throwIfAborted();
    let cases = choose(scenarios(domain,data.ids,data.folderId));
    report.metadata.scenarios = cases.map(({id,readiness,actionName}) => ({id,readiness,action:actionName ?? null}));
    browser = await chromium.launch({headless:true,handleSIGINT:false,handleSIGTERM:false,
      args:['--host-resolver-rules='+modernHostResolverRules(lab.rules),'--no-proxy-server']});
    report.metadata.browser = browser.version();
    report.metadata.node = process.version;
    const sessions = await authenticate(browser,cases,directory);
    report.setupFailures = sessions.failures;
    // A broken page must not prevent reports for independent pages. A small-fixture setup
    // failure also excludes its large counterpart, which uses the same authentication path.
    cases = cases.filter(s => !sessions.failures.some(f => scenarioFamily(s.id) === scenarioFamily(f.scenario)));
    for (let repeat=1;repeat<=repetitions && !interrupted;repeat++) {
      // Rotate scenario/profile order across repetitions; never run measured pages concurrently.
      const ordered = [...cases.slice((repeat-1)%cases.length),...cases.slice(0,(repeat-1)%cases.length)];
      for (const scenario of ordered) {
        for (const profile of repeat % 2 ? selectedProfiles : [...selectedProfiles].reverse()) {
          if (interrupted) break;
          const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:report.metadata.viewport,
            storageState:scenario.auth ? sessions.byScenario[scenario.id] ?? sessions.default : undefined, serviceWorkers:'block'});
          context.setDefaultTimeout(90000);
          try {
            const page = await context.newPage();
            page.on('dialog', dialog => dialog.accept());
            const meter = await instrumentation(context,page,profiles[profile]);
            await meter.cold();
            for (const cache of ['cold','warm']) {
              if (interrupted) break;
              await page.goto('about:blank');
              const errors = [], onError = error => errors.push(error.message);
              page.on('pageerror',onError);
              const sample = {scenario:scenario.id,profile,cache,repeat,status:'failed',loadBefore:loadavg()};
              console.log(`Measuring ${repeat}/${repetitions} ${scenario.id} ${profile}/${cache}`);
              try {
                meter.start();
                const begun = performance.now();
                await page.goto(scenario.url,{waitUntil:'domcontentloaded',timeout:90000});
                await scenario.ready(page); await scenario.settled?.(page);
                await page.evaluate(async () => {await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));});
                const readyMs = performance.now()-begun;
                await page.waitForTimeout(1000);
                const snapshot = await page.evaluate(() => window.__cedarPerf.snapshot());
                sample.metrics = pageMetrics(snapshot,readyMs,meter.snapshot()); meter.stop();
                errors.push(...modernLoadingFailures(sample.metrics,scenario.id,domain));
                sample.diagnostics = {layoutShifts:snapshot.entries['layout-shift'],longTasks:snapshot.entries.longtask,
                  largestContentfulPaint:snapshot.entries['largest-contentful-paint']};
                if (scenario.action && cache === 'warm') {
                  const start = performance.now();
                  await scenario.action(page);
                  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
                  sample.metrics.actionMs = performance.now()-start;
                  const events = await page.evaluate(() => window.__cedarPerf.snapshot().entries.event);
                  sample.metrics.maxObservedEventMs = events.length ? Math.max(...events.map(e => e.duration)) : null;
                }
                if (errors.length) throw new Error('Uncaught browser error: '+errors.join('; '));
                sample.status = 'ok';
                if (repeat === 1 && cache === 'cold' && profile === selectedProfiles[0])
                  await page.screenshot({path:join(directory,`${scenario.id}.png`)});
              } catch(error) {
                sample.error = error.message;
                await page.screenshot({path:join(directory,`${scenario.id}-${profile}-${cache}-${repeat}-failure.png`)}).catch(()=>{});
              } finally {meter.stop(); page.off('pageerror',onError);}
              report.samples.push(sample); await persist();
              console.log(`${repeat}/${repetitions} ${scenario.id} ${profile}/${cache}: ${sample.status === 'ok' ? Math.round(sample.metrics.readyMs)+' ms ready' : sample.error.split('\n')[0]}`);
            }
          } finally {await context.close();}
        }
        if (interrupted) break;
      }
    }
  } catch(error) {report.setupError = error.message; report.cleanupErrors = error.cleanupErrors ?? []; console.error(error.stack);}
  finally {
    await browser?.close().catch(()=>{});
    if (lab) await new Promise(resolve => lab.server.close(resolve));
    try {report.cleanupErrors = data ? await data.cleanup() : (report.cleanupErrors ?? []);}
    catch(error) {report.cleanupErrors = [error.message];}
    report.interrupted = interrupted;
    report.finishedAt = new Date().toISOString(); report.metadata.machine.loadAtEnd = loadavg();
    report.complete = !report.setupError && !interrupted && !report.cleanupErrors.length &&
      report.samples.length === planned.length*selectedProfiles.length*2*repetitions && report.samples.every(s => s.status === 'ok');
    await persist();
    console.log(`Report: ${join(directory,'report.html')}`);
    process.exitCode = report.complete ? 0 : 1;
    process.off('SIGINT',stop); process.off('SIGTERM',stop);
  }
}
