// Only audited suites may overlap. New suites default to exclusive execution.
export const PARALLEL_SUITES = new Set([
  'artifacts', 'versioning', 'sharing', 'group-sharing', 'openness', 'validation',
  'search', 'finding', 'negotiation', 'download', 'inclusion', 'apidocs', 'freeze',
]);

export function workerCount(value = 2) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error('REST workers must be an integer from 1 to 4');
  }
  return count;
}

export async function drainPool(items, workers, run, interrupted = () => false) {
  workerCount(workers);
  const pending = [...items];
  const pool = Array.from({ length: workers }, async () => {
    while (!interrupted() && pending.length) await run(pending.shift());
  });
  const results = await Promise.allSettled(pool);
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function runSuites(suites, workers, run, interrupted = () => false) {
  workerCount(workers);
  if (workers === 1) {
    for (const suite of suites) {
      if (interrupted()) break;
      await run(suite);
    }
    return;
  }
  // Drain every owned task even if an unexpected scheduler callback rejects.
  await drainPool(suites.filter(s => PARALLEL_SUITES.has(s.name)), workers, run, interrupted);
  // Global counts, account credentials, home guards, group protection and
  // category-tree operations run without any other suite mutating the stack.
  for (const suite of suites.filter(s => !PARALLEL_SUITES.has(s.name))) {
    if (interrupted()) break;
    await run(suite);
  }
}
