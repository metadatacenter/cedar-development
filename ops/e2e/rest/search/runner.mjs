import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { plan } from './matrix.mjs';
import { workerCount } from '../scheduler.mjs';

export function parseOptions(args) {
  const options = { live: false, check: false, validate: false, isolated: false, tier: 'rest', workers: 4 };
  for (const arg of args) {
    if (arg === '--live') options.live = true;
    else if (arg === '--plan') options.explicitPlan = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--validate') options.validate = true;
    else if (arg === '--isolated') options.isolated = true;
    else if (arg.startsWith('--tier=')) options.tier = arg.slice(7);
    else if (arg.startsWith('--report=')) options.reportPath = resolve(arg.slice(9));
    else if (arg.startsWith('--workers=')) options.workers = workerCount(arg.slice(10));
    else throw new Error(`Unknown search harness option: ${arg}`);
  }
  assert.ok(['rest', 'journey', 'all'].includes(options.tier), 'tier must be rest, journey or all');
  assert.ok([options.live, options.explicitPlan, options.check, options.validate].filter(Boolean).length <= 1, 'Choose exactly one execution mode');
  assert.ok(!(options.live && (options.explicitPlan || options.check || options.validate)), 'Offline and live modes cannot be combined');
  assert.ok(!options.live || options.reportPath, '--live requires --report=<path> for its ledger');
  return options;
}

export async function main(args, { executeLive } = {}) {
  const options = parseOptions(args);
  if (options.live) {
    const run = executeLive ?? (await import('./live.mjs')).runLive;
    const report = await run(options);
    console.log(`${report.status}: ${options.reportPath}`);
    return report.status === 'IMPLEMENTED_CASES_PASS_WITH_DECLARED_GAPS' ? 0 : 1;
  }
  if (options.check) {
    const test = spawnSync(process.execPath, ['--test', '--import', fileURLToPath(new URL('./offline-guard.mjs', import.meta.url)),
      fileURLToPath(new URL('./harness.test.mjs', import.meta.url))], { stdio: 'inherit' });
    return test.status ?? 1;
  }
  if (options.validate) {
    console.log(JSON.stringify((await import('./validate.mjs')).validateArtifacts(), null, 2));
    return 0;
  }
  console.log(JSON.stringify(plan(options), null, 2));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
