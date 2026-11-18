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
// Every type the Designer's field picker offers, by state slug and picker label. Rich Text renders
// nothing in Preview until given content, and Page Break shows only as the Preview's page selector,
// so those two have no Preview state of their own.
export const DESIGNER_TYPES = [
  ['text','Text'], ['paragraph','Paragraph'], ['multiple-choice','Multiple Choice'], ['checkboxes','Checkboxes'],
  ['list','List'], ['multi-select-list','Multi-select List'], ['temporal','Temporal'], ['email','Email'], ['link','Link'],
  ['phone','Phone'], ['number','Number'], ['controlled-terms','Controlled Terms'], ['attribute-value','Attribute Value'],
  ['orcid','ORCID'], ['ror','ROR'], ['pfas','PFAS'], ['rrid','RRID'], ['pubmed','PubMed'], ['nih-grant-id','NIH Grant ID'],
  ['doi','DOI'], ['image','Image'], ['rich-text','Rich Text'], ['youtube','YouTube'], ['section-break','Section Break'],
  ['page-break','Page Break'],
];
export const PREVIEWLESS_TYPES = ['rich-text', 'page-break'];
// The fields of the shared corpus template that holds one field per input type, by state slug and
// field label, in form order.
export const METADATA_TYPES = [
  ['text','Text'], ['paragraph','Paragraph'], ['email','Email'], ['phone','Phone'], ['radio','Radio'], ['checkbox','Checkbox'],
  ['single-select-list','Single select list'], ['multi-select-list','Multi select list'], ['link','Link'], ['orcid','ORCID'],
  ['ror','ROR'], ['pfas','PFAS'], ['rrid','RRID'], ['pubmed','PubMed'], ['nih-grant-identifier','NIH grant identifier'],
  ['doi','DOI'], ['number','Number'], ['date','Date'], ['controlled-term','Controlled term'],
];
export const APPS = ['designer', 'workspace', 'metadata-editor'];
// Browser profiles a capture can run under. The default drives Chromium with a mouse; the touch
// profile drives WebKit as a touch device, where nothing can hover and every activation is a tap.
export const PROFILES = {
  chromium: {engine: 'chromium', context: {}},
  'webkit-touch': {engine: 'webkit', context: {hasTouch: true, isMobile: true}},
};
export function profile(name = 'chromium') {
  if (!PROFILES[name]) throw new Error('Unknown UI review browser profile: ' + name);
  return PROFILES[name];
}
export const WIDTHS = [1440, 768, 375];
const workspace = [
  ['empty-list','empty'], ['empty-grid','empty'], ['populated-list','listing'], ['next-page','pagination'],
  ['previous-page','pagination'], ['row-actions','pointer'], ['details-open','navigation'], ['details-closed','navigation'],
  ['panels-details-only','composition'], ['panels-none','composition'], ['panels-navigation-only','composition'],
  ['populated-grid','listing'], ['new-menu','creation'], ['new-folder-dialog','creation'],
  ['type-menu','filters'], ['filters','filters'], ['date-menu','filters'], ['date-filtered','filters'], ['sort','filters'],
  ['keyboard','keyboard'], ['reloaded','navigation'], ['breadcrumb-return','navigation'],
  ['template-details','navigation'], ['search','search'], ['home','navigation'],
  ['mixed-list','listing'], ['mixed-grid','listing'], ['mixed-filtered','filters'],
  ['preview-short','preview'], ['preview-long','preview'], ['preview-nested','preview'], ['preview-tryout','preview'], ['preview-return','preview'],
];
// States collected at one width only, where an earlier review found the width mattered.
const workspaceOnce = [
  {id:'new-folder-dialog-keyboard-375',scenario:'new-folder-dialog-keyboard',category:'keyboard',width:375},
  {id:'new-folder-dialog-escaped-375',scenario:'new-folder-dialog-escaped',category:'keyboard',width:375},
  {id:'type-instance-checked-375',scenario:'type-instance-checked',category:'pointer',width:375},
  {id:'both-panels-768',scenario:'both-panels',category:'composition',width:768},
  {id:'paging-overlap-768',scenario:'paging-overlap',category:'pointer',width:768},
];
const metadata = [
  ...[0,1,2,5,6,12].map(n=>['occurrences-'+n,'occurrences']), ['last-page','pagination'], ['previous-page','pagination'],
  ['long-labels','composition'], ['nested','nesting'], ['nested-end','nesting'], ['keyboard','keyboard'],
  ['edited','editing'], ['saved','save'], ['reopened','save'],
  ['occurrence-added','occurrences'], ['occurrence-copied','occurrences'], ['occurrence-deleted','occurrences'],
  ['collapsed-all','navigation'], ['download-menu','navigation'], ['readonly-top','preview'], ['readonly-repeated','preview'],
  ['new-record','empty'], ['save-warning','validation'], ['warning-expanded','validation'], ['warning-jump','validation'],
  ['empty-name-saved','save'], ['empty-template','empty'],
];
export function scenarios(app) {
  if (!APPS.includes(app)) throw new Error('Unknown UI review application: '+app);
  if (app === 'designer') return DESIGNER_STATES.map(id=>({id,scenario:id,category:'authoring',width:Number(id.match(/(?:^|-)(1440|1100|1024|900|768|375)$/)?.[1])||null}))
    .concat(DESIGNER_TYPES.map(([slug])=>({id:'type-'+slug,scenario:'field-type-settings',category:'field-types',width:1440})))
    .concat(DESIGNER_TYPES.filter(([slug])=>!PREVIEWLESS_TYPES.includes(slug))
      .map(([slug])=>({id:'type-'+slug+'-preview',scenario:'field-type-preview',category:'field-types',width:1440})));
  const rows = app === 'workspace' ? workspace : metadata;
  return WIDTHS.flatMap(width=>rows.map(([scenario,category])=>({id:`${scenario}-${width}`,scenario,category,width})))
    .concat(app === 'workspace' ? workspaceOnce : METADATA_TYPES.map(([slug])=>({id:`type-${slug}-1440`,scenario:'field-type',category:'field-types',width:1440}))
      .concat([{id:'static-fields-1440',scenario:'static-fields',category:'field-types',width:1440},
        {id:'static-fields-page-2-1440',scenario:'static-fields',category:'field-types',width:1440},
        {id:'attribute-value-1440',scenario:'attribute-value',category:'field-types',width:1440}]));
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
