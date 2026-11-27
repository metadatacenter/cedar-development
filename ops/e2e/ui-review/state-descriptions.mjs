// Descriptions explain the collector's intended setup, never whether the product rendered it
// correctly. Reviewers must compare that setup with the image, accessibility and action evidence.
const names = {designer:'Template Designer',workspace:'Workspace','metadata-editor':'Metadata Editor',openview:'OpenView'};
const label = value => value.replace(/-/g,' ').replace(/\b(iri|doi|orcid|ror|rrid|pfas|nih)\b/gi,s=>s.toUpperCase()).replace(/^./,s=>s.toUpperCase());
const designer = {
  empty: ['Empty template', 'New template before adding fields; Overview initially open and Preview closed.'],
  'empty-panel-a': ['Empty template — Overview closed', 'The Overview toggle has been activated to close the outline.'],
  'empty-panel-b': ['Empty template — Overview reopened', 'The same outline is reopened after the previous capture.'],
  single: ['One text field', 'A new template with one Text field named Sample; field settings collapsed.'],
  'single-panel-a': ['One text field — Overview closed', 'The template outline has been closed while the field remains in the authoring pane.'],
  'single-panel-b': ['One text field — Overview reopened', 'The template outline is reopened after the previous capture.'],
  'single-preview-a': ['One text field — Preview open', 'Preview is opened alongside the authoring pane and Overview.'],
  'single-preview-b': ['One text field — Preview closed', 'Preview is closed again after the previous capture.'],
  collapsed: ['Text field settings collapsed', 'The Text field settings are collapsed through their existing toggle.'],
  expanded: ['Text field settings expanded', 'The Text field settings are reopened through their existing toggle.'],
  multiple: ['Repeating text field', 'Allow multiple is enabled on the Text field.'],
  'long-name': ['Text field with a long name', 'The field name is Participant preferred contact information and follow-up availability.'],
  nested: ['Nested element in the template', 'An element with child content is present; inspect its relationship to the root template.'],
};
const settings = new Set(['configuration','presentation','constraints','annotations','metadata','version']);
export function describeScenario(app, scenario) {
  const id = scenario.id.replace(/-(1440|1100|1024|900|768|375)$/,'');
  let title=label(id), description;
  if (app==='designer' && designer[id]) [title,description]=designer[id];
  else if(app==='designer' && settings.has(id)) {
    title='Text field — '+label(id)+' settings';
    description='The '+label(id)+' tab is selected for the Text field.';
  } else if(id==='text-200') {
    title='Browser default text size doubled';
    description='The browser default is 32 pixels, twice the usual 16. This is a text preference change, not browser page zoom.';
  } else if(id.startsWith('occurrences-')) {
    const count=id.slice('occurrences-'.length);
    title=count+' repeated entries';
    description='The Metadata Editor fixture contains '+count+' occurrences of the repeating field; inspect its entries and paging controls.';
  } else if(['designer','metadata-editor'].includes(app) && id.startsWith('type-')) {
    const match=/^type-(.*?)(-configuration-end|-preview|-invalid|-open)?$/.exec(id);
    const field=label(match[1]), condition=match[2];
    title=field+(condition==='-configuration-end'?' — end of settings':condition==='-preview'?' — Preview':condition==='-invalid'?' — invalid input':condition==='-open'?' — input picker open':app==='designer'?' — field settings':' — input control');
    description=condition==='-configuration-end'?'The field settings have been explicitly scrolled to their end.':condition==='-invalid'?'The collector entered an invalid value; inspect the control and its validation feedback.':condition==='-open'?'The input picker is open through its ordinary control.':condition==='-preview'?'The '+field+' field is scrolled into the Designer’s read-only Preview. The fixture may show an empty control or an authored-content placeholder.':app==='designer'?'The '+field+' card has its settings expanded in a template containing one field of every offered type.':'The '+field+' input in the field-type fixture is scrolled into view. This state does not establish coverage of every value or interaction the input supports.';
  } else if(id.startsWith('term-picker-')) {
    title='Controlled terms — '+label(id.slice('term-picker-'.length));
    description='The controlled-term constraint dialog is opened from a Designer field. Inspect the named tab, loading stage or scrolled section alongside the recorded actions.';
  } else if(id.startsWith('width-') || id==='width') {
    title='Long field name at this width';
    description='The repeating Text field retains its long name while the viewport is resized.';
  }
  description ??= names[app]+': '+title+'. The screenshot records this step of the '+label(scenario.category||'application').toLowerCase()+' journey; the action log gives the interaction and fixture details.';
  return {title,description};
}
