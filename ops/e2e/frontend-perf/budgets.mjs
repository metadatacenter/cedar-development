// Metrics whose paired regression fails the comparison, per component and per comparison point:
// `base` is the pull-request or push base, `reference` the fixed reference in references.json.
// The tolerances in paired.mjs define a regression; these lists decide which regressions block.
// A metric absent from a list stays advisory there. Inconclusive rows never block: noise is
// reported, not treated as a regression.
// Reviewed on 2026-11-27 against 14 daily identical-input controls per component. CED's reference
// comparison stays advisory: its warm large-document readiness and blocking time have exceeded
// their limits against the 2026-11-08 reference on most pushes since.
const all = Object.freeze(['readyMs', 'blockingOver50Ms', 'cls']);
export const enforced = Object.freeze({
  cee: Object.freeze({base: all, reference: all}),
  ced: Object.freeze({base: all, reference: Object.freeze([])}),
  designer: Object.freeze({base: Object.freeze(['readyMs']), reference: Object.freeze(['readyMs'])}),
});

const point = label => ({baseline: 'base', reference: 'reference'})[label];

export function blockingRegressions(component, comparisons) {
  const budget = enforced[component];
  if (!budget) throw new Error('No budget decision for component '+component);
  const found = [];
  for (const [label, comparison] of Object.entries(comparisons)) {
    if (comparison.reused || !comparison.complete) continue;
    const metrics = budget[point(label)];
    if (!metrics) throw new Error('No budget decision for comparison '+label);
    const rows = comparison.attempts[comparison.selected-1]?.report?.comparison ?? [];
    for (const row of rows)
      if (row.status === 'regression-warning' && metrics.includes(row.metric))
        found.push({comparison:label, scenario:row.scenario, cache:row.cache, metric:row.metric,
          delta:row.delta?.median, limit:row.limit});
  }
  return found;
}
