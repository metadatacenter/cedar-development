import {createHash} from 'node:crypto';

export const STATES = [
  'empty', 'empty-panel-a', 'empty-panel-b', 'single', 'single-panel-a', 'single-panel-b',
  'single-preview-a', 'single-preview-b', 'configuration', 'presentation', 'constraints',
  'annotations', 'metadata', 'version', 'collapsed', 'expanded', 'multiple', 'long-name',
  'width-1440', 'width-1100', 'width-900', 'width-768', 'width-375', 'nested',
  'both-panels-1440', 'both-panels-1100', 'both-panels-1024', 'both-panels-900', 'both-panels-768', 'both-panels-375',
  'configuration-end-768', 'configuration-end-375',
  'both-panels-multiple-1100', 'both-panels-multiple-768', 'both-panels-multiple-375',
  'required-preview-1100', 'required-preview-768', 'required-preview-375',
  'required-configuration-1100', 'required-configuration-768', 'required-configuration-375',
  'required-overview-1440', 'required-overview-768',
  'saved', 'reopened', 'save-unconfirmed', 'save-status-checked',
  'last-field-removed', 'removed-panel-a', 'removed-panel-b', 'keyboard',
];
export const hash = value => createHash('sha256').update(value).digest('hex');

export function validateReview(capture, review, available) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  if (!review || typeof review !== 'object' || Array.isArray(review))
    return ['Review must be a JSON object'];
  require(review.schemaVersion === 1, 'Review schemaVersion must be 1');
  require(typeof review.reviewer === 'string' && review.reviewer.trim(), 'Reviewer identity is required');
  require(review.independence?.freshContext === true, 'A fresh reviewer context is required');
  require(review.independence?.knownDefectsDisclosed === false, 'Known defects must not be disclosed to the reviewer');
  require(review.captureSha256 === capture.captureSha256, 'Review belongs to different capture evidence');
  const covered = new Set(Array.isArray(review.inspectedStates) ? review.inspectedStates : []);
  require(Array.isArray(review.inspectedStates) && covered.size === review.inspectedStates.length,
    'Inspected states must be a list without duplicates');
  for (const id of STATES) require(covered.has(id), `State not inspected: ${id}`);
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
  return [...errors,
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
