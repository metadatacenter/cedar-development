// Shared capture targets for populated editing and read-only rendering. Stable slugs are distinct
// from the existing empty-control catalog; none of those earlier states is replaced.
export const RICH_FIELDS = [
  ['text','Text'], ['paragraph','Paragraph'], ['email','Email'], ['phone','Phone'],
  ['radio','Radio'], ['checkbox','Checkbox'], ['single-select-list','Single select list'],
  ['multi-select-list','Multi select list'], ['link','Link'], ['orcid','ORCID'], ['ror','ROR'],
  ['pfas','PFAS'], ['rrid','RRID'], ['pubmed','PubMed'], ['nih-grant-identifier','NIH grant identifier'],
  ['doi','DOI'], ['number','Number'], ['date','Date'], ['controlled-term','Controlled term'],
  ['rich-text','Study instructions'], ['image','Collection diagram'],
];
export const RICH_INTERACTIONS = [
  ['multiselect-open','Multi-selection with existing selections'],
  ['multiselect-changed','Multi-selection after changing a choice'],
  ['validation','Invalid email with inline feedback'],
  ['validation-corrected','Corrected email after validation'],
  ['term-suggestions','Controlled-term suggestions for melanoma'],
  ['term-selected','Controlled term selected from suggestions'],
  ['term-cleared','Selected controlled term cleared'],
  ['attribute-populated','Named attribute with a long value'],
  ['attribute-readonly','Saved attribute in read-only Preview'],
];
export function richScenarios(app, widths) {
  return widths.flatMap(width => [
    ...RICH_FIELDS.flatMap(([slug,label]) => (app==='metadata-editor'?['populated','readonly']:['readonly'])
      .map(mode => ({id:`rich-${mode}-${slug}-${width}`,scenario:`rich-${mode}`,category:'populated-fields',width,
        title:`${label} — ${mode==='populated'?'populated editor':'saved read-only value'}`,
        description: 'A stored specimen fixture with populated controls, long text, multiple selected choices and labelled authority identifiers. Identifier labels are fixture data, not a fresh authority lookup. Image and rich text are embedded authored content.'}))),
    ...(app==='metadata-editor'?RICH_INTERACTIONS.map(([slug,title])=>({id:`rich-${slug}-${width}`,scenario:`rich-${slug}`,category:'populated-interactions',width,title,
      description:'An ordinary interaction with the populated fixture. Inspect the screenshot and recorded actions for the resulting value, selection or feedback.'})):[]),
  ]);
}
