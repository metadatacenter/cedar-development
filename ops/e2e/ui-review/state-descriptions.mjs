// Descriptions explain the collector's intended setup, never whether the product rendered it
// correctly. Reviewers must compare that setup with the image, accessibility and action evidence.
const names = {designer:'Template Designer','field-designer':'Field Designer',workspace:'Workspace','metadata-editor':'Metadata Editor',openview:'OpenView'};
const standalone = {
  'chooser-open': 'The real Field Designer create route shows the shared type chooser before a field exists.',
  'chooser-dismissed': 'Escape closes the chooser; the existing Choose field type control remains available.',
  'name-empty': 'A new Text field has an empty name and cannot be saved; no parent placement controls belong here.',
  'name-invalid': 'Leaving the empty field name reveals its required-name validation feedback.',
  'validation-expanded': 'The validation summary is expanded to show the missing-name finding and its navigation control.',
  'name-corrected': 'Naming the standalone field removes its validation summary.',
  collapsed: 'The field settings are collapsed using their ordinary toggle; its name remains visible.',
  saved: 'The host saved the field to the real repository; backend readback confirms its name.',
  reopened: 'Reloading the saved field address restores the stored definition.',
  'save-unconfirmed': 'The harness deliberately interrupted a temporary-field save; inspect the host’s existing uncertain-save recovery state.',
  'save-status-checked': 'The author checked the interrupted save against the backend; the unsaved edit remains available.',
  'draft-offered': 'Reloading after an unsaved field edit shows the host’s retained-draft offer.',
  'draft-restored': 'Restore draft brings the edited standalone field name back into the editor.',
  'long-name': 'A standalone field has the long name Participant preferred contact information and follow-up availability.',
};
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
const added = {
  'import-search-failed': 'The reusable-artifact search cannot reach the server; the import dialog retains the query and shows its existing error.',
  'import-search-recovered': 'Repeating the same search after connectivity returns replaces the import error with the populated results.',
  'user-menu': 'Workspace’s user menu is open, showing its existing account navigation.',
  'actions-menu': 'Workspace’s actions menu is open, showing its existing group, privacy and help navigation.',
  'groups-create': 'The Create group tab is open with an empty name and disabled creation control.',
  'groups-name-entered': 'A group name has been entered; creation is available, but no group is submitted.',
  'groups-delete': 'The Delete group tab is open before selecting a group; no deletion is performed.',
  'utc-offset-open': 'The temporal field’s UTC-offset menu is open through its normal control.',
  'folder-preview-tryout': 'The public template preview is in Try out mode with a typed Subject; nothing is saved.',
  'folder-preview-return': 'The same preview has returned from Try out to its ordinary read-only state.',
  'folder-empty': 'An empty public folder shows its normal empty-state message.',
};
const settings = new Set(['configuration','presentation','constraints','annotations','metadata','version']);
export function describeScenario(app, scenario) {
  const id = scenario.id.replace(/-(1440|1100|1024|900|768|375)$/,'');
  let title=label(id), description;
  if (added[id]) description=added[id];
  else if (app==='metadata-editor' && id==='draft-offered') description='Reloading an unsaved record shows its stored value and the retained-draft offer.';
  else if (app==='metadata-editor' && id==='draft-restored') description='Restore draft recovers the edited Subject value without saving it.';
  else if (app==='designer' && id.startsWith('root-element-')) description='The real standalone element host: '+label(id.slice('root-element-'.length))+'. This is a root element, rather than an element nested in a template.';
  else if (app==='field-designer' && standalone[id]) description=standalone[id];
  else if (app==='field-designer' && settings.has(id)) {
    title='Standalone text field — '+label(id)+' settings';
    description='The '+label(id)+' tab is selected on a standalone field, which has no parent Configuration tab.';
  } else if (app==='field-designer' && scenario.scenario==='standalone-field-values') {
    const [,type,tab]=/^type-(.*)-(constraints|content)$/.exec(id);
    title=label(type)+' — standalone '+label(tab)+' settings';
    description='The type-specific '+label(tab)+' panel is selected through its ordinary tab. Inspect its constraints, defaults, options or authored-content controls; required content may still be empty.';
  } else if (app==='field-designer' && id.startsWith('type-')) {
    title=label(id.slice(5))+' — standalone field settings';
    description='The type was selected through the Field Designer chooser. Its named standalone definition and Presentation settings are visible; empty required content may show validation feedback.';
  } else if (app==='designer' && designer[id]) [title,description]=designer[id];
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
