import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './contract.mjs';
import {coverageFor} from './catalog.mjs';
import {reviewerBrief, reportHtml} from './report.mjs';

async function publish(directory, result) {
  const raw = JSON.stringify(result, null, 2) + '\n';
  await writeFile(join(directory, 'capture.json'), raw);
  await writeFile(join(directory, 'coverage.json'), JSON.stringify(coverageFor(result), null, 2) + '\n');
  await writeFile(join(directory, 'reviewer-brief.md'), reviewerBrief(hash(raw), result.app, result.profile));
  await writeFile(join(directory, 'index.html'), reportHtml(result));
}

// Publish a blocker before calibration starts, so interruption cannot leave a complete-looking
// packet. Keep application evidence intact and update every document that depends on its digest.
export async function finishCapture(directory, result, calibrate) {
  const pending = {state: 'calibration', error: 'Calibration generation has not completed'};
  result.incomplete.push(pending);
  result.calibration = {status: 'pending'};
  await publish(directory, result);
  try {
    await calibrate(join(directory, 'calibration'));
  } catch (error) {
    pending.error = 'Calibration generation failed; see operator diagnostics';
    result.calibration = {status: 'failed'};
    await publish(directory, result);
    throw error;
  }
  result.incomplete.splice(result.incomplete.indexOf(pending), 1);
  result.calibration = {status: 'complete'};
  await publish(directory, result);
}
