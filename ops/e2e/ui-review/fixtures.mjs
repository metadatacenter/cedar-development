import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {artifactBody} from '../rest/lib.mjs';
import {WIDTHS} from './catalog.mjs';

export const longLabel='Specimen collection and environmental observation notes from collaborating research institutions';
export const propertyIri=key=>'https://example.org/ui-review/'+encodeURIComponent(key);
export const textValue=value=>({'@value':value});
export function field(name,{required=false}={}) {
  const body=artifactBody('field',name);body['schema:description']='';body._valueConstraints.requiredValue=required;return body;
}
export const repeat=items=>({type:'array',minItems:0,items});
export function container(name,fields,kind='template') {
  const body=artifactBody(kind,name);
  body['schema:description']='Complete the specimen information and record each collection observation. Include handling conditions and storage provenance.';
  for(const [key,value] of Object.entries(fields)){
    body.properties[key]=value;body.properties['@context'].properties[key]={enum:[propertyIri(key)]};
    body._ui.order.push(key);body._ui.propertyLabels[key]=key;body.required.push(key);
  }
  return body;
}
export function instance(name,templateId,values) {
  const body=artifactBody('instance',name,{'schema:isBasedOn':templateId,...values});
  for(const key of Object.keys(values))body['@context'][key]=propertyIri(key);
  body['@context']['pav:derivedFrom']={'@type':'@id'};return body;
}
// Templates from cedar-test-artifacts that together hold every input type: one field per type that
// takes a value (038), the static types (009) and an attribute-value field (022). Declared defaults
// are removed, so a new record starts empty and no default needs a live authority lookup, and the
// legacy break fields gain the content property current validation requires.
export const CORPUS_TEMPLATES = {fieldTypes: '038', staticFields: '009', attributeValue: '022'};
export const corpusPath = number => join(process.env.CEDAR_HOME, 'cedar-test-artifacts/artifacts/templates', number, `template-${number}.json`);
export async function corpusTemplate(number, name) {
  const body = JSON.parse(await readFile(corpusPath(number), 'utf8'));
  for (const key of ['pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy']) body[key] = null;
  body['schema:name'] = name;
  for (const property of Object.values(body.properties)) {
    if (!property?._ui) continue;
    const constraints = property._valueConstraints;
    if (constraints) {delete constraints.defaultValue; for (const literal of constraints.literals ?? []) delete literal.selectedByDefault;}
    if (property['@type'] === 'https://schema.metadatacenter.org/core/StaticTemplateField' && !('_content' in property._ui)) property._ui._content = null;
  }
  return body;
}
export async function metadataFixtures(session) {
  const name='UI review '+randomUUID().slice(0,8);
  const folder=await session.put('folders',{folderId:session.user.profile.homeFolderId,name,description:'Temporary independent UI review'});
  const measurement=container('Measurement',{Code:field('Code'),[longLabel]:repeat(field(longLabel))},'element');
  const sample=container('Sample',{Name:field('Name'),Measurements:repeat(measurement)},'element');
  // Subject is required, so a new record saved without it shows the editor's validation warning.
  const fields={Subject:field('Subject',{required:true}),[longLabel]:field(longLabel),Tags:repeat(field('Tags')),['Repeated '+longLabel]:repeat(field('Repeated '+longLabel)),Samples:repeat(sample)};
  const templateId=await session.put('templates',container(name+' specimen study',fields),folder);
  const emptyTemplateId=await session.put('templates',container(name+' empty form',{}),folder);
  const records={};
  const nested=(values)=>({'@id':'https://example.org/ui-review/'+randomUUID(),'@context':Object.fromEntries(Object.keys(values).map(k=>[k,propertyIri(k)])),...values});
  const values=(count,tags)=>({Subject:textValue('Specimen 42'),[longLabel]:textValue('Collected during the northern coastal field campaign'),Tags:tags,['Repeated '+longLabel]:structuredClone(tags),
    Samples:Array.from({length:count},(_,i)=>nested({Name:textValue('Sample '+(i+1)),Measurements:Array.from({length:Math.min(count,2)},(_,j)=>nested({Code:textValue('M'+(j+1)),[longLabel]:tags}))}))});
  // One record per width for adding, copying and deleting occurrences, so edits at one width never
  // change what another width shows.
  const editable={};
  for(const width of WIDTHS)editable[width]=await session.put('template-instances',instance(name+' editable '+width,templateId,values(1,[textValue('Observation 1')])),folder);
  for(const count of [0,1,2,5,6,12]){
    const tags=Array.from({length:count},(_,i)=>textValue('Observation '+(i+1)+(i%2?' with extended handling conditions and storage provenance':'')));
    records[count]=await session.put('template-instances',instance(name+' '+count+' observations',templateId,values(count,tags)),folder);
  }
  const corpus={};
  for(const [role,number] of Object.entries(CORPUS_TEMPLATES))corpus[role]=await session.put('templates',await corpusTemplate(number,`${name} corpus ${number}`),folder);
  return {folder,templateId,emptyTemplateId,records,editable,corpus};
}
export async function workspaceFixtures(session) {
  const folder=(name,parent)=>session.put('folders',{name,folderId:parent,description:'Temporary independent UI review'});
  const rootName='UI review '+randomUUID().slice(0,8);
  const root=await folder(rootName,session.user.profile.homeFolderId);
  const parent=await folder('Research programme with a long descriptive name for international longitudinal sample collection',root);
  const listing=await folder('Participant specimens and environmental metadata for collaborating institutions',parent);
  const empty=await folder('Empty collection',root);
  const rows=[];
  for(let i=1;i<=54;i++)rows.push(await folder('Record '+String(i).padStart(2,'0')+(i===1?' - Long resource title for the international research collection':''),listing));
  // One resource of each type in one folder.
  const mixed=await folder('Resource types',root);
  const mixedTemplate=await session.put('templates',container('Specimen template',{Name:field('Name')}),mixed);
  const mixedIds=[await folder('Nested folder',mixed),mixedTemplate,
    await session.put('template-elements',container('Specimen element',{Name:field('Name')},'element'),mixed),
    await session.put('template-fields',field('Specimen field'),mixed),
    await session.put('template-instances',instance('Specimen record',mixedTemplate,{Name:textValue('Sample 7')}),mixed)];
  const previews=await folder('Preview collection',root);
  const short=await session.put('templates',container('Short form',{Name:field('Name')}),previews);
  const long=await session.put('templates',container('Long form',{[longLabel]:field(longLabel)}),previews);
  const nested=await session.put('templates',container('Nested form',{Samples:repeat(container('Sample',{Name:field('Name'),[longLabel]:repeat(field(longLabel))},'element'))}),previews);
  return {root,rootName,parent,listing,empty,rows,mixed,mixedIds,mixedTemplate,previews,short,long,nested};
}
