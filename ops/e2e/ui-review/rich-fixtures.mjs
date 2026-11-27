import {corpusTemplate,container,instance,textValue} from './fixtures.mjs';

export const LONG_TEXT='Specimen collected during the northern coastal field campaign — extended handling conditions, storage provenance and follow-up observations from collaborating research institutions.';
export const PARAGRAPH='Collection notes\n'+LONG_TEXT+'\nSamples were kept chilled, logged on arrival and transferred to the reference laboratory for confirmation.';
// An authored diagram embedded in the template itself: no screenshot substitution, image host or
// network route is needed. It is rendered by the ordinary static-image widget.
export const DIAGRAM='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="560" height="180" viewBox="0 0 560 180"><rect width="560" height="180" fill="#e8f3f3"/><g fill="#163d3c" font-family="sans-serif" font-size="21" text-anchor="middle"><text x="280" y="38">Specimen collection workflow</text><rect x="20" y="70" width="145" height="70" rx="10" fill="#ffffff"/><rect x="207" y="70" width="145" height="70" rx="10" fill="#ffffff"/><rect x="394" y="70" width="145" height="70" rx="10" fill="#ffffff"/><text x="92" y="113">Collect</text><text x="279" y="113">Label</text><text x="466" y="113">Store</text><path d="M170 105h30m-8-8 8 8-8 8M357 105h30m-8-8 8 8-8 8" stroke="#163d3c" fill="none" stroke-width="3"/></g></svg>').toString('base64');
const term=(id,label)=>({'@id':id,'rdfs:label':label});
export const RICH_VALUES={
  Text:textValue(LONG_TEXT),Paragraph:textValue(PARAGRAPH),Email:textValue('specimen.coordinator@example.org'),
  Phone:textValue('+1 650 555 0100'),Radio:textValue('Beta'),Checkbox:['Alpha','Beta'].map(textValue),
  'Single select list':textValue('Beta'),'Multi select list':['Alpha','Beta'].map(textValue),
  Link:{'@id':'https://example.org/studies/coastal-campaign/specimens/42?view=provenance'},
  ORCID:term('https://orcid.org/0000-0001-8743-5071','Stored researcher profile — fixture label'),
  ROR:term('https://ror.org/00f54p054','Stored research organization — fixture label'),
  PFAS:term('https://comptox.epa.gov/dashboard/chemical/details/DTXSID3031864','Stored chemical identity — fixture label'),
  RRID:term('https://scicrunch.org/resolver/RRID:AB_2138153','Stored antibody resource — fixture label'),
  PubMed:term('https://pubmed.ncbi.nlm.nih.gov/26978244','Stored publication with an extended study title — fixture label'),
  'NIH grant identifier':term('https://reporter.nih.gov/project-details/10024362','Stored research project — fixture label'),
  DOI:term('https://doi.org/10.1093/database/bav102','Stored publication identifier — fixture label'),
  Number:{'@type':'xsd:decimal','@value':'42.5'},Date:{'@type':'xsd:date','@value':'2026-08-20'},
  'Controlled term':term('http://purl.obolibrary.org/obo/DOID_1909','melanoma'),
};
export async function richFixture(session,folder,name,{widths=[]}={}) {
  const fields=(await corpusTemplate('038',name)).properties;
  const selected=Object.fromEntries(Object.keys(RICH_VALUES).map(key=>[key,fields[key]]));
  const staticFields=(await corpusTemplate('009',name)).properties;
  selected['Study instructions']={...staticFields['Rich text'], 'schema:name':'Study instructions',
    _ui:{inputType:'richtext',_content:'<h2>Before collecting a specimen</h2><p>Confirm the <strong>participant identifier</strong> and record the collection conditions.</p><ul><li>Use a labelled container.</li><li>Record handling and storage provenance.</li></ul><p><a href="https://example.org/protocol">Read the collection protocol</a></p>'}};
  selected['Collection diagram']={...staticFields['Image field'], 'schema:name':'Collection diagram',
    'schema:description':'Collect the specimen, label the container, then store it under the study protocol.',_ui:{inputType:'image',_content:DIAGRAM}};
  const body=container(name+' populated specimen',selected);
  body.required=body.required.filter(key=>!['Study instructions','Collection diagram'].includes(key));
  const template=await session.put('templates',body,folder);
  const record=await session.put('template-instances',instance(name+' populated record',template,structuredClone(RICH_VALUES)),folder);
  const editable={};
  for(const width of widths)editable[width]=await session.put('template-instances',instance(name+' editable rich '+width,template,structuredClone(RICH_VALUES)),folder);
  return {template,record,editable,name:name+' populated specimen'};
}
