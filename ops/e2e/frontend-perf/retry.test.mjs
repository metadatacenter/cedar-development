import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boundedComparison, inputDigest} from './retry.mjs';
const result = (status, complete=true, exitCode=0) => ({exitCode,report:{complete,comparison:[{status}]}});
test('noisy comparison gets exactly one further complete paired run and retains both', async () => {
  let calls=0;
  const answer = await boundedComparison(async () => {calls++; return result('inconclusive');});
  assert.equal(calls,2); assert.equal(answer.attempts.length,2); assert.equal(answer.selected,2);
  assert.equal(answer.attempts[1].report.comparison[0].status,'inconclusive');
});
test('functional failure and incomplete reports never retry into a pass', async () => {
  for (const first of [result('inconclusive',false),result('inconclusive',true,1),{exitCode:0,report:{complete:true}}]) {
    let calls=0;
    const answer=await boundedComparison(async () => {calls++; return calls===1 ? first : result('within-advisory-tolerance');});
    assert.equal(answer.complete,false); assert.equal(calls,1);
  }
});
test('clear regressions are retained without shopping for a faster run', async () => {
  let calls=0;
  const answer=await boundedComparison(async () => {calls++; return result('regression-warning');});
  assert.equal(calls,1); assert.equal(answer.attempts[0].report.comparison[0].status,'regression-warning');
});
test('second attempt can resolve noise but a failed second attempt fails coverage', async () => {
  for (const complete of [true,false]) {
    const answer=await boundedComparison(async n => n===1 ? result('inconclusive') : result('within-advisory-tolerance',complete));
    assert.equal(answer.complete,complete); assert.equal(answer.selected,2);
  }
});

test('reference reuse compares bytes, including every host asset', async () => {
  const root=await mkdtemp(join(tmpdir(),'cedar-reference-'));
  try {
    const a=join(root,'a'), b=join(root,'b'); await mkdir(a); await mkdir(b);
    await writeFile(join(a,'x.js'),'same'); await writeFile(join(b,'x.js'),'same');
    assert.equal(await inputDigest(a),await inputDigest(b));
    assert.equal(await inputDigest(join(a,'x.js')),await inputDigest(join(b,'x.js')));
    await writeFile(join(b,'x.css'),'added');
    assert.notEqual(await inputDigest(a),await inputDigest(b));
  } finally {await rm(root,{recursive:true,force:true});}
});
