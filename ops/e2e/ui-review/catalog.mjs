import {createHash} from 'node:crypto';

export const DESIGNER_STATES = [
  'empty', 'empty-panel-a', 'empty-panel-b', 'single', 'single-panel-a', 'single-panel-b',
  'single-preview-a', 'single-preview-b', 'configuration', 'presentation', 'constraints',
  'annotations', 'metadata', 'version', 'collapsed', 'expanded', 'multiple', 'long-name',
  'width-1440', 'width-1100', 'width-900', 'width-768', 'width-375', 'nested',
  'both-panels-1440', 'both-panels-1100', 'both-panels-1024', 'both-panels-900', 'both-panels-768',
  'phone-preview-375', 'phone-editor-375', 'phone-preview-short', 'phone-editor-short',
  'configuration-end-768', 'configuration-end-375',
  'both-panels-multiple-1100', 'both-panels-multiple-768', 'phone-preview-multiple-375', 'phone-editor-multiple-375',
  'required-preview-1100', 'required-preview-768', 'required-preview-375',
  'required-configuration-1100', 'required-configuration-768', 'required-configuration-375',
  'required-overview-1440', 'required-overview-768',
  'saved', 'reopened', 'save-unconfirmed', 'save-status-checked',
  'last-field-removed', 'removed-panel-a', 'removed-panel-b', 'keyboard',
];
export const APPS = ['designer', 'workspace', 'metadata-editor'];
export const WIDTHS = [1440, 768, 375];
const workspace = [
  ['empty-list','empty'], ['empty-grid','empty'], ['populated-list','listing'], ['next-page','pagination'],
  ['previous-page','pagination'], ['row-actions','pointer'], ['details-open','navigation'], ['details-closed','navigation'],
  ['populated-grid','listing'], ['filters','filters'], ['sort','filters'], ['preview-short','preview'],
  ['preview-long','preview'], ['preview-nested','preview'], ['preview-tryout','preview'], ['preview-return','preview'],
  ['keyboard','keyboard'], ['reloaded','navigation'], ['breadcrumb-return','navigation'],
];
const metadata = [
  ...[0,1,2,5,6,12].map(n=>['occurrences-'+n,'occurrences']), ['last-page','pagination'], ['previous-page','pagination'],
  ['long-labels','composition'], ['nested','nesting'], ['nested-end','nesting'], ['keyboard','keyboard'],
  ['edited','editing'], ['saved','save'], ['reopened','save'], ['new-record','empty'], ['empty-template','empty'],
];
export function scenarios(app) {
  if (!APPS.includes(app)) throw new Error('Unknown UI review application: '+app);
  if (app === 'designer') return DESIGNER_STATES.map(id=>({id,scenario:id,category:'authoring',width:Number(id.match(/(?:^|-)(1440|1100|1024|900|768|375)$/)?.[1])||null}));
  const rows = app === 'workspace' ? workspace : metadata;
  return WIDTHS.flatMap(width=>rows.map(([scenario,category])=>({id:`${scenario}-${width}`,scenario,category,width})))
    .concat(app === 'workspace' ? [{id:'both-panels-768',scenario:'both-panels',category:'composition',width:768},
      {id:'paging-overlap-768',scenario:'paging-overlap',category:'pointer',width:768}] : []);
}
export const requiredStates = app => scenarios(app).map(s=>s.id);
// Page regions whose geometry each capture records. Every selector must match in at least one
// state of the application's capture: a renamed product class would otherwise thin the evidence
// without any error.
const CEE_REGIONS = ['.field-type-icon', '.aligned-up', 'app-cedar-multi-pager', 'mat-expansion-panel-header'];
export const REGIONS = {
  designer: ['.overview-panel', '.preview-panel', '.field-header', '.field-heading', '.field-header-details',
    '.field-type-icon', '.field-name-caption', '.field-type-label', '.occurrence-range', '.required-mark',
    '.field-actions', '.container-type-label', '.template-field-label', '.version-group', 'app-field-card',
    'app-field-summary'],
  workspace: ['.explorer-toolbar', '.table-toolbar', '.breadcrumbs', '.paging', '#workspace-information', ...CEE_REGIONS],
  'metadata-editor': ['.metadata-toolbar', '.pager-container', ...CEE_REGIONS],
};
export function regions(app) {
  if (!REGIONS[app]) throw new Error('Unknown UI review application: '+app);
  return REGIONS[app];
}
export const unmatchedRegions = (app, states) =>
  regions(app).filter(selector => !states.some(state => state.regionsMatched?.includes(selector)));
// Identifies the states and regions a capture was held to. A packet validates only against the
// catalog it was captured with: a later catalog may require states the packet never collected, or
// no longer require states it did.
export const catalogSha256 = app =>
  createHash('sha256').update(JSON.stringify({scenarios: scenarios(app), regions: regions(app)})).digest('hex');
export function coverageFor(capture, review) {
  const inspected = new Set(review?.inspectedStates ?? []);
  return {app:capture.app??'designer',catalogSha256:capture.catalogSha256??null,scope:'Scenario coverage, not proof of exhaustive UI quality',
    scenarios:scenarios(capture.app??'designer').map(s=>{
      const state=capture.states.find(x=>x.id===s.id);
      const failure=capture.incomplete.find(x=>x.state===s.id);
      return {...s,capture:state?'captured':failure?'blocked':'omitted',reason:failure?.error??null,
        inspected:review?inspected.has(s.id):null,evidence:state?[state.screenshot,state.aria,state.metrics,...(state.crops??[])]:[]};
    })};
}
