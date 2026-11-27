// Recovery is limited to independently initialized journeys. A failed journey never resumes at
// its next step: the following journey must navigate to its own known starting state.
const cleanups = new WeakMap();
export function retainCleanup(page, cleanup) {
  const pending = cleanups.get(page) ?? new Set();
  cleanups.set(page, pending);
  let result;
  const release = () => result ??= Promise.resolve().then(cleanup).then(value => {pending.delete(release);return value;});
  pending.add(release);
  return release;
}

export async function recoverJourney(session) {
  const {page} = session;
  for (const release of cleanups.get(page) ?? []) await release();
  // Page-local fault injection is disposable. The context-level fixture mutation guard remains.
  await page.unrouteAll({behavior:'wait'});
  await page.goto('about:blank');
  // Release a drag only after leaving its document; it must never drop into a real folder.
  await page.mouse.up();
  session.expectedNetworkFailures.clear();
}

export async function captureJourney(session, record, name, collect) {
  try {await collect();return true;}
  catch (error) {
    if (!record.failure) throw error;
    record.failure('journey:'+name, error);
    // If cleanup fails, stop the application. Continuing with interception still active would
    // produce misleading evidence and could change the meaning of a later mutation.
    await recoverJourney(session);
    return false;
  }
}
