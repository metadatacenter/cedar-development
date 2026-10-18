import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Pure fixture construction. No REST helper import, credentials, clock, or network at module load.
export const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url)));
export const corpusDigest = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
export const collections = { field: 'template-fields', element: 'template-elements', template: 'templates', instance: 'template-instances' };
const filenames = { field: 'minimal-field.json', element: 'minimal-element.json', template: 'minimal-template.json', instance: 'minimal-instance.json' };
const bases = Object.fromEntries(Object.entries(filenames).map(([kind, file]) =>
  [kind, JSON.parse(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url)))]));
const kinds = ['field', 'element', 'template', 'instance'];
export const definitions = kinds.flatMap(kind => corpus[`${kind}s`].map(item => ({ ...item, kind })));
export const byAlias = new Map(definitions.map(item => [item.alias, item]));
export const readerAliases = corpus.instances.filter(item => item.access !== 'private').map(item => item.alias);
export const allInstances = corpus.instances.map(item => item.alias);
const propertyIri = key => 'https://example.org/search-corpus/properties/' + encodeURIComponent(key);
export function stableId(alias, kind = byAlias.get(alias)?.kind) {
  const hex = createHash('sha256').update('cedar-search-corpus:' + alias).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  assert.ok(collections[kind], `Unknown artifact kind for ${alias}`);
  return `https://repo.example.org/${collections[kind]}/${uuid}`;
}
export function baseBody(kind, name, description = '') {
  const body = structuredClone(bases[kind]);
  body['@id'] = null;
  body['schema:name'] = name;
  body['schema:description'] = description;
  for (const key of ['pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy']) body[key] = null;
  return body;
}
function childSpec(value) { return typeof value === 'string' ? { ref: value } : value; }
function children(body, spec, resolve) {
  for (const [key, value] of Object.entries(spec.children)) {
    const { ref, repeat, label } = childSpec(value);
    const child = structuredClone(resolve(ref));
    body.properties[key] = repeat ? { type: 'array', minItems: 0, items: child } : child;
    body.properties['@context'].properties[key] = { enum: [propertyIri(key)] };
    (body.properties['@context'].required ??= []).push(key);
    body._ui.order.push(key);
    body._ui.propertyLabels[key] = label ?? child['skos:prefLabel'] ?? child['schema:name'];
    body._ui.propertyDescriptions[key] = '';
    // Optional properties let the corpus distinguish absence, null, empty and populated values.
  }
}
function fieldBody(spec) {
  const body = baseBody('field', spec.name);
  if (spec.preferred) body['skos:prefLabel'] = spec.preferred;
  if (spec.type === 'term' || spec.type === 'link') {
    body._ui.inputType = spec.type === 'link' ? 'link' : 'textfield';
    body.properties = { '@type': body.properties['@type'], '@id': { type: 'string', format: 'uri' },
      'rdfs:label': { type: ['string', 'null'] } };
    body.required = ['@id'];
    if (spec.type === 'term') body._valueConstraints = { requiredValue: false, ontologies: [], branches: [], classes: [], valueSets: [] };
  } else if (spec.type === 'numeric') {
    body._ui.inputType = 'numeric';
    body._valueConstraints = { requiredValue: false, numberType: 'xsd:int' };
    body.required = ['@value', '@type'];
  } else if (spec.type === 'temporal') {
    body._ui = { inputType: 'temporal', temporalGranularity: 'day', inputTimeFormat: '24h', timezoneEnabled: false };
    body._valueConstraints = { requiredValue: false, temporalType: 'xsd:date' };
    body.required = ['@value', '@type'];
  }
  return body;
}
function valueFor(value, spec, resolve, seed) {
  const { ref, repeat } = childSpec(spec), child = byAlias.get(ref);
  if (repeat) return value.map((entry, i) => valueFor(entry, { ref }, resolve, `${seed}-${i}`));
  if (child.kind === 'element') {
    const output = { '@id': `https://repo.example.org/template-element-instances/${seed}`,
      '@context': instanceContext(child) };
    for (const [key, entry] of Object.entries(value)) {
      output[key] = valueFor(entry, child.children[key], resolve, `${seed}-${key}`);
    }
    return output;
  }
  if (value && typeof value === 'object' && 'uri' in value)
    return { '@id': value.uri, ...(value.label === undefined ? {} : { 'rdfs:label': value.label }) };
  if (value && typeof value === 'object' && 'literal' in value)
    return { '@value': value.literal, '@type': value.datatype };
  return { '@value': value };
}
export function instanceContext(spec) {
  return Object.fromEntries(Object.keys(spec.children).map(key => [key, propertyIri(key)]));
}
export function artifact(alias, resolve, scope = '') {
  const spec = byAlias.get(alias);
  assert.ok(spec, `Unknown corpus alias ${alias}`);
  let body;
  if (spec.kind === 'field') body = fieldBody(spec);
  else {
    body = baseBody(spec.kind, spec.name);
    if (spec.children) children(body, spec, resolve);
    if (spec.kind === 'instance') {
      const template = byAlias.get(spec.template);
      body['schema:isBasedOn'] = resolve(spec.template)['@id'];
      Object.assign(body['@context'], instanceContext(template));
      body['@context']['pav:derivedFrom'] = { '@type': '@id' };
      for (const [key, value] of Object.entries(spec.values)) {
        assert.ok(template.children[key], `Undefined field ${key} in ${alias}`);
        body[key] = valueFor(value, template.children[key], resolve, `${alias}-${key}`);
      }
    }
  }
  body['schema:description'] = [scope, spec.description].filter(Boolean).join(' ');
  return body;
}
export function materialize(scope = '') {
  const bodies = new Map();
  for (const spec of definitions) {
    const body = artifact(spec.alias, alias => {
      assert.ok(bodies.has(alias), `Dependency ${alias} must be created before ${spec.alias}`);
      return bodies.get(alias);
    }, scope);
    body['@id'] = stableId(spec.alias);
    // Materialized copies represent stored artifacts for offline validation; live POSTs retain null provenance.
    for (const key of ['pav:createdOn', 'pav:lastUpdatedOn']) body[key] = '2026-01-01T00:00:00Z';
    for (const key of ['pav:createdBy', 'oslc:modifiedBy']) body[key] = 'https://example.org/users/owner';
    bodies.set(spec.alias, body);
  }
  return bodies;
}
