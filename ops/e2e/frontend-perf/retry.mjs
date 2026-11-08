import {stat, readFile} from 'node:fs/promises';
import {hash, inventory} from './lab.mjs';

export const inputDigest = async path => (await stat(path)).isDirectory()
  ? (await inventory(path)).sha256 : hash(await readFile(path));

// Retry only complete but noisy timing. Never turn a broken page into a timing pass.
export async function boundedComparison(execute) {
  const attempts = [];
  for (let number=1; number<=2; number++) {
    const result = await execute(number);
    attempts.push(result);
    if (result.exitCode !== 0 || !result.report?.complete) return {complete:false,attempts,selected:number};
    const rows = result.report.comparison;
    if (!Array.isArray(rows) || !rows.length) return {complete:false,attempts,selected:number};
    if (!rows.some(r => r.status === 'inconclusive')) break;
  }
  return {complete:true,attempts,selected:attempts.length};
}
