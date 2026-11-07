// Lab measurements only. Event Timing samples are diagnostics, never field INP.
export const profiles = {
  normal: {cpu: 1, latency: 0, download: -1, upload: -1},
  constrained: {cpu: 4, latency: 150, download: 1_600_000 / 8, upload: 750_000 / 8},
};

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? {n, median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    min: sorted[0], max: sorted[n - 1]} : {n: 0, median: null, min: null, max: null};
}

export function layoutShiftScore(entries) {
  let score = 0, windowScore = 0, start = -Infinity, previous = -Infinity;
  for (const entry of entries) {
    if (entry.hadRecentInput) continue;
    if (entry.startTime - previous >= 1000 || entry.startTime - start >= 5000) {
      start = entry.startTime;
      windowScore = 0;
    }
    windowScore += entry.value;
    previous = entry.startTime;
    score = Math.max(score, windowScore);
  }
  return score;
}

// Serialized by Playwright: keep this function independent of module bindings.
export function observe() {
  if (window !== window.top || window.__cedarPerf) return;
  const entries = {}, observers = [];
  for (const type of ['paint', 'largest-contentful-paint', 'layout-shift', 'longtask', 'event']) {
    entries[type] = [];
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver(list => entries[type].push(...list.getEntries().map(e => e.toJSON())));
    observer.observe({type, buffered: true, ...(type === 'event' ? {durationThreshold: 16} : {})});
    observers.push([type, observer]);
  }
  window.__cedarPerf = {snapshot() {
    for (const [type, observer] of observers) entries[type].push(...observer.takeRecords().map(e => e.toJSON()));
    return {entries, now: performance.now(), navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
      supported: PerformanceObserver.supportedEntryTypes};
  }};
}

export function pageMetrics(snapshot, readyMs, network) {
  const {entries: e, navigation: nav} = snapshot;
  const tasks = e.longtask ?? [];
  return {readyMs, observationMs: snapshot.now,
    ttfbMs: nav ? nav.responseStart - nav.startTime : null,
    fcpMs: e.paint?.find(p => p.name === 'first-contentful-paint')?.startTime ?? null,
    lcpMs: e['largest-contentful-paint']?.at(-1)?.startTime ?? null,
    cls: snapshot.supported.includes('layout-shift') ? layoutShiftScore(e['layout-shift']) : null,
    longTasks: snapshot.supported.includes('longtask') ? tasks.length : null,
    blockingOver50Ms: snapshot.supported.includes('longtask') ? tasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0) : null,
    ...network};
}

export async function instrumentation(context, page, profile) {
  await context.addInitScript(observe);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: profile.cpu});
  await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: profile.latency,
    downloadThroughput: profile.download, uploadThroughput: profile.upload});
  let requests = new Map(), resources = [], failures = [], active = false;
  cdp.on('Network.requestWillBeSent', e => {
    if (!active || !/^https?:/.test(e.request.url)) return;
    if (e.redirectResponse && requests.has(e.requestId)) {
      const previous = requests.get(e.requestId);
      previous.transferBytes = e.redirectResponse.encodedDataLength;
      previous.status = e.redirectResponse.status;
      previous.durationMs = (e.timestamp - previous.started) * 1000;
      previous.complete = true;
    }
    const url = new URL(e.request.url);
    const row = {url:url.origin+url.pathname,started:e.timestamp,transferBytes:0,cached:false,complete:false};
    requests.set(e.requestId,row); resources.push(row);
  });
  cdp.on('Network.requestServedFromCache', e => {if (active && requests.has(e.requestId)) requests.get(e.requestId).cached = true;});
  cdp.on('Network.responseReceived', e => {
    if (!active) return;
    const row = requests.get(e.requestId);
    if (row) {
      row.status = e.response.status;
      if (e.response.fromDiskCache || e.response.fromServiceWorker) row.cached = true;
    }
    if (e.response.status >= 400) failures.push({status: e.response.status, path: new URL(e.response.url).pathname});
  });
  cdp.on('Network.loadingFinished', e => {
    const row = requests.get(e.requestId);
    if (active && row) {row.transferBytes = e.encodedDataLength; row.durationMs = (e.timestamp-row.started)*1000; row.complete = true;}
  });
  cdp.on('Network.loadingFailed', e => {
    if (active && requests.has(e.requestId)) {
      requests.get(e.requestId).failed = true;
      if (!e.canceled) failures.push({error:e.errorText});
    }
  });
  return {
    async cold() {await cdp.send('Network.clearBrowserCache');},
    start() {requests = new Map(); resources = []; failures = []; active = true;},
    snapshot() {return {requests:resources.length, cachedRequests:resources.filter(r => r.cached).length,
      transferBytes:resources.reduce((sum,r) => sum+r.transferBytes,0), networkFailures:[...failures],
      resources:resources.map(({started,...row}) => ({...row})), pendingRequests:resources.filter(r => !r.complete && !r.failed).length};},
    stop() {active = false;},
  };
}

export function summarize(samples) {
  const groups = new Map();
  for (const s of samples) {
    const key = [s.scenario, s.profile, s.cache].join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups].map(([key, rows]) => {
    const good = rows.filter(r => r.status === 'ok');
    return {key, attempts: rows.length, failures: rows.length - good.length,
      metrics: Object.fromEntries(['readyMs', 'ttfbMs', 'fcpMs', 'lcpMs', 'cls', 'blockingOver50Ms', 'transferBytes', 'requests', 'cachedRequests', 'actionMs']
        .map(name => [name, distribution(good.map(s => s.metrics[name]))]))};
  });
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export function htmlReport(report) {
  const rows = summarize(report.samples).map(row => `<tr><td>${escape(row.key)}</td><td>${row.attempts - row.failures}/${row.attempts}</td>` +
    ['readyMs', 'lcpMs', 'cls', 'blockingOver50Ms', 'transferBytes', 'actionMs'].map(key => {
      const d = row.metrics[key], factor = key === 'transferBytes' ? 1000 : 1, digits = key === 'cls' ? 3 : 0;
      return `<td>${d.n ? `${(d.median / factor).toFixed(digits)} <small>(${(d.min / factor).toFixed(digits)}–${(d.max / factor).toFixed(digits)})</small>` : '—'}</td>`;
    }).join('') + '</tr>').join('\n');
  return `<!doctype html><meta charset="utf-8"><title>CEDAR frontend performance</title>
    <style>body{font:15px system-ui;margin:32px;color:#173f3e}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:right}td:first-child{text-align:left}small{display:block;color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:1100px}</style>
    <h1>CEDAR frontend performance</h1><p>${escape(report.startedAt)} · Reporting only · ${report.finishedAt ? report.complete ? 'Complete' : 'Incomplete — see missing coverage below' : 'Running'} · Median (min–max)</p>
    ${(report.setupFailures ?? []).map(f => `<p><strong>Missing coverage:</strong> ${escape(f.scenario)} — ${escape(f.error.split('\n')[0])}</p>`).join('')}
    <p>Readiness and action completion are CEDAR-specific lab timings. LCP and CLS cover the recorded observation window. Blocking is the sum of long-task time over 50 ms, not Lighthouse TBT. No field INP or percentile compliance is inferred.</p>
    <p>Frontend assets use a local HTTP/1.1 HTTPS server with gzip and explicit caching. Production HTTP/2, HTTP/3, CDN and backend latency can differ. Sign-in setup is excluded; later silent SSO is included in readiness.</p>
    <table><thead><tr><th>Scenario / profile / cache</th><th>Valid</th><th>Ready ms</th><th>LCP ms</th><th>CLS</th><th>Blocking ms</th><th>Transfer KB</th><th>Action ms</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Run configuration and limits</h2><pre>${escape(JSON.stringify(report.metadata, null, 2))}</pre>
    <h2>Failures and missing coverage</h2><pre>${escape(JSON.stringify({setup:report.setupError,
      setupFailures:report.setupFailures, cleanup:report.cleanupErrors,
      samples:report.samples.filter(s => s.status !== 'ok')}, null, 2))}</pre>`;
}
