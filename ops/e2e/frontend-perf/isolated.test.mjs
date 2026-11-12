import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// An availability stub tests the runner's failure semantics. Real packaged CEE/CED
// are measured by the reusable CI workflow, not replaced with this test stub.
const stub = `customElements.define('cedar-embeddable-editor',class extends HTMLElement {
  set templateObject(value) {this.innerHTML='<app-cedar-input-text><input></app-cedar-input-text>';}
});`;
test('runner preserves evidence and fails missing assets even when the editor is usable', async () => {
  const root = await mkdtemp(join(tmpdir(),'cedar-isolated-test-'));
  const run = promisify(execFile);
  try {
    const baseline = join(root,'baseline.js'), candidate = join(root,'candidate.js');
    await writeFile(baseline,stub);
    await writeFile(candidate,stub+`fetch('/missing-translation.json');`);
    const args = [new URL('./isolated.mjs',import.meta.url).pathname,'--component=cee','--samples=1',
      '--baseline='+baseline,'--candidate='+candidate,'--output='+join(root,'failed')];
    await assert.rejects(run(process.execPath,args),e => e.code === 1);
    const report = JSON.parse(await readFile(join(root,'failed/report.json'),'utf8'));
    assert.equal(report.complete,false);
    assert.equal(report.samples.length,8);
    assert.ok(report.samples.filter(s => s.version === 'baseline').every(s => s.status === 'ok'));
    assert.ok(report.samples.filter(s => s.version === 'candidate').every(s => s.error.includes('404')));
    assert.ok(report.comparison.every(row => row.status === 'inconclusive'));
    const bytes = await readFile(join(root,'failed/report.json'),'utf8');
    await assert.rejects(run(process.execPath,args),e => e.code !== 0);
    assert.equal(await readFile(join(root,'failed/report.json'),'utf8'),bytes);
    args[args.length-2] = '--candidate='+baseline;
    args[args.length-1] = '--output='+join(root,'complete');
    await run(process.execPath,args);
    const good = JSON.parse(await readFile(join(root,'complete/report.json'),'utf8'));
    assert.equal(good.complete,true);
    assert.equal(good.artifacts.baseline.sha256,good.artifacts.candidate.sha256);
    assert.ok(good.comparison.every(row => row.reason.includes('five pairs')));
  } finally {await rm(root,{recursive:true,force:true});}
});
