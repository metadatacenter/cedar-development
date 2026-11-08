import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {boundedComparison, inputDigest} from './retry.mjs';

const {values}=parseArgs({options:Object.fromEntries([
  'component','baseline','candidate','reference','output','baseline-revision','candidate-revision','reference-revision',
].map(name=>[name,{type:'string'}]))});
for (const name of ['component','baseline','candidate','output']) if (!values[name]) throw new Error('Missing '+name);
const output=resolve(values.output);
await mkdir(output,{recursive:false});
const report={schemaVersion:1,timingMode:'advisory',comparisons:{},complete:false,
  references:{baseline:values['baseline-revision'],reference:values['reference-revision'],candidate:values['candidate-revision']}};
try {
  for (const label of values.reference ? ['baseline','reference'] : ['baseline']) {
    // A shared reference and PR base need only one measurement, with both meanings recorded.
    if (label==='reference' && await inputDigest(values.reference)===await inputDigest(values.baseline)) {
      report.comparisons.reference={...report.comparisons.baseline,reused:'baseline'};
      continue;
    }
    report.comparisons[label]=await boundedComparison(async number=>{
      const directory=join(output,`${label}-${number}`);
      const args=[new URL('./isolated.mjs',import.meta.url).pathname,`--component=${values.component}`,
        `--baseline=${resolve(values[label])}`,`--candidate=${resolve(values.candidate)}`,`--output=${directory}`,'--samples=5'];
      for(const [flag,value] of [['baseline-revision',values[label+'-revision']],['candidate-revision',values['candidate-revision']]])
        if(value) args.push(`--${flag}=${value}`);
      const exitCode=await new Promise((accept,reject)=>{
        const child=spawn(process.execPath,args,{stdio:'inherit'});
        child.once('error',reject); child.once('close',code=>accept(code ?? 1));
      });
      let measured;
      try {measured=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));}
      catch(error) {measured={complete:false,error:error.message};}
      return {directory:`${label}-${number}`,exitCode,report:measured};
    });
  }
  report.complete=Object.values(report.comparisons).every(c=>c.complete);
} catch(error) {report.error=error.stack;}
finally {
  await writeFile(join(output,'comparison.json'),JSON.stringify(report,null,2)+'\n');
  const sections=['# Frontend performance comparisons','',`Coverage: **${report.complete?'complete':'incomplete — check failed'}**. Timing/CLS are advisory.`,
    'PR/push base and fixed reference comparisons are separate. Noisy complete measurements get at most one rerun; all attempts are retained.',''];
  for (const [label,c] of Object.entries(report.comparisons)) {
    sections.push(`## ${label === 'reference' ? 'Fixed post-optimization reference' : 'PR/push base'}`,'');
    if(c.reused) sections.push(`Byte-identical to ${c.reused}; reusing its measurements (source revisions remain recorded in comparison.json).`,'');
    for(const [index,a] of c.attempts.entries()) {
      sections.push(`### Attempt ${index+1}${index+1===c.selected?' (selected)':''}`,'');
      try {sections.push(await readFile(join(output,a.directory,'summary.md'),'utf8'));}
      catch {sections.push('Incomplete: '+(a.report.error ?? 'no report'));}
    }
  }
  if(report.error) sections.push('Setup failed; see comparison.json.');
  await writeFile(join(output,'summary.md'),sections.join('\n')+'\n');
  process.exitCode=report.complete?0:1;
}
