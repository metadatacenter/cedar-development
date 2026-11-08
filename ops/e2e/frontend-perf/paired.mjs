import {distribution} from './metrics.mjs';

// Advisory candidates, NOT calibrated runner budgets. Both tolerances must be exceeded.
export const tolerances = {
  readyMs: {relative:0.10, absolute:100},
  blockingOver50Ms: {relative:0.15, absolute:50},
  cls: {relative:0, absolute:0.02},
};

export function assessPairs(samples, scenarioIds, repetitions) {
  const rows = [];
  for (const scenario of scenarioIds) for (const cache of ['cold','warm']) {
    const selected = samples.filter(s => s.scenario === scenario && s.cache === cache);
    const pairs = Array.from({length:repetitions}, (_, i) => ['baseline','candidate'].map(version =>
      selected.filter(s => s.repeat === i+1 && s.version === version)));
    const complete = selected.length === repetitions*2 && pairs.every(pair => pair.every(group =>
      group.length === 1 && group[0].status === 'ok' && Object.keys(tolerances).every(metric =>
        Number.isFinite(group[0].metrics?.[metric]))));
    for (const [metric, tolerance] of Object.entries(tolerances)) {
      const row = {scenario, cache, metric, status:'inconclusive', reason:'Missing, duplicate or failed samples'};
      if (complete) {
        const before = pairs.map(p => p[0][0].metrics[metric]);
        const after = pairs.map(p => p[1][0].metrics[metric]);
        const deltas = after.map((v,i) => v-before[i]);
        row.baseline = distribution(before); row.candidate = distribution(after); row.delta = distribution(deltas);
        row.limit = Math.max(tolerance.absolute, row.baseline.median*tolerance.relative);
        const spread = values => distribution(values.map(v => Math.abs(v-distribution(values).median))).median;
        if (repetitions < 5) row.reason = 'At least five pairs required for timing assessment';
        else if (Math.max(spread(before), spread(after), spread(deltas)) > row.limit) row.reason = 'Run variability exceeds the advisory tolerance';
        else {
          row.status = row.delta.median > row.limit ? 'regression-warning' : 'within-advisory-tolerance';
          delete row.reason;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

export function loadingFailures(network, origin, deferred=[]) {
  const origins=Array.isArray(origin)?origin:[origin];
  const errors = network.networkFailures.map(f => JSON.stringify(f));
  if (network.pendingRequests) errors.push(`${network.pendingRequests} requests still pending`);
  const scripts = new Set();
  for (const resource of network.resources) {
    if (!origins.includes(new URL(resource.url).origin)) errors.push('Unexpected origin: '+resource.url);
    // Chromium aborts navigation/iframe requests after a successful no-content response.
    // This is distinct from cancellation before a response or during an asset download.
    const noContent = resource.canceled && resource.status === 204;
    if ((resource.failed || !resource.complete) && !noContent) errors.push('Incomplete request: '+resource.url);
    if (deferred.some(pattern=>pattern.test(new URL(resource.url).pathname))) errors.push('Deferred code loaded eagerly: '+resource.url);
    if (/\.m?js$/.test(new URL(resource.url).pathname)) {
      if (scripts.has(resource.url)) errors.push('Duplicate script request: '+resource.url);
      scripts.add(resource.url);
    }
  }
  return errors;
}

export function markdownReport(report) {
  const lines = ['# Frontend rendering performance', '',
    `Measurement coverage: **${report.complete ? 'complete' : 'incomplete — check failed'}**. Timings and CLS are advisory, not calibrated budgets.`, '',
    'Fixed 5/100-field fixtures; constrained profile; cold/warm cache; sequential alternating pairs. Fixed API/session fixtures where needed; no real backend or sign-in. Lab blocking time is not Lighthouse TBT; interaction timing is not INP.', '',
    '| Scenario / cache | Metric | Baseline median | Candidate median | Paired median change | Assessment |',
    '|---|---|---:|---:|---:|---|'];
  for (const r of report.comparison ?? []) {
    const format = n => Number.isFinite(n) ? n.toFixed(r.metric === 'cls' ? 4 : 1) : '—';
    lines.push(`| ${r.scenario} / ${r.cache} | ${r.metric} | ${format(r.baseline?.median)} | ${format(r.candidate?.median)} | ${format(r.delta?.median)} | ${r.status}${r.reason ? ': '+r.reason : ''} |`);
  }
  lines.push('', 'Incomplete/failed samples never become passing measurements. Inconclusive timing rows require a rerun; this advisory phase does not enforce timing regressions.', '',
    'Bundle identities: '+Object.entries(report.artifacts ?? {}).map(([v,a]) => `${v}: \`${a.sha256}\``).join('; '), '');
  return lines.join('\n');
}
