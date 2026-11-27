// Metrics whose paired regression fails the comparison, per component. The tolerances in
// paired.mjs define a regression; this list decides which regressions block. A metric absent here
// stays advisory. Inconclusive rows never block: noise is reported, not treated as a regression.
// Reviewed on 2026-11-27 against 14 daily identical-input controls per component.
export const enforced = Object.freeze({
  cee: Object.freeze(['readyMs', 'blockingOver50Ms', 'cls']),
  ced: Object.freeze(['readyMs', 'blockingOver50Ms', 'cls']),
  designer: Object.freeze(['readyMs']),
});

export function blockingRegressions(component, comparisons) {
  const metrics = enforced[component];
  if (!metrics) throw new Error('No budget decision for component '+component);
  const found = [];
  for (const [label, comparison] of Object.entries(comparisons)) {
    if (comparison.reused || !comparison.complete) continue;
    const rows = comparison.attempts[comparison.selected-1]?.report?.comparison ?? [];
    for (const row of rows)
      if (row.status === 'regression-warning' && metrics.includes(row.metric))
        found.push({comparison:label, scenario:row.scenario, cache:row.cache, metric:row.metric,
          delta:row.delta?.median, limit:row.limit});
  }
  return found;
}
