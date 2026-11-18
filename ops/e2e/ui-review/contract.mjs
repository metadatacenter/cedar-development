import {createHash} from 'node:crypto';

import {APPS, DESIGNER_STATES, requiredStates} from './catalog.mjs';
export const STATES = DESIGNER_STATES;

export const hash = value => createHash('sha256').update(value).digest('hex');

export function validateReview(capture, review, available) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  if (!review || typeof review !== 'object' || Array.isArray(review))
    return ['Review must be a JSON object'];
  if(!APPS.includes(capture.app??'designer'))return ['Unknown capture application'];
  require(review.schemaVersion === 1, 'Review schemaVersion must be 1');
  require(typeof review.reviewer === 'string' && review.reviewer.trim(), 'Reviewer identity is required');
  require(review.independence?.freshContext === true, 'A fresh reviewer context is required');
  require(review.independence?.knownDefectsDisclosed === false, 'Known defects must not be disclosed to the reviewer');
  require(review.captureSha256 === capture.captureSha256, 'Review belongs to different capture evidence');
  const covered = new Set(Array.isArray(review.inspectedStates) ? review.inspectedStates : []);
  require(Array.isArray(review.inspectedStates) && covered.size === review.inspectedStates.length,
    'Inspected states must be a list without duplicates');
  for (const id of requiredStates(capture.app ?? 'designer')) require(covered.has(id), `State not inspected: ${id}`);
  for (const id of covered) require(capture.states.some(s => s.id === id), `Unknown inspected state: ${id}`);
  require(Array.isArray(review.findings), 'findings must be an array');
  const ids = new Set();
  for (const finding of Array.isArray(review.findings) ? review.findings : []) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push('Each finding must be an object');
      continue;
    }
    require(typeof finding.id === 'string' && !ids.has(finding.id), 'Finding IDs must be unique strings');
    ids.add(finding.id);
    for (const key of ['title', 'observed', 'expected', 'impact'])
      require(typeof finding[key] === 'string' && finding[key].trim(), `${finding.id}: missing ${key}`);
    require(['defect', 'design-proposal', 'uncertain'].includes(finding.kind), `${finding.id}: invalid kind`);
    require(['high', 'medium', 'low'].includes(finding.severity), `${finding.id}: invalid severity`);
    require(Array.isArray(finding.steps) && finding.steps.length > 0 &&
      finding.steps.every(step => typeof step === 'string' && step.trim()), `${finding.id}: missing reproduction steps`);
    require(Array.isArray(finding.evidence) && finding.evidence.length > 0, `${finding.id}: missing evidence`);
    for (const file of Array.isArray(finding.evidence) ? finding.evidence : [])
      require(available.has(file), `${finding.id}: unknown evidence ${file}`);
  }
  require(typeof review.limitations === 'string', 'Explicit limitations are required');
  require(typeof review.acceptableObservations === 'string' && review.acceptableObservations.trim(),
    'Record acceptable behavior as well as problems');
  for (const aspect of ['grouping', 'hierarchy', 'wrapping', 'spaceUse'])
    require(typeof review.composition?.[aspect] === 'string' && review.composition[aspect].trim(),
      `Explicit composition assessment required: ${aspect}`);
  return errors;
}

export function acceptanceBlockers(capture, errors) {
  if(!APPS.includes(capture.app??'designer'))return [...errors,'Unknown capture application'];
  const required = requiredStates(capture.app ?? 'designer');
  const missing = required.filter(id=>!capture.states.some(s=>s.id===id));
  const evidenceErrors=[];
  if(capture.app){
    const ids=capture.states.map(s=>s.id);
    if(new Set(ids).size!==ids.length)evidenceErrors.push('Duplicate captured state IDs');
    for(const state of capture.states)for(const kind of ['screenshot','aria','metrics'])
      if(typeof state[kind]!=='string'||!capture.files?.[state[kind]])evidenceErrors.push(`Missing ${kind} evidence for ${state.id}`);
  }
  return [...errors, ...evidenceErrors, ...missing.map(id=>`Required state not captured: ${id}`),
    ...capture.incomplete.map(item => `Collection incomplete: ${JSON.stringify(item)}`),
    ...(!capture.provenance.current ? ['Deployed build differs from current sources; diagnostic review only'] : []),
    ...capture.cleanupErrors.map(error => `Cleanup: ${error}`),
    ...capture.runtimeErrors.map(error => `Browser: ${error}`),
    ...(!capture.servedVerified ? ['Served component identity was not verified'] : [])];
}

export function verdict(capture, review, errors) {
  if (acceptanceBlockers(capture, errors).length) return 'INCOMPLETE';
  if (review.findings.some(f => f.kind === 'defect')) return 'FINDINGS';
  return review.findings.length ? 'DESIGN_REVIEW' : 'REVIEWED';
}
